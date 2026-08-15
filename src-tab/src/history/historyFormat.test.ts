import { describe, expect, it } from "vitest";
import { formatFieldValue, formatMeasure, formatMinutes, formatNumber, formatRunStart, formatRunStartShort } from "./historyFormat";

/**
 * How the history is worded.
 *
 * The assertions avoid pinning exact `Intl` output where a runtime's CLDR data could legitimately
 * differ - what matters is that the *value* is right, that the unit is only shown when the adapter
 * declared one, and that the language really reaches the formatter.
 */

describe("formatMinutes", () => {
	it("stays in minutes below the hour", () => {
		expect(formatMinutes(18, "en")).toMatch(/^18\s?min/);
	});

	it("splits into hours and minutes above it, as the app's own row does", () => {
		const text = formatMinutes(76, "en");
		expect(text).toMatch(/1\s?hr?/);
		expect(text).toMatch(/16\s?min/);
	});

	it("drops the minutes on a full hour", () => {
		expect(formatMinutes(120, "en")).not.toMatch(/min/);
		expect(formatMinutes(120, "en")).toMatch(/2/);
	});

	it("follows the language", () => {
		expect(formatMinutes(18, "de")).not.toBe(formatMinutes(18, "zh-cn"));
	});

	it("never shows a negative duration", () => {
		expect(formatMinutes(-5, "en")).toMatch(/^0/);
	});
});

describe("formatMeasure", () => {
	it("shows nothing for a value the device never published", () => {
		expect(formatMeasure({ value: null, unit: "min" }, "en")).toBeNull();
	});

	it("treats the declared minute unit as a duration", () => {
		expect(formatMeasure({ value: 76, unit: "min" }, "en")).toBe(formatMinutes(76, "en"));
	});

	it("treats the declared hour unit as hours", () => {
		expect(formatMeasure({ value: 123, unit: "h" }, "en")).toMatch(/123/);
		expect(formatMeasure({ value: 123, unit: "h" }, "en")).not.toBe("123 h");
	});

	it("appends any other declared unit verbatim", () => {
		expect(formatMeasure({ value: 51, unit: "m²" }, "en")).toBe("51 m²");
	});

	it("shows a bare number when the adapter declared no unit", () => {
		// This is the B01/Q10 case: raw device numbers whose unit nothing proves.
		expect(formatMeasure({ value: 4538, unit: "" }, "en")).toBe(formatNumber(4538, "en"));
		expect(formatMeasure({ value: 4538, unit: "" }, "en")).not.toMatch(/min|s\b/);
	});

	it("survives a language tag the browser rejects", () => {
		expect(formatMeasure({ value: 51, unit: "m²" }, "not a tag")).toMatch(/51/);
	});
});

describe("formatFieldValue", () => {
	it("formats numbers in the language and keeps text as it is", () => {
		expect(formatFieldValue(1234, "", "en")).toBe("1,234");
		expect(formatFieldValue(1234, "", "de")).toBe("1.234");
		expect(formatFieldValue("abc", "", "en")).toBe("abc");
		expect(formatFieldValue(true, "", "en")).toBe("true");
	});

	it("appends a declared unit", () => {
		expect(formatFieldValue(5, "x", "en")).toBe("5 x");
	});
});

describe("timestamps", () => {
	/** 8 December 2025, 13:00:01 UTC. */
	const MOMENT = 1765198801;

	it("formats a run start in the language", () => {
		const en = formatRunStart(MOMENT, "en");
		const de = formatRunStart(MOMENT, "de");
		expect(en).toMatch(/2025/);
		expect(de).toMatch(/2025/);
		expect(en).not.toBe(de);
	});

	it("drops the year in the short form the list uses", () => {
		expect(formatRunStartShort(MOMENT, "en")).not.toMatch(/2025/);
		expect(formatRunStartShort(MOMENT, "en")).toMatch(/12/);
	});

	it("shows nothing when the device published no timestamp", () => {
		expect(formatRunStart(null, "en")).toBeNull();
		expect(formatRunStartShort(null, "en")).toBeNull();
	});
});
