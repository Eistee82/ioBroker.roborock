import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceManager } from "../../src/lib/deviceManager";
import { ChannelUnavailableError, POLL_POLICY } from "../../src/lib/requestPolicy";

const CLEANING_STATE = 5;
const IDLE_STATE = 3;

type PollEnv = {
	manager: DeviceManager;
	adapter: any;
	handler: any;
	/** Runs `seconds` one-second ticks of the main poll loop. */
	tick: (seconds: number) => Promise<void>;
	setDeviceState: (state: number) => void;
};

function createPollEnv(options: { updateInterval?: number; activePollInterval?: number; pollBackoffMaxInterval?: number; liveTrackInterval?: number } = {}): PollEnv {
	let deviceState = IDLE_STATE;
	let tickFn: (() => Promise<void>) | undefined;

	const handler = {
		protocolVersion: "1.0",
		updateStatus: vi.fn().mockResolvedValue(undefined),
		updateMap: vi.fn().mockResolvedValue(undefined),
		updateCleanSummary: vi.fn().mockResolvedValue(undefined),
		getCommonConsumable: vi.fn(() => ({ type: "number" })),
		getCommonDeviceStates: vi.fn(() => ({ type: "number" }))
	};

	const devices = [{ duid: "duid-1", online: true, deviceStatus: {} }];

	const adapter: any = {
		config: {
			updateInterval: options.updateInterval ?? 60,
			activePollInterval: options.activePollInterval,
			pollBackoffMaxInterval: options.pollBackoffMaxInterval,
			liveTrackInterval: options.liveTrackInterval
		},
		rLog: vi.fn(),
		catchError: vi.fn(),
		errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e)),
		http_api: {
			updateHomeData: vi.fn().mockResolvedValue(undefined),
			getDevices: (): typeof devices => devices,
			// Diese Tests decken das Polling im Cloud-Betrieb ab; im Nur-Lokal-Modus
			// überspringt der DeviceManager den HomeData-Poll ganz.
			hasCloudSession: (): boolean => true
		},
		local_api: { refreshStaleLocalEndpoints: undefined, isConnected: (): boolean => true },
		requestsHandler: { startupFinished: true },
		updateDeviceInfo: vi.fn().mockResolvedValue(undefined),
		getDeviceProtocolVersion: vi.fn().mockResolvedValue("1.0"),
		ensureState: vi.fn().mockResolvedValue(undefined),
		setStateChanged: vi.fn().mockResolvedValue(undefined),
		getStateAsync: vi.fn(async (id: string) => (id.endsWith(".state") ? { val: deviceState } : null)),
		// One ticker only. The live position used to have a second one; it is a free-running cycle
		// now and pauses on timers of its own instead.
		setInterval: vi.fn((callback: () => any) => {
			tickFn = callback as () => Promise<void>;
			return "main-handle" as any;
		}),
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => undefined),
		clearTimeout: vi.fn()
	};

	const manager = new DeviceManager(adapter as any);
	manager.deviceFeatureHandlers.set("duid-1", handler as any);
	manager.startPolling();

	return {
		manager,
		adapter,
		handler,
		setDeviceState: (state: number): void => {
			deviceState = state;
		},
		tick: async (seconds: number): Promise<void> => {
			for (let i = 0; i < seconds; i++) {
				vi.setSystemTime(Date.now() + 1000);
				await tickFn!();
			}
		}
	};
}

