/**
 * Turns the `cleaningInfo` branch of the object tree into the model the history panel renders.
 *
 * ## Where the data comes from
 *
 * The adapter already fetches and stores everything shown here; the tab only reads it. Three
 * device pipelines write into the **same** folder but with **different field names**, so nothing
 * in here may assume one schema:
 *
 *  - **V1** (`src/lib/features/vacuum/v1VacuumFeatures.ts`): `updateCleanSummary()` at `:822`
 *    calls `get_clean_summary`, `syncV1CleanRecords()` at `:944` sorts the start times descending
 *    and `fetchAndSaveRecord()` at `:1014` writes `cleaningInfo.records.<index>.*`. Index 0 is the
 *    newest run. It also writes `startTime` as a plain number (`:1020`), divides `duration` by 60
 *    and `area`/`cleaned_area` by 1000000 (`:1031-1032`), and stores the rendered map under
 *    `records.<index>.map.mapBase64` (`:1041-1051`) - but **only** when `enable_map_creation` is
 *    on (`:1038`).
 *  - **B01** (`src/lib/features/vacuum/services/B01MapService.ts`): `processCleanSummary()` at
 *    `:219` sorts descending as well and `processRecordAttributes()` at `:314` writes every field
 *    of the device's own `detail` object **unconverted**, under `records.<index>.<key>`. Its map
 *    lands one level higher, at `records.<index>.mapBase64` (`:335`).
 *  - **Q10** (`src/lib/features/vacuum/b01/q10/Q10CleanRecordService.ts`): `applyQ10CleanRecordList()`
 *    at `:340` parses the `_`-separated record list of DP 52 into `record_id`, `timestamp`,
 *    `begin`, `clean_time`, `clean_area` and friends, sorted descending, and writes the map to
 *    `records.<index>.map.mapBase64` (`:87`).
 *
 * ## Why units are read from the object and never assumed
 *
 * Only the V1 path normalises: `VACUUM_CONSTANTS.cleaningRecords`
 * (`src/lib/features/vacuum/vacuumConstants.ts:800-834`) declares `duration` in `min` and
 * `area`/`cleaned_area` in `m²`, and `processResultKey` applies it. The B01 and Q10 paths write
 * the device's raw numbers with no unit at all. So this module takes the unit from
 * `common.unit` of the state object and shows a bare number when there is none - the same rule
 * the consumables and dock panels already follow. Inventing "minutes" for a B01 field would be a
 * guess, and a wrong duration is worse than a missing one.
 *
 * ## Why `begin` is not used as the timestamp
 *
 * On the V1 path `begin` and `end` are rewritten to `new Date(v * 1000).toLocaleString()` by
 * `processResultKey` (`src/lib/features/baseDeviceFeatures.ts:662-665`) - a string formatted in
 * the **adapter host's** locale, which the browser cannot parse back reliably. The numeric
 * `startTime` is written separately and is the one to use. B01 and Q10 keep `begin` numeric, so
 * the candidate list below accepts it, but only when the value really is a number in the plausible
 * range - the same bound the adapter itself uses in `isUnixTimestamp`
 * (`src/lib/features/vacuum/v1VacuumFeatures.ts:1114-1116`).
 */

import type { CleaningHistoryModel, CleaningRunModel, HistoryField, HistoryMeasure, HistoryStateDefinition, HistoryStateValue } from "./historyTypes";

/** Folder below the device object that carries the summary and the runs. */
export const HISTORY_FOLDER = "cleaningInfo";

/** Sub-folder holding one numbered folder per run. */
export const RECORDS_FOLDER = "records";

/**
 * Command that deletes one run, in the device's `commands` folder.
 *
 * Named here rather than in the source, because this module owns the shape of the history and this
 * is part of it. The adapter's side is `src/lib/features/vacuum/v1CleanRecordDelete.ts`.
 */
export const DELETE_RUN_COMMAND = "del_clean_record";

