import { beforeEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../../../mock/MockAdapter";
import { MockRobot } from "../../../mock/MockRobot";
import { Feature } from "../../features.enum";
import { V1VacuumFeatures } from "../v1VacuumFeatures";
import { applyRetryEnvelope, MapEditService, parseCleanSequence, readRetryId, RPC_RETRY_FEATURE_BIT } from "./MapEditService";

class TestVacuum extends V1VacuumFeatures {
	protected getDynamicFeatures(): Set<Feature> {
		return new Set();
	}
	public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
		return false;
	}
}

describe("MapEditService", () => {
	let mockAdapter: MockAdapter;
	let mockRobot: MockRobot;
	let vacuum: TestVacuum;
	let deps: any;

	/** Runs a command state write the way `requestsHandler.command` would. */
	async function runCommand(method: string, value: unknown): Promise<{ method: string; params: any }> {
		const intercepted: any = await vacuum.getCommandParams(method, value);
		const finalMethod = intercepted?.method ?? method;
		const finalParams = intercepted?.method ? intercepted.params : intercepted;
		const response = await deps.requestsHandler.sendRequest(mockRobot.duid, finalMethod, finalParams);
		await vacuum.onCommandResult(method, finalMethod, response, finalParams);
		return { method: finalMethod, params: finalParams };
	}

	beforeEach(async () => {
		mockAdapter = new MockAdapter();
		mockRobot = new MockRobot();

		deps = {
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
				sendRequest: async (duid: string, method: string, params: any) => {
					if (duid !== mockRobot.duid) return [];
					return mockRobot.handleRequest(method, params);
				},
				command: async () => {}
			}
		};
		mockAdapter.requestsHandler = deps.requestsHandler;
		mockAdapter.http_api = deps.http_api;

		vacuum = new TestVacuum(deps, mockRobot.duid, mockRobot.model, { staticFeatures: [] });
		await vacuum.initialize();
	});

	describe("retry envelope (report section 1.2)", () => {
		it("wraps an array payload as {data, need_retry} when the bit is set", () => {
			expect(applyRetryEnvelope([16, 17], true)).toEqual({ data: [16, 17], need_retry: 1 });
		});

		it("adds need_retry to an object payload when the bit is set", () => {
			expect(applyRetryEnvelope({ map_flag: 0 }, true)).toEqual({ map_flag: 0, need_retry: 1 });
		});

		it("sends bare parameters when the bit is not set", () => {
			expect(applyRetryEnvelope([16, 17], false)).toEqual([16, 17]);
		});

		it("recognises a deferred answer and its id", () => {
			expect(readRetryId({ result: "retry", id: 42 })).toBe(42);
			expect(readRetryId([{ result: "retry", id: 7 }])).toBe(7);
			expect(readRetryId({ data: { result: "retry", id: 9 } })).toBe(9);
		});

		it("reports a deferred answer without an id as retry_id_invalid", () => {
			expect(readRetryId({ result: "retry" })).toBeUndefined();
		});

		it("treats an ordinary result as not deferred", () => {
			expect(readRetryId(["ok"])).toBeNull();
			expect(readRetryId({ result: "ok" })).toBeNull();
		});
	});

	describe("set_clean_sequence (report section 1.9)", () => {
		it("registers the command state as writable JSON", async () => {
			const commands = (vacuum as any).commands;
			expect(commands).toHaveProperty("set_clean_sequence");
			expect(commands.set_clean_sequence.type).toBe("json");

			await vacuum.createCommandObjects();
			const obj = mockAdapter.objects[`Devices.${mockRobot.duid}.commands.set_clean_sequence`];
			expect(obj).toBeDefined();
			expect(obj.common.write).toBe(true);
			// 'json' is stored as a string state, the way processCommand maps it.
			expect(obj.common.type).toBe("string");
		});

		it("sends the ordered segment ids straight through", async () => {
			const sent = await runCommand("set_clean_sequence", [16, 18, 17]);
			expect(sent.method).toBe("set_clean_sequence");
			expect(sent.params).toEqual([16, 18, 17]);
			expect(mockRobot.cleanSequence).toEqual([16, 18, 17]);
		});

		it("clears the order with an empty array", async () => {
			mockRobot.cleanSequence = [16, 17];
			const sent = await runCommand("set_clean_sequence", []);
			expect(sent.params).toEqual([]);
			expect(mockRobot.cleanSequence).toEqual([]);
		});

		it("wraps the payload once the robot reports feature bit 26", async () => {
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, { val: RPC_RETRY_FEATURE_BIT, ack: true });

			const sent = await runCommand("set_clean_sequence", [16, 17]);
			expect(sent.params).toEqual({ data: [16, 17], need_retry: 1 });
			// The mock strips the envelope again, so the robot still stored the plain list.
			expect(mockRobot.cleanSequence).toEqual([16, 17]);
		});

		it("does not wrap when the reported feature info lacks bit 26", async () => {
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, { val: 0x1000, ack: true });

			const sent = await runCommand("set_clean_sequence", [16]);
			expect(sent.params).toEqual([16]);
		});

		it("rejects anything that is not a list of segment ids", () => {
			expect(() => parseCleanSequence("kitchen")).toThrow(/expects a JSON array/);
			expect(() => parseCleanSequence([16, "kitchen"])).toThrow(/not a segment id/);
			expect(() => parseCleanSequence([16, -1])).toThrow(/not a segment id/);
			expect(() => parseCleanSequence([16, 1.5])).toThrow(/not a segment id/);
		});

		it("accepts numeric strings, because a JSON state may deliver them", () => {
			expect(parseCleanSequence(["16", "17"])).toEqual([16, 17]);
		});

		it("polls retry_request until the robot confirms a deferred call", async () => {
			mockRobot.deferOnce.add("set_clean_sequence");
			mockRobot.retryPollsNeeded = 2;

			await runCommand("set_clean_sequence", [16, 17]);

			const polls = mockRobot.seen.filter((entry) => entry.method === "retry_request");
			expect(polls).toHaveLength(2);
			expect(polls[0].params.method).toBe("set_clean_sequence");
			expect(polls[0].params.retry_count).toBe(1);
			expect(polls[1].params.retry_count).toBe(2);
		});
	});

	describe("scope", () => {
		it("claims only the commands it registers", () => {
			const service = new MapEditService(deps, mockRobot.duid);
			expect(service.handles("set_clean_sequence")).toBe(true);
			expect(service.handles("app_start")).toBe(false);
		});

		it("does not touch the destructive editor methods", () => {
			const service = new MapEditService(deps, mockRobot.duid);
			for (const method of ["save_map", "split_segment", "merge_segment", "set_carpet_area", "set_carpet_clean_mode"]) {
				expect(service.handles(method)).toBe(false);
			}
		});
	});
});
