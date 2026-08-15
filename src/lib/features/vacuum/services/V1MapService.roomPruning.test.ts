import { describe, expect, it, vi } from "vitest";
import { V1MapService } from "./V1MapService";
import { ROOM_ABSENCE_THRESHOLD } from "./roomStatePruning";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * Removing a room switch, as the map service wires it up.
 *
 * `roomStatePruning.test.ts` proves the rule. This proves the gates around it, and those are what
 * decide whether a user loses an object they built a script on:
 *
 *  1. an unknown map slot removes nothing - it would prune the wrong floor;
 *  2. a floor whose states cannot be read removes nothing - an empty answer is not "no rooms";
 *  3. only direct children of that one floor are considered - another floor's switches are not
 *     orphans just because they are missing from this map;
 *  4. only states this adapter created as room switches are deleted, whatever else lives there.
 *
 * Every one of these is a "nothing happens" test on purpose. The one case where something does
 * happen is the last block.
 */

const DUID = "duid1";

interface Harness {
	service: V1MapService;
	deleted: string[];
	logs: string[];
}

/**
 * A service with a hand-built adapter.
 *
 * Hand-built rather than the shared mock because what is under test is which adapter calls are
 * made, and a fake that records them says that directly.
 */
function makeService(options: {
	/** Room states below the floors, as `getStatesAsync` would answer. */
	states?: Record<string, unknown> | null;
	/** Objects behind those states; a missing entry means "not a room switch of ours". */
	objects?: Record<string, { type: string; native?: Record<string, unknown> }>;
	/** Makes the state enumeration fail. */
	statesThrow?: boolean;
} = {}): Harness {
	const deleted: string[] = [];
	const logs: string[] = [];

	const adapter = {
		namespace: "roborock.0",
		getStatesAsync: vi.fn(async (pattern: string) => {
			if (options.statesThrow) throw new Error("no connection");
			if (options.states === null) return null;
			const all = options.states ?? {};
			const prefix = `roborock.0.${pattern.replace(/\*$/, "")}`;
			const hit: Record<string, unknown> = {};
			for (const [id, value] of Object.entries(all)) {
				if (id.startsWith(prefix)) hit[id] = value;
			}
			return hit;
		}),
		getObjectAsync: vi.fn(async (id: string) => {
			const relative = id.startsWith("roborock.0.") ? id.slice("roborock.0.".length) : id;
			return options.objects?.[relative] ?? options.objects?.[id] ?? null;
		}),
		delObjectAsync: vi.fn(async (id: string) => {
			deleted.push(id);
		}),
		rLog: vi.fn((_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, message: string) => {
			logs.push(message);
		}),
		errorMessage: (e: unknown) => String(e),
	};

	const deps = { adapter, ensureState: vi.fn(), ensureFolder: vi.fn() };
	const service = new V1MapService(deps as never, DUID);
	return { service, deleted, logs };
}

/** Runs the pruning as `processMapResults` would, `times` readings in a row. */
async function readMap(
	harness: Harness,
	mapFlag: unknown,
	segmentIds: number[],
	times = 1,
): Promise<void> {
	const segments = segmentIds.map((id) => ({ id }));
	for (let i = 0; i < times; i++) {
		await (harness.service as unknown as {
			pruneRoomStates(flag: unknown, segments: unknown[]): Promise<void>;
		}).pruneRoomStates(mapFlag, segments);
	}
}

/** One room switch as this adapter creates it: a state carrying the segment id in `native`. */
function roomSwitch(): { type: string; native: Record<string, unknown> } {
	return { type: "state", native: { id: 17 } };
}

describe("a map slot that is not known", () => {
	it("removes nothing, because it would be the wrong floor", async () => {
		const harness = makeService({
			states: { "roborock.0.Devices.duid1.floors.0.17": {} },
			objects: { "Devices.duid1.floors.0.17": roomSwitch() },
		});

		for (const flag of [null, undefined, -1, "x", 1.5]) {
			await readMap(harness, flag, [16], ROOM_ABSENCE_THRESHOLD);
		}

		expect(harness.deleted).toEqual([]);
	});
});