/**
 * Fields carrying the start of a run, most trustworthy first.
 *
 * `startTime` is the V1 path's own numeric copy, `timestamp` the Q10 one, `record_start_time` and
 * `begin` are what B01 devices send. See the module comment for why `begin` may be a string.
 */
const START_TIME_KEYS = ["startTime", "timestamp", "record_start_time", "begin"];

/** Lower bound of a plausible unix timestamp, mirroring `isUnixTimestamp` in the adapter. */
const MIN_UNIX_SECONDS = 946684800;

/** Upper bound of a plausible unix timestamp, mirroring `isUnixTimestamp` in the adapter. */
const MAX_UNIX_SECONDS = 4102444800;

/**
 * Relative paths a stored history map can live under, in the order they are looked for.
 *
 * Two, because the pipelines disagree: V1 and Q10 use the `map` sub-folder, B01 writes the image
 * directly into the record folder.
 */
const MAP_STATE_KEYS = ["map.mapBase64", "mapBase64"];

/**
 * Type of run, as the Roborock app names it.
 *
 * Proven twice over in the decompiled a65 control plugin
 * (`_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`):
 *
 *  1. The history row builder reads `CleanTabType[cleanType - 1]` (A65:874495-874631), and that
 *     table is built at A65:379659-379690 from, in order, `home_bottom_menu_global`,
 *     `home_bottom_menu_draw_zone`, `home_bottom_menu_select_zone`, `quick_build_map_start`,
 *     `video_patrol_record_video_patrol`, `video_patrol_record_pet_patrol`. The list is therefore
 *     **one-based**.
 *  2. The constant table right beside it spells the same thing out numerically:
 *     `CleanTypeCode = {CLEAN_TYPE_ALL_ZONE: 1, CLEAN_TYPE_DRAW_ZONE: 2, CLEAN_TYPE_SELECT_ZONE: 3,
 *     CLEAN_TYPE_QUICK_BUILD: 4, CLEAN_TYPE_VIDEO_PATROL: 5, CLEAN_TYPE_PET_PATROL: 6}` (A65:379692).
 *     Roborock's own Chinese debug table agrees for the first three: `ValueTranslation[252]`
 *     ("清扫类型") `= {1: 全屋, 2: 划区, 3: 选区}` (A65:379716).
 *
 * The recorded values of the test device match: whole-flat runs carry `clean_type: 1`, the short
 * room runs `clean_type: 3` (`src/lib/mock/mockData.ts:110-140`).
 *
 * A code outside the table is shown as the bare number rather than as a made-up name.
 */
export const CLEAN_TYPE_LABEL_KEYS: Record<number, string> = {
	1: "ui_history_type_full",
	2: "ui_history_type_zone",
	3: "ui_history_type_room",
	4: "ui_history_type_quick_map",
	5: "ui_history_type_cruise",
	6: "ui_history_type_pet_patrol",
};

/**
 * Why a run ended, keyed by `finish_reason`.
 *
 * This is Roborock's own table `CleanFinishCleanReasons`, read out of the a65 control plugin at
 * A65:379295-379500 (the function body) and named at A65:379500. Every entry below is one
 * `r0[<code>] = strings.<key>` pair of that function, in the order they appear; the wordings are
 * lifted from `lib/protocols/roborock_strings.json`, so the tab says what the app says.
 *
 * The table starts at code 21 - there is no lower entry. Codes it does not list are not an error:
 * the app falls back to the plain finished/interrupted wording, and so does
 * {@link resolveFinishReasonKey}.
 *
 * Cross-check against the test device: its completed runs carry 52 and 56, both of which map to
 * "Finished cleaning" here, and its single aborted run carries 60, which maps to "Cleaning
 * interrupted by user" - and that same record is the only one with `complete: 0`
 * (`src/lib/mock/mockData.ts:112-174`). Two independent sources agree.
 */
