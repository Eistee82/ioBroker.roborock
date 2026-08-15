import type { FeatureDependencies } from "../baseDeviceFeatures";
import { DeviceStateWriter } from "../deviceStateWriter";

/**
 * Which map the robot currently has loaded, and what backups it says exist.
 *
 * Read-only. Nothing here deletes, restores or renames a map; see "What is deliberately absent"
 * below for the payloads that were established anyway, so that nobody has to read them again.
 *
 * ## What was already there, and what this adds
 *
 * `V1MapService` has published one folder per map for a long time -
 * `floors.<mapFlag>.{name, mapFlag, add_time, load}` plus the global counts - out of the answer of
 * `get_multi_maps_list`. Two things it drops, and both matter on a robot with more than one floor:
 *
 * 1. **Which of those maps is loaded right now.** The adapter knows: it derives the slot from the
 *    status field `map_status` (`V1MapService.updateCurrentMapIndex`, `mapStatus >> 2`) and uses it
 *    internally for room mapping. It was never written down anywhere a user or a script can see it,
 *    so a list of floors gave no way to tell which one the robot is on.
 * 2. **The backups.** Every entry of `map_info` carries a `bak_maps` array, and it is discarded.
 *    On the test device both floors have one:
 *    `{"mapFlag":0,"name":"Erdgeschoss","bak_maps":[{"mapFlag":4,"add_time":1786781087}]}`.
 *
 * ## `get_map_status` is deliberately not used
 *
 * The obvious way to publish the active map would be `get_map_status`, and the gap report suggests
 * it. Three findings argue against it, and together they are decisive:
 *
 * - **The app never calls it.** `getMapStatus` (A65:228760-228775) has no caller anywhere in the
 *   control plugin, so there is no code that shows how its answer is meant to be read. Same shape
 *   as `set_airdry_hours` in `_appanalysis/18-funktionsluecken.md` §C18.
 * - **Its answer is not the status field.** Measured on the test device, `get_map_status` returns
 *   `[1]` while the status packet of the same robot carries `map_status: 3`
 *   (`_appanalysis/geraetefaehigkeiten-1786790619395.json`, `_appanalysis/local-mitschnitt.log`).
 *   Both give slot 0 under `>> 2`, but the low bits differ and nothing read says what they mean.
 * - **It would add nothing.** The adapter already receives `map_status` in every status poll.
 *
 * So the active map is published from the value the adapter already has, and no new request is
 * made for it. `get_segment_status` is left out for the first of those reasons alone: its wrapper
 * (A65:228968-228983) has no caller either, and its `[1]` is undecoded.
 *
 * ## Whether the robot can restore a backup is asked, not assumed
 *
 * `bak_maps` promises something the robot may not be able to deliver. The app's restore flow starts
 * at `get_recover_maps` (A65:228906-228921, caller A65:461041-461052), which turns the answer into
 * a list of `{id, time}` pairs - and **the test device answers `unknown_method`**. So on that robot
 * the app's own restore list is empty although two backups are listed.
 *
 * That is worth saying out loud rather than hiding, which is why {@link RESTORE_PROBE} is asked
 * once and the answer published as {@link MapInventoryStates.restoreSupported}. A user who sees a
 * backup dated last week and no way to use it deserves to know it is the robot refusing, not the
 * adapter lacking a button.
 *
 * ## What is deliberately absent, with the payloads for whoever builds them
 *
 * None of these is built here. All three are destructive or a write, and the assignment for this
 * round was the reading half. The payloads are written down so the next round does not have to
 * read them again - **each still needs its own capability question, which none of them has.**
 *
 * | RPC | Payload | Fundstelle | Why not here |
 * | --- | --- | --- | --- |
 * | `recover_multi_map` | `{map_flag: <flag of the **live** map>}` | wrapper A65:229563-229574, caller A65:691527-691529 passes `RSM.currentMapId` | Overwrites the current map. Roborock's own warning `recover_map_hint` says the schedules and commands attached to it stop working. |
 * | `recover_map` | `[id]` | A65:229545-229562, caller A65:461298 | Same, and its `id` comes from the `get_recover_maps` list this robot does not answer. |
 * | `del_map` | `[id]` | A65:228119-228136 | Deletes a map irreversibly. |
 *
 * **The two restore calls do not take the same number**, and that is the trap: `recover_multi_map`
 * is handed the flag of the map that is loaded, not the flag inside `bak_maps`. On the test device
 * that is 0 or 1, while the backups call themselves 4 and 5. Passing a `bak_maps` flag there would
 * name a different map.
 */

