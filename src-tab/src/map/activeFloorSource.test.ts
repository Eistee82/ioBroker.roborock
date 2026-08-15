import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_MAP_STATE, ActiveFloorSource, readMapFlag } from "./activeFloorSource";
import type { EngineConnection } from "../engine/types";

/**
 * The marker that says which floor the robot is on.
 *
 * Small, and its job is mostly to stay out of the way: a robot that does not publish the state has
 * to leave the selector exactly as it was. The failure worth guarding against is the opposite of
 * the usual one - not "nothing is shown" but "the wrong floor is marked", which on a two-floor
 * robot reads as a definite statement about where the machine is.
 */

const ROOT = `roborock.0.Devices.duid1.${ACTIVE_MAP_STATE}`;

let live: ActiveFloorSource | null = null;

afterEach(() => {
	live?.destroy();
	live = null;
});

function harness(values: Record<string, { val: unknown }> = {}) {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();
	const reported: (number | null)[] = [];

	const connection = {
		sendTo: vi.fn(),
		getObject: vi.fn(),
		getStates: vi.fn(async (ids: string[]) => {
			const answer: Record<string, any> = {};
			for (const id of ids) if (values[id]) answer[id] = values[id];
			return answer;
		}),
		subscribeState: vi.fn(async (id: string, handler: (id: string, state: any) => void) => {
			const list = subscriptions.get(id) ?? [];
			list.push(handler);
			subscriptions.set(id, list);
		}),
		unsubscribeState: vi.fn((id: string, handler: (id: string, state: any) => void) => {
			const list = (subscriptions.get(id) ?? []).filter(entry => entry !== handler);
			if (list.length) subscriptions.set(id, list);
			else subscriptions.delete(id);
		}),
		getObjectViewSystem: vi.fn(),
	} as unknown as EngineConnection;

	const source = new ActiveFloorSource(connection, { onActiveFloor: flag => reported.push(flag) });
	live = source;

	return {
		source,
		connection,
		subscriptions,
		reported,
		fire: (val: unknown) => {
			for (const handler of subscriptions.get(ROOT) ?? []) handler(ROOT, { val });
		},
	};
}

describe("reading a map flag", () => {
	it("takes the numbers a slot can have", () => {
		expect(readMapFlag(0)).toBe(0);
		expect(readMapFlag(1)).toBe(1);
		expect(readMapFlag("2")).toBe(2);
	});

	it("refuses everything that is not one", () => {
		// `null` for an unknown floor rather than 0: slot 0 is a real floor, and defaulting to it
		// would mark the ground floor as "the robot is here" on a robot that never said so.
		for (const value of [null, undefined, "", "ground floor", -1, 1.5, Number.NaN]) {
			expect(readMapFlag(value), `${JSON.stringify(value)} is not a flag`).toBeNull();
		}
	});
});

describe("ActiveFloorSource", () => {
	it("reports the floor the robot is on", async () => {
		const h = harness({ [ROOT]: { val: 1 } });
		await h.source.setDevice("roborock.0", "duid1");

		expect(h.reported.at(-1)).toBe(1);
	});

	it("follows a floor switch", async () => {
		const h = harness({ [ROOT]: { val: 0 } });
		await h.source.setDevice("roborock.0", "duid1");

		h.fire(1);
		expect(h.reported.at(-1)).toBe(1);
	});

	it("marks nothing for a robot that does not publish the state", async () => {
		const h = harness();
		await h.source.setDevice("roborock.0", "duid1");

		expect(h.reported.at(-1)).toBeNull();
	});

	it("marks nothing rather than failing when the state cannot be read", async () => {
		const h = harness();
		(h.connection.getStates as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no socket"));

		await expect(h.source.setDevice("roborock.0", "duid1")).resolves.toBeUndefined();
		expect(h.reported.at(-1)).toBeNull();
	});

	it("clears the marker and the subscription when the device is cleared", async () => {
		const h = harness({ [ROOT]: { val: 1 } });
		await h.source.setDevice("roborock.0", "duid1");
		expect(h.subscriptions.has(ROOT)).toBe(true);

		await h.source.setDevice("roborock.0", "");
		expect(h.reported.at(-1)).toBeNull();
		expect(h.subscriptions.has(ROOT)).toBe(false);
	});

	it("does not carry one robot's floor over to the next", async () => {
		// Switching robots must not leave the previous machine's slot marked on a device that has
		// not reported one - that would be a confident statement about the wrong robot.
		const h = harness({ [ROOT]: { val: 1 } });
		await h.source.setDevice("roborock.0", "duid1");

		await h.source.setDevice("roborock.0", "duid2");
		expect(h.reported.at(-1)).toBeNull();
	});

	it("stops reporting once it is destroyed", async () => {
		const h = harness({ [ROOT]: { val: 0 } });
		await h.source.setDevice("roborock.0", "duid1");
		const before = h.reported.length;

		h.source.destroy();
		h.fire(1);
		expect(h.reported.length).toBe(before);
	});
});
