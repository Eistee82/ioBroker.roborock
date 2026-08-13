import { beforeEach, describe, expect, it, vi } from "vitest";
import { Feature } from "../features/features.enum";
import { V1VacuumFeatures } from "../features/vacuum/v1VacuumFeatures";
import { MockAdapter } from "./MockAdapter";
import { MockRobot } from "./MockRobot";

class TestVacuum extends V1VacuumFeatures {
	protected getDynamicFeatures(): Set<Feature> {
		return new Set();
	}
	public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
		return false;
	}
}

describe("Schedule (Timer) Verification", () => {
	let mockAdapter: MockAdapter;
	let mockRobot: MockRobot;
	let vacuumFeatures: TestVacuum;
	let depsMock: any;

	beforeEach(async () => {
		mockAdapter = new MockAdapter();
		mockRobot = new MockRobot();

		depsMock = {
			adapter: mockAdapter,
			log: mockAdapter.log,
			ensureState: async (id: string, common: any) => {
				await mockAdapter.setObjectNotExistsAsync(id, { type: "state", common });
			},
			ensureFolder: async (id: string) => {
				await mockAdapter.setObjectNotExistsAsync(id, { type: "folder", common: { name: id } });
			},
			config: { staticFeatures: [] },
			http_api: {
				getFwFeaturesResult: () => mockRobot.features,
				storeFwFeaturesResult: () => {},
				getRobotModel: () => mockRobot.model
			},
			requestsHandler: {
				sendRequest: async (duid: string, method: string, params: any[]) => {
					if (duid !== mockRobot.duid) return [];
					return mockRobot.handleRequest(method, params);
				},
				command: async () => {}
			}
		};
		mockAdapter.requestsHandler = depsMock.requestsHandler;
		mockAdapter.http_api = depsMock.http_api;

		vacuumFeatures = new TestVacuum(depsMock, mockRobot.duid, mockRobot.model, { staticFeatures: [] });
		await vacuumFeatures.initialize();
	});

	it("should process timers and create schedule states", async () => {
		// Mock timer response
		const timerResponse = [
			["timer_id_1", "on", ["0 14 * * 5", ["Start Cleaning", ["102", "1", "101", "100"]], 1234567890]],
			["timer_id_2", "off", ["0 10 * * *", ["Start Cleaning", ["102", "1", "101", "100"]], 1234567891]],
			["timer_id_3", "on", ["0 8 * * 1,3,5", ["Start Cleaning", ["102", "1", "101", "100"]], 1234567892]]
		];
		// Inject mock into requestsHandler.sendRequest instead of mockRobot
		const originalSendRequest = depsMock.requestsHandler.sendRequest;
		depsMock.requestsHandler.sendRequest = vi.fn().mockImplementation(async (duid, method, params) => {
			if (method === "get_timer") return timerResponse;
			return originalSendRequest(duid, method, params);
		});

		// Call via vacuumFeatures
		await vacuumFeatures.updateTimers();

		// Check if get_timer was called
		expect(depsMock.requestsHandler.sendRequest).toHaveBeenCalledWith(expect.anything(), "get_timer", expect.anything());

		// Verify States are created
		const duid = mockRobot.duid;
		await mockAdapter.expectState(`Devices.${duid}.schedules.timer_id_1.enabled`, { val: true });
		await mockAdapter.expectState(`Devices.${duid}.schedules.timer_id_1.cron`, { val: "0 14 * * 5" });

		await mockAdapter.expectState(`Devices.${duid}.schedules.timer_id_2.enabled`, { val: false });
		await mockAdapter.expectState(`Devices.${duid}.schedules.timer_id_3.cron`, { val: "0 8 * * 1,3,5" });
	});

	it("keeps the enabled switch writable so it can be toggled", async () => {
		await vacuumFeatures.updateTimers();

		const timerId = mockRobot.timers[0][0];
		const obj = await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.${timerId}.enabled`);
		expect(obj.common.write).toBe(true);

		// The cron of a timer can only be changed by rewriting the whole timer (set_timer), so it stays read-only.
		const cronObj = await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.${timerId}.cron`);
		expect(cronObj.common.write).toBe(false);
	});

	it("reflects an upd_timer toggle on the next timer read", async () => {
		const timerId = mockRobot.timers[0][0];
		await vacuumFeatures.updateTimers();
		await mockAdapter.expectState(`Devices.${mockRobot.duid}.schedules.${timerId}.enabled`, { val: true });

		// upd_timer is the counterpart of get_timer: [timerId, "on"|"off"] -> ["ok"].
		const result = await depsMock.requestsHandler.sendRequest(mockRobot.duid, "upd_timer", [timerId, "off"]);
		expect(result).toEqual(["ok"]);

		await vacuumFeatures.updateTimers();
		await mockAdapter.expectState(`Devices.${mockRobot.duid}.schedules.${timerId}.enabled`, { val: false });
	});

	it("rejects an upd_timer for an unknown timer id", async () => {
		const result = await depsMock.requestsHandler.sendRequest(mockRobot.duid, "upd_timer", ["does_not_exist", "off"]);
		expect(result).toEqual(["unknown_id"]);
	});
});
