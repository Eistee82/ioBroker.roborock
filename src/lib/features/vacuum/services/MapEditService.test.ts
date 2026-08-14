import { beforeEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../../../mock/MockAdapter";
import { MockRobot } from "../../../mock/MockRobot";
import { Feature } from "../../features.enum";
import { V1VacuumFeatures } from "../v1VacuumFeatures";
import {
	applyRetryEnvelope,
	CARPET_CLEAN_MODES,
	FURNITURE_TYPES,
	hasFeatureStrBit,
	MapEditService,
	MATTER_FEATURE_BIT,
	parseCarpetCleanMode,
	parseCarpetMode,
	parseCleanSequence,
	parseFurnitures,
	parseRoomMapping,
	parseRoomNaming,
	readRetryId,
	ROOM_TAGS,
	RPC_RETRY_FEATURE_BIT
} from "./MapEditService";

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

	describe("name_segment (report section 1.5)", () => {
		/** Gives the adapter a cloud session with a room catalogue. */
		function withCloud(rooms: { id: number; name: string }[] = [], created: number | null = 9001): void {
			deps.http_api.homeID = 12345;
			deps.http_api.homeData = { rooms: [...rooms] };
			deps.http_api.realApi = {
				post: async (_url: string, _body: string) => ({ data: { success: true, result: { id: created } } })
			};
		}

		it("registers the command state as writable JSON", async () => {
			const commands = (vacuum as any).commands;
			expect(commands).toHaveProperty("name_segment");
			expect(commands.name_segment.type).toBe("json");

			await vacuum.createCommandObjects();
			const obj = mockAdapter.objects[`Devices.${mockRobot.duid}.commands.name_segment`];
			expect(obj).toBeDefined();
			expect(obj.common.write).toBe(true);
		});

		it("sends the complete assignment, not just the renamed room", async () => {
			withCloud([{ id: 777, name: "Kitchen" }]);

			const sent = await runCommand("name_segment", [{ segmentId: 2, name: "Kitchen" }]);

			// The mock robot ships six rooms; all six have to be in the payload, because the
			// firmware replaces the whole assignment and would drop the rest.
			expect(sent.params).toHaveLength(6);
			expect(sent.params.map((entry: any) => entry.robotRoomId)).toEqual([1, 2, 3, 4, 5, 6]);

			const renamed = sent.params.find((entry: any) => entry.robotRoomId === 2);
			expect(renamed.iotRoomId).toBe("777");
			// The untouched rooms keep the cloud id and tag they already had.
			const untouched = sent.params.find((entry: any) => entry.robotRoomId === 1);
			expect(untouched).toEqual({ iotRoomId: "1060432", robotRoomId: 1, robotTagId: 1 });
		});

		it("creates a cloud room when no existing one carries the name", async () => {
			withCloud([], 9001);
			let posted: { url: string; body: string } | null = null;
			deps.http_api.realApi.post = async (url: string, body: string) => {
				posted = { url, body };
				return { data: { success: true, result: { id: 9001 } } };
			};

			const sent = await runCommand("name_segment", [{ segmentId: 3, name: "Studio" }]);

			expect(posted!.url).toBe("user/homes/12345/rooms");
			expect(posted!.body).toBe("name=Studio");
			expect(sent.params.find((entry: any) => entry.robotRoomId === 3).iotRoomId).toBe("9001");
			// The new room is cached, so the map resolves the name without another fetch.
			expect(deps.http_api.homeData.rooms).toContainEqual({ id: 9001, name: "Studio" });
		});

		it("reuses an existing cloud room instead of creating a duplicate", async () => {
			withCloud([{ id: 555, name: "Bathroom" }]);
			let posts = 0;
			deps.http_api.realApi.post = async () => {
				posts++;
				return { data: { success: true, result: { id: 1 } } };
			};

			const sent = await runCommand("name_segment", [{ segmentId: 4, name: "Bathroom" }]);

			expect(posts).toBe(0);
			expect(sent.params.find((entry: any) => entry.robotRoomId === 4).iotRoomId).toBe("555");
		});

		it("changes only the tag without needing a cloud session", async () => {
			deps.http_api.realApi = null;
			deps.http_api.homeID = null;

			const sent = await runCommand("name_segment", [{ segmentId: 5, tag: 13 }]);

			expect(sent.params.find((entry: any) => entry.robotRoomId === 5)).toEqual({ iotRoomId: "1060436", robotRoomId: 5, robotTagId: 13 });
			expect(mockRobot.roomMapping).toHaveLength(6);
		});

		it("refuses to rename without a cloud session, because names live there", async () => {
			deps.http_api.realApi = null;
			deps.http_api.homeID = null;
			deps.http_api.homeData = { rooms: [] };

			await expect(runCommand("name_segment", [{ segmentId: 5, name: "Den" }])).rejects.toThrow(/no cloud session/);
		});

		it("refuses a segment that is not on the map", async () => {
			withCloud([{ id: 1, name: "Nowhere" }]);
			await expect(runCommand("name_segment", [{ segmentId: 99, name: "Nowhere" }])).rejects.toThrow(/not on the current map/);
		});

		it("refuses when the current mapping cannot be read", async () => {
			withCloud([{ id: 1, name: "Kitchen" }]);
			mockRobot.roomMapping = [];

			await expect(runCommand("name_segment", [{ segmentId: 2, name: "Kitchen" }])).rejects.toThrow(/incomplete list/);
		});

		it("leaves the robot's assignment intact for the rooms it did not rename", async () => {
			withCloud([{ id: 777, name: "Kitchen" }]);
			await runCommand("name_segment", [{ segmentId: 2, name: "Kitchen" }]);

			// The mock replaces its mapping exactly as the firmware does, so a short payload would
			// show up here as lost rooms.
			expect(mockRobot.roomMapping).toHaveLength(6);
			expect(mockRobot.roomMapping).toContainEqual([1, "1060432", 1]);
			expect(mockRobot.roomMapping).toContainEqual([2, "777", 15]);
		});

		it("skips sync_rooms_info unless the robot reports the Matter bit", async () => {
			withCloud([{ id: 777, name: "Kitchen" }]);
			await runCommand("name_segment", [{ segmentId: 2, name: "Kitchen" }]);
			expect(mockRobot.syncedRoomNames).toBeNull();
		});

		it("sends sync_rooms_info before name_segment when the Matter bit is set", async () => {
			withCloud([{ id: 777, name: "Kitchen" }]);
			// Bit 67 set in the hex feature string.
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info_str`, { val: (1n << 67n).toString(16), ack: true });

			await runCommand("name_segment", [{ segmentId: 2, name: "Kitchen" }]);

			expect(mockRobot.syncedRoomNames).toEqual([{ id: "777", name: "Kitchen" }]);
			const order = mockRobot.seen.map((entry) => entry.method);
			expect(order.indexOf("sync_rooms_info")).toBeLessThan(order.indexOf("name_segment"));
		});

		it("wraps the payload when the retry bit is set", async () => {
			withCloud([{ id: 777, name: "Kitchen" }]);
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, { val: RPC_RETRY_FEATURE_BIT, ack: true });

			const sent = await runCommand("name_segment", [{ segmentId: 2, name: "Kitchen" }]);

			expect(sent.params.need_retry).toBe(1);
			expect(sent.params.data).toHaveLength(6);
		});

		it("rejects a malformed request instead of sending it", () => {
			expect(() => parseRoomNaming([{ name: "Kitchen" }])).toThrow(/needs a 'segmentId'/);
			expect(() => parseRoomNaming([{ segmentId: 2 }])).toThrow(/changes nothing/);
			expect(() => parseRoomNaming([{ segmentId: 2, name: "" }])).toThrow(/empty name/);
			expect(() => parseRoomNaming([{ segmentId: 2, name: "x".repeat(31) }])).toThrow(/up to 30 characters/);
			expect(() => parseRoomNaming([{ segmentId: 2, tag: 99 }])).toThrow(/not a room type/);
			expect(() => parseRoomNaming([])).toThrow(/empty list/);
			expect(() => parseRoomNaming(["Kitchen"])).toThrow(/must be an object/);
		});

		it("accepts a single object as well as a list", () => {
			expect(parseRoomNaming({ segmentId: 2, name: "Kitchen" })).toEqual([{ segmentId: 2, name: "Kitchen" }]);
		});

		it("knows the eleven selectable room tags plus 'other'", () => {
			expect(ROOM_TAGS[14]).toBe("kitchen");
			expect(ROOM_TAGS[12]).toBe("other");
			// 0, 4, 5 and 11 are not assigned in the plugin.
			for (const gap of [0, 4, 5, 11]) expect(ROOM_TAGS[gap]).toBeUndefined();
		});

		it("reads both shapes of get_room_mapping", () => {
			const legacy = parseRoomMapping([[16, "abc", 14], [17, "def"]], 0);
			expect(legacy.get(16)).toEqual({ iotRoomId: "abc", tag: 14 });
			expect(legacy.get(17)).toEqual({ iotRoomId: "def" });

			const modern = parseRoomMapping([{ map_info: [{ mapFlag: 1, rooms: [{ id: 20, iot_name_id: "xyz", tag: 6 }] }] }], 1);
			expect(modern.get(20)).toEqual({ iotRoomId: "xyz", tag: 6 });
			// A different floor's rooms are not mixed in.
			expect(parseRoomMapping([{ map_info: [{ mapFlag: 1, rooms: [{ id: 20 }] }, { mapFlag: 2, rooms: [{ id: 30 }] }] }], 2).has(30)).toBe(true);
		});

		it("reads bit 67 out of the hex feature string", () => {
			expect(hasFeatureStrBit((1n << 67n).toString(16), MATTER_FEATURE_BIT)).toBe(true);
			expect(hasFeatureStrBit((1n << 66n).toString(16), MATTER_FEATURE_BIT)).toBe(false);
			expect(hasFeatureStrBit("not hex", MATTER_FEATURE_BIT)).toBe(false);
			expect(hasFeatureStrBit(undefined, MATTER_FEATURE_BIT)).toBe(false);
		});
	});

	describe("carpets (report section 1.7)", () => {
		it("registers the two carpet settings whose payload the report pins down", async () => {
			const commands = (vacuum as any).commands;
			expect(commands.set_carpet_clean_mode.type).toBe("number");
			expect(commands.set_carpet_clean_mode.states).toEqual(CARPET_CLEAN_MODES);
			expect(commands.set_carpet_mode.type).toBe("json");

			await vacuum.createCommandObjects();
			expect(mockAdapter.objects[`Devices.${mockRobot.duid}.commands.set_carpet_clean_mode`].common.write).toBe(true);
			expect(mockAdapter.objects[`Devices.${mockRobot.duid}.commands.set_carpet_mode`].common.write).toBe(true);
		});

		it("knows the fourth mode the adapter's own table was missing", () => {
			expect(CARPET_CLEAN_MODES[3]).toBe("Dynamic Lift");
		});

		it("sends {carpet_clean_mode} and nothing else", async () => {
			const sent = await runCommand("set_carpet_clean_mode", 2);
			expect(sent.method).toBe("set_carpet_clean_mode");
			expect(sent.params).toEqual({ carpet_clean_mode: 2 });
		});

		it("is not wrapped in the retry envelope, because it is not one of the 13 methods", async () => {
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, { val: RPC_RETRY_FEATURE_BIT, ack: true });
			const sent = await runCommand("set_carpet_clean_mode", 1);
			expect(sent.params).toEqual({ carpet_clean_mode: 1 });
		});

		it("rejects a mode the plugin does not list", () => {
			expect(() => parseCarpetCleanMode(4)).toThrow(/expects one of/);
			expect(() => parseCarpetCleanMode("Avoid")).toThrow(/expects one of/);
		});

		it("accepts the object form as well as the bare number", () => {
			expect(parseCarpetCleanMode({ carpet_clean_mode: 3 })).toEqual({ carpet_clean_mode: 3 });
			expect(parseCarpetCleanMode("2")).toEqual({ carpet_clean_mode: 2 });
		});

		it("wraps the carpet boost settings in the one-element array the robot expects", async () => {
			const settings = { enable: 1, stall_time: 10, current_low: 400, current_high: 500, current_integral: 450 };
			const sent = await runCommand("set_carpet_mode", settings);
			expect(sent.params).toEqual([settings]);
		});

		it("takes an already wrapped array unchanged", () => {
			expect(parseCarpetMode([{ enable: 0 }])).toEqual([{ enable: 0 }]);
		});

		it("rejects anything that is not a settings object", () => {
			expect(() => parseCarpetMode("on")).toThrow(/settings object/);
			expect(() => parseCarpetMode([{ enable: 1 }, { enable: 0 }])).toThrow(/exactly one/);
		});
	});

	describe("scope", () => {
		it("claims only the commands it registers", () => {
			const service = new MapEditService(deps, mockRobot.duid);
			for (const method of MapEditService.COMMANDS) {
				expect(service.handles(method)).toBe(true);
			}
			expect(service.handles("app_start")).toBe(false);
		});

		it("offers no raw save_map, because a raw save_map would delete the user's zones", () => {
			const service = new MapEditService(deps, mockRobot.duid);
			// The zone editing goes through add_/remove_ operations that read, change and write back
			// the complete set (report section 2.1); a pass-through state would let a caller send a
			// single zone and wipe all the others.
			expect(service.handles("save_map")).toBe(false);
			expect(MapEditService.COMMANDS).not.toContain("save_map");
		});

		it("leaves the carpet zone calls alone, whose payload the report could not pin down", () => {
			const service = new MapEditService(deps, mockRobot.duid);
			// `set_carpet_area` and `set_ignore_carpet_zone` are "teilweise belegt": zone_data was
			// never traced to the single value, so whether they replace or extend is unknown.
			for (const method of ["set_carpet_area", "set_ignore_carpet_zone"]) {
				expect(service.handles(method)).toBe(false);
			}
		});
	});
});
