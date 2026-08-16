import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

import { encodeRasterRuns } from "../../src/common/segmentRaster";
import type { SegmentRaster } from "../../src/common/segmentRaster";
import { MapBuilder } from "../../src/lib/map/v1/MapBuilder";

/**
 * The surface picture: the map with everything that lies **on** the floor and nothing that stands
 * **in** the room.
 *
 * ## Why the adapter draws a third picture at all
 *
 * The 3D view textures its floor with a map picture and stands the robot, the dock, the no-go zones
 * and the walls on it as bodies. Of the two pictures that existed before, neither fits:
 * `mapBase64Clean` is bare room colour - no path, no mopped band, no room names, no detected
 * objects - and `mapBase64` carries a painted copy of every body, which would then lie flat on the
 * floor underneath the body itself.
 *
 * ## Why a second snapshot could not have done it
 *
 * `drawMapV1` draws in a fixed order, and the two sets are interleaved: carpet, paths, **zones**,
 * virtual walls, predicted path, objects, robot, dock, go-to pin, **room labels**
 * (`src/common/mapDrawing/drawMapV1.ts:178-387`). The labels are last and the zones are well before
 * them, so no single cut through that sequence yields the labels without the zones. The surface is
 * therefore recorded on a canvas of its own, which only the layers that belong on it are painted
 * onto as well (`src/lib/map/v1/CanvasMapRenderer.ts`).
 *
 * ## How this test measures it
 *
 * Never "looks right": every case renders the same map twice, once with a layer and once without,
 * and compares the finished PNG data URIs byte for byte.
 *
 * Each case asserts **two** things, and the second is what makes the first mean anything:
 *
 *  - the surface picture changes (or does not change) as the layer demands, **and**
 *  - the full picture changes either way.
 *
 * Without that second half, a layer that silently never drew - a typo in a block name, a zone
 * outside the canvas - would pass every "must not be on the surface" case for the wrong reason.
 */

const GRID = 24;
const ROOM_A = 1;
const ROOM_B = 2;

/** Cell types in the low three bits, as the robot packs them. */
const EMPTY = 0;
const WALL = 1;
const FLOOR = 7;

/** Two rooms over the lower half, a wall across the middle, plain floor above it. */
function raster(): SegmentRaster {
	const cells = new Uint8Array(GRID * GRID);
	for (let row = 0; row < GRID; row++) {
		for (let column = 0; column < GRID; column++) {
			const index = row * GRID + column;
			if (row >= 16) cells[index] = ((column < 12 ? ROOM_A : ROOM_B) << 3) | FLOOR;
			else if (row === 15) cells[index] = (ROOM_A << 3) | WALL;
			else if (row < 8) cells[index] = FLOOR;
			else cells[index] = EMPTY;
		}
	}
	return { encoding: "rle", width: GRID, height: GRID, runs: encodeRasterRuns(cells) };
}

/**
 * The map every case starts from: rooms and walls, and nothing laid over them.
 *
 * Deliberately without `CURRENTLY_CLEANED_BLOCKS` and without room switches, so the selection
 * highlight never runs and the room colours are the same in every render.
 */
function baseMap(): Record<string, unknown> {
	return {
		mapFlag: 0,
		IMAGE: { position: { left: 0, top: 0 }, dimensions: { width: GRID, height: GRID }, raster: raster() }
	};
}

function adapterStub(): Record<string, unknown> {
	return {
		namespace: "roborock.0",
		name: "roborock",
		config: { map_theme: "light", map_color_scheme: "light" },
		getMapColorScheme: () => "light",
		getStatesAsync: async () => ({}),
		errorMessage: (e: unknown) => String(e),
		rLog: vi.fn(),
		fileExistsAsync: async () => false,
		http_api: {
			isSharedDevice: () => false,
			getMatchedRoomIDs: () => [{ id: "room-a", name: "Kitchen" }]
		}
	};
}

interface Rendered {
	clean: string;
	full: string;
	surface: string;
}

/**
 * Draws one map and hands back all three pictures.
 * @param extra Blocks laid over the base map for this case.
 * @param mappedRooms Segment-to-room mapping, only used by the room-name case.
 * @returns The clean, full and surface pictures as data URIs.
 */
async function render(extra: Record<string, unknown> = {}, mappedRooms?: unknown[]): Promise<Rendered> {
	const builder = new MapBuilder(adapterStub() as never);
	const [clean, full, , surface] = await builder.canvasMap(
		{ ...baseMap(), ...extra },
		{ duid: "duid1", surface: true, mappedRooms: mappedRooms as never }
	);
	expect(surface).not.toBeNull();
	return { clean, full, surface: surface! };
}

