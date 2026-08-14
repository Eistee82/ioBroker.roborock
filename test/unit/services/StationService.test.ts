import { beforeEach, describe, expect, it, vi } from "vitest";
import { StationService } from "../../../src/lib/features/vacuum/services/StationService";

describe("StationService", () => {
	let service: StationService;
	let mockAdapter: any;
	let mockDeps: any;

	beforeEach(() => {
		mockAdapter = {
			setStateChanged: vi.fn(),
			translationManager: {
				get: vi.fn((key, def) => def || key),
			}
		};

		mockDeps = {
			adapter: mockAdapter,
			ensureState: vi.fn(),
			ensureFolder: vi.fn(),
		};

		service = new StationService(mockDeps, "test_duid");
	});

	describe("updateDockingStationStatus", () => {
		it("should correctly parse DSS bitmask (Case: All OK)", async () => {
			// dss = 0b 10 10 10 10 10 10 (binary)
			// dss = 0xAAA (hex) = 2730 (decimal)
			// Each 2-bit pair is 2 (OK)
			await service.updateDockingStationStatus(2730);

			const expectedValue = 2; // OK
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("cleanFluidStatus"), { val: expectedValue, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("waterBoxFilterStatus"), { val: expectedValue, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("dustBagStatus"), { val: expectedValue, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("dirtyWaterBoxStatus"), { val: expectedValue, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("clearWaterBoxStatus"), { val: expectedValue, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("isUpdownWaterReady"), { val: expectedValue, ack: true });
		});

		it("should correctly parse DSS bitmask (Case: Mixed values)", async () => {
			// Bits:
			// 10-11: 1 (Maintenance) -> cleanFluidStatus
			// 8-9: 2 (OK) -> waterBoxFilterStatus
			// 6-7: 3 (Unknown) -> dustBagStatus
			// 4-5: 0 (Not Supported) -> dirtyWaterBoxStatus
			// 2-3: 1 (Maintenance) -> clearWaterBoxStatus
			// 0-1: 2 (OK) -> isUpdownWaterReady

			// Binary: 01 10 11 00 01 10
			// Hex: 0x6C6
			// Decimal: 1734
			await service.updateDockingStationStatus(1734);

			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("cleanFluidStatus"), { val: 1, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("waterBoxFilterStatus"), { val: 2, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("dustBagStatus"), { val: 3, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("dirtyWaterBoxStatus"), { val: 0, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("clearWaterBoxStatus"), { val: 1, ack: true });
			expect(mockAdapter.setStateChanged).toHaveBeenCalledWith(expect.stringContaining("isUpdownWaterReady"), { val: 2, ack: true });
		});
	});

	describe("updateWashAndDryStatus", () => {
		/** Value written to `dockingStationStatus.<name>`, or undefined when nothing was written. */
		function written(name: string): unknown {
			const call = mockAdapter.setStateChanged.mock.calls.find(
				(entry: any[]) => entry[0] === `Devices.test_duid.dockingStationStatus.${name}`
			);
			return call ? call[1].val : undefined;
		}

		/** `common` of the object created for `dockingStationStatus.<name>`. */
		function definition(name: string): any {
			const call = mockDeps.ensureState.mock.calls.find(
				(entry: any[]) => entry[0] === `Devices.test_duid.dockingStationStatus.${name}`
			);
			return call ? call[1] : undefined;
		}

		it("splits wash_status into task status and mode the way the app does", async () => {
			// 0x0B07: low byte 7 (a task is running), high byte 11.
			await service.updateWashAndDryStatus({ wash_status: 0x0b07 });

			expect(written("washingTaskStatus")).toBe(7);
			expect(written("washingMode")).toBe(11);
			expect(written("isWashing")).toBe(true);
		});

		it("reports no wash while the low byte is zero", async () => {
			await service.updateWashAndDryStatus({ wash_status: 0 });

			expect(written("washingTaskStatus")).toBe(0);
			expect(written("isWashing")).toBe(false);
		});

		it("labels only the four wash modes the app gives a wording to", async () => {
			await service.updateWashAndDryStatus({ wash_status: 0x0601 });

			const states = definition("washingMode").states;
			expect(Object.keys(states).sort()).toEqual(["12", "6", "7", "9"]);
			// A mode without a proven wording must stay a bare number rather than borrow a label.
			expect(states[11]).toBeUndefined();
		});

		it("derives drying and its remaining minutes from dry_status and rdt", async () => {
			await service.updateWashAndDryStatus({ dry_status: 1, rdt: 7200 });

			expect(written("isDrying")).toBe(true);
			// rdt is seconds; the app shows minutes.
			expect(written("dryRemainTime")).toBe(120);
			expect(definition("dryRemainTime").unit).toBe("min");
		});

		it("treats every dry_status other than 1 as not drying", async () => {
			await service.updateWashAndDryStatus({ dry_status: 0 });

			expect(written("isDrying")).toBe(false);
		});

		it("maps wash_ready 1 to the ready flag", async () => {
			await service.updateWashAndDryStatus({ wash_ready: 1 });
			expect(written("isWashReady")).toBe(true);

			mockAdapter.setStateChanged.mockClear();
			await service.updateWashAndDryStatus({ wash_ready: 0 });
			expect(written("isWashReady")).toBe(false);
		});

		it("publishes nothing at all when the device reports none of the fields", async () => {
			await service.updateWashAndDryStatus({ state: 8, battery: 100 });

			expect(mockDeps.ensureFolder).not.toHaveBeenCalled();
			expect(mockAdapter.setStateChanged).not.toHaveBeenCalled();
		});

		it("skips exactly the fields the device leaves out", async () => {
			await service.updateWashAndDryStatus({ dry_status: 1 });

			expect(written("isDrying")).toBe(true);
			expect(written("washingTaskStatus")).toBeUndefined();
			expect(written("isWashReady")).toBeUndefined();
			expect(written("dryRemainTime")).toBeUndefined();
		});
	});
});
