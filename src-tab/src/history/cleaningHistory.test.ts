import { describe, expect, it } from "vitest";
import {
	CLEAN_TYPE_LABEL_KEYS,
	FINISH_REASON_LABEL_KEYS,
	buildCleaningHistory,
	historyRoot,
	parseHistoryStateId,
	publishedRecordCount,
	resolveFinishReasonKey,
} from "./cleaningHistory";
import type { HistoryStateDefinition, HistoryStateValue } from "./historyTypes";

/**
 * How the `cleaningInfo` branch becomes the history model.
 *
 * The three device pipelines write **different** field names into the same folder, so the fixtures
 * below are modelled on what each one really produces:
 *
 *  - the V1 record is the recorded answer of the test device (`src/lib/mock/mockData.ts:110-140`),
 *    put through the conversions `v1VacuumFeatures.ts:1031-1032` applies (seconds -> minutes,
 *    mm² -> m²) and with `begin` rewritten to a host-locale string the way
 *    `baseDeviceFeatures.ts:662-665` does it;
 *  - the B01 record keeps the device's raw numbers with no declared unit
 *    (`B01MapService.ts:314-327`);
 *  - the Q10 record is the `_`-separated list of DP 52 (`Q10CleanRecordService.ts:340-402`).
 */

const ROOT = historyRoot("roborock.0", "duid1");

/** Builds the two maps `buildCleaningHistory` takes out of a flat description of the branch. */
function branch(entries: Record<string, { val: unknown; unit?: string; name?: unknown }>): {
	definitions: HistoryStateDefinition[];
	values: Record<string, HistoryStateValue | null>;
} {
	const definitions: HistoryStateDefinition[] = [];
	const values: Record<string, HistoryStateValue | null> = {};
	for (const [key, entry] of Object.entries(entries)) {
		const id = `${ROOT}.${key}`;
		definitions.push({ id, common: { unit: entry.unit, name: entry.name } });
		values[id] = { val: entry.val };
	}
	return { definitions, values };
}

function build(entries: Record<string, { val: unknown; unit?: string; name?: unknown }>, language = "en") {
	return buildCleaningHistory({ root: ROOT, language, ...branch(entries) });
}

/** One V1 run as the adapter stores it, at the given folder index. */
function v1Run(index: number, over: Record<string, { val: unknown; unit?: string }> = {}) {
	return {
		[`records.${index}.startTime`]: { val: 1765198801 },
		[`records.${index}.begin`]: { val: "12/8/2025, 2:00:01 PM" },
		[`records.${index}.end`]: { val: "12/8/2025, 3:40:16 PM" },
		[`records.${index}.duration`]: { val: 76, unit: "min" },
		[`records.${index}.area`]: { val: 51, unit: "m²" },
		[`records.${index}.complete`]: { val: 1 },
		[`records.${index}.clean_type`]: { val: 1 },
		[`records.${index}.finish_reason`]: { val: 52 },
		[`records.${index}.wash_count`]: { val: 5 },
		[`records.${index}.avoid_count`]: { val: 50 },
		[`records.${index}.map.mapBase64`]: { val: "data:image/png;base64,AAAA" },
		...over,
	};
}

describe("parseHistoryStateId", () => {
	it("tells summary states from record states", () => {
		expect(parseHistoryStateId(`${ROOT}.clean_count`, ROOT)).toEqual({ scope: "summary", key: "clean_count" });
		expect(parseHistoryStateId(`${ROOT}.records.3.area`, ROOT)).toEqual({ scope: "record", index: 3, key: "area" });
	});

	it("keeps the map sub-folder in the key so it can be looked up in one go", () => {
		expect(parseHistoryStateId(`${ROOT}.records.0.map.mapBase64`, ROOT)).toEqual({
			scope: "record",
			index: 0,
			key: "map.mapBase64",
		});
	});

	it("rejects anything outside the folder and any non-numeric index", () => {
		expect(parseHistoryStateId("roborock.0.Devices.duid1.consumables.filter", ROOT)).toBeNull();
		expect(parseHistoryStateId(`${ROOT}.records.abc.area`, ROOT)).toBeNull();
		expect(parseHistoryStateId(`${ROOT}.records.2`, ROOT)).toBeNull();
	});
});

