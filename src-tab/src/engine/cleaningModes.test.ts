import { describe, expect, it } from "vitest";
import {
	CLEANING_MODE_CUSTOM,
	CLEANING_MODE_GENERAL,
	CLEANING_MODE_MOP,
	CLEANING_MODE_SMART,
	CLEANING_MODE_VACUUM,
	CLEANING_MODE_VAC_AND_MOP,
	ROUTE_COMMAND,
	SUCTION_COMMAND,
	WATER_COMMAND,
	buildCleaningModeTabs,
	cleaningModeLabelKey,
	cleaningModeOptions,
} from "./cleaningModes";
import type { SelectOption } from "./types";

/**
 * The rules behind the cleaning-mode tabs, pinned against the report they come from.
 *
 * Every expectation below is one of the numbers in `_appanalysis/16-reinigungsmodi.md` §4.4 and
 * §5.3, which were themselves checked against screenshots of the app on the reference robot. They
 * are the reason this module exists: getting them wrong shows a level the mode forbids, and the app
 * would silently undo it on the robot.
 */

/** The suction levels the adapter publishes for a robot whose model table proves MAX+ (a65). */
const SUCTION_WITH_MAX_PLUS: SelectOption[] = [
	{ value: "101", label: "Quiet" },
	{ value: "102", label: "Balanced" },
	{ value: "103", label: "Turbo" },
	{ value: "104", label: "Max" },
	{ value: "108", label: "Max+" },
];

/** The same list on a robot the plugin's table does not credit with MAX+. */
const SUCTION_WITHOUT_MAX_PLUS = SUCTION_WITH_MAX_PLUS.filter(option => option.value !== "108");

/** Mop routes in the adapter's order, including the Fast route the app lists first. */
const ROUTES: SelectOption[] = [
	{ value: "300", label: "Standard" },
	{ value: "301", label: "Deep" },
	{ value: "303", label: "Deep+" },
	{ value: "304", label: "Fast" },
];

/** Water levels as the adapter publishes them, "Off" included. */
const WATER: SelectOption[] = [
	{ value: "200", label: "Off" },
	{ value: "201", label: "Mild" },
	{ value: "202", label: "Standard" },
	{ value: "203", label: "Intense" },
];

/** The presets the adapter builds for a robot that has the three pure modes. */
const PRESETS: Record<string, string> = {
	'{"fan_power":102,"mop_mode":300,"water_box_mode":201}': "Vac & Mop",
	'{"fan_power":105,"mop_mode":300,"water_box_mode":201}': "Mop",
	'{"fan_power":102,"mop_mode":300,"water_box_mode":200}': "Vacuum",
};

function values(options: SelectOption[]): string[] {
	return options.map(option => option.value);
}

