import { afterEach, describe, expect, it, vi } from "vitest";

import { requestsHandler } from "../../src/lib/requestsHandler";
import { ChannelUnavailableError } from "../../src/lib/requestPolicy";
import type { CommandOutcomeReport } from "../../src/lib/commandFeedback";

/**
 * The funnel: every command that leaves through `requestsHandler.command` says what became of it.
 *
 * This is the part that makes the channel general. `socketHandler` only reaches the admin tab, but
 * this path is shared by the tab, a script, vis, the object view and the adapter's own scene queue -
 * so the outcome is marked here or it is marked for one writer out of five.
 *
 * Two of the tests below are about a defect that this reporting itself introduced and that was
 * caught by the existing suite: a failure inside the reporting replaced the real error with itself,
 * so the user was told about the messenger instead of about the command.
 */

interface Marked {
	duid: string;
	report: CommandOutcomeReport;
}

function createHandler(options: { variant?: string | null; markerThrows?: boolean } = {}) {
	const marked: Marked[] = [];

	const adapter: any = {
		instance: 0,
		namespace: "roborock.0",
		config: {},
		pendingRequests: new Map(),
		b01MapResponseQueue: new Map(),
		log: { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {}, silly: (): void => {} },
		rLog: vi.fn(),
		catchError: vi.fn(),
		errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e)),
		errorStack: (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e)),
		getDeviceProtocolVersion: async (): Promise<string> => "1.0",
		getB01Variant: async (): Promise<string | null> => options.variant ?? null,
		setTimeout: (cb: (...a: any[]) => void, ms: number): any => setTimeout(cb, ms),
		clearTimeout: (t: any): void => clearTimeout(t),
		setInterval: (cb: (...a: any[]) => void, ms: number): any => setInterval(cb, ms),
		clearInterval: (t: any): void => clearInterval(t),
		mqtt_api: { isConnected: (): boolean => true, sendMessage: vi.fn(), clearIntervals: vi.fn() },
		local_api: { isConnected: (): boolean => false, sendMessage: (): boolean => true, clearLocalDevicedTimeout: vi.fn() },
		markCommandOutcome: vi.fn(async (duid: string, report: CommandOutcomeReport) => {
			if (options.markerThrows) throw new Error("the messenger fell over");
			marked.push({ duid, report });
		})
	};

	const handler = new requestsHandler(adapter);
	return { adapter, handler, marked };
}

/** A feature handler that passes its parameters through, like most of them do. */
function passthroughFeatures(overrides: Record<string, unknown> = {}): any {
	return {
		getCommandParams: vi.fn(async (_method: string, params: unknown) => params),
		onCommandResult: vi.fn(async () => undefined),
		...overrides
	};
}

