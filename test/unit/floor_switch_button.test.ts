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
	const timeouts = new Map<number, () => void>();
	let nextTimeoutId = 1;

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		deviceFeatureHandlers: new Map([["duid1", handler]]),
		requestsHandler: { sendRequest: vi.fn().mockResolvedValue(["ok"]), command: vi.fn() },
		rLog: vi.fn(),
		catchError: vi.fn(),
		setState: vi.fn().mockResolvedValue(undefined),
		// The room switch schedules a repaint of the stored map; these three carry that.
		mapManager: { repaintStoredMap: vi.fn().mockResolvedValue(undefined) },
		commandTimeouts: new Map(),
		setTimeout: (callback: () => void) => {
			const id = nextTimeoutId++;
			timeouts.set(id, callback);
			return id;
		},
		clearTimeout: vi.fn((id: number) => timeouts.delete(id))
	});

	const floorSwitch = vi.spyOn(adapter as any, "handleFloorSwitch").mockResolvedValue(undefined);
	/** Runs whatever is still scheduled, so the debounced repaint can be observed. */
	const runTimeouts = (): void => {
		const pending = [...timeouts.values()];
		timeouts.clear();
		pending.forEach((callback) => callback());
	};
	return { adapter, floorSwitch, runTimeouts };
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

	it("draws the map again when a room switch changes, because the map shows the selection", async () => {
		const { adapter, runTimeouts } = await createAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.floors.2.16", { val: true, ack: false });
		expect(adapter.mapManager.repaintStoredMap).not.toHaveBeenCalled();

		runTimeouts();
		expect(adapter.mapManager.repaintStoredMap).toHaveBeenCalledWith("duid1");
	});

	it("collects a burst of clicks into a single repaint", async () => {
		const { adapter, runTimeouts } = await createAdapter();

		for (const roomId of [16, 17, 18]) {
			await adapter.onStateChange(`roborock.0.Devices.duid1.floors.2.${roomId}`, { val: true, ack: false });
		}
		runTimeouts();

		// Three writes, one canvas pass: the earlier timeouts are cleared, not fired.
		expect(adapter.clearTimeout).toHaveBeenCalledTimes(2);
		expect(adapter.mapManager.repaintStoredMap).toHaveBeenCalledTimes(1);
	});

	it("does not repaint for the floor metadata below the same folder", async () => {
		const { adapter, runTimeouts } = await createAdapter();

		for (const target of ["name", "map_id", "add_time", "mapFlag"]) {
			await adapter.onStateChange(`roborock.0.Devices.duid1.floors.2.${target}`, { val: "x", ack: false });
		}
		runTimeouts();

		expect(adapter.mapManager.repaintStoredMap).not.toHaveBeenCalled();
	});
});
