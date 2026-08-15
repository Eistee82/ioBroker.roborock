import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIVE_TRACK_STATE, LiveMapPoller, MAP_DIFF_METHOD } from "../../src/lib/map/LiveMapPoller";
import { DYNAMIC_DATA_METHOD } from "../../src/lib/map/dynamicData";
import { MapManager } from "../../src/lib/map/MapManager";
import {
	LIVE_TRACK_DISABLED,
	LIVE_TRACK_POLICY,
	LIVE_TRACK_TICK_MS,
	MAX_LIVE_TRACK_INTERVAL_SECONDS,
	getLiveTrackIntervalSeconds,
	resolveLiveTrackIntervalSeconds
} from "../../src/lib/requestPolicy";

const DUID = "duid-track";
const NONCE = 4711;
/** `new_feature_info_str` with bit 22 set: the robot offers the incremental map. */
const FEATURE_STR_WITH_BIT = (1n << 22n).toString(16);
/** Same string without that bit, which puts the map on the full-transfer branch. */
const FEATURE_STR_WITHOUT_BIT = (1n << 21n).toString(16);

/** Builds one block of the dynamic payload: 8 byte header, then the body. */
function block(type: number, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt16LE(type, 0);
	header.writeUInt16LE(8, 2);
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

/** Position block as the robot sends it: x, y and angle as little-endian int32, in millimetres. */
function positionBlock(x: number, y: number, angle: number): Buffer {
	const body = Buffer.alloc(12);
	body.writeInt32LE(x, 0);
	body.writeInt32LE(y, 4);
	body.writeInt32LE(angle, 8);
	return block(8, body);
}

type EnvOptions = {
	/** Cadence of the live position channel; omitted means the policy default. */
	liveTrackInterval?: number;
	/** Cadence of the map check. */
	liveMapInterval?: number;
	/** `new_feature_info_str` the robot reports. */
	featureStr?: string | null;
	/** `deviceStatus.is_locating`. */
	isLocating?: number;
	/** Milliseconds every request appears to take, so fake timers can show scheduling effects. */
	roundTripMs?: number;
};

function createEnv(options: EnvOptions = {}) {
	const calls: { method: string; params: any }[] = [];
	/** Answer of `get_dynamic_map_diff`; replaceable per test. */
	let diffAnswer: unknown = [{ result: 0, nonce: NONCE, diff: { "3": { max_len: 2, nonce: NONCE, count: 0 } } }];
	/** Channel length the next diff reports, so a test can make the track look changed. */
	let maxLen = 2;
	let failDiff: Error | null = null;

	const payload = Buffer.concat([positionBlock(32587, 22591, -137)]);

	const sendRequest = vi.fn(async (_duid: string, method: string, params: unknown) => {
		calls.push({ method, params });
		if (options.roundTripMs) vi.setSystemTime(Date.now() + options.roundTripMs);

		if (method === MAP_DIFF_METHOD) {
			if (failDiff) throw failDiff;
			return diffAnswer;
		}
		if (method === DYNAMIC_DATA_METHOD) {
			return [{ nonce: NONCE, data_id: 3, start: 0, len: maxLen, max_len: maxLen, result: 0, data: payload.toString("base64") }];
		}
		throw new Error(`unexpected method ${method}`);
	});

	const states: Record<string, unknown> = {
		new_feature_info_str: options.featureStr === undefined ? FEATURE_STR_WITH_BIT : options.featureStr,
		is_locating: options.isLocating ?? 0
	};

	const adapter: any = {
		config: {
			liveMapInterval: options.liveMapInterval ?? 3,
			liveTrackInterval: options.liveTrackInterval
		},
		requestsHandler: { sendRequest },
		getStateAsync: vi.fn(async (id: string) => {
			const key = id.split(".").pop() as string;
			const value = states[key];
			return value === undefined || value === null ? null : { val: value };
		}),
		ensureState: vi.fn(async () => undefined),
		setStateChangedAsync: vi.fn(async () => undefined),
		rLog: vi.fn(),
		errorMessage: (error: unknown): string => (error instanceof Error ? error.message : String(error))
	};

	let mapNonce: number | null = NONCE;
	vi.spyOn(MapManager, "getMapNonce").mockImplementation(() => mapNonce);
	vi.spyOn(MapManager, "getBlockNonces").mockImplementation(() => new Map<number, number>());
	vi.spyOn(MapManager, "forgetMapNonce").mockImplementation(() => undefined);

	const updateMap = vi.fn().mockResolvedValue(undefined);
	const poller = new LiveMapPoller(adapter);

	return {
		adapter,
		poller,
		updateMap,
		sendRequest,
		state: (): any => (poller as any).getState(DUID),
		countOf: (method: string): number => calls.filter(call => call.method === method).length,
		paramsOf: (method: string): any[] => calls.filter(call => call.method === method).map(call => call.params),
		setMapNonce: (value: number | null): void => {
			mapNonce = value;
		},
		setDiffAnswer: (answer: unknown): void => {
			diffAnswer = answer;
		},
		setChannelLength: (value: number): void => {
			maxLen = value;
			diffAnswer = [{ result: 0, nonce: NONCE, diff: { "3": { max_len: value, nonce: NONCE, count: 0 } } }];
		},
		failDiffWith: (error: Error | null): void => {
			failDiff = error;
		},
		track: (isActive = true): Promise<void> => poller.tickDynamic(DUID, isActive),
		map: (isActive = true): Promise<void> => poller.tick(DUID, { updateMap }, isActive),
		advance: (ms: number): void => {
			vi.setSystemTime(Date.now() + ms);
		}
	};
}

/** Lets every already-resolved promise in a fire-and-forget cycle run. */
async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

describe("live track cadence policy", () => {
	it("defaults to one second while the robot works, faster than the app's 1.2 s", () => {
		expect(LIVE_TRACK_POLICY.activeIntervalSeconds).toBe(1);
		expect(resolveLiveTrackIntervalSeconds(undefined)).toBe(1);
		expect(getLiveTrackIntervalSeconds({ isActive: true })).toBe(1);
	});

	it("waits twice as long while the robot stands still", () => {
		expect(getLiveTrackIntervalSeconds({ configuredSeconds: 1, isActive: false })).toBe(LIVE_TRACK_POLICY.idleFactor);
		expect(getLiveTrackIntervalSeconds({ configuredSeconds: 4, isActive: false })).toBe(4 * LIVE_TRACK_POLICY.idleFactor);
	});

	it("is off when the interval is 0", () => {
		expect(resolveLiveTrackIntervalSeconds(0)).toBe(LIVE_TRACK_DISABLED);
		expect(getLiveTrackIntervalSeconds({ configuredSeconds: 0, isActive: true })).toBe(LIVE_TRACK_DISABLED);
	});

	it("clamps a hand edited out of range value instead of obeying it", () => {
		expect(resolveLiveTrackIntervalSeconds(9999)).toBe(MAX_LIVE_TRACK_INTERVAL_SECONDS);
		expect(resolveLiveTrackIntervalSeconds("nonsense" as unknown as number)).toBe(LIVE_TRACK_POLICY.activeIntervalSeconds);
	});

	it("ticks faster than the fastest cadence, or a 1 s setting would really be 2 s", () => {
		// A slot that falls due a few milliseconds after the tick that could have served it waits a
		// whole further period. The ticker therefore has to be strictly finer than the cadence.
		expect(LIVE_TRACK_TICK_MS).toBeLessThan(LIVE_TRACK_POLICY.activeIntervalSeconds * 1000);
	});
});

describe("live track cycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("asks for the diff itself and writes the position it gets back", async () => {
		const env = createEnv();

		await env.track();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
		const [, written] = env.adapter.setStateChangedAsync.mock.calls[0];
		expect(JSON.parse(written.val).position).to.deep.equal({ x: 32587, y: 22591, angle: -137 });
		expect(env.adapter.setStateChangedAsync.mock.calls[0][0]).toBe(`Devices.${DUID}.${LIVE_TRACK_STATE}`);
	});

	it("keeps its own cadence: a second tick inside the interval does nothing", async () => {
		const env = createEnv({ liveTrackInterval: 2 });

		await env.track();
		env.advance(1_000);
		await env.track();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		env.advance(1_000);
		env.setChannelLength(3);
		await env.track();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("waits twice as long while the robot stands still", async () => {
		const env = createEnv({ liveTrackInterval: 1 });

		await env.track(false);
		env.advance(1_000);
		await env.track(false);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		env.advance(1_000);
		await env.track(false);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("does not add its own round trip to the cadence", async () => {
		// Scheduling from the end of the work instead of from its start would push the next slot to
		// 1300 ms and drift further with every pass, so a 1 s setting would never be a 1 s cadence.
		const env = createEnv({ liveTrackInterval: 1, roundTripMs: 150 });

		await env.track();
		const spent = Date.now();
		env.advance(1_000 - (spent - new Date("2026-01-01T00:00:00Z").getTime()));
		env.setChannelLength(3);
		await env.track();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("does nothing at all while the robot is re-locating itself", async () => {
		const env = createEnv({ isLocating: 1 });

		await env.track();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(0);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(0);
	});

	it("is off when the channel is switched off, and says so", async () => {
		const env = createEnv({ liveTrackInterval: 0 });

		await env.track();

		expect(env.poller.isTrackEnabled()).toBe(false);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(0);
	});

	it("gives up after repeated diff failures and stops asking", async () => {
		const env = createEnv({ liveTrackInterval: 1 });
		env.failDiffWith(new Error("unknown method"));

		for (let round = 0; round < 3; round++) {
			await env.track();
			env.advance(1_000);
		}
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(3);
		expect(env.state().trackDiffGaveUp).toBe(true);

		await env.track();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(3);
	});

	it("does not count a dead channel against the robot", async () => {
		const env = createEnv({ liveTrackInterval: 1 });
		const unavailable = Object.assign(new Error("channel down"), { code: "CHANNEL_UNAVAILABLE" });
		env.failDiffWith(unavailable);

		for (let round = 0; round < 4; round++) {
			await env.track();
			env.advance(1_000);
		}

		expect(env.state().trackDiffGaveUp).toBe(false);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(4);
	});
});

describe("live track is independent of the map cycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("updates the position while a full map transfer is still running", async () => {
		// The regression this whole change is about: the map cycle held one shared in-flight flag,
		// so the position stood still for exactly as long as a map took to arrive - seconds, over
		// the cloud, precisely while the robot was moving.
		const env = createEnv({ liveTrackInterval: 1 });
		env.setDiffAnswer([{ result: 0, nonce: NONCE, diff: { "3": { max_len: 2, nonce: NONCE, count: 4 } } }]);
		env.updateMap.mockReturnValue(new Promise<void>(() => undefined));

		void env.map();
		await flushMicrotasks();
		expect(env.state().inFlight).toBe(true);

		await env.track();

		expect(env.state().dynamicInFlight).toBe(false);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("runs for a robot that has no incremental map at all", async () => {
		// Such a robot never reached `refreshDynamicTrack` before, because the only call site sat
		// inside the incremental branch it never takes.
		const env = createEnv({ liveTrackInterval: 1, featureStr: FEATURE_STR_WITHOUT_BIT });

		await env.track();

		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("runs while the live map refresh is switched off", async () => {
		const env = createEnv({ liveTrackInterval: 1, liveMapInterval: 0 });

		expect(env.poller.isEnabled()).toBe(false);
		await env.track();

		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("the map cycle no longer fetches the track", async () => {
		const env = createEnv();

		await env.map();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(0);
	});

	it("keeps polling the position when the map cycle gave up on the diff", async () => {
		const env = createEnv({ liveTrackInterval: 1 });
		env.state().diffGaveUp = true;

		await env.track();

		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});
});

describe("shared diff answer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("asks once when both cycles fall due in the same moment", async () => {
		const env = createEnv({ liveTrackInterval: 1 });

		await env.map();
		await env.track();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("works in the other order as well", async () => {
		const env = createEnv({ liveTrackInterval: 1 });

		await env.track();
		await env.map();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
	});

	it("asks again once the answer is no longer fresh", async () => {
		const env = createEnv({ liveTrackInterval: 1 });

		await env.map();
		env.advance(400);
		await env.track();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("never reuses an answer that was asked with a different nonce", async () => {
		// What a diff reports depends on the nonce it was given, so an answer to another question
		// must not decide this one.
		const env = createEnv({ liveTrackInterval: 1 });

		await env.map();
		env.setMapNonce(NONCE + 1);
		await env.track();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
		expect(env.paramsOf(MAP_DIFF_METHOD).map(params => params.nonce)).to.deep.equal([NONCE, NONCE + 1]);
	});

	it("falls back to nonce 1 while no map has been parsed yet", async () => {
		// Measured at the device: a made-up nonce still returns the valid per-channel nonces, which
		// is all this cycle needs.
		const env = createEnv({ liveTrackInterval: 1 });
		env.setMapNonce(null);

		await env.track();

		expect(env.paramsOf(MAP_DIFF_METHOD)[0].nonce).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});
});