/** RPC that lists the map slots, their names and their backups. */
export const GET_MULTI_MAPS_LIST = "get_multi_maps_list";

/** RPC whose answer decides whether the robot offers restoring at all. */
export const RESTORE_PROBE = "get_recover_maps";

/** Folder this module publishes into. Deliberately not `floors`, which `V1MapService` owns. */
export const MAP_INVENTORY_FOLDER = "mapInventory";

/** One backup the robot reports for a map. */
export interface MapBackup {
	/** Slot the backup itself occupies; **not** what `recover_multi_map` is given. */
	mapFlag: number;
	/** When it was taken, as reported (seconds since the epoch), or null. */
	addTime: number | null;
	/** Slot of the map it belongs to. */
	ofMapFlag: number;
	/** Name of the map it belongs to, or null when the robot named none. */
	ofMapName: string | null;
}

/** One map slot the robot reports. */
export interface MapSlot {
	mapFlag: number;
	name: string | null;
	addTime: number | null;
	backups: MapBackup[];
}

/** Everything `get_multi_maps_list` says. */
export interface MapInventory {
	/** How many map slots the robot has, or null when it did not say. */
	maxMaps: number | null;
	/** How many backups it keeps per map, or null. */
	maxBackups: number | null;
	/** How many slots are in use, or null. */
	mapCount: number | null;
	maps: MapSlot[];
}

/** Reads a finite number, or null. */
function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Reads a non-empty string, or null. */
function textOrNull(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * Reads the answer of `get_multi_maps_list`.
 *
 * The answer arrives as a one element array around the object; both shapes are accepted because the
 * request layer unwraps inconsistently across the transports.
 *
 * A slot without a usable `mapFlag` is skipped rather than given an invented one: the flag is what
 * every other state in this adapter keys a floor by, and a wrong one would attach a backup to the
 * wrong floor - on a two-floor robot, to the other one.
 *
 * @param response Raw robot answer.
 * @returns The inventory, or null when the answer carries no `map_info`.
 */
export function parseMultiMapsList(response: unknown): MapInventory | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];

	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const source = payload as Record<string, unknown>;

	const rawMaps = source.map_info;
	if (!Array.isArray(rawMaps)) return null;

	const maps: MapSlot[] = [];
	for (const entry of rawMaps) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const slot = entry as Record<string, unknown>;

		const mapFlag = finiteNumber(slot.mapFlag ?? slot.mapflag);
		if (mapFlag === null || !Number.isInteger(mapFlag) || mapFlag < 0) continue;

		const name = textOrNull(slot.name);
		const backups: MapBackup[] = [];
		if (Array.isArray(slot.bak_maps)) {
			for (const rawBackup of slot.bak_maps) {
				if (!rawBackup || typeof rawBackup !== "object" || Array.isArray(rawBackup)) continue;
				const backup = rawBackup as Record<string, unknown>;
				const backupFlag = finiteNumber(backup.mapFlag ?? backup.mapflag);
				if (backupFlag === null) continue;
				backups.push({
					mapFlag: backupFlag,
					addTime: finiteNumber(backup.add_time),
					ofMapFlag: mapFlag,
					ofMapName: name
				});
			}
		}

		maps.push({ mapFlag, name, addTime: finiteNumber(slot.add_time), backups });
	}

	return {
		maxMaps: finiteNumber(source.max_multi_map),
		maxBackups: finiteNumber(source.max_bak_map),
		mapCount: finiteNumber(source.multi_map_count),
		maps
	};
}

/** Every backup of every map, flattened, oldest map first. */
export function allBackups(inventory: MapInventory): MapBackup[] {
	return inventory.maps.flatMap((slot) => slot.backups);
}

/** State names this module owns, so a test names them once. */
export const MapInventoryStates = {
	activeMapFlag: `${MAP_INVENTORY_FOLDER}.activeMapFlag`,
	activeMapName: `${MAP_INVENTORY_FOLDER}.activeMapName`,
	backups: `${MAP_INVENTORY_FOLDER}.backups`,
	backupCount: `${MAP_INVENTORY_FOLDER}.backupCount`,
	restoreSupported: `${MAP_INVENTORY_FOLDER}.restoreSupported`
} as const;