describe("buildCleaningModeTabs", () => {
	it("turns the adapter's presets into the app's tab order", () => {
		const tabs = buildCleaningModeTabs(PRESETS);

		expect(tabs.map(tab => tab.mode)).toEqual([CLEANING_MODE_VAC_AND_MOP, CLEANING_MODE_MOP, CLEANING_MODE_VACUUM]);
		expect(tabs.map(tab => tab.labelKey)).toEqual(["ui_clean_mode_vac_and_mop", "ui_clean_mode_mop", "ui_clean_mode_vacuum"]);
	});

	it("keeps each payload with the mode it stands for, whatever order they arrived in", () => {
		const [vacuum, mop] = [Object.keys(PRESETS)[2], Object.keys(PRESETS)[1]];
		const tabs = buildCleaningModeTabs({
			[vacuum]: "Vacuum",
			[mop]: "Mop",
			[Object.keys(PRESETS)[0]]: "Vac & Mop",
		});

		expect(tabs.find(tab => tab.mode === CLEANING_MODE_VACUUM)?.payload).toBe(vacuum);
		expect(tabs.find(tab => tab.mode === CLEANING_MODE_MOP)?.payload).toBe(mop);
	});

	it("ignores a preset whose label it does not know", () => {
		// A model profile may bring presets of its own. Sending one under a caption that means
		// something else would put the robot into a mode the user did not pick.
		const tabs = buildCleaningModeTabs({ ...PRESETS, '{"fan_power":106}': "Turbo mode" });

		expect(tabs).toHaveLength(3);
	});

	it("shows no bar for a robot that has only one mode", () => {
		// The legacy products get the single combined tab. It cannot switch anything.
		expect(buildCleaningModeTabs({ '{"fan_power":102,"water_box_mode":201}': "General" })).toEqual([]);
	});

	it("shows no bar when the device publishes no such command", () => {
		expect(buildCleaningModeTabs(null)).toEqual([]);
		expect(buildCleaningModeTabs(undefined)).toEqual([]);
		expect(buildCleaningModeTabs({})).toEqual([]);
	});

	it("keeps the first payload when two carry the same label", () => {
		const tabs = buildCleaningModeTabs({ ...PRESETS, '{"fan_power":103,"water_box_mode":200}': "Vacuum" });

		expect(tabs).toHaveLength(3);
		expect(tabs.find(tab => tab.mode === CLEANING_MODE_VACUUM)?.payload).toBe(Object.keys(PRESETS)[2]);
	});
});

describe("cleaningModeLabelKey", () => {
	it("names every mode the adapter can report", () => {
		expect(cleaningModeLabelKey(CLEANING_MODE_CUSTOM)).toBe("ui_clean_mode_custom");
		expect(cleaningModeLabelKey(CLEANING_MODE_SMART)).toBe("ui_clean_mode_smart");
		expect(cleaningModeLabelKey(CLEANING_MODE_GENERAL)).toBe("ui_clean_mode_general");
	});

	it("names nothing for an unknown or missing mode", () => {
		expect(cleaningModeLabelKey(99)).toBeNull();
		expect(cleaningModeLabelKey(null)).toBeNull();
	});
});

describe("cleaningModeOptions - suction", () => {
	it("offers four levels on Vac & Mop, MAX+ only on Vacuum (report §4.4)", () => {
		expect(values(cleaningModeOptions(CLEANING_MODE_VAC_AND_MOP, SUCTION_COMMAND, SUCTION_WITH_MAX_PLUS)))
			.toEqual(["101", "102", "103", "104"]);
		expect(values(cleaningModeOptions(CLEANING_MODE_VACUUM, SUCTION_COMMAND, SUCTION_WITH_MAX_PLUS)))
			.toEqual(["101", "102", "103", "104", "108"]);
	});

	it("never invents MAX+ for a robot whose model does not have it", () => {
		// Whether 108 exists is decided by the plugin's static model table, resolved on the adapter
		// side; a level that is not in the command object cannot appear on any tab.
		expect(values(cleaningModeOptions(CLEANING_MODE_VACUUM, SUCTION_COMMAND, SUCTION_WITHOUT_MAX_PLUS)))
			.toEqual(["101", "102", "103", "104"]);
	});

	it("shows no suction picker at all while mopping (report §6.1)", () => {
		// Mop-only *is* fan_power 105 - the picker would offer to leave the mode it is standing in.
		expect(cleaningModeOptions(CLEANING_MODE_MOP, SUCTION_COMMAND, SUCTION_WITH_MAX_PLUS)).toEqual([]);
	});

	it("hides MAX+ in Customize and keeps it on the single General tab (report §4.3)", () => {
		expect(values(cleaningModeOptions(CLEANING_MODE_CUSTOM, SUCTION_COMMAND, SUCTION_WITH_MAX_PLUS)))
			.toEqual(["101", "102", "103", "104"]);
		expect(values(cleaningModeOptions(CLEANING_MODE_GENERAL, SUCTION_COMMAND, SUCTION_WITH_MAX_PLUS)))
			.toEqual(["101", "102", "103", "104", "108"]);
	});
});

