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

	describe("deleting a schedule", () => {
		it("publishes where each schedule lives and a button to remove it", async () => {
			await vacuumFeatures.updateTimers();
			const timerId = mockRobot.timers[0][0];

			await mockAdapter.expectState(`Devices.${mockRobot.duid}.schedules.${timerId}.source`, { val: "device" });

			const button = await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.${timerId}.delete`);
			expect(button.common.write).toBe(true);
			expect(button.common.role).toBe("button");
			expect(button.common.type).toBe("boolean");
		});

		it("sends del_timer with the very id get_timer reported, and takes the object away", async () => {
			await vacuumFeatures.updateTimers();
			const timerId = mockRobot.timers[0][0];
			mockRobot.seen.length = 0;

			const result = await vacuumFeatures.deleteSchedule(timerId, "device");

			expect(result.outcome).toBe("confirmed");
			// A65:582570-582583 hands the wrapper one argument, and A65:582378 proves that argument is
			// get_timer row index 0 - the same string the folder is named after.
			expect(mockRobot.seen.find((call) => call.method === "del_timer")?.params).toEqual([timerId]);
			expect(mockRobot.timers.some((entry: any[]) => entry[0] === timerId)).toBe(false);
			expect(await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.${timerId}.delete`)).toBeFalsy();
		});

		it("sends del_server_timer for a schedule that lives on the server", async () => {
			mockRobot.serverTimers = [["1743140136890", "on", -1]];
			await vacuumFeatures.updateTimers();
			await mockAdapter.expectState(`Devices.${mockRobot.duid}.schedules.1743140136890.source`, { val: "server" });
			mockRobot.seen.length = 0;

			const result = await vacuumFeatures.deleteSchedule("1743140136890", "server");

			expect(result.outcome).toBe("confirmed");
			expect(mockRobot.seen.find((call) => call.method === "del_server_timer")?.params).toEqual(["1743140136890"]);
			expect(mockRobot.seen.some((call) => call.method === "del_timer")).toBe(false);
			expect(mockRobot.serverTimers).toEqual([]);
		});

		it("says on the button that the copy in the Roborock account stays", async () => {
			mockAdapter.translations = {};
			mockRobot.serverTimers = [["1743140136890", "on", -1]];
			await vacuumFeatures.updateTimers();

			const serverButton = await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.1743140136890.delete`);
			expect(String(serverButton.common.desc)).toMatch(/Roborock account stays/);

			const deviceButton = await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.${mockRobot.timers[0][0]}.delete`);
			expect(String(deviceButton.common.desc)).not.toMatch(/Roborock account stays/);
		});

		it("keeps the schedule when the robot still lists it afterwards", async () => {
			await vacuumFeatures.updateTimers();
			const timerId = mockRobot.timers[0][0];

			// The robot answers the delete and changes nothing - the silent case this project keeps
			// finding. Only the list read afterwards can tell, which is why the answer is not the test.
			const original = depsMock.requestsHandler.sendRequest;
			depsMock.requestsHandler.sendRequest = async (duid: string, method: string, params: any[]) =>
				method === "del_timer" ? ["ok"] : original(duid, method, params);

			const result = await vacuumFeatures.deleteSchedule(timerId, "device");

			expect(result.outcome).toBe("ineffective");
			expect(await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.${timerId}.delete`)).toBeTruthy();
		});

		it("reports 'unknown' rather than success when the list read fails", async () => {
			await vacuumFeatures.updateTimers();
			const timerId = mockRobot.timers[0][0];

			const original = depsMock.requestsHandler.sendRequest;
			depsMock.requestsHandler.sendRequest = async (duid: string, method: string, params: any[]) => {
				if (method === "get_timer") throw new Error("Timeout");
				return original(duid, method, params);
			};

			const result = await vacuumFeatures.deleteSchedule(timerId, "device");

			expect(result.outcome).toBe("no_answer");
			expect(await mockAdapter.getObjectAsync(`Devices.${mockRobot.duid}.schedules.${timerId}.delete`)).toBeTruthy();
		});

		it("does not send anything for an id that could escape its path", async () => {
			mockRobot.seen.length = 0;
			const result = await vacuumFeatures.deleteSchedule("../../other", "device");

			expect(result.outcome).toBe("not_sent");
			expect(mockRobot.seen).toEqual([]);
		});
	});
});
