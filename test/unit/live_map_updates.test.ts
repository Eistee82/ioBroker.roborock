import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveMapPoller, MAP_DIFF_METHOD } from "../../src/lib/map/LiveMapPoller";
import { MapManager } from "../../src/lib/map/MapManager";
import {
	MAP_DIFF_COUNT,
	evaluateMapDiff,
	extractBlockNonces,
	extractMapNonce,
	findOutdatedBlock,
	supportsIncrementalMap
} from "../../src/lib/map/mapDiff";
import { MockRobot } from "../../src/lib/mock/MockRobot";
import {
	LIVE_MAP_DISABLED,
	LIVE_MAP_POLICY,
	getLiveMapIntervalSeconds,
	resolveLiveMapIntervalSeconds
} from "../../src/lib/requestPolicy";

const NONCE = 1000;
/** `new_feature_info_str` with bit 22 set: the robot offers the incremental map. */
const FEATURE_STR_WITH_BIT = (1n << 22n).toString(16);
/** Same string without that bit. */
const FEATURE_STR_WITHOUT_BIT = (1n << 21n).toString(16);

describe("map diff evaluation", () => {
	it("keeps the map when the robot reports no change - the point of the whole mechanism", () => {
		const decision = evaluateMapDiff({ result: 0, nonce: NONCE, diff: {} }, NONCE);

		expect(decision.fetchFullMap).toBe(false);
		expect(decision.nonceStale).toBe(false);
	});

	it("keeps the map when a block changed by less than its threshold", () => {
		// Block 2 is the image; the app only reacts above `mapDiffCount`.
		const decision = evaluateMapDiff({ result: 0, nonce: NONCE, diff: { "2": { count: MAP_DIFF_COUNT } } }, NONCE);

		expect(decision.fetchFullMap).toBe(false);
	});

	it("fetches the map once the image changed by more than the threshold", () => {
		const decision = evaluateMapDiff({ result: 0, nonce: NONCE, diff: { "2": { count: MAP_DIFF_COUNT + 1 } } }, NONCE);

		expect(decision.fetchFullMap).toBe(true);
	});

	it("fetches the map on any path change, because the adapter cannot patch a drawn map", () => {
		const decision = evaluateMapDiff({ result: 0, nonce: NONCE, diff: { "3": { count: 1 } } }, NONCE);

		expect(decision.fetchFullMap).toBe(true);
	});

	it("fetches the map on any furniture change", () => {
		const decision = evaluateMapDiff({ result: 0, nonce: NONCE, diff: { "25": { count: 1 } } }, NONCE);

		expect(decision.fetchFullMap).toBe(true);
	});

	it("ignores blocks that are in no threshold table", () => {
		const decision = evaluateMapDiff({ result: 0, nonce: NONCE, diff: { "99": { count: 5000 } } }, NONCE);

		expect(decision.fetchFullMap).toBe(false);
	});

	it("takes the whole map when the robot asks for it outright (result 2)", () => {
		const decision = evaluateMapDiff({ result: 2 }, NONCE);

		expect(decision.fetchFullMap).toBe(true);
		expect(decision.nonceStale).toBe(false);
	});

	it("drops the cached nonce when the robot moved on to another map (result 1)", () => {
		const decision = evaluateMapDiff({ result: 1, nonce: NONCE + 7 }, NONCE);

		expect(decision.fetchFullMap).toBe(true);
		expect(decision.nonceStale).toBe(true);
	});

	it("drops the cached nonce when a result-0 answer belongs to a different map", () => {
		const decision = evaluateMapDiff({ result: 0, nonce: NONCE + 7, diff: {} }, NONCE);

		expect(decision.fetchFullMap).toBe(true);
		expect(decision.nonceStale).toBe(true);
	});

	it("unwraps the single element arrays the V1 transport adds", () => {
		const decision = evaluateMapDiff([{ result: 0, nonce: NONCE, diff: {} }], NONCE);

		expect(decision.fetchFullMap).toBe(false);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["a string", "nope"],
		["an unknown result code", { result: 42 }],
		["a missing result code", { nonce: NONCE, diff: {} }]
	])("fetches the full map when the answer is %s - a swallowed change is worse than a spare transfer", (_label, raw) => {
		expect(evaluateMapDiff(raw, NONCE).fetchFullMap).toBe(true);
	});
});

