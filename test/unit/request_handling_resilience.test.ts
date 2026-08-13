import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoborockRequest, requestsHandler } from "../../src/lib/requestsHandler";
import { RETRY_POLICY, isChannelUnavailableError } from "../../src/lib/requestPolicy";

type RLogCall = {
	connection: string;
	duid: string | null | undefined;
	direction: string;
	message: string;
	level: string;
};

type TestAdapter = {
	adapter: any;
	rLogCalls: RLogCall[];
	setChannel: (options: { cloud?: boolean; local?: boolean }) => void;
};

function createTestAdapter(): TestAdapter {
	const rLogCalls: RLogCall[] = [];
	let cloudUp = true;
	let localUp = false;

	const adapter: any = {
		instance: 0,
		namespace: "roborock.0",
		config: { updateInterval: 60 },
		pendingRequests: new Map(),
		b01MapResponseQueue: new Map(),
		log: { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {}, silly: (): void => {} },
		catchError: vi.fn(),
		errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e)),
		errorStack: (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e)),
		rLog: (connection: string, duid: string | null | undefined, direction: string, _version: unknown, _protocol: unknown, message: string, level = "debug"): void => {
			rLogCalls.push({ connection, duid, direction, message, level });
		},
		getDeviceProtocolVersion: async (): Promise<string> => "1.0",
		getB01Variant: async (): Promise<null> => null,
		deviceManager: { deviceFeatureHandlers: new Map() },
		/** Every delay the handler ever schedules, so tests can assert on them directly. */
		scheduledDelays: [] as number[],
		// Route through the globals so vitest fake timers control them.
		setTimeout: (cb: (...a: any[]) => void, ms: number): any => {
			adapter.scheduledDelays.push(ms);
			return setTimeout(cb, ms);
		},
		clearTimeout: (t: any): void => clearTimeout(t),
		setInterval: (cb: (...a: any[]) => void, ms: number): any => setInterval(cb, ms),
		clearInterval: (t: any): void => clearInterval(t),
		mqtt_api: {
			isConnected: (): boolean => cloudUp,
			sendMessage: vi.fn(),
			clearIntervals: vi.fn()
		},
		local_api: {
			isConnected: (): boolean => localUp,
			sendMessage: (): boolean => true,
			clearLocalDevicedTimeout: vi.fn()
		}
	};

	return {
		adapter,
		rLogCalls,
		setChannel: ({ cloud, local }): void => {
			if (cloud !== undefined) cloudUp = cloud;
			if (local !== undefined) localUp = local;
		}
	};
}

function createHandler(): { handler: requestsHandler } & TestAdapter {
	const env = createTestAdapter();
	const handler = new requestsHandler(env.adapter as any);
	env.adapter.requestsHandler = handler;

	// Skip crypto: we only care about queueing/timeout/backoff behaviour here.
	handler.messageParser.buildPayload = async (): Promise<string> => "payload";
	handler.messageParser.buildRoborockMessage = async (): Promise<Buffer> => Buffer.from("msg");

	return { handler, ...env };
}

/** Lets all pending microtasks run without moving the fake clock. */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