export const FINISH_REASON_LABEL_KEYS: Record<number, string> = {
	21: "ui_history_reason_manual",
	24: "ui_history_result_interrupted",
	29: "ui_history_reason_manual",
	32: "ui_history_reason_breakpoint",
	33: "ui_history_reason_breakpoint",
	34: "ui_history_result_interrupted",
	35: "ui_history_reason_manual",
	36: "ui_history_reason_manual",
	37: "ui_history_reason_manual",
	43: "ui_history_reason_manual",
	45: "ui_history_reason_locate_failed",
	48: "ui_history_reason_manual",
	49: "ui_history_reason_manual",
	50: "ui_history_reason_manual",
	51: "ui_history_result_interrupted",
	52: "ui_history_result_finished",
	54: "ui_history_result_finished",
	55: "ui_history_result_finished",
	56: "ui_history_result_finished",
	57: "ui_history_result_finished",
	60: "ui_history_reason_manual",
	61: "ui_history_reason_unreachable",
	62: "ui_history_reason_unreachable",
	64: "ui_history_result_interrupted",
	65: "ui_history_reason_locate_failed",
	67: "ui_history_reason_wash_error",
	68: "ui_history_reason_dock_return_failed",
	101: "ui_history_result_interrupted",
	102: "ui_history_reason_breakpoint",
	103: "ui_history_reason_manual",
	104: "ui_history_result_interrupted",
	105: "ui_history_result_interrupted",
	106: "ui_history_result_interrupted",
	107: "ui_history_result_interrupted",
	109: "ui_history_result_interrupted",
	110: "ui_history_result_interrupted",
	114: "ui_history_reason_cruise_completed",
	115: "ui_history_reason_cruise_failed",
	116: "ui_history_reason_pet_found",
	117: "ui_history_reason_pet_not_found",
};

/**
 * Summary values of the whole device, and the unit each of them is published with.
 *
 * All three pipelines agree on the names: the V1 path lists them in
 * `VACUUM_CONSTANTS.cleaningInfo` (`vacuumConstants.ts:835-842`, `clean_time` in `h`,
 * `clean_area` in `m²`), and B01 writes the same three through `updateSummaryState()`
 * (`B01MapService.ts:290-302`), dividing seconds by 3600 and mm² by 1000000. So both publish
 * hours and square metres; only the V1 objects also *declare* the unit, which is why the unit
 * still comes from the object rather than from this list.
 */
const SUMMARY_KEYS = ["clean_area", "clean_time", "clean_count"];

/** Fields the run model resolves by name; everything else is passed through as an extra. */
const CLAIMED_RECORD_KEYS = new Set([
	...START_TIME_KEYS,
	"duration",
	"area",
	"clean_type",
	"complete",
	"finish_reason",
	"wash_count",
	"mapBase64",
]);

/** Builds the object id of the history folder of one device. */
export function historyRoot(instanceId: string, duid: string): string {
	return `${instanceId}.Devices.${duid}.${HISTORY_FOLDER}`;
}

/**
 * Splits a state id below the history folder into the part the model cares about.
 * @param id Full object id.
 * @param root Result of {@link historyRoot}.
 * @returns Where the state belongs, or null when it is not below the folder at all.
 */
export function parseHistoryStateId(
	id: string,
	root: string,
): { scope: "summary"; key: string } | { scope: "record"; index: number; key: string } | null {
	if (!id.startsWith(`${root}.`)) return null;
	const rest = id.slice(root.length + 1);
	if (!rest) return null;

	const parts = rest.split(".");
	if (parts[0] !== RECORDS_FOLDER) {
		return { scope: "summary", key: rest };
	}

	// `records.<index>.<key>` and `records.<index>.map.<key>`; the key keeps its dots so the
	// map lookup below can ask for `map.mapBase64` in one go.
	if (parts.length < 3) return null;
	const index = Number(parts[1]);
	if (!Number.isInteger(index) || index < 0) return null;
	return { scope: "record", index, key: parts.slice(2).join(".") };
}

/** Reads a state value as a finite number, or null when it is anything else. */
function numericValue(state: HistoryStateValue | null | undefined): number | null {
	if (!state) return null;
	const value = Number(state.val);
	return Number.isFinite(value) ? value : null;
}

