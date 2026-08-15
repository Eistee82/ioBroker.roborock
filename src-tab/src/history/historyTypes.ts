/**
 * The model the cleaning history panel renders, and the two ioBroker shapes it is built from.
 *
 * Kept apart from `cleaningHistory.ts` so the React components can import the types without
 * pulling in the proof tables, and so the source module stays free of view concerns.
 */

/** The slice of an ioBroker state value this branch reads. */
export interface HistoryStateValue {
	val: unknown;
}

/** The slice of an ioBroker state object this branch reads. */
export interface HistoryStateDefinition {
	id: string;
	common?: {
		name?: unknown;
		unit?: unknown;
		type?: unknown;
	};
}

/**
 * A number together with the unit the adapter declared for it.
 *
 * `unit` is empty whenever the object carries none - see the module comment of
 * `cleaningHistory.ts` for why that is not filled in with a guess.
 */
export interface HistoryMeasure {
	value: number | null;
	unit: string;
}

/** One published field, shown with the name and unit of its own object. */
export interface HistoryField {
	/** State name inside the folder, e.g. `avoid_count`. */
	key: string;
	/** Resolved `common.name`, falling back to the key. */
	name: string;
	value: string | number | boolean;
	unit: string;
}

/** One recorded cleaning run. */
export interface CleaningRunModel {
	/** Index of the folder the run lives in; 0 is the newest run the adapter wrote. */
	index: number;
	/** Start of the run in unix seconds, or null when no numeric timestamp was published. */
	startedAt: number | null;
	duration: HistoryMeasure;
	area: HistoryMeasure;
	/** `clean_type` as published; see `CLEAN_TYPE_LABEL_KEYS` for the wording. */
	cleanType: number | null;
	/** True when the run finished, false when it was cut short, null when nothing was published. */
	finished: boolean | null;
	/** `finish_reason` as published; see `FINISH_REASON_LABEL_KEYS`. */
	finishReason: number | null;
	/** Number of mop washes during the run, or null when the device published none. */
	washCount: number | null;
	/** Full id of the state holding the rendered map of this run, or null when none exists. */
	mapStateId: string | null;
	/** Every other published field of the run, sorted by name. */
	extras: HistoryField[];
}

/** The whole history of one device. */
export interface CleaningHistoryModel {
	/** Lifetime totals, in the order area, time, runs; a value the device never sent is absent. */
	summary: HistoryField[];
	/** Recorded runs, newest first. */
	runs: CleaningRunModel[];
}