describe("map nonce", () => {
	it("reads the NONCEDATA entry of type 35", () => {
		const mapData = { NONCEDATA: [{ type: 1, unixTime: 5 }, { type: 35, unixTime: 4242 }] };

		expect(extractMapNonce(mapData)).toBe(4242);
	});

	it("returns null when the map carries no nonce entry", () => {
		expect(extractMapNonce({ NONCEDATA: [{ type: 1, unixTime: 5 }] })).toBeNull();
	});

	it("treats a zero as no nonce, because the robot then reports nothing as changed", () => {
		// Measured at the device: a map whose type-35 entry is 0 makes every later diff come back
		// with `count: 0` for every block, even after the map has been replaced entirely. Passing
		// the 0 on kept the poller on the incremental branch, where it concluded "nothing changed"
		// forever and the shown map froze at the state it had when the zero first appeared.
		expect(extractMapNonce({ NONCEDATA: [{ type: 35, unixTime: 0 }] })).toBeNull();
		expect(extractMapNonce({ NONCEDATA: [{ type: 35, unixTime: -1 }] })).toBeNull();
	});

	it("still finds a later, valid entry when an earlier one is unusable", () => {
		expect(extractMapNonce({ NONCEDATA: [{ type: 35, unixTime: 0 }, { type: 35, unixTime: 4242 }] })).toBe(4242);
	});

	it.each([[undefined], [null], [{}], [{ NONCEDATA: "nope" }]])("returns null for %s", (mapData) => {
		expect(extractMapNonce(mapData)).toBeNull();
	});
});

describe("incremental map feature bit", () => {
	it("accepts a robot that sets bit 22", () => {
		expect(supportsIncrementalMap(FEATURE_STR_WITH_BIT)).toBe(true);
		expect(supportsIncrementalMap(`0x${FEATURE_STR_WITH_BIT}`)).toBe(true);
	});

	it("rejects a robot that does not", () => {
		expect(supportsIncrementalMap(FEATURE_STR_WITHOUT_BIT)).toBe(false);
	});

	it.each([[undefined], [null], [""], ["zzz"], [42]])("rejects the unreadable value %s", (raw) => {
		expect(supportsIncrementalMap(raw)).toBe(false);
	});
});

describe("live map cadence", () => {
	it("is off when the interval is 0", () => {
		expect(resolveLiveMapIntervalSeconds(0)).toBe(LIVE_MAP_DISABLED);
		expect(getLiveMapIntervalSeconds({ configuredSeconds: 0, isActive: true, supportsIncrementalMap: true })).toBe(LIVE_MAP_DISABLED);
	});

	it("uses the configured value while the robot works", () => {
		expect(getLiveMapIntervalSeconds({ configuredSeconds: 2, isActive: true, supportsIncrementalMap: true })).toBe(2);
	});

	it("waits longer while the robot stands still, the way the app does", () => {
		expect(getLiveMapIntervalSeconds({ configuredSeconds: 2, isActive: false, supportsIncrementalMap: true }))
			.toBe(2 * LIVE_MAP_POLICY.idleFactor);
	});

	it("never transfers a whole map faster than the floor when the robot has no diff", () => {
		const interval = getLiveMapIntervalSeconds({ configuredSeconds: 1, isActive: true, supportsIncrementalMap: false });

		expect(interval).toBe(LIVE_MAP_POLICY.fullMapFloorSeconds);
	});

	it("transfers no map at all while a robot without the diff is idle", () => {
		// Before this feature the adapter fetched nothing while idle; a full map every few
		// seconds on a docked robot would be a pure regression.
		expect(getLiveMapIntervalSeconds({ configuredSeconds: 1, isActive: false, supportsIncrementalMap: false }))
			.toBe(LIVE_MAP_DISABLED);
	});

	it("clamps a hand edited out of range value instead of obeying it", () => {
		expect(resolveLiveMapIntervalSeconds(9999)).toBe(30);
		expect(resolveLiveMapIntervalSeconds(undefined)).toBe(LIVE_MAP_POLICY.activeIntervalSeconds);
	});
});

type PollerEnv = {
	poller: LiveMapPoller;
	robot: MockRobot;
	updateMap: ReturnType<typeof vi.fn>;
	sendRequest: ReturnType<typeof vi.fn>;
	tick: (isActive?: boolean) => Promise<void>;
	/** Moves the clock past the cadence so the next tick is due. */
	advance: (seconds?: number) => void;
	diffCalls: () => { method: string; params: any }[];
};

