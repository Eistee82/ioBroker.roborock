import { MapDecryptor } from "../../../map/v1/MapDecryptor";
import { MapParser } from "../../../map/v1/MapParser";
import { hasFeatureStrBit } from "../../../featureStr";
import {
	MAP_RECORD_MAP_SLOT,
	MAP_RECORD_TYPES,
	MAX_COUNT_WALL_OR_FBZ,
	parseZoneInput,
	UNREPRODUCIBLE_BLOCKS,
	ZONE_ADD_COMMANDS,
	ZONE_BLOCKS,
	ZONE_LABELS,
	ZONE_LENGTHS,
	ZONE_REMOVE_COMMAND,
} from "../../../../common/mapZoneKinds";
import type { MapZoneKind } from "../../../../common/mapZoneKinds";
import type { CommandSpec, FeatureDependencies } from "../../baseDeviceFeatures";

/**
 * The map editor commands this adapter exposes.
 *
 * Most of them are harmless: they are either differential (they carry an operation code and an id,
 * so the robot only touches what was named) or they set a single value. Two are not, and both are
 * built so that a caller cannot trip over them:
 *
 * * **`save_map` replaces the entire set of zones and walls** - the payload has no operation code,
 *   no zone id and no delete record (report section 2.1). There is therefore no raw `save_map`
 *   command; the adapter offers "add a zone" and "remove a zone" instead, reads the robot's own map
 *   first, lays the change over it and writes the complete set back. If the map cannot be read,
 *   nothing is written.
 * * **`split_segment` and `merge_segment` change the segment ids** (report section 2.2), which
 *   invalidates room-bound modes, the cleaning order and room-bound schedules. Both warn on the
 *   state and in the log, and the room states are re-read afterwards.
 *
 * Payload formats, module and line references come from `_appanalysis/14-editor-methoden.md`
 * (sections 1.2 to 1.9, 2.1 to 2.3) and `lib/protocols/roborock_map_edit.json`, both read out of
 * Roborock's decompiled control plugin.
 */

/**
 * Bit 26 of `new_feature_info`. With the bit set the firmware understands the retry envelope, and
 * the app then wraps the payload of every method in {@link RETRY_METHODS}.
 *
 * Report section 1.2: `isRPCRetrySupported()` is `robotNewFeatures & 0x4000000`.
 */
export const RPC_RETRY_FEATURE_BIT = 0x4000000;

/** Poll interval of `retry_request` in the app (report section 1.2). */
export const RETRY_POLL_INTERVAL_MS = 2000;

/** The app gives up after this many `retry_request` polls (report section 1.2). */
export const RETRY_MAX_ATTEMPTS = 8;

/**
 * The 13 methods the app wraps when the firmware supports the retry envelope.
 *
 * Kept complete on purpose even though this service only sends two of them - the list is the
 * documented one, and a later package that adds more editor methods should not have to rediscover
 * which of them need the envelope.
 */
export const RETRY_METHODS: ReadonlySet<string> = new Set([
	"save_map",
	"merge_segment",
	"split_segment",
	"name_segment",
	"set_customize_clean_mode",
	"load_multi_map",
	"save_as_multi_map",
	"set_clean_sequence",
	"set_lab_status",
	"set_timer",
	"set_ignore_identify_area",
	"set_ignore_carpet_zone",
	"set_server_timer",
]);

/** Payload wrapped for a firmware that supports the retry envelope. */
export interface RetryEnvelope {
	data: unknown;
	need_retry: 1;
}

/**
 * Turns a payload into the shape the firmware expects.
 *
 * Report section 1.2: an object payload gets `need_retry = 1` added, an array payload is wrapped
 * as `{data: <array>, need_retry: 1}`. Without the feature bit the bare parameters are sent.
 * @param params Payload as the method itself defines it.
 * @param retrySupported Whether bit 26 of `new_feature_info` is set.
 * @returns The payload to put on the wire.
 */
export function applyRetryEnvelope(params: unknown, retrySupported: boolean): unknown {
	if (!retrySupported) return params;

	if (Array.isArray(params)) {
		// Plain annotation instead of `satisfies`: the adapter ships TypeScript sources, and
		// js-controller compiles them at startup with the esbuild bundled in its own
		// node_modules. That copy is older than the running toolchain and rejects `satisfies`
		// outright - "Expected ';' but found 'satisfies'" - which takes the whole instance down
		// before it ever connects. Nothing here may use syntax newer than that esbuild knows,
		// however green the local typecheck is.
		const envelope: RetryEnvelope = { data: params, need_retry: 1 };
		return envelope;
	}
	if (params !== null && typeof params === "object") {
		return { ...(params as Record<string, unknown>), need_retry: 1 };
	}
	return params;
}

/**
 * Recognises the "not finished yet" answer described in report section 1.2.
 * @param response Whatever the robot answered.
 * @returns `null` when this is an ordinary result, the retry id when the robot deferred the call,
 * and `undefined` when it deferred without naming an id (`retry_id_invalid`).
 */
export function readRetryId(response: unknown): number | undefined | null {
	// The transport hands results back either bare or inside a `data` envelope.
	let body: unknown = response;
	if (body !== null && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
		body = (body as Record<string, unknown>).data;
	}
	while (Array.isArray(body) && body.length === 1) {
		body = body[0];
	}

	if (body === null || typeof body !== "object") return null;

	const record = body as Record<string, unknown>;
	if (record.result !== "retry") return null;

	const id = typeof record.id === "number" ? record.id : Number(record.id);
	return Number.isFinite(id) ? id : undefined;
}

/**
 * Room type tags (`RoomTagInfo`, report section 3.7). Each tag also carries default suction and
 * water levels in the app; only the identity of the tag is needed here.
 */
export const ROOM_TAGS: Readonly<Record<number, string>> = {
	1: "bedroom",
	2: "masterbedroom",
	3: "geustbedroom",
	6: "livingroom",
	7: "balcony",
	8: "vestibule",
	9: "study",
	10: "entryway",
	12: "other",
	13: "diningroom",
	14: "kitchen",
	15: "toilet",
};

/**
 * Longest room name the app accepts (`map_edit_max_input_length_tip`, "Up to 30 characters").
 */
export const MAX_ROOM_NAME_LENGTH = 30;

/**
 * Bit 67 of `new_feature_info_str` (`NewFeatureStrBit.Matter`). Only robots with this bit are sent
 * `sync_rooms_info`; without it the app does not push names to the robot at all.
 */
export const MATTER_FEATURE_BIT = 67n;

/** One room the user wants renamed or re-tagged. */
export interface RoomNameRequest {
	segmentId: number;
	name?: string;
	tag?: number;
}

/** What the robot currently knows about one segment. */
export interface RoomMappingEntry {
	iotRoomId: string;
	tag?: number;
}

/**
 * Reads a room naming request a user wrote into the command state.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @returns The requested changes.
 * @throws If the value is not a well-formed naming request.
 */
