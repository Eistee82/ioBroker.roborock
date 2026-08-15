import { afterEach, describe, expect, it, vi } from "vitest";
import { MapEngine } from "./MapEngine";
import type { EngineConnection, MapEngineHost, RoomListModel } from "./types";

/**
 * Renaming a room, as the engine wires it up.
 *
 * The risk here is not the payload - it is one object with two fields - but everything around it:
 *
 *  1. **The right room.** The command names a room by its **segment id**, the robot's own number.
 *     Sending a list position instead would rename whichever room happened to sit there.
 *  2. **Not sending at all.** Each call makes the adapter rebuild the entire room assignment, so a
 *     rename to the name the room already has is a full rewrite for nothing.
 *  3. **Not sending something the adapter will refuse.** An empty or over-long name is rejected in
 *     the browser with a message, because `set_state` answers ok before the robot is asked and the
 *     refusal would otherwise only appear in the adapter log.
 */

interface EngineInternals {
	map: unknown;
	roomList: { segmentId: number; name: string }[];
	drawOverlaysFromMap(): void;
}

let live: MapEngine | null = null;

/** A parsed V1 map whose segments carry names. */
function mapWithRooms(segments: { id: number; name: string }[]): Record<string, unknown> {
	return {
		IMAGE: {
			dimensions: { width: 200, height: 200 },
			position: { left: 0, top: 0 },
			segments: {
				list: segments.map((segment) => ({ id: segment.id, name: segment.name, center: [1000, 1000] })),
			},
		},
		mapFlag: 0,
	};
}

async function startEngine(): Promise<{
	engine: MapEngine;
	internals: EngineInternals;
	sendTo: ReturnType<typeof vi.fn>;
	models: RoomListModel[];
	errors: string[];
}> {
	const sendTo = vi.fn().mockResolvedValue({});
	const connection: EngineConnection = {
		sendTo,
		getObject: vi.fn().mockResolvedValue(null),
		getStates: vi.fn().mockResolvedValue({}),
		subscribeState: vi.fn().mockResolvedValue(undefined),
		unsubscribeState: vi.fn(),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const container = document.createElement("div");
	document.body.appendChild(container);

	const models: RoomListModel[] = [];
	const errors: string[] = [];
	const host: MapEngineHost = {
		container,
		t: (_key: string, fallback: string, ...args: (string | number)[]) =>
			args.reduce<string>((text, value) => text.replace("%s", String(value)), fallback),
		onRoomList: (model) => models.push(model),
		onError: (message) => errors.push(message),
	};

	const engine = new MapEngine(connection, host);
	live = engine;
	await engine.init("roborock.0");

	(engine as unknown as { currentRobotDuid: string | null }).currentRobotDuid = "duid1";
	(engine as unknown as { mapImage: unknown }).mapImage = {
		dimensions: { width: 200, height: 200 },
		position: { left: 0, top: 0 },
	};

	return { engine, internals: engine as unknown as EngineInternals, sendTo, models, errors };
}

/** Loads a map and lets the engine build its room list from it. */
function loadRooms(internals: EngineInternals, segments: { id: number; name: string }[]): void {
	internals.map = mapWithRooms(segments);
	internals.drawOverlaysFromMap();
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.replaceChildren();
});

describe("the room list", () => {
	it("carries the named rooms of the current map", async () => {
		const { internals, models } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 17, name: "Living room" },
		]);

		const model = models[models.length - 1];
		expect(model.rooms.map((room) => [room.segmentId, room.name])).toEqual([
			[16, "Kitchen"],
			[17, "Living room"],
		]);
		expect(model.maxNameLength).toBe(30);
	});

	it("leaves out a segment that has no name", async () => {
		// It has no label on the map either, so there is nothing to show and nothing to rename.
		const { internals, models } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 18, name: "" },
		]);

		expect(models[models.length - 1].rooms.map((room) => room.segmentId)).toEqual([16]);
	});

	it("marks the rooms picked for the next run", async () => {
		const { engine, internals, models } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 17, name: "Living room" },
		]);

		(engine as unknown as { toggleRoomSelection(id: number): void }).toggleRoomSelection(17);

		const model = models[models.length - 1];
		expect(model.rooms.find((room) => room.segmentId === 17)?.selected).toBe(true);
		expect(model.rooms.find((room) => room.segmentId === 16)?.selected).toBe(false);
	});

	it("empties on a robot switch, so the previous robot's rooms cannot be renamed", async () => {
		const { engine, internals, models } = await startEngine();
		loadRooms(internals, [{ id: 16, name: "Kitchen" }]);

		engine.selectRobot("duid2");
		expect(internals.roomList).toEqual([]);
		expect(models[models.length - 1].rooms).toEqual([]);
	});
});

