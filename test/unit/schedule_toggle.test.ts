import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * Regression guard for the schedule switch.
 *
 * Two defects, two rounds, one test file.
 *
 * Round 1: `schedules.<timerId>.enabled` was created as a writable switch, but nothing was
 * subscribed to it and `handleCommand` had no matching command folder, so every click was silently
 * dropped. The counterpart of the `get_timer` read is `upd_timer [timerId, "on"|"off"]`.
 *
 * Round 2, and that is what most of this file is about: the robot's `["ok"]` was taken as the
 * confirmation and written back with `ack: true`. `["ok"]` says the robot took the command, not that
 * the schedule moved - so the switch is now acknowledged from the robot's own list, and every way
 * the command can fail leaves a quality and a reason on the state instead of a log line nobody sees.
 *
 * The order of the two writes is pinned deliberately: `markCommandOutcome` keeps `val` and `ack` as
 * it finds them, and a value written afterwards would clear the quality again. Swap the two and the
 * "reports the value the robot really has" tests fail.
 */
const TIMER_ID = "1749184337669";
const OTHER_ID = "1498595904821";
const STATE_ID = `roborock.0.Devices.duid1.schedules.${TIMER_ID}.enabled`;

/** One row as `get_timer` reports it. */
function row(id: string, state: string): unknown[] {
	return [id, state, ["0 14 * * 5", ["start_clean", {}], 1749184337]];
}

interface Written {
	id: string;
	state: Record<string, unknown>;
}

/** Throws what the scenario put in the answer list, or hands it back. */
function answer(value: unknown): unknown {
	if (value instanceof Error) throw value;
	return value;
}

/** Reads the translation key out of the comment `markCommandOutcome` wrote. */
function commentKey(state: Record<string, unknown> | undefined): string {
	return JSON.parse(String(state?.c ?? "{}")).k ?? "";
}

async function createAdapter(options: {
	/** What `upd_timer` answers, or an `Error` it throws. */
	updTimer?: unknown;
	/** What each successive `get_timer` answers; the last entry repeats. */
	timers?: unknown[];
	/** The state as it stands before the click. */
	current?: Record<string, unknown>;
} = {}) {
	const { Roborock } = await import("../../src/main");

	const timers = options.timers ?? [[row(TIMER_ID, "on")]];
	/** Every write and re-read in the order they happened; `q` marks an outcome write. */
	const order: string[] = [];
	const written: Written[] = [];
	const states = new Map<string, Record<string, unknown>>([[STATE_ID, options.current ?? { val: true, ack: false, q: 0, c: "" }]]);
	let reads = 0;

	const updateTimers = vi.fn(async () => {
		order.push("refresh");
	});
	const handler = { protocolVersion: "1.0", updateTimers };

	const sendRequest = vi.fn(async (_duid: string, method: string) => {
		if (method === "upd_timer") return answer(options.updTimer ?? ["ok"]);
		if (method === "get_timer") {
			const value = timers[Math.min(reads, timers.length - 1)];
			reads++;
			order.push("read");
			return answer(value);
		}
		throw new Error(`unexpected method ${method}`);
	});

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		deviceFeatureHandlers: new Map([["duid1", handler]]),
		requestsHandler: { sendRequest, command: vi.fn() },
		rLog: vi.fn(),
		catchError: vi.fn(),
		delay: vi.fn(async () => {
			order.push("wait");
		}),
		getStateAsync: vi.fn(async (id: string) => states.get(id) ?? null),
		setState: vi.fn(async (id: string, state: Record<string, unknown>) => {
			written.push({ id, state });
			order.push("q" in state ? "mark" : "value");
			// A write that does not name a quality resets it, as the states database does
			// (`statesInRedisClient.js:513-517`). That is what makes a swapped order visible here.
			states.set(id, { q: 0, c: "", ...state });
		})
	});

	return { adapter, handler, sendRequest, updateTimers, written, order, states };
}