export function parseRoomNaming(raw: unknown): RoomNameRequest[] {
	const entries = Array.isArray(raw) ? raw : [raw];
	if (entries.length === 0) {
		throw new Error("name_segment got an empty list; nothing would change.");
	}

	return entries.map((entry, index) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`name_segment entry ${index} must be an object such as {"segmentId": 16, "name": "Kitchen"}.`);
		}
		const record = entry as Record<string, unknown>;

		const segmentId = Number(record.segmentId ?? record.robotRoomId);
		if (!Number.isInteger(segmentId) || segmentId < 0) {
			throw new Error(`name_segment entry ${index} needs a 'segmentId' (the room's segment id on the map).`);
		}

		const result: RoomNameRequest = { segmentId };

		if (record.name !== undefined && record.name !== null) {
			const name = String(record.name).trim();
			if (name.length === 0) {
				throw new Error(`name_segment entry ${index} has an empty name; leave 'name' out to keep the current one.`);
			}
			if (name.length > MAX_ROOM_NAME_LENGTH) {
				throw new Error(`name_segment entry ${index}: the app allows up to ${MAX_ROOM_NAME_LENGTH} characters, got ${name.length}.`);
			}
			result.name = name;
		}

		if (record.tag !== undefined && record.tag !== null) {
			const tag = Number(record.tag);
			if (!Number.isInteger(tag) || ROOM_TAGS[tag] === undefined) {
				throw new Error(`name_segment entry ${index}: '${String(record.tag)}' is not a room type. Known tags: ${Object.keys(ROOM_TAGS).join(", ")}.`);
			}
			result.tag = tag;
		}

		if (result.name === undefined && result.tag === undefined) {
			throw new Error(`name_segment entry ${index} changes nothing; give a 'name', a 'tag', or both.`);
		}

		return result;
	});
}

/**
 * Reads the segment-to-cloud-room mapping out of a `get_room_mapping` answer.
 *
 * Two shapes are in the wild (see `V1MapService.updateRoomMapping`): the flat legacy list
 * `[[segmentId, iotRoomId, tag?], ...]` and the newer `map_info[].rooms[] = {id, iot_name_id, tag}`.
 * @param raw The robot's answer.
 * @param mapFlag Map whose rooms are wanted, for the `map_info` shape.
 * @returns Segment id to what the robot knows about it.
 */
export function parseRoomMapping(raw: unknown, mapFlag: number): Map<number, RoomMappingEntry> {
	const result = new Map<number, RoomMappingEntry>();

	let body: unknown = raw;
	if (body !== null && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
		body = (body as Record<string, unknown>).data;
	}

	const mapInfo = Array.isArray(body) && body[0] && (body[0] as Record<string, unknown>).map_info
		? (body[0] as Record<string, unknown>).map_info
		: (body as Record<string, unknown> | null)?.map_info;

	if (Array.isArray(mapInfo)) {
		const maps = mapInfo as Record<string, unknown>[];
		const wanted = maps.find((entry) => Number(entry.mapFlag ?? entry.id) === mapFlag) ?? (maps.length === 1 ? maps[0] : undefined);
		for (const room of (wanted?.rooms as Record<string, unknown>[] | undefined) ?? []) {
			const segmentId = Number(room.id);
			if (!Number.isInteger(segmentId)) continue;
			const entry: RoomMappingEntry = { iotRoomId: String(room.iot_name_id ?? "") };
			const tag = Number(room.tag);
			if (Number.isInteger(tag)) entry.tag = tag;
			result.set(segmentId, entry);
		}
		return result;
	}

	if (Array.isArray(body)) {
		for (const room of body) {
			if (!Array.isArray(room) || room.length < 2) continue;
			const segmentId = Number(room[0]);
			if (!Number.isInteger(segmentId)) continue;
			const entry: RoomMappingEntry = { iotRoomId: String(room[1] ?? "") };
			if (room.length > 2) {
				const tag = Number(room[2]);
				if (Number.isInteger(tag)) entry.tag = tag;
			}
			result.set(segmentId, entry);
		}
	}

	return result;
}

/**
 * Furniture types the control plugin knows (`FurnitureType`, report section 1.8).
 *
 * Used for a warning only - a robot on newer firmware may well accept a type that is not in this
 * table, and refusing it here would be worse than letting the robot decide.
 */
export const FURNITURE_TYPES: Readonly<Record<number, string>> = {
	0: "FT_UNKNOWN",
	43: "FT_TVCABINET",
	44: "FT_TOILET",
	45: "FT_BED",
	46: "FT_SOFA",
	47: "FT_DINNERTABLE",
	48: "FT_TEATABLE",
	49: "FT_SHOECABINET",
	50: "FT_NIGHTSTAND",
	51: "FT_WARDROBE",
	52: "FT_OPENCATTOILET",
	53: "FT_CATTOILET",
	54: "FT_PETCAGE",
	55: "FT_PETWATERLOO",
	56: "FT_PETBOWL",
	57: "FT_FLOORMIRROR",
	58: "FT_CATTREE",
};

/** Length of an "add or change" furniture record (report section 1.8). */
const FURNITURE_UPSERT_LENGTH = 13;

/** Payload of `save_furnitures`. */
export interface FurniturePayload {
	map_flag: number;
	data: number[][];
}

/**
 * Reads a furniture edit a user wrote into the command state.
 *
 * Report section 1.8: the payload is `{map_flag, data}`, and every record in `data` is either
 * `[1, id, x0,y0, x1,y1, x2,y2, x3,y3, type, subType, direction]` to add or change a piece
 * (`id = -1` for a new one) or `[0, id]` to delete one. Unlike `save_map` this is differential:
 * the robot only touches the pieces the payload names, so an incomplete list loses nothing.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @param defaultMapFlag Map the edit applies to when the payload does not name one.
 * @returns The validated payload.
 * @throws If the value is not a well-formed furniture edit.
 */
export function parseFurnitures(raw: unknown, defaultMapFlag: number): FurniturePayload {
	let records: unknown;
	let mapFlag: number = defaultMapFlag;

	if (Array.isArray(raw)) {
		records = raw;
	} else if (raw !== null && typeof raw === "object") {
		const record = raw as Record<string, unknown>;
		records = record.data;
		if (record.map_flag !== undefined) {
			const flag = Number(record.map_flag);
			if (!Number.isInteger(flag) || flag < 0) {
				throw new Error(`save_furnitures got an invalid map_flag: ${JSON.stringify(record.map_flag)}`);
			}
			mapFlag = flag;
		}
	} else {
		throw new Error("save_furnitures expects {\"map_flag\": <map>, \"data\": [...]} or a bare array of records.");
	}

	if (!Array.isArray(records)) {
		throw new Error("save_furnitures expects a 'data' array of furniture records.");
	}
	if (records.length === 0) {
		throw new Error("save_furnitures got an empty record list; nothing would change.");
	}

	if (!Number.isInteger(mapFlag) || mapFlag < 0) {
		throw new Error(`save_furnitures has no usable map_flag (got ${mapFlag}); name one explicitly.`);
	}

	return { map_flag: mapFlag, data: records.map(parseFurnitureRecord) };
}

/**
 * Validates one furniture record.
 * @param raw One entry of the `data` array.
 * @param index Position in the list, for the error message.
 * @returns The record as plain numbers.
 */
function parseFurnitureRecord(raw: unknown, index: number): number[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(`save_furnitures record ${index} is not a record array.`);
	}

	const values = raw.map((entry, position) => {
		const value = typeof entry === "number" ? entry : Number(entry);
		if (!Number.isInteger(value)) {
			throw new Error(`save_furnitures record ${index}, position ${position} is not a whole number: ${JSON.stringify(entry)}`);
		}
		return value;
	});

	const operation = values[0];
	if (operation === 0) {
		if (values.length !== 2) {
			throw new Error(`save_furnitures record ${index}: a delete is [0, id], got ${values.length} values.`);
		}
		return values;
	}

	if (operation === 1) {
		if (values.length !== FURNITURE_UPSERT_LENGTH) {
			throw new Error(`save_furnitures record ${index}: an add or change is [1, id, x0,y0, x1,y1, x2,y2, x3,y3, type, subType, direction] - ${FURNITURE_UPSERT_LENGTH} values, got ${values.length}.`);
		}
		return values;
	}

	throw new Error(`save_furnitures record ${index}: the first value is the operation, 1 to add or change and 0 to delete, got ${operation}.`);
}

/**
 * Reads the cleaning sequence a user wrote into the command state.
 *
 * Report section 1.9: the parameter is the ordered array of segment ids, the same shape
 * `get_clean_sequence` returns. An empty array clears the sequence and lets the robot pick its own
 * order again.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @returns The validated list of segment ids.
 * @throws If the value is not an array of non-negative integers.
 */