/** Lets the fire-and-forget result handling run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

const handlers: requestsHandler[] = [];

function track(handler: requestsHandler): requestsHandler {
	handlers.push(handler);
	return handler;
}

afterEach(() => {
	// Stops the 24 h request-id reset interval the constructor starts.
	for (const handler of handlers.splice(0)) handler.clearQueue(true);
	vi.clearAllMocks();
});

describe("every command says what became of it", () => {
	it("reports a robot that accepted", async () => {
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockResolvedValue(["ok"] as any);

		await handler.command(passthroughFeatures(), "duid1", "set_custom_mode", 102, undefined, {
			stateId: "roborock.0.Devices.duid1.commands.set_custom_mode",
			folder: "commands"
		});
		await settle();

		expect(marked).toHaveLength(1);
		expect(marked[0]).toMatchObject({
			duid: "duid1",
			report: { command: "set_custom_mode", outcome: "accepted", stateId: "roborock.0.Devices.duid1.commands.set_custom_mode", folder: "commands" }
		});
	});

	it("reports a robot that answered something else", async () => {
		// The silent case: the robot replies, but not with ["ok"]. Until now only the log said so.
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockResolvedValue(["unknown_method"] as any);

		await handler.command(passthroughFeatures(), "duid1", "set_custom_mode", 102);
		await settle();

		expect(marked[0].report.outcome).toBe("rejected");
		expect(marked[0].report.detail).toContain("unknown_method");
	});

	it("does not judge a command that has no defined answer", async () => {
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockResolvedValue(["anything"] as any);

		await handler.command(passthroughFeatures(), "duid1", "app_start");
		await settle();

		expect(marked[0].report.outcome).toBe("accepted");
	});

	it("says 'unreachable' when nothing was sent", async () => {
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockRejectedValue(new ChannelUnavailableError("cloud and local are down"));

		await handler.command(passthroughFeatures(), "duid1", "set_custom_mode", 102);
		await settle();

		expect(marked[0].report.outcome).toBe("unreachable");
	});

	it("says 'no_answer' - not 'failed' - on a timeout", async () => {
		// The robot may have carried the command out and lost the answer on the way back.
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockRejectedValue(new Error("Request command-set_custom_mode timed out after 15000ms"));

		await handler.command(passthroughFeatures(), "duid1", "set_custom_mode", 102);
		await settle();

		expect(marked[0].report.outcome).toBe("no_answer");
	});

	it("keeps any other failure as an open question, with the reason", async () => {
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockRejectedValue(new Error("Failed to build B01 DP message"));

		await handler.command(passthroughFeatures(), "duid1", "set_custom_mode", 102);
		await settle();

		expect(marked[0].report.outcome).toBe("error");
		expect(marked[0].report.detail).toContain("Failed to build B01 DP message");
	});

	it("says nothing while the adapter is shutting down", async () => {
		// A request cancelled by the tear-down says nothing about the robot, and the states are
		// being removed anyway.
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockRejectedValue(new Error("Task req_1_2 was cancelled: ADAPTER_STOPPED"));

		await handler.command(passthroughFeatures(), "duid1", "set_custom_mode", 102);
		await settle();

		expect(marked).toHaveLength(0);
	});

	it("marks a command that came without an origin, because a script is a writer too", async () => {
		// No state id and no folder: the adapter looks the command object up by name.
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockResolvedValue(["ok"] as any);

		await handler.command(passthroughFeatures(), "duid1", "set_custom_mode", 102);
		await settle();

		expect(marked[0].report).toMatchObject({ stateId: null, folder: null, outcome: "accepted" });
	});

	it("names the command the user pressed, not the method that went on the wire", async () => {
		// The state that carries the outcome is the one the user wrote to, so the name has to be the
		// one they know. `set_zone` would name a method that has no state at all.
		const { handler, marked } = createHandler();
		track(handler);
		vi.spyOn(handler, "sendRequest").mockResolvedValue(["ok"] as any);
		const features = passthroughFeatures({
			getCommandParams: vi.fn(async () => ({ method: "set_zone", params: [[1, 2, 3, 4]] }))
		});

		await handler.command(features, "duid1", "clean_zone");
		await settle();

		expect(marked[0].report.command).toBe("clean_zone");
	});
});

describe("a request that never left", () => {
	it("is reported as 'not_sent' when the handler refused to build it", async () => {
		const { handler, marked } = createHandler();
		track(handler);
		const sendRequest = vi.spyOn(handler, "sendRequest");
		const features = passthroughFeatures({
			getCommandParams: vi.fn(async () => { throw new Error("The wall at index 3 is at 1,2 but the request expected 5,6"); })
		});

		await expect(handler.command(features, "duid1", "set_zone", [])).rejects.toThrow(/index 3/);
		expect(sendRequest).not.toHaveBeenCalled();
		expect(marked[0].report).toMatchObject({ outcome: "not_sent" });
		expect(marked[0].report.detail).toContain("index 3");
	});

	it("still throws the original error, unchanged", async () => {
		// The direct socket routes turn this throw into the answer to the tab's message. A reporting
		// error that replaced it would tell the user about the messenger instead.
		const { handler } = createHandler({ markerThrows: true });
		track(handler);
		const features = passthroughFeatures({
			getCommandParams: vi.fn(async () => { throw new Error("Unknown map flag 7"); })
		});

		await expect(handler.command(features, "duid1", "load_multi_map", 7)).rejects.toThrow("Unknown map flag 7");
	});

	it("does not let a broken reporter break a working command", async () => {
		const { handler } = createHandler({ markerThrows: true });
		track(handler);
		vi.spyOn(handler, "sendRequest").mockResolvedValue(["ok"] as any);
		const features = passthroughFeatures();

		await expect(handler.command(features, "duid1", "set_custom_mode", 102)).resolves.toBeUndefined();
		await settle();

		expect(features.onCommandResult).toHaveBeenCalled();
	});
});

describe("a device that never answers", () => {
	it("is reported as 'sent', not as accepted", async () => {
		// The Q10 control path publishes data points and gets no answer at all. Calling that
		// "accepted" would claim a confirmation this device never gives.
		const { handler, marked } = createHandler({ variant: "Q10" });
		track(handler);
		(handler as any).q10CommandHandler = { handleCommand: vi.fn(async () => undefined) };

		await handler.command(passthroughFeatures(), "duid1", "app_start", undefined, undefined, { folder: "commands" });

		expect(marked).toHaveLength(1);
		expect(marked[0].report).toMatchObject({ command: "app_start", outcome: "sent", folder: "commands" });
	});

	it("is reported as 'not_sent' when the publish failed, with the error kept", async () => {
		const { handler, marked } = createHandler({ variant: "Q10" });
		track(handler);
		(handler as any).q10CommandHandler = {
			handleCommand: vi.fn(async () => { throw new Error("Unsupported Q10 command 'find_me'"); })
		};

		await expect(handler.command(passthroughFeatures(), "duid1", "find_me")).rejects.toThrow("Unsupported Q10 command 'find_me'");
		expect(marked[0].report).toMatchObject({ outcome: "not_sent" });
	});
});
