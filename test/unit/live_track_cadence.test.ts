import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIVE_TRACK_STATE, LiveMapPoller, MAP_DIFF_METHOD } from "../../src/lib/map/LiveMapPoller";
import { DYNAMIC_DATA_METHOD } from "../../src/lib/map/dynamicData";
import { MapManager } from "../../src/lib/map/MapManager";
import { RequestPriority } from "../../src/lib/requestsHandler";
import {
	LEGACY_LIVE_TRACK_MAX_SECONDS,
	LIVE_TRACK_DISABLED,
	LIVE_TRACK_POLICY,
	LIVE_TRACK_REQUEST_PRIORITY,
	MAX_LIVE_TRACK_PAUSE_MS,
	MIN_LIVE_TRACK_PAUSE_MS,
	getLiveTrackPauseMs,
	resolveLiveTrackPauseMs
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
	/** Configured pause of the live position channel; omitted means the policy default. */
	liveTrackInterval?: number;
	/** Cadence of the map check. */
	liveMapInterval?: number;
	/** `new_feature_info_str` the robot reports. */
	featureStr?: string | null;
	/** `deviceStatus.is_locating`. */
	isLocating?: number;
	/** Milliseconds every request appears to take. */
	roundTripMs?: number;
};

function createEnv(options: EnvOptions = {}) {
	const calls: { method: string; params: any; priority: number | undefined }[] = [];
	/** Answer of `get_dynamic_map_diff`; replaceable per test. */
	let diffAnswer: unknown = [{ result: 0, nonce: NONCE, diff: { "3": { max_len: 2, nonce: NONCE, count: 0 } } }];
	/** Channel length the next diff reports, so a test can make the track look changed. */
	let maxLen = 2;
	let failDiff: Error | null = null;
	let positionX = 32587;

	const sendRequest = vi.fn(async (_duid: string, method: string, params: unknown, opts?: { priority?: number }) => {
		calls.push({ method, params, priority: opts?.priority });
		if (options.roundTripMs) vi.setSystemTime(Date.now() + options.roundTripMs);

		if (method === MAP_DIFF_METHOD) {
			if (failDiff) throw failDiff;
			return diffAnswer;
		}
		if (method === DYNAMIC_DATA_METHOD) {
			const payload = positionBlock(positionX, 22591, -137);
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
		// The real adapter's own timers, which is what the free-running cycle pauses on. Backed by
		// vitest's fake timers here, so a test can step the loop forward one pass at a time.
		setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
		clearTimeout: (timer: any) => clearTimeout(timer),
		rLog: vi.fn(),
		errorMessage: (error: unknown): string => (error instanceof Error ? error.message : String(error))
	};

	let mapNonce: number | null = NONCE;
	vi.spyOn(MapManager, "getMapNonce").mockImplementation(() => mapNonce);
	vi.spyOn(MapManager, "getBlockNonces").mockImplementation(() => new Map<number, number>());
	vi.spyOn(MapManager, "forgetMapNonce").mockImplementation(() => undefined);

	const updateMap = vi.fn().mockResolvedValue(undefined);
	const poller = new LiveMapPoller(adapter);

	let isActive = true;
	let isLocal = true;

	return {
		adapter,
		poller,
		updateMap,
		sendRequest,
		state: (): any => (poller as any).getState(DUID),
		countOf: (method: string): number => calls.filter(call => call.method === method).length,
		paramsOf: (method: string): any[] => calls.filter(call => call.method === method).map(call => call.params),
		priorityOf: (method: string): (number | undefined)[] => calls.filter(call => call.method === method).map(call => call.priority),
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
		movePosition: (value: number): void => {
			positionX = value;
		},
		failDiffWith: (error: Error | null): void => {
			failDiff = error;
		},
		setActive: (value: boolean): void => {
			isActive = value;
		},
		setLocal: (value: boolean): void => {
			isLocal = value;
		},
		/** Starts the free-running cycle; the first pass runs at once. */
		start: (): void =>
			poller.startDynamicCycle(DUID, {
				isActive: () => isActive,
				isLocal: () => isLocal
			}),
		stop: (): void => poller.stopDynamicCycle(DUID),
		/** Whether a pause is pending, i.e. whether the loop is still going. */
		isLooping: (): boolean => (poller as any).dynamicTimers.has(DUID) || (poller as any).dynamicLoops.has(DUID),
		map: (active = true): Promise<void> => poller.tick(DUID, { updateMap }, active),
		/** Lets the in-flight pass finish, and its pause be scheduled, without moving the clock. */
		settle: async (): Promise<void> => {
			// A pass awaits half a dozen promises before it schedules its pause; advancing by zero
			// drains those the way vitest intends, and the plain flushes catch the stragglers.
			await vi.advanceTimersByTimeAsync(0);
			for (let index = 0; index < 200; index++) await Promise.resolve();
		},
		/** Moves the clock, firing any pause that comes due, and lets the resulting pass finish. */
		advance: async (ms: number): Promise<void> => {
			await vi.advanceTimersByTimeAsync(ms);
			await vi.advanceTimersByTimeAsync(0);
			for (let index = 0; index < 200; index++) await Promise.resolve();
		}
	};
}

/** Lets every already-resolved promise in a fire-and-forget cycle run. */
async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 200; index++) await Promise.resolve();
}

