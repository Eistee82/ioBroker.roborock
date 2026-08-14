import { beforeEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../../../mock/MockAdapter";
import { MockRobot } from "../../../mock/MockRobot";
import { Feature } from "../../features.enum";
import { V1VacuumFeatures } from "../v1VacuumFeatures";
import { applyRetryEnvelope, FURNITURE_TYPES, MapEditService, parseCleanSequence, parseFurnitures, readRetryId, RPC_RETRY_FEATURE_BIT } from "./MapEditService";

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

	describe("save_furnitures (report section 1.8)", () => {
		/** A well-formed "add" record: [1, id, four corners in mm, type, subType, direction]. */
		const bed = [1, -1, 1000, 1000, 2000, 1000, 2000, 3000, 1000, 3000, 45, 0, 0];

		it("registers the command state as writable JSON", async () => {
			const commands = (vacuum as any).commands;
			expect(commands).toHaveProperty("save_furnitures");
			expect(commands.save_furnitures.type).toBe("json");

			await vacuum.createCommandObjects();
			const obj = mockAdapter.objects[`Devices.${mockRobot.duid}.commands.save_furnitures`];
			expect(obj).toBeDefined();
			expect(obj.common.write).toBe(true);
		});

		it("sends {map_flag, data} and adds the piece", async () => {
			const sent = await runCommand("save_furnitures", { map_flag: 0, data: [bed] });

			expect(sent.method).toBe("save_furnitures");
			expect(sent.params).toEqual({ map_flag: 0, data: [bed] });
			expect([...mockRobot.furnitures.get(0)!.values()]).toHaveLength(1);
		});

		it("falls back to the active map when the payload names none", async () => {
			// map_status 12 puts the robot on map slot 3 (12 >> 2).
			(vacuum as any).mapService.updateCurrentMapIndex(12);
			expect(vacuum.getCurrentMapIndex()).toBe(3);

			const sent = await runCommand("save_furnitures", { data: [bed] });
			expect(sent.params.map_flag).toBe(3);
		});

		it("accepts a bare array of records", async () => {
			(vacuum as any).mapService.updateCurrentMapIndex(0);
			const sent = await runCommand("save_furnitures", [bed]);
			expect(sent.params.data).toEqual([bed]);
			expect(sent.params.map_flag).toBe(0);
		});

		it("refuses to guess a map before one is loaded", () => {
			// V1MapService starts at -1; sending furniture to map 0 on a two-map robot would put it
			// on the wrong floor, so the payload has to name the map instead.
			expect(vacuum.getCurrentMapIndex()).toBe(-1);
			expect(() => parseFurnitures({ data: [bed] }, -1)).toThrow(/no usable map_flag/);
		});

		it("deletes with [0, id] and leaves the other pieces alone", async () => {
			await runCommand("save_furnitures", { map_flag: 0, data: [bed, [1, -1, 0, 0, 10, 0, 10, 10, 0, 10, 46, 0, 0]] });
			const ids = [...mockRobot.furnitures.get(0)!.keys()];
			expect(ids).toHaveLength(2);

			await runCommand("save_furnitures", { map_flag: 0, data: [[0, ids[0]]] });

			// Differential: only the named piece is gone, the other survives.
			expect([...mockRobot.furnitures.get(0)!.keys()]).toEqual([ids[1]]);
		});

		it("is not wrapped in the retry envelope even when the bit is set", async () => {
			// save_furnitures is not one of the 13 retry methods (report section 1.2).
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, { val: RPC_RETRY_FEATURE_BIT, ack: true });

			const sent = await runCommand("save_furnitures", { map_flag: 0, data: [bed] });
			expect(sent.params).toEqual({ map_flag: 0, data: [bed] });
			expect(sent.params.need_retry).toBeUndefined();
		});

		it("rejects a malformed record instead of sending it", () => {
			expect(() => parseFurnitures({ data: [[1, -1, 0, 0]] }, 0)).toThrow(/13 values/);
			expect(() => parseFurnitures({ data: [[0, 1, 2]] }, 0)).toThrow(/\[0, id\]/);
			expect(() => parseFurnitures({ data: [[2, 1]] }, 0)).toThrow(/the operation/);
			expect(() => parseFurnitures({ data: [] }, 0)).toThrow(/empty record list/);
			expect(() => parseFurnitures("bed", 0)).toThrow(/expects/);
			expect(() => parseFurnitures({ data: [[1, -1, 0, 0, 10, 0, 10, 10, 0, 10, 45, 0, "left"]] }, 0)).toThrow(/whole number/);
		});

		it("rejects a map_flag that is not a map", () => {
			expect(() => parseFurnitures({ map_flag: -1, data: [bed] }, 0)).toThrow(/invalid map_flag/);
		});

		it("lists the documented furniture types", () => {
			expect(FURNITURE_TYPES[45]).toBe("FT_BED");
			expect(FURNITURE_TYPES[58]).toBe("FT_CATTREE");
			// The gaps between 0 and 43 are not assigned in the plugin.
			expect(FURNITURE_TYPES[42]).toBeUndefined();
		});

		it("still sends an undocumented furniture type", async () => {
			const exotic = [1, -1, 0, 0, 10, 0, 10, 10, 0, 10, 99, 0, 0];
			const sent = await runCommand("save_furnitures", { map_flag: 0, data: [exotic] });
			expect(sent.params.data).toEqual([exotic]);
		});
	});

	describe("scope", () => {
		it("claims only the commands it registers", () => {
			const service = new MapEditService(deps, mockRobot.duid);
			expect(service.handles("set_clean_sequence")).toBe(true);
			expect(service.handles("save_furnitures")).toBe(true);
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
