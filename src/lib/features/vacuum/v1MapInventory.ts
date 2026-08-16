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
 * ## Whether a backup would be offered - and a correction to an earlier version of this file
 *
 * **This file previously claimed that the Roborock app shows an empty restore list on the test
 * device, and that was wrong.** The claim rested on `get_recover_maps` answering `unknown_method`,
 * which is true and measured - but that call belongs to a **different** flow.
 *
 * The app has two, and they share no call at all:
 *
 * | | "Reset map" (`reset_map_*`) | **"Map backup"** (`backup_map_new` / `recover_map_new`) |
 * | --- | --- | --- |
 * | Entry | its own page | map menu, `visible = isSupportBackupMap()` = **`new_feature_info` bit 49**, A65:725540-725576 |
 * | List from | `get_recover_maps`, `[id, time]` pairs, A65:461041-461052 | **`bak_maps` of `get_multi_maps_list`**, A65:708608-708625 |
 * | Restore | `recover_map(id)`, A65:461295-461300 | `recover_multi_map({map_flag})`, A65:691505-691530 |
 *
 * So both earlier readings were right about their own flow: the **old** one really is absent on
 * this robot, and bit 49 really does mean something - it unlocks the **new** one, which never asks
 * `get_recover_maps`. `_appanalysis/26-luecken-stand.md` §7 has the full derivation.
 *
 * The test device carries one backup per map, so **in the app that list would be populated**.
 * {@link MapInventoryStates.restoreSupported} therefore no longer probes the wrong call. It answers
 * the question the two proven halves can answer together:
 *
 * > Are there backups, and does this robot's menu offer them?
 *
 * **It does not say that restoring works.** `recover_multi_map` is a **write** and has never been
 * measured - deliberately, because it overwrites the map that is loaded, and Roborock's own warning
 * (`recover_map_hint`) says the schedules and commands attached to it stop working. Asking a robot
 * to prove a destructive call by making it is not a capability probe.
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
 * | `manual_bak_map` | `{map_flag: <flag of the **live** map>}` | wrapper A65:229411-229421, caller A65:691399 passes `RSM.currentMapId` | Replaces the one backup the robot keeps. See below - this one only *looks* harmless. |
 *
 * **Taking a backup is the entry on that list that reads as safe, and is not.** The robot states its
 * own ceiling in the very answer this file parses: `max_bak_map` is **1**, and each map arrives with
 * exactly one entry in `bak_maps`. There is no room for a second, so a new backup can only overwrite
 * the existing one.
 *
 * What that costs is visible in the same measurement. On the test device the ground floor's backup
 * is dated **2025-11-18** while the map itself is from 2026-08-14: pressing "back up" trades a
 * nine-month-old state for the current one, irreversibly, and this adapter cannot restore either of
 * them (see {@link MapInventoryStates.restoreSupported}). **The function would fail precisely when
 * it is wanted** - one backs up before doing something risky, which is exactly when the older state
 * is the valuable one.
 *
 * Roborock does **not** warn here: the string table has only button captions for `backup_map`, in 22
 * languages, and no hint text - while restoring gets an explicit one (`recover_map_hint`). That is an
 * *indication* that the vendor considers it harmless, not evidence, and the two cannot be told apart
 * without trying it on a device.
 *
 * **The two restore calls do not take the same number**, and that is the trap: `recover_multi_map`
 * is handed the flag of the map that is loaded, not the flag inside `bak_maps`. On the test device
 * that is 0 or 1, while the backups call themselves 4 and 5. Passing a `bak_maps` flag there would
 * name a different map. Proven twice over, at A65:691527-691530 and again at A65:919178-919180 -
 * both pass `RSM.currentMapId`.
 *
 * **And the payload never names the backup.** `{map_flag}` is the whole of it: which of the stored
 * backups the robot is meant to load appears nowhere in the request. On a robot that keeps **one**
 * backup per map - the test device's `max_bak_map` is 1 - that is unambiguous. Whether a robot with
 * several can be told which one is **not answerable from this bundle**, and it is the first thing
 * to establish before a restore button is built for such a device.
 */

/** RPC that lists the map slots, their names and their backups. */
export const GET_MULTI_MAPS_LIST = "get_multi_maps_list";

