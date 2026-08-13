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
 * `schedules.<timerId>.enabled` was created as a writable switch, but nothing was subscribed to
 * it and `handleCommand` had no matching command folder, so every click was silently dropped.
 * The switch looked operable and did nothing. The counterpart of the `get_timer` read is
 * `upd_timer [timerId, "on"|"off"]`, answered with `["ok"]`.
 */
const TIMER_ID = "1749184337669";
const STATE_ID = `roborock.0.Devices.duid1.schedules.${TIMER_ID}.enabled`;

async function createAdapter(sendRequest: ReturnType<typeof vi.fn>) {
	const { Roborock } = await import("../../src/main");
	const updateTimers = vi.fn().mockResolvedValue(undefined);
	const handler = { protocolVersion: "1.0", updateTimers };
	const setState = vi.fn().mockResolvedValue(undefined);

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		deviceFeatureHandlers: new Map([["duid1", handler]]),
		requestsHandler: { sendRequest, command: vi.fn() },
		rLog: vi.fn(),
		catchError: vi.fn(),
		setState
	});

	return { adapter, handler, setState, updateTimers };
}

describe("schedule switch writes reach the robot", () => {
	it("enables a timer with upd_timer and only then acknowledges the switch", async () => {
		const sendRequest = vi.fn().mockResolvedValue(["ok"]);
		const { adapter, setState, updateTimers } = await createAdapter(sendRequest);

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(sendRequest).toHaveBeenCalledWith("duid1", "upd_timer", [TIMER_ID, "on"]);
		expect(setState).toHaveBeenCalledWith(STATE_ID, { val: true, ack: true });
		expect(updateTimers).not.toHaveBeenCalled();
	});

	it("disables a timer with the off mode", async () => {
		const sendRequest = vi.fn().mockResolvedValue(["ok"]);
		const { adapter, setState } = await createAdapter(sendRequest);

		await adapter.onStateChange(STATE_ID, { val: false, ack: false });

		expect(sendRequest).toHaveBeenCalledWith("duid1", "upd_timer", [TIMER_ID, "off"]);
		expect(setState).toHaveBeenCalledWith(STATE_ID, { val: false, ack: true });
	});

	it("unwraps the transport envelope around the robot answer", async () => {
		const sendRequest = vi.fn().mockResolvedValue({ data: ["ok"] });
		const { adapter, setState, updateTimers } = await createAdapter(sendRequest);

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(setState).toHaveBeenCalledWith(STATE_ID, { val: true, ack: true });
		expect(updateTimers).not.toHaveBeenCalled();
	});

	it("does not answer its own acknowledged updates", async () => {
		const sendRequest = vi.fn().mockResolvedValue(["ok"]);
		const { adapter } = await createAdapter(sendRequest);

		await adapter.onStateChange(STATE_ID, { val: true, ack: true });

		expect(sendRequest).not.toHaveBeenCalled();
	});

	it("re-reads the timers instead of acknowledging an unexpected answer", async () => {
		const sendRequest = vi.fn().mockResolvedValue(["unknown_method"]);
		const { adapter, setState, updateTimers } = await createAdapter(sendRequest);

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(setState).not.toHaveBeenCalled();
		expect(updateTimers).toHaveBeenCalledTimes(1);
	});

	it("restores the real timer state when the request fails", async () => {
		const sendRequest = vi.fn().mockRejectedValue(new Error("timeout"));
		const { adapter, setState, updateTimers } = await createAdapter(sendRequest);

		await adapter.onStateChange(STATE_ID, { val: true, ack: false });

		expect(setState).not.toHaveBeenCalled();
		expect(updateTimers).toHaveBeenCalledTimes(1);
		expect(adapter.catchError).toHaveBeenCalled();
	});

	it("leaves the read-only cron state alone", async () => {
		const sendRequest = vi.fn().mockResolvedValue(["ok"]);
		const { adapter } = await createAdapter(sendRequest);

		await adapter.onStateChange(`roborock.0.Devices.duid1.schedules.${TIMER_ID}.cron`, { val: "0 14 * * 5", ack: false });

		expect(sendRequest).not.toHaveBeenCalled();
	});

	it("ignores schedules of a device without a feature handler", async () => {
		const sendRequest = vi.fn().mockResolvedValue(["ok"]);
		const { adapter } = await createAdapter(sendRequest);

		await adapter.onStateChange("roborock.0.Devices.unknown.schedules.42.enabled", { val: true, ack: false });

		expect(sendRequest).not.toHaveBeenCalled();
	});
});