describe("adaptive polling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls a cleaning robot far more often than an idle one", async () => {
		const idleEnv = createPollEnv({ updateInterval: 60 });
		// First tick is the slow tick, everything after that is governed by the interval.
		await idleEnv.tick(50);
		const idlePolls = idleEnv.handler.updateStatus.mock.calls.length;

		const activeEnv = createPollEnv({ updateInterval: 60 });
		activeEnv.setDeviceState(CLEANING_STATE);
		await activeEnv.tick(50);
		const activePolls = activeEnv.handler.updateStatus.mock.calls.length;

		// Idle: only the initial slow tick within the first 50s of a 60s interval.
		expect(idlePolls).toBe(1);
		// Active: roughly one poll per activeIntervalSeconds.
		expect(activePolls).toBeGreaterThanOrEqual(Math.floor(50 / POLL_POLICY.activeIntervalSeconds) - 1);
		expect(activePolls).toBeGreaterThan(idlePolls * 5);
	});

	it("stays slow while the adapter is still starting up, even during cleaning", async () => {
		const env = createPollEnv({ updateInterval: 60 });
		env.adapter.requestsHandler.startupFinished = false;
		env.setDeviceState(CLEANING_STATE);

		await env.tick(25);

		// Startup floor is 30s, so only the very first (slow) tick polled.
		expect(env.handler.updateStatus).toHaveBeenCalledTimes(1);
	});

	it("backs off exponentially after failures and recovers afterwards", async () => {
		const env = createPollEnv({ updateInterval: 5 });
		env.setDeviceState(CLEANING_STATE);
		env.handler.updateStatus.mockRejectedValue(new Error("boom"));

		await env.tick(1); // first (slow) tick -> attempt 1 fails
		expect(env.handler.updateStatus).toHaveBeenCalledTimes(1);

		// errorBaseSeconds = 30 -> nothing for the next 25s, despite the 5s base interval.
		await env.tick(25);
		expect(env.handler.updateStatus).toHaveBeenCalledTimes(1);

		await env.tick(6); // 30s backoff elapsed -> attempt 2 fails
		expect(env.handler.updateStatus).toHaveBeenCalledTimes(2);

		// Second failure doubles the backoff to 60s.
		await env.tick(50);
		expect(env.handler.updateStatus).toHaveBeenCalledTimes(2);
		await env.tick(15);
		expect(env.handler.updateStatus).toHaveBeenCalledTimes(3);

		// Once the device answers again the backoff is dropped immediately.
		env.handler.updateStatus.mockResolvedValue(undefined);
		await env.tick(125); // clear the 120s backoff of the third failure
		const afterRecovery = env.handler.updateStatus.mock.calls.length;
		await env.tick(20);
		expect(env.handler.updateStatus.mock.calls.length - afterRecovery).toBeGreaterThan(2);
	});

	it("does not spam catchError with stack traces while the connection is down", async () => {
		const env = createPollEnv({ updateInterval: 5 });
		env.handler.updateStatus.mockRejectedValue(new ChannelUnavailableError("cloud and local down"));

		await env.tick(1);
		await env.tick(400);

		expect(env.adapter.catchError).not.toHaveBeenCalled();
		// Backoff caps at errorMaxSeconds, so a 400s outage costs a handful of attempts, not 400.
		expect(env.handler.updateStatus.mock.calls.length).toBeLessThan(8);
	});

	it("keeps cloud housekeeping running on the slow tick while a device is backed off", async () => {
		const env = createPollEnv({ updateInterval: 5 });
		env.handler.updateStatus.mockRejectedValue(new Error("boom"));

		await env.tick(1);
		const infoCallsAfterFirst = env.adapter.updateDeviceInfo.mock.calls.length;

		await env.tick(20); // four more slow ticks (5s interval), device itself stays backed off
		expect(env.adapter.updateDeviceInfo.mock.calls.length).toBeGreaterThan(infoCallsAfterFirst);
		expect(env.handler.updateStatus).toHaveBeenCalledTimes(1);
	});

	it("honours the configured active cadence from the admin settings", async () => {
		const slow = createPollEnv({ updateInterval: 60, activePollInterval: 20 });
		slow.setDeviceState(CLEANING_STATE);
		await slow.tick(60);

		const fast = createPollEnv({ updateInterval: 60, activePollInterval: 2 });
		fast.setDeviceState(CLEANING_STATE);
		await fast.tick(60);

		// 60s at 20s cadence -> a handful of polls; at 2s -> roughly ten times as many.
		expect(slow.handler.updateStatus.mock.calls.length).toBeLessThanOrEqual(5);
		expect(fast.handler.updateStatus.mock.calls.length).toBeGreaterThan(20);
	});

	it("honours the configured backoff cap after repeated failures", async () => {
		const env = createPollEnv({ updateInterval: 60, pollBackoffMaxInterval: 900 });
		env.handler.updateStatus.mockRejectedValue(new ChannelUnavailableError("down"));

		await env.tick(1);
		await env.tick(1000);
		const withHighCap = env.handler.updateStatus.mock.calls.length;

		const lowCap = createPollEnv({ updateInterval: 60, pollBackoffMaxInterval: 60 });
		lowCap.handler.updateStatus.mockRejectedValue(new ChannelUnavailableError("down"));
		await lowCap.tick(1);
		await lowCap.tick(1000);

		// A 60s cap retries far more often over the same outage than a 900s cap.
		expect(lowCap.handler.updateStatus.mock.calls.length).toBeGreaterThan(withHighCap * 2);
	});

	it("drops all adaptive state when polling stops", async () => {
		const env = createPollEnv({ updateInterval: 5 });
		env.handler.updateStatus.mockRejectedValue(new Error("boom"));
		await env.tick(1);

		env.manager.stopPolling();

		expect(env.adapter.clearInterval).toHaveBeenCalled();
		expect((env.manager as any).nextPollDueAt.size).toBe(0);
		expect((env.manager as any).pollErrorCount.size).toBe(0);
		expect((env.manager as any).pollingDevices.size).toBe(0);
	});
});