describe("publishedRecordCount", () => {
	it("prefers the Q10 counter", () => {
		const { values } = branch({ record_count: { val: 4 }, JSON: { val: "[1,2]" } });
		expect(publishedRecordCount(values, ROOT)).toBe(4);
	});

	it("counts the V1 JSON array", () => {
		const { values } = branch({ JSON: { val: JSON.stringify([{ begin: 1 }, { begin: 2 }, null]) } });
		expect(publishedRecordCount(values, ROOT)).toBe(3);
	});

	it("counts the records member of the B01 JSON object", () => {
		const { values } = branch({ JSON: { val: JSON.stringify({ clean_count: 9, records: [{}, {}] }) } });
		expect(publishedRecordCount(values, ROOT)).toBe(2);
	});

	it("answers null rather than zero when nothing says", () => {
		const { values } = branch({ JSON: { val: "not json" } });
		expect(publishedRecordCount(values, ROOT)).toBeNull();
		expect(publishedRecordCount({}, ROOT)).toBeNull();
	});
});

describe("buildCleaningHistory - V1", () => {
	it("reads start, duration, area, type, result and map of a run", () => {
		const history = build({ ...v1Run(0) });

		expect(history.runs).toHaveLength(1);
		const run = history.runs[0];
		expect(run.startedAt).toBe(1765198801);
		expect(run.duration).toEqual({ value: 76, unit: "min" });
		expect(run.area).toEqual({ value: 51, unit: "m²" });
		expect(run.cleanType).toBe(1);
		expect(run.finished).toBe(true);
		expect(run.finishReason).toBe(52);
		expect(run.washCount).toBe(5);
		expect(run.mapStateId).toBe(`${ROOT}.records.0.map.mapBase64`);
	});

	it("takes the timestamp from startTime and never parses the host-locale begin", () => {
		// `begin` is a string here on purpose - that is what the adapter writes on the V1 path,
		// formatted in the *adapter host's* locale. Parsing it in the browser would be a guess.
		const history = build({ ...v1Run(0), [`records.0.startTime`]: { val: 0 } });
		expect(history.runs[0].startedAt).toBeNull();
	});

	it("marks a run the robot cut short", () => {
		const history = build({ ...v1Run(0, { "records.0.complete": { val: 0 }, "records.0.finish_reason": { val: 60 } }) });
		expect(history.runs[0].finished).toBe(false);
	});

	it("leaves finished unknown when the device published no complete flag", () => {
		const entries = v1Run(0);
		delete entries["records.0.complete"];
		expect(build(entries).runs[0].finished).toBeNull();
	});

	it("passes unclaimed fields through with their object name and unit", () => {
		const history = build({
			...v1Run(0),
			"records.0.avoid_count": { val: 50, name: "Avoid Count" },
			"records.0.cleaned_area": { val: 54, unit: "m²" },
		});

		// `begin` is missing on purpose: it is one of the timestamp candidates, so it is consumed
		// by the model and not repeated as a raw value - on the V1 path it is the same moment
		// again, only formatted in the adapter host's locale.
		const extras = history.runs[0].extras;
		expect(extras.map(entry => entry.key)).toEqual(["avoid_count", "cleaned_area", "end"]);
		expect(extras.find(entry => entry.key === "avoid_count")).toEqual({
			key: "avoid_count",
			name: "Avoid Count",
			value: 50,
			unit: "",
		});
	});

	it("never lists a map image among the extra values", () => {
		const history = build({ ...v1Run(0) });
		expect(history.runs[0].extras.some(entry => entry.key.includes("mapBase64"))).toBe(false);
	});
});