export function parseCleanSequence(raw: unknown): number[] {
	if (!Array.isArray(raw)) {
		throw new Error("set_clean_sequence expects a JSON array of segment ids, for example [16,17,18]. An empty array [] clears the order.");
	}

	return raw.map((entry, index) => {
		const id = typeof entry === "number" ? entry : Number(entry);
		if (!Number.isInteger(id) || id < 0) {
			throw new Error(`set_clean_sequence entry ${index} is not a segment id: ${JSON.stringify(entry)}`);
		}
		return id;
	});
}

// ---------------------------------------------------------------------------
// No-go zones, no-mop zones and invisible walls - `save_map`
// (report sections 1.6 and 2.1)
// ---------------------------------------------------------------------------

/**
 * The record types, block names, lengths and limits come from `src/common/mapZoneKinds.ts`.
 *
 * They live there rather than here because the admin tab needs the same four facts and cannot
 * import this module - it would pull the map decryptor and the parser into a browser bundle. They
 * are re-exported unchanged so this file stays the one address for everything about the zone
 * commands.
 */
export {
	MAP_RECORD_MAP_SLOT,
	MAP_RECORD_TYPES,
	MAX_COUNT_WALL_OR_FBZ,
	ZONE_BLOCKS,
	ZONE_LABELS,
	ZONE_LENGTHS,
};
export type { MapZoneKind };

/** The complete set of walls and zones on one map, in the robot's own millimetres. */
export interface MapOverlays {
	/** `[xStart, yStart, xEnd, yEnd]` per wall. */
	wall: number[][];
	/** `[x0,y0, x1,y1, x2,y2, x3,y3]` per zone. */
	no_go: number[][];
	/** `[x0,y0, x1,y1, x2,y2, x3,y3]` per zone. */
	no_mop: number[][];
}

/**
 * Reads the complete set of walls and zones out of a parsed V1 map.
 *
 * This is the "read" half of the read-change-write cycle `save_map` forces on every caller
 * (report section 2.1). It is deliberately strict: anything it cannot account for makes it throw,
 * because the alternative - returning a short list - ends with the robot deleting whatever was
 * left out.
 * @param mapData A parsed V1 map.
 * @returns Every wall and zone on that map.
 * @throws If the map was not parsed, or carries an overlay this adapter cannot rebuild.
 */
export function readOverlaysFromMap(mapData: Record<string, unknown>): MapOverlays {
	// A map without an image block is not a map: an empty parse result would otherwise read as
	// "this robot has no zones", and the next save would wipe the ones it does have.
	if (!mapData || typeof mapData !== "object" || mapData.IMAGE === undefined) {
		throw new Error("The robot's map could not be parsed. Refusing to touch the zones, because save_map replaces every zone and wall at once and an unreadable map would look like an empty one.");
	}

	for (const block of UNREPRODUCIBLE_BLOCKS) {
		const value = mapData[block];
		if (Array.isArray(value) && value.length > 0) {
			throw new Error(`This map carries a '${block}' overlay. save_map replaces every zone and wall in one go, and the record type of that overlay is not documented, so writing would delete it. Refusing to edit the zones of this map.`);
		}
	}

	const overlays: MapOverlays = { wall: [], no_go: [], no_mop: [] };
	for (const kind of Object.keys(ZONE_BLOCKS) as MapZoneKind[]) {
		overlays[kind] = readZoneBlock(mapData[ZONE_BLOCKS[kind]], ZONE_LENGTHS[kind], ZONE_BLOCKS[kind]);
	}
	return overlays;
}

/**
 * Turns one parsed map block into a list of records, refusing anything unexpected.
 * @param raw Value of the block, absent when the map has none of that kind.
 * @param length How many numbers a record of this kind has.
 * @param blockName Name of the block, for the error message.
 * @returns The records as plain numbers.
 * @throws If a record does not have the expected shape.
 */
function readZoneBlock(raw: unknown, length: number, blockName: string): number[][] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new Error(`The map's '${blockName}' block is not a list; refusing to rewrite the zones from a map that was not understood.`);
	}

	return raw.map((entry, index) => {
		if (!Array.isArray(entry) || entry.length !== length) {
			throw new Error(`The map's '${blockName}' entry ${index} has ${Array.isArray(entry) ? entry.length : "no"} coordinates instead of ${length}; refusing to rewrite the zones from a map that was not understood.`);
		}
		return entry.map((value) => {
			const number = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(number)) {
				throw new Error(`The map's '${blockName}' entry ${index} holds a value that is not a number; refusing to rewrite the zones from a map that was not understood.`);
			}
			return Math.round(number);
		});
	});
}

/**
 * Builds the complete `save_map` payload from the full set of overlays.
 *
 * Report section 1.6: `walls.concat(fbz)`, plus `[100, mapFlag]` in multi-map operation. `[200, 0]`
 * is never sent - no caller in the app's own bundle sets it and its meaning is unknown.
 * @param overlays Every wall and zone that is to exist on the map afterwards.
 * @param mapSlot Map slot to name, or `null` on a single-map robot.
 * @returns The payload for `save_map`.
 */
export function buildSaveMapPayload(overlays: MapOverlays, mapSlot: number | null): number[][] {
	const payload: number[][] = [
		...overlays.wall.map((zone) => [MAP_RECORD_TYPES.wall, ...zone]),
		...overlays.no_go.map((zone) => [MAP_RECORD_TYPES.no_go, ...zone]),
		...overlays.no_mop.map((zone) => [MAP_RECORD_TYPES.no_mop, ...zone]),
	];

	if (mapSlot !== null) {
		payload.push([MAP_RECORD_MAP_SLOT, mapSlot]);
	}
	return payload;
}

/**
 * Reads a zone or wall a user wrote into one of the `add_...` command states.
 *
 * Defined in `src/common/mapZoneKinds.ts` so the admin tab can run its own payload through the same
 * check before sending it, and re-exported here because this is where the zone commands live.
 */
export { parseZoneInput };

/** What a user asked to be removed from the map. */
export interface ZoneRemoval {
	/** Which overlay, or `"all"` to clear walls and zones alike. */
	kind: MapZoneKind | "all";
	/** Position within that kind as `mapEdit.zones` lists it, or `null` for `"all"`. */
	index: number | null;
}

/**
 * Reads a removal a user wrote into the `remove_map_zone` command state.
 *
 * `save_map` has no zone ids (report section 2.1), so a zone can only be named by its position in
 * the list the adapter publishes under `mapEdit.zones`.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @returns What is to be removed.
 * @throws If the value names neither a kind and index nor "all".
 */
export function parseZoneRemoval(raw: unknown): ZoneRemoval {
	const kinds = Object.keys(MAP_RECORD_TYPES) as MapZoneKind[];
	const usage = `remove_map_zone expects {"kind": "${kinds.join("\" | \"")}", "index": 0} or "all" to clear every wall and zone.`;

	if (typeof raw === "string" && raw.trim().toLowerCase() === "all") {
		return { kind: "all", index: null };
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(usage);
	}

	const record = raw as Record<string, unknown>;
	const kind = String(record.kind ?? "").trim().toLowerCase();
	if (kind === "all") return { kind: "all", index: null };

	if (!kinds.includes(kind as MapZoneKind)) {
		throw new Error(usage);
	}

	const index = Number(record.index);
	if (!Number.isInteger(index) || index < 0) {
		throw new Error(`remove_map_zone needs the position of the ${ZONE_LABELS[kind as MapZoneKind]} within its own list, counted from 0; got ${JSON.stringify(record.index)}.`);
	}

	return { kind: kind as MapZoneKind, index };
}

/**
 * Counts the walls and zones in a set.
 * @param overlays The set.
 * @returns How many records it holds altogether.
 */
