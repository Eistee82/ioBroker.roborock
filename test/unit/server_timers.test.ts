import { describe, expect, it } from "vitest";

import { isServerTimerActive, parseServerTimerList } from "../../src/lib/features/vacuum/serverTimers";

/**
 * Reading the schedules a robot keeps on Roborock's server.
 *
 * The one rule worth guarding is the direction of the on/off test. Two spellings are in evidence
 * and they disagree: the app compares against `'disable'` (a65 control plugin, A65:581586-581615),
 * the test device answered `"on"`. A third spelling nobody has seen is therefore possible, so the
 * check asks whether the state is one of the known **off** words - never whether it equals `"on"`.
 * An unknown word then reads as "on", which is the error that can be noticed.
 */

describe("reading the on/off state", () => {
	it("treats the two known off spellings as off", () => {
		// 'disable' is what the app itself tests for; 'off' is the vocabulary upd_timer uses.
		expect(isServerTimerActive("disable")).toBe(false);
		expect(isServerTimerActive("off")).toBe(false);
		expect(isServerTimerActive("DISABLE")).toBe(false);
		expect(isServerTimerActive(" off ")).toBe(false);
	});

	it("treats the measured value as on", () => {
		expect(isServerTimerActive("on")).toBe(true);
	});

	it("treats a spelling nobody has seen as on, not as off", () => {
		// The whole point: comparing against "on" would call these switched off, and a schedule
		// wrongly shown as off is the error nobody notices.
		expect(isServerTimerActive("enabled")).toBe(true);
		expect(isServerTimerActive("1")).toBe(true);
		expect(isServerTimerActive("active")).toBe(true);
		expect(isServerTimerActive(1)).toBe(true);
		expect(isServerTimerActive(undefined)).toBe(true);
	});
});

describe("reading the list", () => {
	it("reads the answer the test device gave", () => {
		expect(parseServerTimerList([["1743140136890", "on", -1]])).toEqual([
			{ id: "1743140136890", active: true, state: "on", raw: '["1743140136890","on",-1]' }
		]);
	});

	it("keeps the third field without interpreting it", () => {
		// The app reads index 0 and index 1 and nothing else, so the rest is passed through as it
		// came rather than given a meaning.
		const [entry] = parseServerTimerList([["id-1", "on", 42, { more: true }]]);
		expect(entry.raw).toBe('["id-1","on",42,{"more":true}]');
		expect(Object.keys(entry).sort()).toEqual(["active", "id", "raw", "state"]);
	});

	it("reads several entries and their states", () => {
		const entries = parseServerTimerList([
			["a", "on", -1],
			["b", "disable", -1],
			["c", "off", -1]
		]);
		expect(entries.map(entry => [entry.id, entry.active])).toEqual([["a", true], ["b", false], ["c", false]]);
	});

	it("unwraps a list the request layer wrapped once", () => {
		expect(parseServerTimerList([[["x", "on", -1]]])).toHaveLength(1);
		expect(parseServerTimerList({ data: [["x", "on", -1]] })).toHaveLength(1);
	});

	it("drops a row without a usable identifier rather than inventing one", () => {
		expect(parseServerTimerList([[], [null, "on"], ["", "on"], ["  ", "on"]])).toEqual([]);
	});

	it("accepts a numeric identifier", () => {
		expect(parseServerTimerList([[1743140136890, "on", -1]])[0].id).toBe("1743140136890");
	});

	it("says nothing about a robot that keeps no server schedules", () => {
		expect(parseServerTimerList([])).toEqual([]);
		expect(parseServerTimerList(null)).toEqual([]);
		expect(parseServerTimerList("unknown_method")).toEqual([]);
	});
});