describe("buildCleaningHistory - other pipelines", () => {
	it("reads a B01 record, whose fields carry no declared unit", () => {
		const history = build({
			"records.0.record_start_time": { val: 1765198801 },
			"records.0.duration": { val: 4538 },
			"records.0.area": { val: 51290000 },
			"records.0.mapBase64": { val: "data:image/png;base64,AAAA" },
		});

		const run = history.runs[0];
		expect(run.startedAt).toBe(1765198801);
		// No unit is declared, so none is shown - the number is the device's raw one.
		expect(run.duration).toEqual({ value: 4538, unit: "" });
		expect(run.area).toEqual({ value: 51290000, unit: "" });
		expect(run.mapStateId).toBe(`${ROOT}.records.0.mapBase64`);
	});

	it("reads the Q10 timestamp and leaves its unproven fields as extras", () => {
		const history = build({
			"records.0.record_id": { val: "abc" },
			"records.0.timestamp": { val: 1765198801 },
			"records.0.begin": { val: "12/08 14:00" },
			"records.0.clean_time": { val: 4538 },
			"records.0.clean_area": { val: 51290000 },
		});

		const run = history.runs[0];
		expect(run.startedAt).toBe(1765198801);
		expect(run.duration.value).toBeNull();
		expect(run.extras.map(entry => entry.key)).toContain("clean_time");
	});
});

describe("buildCleaningHistory - list and totals", () => {
	it("sorts the runs newest first even when the folders are not in order", () => {
		const history = build({
			...v1Run(0, { "records.0.startTime": { val: 1764939602 } }),
			...v1Run(1, { "records.1.startTime": { val: 1765198801 } }),
			...v1Run(2, { "records.2.startTime": { val: 1764766801 } }),
			record_count: { val: 3 },
		});

		expect(history.runs.map(run => run.startedAt)).toEqual([1765198801, 1764939602, 1764766801]);
	});

	it("drops the folders a shrunken record list left behind", () => {
		// The V1 path shifts folders but never deletes them (`v1VacuumFeatures.ts:944-995`), so a
		// stale folder outlives the run it belonged to.
		const history = build({
			...v1Run(0),
			...v1Run(1, { "records.1.startTime": { val: 1764939602 } }),
			...v1Run(2, { "records.2.startTime": { val: 1700000000 } }),
			JSON: { val: JSON.stringify([{}, {}]) },
		});

		expect(history.runs.map(run => run.index)).toEqual([0, 1]);
	});

	it("keeps every folder when nothing publishes a count", () => {
		const history = build({ ...v1Run(0), ...v1Run(1, { "records.1.startTime": { val: 1764939602 } }) });
		expect(history.runs).toHaveLength(2);
	});

	it("reads the lifetime totals with their declared units, in a fixed order", () => {
		const history = build({
			clean_count: { val: 190 },
			clean_area: { val: 6047, unit: "m²" },
			clean_time: { val: 123, unit: "h" },
		});

		expect(history.summary).toEqual([
			{ key: "clean_area", name: "clean_area", value: 6047, unit: "m²" },
			{ key: "clean_time", name: "clean_time", value: 123, unit: "h" },
			{ key: "clean_count", name: "clean_count", value: 190, unit: "" },
		]);
	});

	it("yields an empty model for a device that published nothing", () => {
		expect(build({})).toEqual({ summary: [], runs: [] });
	});
});

describe("resolveFinishReasonKey", () => {
	it("uses the app's own table before the completion flag", () => {
		// 52 and 56 are what the test device reports for its completed runs.
		expect(resolveFinishReasonKey(52, true)).toBe("ui_history_result_finished");
		expect(resolveFinishReasonKey(56, true)).toBe("ui_history_result_finished");
		// 60 is the code of its single aborted run.
		expect(resolveFinishReasonKey(60, false)).toBe("ui_history_reason_manual");
	});

	it("falls back to the completion flag for a code outside the table", () => {
		expect(resolveFinishReasonKey(999, true)).toBe("ui_history_result_finished");
		expect(resolveFinishReasonKey(999, false)).toBe("ui_history_result_interrupted");
		expect(resolveFinishReasonKey(null, true)).toBe("ui_history_result_finished");
	});

	it("says nothing when the device published neither field", () => {
		expect(resolveFinishReasonKey(null, null)).toBeNull();
	});
});

describe("proof tables", () => {
	it("keeps the clean type table one-based, as CleanTypeCode declares", () => {
		expect(CLEAN_TYPE_LABEL_KEYS[0]).toBeUndefined();
		expect(Object.keys(CLEAN_TYPE_LABEL_KEYS).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("starts the finish reason table at 21, the lowest code Roborock lists", () => {
		const codes = Object.keys(FINISH_REASON_LABEL_KEYS).map(Number);
		expect(Math.min(...codes)).toBe(21);
		expect(Math.max(...codes)).toBe(117);
	});
});