describe("robust request handling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	describe("method dependent timeouts", () => {
		it("gives get_status a short timeout and a map request a long one", async () => {
			const { handler, adapter } = createHandler();

			const statusPromise = handler.sendRequest("duid-1", "get_status", []);
			await flush();
			const statusRequest = Array.from(adapter.pendingRequests.values())[0] as RoborockRequest;
			expect(statusRequest.timeout).toBe(5000);

			const mapPromise = handler.sendRequest("duid-1", "get_map_v1", []);
			await flush();
			const mapRequest = Array.from(adapter.pendingRequests.values()).find((r: any) => r.method === "get_map_v1") as RoborockRequest;
			expect(mapRequest.timeout).toBe(25000);

			statusPromise.catch(() => {});
			mapPromise.catch(() => {});
			handler.clearQueue(true);
			await flush();
		});

		it("passes an explicit override through instead of overwriting it for map methods", async () => {
			const { handler, adapter } = createHandler();

			const promise = handler.sendRequest("duid-1", "load_multi_map", [0], { timeout: 60000 });
			await flush();

			const request = Array.from(adapter.pendingRequests.values())[0] as RoborockRequest;
			expect(request.timeout).toBe(60000);

			promise.catch(() => {});
			handler.clearQueue(true);
			await flush();
		});

		it("rejects exactly at the method timeout, not at the old global 10s", async () => {
			const { handler, adapter } = createHandler();

			const promise = handler.sendRequest("duid-1", "get_status", []);
			promise.catch(() => {});
			await flush();

			await vi.advanceTimersByTimeAsync(4999);
			expect(adapter.pendingRequests.size).toBe(1);

			await vi.advanceTimersByTimeAsync(1);
			// Timer fired: the request is gone from the pending map (no leak, no second timer).
			expect(adapter.pendingRequests.size).toBe(0);

			handler.clearQueue(true);
			await flush();
		});
	});

	describe("exponential backoff between retries", () => {
		it("waits longer before every further retry instead of a flat second", async () => {
			const { handler, adapter } = createHandler();
			const sendMessage = adapter.mqtt_api.sendMessage;

			const promise = handler.sendRequest("duid-1", "get_status", []);
			promise.catch(() => {});
			await flush();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Run the whole retry chain: 3 attempts a 5s timeout plus the two backoffs.
			await vi.advanceTimersByTimeAsync(60000);
			await expect(promise).rejects.toThrow(/timed out/);

			// maxRetries = 2 -> three attempts in total.
			expect(sendMessage).toHaveBeenCalledTimes(1 + RETRY_POLICY.maxRetries);

			// Everything that is not a request timeout (5000) or a finished-request expiry
			// (60000) is a retry backoff.
			const backoffs = (adapter.scheduledDelays as number[]).filter((ms) => ms !== 5000 && ms !== 60000);
			expect(backoffs).toHaveLength(RETRY_POLICY.maxRetries);

			const firstMin = RETRY_POLICY.baseDelayMs * (1 - RETRY_POLICY.jitterRatio);
			const firstMax = RETRY_POLICY.baseDelayMs * (1 + RETRY_POLICY.jitterRatio);
			const secondMin = RETRY_POLICY.baseDelayMs * RETRY_POLICY.factor * (1 - RETRY_POLICY.jitterRatio);
			const secondMax = RETRY_POLICY.baseDelayMs * RETRY_POLICY.factor * (1 + RETRY_POLICY.jitterRatio);

			expect(backoffs[0]).toBeGreaterThanOrEqual(firstMin);
			expect(backoffs[0]).toBeLessThanOrEqual(firstMax);
			expect(backoffs[1]).toBeGreaterThanOrEqual(secondMin);
			expect(backoffs[1]).toBeLessThanOrEqual(secondMax);
			// The whole point: the second wait is strictly longer than the first, and neither
			// is the old flat 1000ms retry.
			expect(backoffs[1]).toBeGreaterThan(backoffs[0]);

			handler.clearQueue(true);
			await flush();
		});
	});

	describe("no timeout cascade when the connection is lost", () => {
		it("fails new requests immediately while both channels are down", async () => {
			const { handler, adapter, setChannel } = createHandler();
			setChannel({ cloud: false, local: false });

			const before = Date.now();
			await expect(handler.sendRequest("duid-1", "get_status", [])).rejects.toSatisfy(isChannelUnavailableError);

			// No clock movement at all: the caller did not wait for any timeout.
			expect(Date.now()).toBe(before);
			expect(adapter.mqtt_api.sendMessage).not.toHaveBeenCalled();
			expect(adapter.pendingRequests.size).toBe(0);
			expect(vi.getTimerCount()).toBe(1); // only the 24h request-ID reset interval

			handler.clearQueue(true);
		});

		it("does not retry a request that never reached the wire", async () => {
			const { handler, setChannel } = createHandler();
			setChannel({ cloud: false, local: false });

			let attempts = 0;
			const original = handler.messageParser.buildPayload;
			handler.messageParser.buildPayload = async (...args: any[]): Promise<any> => {
				attempts += 1;
				return (original as any)(...args);
			};

			await expect(handler.sendRequest("duid-1", "get_prop", ["get_status"])).rejects.toSatisfy(isChannelUnavailableError);
			await vi.advanceTimersByTimeAsync(60000);
			expect(attempts).toBe(0);

			handler.clearQueue(true);
		});

		it("fails all in-flight requests at once instead of one timeout after the other", async () => {
			const { handler, adapter, setChannel } = createHandler();

			const promises = [
				handler.sendRequest("duid-1", "get_status", []),
				handler.sendRequest("duid-1", "get_consumable", []),
				handler.sendRequest("duid-1", "get_map_v1", []),
				handler.sendRequest("duid-2", "get_status", [])
			];
			promises.forEach((p) => p.catch(() => {}));
			await flush();
			expect(adapter.pendingRequests.size).toBe(4);

			// The broker drops the connection.
			setChannel({ cloud: false });
			handler.onChannelDown("MQTT", "connection closed");
			await flush();

			// Everything is resolved right away, no waiting for 5s/8s/25s timers.
			expect(adapter.pendingRequests.size).toBe(0);
			for (const promise of promises) {
				await expect(promise).rejects.toSatisfy(isChannelUnavailableError);
			}
			expect(adapter.mqtt_api.sendMessage).toHaveBeenCalledTimes(4); // no retry storm

			handler.clearQueue(true);
			await flush();
		});

		it("scopes a TCP session reset to that device", async () => {
			const { handler, adapter, setChannel } = createHandler();
			setChannel({ cloud: false, local: true });

			const localPromise = handler.sendRequest("duid-1", "get_status", []);
			const otherPromise = handler.sendRequest("duid-2", "get_status", []);
			localPromise.catch(() => {});
			otherPromise.catch(() => {});
			await flush();
			expect(adapter.pendingRequests.size).toBe(2);

			const rejected = handler.rejectPendingTcpRequests("duid-1", "keepalive timeout");
			await flush();

			expect(rejected).toBe(1);
			expect(adapter.pendingRequests.size).toBe(1);
			await expect(localPromise).rejects.toThrow(/duid-1/);

			handler.clearQueue(true);
			await flush();
		});

		it("reports the outage once per device instead of once per request", async () => {
			const { handler, rLogCalls, setChannel } = createHandler();
			setChannel({ cloud: false, local: false });

			for (let i = 0; i < 12; i++) {
				await expect(handler.sendRequest("duid-1", "get_status", [])).rejects.toSatisfy(isChannelUnavailableError);
			}

			const warnings = rLogCalls.filter((c) => c.level === "warn" && c.message.includes("rejected immediately"));
			expect(warnings).toHaveLength(1);
			expect(warnings[0].message).toMatch(/cloud \(MQTT\) and local \(TCP\) channel are both down/);

			// Once the channel is back, the suppressed count is reported and the state resets.
			setChannel({ cloud: true });
			const recovered = handler.sendRequest("duid-1", "get_status", []);
			recovered.catch(() => {});
			await flush();

			const recoveryLine = rLogCalls.find((c) => c.message.includes("is available again"));
			expect(recoveryLine).toBeDefined();
			expect(recoveryLine!.message).toContain("11 request(s) were rejected");

			handler.clearQueue(true);
			await flush();
		});

		it("gives the user a message that names the robot and the method", async () => {
			const { handler, setChannel } = createHandler();
			setChannel({ cloud: false, local: false });

			await expect(handler.sendRequest("duid-1", "app_start", [])).rejects.toThrow(
				/No connection to robot duid-1.*app_start/
			);

			handler.clearQueue(true);
		});

		it("still allows the network-info requests used to recover the local endpoint", async () => {
			const { handler, setChannel } = createHandler();
			setChannel({ cloud: false, local: false });

			// Guard exemption: these are how the adapter finds its way back to the robot.
			expect(handler.getChannelUnavailableReason("duid-1", "get_network_info")).toBeUndefined();
			expect(handler.getChannelUnavailableReason("duid-1", "service.get_net_info")).toBeUndefined();
			expect(handler.getChannelUnavailableReason("duid-1", "get_status")).toMatch(/both down/);

			let reachedSendPath = false;
			handler.messageParser.buildPayload = async (): Promise<string> => {
				reachedSendPath = true;
				return "payload";
			};

			const promise = handler.sendRequest("duid-1", "get_network_info", []);
			promise.catch(() => {});
			await flush();
			expect(reachedSendPath).toBe(true);

			handler.clearQueue(true);
			await flush();
		});
	});

	describe("timer cleanup on unload", () => {
		it("leaves no timer behind, including the 24h request-ID reset interval", async () => {
			const { handler, adapter } = createHandler();

			// One request in flight (timeout timer) ...
			const inflight = handler.sendRequest("duid-1", "get_status", []);
			inflight.catch(() => {});
			await flush();

			// ... one finished request (60s expiry timer of the "recently finished" guard) ...
			const finishedId = handler.nextMessageId();
			handler.resolvePendingRequest(finishedId, ["ok"], 101, "duid-1", "MQTT");
			expect(vi.getTimerCount()).toBeGreaterThan(1);

			handler.clearQueue(true);
			await flush();

			expect(vi.getTimerCount()).toBe(0);
			expect(handler.mqttResetInterval).toBeUndefined();
			expect(adapter.pendingRequests.size).toBe(0);
			await expect(inflight).rejects.toThrow();
		});

		it("releases a waiting retry backoff instead of hanging forever", async () => {
			const { handler } = createHandler();

			const promise = handler.sendRequest("duid-1", "get_status", []);
			promise.catch(() => {});
			await flush();

			// Drive the first attempt into its timeout so a backoff timer is armed.
			await vi.advanceTimersByTimeAsync(5000);
			expect(vi.getTimerCount()).toBeGreaterThan(1);

			handler.clearQueue(true);
			await flush();

			await expect(promise).rejects.toThrow(/ADAPTER_STOPPED/);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("keeps working after a non-permanent clear (MQTT reset)", async () => {
			const { handler, adapter } = createHandler();

			handler.clearQueue();
			expect(handler.mqttResetInterval).toBeDefined();

			const promise = handler.sendRequest("duid-1", "get_status", []);
			promise.catch(() => {});
			await flush();
			expect(adapter.pendingRequests.size).toBe(1);

			handler.clearQueue(true);
			await flush();
		});
	});
});