export function countOverlays(overlays: MapOverlays): number {
	return overlays.wall.length + overlays.no_go.length + overlays.no_mop.length;
}

/**
 * Digs the raw map out of a `get_map_v1` answer.
 *
 * The transport hands it back either bare or as `{data, version}`, the same two shapes
 * `V1MapService.updateMap` deals with.
 * @param raw The robot's answer.
 * @returns The raw map, or `null` when the answer holds none.
 */
export function extractMapBuffer(raw: unknown): Buffer | null {
	if (Buffer.isBuffer(raw)) return raw;

	if (raw !== null && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
		const data = (raw as Record<string, unknown>).data;
		if (Buffer.isBuffer(data)) return data;
	}
	return null;
}

/**
 * Reads how many map slots the robot has out of a `get_multi_maps_list` answer.
 * @param raw The robot's answer.
 * @returns `max_multi_map`, or `null` when the answer does not carry it.
 */
export function readMaxMultiMap(raw: unknown): number | null {
	let body: unknown = raw;
	if (body !== null && typeof body === "object" && !Array.isArray(body) && "data" in (body as Record<string, unknown>)) {
		body = (body as Record<string, unknown>).data;
	}
	while (Array.isArray(body) && body.length > 0) {
		body = body[0];
	}

	if (body === null || typeof body !== "object") return null;

	const value = (body as Record<string, unknown>).max_multi_map;
	if (value === undefined || value === null) return null;

	const max = Number(value);
	return Number.isInteger(max) && max > 0 ? max : null;
}

// ---------------------------------------------------------------------------
// Splitting and merging rooms - `split_segment`, `merge_segment`
// (report sections 1.3, 1.4 and 2.2)
// ---------------------------------------------------------------------------

/** `MAX_BLOCK_NO` (module 1507): a map holds at most this many segments. */
export const MAX_BLOCK_NO = 32;

/** A merge needs at least this many segments (`map_edit_merge_restriction`). */
export const MIN_MERGE_SEGMENTS = 2;

/**
 * Reads a split request a user wrote into the command state.
 *
 * Report section 1.3: the parameter is `[blockID, x1, y1, x2, y2]` - the segment to divide and the
 * two end points of the dividing line, in the robot's own millimetres. The app computes them as
 * `50 * cell` with the y axis mirrored, which is the same unit the map states report.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @returns The five numbers, validated.
 * @throws If the value is not a well-formed split request.
 */
export function parseSplitSegment(raw: unknown): number[] {
	if (!Array.isArray(raw) || raw.length !== 5) {
		throw new Error("split_segment expects [segmentId, x1, y1, x2, y2]: the room to divide and the two end points of the dividing line, in millimetres.");
	}

	const values = raw.map((entry, index) => {
		const value = typeof entry === "number" ? entry : Number(entry);
		if (!Number.isFinite(value)) {
			throw new Error(`split_segment value ${index} is not a number: ${JSON.stringify(entry)}`);
		}
		return Math.round(value);
	});

	if (values[0] < 0) {
		throw new Error(`split_segment needs a segment id as its first value, got ${values[0]}.`);
	}
	if (values[1] === values[3] && values[2] === values[4]) {
		throw new Error("split_segment needs a dividing line with two different end points.");
	}
	return values;
}

/**
 * Reads a merge request a user wrote into the command state.
 *
 * Report section 1.4: the parameter is a flat array of segment ids, at least two of them. Whether
 * they actually touch is left to the robot - the app checks it with a flood fill over the map's own
 * adjacency, which the adapter does not have.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @returns The segment ids, validated.
 * @throws If the value is not a well-formed merge request.
 */
export function parseMergeSegment(raw: unknown): number[] {
	if (!Array.isArray(raw)) {
		throw new Error("merge_segment expects a JSON array of segment ids, for example [16,17].");
	}

	const ids = raw.map((entry, index) => {
		const id = typeof entry === "number" ? entry : Number(entry);
		if (!Number.isInteger(id) || id < 0) {
			throw new Error(`merge_segment entry ${index} is not a segment id: ${JSON.stringify(entry)}`);
		}
		return id;
	});

	if (ids.length < MIN_MERGE_SEGMENTS) {
		throw new Error(`merge_segment needs at least ${MIN_MERGE_SEGMENTS} rooms, got ${ids.length}.`);
	}
	if (new Set(ids).size !== ids.length) {
		throw new Error(`merge_segment got the same room twice: [${ids.join(", ")}].`);
	}
	return ids;
}

/**
 * How the robot is meant to treat carpets (`CarPetCleanModeSettingMap`, report section 1.7).
 *
 * The adapter's `deviceStatus.carpet_clean_mode` only ever knew 0 to 2; the fourth value is in the
 * plugin's own table.
 */
export const CARPET_CLEAN_MODES: Readonly<Record<number, string>> = {
	0: "Avoid",
	1: "Rise",
	2: "Ignore",
	3: "Dynamic Lift",
};

/**
 * Reads the carpet handling mode a user wrote into the command state.
 *
 * Report section 1.7: the parameter is `{carpet_clean_mode: 0..3}`. The call is a single setting,
 * not a list, so there is nothing it could drop.
 * @param raw Value of the command state.
 * @returns The payload for `set_carpet_clean_mode`.
 * @throws If the value is not one of the four documented modes.
 */
export function parseCarpetCleanMode(raw: unknown): { carpet_clean_mode: number } {
	let value: unknown = raw;
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		value = (value as Record<string, unknown>).carpet_clean_mode;
	}

	const mode = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(mode) || CARPET_CLEAN_MODES[mode] === undefined) {
		throw new Error(`set_carpet_clean_mode expects one of ${Object.entries(CARPET_CLEAN_MODES).map(([key, label]) => `${key} (${label})`).join(", ")}, got ${JSON.stringify(raw)}.`);
	}
	return { carpet_clean_mode: mode };
}

/**
 * Reads the classic carpet boost settings a user wrote into the command state.
 *
 * Report section 1.7: the parameter is a one-element array holding the settings object, the same
 * shape `deviceStatus.carpet_mode` reports back. A bare object is wrapped, an array is taken as it
 * is - the robot replaces the whole settings record either way, and the record is what the user
 * supplied, so nothing of theirs can be lost.
 * @param raw Value of the command state.
 * @returns The payload for `set_carpet_mode`.
 * @throws If the value is not a settings object.
 */
export function parseCarpetMode(raw: unknown): Record<string, unknown>[] {
	const entries = Array.isArray(raw) ? raw : [raw];
	if (entries.length !== 1) {
		throw new Error(`set_carpet_mode expects exactly one settings object, for example {"enable":1,"stall_time":10,"current_low":400,"current_high":500,"current_integral":450}; got ${entries.length}.`);
	}

	const settings = entries[0];
	if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error("set_carpet_mode expects a settings object such as {\"enable\":1,\"stall_time\":10,\"current_low\":400,\"current_high\":500,\"current_integral\":450}.");
	}
	return [settings as Record<string, unknown>];
}

/**
 * The map editor methods this adapter sends, and the payload building around them.
 *
 * The service owns the payload shapes and the retry envelope; the device feature class only routes
 * its command states here. Written as its own unit so a later package can add editor methods
 * without touching `v1VacuumFeatures.ts` again.
 */
export class MapEditService {
	/**
	 * The command states that add one wall or zone, and which kind each of them adds.
	 *
	 * There is no `save_map` state on purpose: the method replaces the complete set of walls and
	 * zones, so a state that passed a payload straight through would let a caller delete everything
	 * else by sending one zone (report section 2.1).
	 */
	public static readonly ZONE_ADD_COMMANDS: Readonly<Record<string, MapZoneKind>> = ZONE_ADD_COMMANDS;