/**
 * Publishes the map inventory.
 *
 * Holds no timer and no subscription, so there is nothing for `onUnload` to clean up.
 */
export class V1MapInventoryService {
	private readonly stateWriter: DeviceStateWriter;

	/** Last inventory read, so the active map can be named without asking again. */
	private inventory: MapInventory | null = null;

	/** Last active flag published, so an unchanged status poll writes nothing. */
	private publishedFlag: number | null = null;

	constructor(
		private readonly deps: FeatureDependencies,
		private readonly duid: string
	) {
		this.stateWriter = new DeviceStateWriter(deps, duid);
	}

	/**
	 * Publishes what the robot answers about its maps and their backups.
	 *
	 * @param response Raw answer of `get_multi_maps_list`.
	 * @returns Whether an inventory was published.
	 */
	public async applyMultiMapsList(response: unknown): Promise<boolean> {
		const inventory = parseMultiMapsList(response);
		if (!inventory) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable get_multi_maps_list answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		this.inventory = inventory;
		const backups = allBackups(inventory);

		await this.stateWriter.ensureFolder(MAP_INVENTORY_FOLDER);
		await this.stateWriter.ensureAndSetState(MapInventoryStates.backupCount, {
			name: "Stored map backups",
			type: "number",
			role: "value",
			read: true,
			write: false
		}, backups.length);

		// A JSON state rather than one folder per backup: the robot keeps at most `max_bak_map` of
		// them per map - one on the test device - and they come and go with the robot's own
		// housekeeping. Objects that appear and vanish are the thing the room-switch pruning had to
		// be built for; a single value that is simply rewritten has no such problem.
		await this.stateWriter.ensureAndSetState(MapInventoryStates.backups, {
			name: "Stored map backups",
			desc: "Read-only. This adapter cannot restore a backup; see mapInventory.restoreSupported.",
			type: "string",
			role: "json",
			read: true,
			write: false
		}, JSON.stringify(backups));

		// Re-publish the active map's name, which may have changed with the list.
		await this.publishActiveMap(this.publishedFlag, true);
		return true;
	}

	/**
	 * Publishes which map is loaded.
	 *
	 * The flag comes from what the adapter already derives from the status packet, so this costs no
	 * request. Called on every status poll and therefore guarded: only a change is written.
	 *
	 * @param mapFlag Active slot, or null while none is known.
	 * @param force Write even when the flag did not change; used after the list was re-read.
	 * @returns Whether anything was written.
	 */
	public async publishActiveMap(mapFlag: number | null, force = false): Promise<boolean> {
		if (!force && mapFlag === this.publishedFlag) return false;
		this.publishedFlag = mapFlag;

		const name = mapFlag === null
			? null
			: (this.inventory?.maps.find((slot) => slot.mapFlag === mapFlag)?.name ?? null);

		await this.stateWriter.ensureFolder(MAP_INVENTORY_FOLDER);
		await this.stateWriter.ensureAndSetState(MapInventoryStates.activeMapFlag, {
			name: "Active map",
			desc: "Which of the robot's map slots is loaded right now.",
			type: "number",
			role: "value",
			read: true,
			write: false
		}, mapFlag);
		// Named in plain English rather than through the Roborock catalogue: it has no key for
		// "name of the loaded map", and pointing at one that resolves to nothing only looks like a
		// translation. The map's own name, which this state carries, is the robot's own wording.
		await this.stateWriter.ensureAndSetState(MapInventoryStates.activeMapName, {
			name: "Active map name",
			type: "string",
			role: "text",
			read: true,
			write: false
		}, name);
		return true;
	}

	/**
	 * Publishes whether the robot offers restoring a backup at all.
	 *
	 * @param supported What the probe of {@link RESTORE_PROBE} concluded.
	 */
	public async publishRestoreSupport(supported: boolean): Promise<void> {
		await this.stateWriter.ensureFolder(MAP_INVENTORY_FOLDER);
		await this.stateWriter.ensureAndSetState(MapInventoryStates.restoreSupported, {
			name: "Robot can restore a map backup",
			desc: "Answered by the robot itself. When false, the backups listed beside this are not usable - not even in the Roborock app.",
			type: "boolean",
			role: "indicator",
			read: true,
			write: false
		}, supported);
	}
}