/** A driven path across the lower rooms, in robot millimetres. */
const PATH = { points: [[200, 200], [1000, 200]] as [number, number][] };

describe("the surface picture carries what lies on the floor", () => {
	it("gains the driven path, and the clean picture does not", async () => {
		const without = await render();
		const withPath = await render({ PATH });

		expect(withPath.surface).not.toBe(without.surface);
		expect(withPath.full).not.toBe(without.full);
		// The whole point of the third picture: the state the 2D view uses as its background stays
		// the bare room colour it always was.
		expect(withPath.clean).toBe(without.clean);
	});

	it("gains the mopped band", async () => {
		// Bit 0 of the MOP_PATH flag is what turns a path point into a mopped one
		// (`src/common/pathProcessor.ts:95`). The same points without the flag draw the line alone.
		const dryRun = await render({ PATH, MOP_PATH: [0, 0] });
		const mopped = await render({ PATH, MOP_PATH: [1, 1] });

		expect(mopped.surface).not.toBe(dryRun.surface);
		expect(mopped.full).not.toBe(dryRun.full);
	});

	it("gains the carpet", async () => {
		const cells = [17 * GRID + 3, 17 * GRID + 4, 18 * GRID + 3, 18 * GRID + 4];
		const without = await render();
		const withCarpet = await render({ CARPET_MAP: cells });

		expect(withCarpet.surface).not.toBe(without.surface);
		expect(withCarpet.full).not.toBe(without.full);
	});

	it("gains the detected objects", async () => {
		const without = await render();
		const withObstacle = await render({ OBSTACLES2: [[500, 500, 1]] });

		expect(withObstacle.surface).not.toBe(without.surface);
		expect(withObstacle.full).not.toBe(without.full);
	});

	it("gains the room names", async () => {
		const without = await render();
		const named = await render({}, [[ROOM_A, "room-a"]]);

		expect(named.surface).not.toBe(without.surface);
		expect(named.full).not.toBe(without.full);
	});
});

describe("the surface picture carries nothing the 3D view draws as a body", () => {
	/**
	 * One layer that has to stay off the surface.
	 *
	 * The second expectation is the guard: a block that never reached the canvas would satisfy the
	 * first one without proving anything.
	 * @param name What the case is called.
	 * @param extra The block that adds the layer.
	 */
	function mustStayOff(name: string, extra: Record<string, unknown>): void {
		it(name, async () => {
			const without = await render();
			const withLayer = await render(extra);

			expect(withLayer.surface).toBe(without.surface);
			expect(withLayer.full).not.toBe(without.full);
			expect(withLayer.clean).toBe(without.clean);
		});
	}

	mustStayOff("no-go zones", { FORBIDDEN_ZONES: [[100, 700, 600, 700, 600, 400, 100, 400]] });
	mustStayOff("no-mop zones", { NO_MOP_ZONE: [[100, 700, 600, 700, 600, 400, 100, 400]] });
	mustStayOff("virtual walls", { VIRTUAL_WALLS: [[100, 900, 1000, 900]] });
	mustStayOff("the zone being cleaned right now", { CURRENTLY_CLEANED_ZONES: [[100, 100, 600, 600]] });
	mustStayOff("the robot", { ROBOT_POSITION: { position: [300, 300], angle: 0 } });
	mustStayOff("the dock", { CHARGER_LOCATION: { position: [900, 300], angle: 0 } });
	mustStayOff("the go-to pin", { GOTO_TARGET: [700, 500] });
	mustStayOff("the predicted route to the go-to pin", {
		GOTO_PREDICTED_PATH: { points: [[200, 500], [900, 500]] }
	});
});

describe("the surface picture is only produced when it is asked for", () => {
	it("comes back as null by default, so no caller pays for a PNG it does not publish", async () => {
		const builder = new MapBuilder(adapterStub() as never);
		const [, , , surface] = await builder.canvasMap({ ...baseMap(), PATH }, { duid: "duid1" });

		expect(surface).toBeNull();
	});

	it("comes back as null for a map with no image block, rather than throwing", async () => {
		// `canvasMap` refuses such a map before it ever draws, and a caller that publishes the state
		// has to survive that instead of writing an empty picture over a good one.
		const builder = new MapBuilder(adapterStub() as never);
		const [, , , surface] = await builder.canvasMap({ IMAGE: {} }, { duid: "duid1", surface: true });

		expect(surface).toBeNull();
	});
});