	/** Command that removes one wall or zone, or clears them all. */
	public static readonly ZONE_REMOVE_COMMAND = ZONE_REMOVE_COMMAND;

	/** The two commands that change segment ids and therefore invalidate room-bound settings. */
	public static readonly SEGMENT_EDIT_COMMANDS: readonly string[] = ["split_segment", "merge_segment"];

	/** Commands this service registers and handles. */
	public static readonly COMMANDS: readonly string[] = [
		"set_clean_sequence",
		"save_furnitures",
		"name_segment",
		"set_carpet_clean_mode",
		"set_carpet_mode",
		...Object.keys(MapEditService.ZONE_ADD_COMMANDS),
		MapEditService.ZONE_REMOVE_COMMAND,
		...MapEditService.SEGMENT_EDIT_COMMANDS,
	];

	/**
	 * @param deps Feature dependencies.
	 * @param duid Device this service belongs to.
	 * @param getMapFlag Map an edit applies to when the payload does not name one; the feature class
	 * knows the active map, the service does not.
	 * @param onSegmentsChanged Re-reads the room states after a split or a merge. The segment ids
	 * change during both (report section 2.2), so the states the adapter holds point nowhere until
	 * they are read again.
	 */
	constructor(
		private readonly deps: FeatureDependencies,
		private readonly duid: string,
		private readonly getMapFlag: () => number = () => 0,
		private readonly onSegmentsChanged: () => Promise<void> = async () => {}
	) {}

	/**
	 * The set of walls and zones a `save_map` is on its way with.
	 *
	 * Published once the robot confirms; before that the state keeps showing what the robot
	 * actually holds, so a write that never lands does not leave a lie behind.
	 */
	private pendingOverlays: MapOverlays | null = null;

	/**
	 * Declares the command states for the editor methods.
	 * @param addCommand The feature class' own `addCommand`, so the states land in the usual place.
	 */
	public registerCommands(addCommand: (name: string, spec: CommandSpec) => void): void {
		const translations = this.deps.adapter.translations;

		addCommand("set_clean_sequence", {
			type: "json",
			role: "json",
			def: "[]",
			name: translations["set_clean_sequence"] || "Cleaning order (segment IDs, [] resets)",
		} as CommandSpec);

		addCommand("save_furnitures", {
			type: "json",
			role: "json",
			def: "",
			name: translations["save_furnitures"] || "Furniture ([1,id,x0,y0,x1,y1,x2,y2,x3,y3,type,subType,direction] adds, [0,id] deletes)",
		} as CommandSpec);

		addCommand("name_segment", {
			type: "json",
			role: "json",
			def: "",
			name: translations["name_segment"] || "Rename rooms ([{\"segmentId\":16,\"name\":\"Kitchen\",\"tag\":14}])",
		} as CommandSpec);

		addCommand("set_carpet_clean_mode", {
			type: "number",
			role: "value.list",
			def: 0,
			states: { ...CARPET_CLEAN_MODES },
			name: translations["set_carpet_clean_mode"] || "Carpet Avoidance Mode",
		} as CommandSpec);

		addCommand("set_carpet_mode", {
			type: "json",
			role: "json",
			def: "",
			name: translations["set_carpet_mode"] || "Carpet Boost",
		} as CommandSpec);

		addCommand("add_virtual_wall", {
			type: "json",
			role: "json",
			def: "",
			name: translations["add_virtual_wall"] || "Add invisible wall ([xStart,yStart,xEnd,yEnd] in mm)",
			desc: translations["map_zone_write_hint"] || MapEditService.ZONE_WRITE_HINT_EN,
		} as CommandSpec);

		addCommand("add_no_go_zone", {
			type: "json",
			role: "json",
			def: "",
			name: translations["add_no_go_zone"] || "Add no-go zone ([x1,y1,x2,y2] or four corners, in mm)",
			desc: translations["map_zone_write_hint"] || MapEditService.ZONE_WRITE_HINT_EN,
		} as CommandSpec);

		addCommand("add_no_mop_zone", {
			type: "json",
			role: "json",
			def: "",
			name: translations["add_no_mop_zone"] || "Add no-mop zone ([x1,y1,x2,y2] or four corners, in mm)",
			desc: translations["map_zone_write_hint"] || MapEditService.ZONE_WRITE_HINT_EN,
		} as CommandSpec);

		addCommand(MapEditService.ZONE_REMOVE_COMMAND, {
			type: "json",
			role: "json",
			def: "",
			name: translations["remove_map_zone"] || "Remove a wall or zone ({\"kind\":\"no_go\",\"index\":0}, or \"all\")",
			desc: translations["map_zone_write_hint"] || MapEditService.ZONE_WRITE_HINT_EN,
		} as CommandSpec);

		addCommand("split_segment", {
			type: "json",
			role: "json",
			def: "",
			name: translations["split_segment"] || "Divide a room ([segmentId, x1, y1, x2, y2] in mm)",
			desc: this.segmentEditHint(),
		} as CommandSpec);

		addCommand("merge_segment", {
			type: "json",
			role: "json",
			def: "",
			name: translations["merge_segment"] || "Combine rooms ([segmentId, segmentId, ...])",
			desc: this.segmentEditHint(),
		} as CommandSpec);
	}

	/** English fallback for the note every zone command carries; see `map_zone_write_hint`. */
	private static readonly ZONE_WRITE_HINT_EN = "The robot stores walls and zones as one set without ids, so every change rewrites all of them. The adapter reads the current set off the robot's map first and writes it back complete; if the map cannot be read, nothing is written. The current set is listed under mapEdit.zones, and the index used for removal is the position within its own list.";

	/**
	 * Roborock's own warning, `map_edit_segment_prompt`, plus what the adapter does about it.
	 *
	 * Report section 2.2: the app shows the first sentence whenever room-bound cleaning modes, a
	 * cleaning order or room-bound schedules exist, because splitting and merging renumber the
	 * segments (`RoomIdDidChanged`). Everything that referred to a room by its old id then refers to
	 * nothing.
	 * @returns The text for the state's description.
	 */
	private segmentEditHint(): string {
		const translations = this.deps.adapter.translations;
		return `${translations["map_edit_segment_prompt"] || MapEditService.SEGMENT_EDIT_WARNING_EN} ${translations["map_edit_segment_hint"] || MapEditService.SEGMENT_EDIT_HINT_EN}`;
	}

	/** Roborock's own wording of the warning; see `map_edit_segment_prompt`. */
	private static readonly SEGMENT_EDIT_WARNING_EN = "After combining or dividing rooms, all related settings and schedules become invalid.";

	/** What the adapter adds to that warning; see `map_edit_segment_hint`. */
	private static readonly SEGMENT_EDIT_HINT_EN = "The reason is that the room IDs change. Room-bound cleaning modes, the cleaning order and schedules that name a room have to be set up again afterwards. The adapter re-reads the rooms and the map once the robot confirms the change.";

	/** Whether the given command is handled by this service. */
	public handles(method: string): boolean {
		return MapEditService.COMMANDS.includes(method);
	}

	/**
	 * Builds the wire payload for one of {@link MapEditService.COMMANDS}.
	 * @param method The command being sent.
	 * @param params Raw value from the command state.
	 * @returns Method and payload for `requestsHandler`.
	 */
	public async buildRequest(method: string, params: unknown): Promise<{ method: string; params: unknown }> {
		if (method === "set_clean_sequence") {
			const sequence = parseCleanSequence(params);
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
				sequence.length === 0
					? "Clearing the cleaning order; the robot will pick its own order again."
					: `Setting the cleaning order to ${sequence.join(", ")}.`,
				"info");
			return { method, params: await this.wrap(method, sequence) };
		}