describe("live track pacing policy", () => {
	it("defaults to a 200 ms pause while the robot works", () => {
		expect(LIVE_TRACK_POLICY.activePauseMs).toBe(200);
		expect(resolveLiveTrackPauseMs(undefined)).toBe(200);
		expect(getLiveTrackPauseMs({ isActive: true, isLocal: true })).toBe(200);
	});

	it("reads a stored whole-second setting in its old unit", () => {
		// The option kept its key, so an installation configured before the change has to keep the
		// behaviour it was configured for rather than suddenly polling a thousand times faster.
		expect(resolveLiveTrackPauseMs(1)).toBe(1000);
		expect(resolveLiveTrackPauseMs(5)).toBe(5000);
		expect(resolveLiveTrackPauseMs(LEGACY_LIVE_TRACK_MAX_SECONDS)).toBe(30_000);
	});

	it("reads everything above that range as milliseconds", () => {
		expect(resolveLiveTrackPauseMs(200)).toBe(200);
		expect(resolveLiveTrackPauseMs(MIN_LIVE_TRACK_PAUSE_MS)).toBe(MIN_LIVE_TRACK_PAUSE_MS);
		expect(resolveLiveTrackPauseMs(750)).toBe(750);
	});

	it("keeps the two units from overlapping", () => {
		// The whole legacy-value trick rests on this: no legal millisecond setting can look like a
		// legacy second setting, so nothing has to be guessed about where a stored number came from.
		expect(LEGACY_LIVE_TRACK_MAX_SECONDS).toBeLessThan(MIN_LIVE_TRACK_PAUSE_MS);
	});

	it("is off at 0", () => {
		expect(resolveLiveTrackPauseMs(0)).toBe(LIVE_TRACK_DISABLED);
		expect(getLiveTrackPauseMs({ configuredPause: 0, isActive: true, isLocal: true })).toBe(LIVE_TRACK_DISABLED);
	});

	it("clamps a hand edited out of range value instead of obeying it", () => {
		expect(resolveLiveTrackPauseMs(9_999_999)).toBe(MAX_LIVE_TRACK_PAUSE_MS);
		expect(resolveLiveTrackPauseMs(40)).toBe(MIN_LIVE_TRACK_PAUSE_MS);
		expect(resolveLiveTrackPauseMs("nonsense" as unknown as number)).toBe(LIVE_TRACK_POLICY.activePauseMs);
	});

	it("slows down to the idle pause while the robot stands still", () => {
		expect(getLiveTrackPauseMs({ configuredPause: 200, isActive: false, isLocal: true })).toBe(LIVE_TRACK_POLICY.idlePauseMs);
	});

	it("slows down to the cloud pause without a local link", () => {
		expect(getLiveTrackPauseMs({ configuredPause: 200, isActive: true, isLocal: false })).toBe(LIVE_TRACK_POLICY.cloudPauseMs);
	});

	it("never speeds a slow setting up in the name of slowing it down", () => {
		// Both rules are floors. A user who asked for 10 s keeps 10 s when the robot goes idle.
		expect(getLiveTrackPauseMs({ configuredPause: 10_000, isActive: false, isLocal: true })).toBe(10_000);
		expect(getLiveTrackPauseMs({ configuredPause: 10_000, isActive: true, isLocal: false })).toBe(10_000);
	});

	it("sends below normal priority, so nothing waits behind it", () => {
		// It used to go in at NORMAL, the same rank as a button the user pressed. p-queue schedules
		// the greatest priority first, so this has to be the smaller number.
		expect(LIVE_TRACK_REQUEST_PRIORITY).toBe(RequestPriority.LOW);
		expect(LIVE_TRACK_REQUEST_PRIORITY).toBeLessThan(RequestPriority.NORMAL);
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
		env.start();
		await env.settle();
		env.stop();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
		const [, written] = env.adapter.setStateChangedAsync.mock.calls[0];
		expect(JSON.parse(written.val).position).to.deep.equal({ x: 32587, y: 22591, angle: -137 });
		expect(env.adapter.setStateChangedAsync.mock.calls[0][0]).toBe(`Devices.${DUID}.${LIVE_TRACK_STATE}`);
	});

	it("fetches the position again even though nonce and length did not change", async () => {
		// The regression this change is really about. The channel gate compared nonce and max_len,
		// and max_len is the length of the driven path, which grows about once a second - so it was
		// a 1 Hz rate limit on a position that moves continuously.
		const env = createEnv({ liveTrackInterval: 200 });
		env.start();
		await env.settle();
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);

		env.movePosition(33000);
		await env.advance(200);
		env.stop();

		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(2);
		const written = env.adapter.setStateChangedAsync.mock.calls.map((call: any[]) => JSON.parse(call[1].val).position.x);
		expect(written).to.deep.equal([32587, 33000]);
	});

	it("asks again only after the pause, not before", async () => {
		const env = createEnv({ liveTrackInterval: 500 });
		env.start();
		await env.settle();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		await env.advance(499);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		await env.advance(1);
		env.stop();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("counts the pause from the answer, so a slow link slows the cycle instead of stacking it", async () => {
		// This is the difference to a fixed cadence: the round trip is never subtracted from the
		// pause, so two requests can never be in the air at once however slow the robot answers.
		const env = createEnv({ liveTrackInterval: 200, roundTripMs: 400 });
		env.start();
		await env.settle();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		await env.advance(199);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		await env.advance(1);
		env.stop();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("uses the idle pause while the robot stands still", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.setActive(false);
		env.start();
		await env.settle();

		await env.advance(LIVE_TRACK_POLICY.idlePauseMs - 1);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		await env.advance(1);
		env.stop();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("uses the cloud pause when the local socket is down", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.setLocal(false);
		env.start();
		await env.settle();

		await env.advance(LIVE_TRACK_POLICY.cloudPauseMs - 1);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);

		await env.advance(1);
		env.stop();
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("picks the pace up again when the robot starts working", async () => {
		// The context is read on every pass, not once at the start. A cycle started while the robot
		// was in its dock would otherwise stay at the idle pace for the whole cleaning run.
		const env = createEnv({ liveTrackInterval: 200 });
		env.setActive(false);
		env.start();
		await env.settle();
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);

		env.setActive(true);
		await env.advance(LIVE_TRACK_POLICY.idlePauseMs);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(2);

		// The next pass is now 200 ms away rather than 2000, which is the whole point.
		await env.advance(200);
		env.stop();
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(3);
	});

	it("reuses its own diff answer while it is still fresh, but never the position", async () => {
		// At a pause shorter than the sharing window the cycle meets its own previous diff. That is
		// deliberate and it halves the request count: what the diff carries is the channel nonce and
		// length, and a 200 ms old length is at most one path point short of the truth on a channel
		// that grows about once a second. The position is not in the diff at all - it comes from
		// get_dynamic_data, which every single pass issues.
		const env = createEnv({ liveTrackInterval: 200 });
		env.start();
		await env.settle();
		await env.advance(200);
		env.stop();

		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(2);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
	});

	it("does nothing at all while the robot is re-locating itself", async () => {
		const env = createEnv({ isLocating: 1 });
		env.start();
		await env.settle();
		env.stop();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(0);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(0);
	});

	it("does not start at all when the channel is switched off", async () => {
		const env = createEnv({ liveTrackInterval: 0 });
		env.start();
		await env.settle();

		expect(env.poller.isTrackEnabled()).toBe(false);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(0);
		expect(env.isLooping()).toBe(false);
	});

	it("starting twice does not run two loops", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.start();
		env.start();
		await env.settle();
		// One pass, not two: a second loop would have doubled every count from here on.
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);

		await env.advance(200);
		env.stop();
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(2);
	});

	it("stops for good when it is stopped", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.start();
		await env.settle();
		env.stop();

		await env.advance(5_000);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
		expect(env.isLooping()).toBe(false);
	});

	it("leaves no pending pause behind on dispose", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.start();
		await env.settle();
		expect(env.isLooping()).toBe(true);

		env.poller.dispose();
		expect(env.isLooping()).toBe(false);

		await env.advance(5_000);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
	});

	it("sends both requests below normal priority", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.start();
		await env.settle();
		env.stop();

		expect(env.priorityOf(MAP_DIFF_METHOD)).to.deep.equal([LIVE_TRACK_REQUEST_PRIORITY]);
		expect(env.priorityOf(DYNAMIC_DATA_METHOD)).to.deep.equal([LIVE_TRACK_REQUEST_PRIORITY]);
	});

	it("gives up after repeated diff failures and ends the loop", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.failDiffWith(new Error("unknown method"));

		env.start();
		await env.settle();
		await env.advance(200);
		await env.advance(200);

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(3);
		expect(env.state().trackDiffGaveUp).toBe(true);

		await env.advance(5_000);
		expect(env.countOf(MAP_DIFF_METHOD)).toBe(3);
		expect(env.isLooping()).toBe(false);
	});

	it("does not count a dead channel against the robot", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		const unavailable = Object.assign(new Error("channel down"), { code: "CHANNEL_UNAVAILABLE" });
		env.failDiffWith(unavailable);

		env.start();
		await env.settle();
		for (let round = 0; round < 3; round++) await env.advance(200);
		env.stop();

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
		// The regression this whole change began with: the map cycle held one shared in-flight flag,
		// so the position stood still for exactly as long as a map took to arrive - seconds, over
		// the cloud, precisely while the robot was moving.
		const env = createEnv({ liveTrackInterval: 200 });
		env.setDiffAnswer([{ result: 0, nonce: NONCE, diff: { "3": { max_len: 2, nonce: NONCE, count: 4 } } }]);
		env.updateMap.mockReturnValue(new Promise<void>(() => undefined));

		void env.map();
		await flushMicrotasks();
		expect(env.state().inFlight).toBe(true);

		env.start();
		await env.settle();
		env.stop();

		expect(env.state().dynamicInFlight).toBe(false);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("runs for a robot that has no incremental map at all", async () => {
		// Such a robot never reached `refreshDynamicTrack` before, because the only call site sat
		// inside the incremental branch it never takes.
		const env = createEnv({ liveTrackInterval: 200, featureStr: FEATURE_STR_WITHOUT_BIT });
		env.start();
		await env.settle();
		env.stop();

		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("runs while the live map refresh is switched off", async () => {
		const env = createEnv({ liveTrackInterval: 200, liveMapInterval: 0 });

		expect(env.poller.isEnabled()).toBe(false);
		env.start();
		await env.settle();
		env.stop();

		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("the map cycle no longer fetches the track", async () => {
		const env = createEnv();

		await env.map();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(0);
	});

	it("keeps polling the position when the map cycle gave up on the diff", async () => {
		const env = createEnv({ liveTrackInterval: 200 });
		env.state().diffGaveUp = true;

		env.start();
		await env.settle();
		env.stop();

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
		const env = createEnv({ liveTrackInterval: 200 });

		await env.map();
		env.start();
		await env.settle();
		env.stop();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});

	it("works in the other order as well", async () => {
		const env = createEnv({ liveTrackInterval: 200 });

		env.start();
		await env.settle();
		env.stop();
		await env.map();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(1);
	});

	it("asks again once the answer is no longer fresh", async () => {
		const env = createEnv({ liveTrackInterval: 200 });

		await env.map();
		await vi.advanceTimersByTimeAsync(400);
		env.start();
		await env.settle();
		env.stop();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
	});

	it("never reuses an answer that was asked with a different nonce", async () => {
		// What a diff reports depends on the nonce it was given, so an answer to another question
		// must not decide this one.
		const env = createEnv({ liveTrackInterval: 200 });

		await env.map();
		env.setMapNonce(NONCE + 1);
		env.start();
		await env.settle();
		env.stop();

		expect(env.countOf(MAP_DIFF_METHOD)).toBe(2);
		expect(env.paramsOf(MAP_DIFF_METHOD).map(params => params.nonce)).to.deep.equal([NONCE, NONCE + 1]);
	});

	it("falls back to nonce 1 while no map has been parsed yet", async () => {
		// Measured at the device: a made-up nonce still returns the valid per-channel nonces, which
		// is all this cycle needs.
		const env = createEnv({ liveTrackInterval: 200 });
		env.setMapNonce(null);

		env.start();
		await env.settle();
		env.stop();

		expect(env.paramsOf(MAP_DIFF_METHOD)[0].nonce).toBe(1);
		expect(env.countOf(DYNAMIC_DATA_METHOD)).toBe(1);
	});
});