/** True for a number that can plausibly be a unix timestamp in seconds. */
function isUnixSeconds(value: number | null): value is number {
	return value !== null && value > MIN_UNIX_SECONDS && value < MAX_UNIX_SECONDS;
}

/** `common.unit` as a string; an object without one yields the empty string, never a guess. */
function unitOf(definition: HistoryStateDefinition | undefined): string {
	const unit = definition?.common?.unit;
	return typeof unit === "string" ? unit : "";
}

/**
 * Resolves `common.name`, which ioBroker allows to be a plain string or a per-language map.
 * @param name Raw `common.name`.
 * @param language Admin language.
 * @param fallback Shown when the object carries no usable name.
 */
export function historyStateName(name: unknown, language: string, fallback: string): string {
	if (typeof name === "string" && name.trim()) return name;
	if (name && typeof name === "object") {
		const translated = name as Record<string, unknown>;
		const candidate = translated[language] ?? translated.en;
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return fallback;
}

/**
 * How many of the numbered record folders are current.
 *
 * This exists because the V1 path never deletes: `syncV1CleanRecords()`
 * (`v1VacuumFeatures.ts:944-995`) shifts existing folders around and creates new ones, but a run
 * that drops off the end leaves its folder behind. Showing those would be showing runs the robot
 * no longer reports.
 *
 * Asked in order of how authoritative each source is: the Q10 path publishes `record_count`
 * outright (`Q10CleanRecordService.ts:384`), the V1 path writes one JSON array entry per current
 * run (`v1VacuumFeatures.ts:928-942`) and B01 the same list under a `records` member
 * (`B01MapService.ts:271-284`). With none of them present the caller keeps every folder it found -
 * too few runs is a worse answer than one stale run.
 * @param values Every state value below the history folder, keyed by full id.
 * @param root Result of {@link historyRoot}.
 * @returns The number of current runs, or null when nothing says.
 */
export function publishedRecordCount(values: Record<string, HistoryStateValue | null>, root: string): number | null {
	const count = numericValue(values[`${root}.record_count`]);
	if (count !== null && count >= 0) return Math.trunc(count);

	const json = values[`${root}.JSON`]?.val;
	if (typeof json !== "string" || !json.trim()) return null;

	try {
		const parsed: unknown = JSON.parse(json);
		if (Array.isArray(parsed)) return parsed.length;
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)) {
			return ((parsed as { records: unknown[] }).records).length;
		}
	} catch {
		// A JSON state the adapter could not fill, or a shape this build does not know. Falling
		// through to "no answer" keeps every folder rather than hiding runs over a parse error.
	}
	return null;
}

/**
 * Picks the wording for how a run ended.
 *
 * The algorithm is the app's own, read from the `descText` getter of the history detail page
 * (A65:878783-878830): look the code up in `CleanFinishCleanReasons`, and only when that yields
 * nothing fall back to the completion flag - `Finished cleaning` when it is set, `Cleanup
 * Interrupted` when it is not.
 * @param finishReason Value of `finish_reason`, or null when the device published none.
 * @param finished Value of {@link CleaningRunModel.finished}.
 * @returns Translation key, or null when neither field was published.
 */
export function resolveFinishReasonKey(finishReason: number | null, finished: boolean | null): string | null {
	if (finishReason !== null) {
		const key = FINISH_REASON_LABEL_KEYS[finishReason];
		if (key) return key;
	}
	if (finished === null) return null;
	return finished ? "ui_history_result_finished" : "ui_history_result_interrupted";
}

/** Assembles one measured value out of its state and its object definition. */
function measure(
	values: Record<string, HistoryStateValue | null>,
	definitions: Map<string, HistoryStateDefinition>,
	id: string,
): HistoryMeasure {
	return { value: numericValue(values[id]), unit: unitOf(definitions.get(id)) };
}