describe("schedule switch writes reach the robot", () => {
	it("enables a timer with upd_timer", async () => {
		const { adapter, sendRequest } = await createAdapter();

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(sendRequest).toHaveBeenCalledWith("duid1", "upd_timer", [TIMER_ID, "on"]);
	});

	it("disables a timer with the off mode", async () => {
		const { adapter, sendRequest } = await createAdapter({ timers: [[row(TIMER_ID, "off")]] });

		await adapter.onStateChange(STATE_ID, { val: false, ack: false });

		expect(sendRequest).toHaveBeenCalledWith("duid1", "upd_timer", [TIMER_ID, "off"]);
	});

	it("does not answer its own acknowledged updates", async () => {
		const { adapter, sendRequest } = await createAdapter();

		await adapter.onStateChange(STATE_ID, { val: true, ack: true });

		expect(sendRequest).not.toHaveBeenCalled();
	});

	it("leaves the read-only cron state alone", async () => {
		const { adapter, sendRequest } = await createAdapter();

		await adapter.onStateChange(`roborock.0.Devices.duid1.schedules.${TIMER_ID}.cron`, { val: "0 14 * * 5", ack: false });

		expect(sendRequest).not.toHaveBeenCalled();
	});

	it("ignores schedules of a device without a feature handler", async () => {
		const { adapter, sendRequest } = await createAdapter();

		await adapter.onStateChange("roborock.0.Devices.unknown.schedules.42.enabled", { val: true, ack: false });

		expect(sendRequest).not.toHaveBeenCalled();
	});
});