/**
 * Bit of `new_feature_info` that decides whether the robot's map menu offers backup and restore.
 *
 * `isSupportBackupMap()` in the control plugin; it is the whole `visible` condition of both menu
 * items (A65:725540-725576). Without it the app shows no restore entry at all, however many
 * backups the robot lists.
 *
 * Bit 49 is **above** 32, so a plain `value & (1 << 49)` would silently give the wrong answer -
 * JavaScript's bit operators truncate to 32 bits. The app hits the same wall and divides instead
 * (`(robotNewFeatures / 2**32) >> s & m`, A65:234000-234037); {@link backupMenuOffered} does the
 * same. `MapEditService` gets away with `&` only because its bit 26 is below the cut.
 */
export const BACKUP_MAP_FEATURE_BIT = 49;

/** State the feature bitfield arrives in; `processStatus` turns every unhandled key into one. */
export const NEW_FEATURE_INFO_STATE = "deviceStatus.new_feature_info";

/**
 * Reads bit 49 out of a `new_feature_info` value.
 *
 * @param raw Value of the `new_feature_info` state, in whatever shape it was stored.
 * @returns True or false when the field could be read, **null when it could not** - and the two
 *   are different answers. "The robot says no" is a fact; "the robot never told us" is not, and
 *   turning the second into the first is exactly the mistake this state is being repaired from.
 */
export function backupMenuOffered(raw: unknown): boolean | null {
	if (raw === undefined || raw === null || raw === "") return null;
	const value = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(value) || value < 0) return null;

	const high = Math.floor(value / 2 ** 32);
	return (high & (1 << (BACKUP_MAP_FEATURE_BIT - 32))) !== 0;
}

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

		// Published from here rather than from the feature class, because it needs this very list:
		// the count of `bak_maps` is one of its two inputs. Asking for it beside the list read - as
		// the removed probe did - meant the answer could be computed before the list had arrived.
		await this.publishRestoreSupport();
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
	 * Publishes whether a restore would be offered for the backups listed beside it.
	 *
	 * Two proven halves, and both are needed:
	 *
	 * - **there is something to restore** - `bak_maps` is not empty, which is the list the app's
	 *   own restore page is built from;
	 * - **the robot's menu offers it** - `new_feature_info` bit 49, the whole `visible` condition
	 *   of both menu entries.
	 *
	 * Neither alone would do. Without the bit the app shows no entry however many backups exist;
	 * without backups the entry is there and empty.
	 *
	 * **When the bit cannot be read the count decides alone.** That is a deliberate asymmetry: a
	 * cleared bit is the robot saying no and is reported as such, but a *missing* field says
	 * nothing, and answering "no" to it would recreate the exact fault this method was repaired
	 * from - a state that told the user his robot cannot do something nobody had established.
	 *
	 * The published value never claims that restoring **works**; see the file comment. It claims
	 * that backups exist and that the app would offer them.
	 */
	public async publishRestoreSupport(): Promise<void> {
		const backups = this.inventory ? allBackups(this.inventory).length : 0;
		const menuOffered = backupMenuOffered(await this.readNewFeatureInfo());
		const offered = backups > 0 && menuOffered !== false;

		await this.stateWriter.ensureFolder(MAP_INVENTORY_FOLDER);
		await this.stateWriter.ensureAndSetState(MapInventoryStates.restoreSupported, {
			name: "A stored backup would be offered for restoring",
			desc:
				"True when the robot lists at least one backup and its firmware offers the restore menu "
				+ "(new_feature_info bit 49). This adapter has no restore button; the state says whether the "
				+ "Roborock app would show one, not that restoring has been tried.",
			type: "boolean",
			role: "indicator",
			read: true,
			write: false
		}, offered);
	}

	/** Reads the feature bitfield, or null when it is not there. Never throws. */
	private async readNewFeatureInfo(): Promise<unknown> {
		try {
			const state = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.${NEW_FEATURE_INFO_STATE}`);
			return state?.val ?? null;
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined,
				`Could not read ${NEW_FEATURE_INFO_STATE}, judging the restore menu by the backup count alone: ${this.deps.adapter.errorMessage(e)}`, "debug");
			return null;
		}
	}
}
