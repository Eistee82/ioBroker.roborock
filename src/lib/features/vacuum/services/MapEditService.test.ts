import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { hasFeatureStrBit } from "../../../featureStr";
import { MockAdapter } from "../../../mock/MockAdapter";
import { MockRobot } from "../../../mock/MockRobot";
import { Feature } from "../../features.enum";
import { V1VacuumFeatures } from "../v1VacuumFeatures";
import {
	applyRetryEnvelope,
	buildSaveMapPayload,
	CARPET_CLEAN_MODES,
	extractMapBuffer,
	FURNITURE_TYPES,
	MAP_RECORD_TYPES,
	MapEditService,
	MATTER_FEATURE_BIT,
	MAX_BLOCK_NO,
	MAX_COUNT_WALL_OR_FBZ,
	parseCarpetCleanMode,
	parseCarpetMode,
	parseCleanSequence,
	parseCleanSequenceResponse,
	parseFurnitures,
	parseMergeSegment,
	parseRoomMapping,
	parseRoomNaming,
	parseSplitSegment,
	parseZoneInput,
	parseZoneRemoval,
	readMaxMultiMap,
	readOverlaysFromMap,
	readRetryId,
	ROOM_TAGS,
	RPC_RETRY_FEATURE_BIT,
	type MapOverlays
} from "./MapEditService";

/**
 * Encodes one list-shaped V1 map block.
 * @param type Block type id.
 * @param entries The records, each already the right number of values.
 * @param valuesPerEntry How many uint16 one record holds.
 * @returns The encoded block.
 */
function encodeZoneBlock(type: number, entries: number[][], valuesPerEntry: number): Buffer {
	const headerLength = 12;
	const buffer = Buffer.alloc(headerLength + entries.length * valuesPerEntry * 2);
	buffer.writeUInt16LE(type, 0);
	buffer.writeUInt16LE(headerLength, 2);
	buffer.writeUInt32LE(entries.length * valuesPerEntry * 2, 4);
	buffer.writeUInt32LE(entries.length, 8);

	let position = headerLength;
	for (const entry of entries) {
		for (const value of entry) {
			buffer.writeUInt16LE(value, position);
			position += 2;
		}
	}
	return buffer;
}

/**
 * Encodes the smallest image block the parser accepts, so the map counts as a map.
 * @returns The encoded block.
 */
function encodeImageBlock(): Buffer {
	const headerLength = 24;
	const width = 2;
	const height = 2;
	const buffer = Buffer.alloc(headerLength + width * height);
	buffer.writeUInt16LE(2, 0);
	buffer.writeUInt16LE(headerLength, 2);
	buffer.writeUInt32LE(width * height, 4);
	buffer.writeInt32LE(0, 8);       // top
	buffer.writeInt32LE(0, 12);      // left
	buffer.writeInt32LE(height, 16);
	buffer.writeInt32LE(width, 20);
	return buffer;
}

/**
 * Builds a V1 map the real `MapParser` accepts, carrying the given walls and zones.
 *
 * The zone commands read the robot's own map before every write, so the test has to hand them a
 * real one - a stubbed reader would prove nothing about the read-change-write cycle.
 * @param overlays Walls and zones the map is to carry.
 * @returns The raw map as `get_map_v1` returns it.
 */
function buildMapFixture(overlays: MapOverlays): Buffer {
	const blocks = [encodeImageBlock()];
	if (overlays.wall.length > 0) blocks.push(encodeZoneBlock(10, overlays.wall, 4));
	if (overlays.no_go.length > 0) blocks.push(encodeZoneBlock(9, overlays.no_go, 8));
	if (overlays.no_mop.length > 0) blocks.push(encodeZoneBlock(12, overlays.no_mop, 8));
	const body = Buffer.concat(blocks);

	const header = Buffer.alloc(0x14);
	header.writeUInt8(0x72, 0);
	header.writeUInt8(0x72, 1);
	header.writeUInt16LE(0x14, 2);
	header.writeUInt32LE(0x14 + body.length, 4);
	header.writeUInt16LE(1, 8);
	header.writeUInt16LE(0, 10);
	header.writeUInt32LE(0, 12);
	header.writeUInt32LE(0, 16);

	const withoutHash = Buffer.concat([header, body]);
	return Buffer.concat([withoutHash, crypto.createHash("sha1").update(withoutHash).digest()]);
}

/**
 * Turns a `save_map` payload back into a set of walls and zones the way the firmware does:
 * whatever is not in the payload is gone.
 * @param payload The records that were sent.
 * @returns The set the robot holds afterwards.
 */