/**
 * Builds the history model out of everything published below the history folder.
 *
 * Runs are sorted by their start, newest first, and fall back to the folder index when a run
 * carries no usable timestamp. All three pipelines already write index 0 as the newest, so the
 * sort only guards against a half-written update - it never fights the adapter.
 * @param input Object definitions and state values below {@link historyRoot}.
 */
export function buildCleaningHistory(input: {
	root: string;
	definitions: HistoryStateDefinition[];
	values: Record<string, HistoryStateValue | null>;
	/** Admin language, used to resolve per-language object names. */
	language: string;
	/** Whether the device published a writable `commands.del_clean_record`. */
	canDelete?: boolean;
}): CleaningHistoryModel {
	const { root, values, language } = input;
	const definitions = new Map<string, HistoryStateDefinition>();
	for (const definition of input.definitions) definitions.set(definition.id, definition);

	const summary: HistoryField[] = [];
	for (const key of SUMMARY_KEYS) {
		const id = `${root}.${key}`;
		const value = numericValue(values[id]);
		if (value === null) continue;
		summary.push({
			key,
			name: historyStateName(definitions.get(id)?.common?.name, language, key),
			value,
			unit: unitOf(definitions.get(id)),
		});
	}

	// Which record folders exist at all. Taken from the objects rather than from the values so a
	// run whose states have not been filled yet still gets a row instead of vanishing.
	const indices = new Set<number>();
	for (const definition of definitions.values()) {
		const parsed = parseHistoryStateId(definition.id, root);
		if (parsed && parsed.scope === "record") indices.add(parsed.index);
	}

	const limit = publishedRecordCount(values, root);
	const runs: CleaningRunModel[] = [];

	for (const index of Array.from(indices).sort((a, b) => a - b)) {
		if (limit !== null && index >= limit) continue;

		const folder = `${root}.${RECORDS_FOLDER}.${index}`;
		const at = (key: string): string => `${folder}.${key}`;

		let startedAt: number | null = null;
		for (const key of START_TIME_KEYS) {
			const candidate = numericValue(values[at(key)]);
			if (isUnixSeconds(candidate)) {
				startedAt = candidate;
				break;
			}
		}

		const complete = numericValue(values[at("complete")]);
		const mapStateId = MAP_STATE_KEYS.map(at).find(id => definitions.has(id)) ?? null;

		const extras: HistoryField[] = [];
		for (const definition of definitions.values()) {
			const parsed = parseHistoryStateId(definition.id, root);
			if (!parsed || parsed.scope !== "record" || parsed.index !== index) continue;
			// The map images are shown as pictures, not as a base64 string in a table.
			if (parsed.key.startsWith("map.") || CLAIMED_RECORD_KEYS.has(parsed.key)) continue;

			const raw = values[definition.id]?.val;
			if (raw === undefined || raw === null) continue;
			if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;

			extras.push({
				key: parsed.key,
				name: historyStateName(definition.common?.name, language, parsed.key),
				value: raw,
				unit: unitOf(definition),
			});
		}
		extras.sort((a, b) => a.key.localeCompare(b.key));

		runs.push({
			index,
			startedAt,
			duration: measure(values, definitions, at("duration")),
			area: measure(values, definitions, at("area")),
			cleanType: numericValue(values[at("clean_type")]),
			// `complete !== 0` is the app's own reading: the history row builder computes
			// `isCleanFinished = (0 != status)` from exactly this field (A65:874641), and the
			// record field feeding `status` is `complete` (A65:875460).
			finished: complete === null ? null : complete !== 0,
			finishReason: numericValue(values[at("finish_reason")]),
			washCount: numericValue(values[at("wash_count")]),
			mapStateId,
			extras,
		});
	}

	runs.sort((a, b) => {
		if (a.startedAt !== null && b.startedAt !== null) return b.startedAt - a.startedAt;
		if (a.startedAt !== null) return -1;
		if (b.startedAt !== null) return 1;
		return a.index - b.index;
	});

	return { summary, runs, canDelete: input.canDelete === true };
}
