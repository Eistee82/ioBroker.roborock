import { afterEach, describe, expect, it, vi } from "vitest";
import { MapEngine } from "./MapEngine";
import type { EngineConnection, MapEngineHost } from "./types";

/**
 * The map itself shows which rooms are picked, and that map is a PNG the **adapter** paints: the
 * tab has the rooms only as pixels and cannot dim the ones that are not picked. So a click has to
 * reach the adapter, and it does that through its room switches - the same states a segment run
 * without explicit rooms cleans.
 *
 * What is tested here is exactly that wiring, not the highlight itself: that a click sends the
 * whole selection with the floor it belongs to, and that a selection without a known floor is not
 * sent at all - room ids repeat across the maps of one robot, so a floorless selection would light
 * up arbitrary rooms of another map.
 */

interface EngineInternals {
	selectedRoomIds: Set<number>;
	currentRobotDuid: string | null;
	map: { mapFlag?: unknown } | undefined;
	toggleRoomSelection(segmentId: number): void;
	clearRoomSelection(): void;
}

let live: MapEngine | null = null;

async function startEngine(): Promise<{ sendTo: ReturnType<typeof vi.fn>; internals: EngineInternals }> {
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

	const host: MapEngineHost = {
		container,
		t: (_key: string, fallback: string) => fallback,
	};

	const engine = new MapEngine(connection, host);
	live = engine;
	await engine.init("roborock.0");

	const internals = engine as unknown as EngineInternals;
	internals.currentRobotDuid = "duid1";
	internals.map = { mapFlag: 0 };
	sendTo.mockClear();
	return { sendTo, internals };
}

/** The payloads of every `set_room_selection` that was sent. */
function selectionMessages(sendTo: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
	return sendTo.mock.calls.filter((call) => call[1] === "set_room_selection").map((call) => call[2]);
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.replaceChildren();
});

describe("the room selection reaches the adapter", () => {
	it("sends the whole selection with its floor when a room is picked", async () => {
		const { sendTo, internals } = await startEngine();

		internals.toggleRoomSelection(16);

		expect(selectionMessages(sendTo)).toEqual([{ duid: "duid1", mapFlag: 0, rooms: [16] }]);
	});

	it("sends the complete set, not the change", async () => {
		const { sendTo, internals } = await startEngine();

		internals.toggleRoomSelection(16);
		internals.toggleRoomSelection(17);

		// The adapter switches the rooms of that floor to exactly this set, so a message that only
		// named the room just clicked would turn the previous ones off again.
		expect(selectionMessages(sendTo).at(-1)).toEqual({ duid: "duid1", mapFlag: 0, rooms: [16, 17] });
	});

	it("sends the room again as unpicked when it is clicked a second time", async () => {
		const { sendTo, internals } = await startEngine();

		internals.toggleRoomSelection(16);
		internals.toggleRoomSelection(16);

		expect(selectionMessages(sendTo).at(-1)).toEqual({ duid: "duid1", mapFlag: 0, rooms: [] });
	});

	it("sends an empty selection when the selection is dropped", async () => {
		const { sendTo, internals } = await startEngine();

		internals.toggleRoomSelection(16);
		internals.clearRoomSelection();

		expect(selectionMessages(sendTo).at(-1)).toEqual({ duid: "duid1", mapFlag: 0, rooms: [] });
	});

	it("says nothing when there is nothing to drop", async () => {
		const { sendTo, internals } = await startEngine();

		internals.clearRoomSelection();

		expect(selectionMessages(sendTo)).toEqual([]);
	});

	it("stays silent while the floor of the drawn map is unknown", async () => {
		const { sendTo, internals } = await startEngine();
		internals.map = {};

		internals.toggleRoomSelection(16);

		expect(selectionMessages(sendTo)).toEqual([]);
		// The local highlight still works - only the map cannot follow.
		expect(internals.selectedRoomIds.has(16)).toBe(true);
	});

	it("stays silent while no robot is selected", async () => {
		const { sendTo, internals } = await startEngine();
		internals.currentRobotDuid = null;

		internals.toggleRoomSelection(16);

		expect(selectionMessages(sendTo)).toEqual([]);
	});
});