describe("the switch is acknowledged from the robot's list, not from ['ok']", () => {
	it("asks get_timer after the robot said ok, and acknowledges what it answers", async () => {
		const { adapter, sendRequest, written, states, updateTimers } = await createAdapter();

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(sendRequest).toHaveBeenCalledWith("duid1", "get_timer", []);
		expect(written[0]).toEqual({ id: STATE_ID, state: { val: true, ack: true } });
		expect(states.get(STATE_ID)).toMatchObject({ val: true, ack: true, q: 0 });
		// The list already said everything; rebuilding the whole tree would only ask again.
		expect(updateTimers).not.toHaveBeenCalled();
	});

	it("does not take ['ok'] as proof when the list keeps reporting the old state", async () => {
		// The counter-test of the defect: the robot answers ok and the schedule does not move.
		const { adapter, written, states, order } = await createAdapter({ timers: [[row(TIMER_ID, "off")]] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(states.get(STATE_ID)).toMatchObject({ val: false, ack: true, q: 0x41 });
		expect(commentKey(states.get(STATE_ID))).toBe("ui_cmdres_ineffective");
		// The value the robot really has is written first, the mark on top of it. Swapped, the mark
		// would be cleared by the value write and the switch would spring back without a reason.
		expect(order.slice(-2)).toEqual(["value", "mark"]);
		expect(written.map((entry) => entry.state.val)).toEqual([false, false]);
	});

	it("waits and asks again before calling the switch ineffective", async () => {
		const { adapter, states, order } = await createAdapter({ timers: [[row(TIMER_ID, "off")], [row(TIMER_ID, "on")]] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(order).toEqual(["read", "wait", "read", "value"]);
		expect(states.get(STATE_ID)).toMatchObject({ val: true, ack: true, q: 0 });
	});

	it("reads a state field it does not know as on, the same way the list reader does", async () => {
		// Not `listed === "on"`: the app tests these rows against `'disable'`, the test device answered
		// `"on"`, and a third spelling would otherwise turn a switch that worked into an alarm.
		const { adapter, states, order } = await createAdapter({ timers: [[row(TIMER_ID, "enable")]] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(states.get(STATE_ID)).toMatchObject({ val: true, ack: true, q: 0 });
		expect(order).toEqual(["read", "value"]);
	});

	it("unwraps the transport envelope around both answers", async () => {
		const { adapter, states } = await createAdapter({ updTimer: { data: ["ok"] }, timers: [{ data: [row(TIMER_ID, "on")] }] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(states.get(STATE_ID)).toMatchObject({ val: true, ack: true, q: 0 });
	});

	it("clears a mark an earlier attempt left once the switch is confirmed", async () => {
		const { adapter, states } = await createAdapter({ current: { val: false, ack: true, q: 0x41, c: "{\"k\":\"ui_cmdres_ineffective\"}" } });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(states.get(STATE_ID)).toMatchObject({ val: true, ack: true, q: 0, c: "" });
	});
});

describe("every way the switch can fail says so on the state", () => {
	it("marks an answer that is not ['ok'] as rejected and quotes it", async () => {
		const { adapter, sendRequest, states, order } = await createAdapter({ updTimer: ["unknown_method"] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(sendRequest).not.toHaveBeenCalledWith("duid1", "get_timer", []);
		expect(states.get(STATE_ID)).toMatchObject({ q: 0x44 });
		expect(commentKey(states.get(STATE_ID))).toBe("ui_cmdres_rejected");
		expect(String(states.get(STATE_ID)?.c)).toContain("unknown_method");
		// Re-read first, mark second - the other way round the re-read would wipe the mark.
		expect(order).toEqual(["refresh", "mark"]);
	});

	it("marks a request that timed out as unanswered, and re-reads before marking", async () => {
		const { adapter, states, order } = await createAdapter({ updTimer: new Error("Request Timeout after 30s") });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(states.get(STATE_ID)).toMatchObject({ q: 0x01 });
		expect(commentKey(states.get(STATE_ID))).toBe("ui_cmdres_no_answer");
		expect(order).toEqual(["refresh", "mark"]);
		expect(adapter.catchError).toHaveBeenCalled();
	});

	it("marks any other failure as an error and names it", async () => {
		const { adapter, states } = await createAdapter({ updTimer: new Error("socket hung up") });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(states.get(STATE_ID)).toMatchObject({ q: 0x01 });
		expect(commentKey(states.get(STATE_ID))).toBe("ui_cmdres_error");
		expect(String(states.get(STATE_ID)?.c)).toContain("socket hung up");
	});

	it("writes nothing at all when the adapter is shutting down", async () => {
		// A request cancelled by the shutdown says nothing about the robot, and the states are being
		// torn down anyway.
		const { adapter, order } = await createAdapter({ updTimer: new Error("ADAPTER_STOPPED") });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(order).toEqual([]);
	});

	it("says the outcome is unknown when the robot took the command but the list did not answer", async () => {
		const { adapter, states, order, updateTimers } = await createAdapter({ timers: [new Error("Timeout")] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		// no_answer, not ineffective: nothing was learned about the schedule, so nothing is claimed.
		expect(states.get(STATE_ID)).toMatchObject({ val: true, ack: false, q: 0x01 });
		expect(commentKey(states.get(STATE_ID))).toBe("ui_cmdres_no_answer");
		// One read, no retries: the read is what failed, and asking it twice more says nothing new.
		expect(order).toEqual(["read", "mark"]);
		expect(updateTimers).not.toHaveBeenCalled();
	});
});

describe("a schedule that is gone from the list is not a failure", () => {
	it("says accepted and nothing more when the robot no longer lists the schedule", async () => {
		const { adapter, written, updateTimers } = await createAdapter({ timers: [[row(OTHER_ID, "on")]] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		// `confirmed` and `ineffective` both claim something about a schedule there no longer is, and
		// `accepted` needs no write of its own: it neither acknowledges a value nor raises a quality.
		expect(written).toEqual([]);
		expect(updateTimers).toHaveBeenCalledTimes(1);
	});

	it("clears an older mark before the tree is rebuilt from that same read", async () => {
		const { adapter, states, order } = await createAdapter({
			timers: [[row(OTHER_ID, "on")]],
			current: { val: true, ack: false, q: 0x41, c: "{\"k\":\"ui_cmdres_ineffective\"}" }
		});

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(states.get(STATE_ID)).toMatchObject({ val: true, ack: false, q: 0, c: "" });
		// Marking after the refresh would write onto an object the refresh may have taken away.
		expect(order).toEqual(["read", "mark", "refresh"]);
	});

	it("treats an answer it cannot read the same way, rather than raising an alarm", async () => {
		const { adapter, written, updateTimers } = await createAdapter({ timers: ["unknown_method"] });

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(written).toEqual([]);
		expect(updateTimers).toHaveBeenCalledTimes(1);
	});
});