function createPollerEnv(options: {
	liveMapInterval?: number;
	featureStr?: string | null;
	nonce?: number | null;
	isLocating?: number;
} = {}): PollerEnv {
	const robot = new MockRobot();
	const updateMap = vi.fn().mockResolvedValue(undefined);

	const sendRequest = vi.fn(async (_duid: string, method: string, params: unknown) => robot.handleRequest(method, params));

	const states: Record<string, unknown> = {
		new_feature_info_str: options.featureStr === undefined ? FEATURE_STR_WITH_BIT : options.featureStr,
		is_locating: options.isLocating ?? 0
	};

	const adapter = {
		config: { liveMapInterval: options.liveMapInterval ?? 2 },
		requestsHandler: { sendRequest },
		getStateAsync: vi.fn(async (id: string) => {
			const key = id.split(".").pop() as string;
			const val = states[key];
			return val === undefined || val === null ? null : { val };
		}),
		rLog: vi.fn(),
		errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e))
	};

	const nonce = options.nonce === undefined ? NONCE : options.nonce;
	vi.spyOn(MapManager, "getMapNonce").mockImplementation(() => nonce);
	vi.spyOn(MapManager, "forgetMapNonce").mockImplementation(() => undefined);

	const poller = new LiveMapPoller(adapter as any);

	return {
		poller,
		robot,
		updateMap,
		sendRequest,
		tick: async (isActive = true): Promise<void> => {
			await poller.tick("duid-1", { updateMap }, isActive);
		},
		advance: (seconds = 60): void => {
			vi.setSystemTime(Date.now() + seconds * 1000);
		},
		diffCalls: (): { method: string; params: any }[] => robot.seen.filter((r) => r.method === MAP_DIFF_METHOD)
	};
}

describe("LiveMapPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("asks for the difference and does NOT fetch a full map when nothing changed", async () => {
		const env = createPollerEnv();

		await env.tick();

		expect(env.diffCalls()).toHaveLength(1);
		expect(env.diffCalls()[0].params).toMatchObject({ nonce: NONCE });
		expect(env.updateMap).not.toHaveBeenCalled();
	});

	it("stays quiet over many cycles while the robot changes nothing", async () => {
		const env = createPollerEnv();

		for (let i = 0; i < 10; i++) {
			await env.tick();
			env.advance();
		}

		expect(env.diffCalls()).toHaveLength(10);
		expect(env.updateMap).not.toHaveBeenCalled();
	});

	it("fetches the full map as soon as the difference reports a change", async () => {
		const env = createPollerEnv();
		env.robot.mapDiffAnswers = [{ result: 0, nonce: NONCE, diff: { "3": { count: 4 } } }];

		await env.tick();

		expect(env.updateMap).toHaveBeenCalledTimes(1);
	});

	it("sends the round parameter the app sends", async () => {
		const env = createPollerEnv();

		await env.tick();

		expect(env.diffCalls()[0].params.round).toBe(Date.now());
	});

	it("respects the cadence: a second tick inside the interval does nothing", async () => {
		const env = createPollerEnv({ liveMapInterval: 5 });

		await env.tick();
		env.advance(1);
		await env.tick();

		expect(env.diffCalls()).toHaveLength(1);
	});

	it("waits twice as long while the robot stands still", async () => {
		const env = createPollerEnv({ liveMapInterval: 2 });

		await env.tick(false);
		env.advance(3);
		await env.tick(false);

		expect(env.diffCalls()).toHaveLength(1);

		env.advance(2);
		await env.tick(false);
		expect(env.diffCalls()).toHaveLength(2);
	});

	it("does nothing at all while the robot is re-locating itself", async () => {
		const env = createPollerEnv({ isLocating: 1 });

		await env.tick();

		expect(env.diffCalls()).toHaveLength(0);
		expect(env.updateMap).not.toHaveBeenCalled();
	});

	it("does nothing when the feature is switched off", async () => {
		const env = createPollerEnv({ liveMapInterval: 0 });

		await env.tick();

		expect(env.poller.isEnabled()).toBe(false);
		expect(env.diffCalls()).toHaveLength(0);
		expect(env.updateMap).not.toHaveBeenCalled();
	});

	describe("robots without the incremental map", () => {
		it("never asks for a difference and takes the whole map instead", async () => {
			const env = createPollerEnv({ featureStr: FEATURE_STR_WITHOUT_BIT });

			await env.tick();

			expect(env.diffCalls()).toHaveLength(0);
			expect(env.updateMap).toHaveBeenCalledTimes(1);
		});

		it("is held to the slower floor even when a fast cadence is configured", async () => {
			const env = createPollerEnv({ featureStr: FEATURE_STR_WITHOUT_BIT, liveMapInterval: 1 });

			await env.tick();
			env.advance(LIVE_MAP_POLICY.fullMapFloorSeconds - 1);
			await env.tick();

			expect(env.updateMap).toHaveBeenCalledTimes(1);

			env.advance(2);
			await env.tick();
			expect(env.updateMap).toHaveBeenCalledTimes(2);
		});

		it("takes the same branch while no map with a nonce has been parsed yet", async () => {
			const env = createPollerEnv({ nonce: null });

			await env.tick();

			expect(env.diffCalls()).toHaveLength(0);
			expect(env.updateMap).toHaveBeenCalledTimes(1);
		});

		it("fetches nothing while the robot is idle", async () => {
			const env = createPollerEnv({ featureStr: FEATURE_STR_WITHOUT_BIT });

			await env.tick(false);

			expect(env.updateMap).not.toHaveBeenCalled();
			expect(env.poller.handlesMapFor("duid-1")).toBe(false);
		});
	});

	it("gives up on the difference after repeated failures and keeps the map updated", async () => {
		const env = createPollerEnv();
		env.sendRequest.mockRejectedValue(new Error("unknown method"));

		for (let i = 0; i < 3; i++) {
			await env.tick();
			env.advance();
		}

		expect(env.sendRequest).toHaveBeenCalledTimes(3);
		expect(env.updateMap).not.toHaveBeenCalled();

		// From here on the robot is treated as one without the incremental map: no further diff
		// attempts, but the map keeps being fetched.
		await env.tick();
		expect(env.sendRequest).toHaveBeenCalledTimes(3);
		expect(env.updateMap).toHaveBeenCalledTimes(1);
	});

	it("does not claim the map before a cycle succeeded", async () => {
		const env = createPollerEnv();
		expect(env.poller.handlesMapFor("duid-1")).toBe(false);

		await env.tick();

		expect(env.poller.handlesMapFor("duid-1")).toBe(true);
	});

	it("hands the map back to the status poll after a failure", async () => {
		const env = createPollerEnv();
		await env.tick();
		expect(env.poller.handlesMapFor("duid-1")).toBe(true);

		env.sendRequest.mockRejectedValue(new Error("boom"));
		env.advance();
		await env.tick();

		expect(env.poller.handlesMapFor("duid-1")).toBe(false);
	});

	it("stops after dispose and runs again after start", async () => {
		const env = createPollerEnv();

		env.poller.dispose();
		await env.tick();
		expect(env.diffCalls()).toHaveLength(0);

		env.poller.start();
		await env.tick();
		expect(env.diffCalls()).toHaveLength(1);
	});
});

