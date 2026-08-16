/**
 * The shape of `mapInventory.maps`, and how to read it back.
 *
 * Here rather than in `src/lib/features/vacuum/v1MapInventory.ts` for the same reason
 * {@link ../lib/features/vacuum/../../common/mapNameLength} is here: the admin tab shows this list
 * and cannot import a feature service - that file reaches `DeviceStateWriter` and from there the
 * whole adapter. The **writer** of the state stays where it belongs, beside the parser of
 * `get_multi_maps_list`; only the contract between the two sides lives here, so that a change to it
 * cannot be made on one side alone.
 *
 * The state itself is a JSON string, which means it crosses to the browser as text that nobody
 * validated on the way. {@link parseMapList} is therefore written to survive anything - an empty
 * state before the first read, an old adapter that never wrote it, a value somebody edited by hand -
 * and to drop what it cannot read rather than to throw. A list that half arrived is still a list; a
 * panel that threw is a blank page.
 */

/**
 * One map slot, as `mapInventory.maps` publishes it.
 *
 * Deliberately not the robot's own wording: `mapFlag` is kept because every other state in this
 * adapter keys a floor by it, but `add_time` becomes `addTime` like everything else this adapter
 * hands to the tab, and the backups are reduced to the two facts a reader can act on.
 */
export interface MapListEntry {
	/** Slot, the `mapFlag` of `get_multi_maps_list`. */
	mapFlag: number;
	/**
	 * What the robot calls it, or **null when it named none**.
	 *
	 * Null rather than an invented `Map 0`: a reader could otherwise not tell a map the user really
	 * called "Map 0" from one that has no name at all, and a rename dialog would offer to replace a
	 * name that does not exist with the identical text. Whoever displays the list may of course put a
	 * placeholder on the screen - that is a label, not data.
	 */
	name: string | null;
	/**
	 * When the map was last saved, in seconds since the epoch, or null.
	 *
	 * "Last saved", not "created": measured across two read-only sweeps 4 h 47 min apart
	 * (`_appanalysis/23-geraetefaehigkeiten-runde2.md`), the ground floor's `add_time` moved twelve
	 * seconds after the robot finished driving back to the dock, while the cellar - never cleaned -
	 * kept its stamp from the year before.
	 */
	addTime: number | null;
	/** How many backups the robot lists for this map. */
	backupCount: number;
	/** Newest backup's timestamp in seconds since the epoch, or null when there is none. */
	lastBackupTime: number | null;
}

/** Reads a finite number, or null. States carry whatever was written, including strings. */
function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the value of `mapInventory.maps`.
 *
 * @param raw The state value: the JSON string the adapter writes, or the parsed array.
 * @returns The slots it could read, in the order they were listed; an empty list for anything else.
 */
export function parseMapList(raw: unknown): MapListEntry[] {
	let value: unknown = raw;
	if (typeof value === "string") {
		const text = value.trim();
		if (text === "") return [];
		try {
			value = JSON.parse(text);
		} catch {
			// An unparsable state is "no list", not an error to show: the panel simply stays away,
			// which is what it does for a robot that never published the state either.
			return [];
		}
	}

	if (!Array.isArray(value)) return [];

	const entries: MapListEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;

		// A row without a usable slot is dropped rather than given an invented one. The flag is what a
		// rename is addressed to, and a wrong one would rename the other floor.
		const mapFlag = finiteNumber(record.mapFlag);
		if (mapFlag === null || !Number.isInteger(mapFlag) || mapFlag < 0) continue;

		const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name : null;
		const backupCount = finiteNumber(record.backupCount);

		entries.push({
			mapFlag,
			name,
			addTime: finiteNumber(record.addTime),
			backupCount: backupCount !== null && backupCount > 0 ? Math.trunc(backupCount) : 0,
			lastBackupTime: finiteNumber(record.lastBackupTime)
		});
	}
	return entries;
}
