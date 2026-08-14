/**
 * What the station is doing with the mop, read out of the rows the dock panel already shows.
 *
 * The adapter derives those states below `dockingStationStatus` from the raw status fields the
 * Roborock app reads too - `wash_status`, `dry_status` and `rdt`. The derivation and the proof for
 * every single rule live in the adapter, in `StationService.updateWashAndDryStatus()`; nothing is
 * re-derived here. Read here is only what the summary line shows; the remaining station states
 * reach the panel through its ordinary row list.
 *
 * The one rule this module does enforce is the difference between "no" and "nothing said". A
 * device that publishes none of these states must read as unknown, never as idle: an idle station
 * and a silent one look the same from here, and only one of the two is harmless to claim.
 */

import type { DockActivityModel } from "./types";

/**
 * State names below `dockingStationStatus` the summary line reads by name.
 *
 * They stay ordinary rows of the panel's list as well - this is about reading them a second time
 * for the collapsed summary, not about hiding them.
 */
export const DOCK_ACTIVITY_STATES = {
	washing: "isWashing",
	washingMode: "washingMode",
	drying: "isDrying",
	dryRemainTime: "dryRemainTime",
} as const;

/** What a device that published nothing yet reports: unknown everywhere, never "no". */
export const EMPTY_DOCK_ACTIVITY: DockActivityModel = {
	washing: null,
	washingModeText: null,
	drying: null,
	dryRemainMinutes: null,
};

/** The part of a dock status row this module needs: where it lives and how it words its values. */
export interface DockStatusValueRow {
	stateId: string;
	states: Record<string, string> | null;
}

/**
 * Condenses the station rows into the summary the panel shows while collapsed.
 *
 * The wash mode is deliberately tied to `isWashing`: the adapter publishes the mode raw, and the
 * app only reads it while a wash task runs. A mode left over from the last cycle would otherwise
 * claim the station is self-cleaning while it stands idle.
 *
 * @param rows Station rows of the current device, with their full state ids.
 * @param values Last known value per state id.
 * @param folder Folder segment the rows live in, e.g. `dockingStationStatus`.
 */
export function readDockActivity(
	rows: readonly DockStatusValueRow[],
	values: Readonly<Record<string, unknown>>,
	folder: string,
): DockActivityModel {
	const raw = (name: string): unknown => {
		const row = rows.find(entry => entry.stateId.endsWith(`.${folder}.${name}`));
		if (!row) return null;
		const value = values[row.stateId];
		return value === undefined ? null : value;
	};

	const flag = (name: string): boolean | null => {
		const value = raw(name);
		if (value === null) return null;
		return value === true || value === "true" || value === 1;
	};

	const text = (name: string): string | null => {
		const row = rows.find(entry => entry.stateId.endsWith(`.${folder}.${name}`));
		if (!row?.states) return null;
		const value = values[row.stateId];
		if (value === null || value === undefined) return null;
		return row.states[String(value)] ?? null;
	};

	const number = (name: string): number | null => {
		const value = raw(name);
		// `Number(null)` is 0, and a 0 here would read as "done drying" rather than "not reported".
		if (value === null) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	};

	const washing = flag(DOCK_ACTIVITY_STATES.washing);

	return {
		washing,
		washingModeText: washing === true ? text(DOCK_ACTIVITY_STATES.washingMode) : null,
		drying: flag(DOCK_ACTIVITY_STATES.drying),
		dryRemainMinutes: number(DOCK_ACTIVITY_STATES.dryRemainTime),
	};
}