describe("combining rooms", () => {
	/** Picks rooms on the map, in the order given. */
	function pick(engine: MapEngine, ids: number[]): void {
		for (const id of ids) {
			(engine as unknown as { toggleRoomSelection(id: number): void }).toggleRoomSelection(id);
		}
	}

	it("sends the picked segment ids, in the order they were picked", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 17, name: "Living room" },
			{ id: 18, name: "Hallway" },
		]);

		pick(engine, [18, 16]);
		await engine.mergeSelectedRooms();

		// Picking a room already talks to the adapter, so the merge is found by its command name
		// rather than by being the only call.
		const merges = sendTo.mock.calls.filter((call) => call[2]?.command === "merge_segment");
		expect(merges).toHaveLength(1);
		const message = merges[0][2];
		// The click order, not the map order: it is what the user can see and what the app sends.
		expect(JSON.parse(message.value)).toEqual([18, 16]);
	});

	it("refuses a single room and says how many are needed", async () => {
		const { engine, internals, sendTo, errors } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 17, name: "Living room" },
		]);

		pick(engine, [16]);
		await engine.mergeSelectedRooms();

		expect(sendTo.mock.calls.some((call) => call[2]?.command === "merge_segment")).toBe(false);
		expect(errors[errors.length - 1]).toMatch(/at least 2/i);
	});

	it("sends nothing when no room is picked at all", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadRooms(internals, [{ id: 16, name: "Kitchen" }]);

		await engine.mergeSelectedRooms();
		expect(sendTo.mock.calls.some((call) => call[2]?.command === "merge_segment")).toBe(false);
	});

	it("drops the selection, because those segment ids are about to stop existing", async () => {
		// Keeping it would leave rooms highlighted that the next map no longer has - and the
		// highlight is what a segment run reads.
		const { engine, internals, models } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 17, name: "Living room" },
		]);

		pick(engine, [16, 17]);
		await engine.mergeSelectedRooms();

		expect(models[models.length - 1].rooms.every((room) => !room.selected)).toBe(true);
	});

	it("sends nothing when no robot is selected", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 17, name: "Living room" },
		]);
		pick(engine, [16, 17]);
		(engine as unknown as { currentRobotDuid: string | null }).currentRobotDuid = null;

		await engine.mergeSelectedRooms();
		expect(sendTo.mock.calls.some((call) => call[2]?.command === "merge_segment")).toBe(false);
	});
});

describe("renaming a room", () => {
	it("names the room by its segment id, as a JSON string", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadRooms(internals, [
			{ id: 16, name: "Kitchen" },
			{ id: 17, name: "Living room" },
		]);

		await engine.renameRoom(17, "Lounge");

		expect(sendTo).toHaveBeenCalledTimes(1);
		const [instance, command, message] = sendTo.mock.calls[0];
		expect(instance).toBe("roborock.0");
		expect(command).toBe("set_state");
		expect(message.folder).toBe("commands");
		expect(message.command).toBe("name_segment");
		// 17, the robot's own segment id - not 1, its position in the list.
		expect(JSON.parse(message.value)).toEqual([{ segmentId: 17, name: "Lounge" }]);
	});

	it("sends the name without a tag, so a rename cannot retag the room", async () => {
		// The adapter keeps the room's current tag when none is given, and that tag carries the
		// room's suction and water defaults. An invented one would change how the room is cleaned.
		const { engine, internals, sendTo } = await startEngine();
		loadRooms(internals, [{ id: 16, name: "Kitchen" }]);

		await engine.renameRoom(16, "Pantry");
		expect(JSON.parse(sendTo.mock.calls[0][2].value)[0]).not.toHaveProperty("tag");
	});

	it("trims the name before sending it", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadRooms(internals, [{ id: 16, name: "Kitchen" }]);

		await engine.renameRoom(16, "  Pantry  ");
		expect(JSON.parse(sendTo.mock.calls[0][2].value)).toEqual([{ segmentId: 16, name: "Pantry" }]);
	});

	it("sends nothing when the name did not change", async () => {
		// One call rewrites the whole room assignment; doing that for an unchanged name is a full
		// rewrite for nothing.
		const { engine, internals, sendTo } = await startEngine();
		loadRooms(internals, [{ id: 16, name: "Kitchen" }]);

		await engine.renameRoom(16, "Kitchen");
		await engine.renameRoom(16, "  Kitchen  ");
		expect(sendTo.mock.calls.some((call) => call[2]?.command === "merge_segment")).toBe(false);
	});

	it("refuses an empty name and says so instead of sending it", async () => {
		const { engine, internals, sendTo, errors } = await startEngine();
		loadRooms(internals, [{ id: 16, name: "Kitchen" }]);

		await engine.renameRoom(16, "   ");
		expect(sendTo.mock.calls.some((call) => call[2]?.command === "merge_segment")).toBe(false);
		expect(errors[errors.length - 1]).toMatch(/1 and 30/);
	});

	it("refuses a name longer than the app allows", async () => {
		const { engine, internals, sendTo, errors } = await startEngine();
		loadRooms(internals, [{ id: 16, name: "Kitchen" }]);

		await engine.renameRoom(16, "x".repeat(31));
		expect(sendTo.mock.calls.some((call) => call[2]?.command === "merge_segment")).toBe(false);
		expect(errors[errors.length - 1]).toMatch(/1 and 30/);

		// One character less is fine, so the boundary is where the app puts it.
		await engine.renameRoom(16, "x".repeat(30));
		expect(sendTo).toHaveBeenCalledTimes(1);
	});

	it("sends nothing when no robot is selected", async () => {
		const { engine, sendTo } = await startEngine();
		(engine as unknown as { currentRobotDuid: string | null }).currentRobotDuid = null;

		await engine.renameRoom(16, "Kitchen");
		expect(sendTo.mock.calls.some((call) => call[2]?.command === "merge_segment")).toBe(false);
	});
});