describe("per-channel nonces", () => {
	it("reads the channel nonces and leaves out the map nonce itself", () => {
		// Shape taken from the test device: entry type 35 is the map nonce, every other type is
		// the channel number the diff answers under.
		const map = {
			NONCEDATA: [
				{ type: 35, unixTime: 1786726275 },
				{ type: 3, unixTime: 1786721586 },
				{ type: 11, unixTime: 1786726193 }
			]
		};

		const nonces = extractBlockNonces(map);
		expect(nonces.get(3)).toBe(1786721586);
		expect(nonces.get(11)).toBe(1786726193);
		expect(nonces.has(35)).toBe(false);
	});

	it("skips entries that carry no usable nonce", () => {
		const nonces = extractBlockNonces({ NONCEDATA: [{ type: 3, unixTime: 0 }, { type: 6, unixTime: "x" }, { type: 11, unixTime: 5 }] });
		expect(nonces.has(3)).toBe(false);
		expect(nonces.has(6)).toBe(false);
		expect(nonces.get(11)).toBe(5);
	});

	it.each([[undefined], [null], [{}], [{ NONCEDATA: "nope" }]])("answers with an empty map for %s", (mapData) => {
		expect(extractBlockNonces(mapData).size).toBe(0);
	});

	it("spots a channel whose nonce moved", () => {
		const answer = new Map([[3, 999], [11, 5]]);
		const held = new Map([[3, 111], [11, 5]]);
		expect(findOutdatedBlock(answer, held)).toContain("channel 3");
	});

	it("stays quiet while every shared channel matches", () => {
		const same = new Map([[3, 111], [11, 5]]);
		expect(findOutdatedBlock(same, new Map(same))).toBeNull();
	});

	it("ignores channels the held map does not mention", () => {
		// The robot lists channels it supports; the map only carries those it has data for. A
		// channel missing from the map is not evidence that the map is stale.
		expect(findOutdatedBlock(new Map([[42, 7]]), new Map([[3, 111]]))).toBeNull();
	});

	it("says nothing when no map is held yet", () => {
		expect(findOutdatedBlock(new Map([[3, 999]]), new Map())).toBeNull();
	});
});