describe("cleaningModeOptions - water", () => {
	it("shows no water picker while vacuuming (report §6.1)", () => {
		expect(cleaningModeOptions(CLEANING_MODE_VACUUM, WATER_COMMAND, WATER)).toEqual([]);
	});

	it("drops the level 'Off', because that is the Vacuum tab (report §6.3)", () => {
		expect(values(cleaningModeOptions(CLEANING_MODE_VAC_AND_MOP, WATER_COMMAND, WATER))).toEqual(["201", "202", "203"]);
		expect(values(cleaningModeOptions(CLEANING_MODE_MOP, WATER_COMMAND, WATER))).toEqual(["201", "202", "203"]);
	});
});

describe("cleaningModeOptions - mop route", () => {
	it("offers all four routes while mopping and two everywhere else (report §5.3)", () => {
		expect(values(cleaningModeOptions(CLEANING_MODE_MOP, ROUTE_COMMAND, ROUTES))).toEqual(["304", "300", "301", "303"]);
		expect(values(cleaningModeOptions(CLEANING_MODE_VAC_AND_MOP, ROUTE_COMMAND, ROUTES))).toEqual(["304", "300"]);
		expect(values(cleaningModeOptions(CLEANING_MODE_VACUUM, ROUTE_COMMAND, ROUTES))).toEqual(["304", "300"]);
	});

	it("leaves Customize and SmartPlan the full list", () => {
		// `getCleanRouteItems` tests only the three pure tabs and returns MopMethods() unchanged for
		// everything else. The work order for this bar said two routes for Customize; the cited code
		// says four, and it is the code that decides what the robot accepts.
		expect(values(cleaningModeOptions(CLEANING_MODE_CUSTOM, ROUTE_COMMAND, ROUTES))).toEqual(["304", "300", "301", "303"]);
		expect(values(cleaningModeOptions(CLEANING_MODE_SMART, ROUTE_COMMAND, ROUTES))).toEqual(["304", "300", "301", "303"]);
	});

	it("keeps a route the app does not know where the list is not cut down", () => {
		// Some model profiles declare routes of their own (306 "Intense/Smart"). Hiding a level the
		// robot has is the worse error, so the full list keeps it - the cut-down one does not.
		const withOwnRoute = [...ROUTES, { value: "306", label: "Intense/Smart" }];

		expect(values(cleaningModeOptions(CLEANING_MODE_MOP, ROUTE_COMMAND, withOwnRoute))).toEqual(["304", "300", "301", "303", "306"]);
		expect(values(cleaningModeOptions(CLEANING_MODE_VAC_AND_MOP, ROUTE_COMMAND, withOwnRoute))).toEqual(["304", "300"]);
	});

	it("shows what the robot has, not what the app would list", () => {
		// The adapter's default route list has no Fast route yet. The filter must not conjure one.
		const withoutFast = ROUTES.filter(option => option.value !== "304");

		expect(values(cleaningModeOptions(CLEANING_MODE_VAC_AND_MOP, ROUTE_COMMAND, withoutFast))).toEqual(["300"]);
	});
});

describe("cleaningModeOptions - no mode known", () => {
	it("hides nothing while the reported mode is unknown", () => {
		// Filtering on a guess would take away a control that worked before.
		expect(cleaningModeOptions(null, SUCTION_COMMAND, SUCTION_WITH_MAX_PLUS)).toEqual(SUCTION_WITH_MAX_PLUS);
		expect(cleaningModeOptions(null, WATER_COMMAND, WATER)).toEqual(WATER);
		expect(cleaningModeOptions(null, ROUTE_COMMAND, ROUTES)).toEqual(ROUTES);
	});

	it("leaves a command it has no rule for exactly as it is", () => {
		expect(cleaningModeOptions(CLEANING_MODE_MOP, "set_wash_towel_mode", WATER)).toEqual(WATER);
	});
});
