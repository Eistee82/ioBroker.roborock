import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * Regression guard for the "Load Map" button.
 *
 * `floors.<mapFlag>.load` is created as a writable button and `handleFloorSwitch()` has always
 * existed, but `Devices.*.floors.*` was never subscribed, so the handler was unreachable and the
 * button silently did nothing – the same defect as the schedule switch.
 */
async function createAdapter() {
	const { Roborock } = await import("../../src/main");
	const handler = { protocolVersion: "1.0" };

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		deviceFeatureHandlers: new Map([["duid1", handler]]),
		requestsHandler: { sendRequest: vi.fn().mockResolvedValue(["ok"]), command: vi.fn() },
		rLog: vi.fn(),
		catchError: vi.fn(),
		setState: vi.fn().mockResolvedValue(undefined)
	});

	const floorSwitch = vi.spyOn(adapter as any, "handleFloorSwitch").mockResolvedValue(undefined);
	return { adapter, floorSwitch };
}

describe("floors.<mapFlag>.load reaches the floor switch", () => {
	it("triggers a floor switch when the button is pressed", async () => {
		const { adapter, floorSwitch } = await createAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.floors.2.load", { val: true, ack: false });

		expect(floorSwitch).toHaveBeenCalledWith("duid1", 2, "roborock.0.Devices.duid1.floors.2.load");
	});

	it("accepts the truthy variants ioBroker scripts produce", async () => {
		for (const val of [true, "true", 1, "1"]) {
			const { adapter, floorSwitch } = await createAdapter();
			await adapter.onStateChange("roborock.0.Devices.duid1.floors.0.load", { val, ack: false });
			expect(floorSwitch, `val=${JSON.stringify(val)}`).toHaveBeenCalledWith("duid1", 0, "roborock.0.Devices.duid1.floors.0.load");
		}
	});

	it("ignores the acknowledged reset back to false", async () => {
		const { adapter, floorSwitch } = await createAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.floors.2.load", { val: false, ack: true });

		expect(floorSwitch).not.toHaveBeenCalled();
	});

	it("ignores a non numeric map flag instead of switching to NaN", async () => {
		const { adapter, floorSwitch } = await createAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.floors.bogus.load", { val: true, ack: false });

		expect(floorSwitch).not.toHaveBeenCalled();
	});

	it("does not turn a room switch into a request", async () => {
		const { adapter, floorSwitch } = await createAdapter();

		// Room switches are read on demand when a segment cleaning starts.
		await adapter.onStateChange("roborock.0.Devices.duid1.floors.2.16", { val: true, ack: false });

		expect(floorSwitch).not.toHaveBeenCalled();
		expect(adapter.requestsHandler.command).not.toHaveBeenCalled();
		expect(adapter.requestsHandler.sendRequest).not.toHaveBeenCalled();
	});
});