		if (method === "save_furnitures") {
			const payload = parseFurnitures(params, this.getMapFlag());
			this.warnAboutUnknownFurnitureTypes(payload);

			const added = payload.data.filter((record) => record[0] === 1).length;
			const deleted = payload.data.length - added;
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `Saving furniture on map ${payload.map_flag}: ${added} added or changed, ${deleted} deleted.`, "info");

			return { method, params: await this.wrap(method, payload) };
		}

		if (method === "name_segment") {
			const entries = await this.buildNameSegment(parseRoomNaming(params));
			return { method, params: await this.wrap(method, entries) };
		}

		if (method === "set_carpet_clean_mode") {
			const payload = parseCarpetCleanMode(params);
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `Setting the carpet handling to ${CARPET_CLEAN_MODES[payload.carpet_clean_mode]} (${payload.carpet_clean_mode}).`, "info");
			return { method, params: await this.wrap(method, payload) };
		}

		if (method === "set_carpet_mode") {
			return { method, params: await this.wrap(method, parseCarpetMode(params)) };
		}

		const addedKind = MapEditService.ZONE_ADD_COMMANDS[method];
		if (addedKind !== undefined) {
			return this.buildSaveMap((overlays) => this.addZone(overlays, addedKind, parseZoneInput(addedKind, params)));
		}

		if (method === MapEditService.ZONE_REMOVE_COMMAND) {
			return this.buildSaveMap((overlays) => this.removeZone(overlays, parseZoneRemoval(params)));
		}

		if (method === "split_segment") {
			const info = parseSplitSegment(params);
			const rooms = await this.readSegmentIds(method);

			if (!rooms.has(info[0])) {
				throw new Error(`split_segment: room ${info[0]} is not on the current map (known: ${[...rooms].join(", ")}).`);
			}
			// The report words the app's own check two ways: section 1.3 says "more than 31", while
			// section 2.3 and `roborock_map_edit.json` both say "refused from 31 rooms on". Two of
			// three say 31, and a split refused one room early costs nothing next to one the robot
			// rejects after the fact, so 31 it is.
			if (rooms.size >= MAX_BLOCK_NO - 1) {
				throw new Error(`split_segment: the map already holds ${rooms.size} rooms, and the app stops offering a split from ${MAX_BLOCK_NO - 1} on (the firmware's limit is ${MAX_BLOCK_NO}). Combine two rooms first.`);
			}

			this.warnAboutSegmentEdit(`Dividing room ${info[0]} along ${info.slice(1).join(", ")}.`);
			return { method, params: await this.wrap(method, info) };
		}

		if (method === "merge_segment") {
			const ids = parseMergeSegment(params);
			const rooms = await this.readSegmentIds(method);

			const missing = ids.filter((id) => !rooms.has(id));
			if (missing.length > 0) {
				throw new Error(`merge_segment: room(s) ${missing.join(", ")} are not on the current map (known: ${[...rooms].join(", ")}).`);
			}

			// Whether the rooms touch is checked by the robot; the adapter has no adjacency to test.
			this.warnAboutSegmentEdit(`Combining rooms ${ids.join(", ")}.`);
			return { method, params: await this.wrap(method, ids) };
		}

		throw new Error(`MapEditService cannot build a request for '${method}'.`);
	}

	/**
	 * Builds the full `name_segment` payload for the requested renames.
	 *
	 * **`name_segment` replaces the entire assignment.** The app rebuilds the list from every known
	 * segment and sends it complete; a partial list silently drops the rooms it leaves out, and the
	 * adapter would then show nameless rooms because it resolves names by cloud room id. So the
	 * current mapping is read first and the requested changes are laid over it.
	 *
	 * The robot only ever stores numbers - the room name itself lives in the Roborock cloud, and
	 * there is no rename endpoint. Renaming therefore means pointing the segment at a cloud room
	 * that carries the wanted name, creating one when none exists.
	 * @param requests The parsed changes.
	 * @returns The complete list of `{iotRoomId, robotRoomId, robotTagId}` entries.
	 */
	private async buildNameSegment(requests: RoomNameRequest[]): Promise<Record<string, unknown>[]> {
		const mapFlag = this.getMapFlag();
		const mapping = await this.readRoomMapping(mapFlag);

		if (mapping.size === 0) {
			throw new Error("name_segment needs the current room mapping, and get_room_mapping returned none. Wait until the map is loaded and try again - sending an incomplete list would drop the names of every other room.");
		}

		for (const request of requests) {
			if (!mapping.has(request.segmentId)) {
				throw new Error(`name_segment: segment ${request.segmentId} is not on the current map (known: ${[...mapping.keys()].join(", ")}).`);
			}
		}

		const changes = new Map(requests.map((request) => [request.segmentId, request]));
		const named: { id: string; name: string }[] = [];
		const payload: Record<string, unknown>[] = [];

		for (const [segmentId, current] of mapping) {
			const change = changes.get(segmentId);
			let iotRoomId = current.iotRoomId;

			if (change?.name !== undefined) {
				iotRoomId = await this.resolveCloudRoomId(change.name);
				named.push({ id: iotRoomId, name: change.name });
			}

			const entry: Record<string, unknown> = { iotRoomId: String(iotRoomId), robotRoomId: segmentId };

			// Only send a tag that is actually known. Inventing one would retag the room and change
			// the suction and water defaults the tag carries.
			const tag = change?.tag ?? current.tag;
			if (tag !== undefined) entry.robotTagId = tag;

			payload.push(entry);
		}

		await this.syncRoomsInfo(named);

		this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `Renaming ${requests.length} of ${payload.length} room(s) on map ${mapFlag}; the full assignment is sent because name_segment replaces it.`, "info");

		return payload;
	}

	/**
	 * Runs one zone edit as read, change, write back.
	 *
	 * **This is the whole point of the zone commands.** `save_map` takes the complete set of walls
	 * and zones and keeps exactly what it was given - no operation code, no zone id, no delete
	 * record (report section 2.1). So the robot's own map is read first, the change is laid over the
	 * set that map holds, and everything is sent back together. Every step that could fail throws
	 * instead of continuing with a partial set, because a partial set is what deletes the user's
	 * zones.
	 * @param change Applies the requested edit to the set read off the robot, and returns what to
	 * say about it in the log.
	 * @returns Method and payload for `requestsHandler`.
	 */
	private async buildSaveMap(change: (overlays: MapOverlays) => string): Promise<{ method: string; params: unknown }> {
		const mapSlot = await this.readMapSlot();
		const overlays = await this.readOverlays();

		const before = countOverlays(overlays);
		const description = change(overlays);
		const payload = buildSaveMapPayload(overlays, mapSlot);

		this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
			`${description} Writing back the complete set (${countOverlays(overlays)} record(s), was ${before})${mapSlot === null ? "" : ` on map slot ${mapSlot}`}, because save_map keeps only what it is sent.`,
			"info");

		// Published for real once the robot confirms; until then `mapEdit.zones` still shows what
		// `readOverlays` found, which is what is actually on the robot.
		this.pendingOverlays = overlays;
		return { method: "save_map", params: await this.wrap("save_map", payload) };
	}

	/**
	 * Adds one wall or zone to the set that was read off the robot.
	 * @param overlays The set read off the robot; changed in place.
	 * @param kind Which overlay is being added.
	 * @param zone Its coordinates.
	 * @returns A sentence for the log.
	 * @throws If the robot is already at the limit for that kind.
	 */
	private addZone(overlays: MapOverlays, kind: MapZoneKind, zone: number[]): string {
		if (overlays[kind].length >= MAX_COUNT_WALL_OR_FBZ) {
			throw new Error(`The map already has ${overlays[kind].length} ${ZONE_LABELS[kind]}s, and the app's own limit is ${MAX_COUNT_WALL_OR_FBZ} per kind. Remove one first.`);
		}

		overlays[kind].push(zone);
		return `Adding a ${ZONE_LABELS[kind]} at ${zone.join(", ")}.`;
	}

	/**
	 * Removes one wall or zone from the set that was read off the robot, or clears them all.
	 * @param overlays The set read off the robot; changed in place.
	 * @param removal What the user asked to remove.
	 * @returns A sentence for the log.
	 * @throws If the named zone is not there.
	 */
	private removeZone(overlays: MapOverlays, removal: ZoneRemoval): string {
		if (removal.kind === "all") {
			const total = countOverlays(overlays);
			if (total === 0) {
				throw new Error("The map has no walls or zones; there is nothing to remove.");
			}
			overlays.wall = [];
			overlays.no_go = [];
			overlays.no_mop = [];
			return `Removing all ${total} wall(s) and zone(s).`;
		}

		const list = overlays[removal.kind];
		const index = removal.index as number;
		if (index >= list.length) {
			throw new Error(list.length === 0
				? `The map has no ${ZONE_LABELS[removal.kind]}s, so there is no index ${index} to remove.`
				: `The map has ${list.length} ${ZONE_LABELS[removal.kind]}(s), numbered 0 to ${list.length - 1}; there is no index ${index}. mapEdit.zones lists them.`);
		}

		const [removed] = list.splice(index, 1);
		return `Removing the ${ZONE_LABELS[removal.kind]} at index ${index} (${removed.join(", ")}).`;
	}

	/**
	 * Reads the complete set of walls and zones off the robot's own map.
	 *
	 * The robot is the only source that has all of them: `save_map` has no read counterpart, and the
	 * adapter must not rely on a set it cached earlier, because the app or another client may have
	 * changed it in the meantime.
	 * @returns Every wall and zone on the current map.
	 * @throws If the map cannot be fetched or parsed - in which case nothing is written.
	 */
	private async readOverlays(): Promise<MapOverlays> {
		let raw: unknown;
		try {
			raw = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_map_v1", [], { priority: 0 });
		} catch (e: unknown) {
			throw new Error(`Could not fetch the robot's map (${this.deps.adapter.errorMessage(e)}). Refusing to edit the zones: save_map replaces every wall and zone at once, so writing without the current set would delete it.`);
		}

		const buffer = extractMapBuffer(raw);
		if (!buffer) {
			throw new Error("The robot did not answer get_map_v1 with a map. Refusing to edit the zones: save_map replaces every wall and zone at once, so writing without the current set would delete it.");
		}

		const decoded = await MapDecryptor.decrypt(buffer);
		const parser = new MapParser(this.deps.adapter);
		const mapData = await parser.parsedata(decoded, null, { isHistoryMap: false, duid: this.duid });

		const overlays = readOverlaysFromMap(mapData as unknown as Record<string, unknown>);

		// Published even when the edit is then refused: this is what is on the robot right now, and
		// an index only means something next to the list it counts into.
		await this.publishOverlays(overlays);
		return overlays;
	}

	/**
	 * Works out whether the payload has to name a map slot.
	 *
	 * Report section 1.6: the app appends `[100, mapFlag]` only when the robot supports more than
	 * one map. A robot that cannot say how many slots it has is not written to at all - the marker
	 * decides which floor the zones land on.
	 * @returns The map slot to name, or `null` on a single-map robot.
	 * @throws If the slot count cannot be read, or the active map is unknown on a multi-map robot.
	 */
	private async readMapSlot(): Promise<number | null> {
		let raw: unknown;
		try {
			raw = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_multi_maps_list", []);
		} catch (e: unknown) {
			throw new Error(`Could not read the robot's map list (${this.deps.adapter.errorMessage(e)}), and a multi-map robot needs the map slot in the payload. Refusing to edit the zones rather than write them to the wrong floor.`);
		}

		const maxMultiMap = readMaxMultiMap(raw);
		if (maxMultiMap === null) {
			throw new Error("get_multi_maps_list did not report how many maps the robot has, and a multi-map robot needs the map slot in the payload. Refusing to edit the zones rather than write them to the wrong floor.");
		}
		if (maxMultiMap <= 1) return null;

		const mapFlag = this.getMapFlag();
		if (!Number.isInteger(mapFlag) || mapFlag < 0) {
			throw new Error("The active map is not known yet, and this robot keeps several. Refusing to edit the zones rather than write them to the wrong floor; wait until the map has loaded.");
		}
		return mapFlag;
	}

	/**
	 * Publishes the set of walls and zones so a user can see what an index refers to.
	 *
	 * `save_map` has no zone ids, so removing one means naming its position - and the position is
	 * only meaningful next to the list it counts into.
	 * @param overlays The set as it will be after the pending write.
	 */
	private async publishOverlays(overlays: MapOverlays): Promise<void> {
		const stateId = `Devices.${this.duid}.mapEdit.zones`;
		try {
			await this.deps.ensureFolder(`Devices.${this.duid}.mapEdit`);
			await this.deps.ensureState(stateId, {
				type: "string",
				role: "json",
				read: true,
				write: false,
				name: this.deps.adapter.translations["map_zones"] || "Walls and zones on the current map",
				def: "",
			});
			await this.deps.adapter.setState(stateId, JSON.stringify(overlays), true);
		} catch (e: unknown) {
			// Only a convenience readout; never let it stop the edit itself.
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `Could not publish ${stateId}: ${this.deps.adapter.errorMessage(e)}`, "warn");
		}
	}

	/**
	 * Reads which segments are on the current map, refusing to go on when it cannot.
	 *
	 * A split or a merge that names a room the robot does not have is at best rejected and at worst
	 * applied to the wrong one; both are checked against what the robot itself reports rather than
	 * against anything the adapter cached.
	 * @param method The command being checked, for the error message.
	 * @returns The segment ids on the current map.
	 * @throws If the room list cannot be read.
	 */
	private async readSegmentIds(method: string): Promise<Set<number>> {
		const mapping = await this.readRoomMapping(this.getMapFlag());
		if (mapping.size === 0) {
			throw new Error(`${method} needs the current room list, and get_room_mapping returned none. Wait until the map is loaded and try again - this call renumbers the rooms, so it must not be sent blind.`);
		}
		return new Set(mapping.keys());
	}

	/**
	 * Repeats Roborock's own warning in the log before a split or a merge goes out.
	 *
	 * Report section 2.2: room-bound cleaning modes, the cleaning order and room-bound schedules all
	 * refer to a segment id, and both calls renumber the segments. The app warns about this on
	 * screen; the adapter has no screen, so it warns here and on the state itself.
	 * @param what A sentence describing the change.
	 */
	private warnAboutSegmentEdit(what: string): void {
		this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `${what} ${MapEditService.SEGMENT_EDIT_WARNING_EN} The room IDs change, so room-bound cleaning modes, the cleaning order and schedules that name a room have to be set up again. The rooms and the map are re-read once the robot confirms.`, "warn");
	}

	/**
	 * Reads the current segment-to-cloud-room assignment from the robot.
	 * @param mapFlag Map whose rooms are wanted.
	 * @returns Segment id to what the robot knows about it.
	 */
	private async readRoomMapping(mapFlag: number): Promise<Map<number, RoomMappingEntry>> {
		const raw = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_room_mapping", []);
		return parseRoomMapping(raw, mapFlag);
	}

	/**
	 * Pushes the room names to the robot, which it needs for Matter and voice control.
	 *
	 * Report section 1.5: the app sends `sync_rooms_info` before `name_segment`, but only when the
	 * robot announces `NewFeatureStrBit.Matter` (bit 67). Without the bit it does not transfer names
	 * at all, and nothing in the adapter depends on it either - the map tab resolves names from the
	 * cloud room list - so a robot without the bit simply skips this step.
	 * @param rooms The cloud rooms whose names changed.
	 */
	private async syncRoomsInfo(rooms: { id: string; name: string }[]): Promise<void> {
		if (rooms.length === 0) return;

		const state = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.deviceStatus.new_feature_info_str`);
		if (!hasFeatureStrBit(state?.val, MATTER_FEATURE_BIT)) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined, "Skipping sync_rooms_info; the robot does not report the Matter feature bit, and its own app does not send names either in that case.", "debug");
			return;
		}

		try {
			await this.deps.adapter.requestsHandler.sendRequest(this.duid, "sync_rooms_info", rooms);
		} catch (e: unknown) {
			// The names still reach the map through the cloud room list, so this is not fatal.
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `sync_rooms_info failed, continuing with name_segment: ${this.deps.adapter.errorMessage(e)}`, "warn");
		}
	}

	/**
	 * Finds the cloud room that carries a name, creating one when none does.
	 *
	 * There is no rename endpoint in the Roborock cloud API - only list, create and delete - so a
	 * rename is "point the segment at a room with the right name". The old room is deliberately left
	 * in place: other floors or schedules may still refer to it.
	 * @param name The wanted room name.
	 * @returns The cloud room id.
	 */
	private async resolveCloudRoomId(name: string): Promise<string> {
		const httpApi = this.deps.adapter.http_api;
		const existing = (httpApi.homeData?.rooms ?? []).find((room) => room.name?.trim() === name);
		if (existing) return String(existing.id);

		if (!httpApi.realApi || !httpApi.homeID) {
			throw new Error(`name_segment cannot name a room '${name}': room names live in the Roborock cloud and there is no cloud session. Renaming needs the adapter to be logged in.`);
		}

		const form = new URLSearchParams({ name });
		const response = await httpApi.realApi.post<{ success?: boolean; result?: { id?: number } | number; msg?: string }>(
			`user/homes/${httpApi.homeID}/rooms`,
			form.toString(),
			{ headers: { "Content-Type": "application/x-www-form-urlencoded" } }
		);

		const result = response.data?.result;
		const id = typeof result === "number" ? result : result?.id;
		if (id === undefined || id === null) {
			throw new Error(`name_segment could not create the cloud room '${name}': ${JSON.stringify(response.data)}`);
		}

		// Keep the cached list in step so the map tab resolves the new name without a refetch.
		httpApi.homeData?.rooms?.push({ id: Number(id), name });
		this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `Created cloud room '${name}' (id ${id}).`, "info");

		return String(id);
	}

	/**
	 * Notes furniture types outside the documented table without refusing them.
	 *
	 * Newer firmware may know types the decompiled plugin did not, and rejecting those here would
	 * block a legitimate edit; a log line is enough to explain a robot that answers with an error.
	 * @param payload The validated furniture payload.
	 */
	private warnAboutUnknownFurnitureTypes(payload: FurniturePayload): void {
		const unknown = payload.data
			.filter((record) => record[0] === 1 && FURNITURE_TYPES[record[10]] === undefined)
			.map((record) => record[10]);

		if (unknown.length > 0) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `save_furnitures uses furniture type(s) ${[...new Set(unknown)].join(", ")}, which the Roborock app does not list. Sending them anyway; the robot decides.`, "warn");
		}
	}

	/**
	 * Finishes a call the robot deferred.
	 *
	 * Report section 1.2: a robot that answers `{result: 'retry', id: <n>}` has accepted the call but
	 * not finished it. The app then polls `retry_request {retry_id, method, retry_count}` every two
	 * seconds, at most eight times, and reports `reach_max_retry_count` afterwards. A response
	 * without an `id` is `retry_id_invalid`.
	 *
	 * Without this the call would simply be left hanging, so the outcome is logged either way.
	 *
	 * A confirmed `split_segment` or `merge_segment` also triggers the room refresh: the segment ids
	 * have changed by then (report section 2.2) and the states the adapter holds point nowhere.
	 * @param method The command that was deferred.
	 * @param response Whatever the robot answered.
	 */
	public async resolveDeferredResult(method: string, response: unknown): Promise<void> {
		const confirmed = await this.pollUntilConfirmed(method, response);

		if (method === "save_map") {
			const written = this.pendingOverlays;
			this.pendingOverlays = null;
			if (confirmed && written) await this.publishOverlays(written);
		}

		if (confirmed && MapEditService.SEGMENT_EDIT_COMMANDS.includes(method)) {
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `${method} finished; re-reading the rooms and the map because the segment IDs have changed.`, "info");
			try {
				await this.onSegmentsChanged();
			} catch (e: unknown) {
				this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `Could not re-read the rooms after ${method}: ${this.deps.adapter.errorMessage(e)}. The room states still carry the old segment IDs until the next update.`, "warn");
			}
		}
	}

	/**
	 * Polls `retry_request` until the robot confirms a deferred call.
	 * @param method The command that was sent.
	 * @param response Whatever the robot answered.
	 * @returns True when the call went through, false when it was deferred and never confirmed.
	 */
	private async pollUntilConfirmed(method: string, response: unknown): Promise<boolean> {
		const retryId = readRetryId(response);
		if (retryId === null) return true;

		if (retryId === undefined) {
			this.deps.adapter.rLog("Requests", this.duid, "Error", "1.0", undefined, `${method}: the robot answered 'retry' without an id (retry_id_invalid).`, "error");
			return false;
		}

		for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
			await this.delay(RETRY_POLL_INTERVAL_MS);

			let result: unknown;
			try {
				result = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "retry_request", {
					retry_id: retryId,
					method,
					retry_count: attempt,
				});
			} catch (e: unknown) {
				this.deps.adapter.rLog("Requests", this.duid, "Error", "1.0", undefined, `${method}: retry_request ${attempt} failed: ${this.deps.adapter.errorMessage(e)}`, "error");
				return false;
			}

			if (readRetryId(result) === null) {
				this.deps.adapter.rLog("Requests", this.duid, "Info", "1.0", undefined, `${method} confirmed after ${attempt} retry poll(s).`, "info");
				return true;
			}
		}

		this.deps.adapter.rLog("Requests", this.duid, "Error", "1.0", undefined, `${method}: still unconfirmed after ${RETRY_MAX_ATTEMPTS} retry polls (reach_max_retry_count).`, "error");
		return false;
	}

	/**
	 * Waits through an adapter-owned timer, so a pending poll cannot outlive the adapter.
	 * @param ms Delay in milliseconds.
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = this.deps.adapter.setTimeout(() => resolve(), ms);
			// setTimeout returns undefined once the adapter is shutting down; do not hang in that case.
			if (!timer) resolve();
		});
	}

	/**
	 * Applies the retry envelope when the method needs it and the firmware supports it.
	 * @param method The command being sent.
	 * @param params Payload as the method defines it.
	 * @returns The payload to put on the wire.
	 */
	private async wrap(method: string, params: unknown): Promise<unknown> {
		if (!RETRY_METHODS.has(method)) return params;
		return applyRetryEnvelope(params, await this.isRetrySupported());
	}

	/**
	 * Whether the robot understands the retry envelope.
	 *
	 * `new_feature_info` reaches the adapter as a plain `deviceStatus` state, because `processStatus`
	 * turns every unhandled `get_status` key into one. A robot that does not report the field, or
	 * reports something unreadable, is treated as not supporting the envelope - which is the
	 * documented fallback: send the bare parameters.
	 * @returns True when bit 26 is set.
	 */
	private async isRetrySupported(): Promise<boolean> {
		try {
			const state = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.deviceStatus.new_feature_info`);
			const raw = state?.val;
			if (raw === undefined || raw === null || raw === "") return false;

			const value = typeof raw === "number" ? raw : Number(raw);
			if (!Number.isFinite(value)) return false;

			return (value & RPC_RETRY_FEATURE_BIT) !== 0;
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined, `Could not read new_feature_info, sending bare parameters: ${this.deps.adapter.errorMessage(e)}`, "debug");
			return false;
		}
	}
}