function applySaveMap(payload: number[][]): MapOverlays {
	const result: MapOverlays = { wall: [], no_go: [], no_mop: [] };
	for (const record of payload) {
		if (record[0] === MAP_RECORD_TYPES.wall) result.wall.push(record.slice(1));
		else if (record[0] === MAP_RECORD_TYPES.no_go) result.no_go.push(record.slice(1));
		else if (record[0] === MAP_RECORD_TYPES.no_mop) result.no_mop.push(record.slice(1));
	}
	return result;
}

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
				getRobotModel: () => mockRobot.model,
				// The zone commands run the real V1 map parser, which asks for the cloud room list.
				isSharedDevice: () => false,
				getMatchedRoomIDs: () => []
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

	describe("zones and walls via save_map (report sections 1.6 and 2.1)", () => {
		/** What the robot currently holds; `get_map_v1` is built from this and `save_map` replaces it. */
		let onRobot: MapOverlays;
		/** Set when the robot was asked to save, so a test can prove nothing was written. */
		let saved: number[][] | null;

		/** A no-go zone and a no-mop zone the user already had, plus a wall. */
		const existingNoGo = [1000, 2000, 3000, 2000, 3000, 1000, 1000, 1000];
		const existingNoMop = [5000, 6000, 7000, 6000, 7000, 5000, 5000, 5000];
		const existingWall = [100, 200, 300, 400];

		/**
		 * Puts the robot behind a transport that answers `get_map_v1` with a real V1 map and applies
		 * `save_map` the way the firmware does - by keeping only what the payload carried.
		 * @param maxMultiMap How many map slots the robot reports.
		 */
		function withMap(maxMultiMap = 1): void {
			mockRobot.multiMaps.max_multi_map = maxMultiMap;
			deps.requestsHandler.sendRequest = async (duid: string, method: string, params: any) => {
				if (duid !== mockRobot.duid) return [];
				if (method === "get_map_v1") return buildMapFixture(onRobot);
				if (method === "save_map") {
					saved = MockRobot.unwrapRetryEnvelope(params);
					onRobot = applySaveMap(saved as number[][]);
					return ["ok"];
				}
				return mockRobot.handleRequest(method, params);
			};
		}

		beforeEach(() => {
			onRobot = { wall: [existingWall], no_go: [existingNoGo], no_mop: [existingNoMop] };
			saved = null;
		});

		it("registers add and remove states, and no raw save_map state", async () => {
			const commands = (vacuum as any).commands;
			for (const name of ["add_no_go_zone", "add_no_mop_zone", "add_virtual_wall", "remove_map_zone"]) {
				expect(commands[name]?.type).toBe("json");
			}
			expect(commands).not.toHaveProperty("save_map");

			await vacuum.createCommandObjects();
			const obj = mockAdapter.objects[`Devices.${mockRobot.duid}.commands.add_no_go_zone`];
			expect(obj.common.write).toBe(true);
			// The state says out loud that a change rewrites everything.
			expect(String(obj.common.desc)).toMatch(/every change rewrites all of them|jede Änderung/i);
		});

		// --- The assurance this whole package exists for ---------------------------------------

		it("keeps every existing wall and zone when one is added", async () => {
			withMap();

			await runCommand("add_no_go_zone", [8000, 9000, 9000, 8000]);

			// save_map has no operation code and no zone id: whatever is missing from the payload is
			// deleted. The adapter therefore reads the robot's own map first and sends it back whole.
			expect(saved).not.toBeNull();
			expect(onRobot.no_go).toHaveLength(2);
			expect(onRobot.no_go).toContainEqual(existingNoGo);
			expect(onRobot.no_go).toContainEqual([8000, 9000, 9000, 9000, 9000, 8000, 8000, 8000]);
			// The other kinds were never mentioned by the user and are still there.
			expect(onRobot.wall).toEqual([existingWall]);
			expect(onRobot.no_mop).toEqual([existingNoMop]);
		});

		it("keeps the other zones when one is removed", async () => {
			withMap();
			onRobot.no_go = [existingNoGo, [4000, 4000, 5000, 4000, 5000, 3000, 4000, 3000]];

			await runCommand("remove_map_zone", { kind: "no_go", index: 0 });

			expect(onRobot.no_go).toEqual([[4000, 4000, 5000, 4000, 5000, 3000, 4000, 3000]]);
			expect(onRobot.wall).toEqual([existingWall]);
			expect(onRobot.no_mop).toEqual([existingNoMop]);
		});

		/**
		 * The retry envelope reaches the zone commands too.
		 *
		 * Firmware bit 26 is **set** on the test device (`0008004056C8FFFE`, read-only measurement
		 * in `_appanalysis/19-geraetefaehigkeiten.md`), so `save_map` has to travel as
		 * `{data, need_retry: 1}` there. A path that built its payload without going through
		 * `wrap()` would send it bare, and the robot would most likely drop it without a word.
		 *
		 * The bit is read from the robot's own status rather than assumed, which is what keeps a
		 * device that does not have it working: it gets the bare payload, as the second case pins.
		 */
		it("wraps a zone edit in the retry envelope on a robot whose bit 26 is set", async () => {
			withMap();
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, {
				val: RPC_RETRY_FEATURE_BIT,
				ack: true
			});

			const sent = await runCommand("add_no_go_zone", [8000, 9000, 9000, 8000]);

			expect(sent.method).toBe("save_map");
			expect(sent.params.need_retry).toBe(1);
			expect(Array.isArray(sent.params.data)).toBe(true);
		});

		it("sends a zone edit bare on a robot without that bit", async () => {
			withMap();
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, {
				val: 0x1000,
				ack: true
			});

			const sent = await runCommand("add_no_go_zone", [8000, 9000, 9000, 8000]);

			expect(Array.isArray(sent.params)).toBe(true);
			expect(sent.params.need_retry).toBeUndefined();
		});

		// --- Naming a zone by an index that may have moved -------------------------------------

		/**
		 * The safeguard against a shifted index.
		 *
		 * An index only means something next to the list it counts into, and that list lives on the
		 * robot: the phone app adds a no-go zone, every later index shifts by one, and a removal
		 * that trusts its number deletes the neighbour. Silently - the robot answers `["ok"]` either
		 * way. There is no undo, and `get_recover_maps` answers `unknown_method` on the test device,
		 * so no robot-side backup is known to exist.
		 */
		it("refuses a removal whose index no longer holds the zone the caller meant", async () => {
			withMap();
			onRobot.no_go = [existingNoGo, [4000, 4000, 5000, 4000, 5000, 3000, 4000, 3000]];

			// The caller read the list when its own zone was at index 0; by now something else is.
			await expect(
				runCommand("remove_map_zone", { kind: "no_go", index: 0, zone: [9, 9, 9, 9, 9, 9, 9, 9] })
			).rejects.toThrow(/has changed since that list was read/);

			// And nothing was written at all - not a partial set, not a set with one zone gone.
			expect(saved).toBeNull();
			expect(onRobot.no_go).toHaveLength(2);
		});

		it("removes it when the coordinates do match", async () => {
			withMap();
			onRobot.no_go = [existingNoGo, [4000, 4000, 5000, 4000, 5000, 3000, 4000, 3000]];

			await runCommand("remove_map_zone", { kind: "no_go", index: 0, zone: existingNoGo });

			expect(onRobot.no_go).toEqual([[4000, 4000, 5000, 4000, 5000, 3000, 4000, 3000]]);
		});

		it("still removes by index alone, so every caller written before this keeps working", async () => {
			withMap();
			onRobot.no_go = [existingNoGo];

			await runCommand("remove_map_zone", { kind: "no_go", index: 0 });

			expect(onRobot.no_go).toEqual([]);
		});

		// --- Moving one in a single cycle -------------------------------------------------------

		it("moves a zone without the map ever holding one fewer", async () => {
			withMap();
			const moved = [1500, 2500, 3500, 2500, 3500, 1500, 1500, 1500];

			await runCommand("update_map_zone", { kind: "no_go", index: 0, zone: moved });

			// One save_map, and the count is unchanged: there is no moment in between.
			expect(onRobot.no_go).toEqual([moved]);
			expect(onRobot.wall).toEqual([existingWall]);
			expect(onRobot.no_mop).toEqual([existingNoMop]);
		});

		it("keeps a moved zone at its own position in the list", async () => {
			// "Remove, then add" would move it to the end, and every index after it would shift -
			// which is exactly what the safeguard above then rejects on the next request.
			withMap();
			const second = [4000, 4000, 5000, 4000, 5000, 3000, 4000, 3000];
			onRobot.no_go = [existingNoGo, second];
			const moved = [1500, 2500, 3500, 2500, 3500, 1500, 1500, 1500];

			await runCommand("update_map_zone", { kind: "no_go", index: 0, zone: moved });

			expect(onRobot.no_go).toEqual([moved, second]);
		});

		it("moves a zone on a map that is already at the limit", async () => {
			// The count does not change, so the ten-per-kind limit must not apply. A map full of
			// no-go zones has to stay editable.
			withMap();
			onRobot.no_go = Array.from({ length: MAX_COUNT_WALL_OR_FBZ }, (_, i) => [i, 0, i + 1, 0, i + 1, 1, i, 1]);
			const moved = [900, 900, 1000, 900, 1000, 800, 900, 800];

			await runCommand("update_map_zone", { kind: "no_go", index: 3, zone: moved });

			expect(onRobot.no_go).toHaveLength(MAX_COUNT_WALL_OR_FBZ);
			expect(onRobot.no_go[3]).toEqual(moved);
		});

		it("turns a zone, which is the shape only four corners can carry", async () => {
			withMap();
			const turned = [1000, 2000, 2910, 2580, 3490, 1670, 1580, 1090];

			await runCommand("update_map_zone", { kind: "no_go", index: 0, zone: turned });

			expect(onRobot.no_go).toEqual([turned]);
		});

		it("moves a wall by its two end points", async () => {
			withMap();

			await runCommand("update_map_zone", { kind: "wall", index: 0, zone: [500, 600, 700, 800] });

			expect(onRobot.wall).toEqual([[500, 600, 700, 800]]);
		});

		it("refuses a move whose index no longer holds the zone the caller meant", async () => {
			withMap();

			await expect(
				runCommand("update_map_zone", {
					kind: "no_go",
					index: 0,
					zone: [1, 1, 2, 1, 2, 0, 1, 0],
					from: [9, 9, 9, 9, 9, 9, 9, 9]
				})
			).rejects.toThrow(/has changed since that list was read/);

			expect(saved).toBeNull();
			expect(onRobot.no_go).toEqual([existingNoGo]);
		});

		it("refuses a move that names a zone the map does not have", async () => {
			withMap();

			await expect(
				runCommand("update_map_zone", { kind: "no_go", index: 5, zone: [1, 1, 2, 1, 2, 0, 1, 0] })
			).rejects.toThrow(/numbered 0 to 0/);
			expect(saved).toBeNull();
		});

		it("validates the new coordinates exactly as an add would", async () => {
			withMap();

			// Same parser, so a shape that could not be added cannot be moved into either.
			await expect(runCommand("update_map_zone", { kind: "no_go", index: 0, zone: [1, 2, 3] })).rejects.toThrow(
				/eight numbers .*or four numbers/
			);
			await expect(
				runCommand("update_map_zone", { kind: "wall", index: 0, zone: [5, 5, 5, 5] })
			).rejects.toThrow(/two different end points/);
			expect(saved).toBeNull();
		});

		it("sends the records in the walls-then-zones order the app uses", async () => {
			withMap();

			await runCommand("add_no_mop_zone", [0, 0, 100, 100]);

			expect(saved!.map((record) => record[0])).toEqual([
				MAP_RECORD_TYPES.wall,
				MAP_RECORD_TYPES.no_go,
				MAP_RECORD_TYPES.no_mop,
				MAP_RECORD_TYPES.no_mop
			]);
		});

		// --- Refusing rather than losing data ---------------------------------------------------

		/**
		 * Lets `get_map_v1` fail or answer with something unusable, keeping the `save_map` recorder
		 * in place so a test can show that nothing was written.
		 * @param answer What the robot answers, or what it throws.
		 */
		function withBrokenMap(answer: () => unknown): void {
			withMap();
			const transport = deps.requestsHandler.sendRequest;
			deps.requestsHandler.sendRequest = async (duid: string, method: string, params: any) =>
				method === "get_map_v1" ? answer() : transport(duid, method, params);
		}

		it("writes nothing when the map cannot be fetched", async () => {
			withBrokenMap(() => {
				throw new Error("robot offline");
			});

			await expect(runCommand("add_no_go_zone", [0, 0, 100, 100])).rejects.toThrow(/Could not fetch the robot's map/);
			expect(saved).toBeNull();
		});

		it("writes nothing when the answer is not a map", async () => {
			withBrokenMap(() => ["ok"]);

			await expect(runCommand("add_no_go_zone", [0, 0, 100, 100])).rejects.toThrow(/did not answer get_map_v1 with a map/);
			expect(saved).toBeNull();
		});

		it("writes nothing when the map is unreadable, instead of reading it as an empty map", async () => {
			withBrokenMap(() => Buffer.from("rr not really a map at all, but long enough"));

			await expect(runCommand("add_no_go_zone", [0, 0, 100, 100])).rejects.toThrow(/could not be parsed/);
			expect(saved).toBeNull();
		});

		it("recognises both shapes get_map_v1 answers in", () => {
			const fixture = buildMapFixture(onRobot);
			expect(extractMapBuffer(fixture)).toBe(fixture);
			expect(extractMapBuffer({ data: fixture, version: "1.0" })).toBe(fixture);
			expect(extractMapBuffer(["ok"])).toBeNull();
		});

		it("writes nothing when the map carries an overlay it cannot rebuild", () => {
			// Record type 3 (the Garnet generation's cleaning-free zone) has no documented map block,
			// so a map holding one is left alone rather than stripped of it.
			expect(() => readOverlaysFromMap({ IMAGE: {}, CLF_FORBIDDEN_ZONES: [[1, 2, 3, 4, 5, 6, 7, 8]] }))
				.toThrow(/CLF_FORBIDDEN_ZONES/);
			expect(() => readOverlaysFromMap({ IMAGE: {}, CL_FORBIDDEN_ZONES: [1, 2, 3, 4, 5, 6, 7, 8] }))
				.toThrow(/CL_FORBIDDEN_ZONES/);
		});

		it("writes nothing when a zone in the map has an unexpected shape", () => {
			expect(() => readOverlaysFromMap({ IMAGE: {}, FORBIDDEN_ZONES: [[1, 2, 3, 4]] })).toThrow(/instead of 8/);
			expect(() => readOverlaysFromMap({ IMAGE: {}, VIRTUAL_WALLS: "none" })).toThrow(/not a list/);
		});

		it("writes nothing when the robot cannot say how many maps it has", async () => {
			withMap();
			const transport = deps.requestsHandler.sendRequest;
			deps.requestsHandler.sendRequest = async (duid: string, method: string, params: any) => {
				if (method === "get_multi_maps_list") return ["ok"];
				return transport(duid, method, params);
			};

			await expect(runCommand("add_no_go_zone", [0, 0, 100, 100])).rejects.toThrow(/how many maps/);
			expect(saved).toBeNull();
		});

		it("writes nothing on a multi-map robot before the active map is known", async () => {
			withMap(3);
			expect(vacuum.getCurrentMapIndex()).toBe(-1);

			await expect(runCommand("add_no_go_zone", [0, 0, 100, 100])).rejects.toThrow(/active map is not known/);
			expect(saved).toBeNull();
		});

		it("names the map slot on a multi-map robot and leaves it out on a single-map one", async () => {
			withMap(3);
			(vacuum as any).mapService.updateCurrentMapIndex(12); // map_status 12 -> slot 3

			await runCommand("add_no_go_zone", [0, 0, 100, 100]);
			expect(saved![saved!.length - 1]).toEqual([100, 3]);

			withMap(1);
			saved = null;
			await runCommand("add_no_go_zone", [0, 0, 200, 200]);
			expect(saved!.some((record) => record[0] === 100)).toBe(false);
		});

		it("refuses the eleventh zone of a kind, the app's own limit", async () => {
			withMap();
			onRobot.no_go = Array.from({ length: MAX_COUNT_WALL_OR_FBZ }, (_, i) => [i, 0, i + 1, 0, i + 1, 1, i, 1]);

			await expect(runCommand("add_no_go_zone", [0, 0, 100, 100])).rejects.toThrow(/limit is 10 per kind/);
			expect(saved).toBeNull();
			// Ten per kind, not ten in total: a wall still goes through.
			await runCommand("add_virtual_wall", [0, 0, 500, 0]);
			expect(onRobot.no_go).toHaveLength(MAX_COUNT_WALL_OR_FBZ);
			expect(onRobot.wall).toHaveLength(2);
		});

		it("refuses to remove an index that is not there and says how many there are", async () => {
			withMap();
			await expect(runCommand("remove_map_zone", { kind: "no_mop", index: 4 })).rejects.toThrow(/numbered 0 to 0/);
			expect(saved).toBeNull();
		});

		it("clears every wall and zone on request", async () => {
			withMap();
			await runCommand("remove_map_zone", "all");
			expect(onRobot).toEqual({ wall: [], no_go: [], no_mop: [] });
			expect(saved).toEqual([]);
		});

		it("publishes what is on the map, so an index means something", async () => {
			withMap();
			await runCommand("add_virtual_wall", [10, 20, 30, 40]);

			const state = await mockAdapter.getStateAsync(`Devices.${mockRobot.duid}.mapEdit.zones`);
			expect(JSON.parse(String(state.val))).toEqual({
				wall: [existingWall, [10, 20, 30, 40]],
				no_go: [existingNoGo],
				no_mop: [existingNoMop]
			});
		});

		it("publishes the current set even when the edit itself is refused", async () => {
			withMap();
			onRobot.no_go = Array.from({ length: MAX_COUNT_WALL_OR_FBZ }, (_, i) => [i, 0, i + 1, 0, i + 1, 1, i, 1]);

			await expect(runCommand("add_no_go_zone", [0, 0, 100, 100])).rejects.toThrow(/limit is 10 per kind/);

			// The list is how a user works out which index to remove, so a refusal has to show it.
			const state = await mockAdapter.getStateAsync(`Devices.${mockRobot.duid}.mapEdit.zones`);
			expect(JSON.parse(String(state.val)).no_go).toHaveLength(MAX_COUNT_WALL_OR_FBZ);
		});

		it("wraps the payload once the robot reports feature bit 26", async () => {
			withMap();
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, { val: RPC_RETRY_FEATURE_BIT, ack: true });

			const sent = await runCommand("add_no_go_zone", [0, 0, 100, 100]);
			expect(sent.method).toBe("save_map");
			expect(sent.params.need_retry).toBe(1);
			expect(Array.isArray(sent.params.data)).toBe(true);
		});

		// --- Reading the user's input -----------------------------------------------------------

		it("expands two opposite corners into the four the app sends", () => {
			// Report section 1.6: x0,y0 = (x, y1+h); x1,y1 = (x+w, y1+h); x2,y2 = (x+w, y1); x3,y3 = (x, y1).
			expect(parseZoneInput("no_go", [1000, 500, 2000, 1500])).toEqual([1000, 1500, 2000, 1500, 2000, 500, 1000, 500]);
			// The order the two corners are given in makes no difference.
			expect(parseZoneInput("no_go", [2000, 1500, 1000, 500])).toEqual([1000, 1500, 2000, 1500, 2000, 500, 1000, 500]);
		});

		it("takes four explicit corners unchanged, which a rotated zone needs", () => {
			const rotated = [0, 100, 100, 200, 200, 100, 100, 0];
			expect(parseZoneInput("no_mop", rotated)).toEqual(rotated);
		});

		it("rejects a zone that is not a zone", () => {
			expect(() => parseZoneInput("no_go", "kitchen")).toThrow(/four corners/);
			expect(() => parseZoneInput("no_go", [1, 2, 3])).toThrow(/eight numbers/);
			expect(() => parseZoneInput("no_go", [0, 0, 0, 500])).toThrow(/describes a line/);
			expect(() => parseZoneInput("no_go", [0, 0, "x", 500])).toThrow(/not a number/);
			expect(() => parseZoneInput("wall", [1, 2, 3, 4, 5, 6, 7, 8])).toThrow(/four numbers/);
			expect(() => parseZoneInput("wall", [5, 5, 5, 5])).toThrow(/two different end points/);
		});

		it("reads the cleaning order the robot reports, through both answer shapes", () => {
			// The transport hands V1 answers back bare, wrapped in `{data}`, or nested once. All
			// three have to yield the same order; the nesting must not swallow a real first element.
			expect(parseCleanSequenceResponse([16, 17, 18])).toEqual([16, 17, 18]);
			expect(parseCleanSequenceResponse({ data: [16, 17] })).toEqual([16, 17]);
			expect(parseCleanSequenceResponse([[16, 17]])).toEqual([16, 17]);
			expect(parseCleanSequenceResponse([16])).toEqual([16]);
		});

		it("reads an empty order as an empty order, because that is a real value", () => {
			// Empty means "the robot picks its own order" - not "unknown".
			expect(parseCleanSequenceResponse([])).toEqual([]);
			expect(parseCleanSequenceResponse({ data: [] })).toEqual([]);
		});

		it("answers null for anything it did not understand, rather than inventing an empty order", () => {
			// An invented empty order would read as "no order set" and could talk somebody into
			// overwriting one that exists.
			expect(parseCleanSequenceResponse(null)).toBeNull();
			expect(parseCleanSequenceResponse("unknown_method")).toBeNull();
			expect(parseCleanSequenceResponse({ result: "unknown_method" })).toBeNull();
			expect(parseCleanSequenceResponse([16, "x"])).toBeNull();
			expect(parseCleanSequenceResponse([16, -1])).toBeNull();
		});

		/**
		 * The cleaning order after a split or a merge.
		 *
		 * An order made of old segment numbers is worse than none: the renumbering gives those ids
		 * to different rooms, so the list stays perfectly well-formed while naming the wrong rooms,
		 * and nothing on screen suggests anything is wrong. Clearing it puts the robot back into the
		 * state it is in before anybody sets an order.
		 */
		it("clears the cleaning order after a merge, and publishes the empty one", async () => {
			mockRobot.cleanSequence = [16, 17, 18];

			await vacuum.getCommandParams("set_clean_sequence", [16, 17, 18]);
			await (vacuum as any).mapEditService.resolveDeferredResult("merge_segment", ["ok"]);

			expect(mockRobot.cleanSequence).toEqual([]);
			const published = await mockAdapter.getStateAsync(`Devices.${mockRobot.duid}.mapEdit.cleanSequence`);
			expect(JSON.parse(String(published?.val))).toEqual([]);
		});

		it("does not write an order the robot does not have", async () => {
			// A robot without an order must not be sent a clear for nothing.
			mockRobot.cleanSequence = [];
			let cleared = 0;
			const original = mockRobot.handleRequest.bind(mockRobot);
			mockRobot.handleRequest = (method: string, params: unknown) => {
				if (method === "set_clean_sequence") cleared++;
				return original(method, params);
			};

			await (vacuum as any).mapEditService.resolveDeferredResult("split_segment", ["ok"]);
			expect(cleared).toBe(0);
		});

		it("leaves the order alone when it cannot be read", async () => {
			// Sending a clear on a guess would throw away an order that may well still be valid.
			mockRobot.cleanSequence = [16, 17];
			const original = mockRobot.handleRequest.bind(mockRobot);
			mockRobot.handleRequest = (method: string, params: unknown) => {
				if (method === "get_clean_sequence") return { result: "unknown_method" };
				return original(method, params);
			};

			await (vacuum as any).mapEditService.resolveDeferredResult("merge_segment", ["ok"]);
			expect(mockRobot.cleanSequence).toEqual([16, 17]);
		});

		it("re-reads the order the robot really holds after one was set", async () => {
			// The robot is the authority: it may reject or reorder what was sent.
			await runCommand("set_clean_sequence", [16, 17]);

			const published = await mockAdapter.getStateAsync(`Devices.${mockRobot.duid}.mapEdit.cleanSequence`);
			expect(JSON.parse(String(published?.val))).toEqual([16, 17]);
		});

		it("reads a removal request", () => {
			expect(parseZoneRemoval({ kind: "no_mop", index: 2 })).toEqual({ kind: "no_mop", index: 2, expected: null });
			expect(parseZoneRemoval("all")).toEqual({ kind: "all", index: null, expected: null });
			expect(parseZoneRemoval({ kind: "all" })).toEqual({ kind: "all", index: null, expected: null });
			expect(() => parseZoneRemoval({ kind: "carpet", index: 0 })).toThrow(/remove_map_zone expects/);
			expect(() => parseZoneRemoval({ kind: "no_go" })).toThrow(/counted from 0/);
			expect(() => parseZoneRemoval({ kind: "no_go", index: -1 })).toThrow(/counted from 0/);
		});

		it("reads the coordinates a removal expects to find, and insists they are well formed", () => {
			// A caller that sends `zone` means to have it checked. Ignoring a malformed one would
			// switch the safeguard off exactly where somebody thought they had switched it on.
			expect(parseZoneRemoval({ kind: "no_go", index: 1, zone: [1, 2, 3, 4, 5, 6, 7, 8] })).toEqual({
				kind: "no_go",
				index: 1,
				expected: [1, 2, 3, 4, 5, 6, 7, 8]
			});
			expect(parseZoneRemoval({ kind: "wall", index: 0, zone: [1, 2, 3, 4] }).expected).toEqual([1, 2, 3, 4]);
			// A wall has four numbers, a zone eight; the wrong count is a mistake, not a hint.
			expect(() => parseZoneRemoval({ kind: "no_go", index: 0, zone: [1, 2, 3, 4] })).toThrow(/needs 8 numbers/);
			expect(() => parseZoneRemoval({ kind: "wall", index: 0, zone: [1, 2, "x", 4] })).toThrow(/not a number/);
		});

		it("builds the payload the app builds", () => {
			const overlays: MapOverlays = { wall: [[1, 2, 3, 4]], no_go: [[1, 2, 3, 4, 5, 6, 7, 8]], no_mop: [] };
			expect(buildSaveMapPayload(overlays, null)).toEqual([[1, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5, 6, 7, 8]]);
			expect(buildSaveMapPayload(overlays, 2)).toContainEqual([100, 2]);
			// [200, 0] is never sent: no caller in the app's own bundle sets it.
			expect(buildSaveMapPayload(overlays, 2).some((record) => record[0] === 200)).toBe(false);
		});

		it("reads the map slot count out of both answer shapes", () => {
			expect(readMaxMultiMap([{ max_multi_map: 4 }])).toBe(4);
			expect(readMaxMultiMap({ data: [{ max_multi_map: 2 }] })).toBe(2);
			expect(readMaxMultiMap(["ok"])).toBeNull();
			expect(readMaxMultiMap(null)).toBeNull();
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

	describe("splitting and merging rooms (report sections 1.3, 1.4 and 2.2)", () => {
		it("registers both states and puts Roborock's own warning on them", async () => {
			const commands = (vacuum as any).commands;
			expect(commands.split_segment.type).toBe("json");
			expect(commands.merge_segment.type).toBe("json");

			await vacuum.createCommandObjects();
			for (const name of MapEditService.SEGMENT_EDIT_COMMANDS) {
				const obj = mockAdapter.objects[`Devices.${mockRobot.duid}.commands.${name}`];
				expect(obj.common.write).toBe(true);
				// map_edit_segment_prompt, the text the app shows before the same operation.
				expect(String(obj.common.desc)).toMatch(/settings and schedules become invalid|Einstellungen und Zeitpläne/i);
			}
		});

		it("sends the five numbers of a split straight through", async () => {
			const sent = await runCommand("split_segment", [3, 1000, 2000, 1000, 5000]);
			expect(sent.method).toBe("split_segment");
			expect(sent.params).toEqual([3, 1000, 2000, 1000, 5000]);
		});

		it("sends the flat list of ids of a merge", async () => {
			const sent = await runCommand("merge_segment", [2, 3]);
			expect(sent.method).toBe("merge_segment");
			expect(sent.params).toEqual([2, 3]);
		});

		it("warns in the log, because the adapter has no screen to warn on", async () => {
			const warnings: string[] = [];
			const original = mockAdapter.rLog.bind(mockAdapter);
			mockAdapter.rLog = (...args: any[]) => {
				if (args[6] === "warn") warnings.push(String(args[5]));
				return original(...(args as Parameters<typeof original>));
			};

			await runCommand("merge_segment", [2, 3]);

			expect(warnings.some((line) => /settings and schedules become invalid/.test(line))).toBe(true);
			expect(warnings.some((line) => /room IDs change/.test(line))).toBe(true);
		});

		it("re-reads the rooms and the map once the robot confirms", async () => {
			await runCommand("split_segment", [3, 0, 0, 0, 1000]);

			// The old segment ids point nowhere after a split (RoomIdDidChanged), so the room states
			// have to be built again from what the robot reports now.
			const after = mockRobot.seen.slice(mockRobot.seen.findIndex((entry) => entry.method === "split_segment"));
			expect(after.map((entry) => entry.method)).toContain("get_room_mapping");
			expect(after.map((entry) => entry.method)).toContain("get_map_v1");
		});

		it("re-reads them only after a deferred call was actually confirmed", async () => {
			mockRobot.deferOnce.add("merge_segment");
			mockRobot.retryPollsNeeded = 1;

			await runCommand("merge_segment", [2, 3]);

			const afterPoll = mockRobot.seen.slice(mockRobot.seen.map((entry) => entry.method).lastIndexOf("retry_request"));
			expect(afterPoll.map((entry) => entry.method)).toContain("get_room_mapping");
		});

		it("refuses a room that is not on the map", async () => {
			await expect(runCommand("split_segment", [99, 0, 0, 0, 1000])).rejects.toThrow(/not on the current map/);
			await expect(runCommand("merge_segment", [2, 99])).rejects.toThrow(/not on the current map/);
		});

		it("refuses when the room list cannot be read, rather than renumber blind", async () => {
			mockRobot.roomMapping = [];
			await expect(runCommand("split_segment", [3, 0, 0, 0, 1000])).rejects.toThrow(/returned none/);
			await expect(runCommand("merge_segment", [2, 3])).rejects.toThrow(/returned none/);
		});

		/**
		 * Publishes a `map.mapData` state holding just the image block the split checks read.
		 * @param rooms Segment ids with the floor-cell count each of them covers.
		 * @param blockNum Segment count of the image block header; defaults to the number of rooms.
		 */
		async function publishMap(rooms: Array<{ id: number; count: number }>, blockNum?: number): Promise<void> {
			const mapData = {
				IMAGE: {
					segments: {
						count: blockNum ?? rooms.length,
						list: rooms.map((room) => ({ id: room.id, name: "", center: [0, 0], count: room.count, bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } })),
					},
				},
			};
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.map.mapData`, { val: JSON.stringify(mapData), ack: true });
		}

		/** A room comfortably above the 2 m² floor: 4000 cells is 10 m². */
		const BIG_ENOUGH = 4000;

		it("refuses a room under the 2 m² the app insists on, and allows one just over it", async () => {
			// 799 cells is 1.9975 m², 801 is 2.0025 - the threshold sits between them. The message
			// has to say "1.998" and not "2.00", or it reads as a broken check rather than a small room.
			await publishMap([{ id: 1, count: 799 }]);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).rejects.toThrow(/covers 1\.998 m² \(799 cells\), and the app refuses to divide anything under 2 m²/);

			await publishMap([{ id: 1, count: 801 }]);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).resolves.toBeDefined();
		});

		it("takes the room count from the image block header rather than from the naming", async () => {
			// A room the user never named is on the map but missing from `get_room_mapping`, so the
			// mapping undercounts. `blockNum` is what the app itself tests.
			mockRobot.roomMapping = [[1, "1", 12]];
			await publishMap([{ id: 1, count: BIG_ENOUGH }], MAX_BLOCK_NO);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).rejects.toThrow(/already holds 32 rooms/);
		});

		it("halves the room limit on a robot that says it has no MaxZoneOpened", async () => {
			// Bit 77 clear, and the robot did say so - a hex string with only bit 0 set.
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info_str`, { val: "1", ack: true });

			mockRobot.roomMapping = Array.from({ length: 16 }, (_, i) => [i + 1, String(i + 1), 12]);
			await publishMap([{ id: 1, count: BIG_ENOUGH }], 16);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).rejects.toThrow(/already holds 16 rooms.*MaxZoneOpened/s);

			await publishMap([{ id: 1, count: BIG_ENOUGH }], 15);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).resolves.toBeDefined();
		});

		it("allows the full 32 on a robot that announces MaxZoneOpened", async () => {
			// Bit 77 set: 1 << 77 in hex.
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info_str`, { val: (1n << 77n).toString(16), ack: true });
			expect(hasFeatureStrBit((1n << 77n).toString(16), 77n)).toBe(true);

			mockRobot.roomMapping = Array.from({ length: 20 }, (_, i) => [i + 1, String(i + 1), 12]);
			await publishMap([{ id: 1, count: BIG_ENOUGH }], 31);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).resolves.toBeDefined();

			await publishMap([{ id: 1, count: BIG_ENOUGH }], MAX_BLOCK_NO);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).rejects.toThrow(/already holds 32 rooms/);
		});

		it("uses the permissive limit when the robot has not reported its feature string at all", async () => {
			// The lesson from the water level that was labelled unsupported because nobody had read
			// the string yet: no state is not the same answer as a clear bit. 20 rooms would be over
			// the strict limit and is allowed here, because nothing says the strict limit applies.
			mockRobot.roomMapping = Array.from({ length: 20 }, (_, i) => [i + 1, String(i + 1), 12]);
			await publishMap([{ id: 1, count: BIG_ENOUGH }], 20);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).resolves.toBeDefined();
		});

		it("falls back to the naming, and skips the area check, when no map has been parsed yet", async () => {
			// B01/Q10 devices have no V1 image block, and a `mapData` from an older adapter version
			// has no `count`. Neither may cost the user the function.
			mockRobot.roomMapping = Array.from({ length: MAX_BLOCK_NO }, (_, i) => [i + 1, String(i + 1), 12]);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).rejects.toThrow(/already holds 32 rooms/);

			mockRobot.roomMapping = Array.from({ length: MAX_BLOCK_NO - 1 }, (_, i) => [i + 1, String(i + 1), 12]);
			await expect(runCommand("split_segment", [1, 0, 0, 0, 1000])).resolves.toBeDefined();
		});

		it("wraps both payloads when the retry bit is set", async () => {
			await mockAdapter.setStateAsync(`Devices.${mockRobot.duid}.deviceStatus.new_feature_info`, { val: RPC_RETRY_FEATURE_BIT, ack: true });

			expect((await runCommand("split_segment", [3, 0, 0, 0, 1000])).params).toEqual({ data: [3, 0, 0, 0, 1000], need_retry: 1 });
			expect((await runCommand("merge_segment", [2, 3])).params).toEqual({ data: [2, 3], need_retry: 1 });
		});

		it("rejects a malformed request instead of sending it", () => {
			expect(() => parseSplitSegment([3, 0, 0])).toThrow(/expects \[segmentId/);
			expect(() => parseSplitSegment([3, 0, 0, 0, "x"])).toThrow(/not a number/);
			expect(() => parseSplitSegment([-1, 0, 0, 0, 1000])).toThrow(/segment id as its first value/);
			expect(() => parseSplitSegment([3, 5, 5, 5, 5])).toThrow(/two different end points/);

			expect(() => parseMergeSegment([16])).toThrow(/at least 2 rooms/);
			expect(() => parseMergeSegment([16, 16])).toThrow(/same room twice/);
			expect(() => parseMergeSegment("16,17")).toThrow(/JSON array/);
			expect(() => parseMergeSegment([16, -1])).toThrow(/not a segment id/);
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

		it("leaves the carpet zone calls alone, because their set cannot be read back in full", () => {
			const service = new MapEditService(deps, mockRobot.duid);
			// Originally held back because `zone_data` had never been traced to the single value, so
			// whether the calls replace or extend was unknown. Both halves are answered now, and the
			// answer is why they stay out:
			//
			//  - They **replace**. `getCarpetZonesParams` feeds them the complete visible set from
			//    `getVisibleCarpetZones` and deletes by filtering one id out of it - the `save_map`
			//    pattern, so sending one zone drops the rest.
			//  - There is **no getter**. The a65 bundle has `get_carpet_clean_mode` and nothing for
			//    the areas, and the only other source, map block `CUSTOM_CARPET`, carries neither
			//    `slopeAngle` nor `carpetId` nor the per-carpet flags. The adapter therefore cannot
			//    rebuild the set it would have to send back.
			for (const method of ["set_carpet_area", "set_ignore_carpet_zone"]) {
				expect(service.handles(method)).toBe(false);
			}
		});
	});
});