describe("a floor whose switches cannot be read", () => {
	it("removes nothing when the enumeration fails", async () => {
		const harness = makeService({ statesThrow: true });
		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD + 2);
		expect(harness.deleted).toEqual([]);
	});

	it("removes nothing when the enumeration answers nothing at all", async () => {
		// `null` is "I could not tell you", not "there are none".
		const harness = makeService({ states: null });
		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD + 2);
		expect(harness.deleted).toEqual([]);
	});
});

describe("a reading without segments", () => {
	it("removes nothing however often it repeats", async () => {
		const harness = makeService({
			states: { "roborock.0.Devices.duid1.floors.0.17": {} },
			objects: { "Devices.duid1.floors.0.17": roomSwitch() },
		});

		await readMap(harness, 0, [], ROOM_ABSENCE_THRESHOLD + 5);
		expect(harness.deleted).toEqual([]);
	});
});

describe("the other floors", () => {
	it("keeps their switches, which are not orphans just because this map lacks them", async () => {
		const harness = makeService({
			states: {
				"roborock.0.Devices.duid1.floors.0.17": {},
				"roborock.0.Devices.duid1.floors.1.17": {},
				"roborock.0.Devices.duid1.floors.1.18": {},
			},
			objects: {
				"Devices.duid1.floors.0.17": roomSwitch(),
				"Devices.duid1.floors.1.17": roomSwitch(),
				"Devices.duid1.floors.1.18": roomSwitch(),
			},
		});

		// Map 0 no longer has room 17; map 1 is never read here at all.
		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD);

		expect(harness.deleted).toEqual(["Devices.duid1.floors.0.17"]);
	});
});

describe("objects that are not our room switches", () => {
	it("leaves a state without a segment id alone", async () => {
		// Somebody else's state below the floor - the adapter never wrote it and does not own it.
		const harness = makeService({
			states: { "roborock.0.Devices.duid1.floors.0.17": {} },
			objects: { "Devices.duid1.floors.0.17": { type: "state" } },
		});

		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD);
		expect(harness.deleted).toEqual([]);
	});

	it("leaves a channel or folder alone", async () => {
		const harness = makeService({
			states: { "roborock.0.Devices.duid1.floors.0.17": {} },
			objects: { "Devices.duid1.floors.0.17": { type: "channel", native: { id: 17 } } },
		});

		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD);
		expect(harness.deleted).toEqual([]);
	});

	it("leaves anything deeper than a direct child alone", async () => {
		const harness = makeService({
			states: { "roborock.0.Devices.duid1.floors.0.17.something": {} },
			objects: { "Devices.duid1.floors.0.17.something": roomSwitch() },
		});

		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD);
		expect(harness.deleted).toEqual([]);
	});
});

describe("a room the robot really lost", () => {
	it("survives until the evidence is complete, then goes with a reason in the log", async () => {
		const harness = makeService({
			states: {
				"roborock.0.Devices.duid1.floors.0.16": {},
				"roborock.0.Devices.duid1.floors.0.17": {},
			},
			objects: {
				"Devices.duid1.floors.0.16": roomSwitch(),
				"Devices.duid1.floors.0.17": roomSwitch(),
			},
		});

		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD - 1);
		expect(harness.deleted).toEqual([]);

		await readMap(harness, 0, [16]);
		expect(harness.deleted).toEqual(["Devices.duid1.floors.0.17"]);

		// The log has to explain a switch that vanished, or nobody can tell it from a bug.
		const reason = harness.logs.find((line) => line.includes("floors.0.17"));
		expect(reason).toBeTruthy();
		expect(reason).toMatch(/split or merged/i);
	});

	it("starts the evidence over when the room comes back in between", async () => {
		const harness = makeService({
			states: {
				"roborock.0.Devices.duid1.floors.0.16": {},
				"roborock.0.Devices.duid1.floors.0.17": {},
			},
			objects: {
				"Devices.duid1.floors.0.16": roomSwitch(),
				"Devices.duid1.floors.0.17": roomSwitch(),
			},
		});

		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD - 1);
		await readMap(harness, 0, [16, 17]);
		await readMap(harness, 0, [16], ROOM_ABSENCE_THRESHOLD - 1);

		expect(harness.deleted).toEqual([]);
	});
});