describe("live position ticker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("needs no ticker of its own any more", () => {
		// It used to have a second interval, finer than the main loop, because a cadence checked by
		// a ticker of the same period degrades to twice that period. A free-running cycle has no
		// cadence to check, so the second ticker is gone and the main loop is the only one left.
		const env = createPollEnv();

		const periods = env.adapter.setInterval.mock.calls.map((call: any[]) => call[1]);
		expect(periods).to.deep.equal([1000]);
	});

	it("starts a free-running cycle for an online device", async () => {
		const env = createPollEnv();
		const start = vi.spyOn((env.manager as any).liveMapPoller, "startDynamicCycle").mockReturnValue(undefined);

		await env.tick(1);

		expect(start).toHaveBeenCalled();
		expect(start.mock.calls[0][0]).toBe("duid-1");
	});

	it("hands over both answers as functions, read fresh on every pass", async () => {
		// A cycle outlives the moment it was started. Passing booleans would pin a robot that was
		// idle at start-up to the idle pace for the whole cleaning run that follows.
		const env = createPollEnv({ updateInterval: 60 });
		const start = vi.spyOn((env.manager as any).liveMapPoller, "startDynamicCycle").mockReturnValue(undefined);

		await env.tick(1);
		const context = start.mock.calls[0][1] as { isActive(): boolean; isLocal(): boolean };
		expect(context.isActive()).toBe(false);
		expect(context.isLocal()).toBe(true);

		env.setDeviceState(CLEANING_STATE);
		// Far enough for the next status poll to fall due, which is what refreshes the state code
		// the context reads.
		await env.tick(61);
		expect(context.isActive()).toBe(true);
	});

	it("reports a cloud-only device as not local, so the pace can be held back", async () => {
		const env = createPollEnv();
		env.adapter.local_api.isConnected = (): boolean => false;
		const start = vi.spyOn((env.manager as any).liveMapPoller, "startDynamicCycle").mockReturnValue(undefined);

		await env.tick(1);
		const context = start.mock.calls[0][1] as { isLocal(): boolean };
		expect(context.isLocal()).toBe(false);
	});

	it("leaves an offline device alone", async () => {
		const env = createPollEnv();
		const start = vi.spyOn((env.manager as any).liveMapPoller, "startDynamicCycle").mockReturnValue(undefined);
		env.adapter.http_api.getDevices()[0].online = false;

		await env.tick(3);

		expect(start).not.toHaveBeenCalled();
	});

	it("is stopped when polling stops, so nothing survives an unload", () => {
		const env = createPollEnv();
		const dispose = vi.spyOn((env.manager as any).liveMapPoller, "dispose");

		env.manager.stopPolling();

		// The poller owns the cycles and their pending pauses now, so disposing it is what clears
		// them; the manager has no live-track handle of its own left to forget.
		expect(dispose).toHaveBeenCalled();
		expect(env.adapter.clearInterval).toHaveBeenCalledWith("main-handle");
	});
});
