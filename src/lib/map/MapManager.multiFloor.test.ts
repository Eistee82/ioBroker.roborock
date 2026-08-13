import { beforeEach, describe, expect, it } from "vitest";
import { MapManager } from "./MapManager";

/**
 * Regression tests for multi floor devices: two stored maps of the same robot reuse the
 * same room ids (and often the same room names). Segment names must therefore only ever
 * be resolved from the floor the currently processed map belongs to.
 */

// Room states as they exist in ioBroker: Devices.<duid>.floors.<mapFlag>.<roomId>
const ROOM_STATES: Record<string, string> = {
	"Devices.duid1.floors.0.16": "Kitchen",
	"Devices.duid1.floors.0.17": "Hallway",
	"Devices.duid1.floors.1.16": "Bedroom",
	"Devices.duid1.floors.1.17": "Hallway"
};

function createAdapterStub(requestedObjectIds: string[]): any {
	return {
		log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		rLog: () => {},
		errorMessage: (e: unknown) => String(e),
		http_api: {
			getMatchedRoomIDs: () => [],
			getRobotModel: () => "roborock.vacuum.a27",
			isSharedDevice: () => false
		},
		getObjectAsync: async (id: string) => {
			requestedObjectIds.push(id);
			const name = ROOM_STATES[id];
			return name ? { common: { name } } : null;
		}
	};
}

/** Parsed V1 map with two segments; names are empty as for cloud maps. */
function createParsedMapFixture(): any {
	return {
		metaData: {},
		IMAGE: {
			segments: {
				count: 2,
				list: [
					{ id: 16, name: "", center: [1000, 1000] },
					{ id: 17, name: "", center: [2000, 2000] }
				]
			},
			position: { top: 0, left: 0 },
			dimensions: { height: 10, width: 10 },
			pixels: { floor: [], obstacle: [], segments: [] }
		}
	};
}

async function processV1Map(
	manager: MapManager,
	currentMapIndex: number | undefined
): Promise<{ mapData: any } | null> {
	// MapDecryptor V1 passes uncompressed buffers through unchanged, so any buffer works here.
	const result = await manager.processMap(
		Buffer.from([0x72, 0x72, 0x00, 0x00]),
		"1.0",
		"roborock.vacuum.a27",
		"serial1",
		null,
		"duid1",
		"Unknown",
		undefined,
		currentMapIndex
	);
	return result as { mapData: any } | null;
}

describe("MapManager multi floor room keys", () => {
	let manager: MapManager;
	let requestedObjectIds: string[];

	beforeEach(() => {
		requestedObjectIds = [];
		manager = new MapManager(createAdapterStub(requestedObjectIds));
		manager.mapParser = { parsedata: async () => createParsedMapFixture() } as any;
		manager.mapCreator = { canvasMap: async () => ["clean", "full", "cropped"] } as any;
	});

	it("enriches segment names from the room states of map 0", async () => {
		const result = await processV1Map(manager, 0);

		expect(result).to.not.equal(null);
		expect(result!.mapData.mapFlag).to.equal(0);
		expect(result!.mapData.IMAGE.segments.list.map((s: any) => s.name)).to.deep.equal(["Kitchen", "Hallway"]);
		expect(requestedObjectIds).to.deep.equal(["Devices.duid1.floors.0.16", "Devices.duid1.floors.0.17"]);
	});

	it("enriches segment names from map 1 although both maps use room ids 16/17", async () => {
		const result = await processV1Map(manager, 1);

		expect(result!.mapData.mapFlag).to.equal(1);
		// Must be the second floor's rooms, not "Kitchen" from floor 0.
		expect(result!.mapData.IMAGE.segments.list.map((s: any) => s.name)).to.deep.equal(["Bedroom", "Hallway"]);
		expect(requestedObjectIds.every((id) => id.startsWith("Devices.duid1.floors.1."))).to.equal(true);
	});

	it("does not read floor 0 as fallback while the active map is still unknown", async () => {
		const result = await processV1Map(manager, -1);

		expect(result!.mapData.mapFlag).to.equal(undefined);
		expect(result!.mapData.IMAGE.segments.list.map((s: any) => s.name)).to.deep.equal(["", ""]);
		expect(requestedObjectIds).to.deep.equal([]);
	});

	it("does not read floor 0 as fallback when no map index is passed at all", async () => {
		const result = await processV1Map(manager, undefined);

		expect(result!.mapData.mapFlag).to.equal(undefined);
		expect(requestedObjectIds).to.deep.equal([]);
	});

	it("switching floors yields different names for identical room ids", async () => {
		const groundFloor = await processV1Map(manager, 0);
		const firstFloor = await processV1Map(manager, 1);

		const nameOf = (result: any, roomId: number): string =>
			result.mapData.IMAGE.segments.list.find((s: any) => s.id === roomId).name;

		expect(nameOf(groundFloor, 16)).to.equal("Kitchen");
		expect(nameOf(firstFloor, 16)).to.equal("Bedroom");
		expect(groundFloor!.mapData.mapFlag).to.not.equal(firstFloor!.mapData.mapFlag);
	});
});
