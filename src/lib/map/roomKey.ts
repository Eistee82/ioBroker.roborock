/**
 * Room keys for multi-floor (multi-map) devices.
 *
 * A room id is only unique **within one stored map**. Robots that keep several maps
 * (floors) regularly reuse the same segment/room ids across maps, and users often give
 * rooms on different floors the same name ("Bathroom", "Hallway"). The only safe key is
 * therefore the composite `(mapFlag, roomId)`; the room name is display data and must
 * never be used as a key.
 *
 * The ioBroker object layout already reflects that and stays unchanged:
 *   `Devices.<duid>.floors.<mapFlag>.<roomId>`
 *
 * This module centralises the key construction so that every reader (map pipelines,
 * web UI caches) derives the very same key from the very same pair of values.
 */

/** Value used by the V1 pipeline while the active map slot is still unknown. */
export const UNKNOWN_MAP_FLAG = -1;

/**
 * Normalises a map flag (floor id).
 * @param value Raw value, e.g. the current map index of the V1 pipeline.
 * @returns The map flag as non-negative integer, or `null` when it is unknown/invalid.
 */
export function normalizeMapFlag(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const flag = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(flag) || flag < 0) return null;
	return flag;
}

/**
 * Normalises a room/segment id.
 * @param value Raw value from a parsed map segment.
 * @returns The room id as non-negative integer, or `null` when it is invalid.
 */
export function normalizeRoomId(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const roomId = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(roomId) || roomId < 0) return null;
	return roomId;
}

/**
 * Object id of the floor folder holding all rooms of one map.
 * @param duid Device unique id.
 * @param mapFlag Map flag (floor id).
 */
export function floorFolderId(duid: string, mapFlag: number): string {
	return `Devices.${duid}.floors.${mapFlag}`;
}

/**
 * Object id of a single room state, keyed by `(mapFlag, roomId)`.
 * @param duid Device unique id.
 * @param mapFlag Map flag (floor id).
 * @param roomId Room/segment id inside that map.
 */
export function roomStateId(duid: string, mapFlag: number, roomId: number): string {
	return `${floorFolderId(duid, mapFlag)}.${roomId}`;
}

/**
 * Cache key for a room name held in memory (adapter or web UI).
 * @param duid Device unique id.
 * @param mapFlag Map flag (floor id).
 * @param roomId Room/segment id inside that map.
 */
export function roomNameCacheKey(duid: string, mapFlag: number, roomId: number): string {
	return `${duid}.${mapFlag}.${roomId}`;
}

/**
 * Cache key identifying one `(device, map)` pair, e.g. for "already requested" guards.
 * @param duid Device unique id.
 * @param mapFlag Map flag (floor id).
 */
export function floorScopeKey(duid: string, mapFlag: number): string {
	return `${duid}.${mapFlag}`;
}

/**
 * State names below `floors.<mapFlag>` that carry metadata instead of a room switch.
 *
 * Everything else in that folder is a room, keyed by its id. Kept here rather than next to one of
 * the readers because two of them exist - the segment cleaning collects the switches to decide
 * what to clean, the map renderer collects them to decide what to highlight - and a name that is
 * a room for one of them but metadata for the other would be a silent bug in both.
 */
export const NON_ROOM_STATE_NAMES: ReadonlySet<string> = new Set(["add_time", "load", "mapFlag", "map_id", "name"]);

/**
 * Whether a room switch state counts as "on".
 *
 * Deliberately tolerant: the switches are written by the admin tab, by vis widgets and by scripts,
 * and a script that writes `1` or `"true"` means the same thing a checkbox does.
 * @param value Raw state value.
 * @returns True when the room is selected.
 */
export function isRoomSwitchOn(value: unknown): boolean {
	return value === true || value === "true" || value === 1;
}

/**
 * Sorts room ids ascending and removes duplicates.
 * @param roomIds Ids in any order.
 * @returns A new ascending array.
 */
export function sortRoomIds(roomIds: Iterable<number> | undefined | null): number[] {
	return roomIds ? [...new Set(roomIds)].sort((left, right) => left - right) : [];
}

/**
 * Groups the room switches that are on by the floor they belong to.
 *
 * Grouping instead of flattening is the whole point: room ids repeat across the maps of one robot
 * (see the module header), so a caller has to say which floor it means before the ids mean
 * anything. Callers that know the active map pick their entry; callers that do not can at least
 * see that the answer is ambiguous instead of mixing floors.
 * @param states States below `Devices.<duid>.floors.*`, as returned by `getStatesAsync`.
 * @returns Map flag to the set of selected room ids on that floor; floors without a selection are absent.
 */
export function groupSelectedRoomsByMapFlag(
	states: Record<string, { val?: unknown } | null | undefined> | null | undefined
): Map<number, Set<number>> {
	const selectedByMapFlag = new Map<number, Set<number>>();
	if (!states) return selectedByMapFlag;

	for (const [stateId, state] of Object.entries(states)) {
		if (!state || !isRoomSwitchOn(state.val)) continue;

		const parts = stateId.split(".");
		const lastSegment = parts[parts.length - 1];
		if (!lastSegment || NON_ROOM_STATE_NAMES.has(lastSegment)) continue;

		const roomId = normalizeRoomId(lastSegment);
		const mapFlag = normalizeMapFlag(parts[parts.length - 2]);
		if (roomId === null || mapFlag === null) continue;

		let rooms = selectedByMapFlag.get(mapFlag);
		if (!rooms) {
			rooms = new Set<number>();
			selectedByMapFlag.set(mapFlag, rooms);
		}
		rooms.add(roomId);
	}
	return selectedByMapFlag;
}

/**
 * Converts an ioBroker `common.name` (string or translation object) into a display name.
 * @param value Raw `common.name` value.
 * @returns Trimmed display name, or an empty string when nothing usable is present.
 */
export function toDisplayName(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const candidate = typeof record.en === "string" ? record.en : Object.values(record).find((entry) => typeof entry === "string");
		if (typeof candidate === "string") return candidate.trim();
	}
	return "";
}

/** Minimal shape of a parsed map segment that can carry a display name. */
export interface NamedSegment {
	id?: number | null;
	name?: string;
}

/**
 * Fills empty segment names from the room states of exactly one map.
 *
 * Never falls back to another floor: when `mapFlag` is unknown the segments are left
 * untouched, because a name taken from a different map would be plain wrong on devices
 * that reuse room ids across maps.
 * @param segments Parsed segments of the map; names are filled in place.
 * @param duid Device unique id.
 * @param mapFlag Map flag (floor id) the segments belong to.
 * @param readRoomName Callback resolving an object id to its raw `common.name`.
 * @returns Number of segments that received a name.
 */
export async function enrichSegmentNamesFromRoomStates(
	segments: NamedSegment[],
	duid: string,
	mapFlag: unknown,
	readRoomName: (stateId: string) => Promise<unknown>
): Promise<number> {
	const flag = normalizeMapFlag(mapFlag);
	if (!duid || flag === null || !Array.isArray(segments)) return 0;

	let applied = 0;
	for (const segment of segments) {
		if (!segment || segment.name) continue;
		const roomId = normalizeRoomId(segment.id);
		if (roomId === null) continue;

		const name = toDisplayName(await readRoomName(roomStateId(duid, flag, roomId)));
		if (name) {
			segment.name = name;
			applied++;
		}
	}
	return applied;
}
