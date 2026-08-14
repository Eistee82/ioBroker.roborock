import { describe, expect, it } from "vitest";
import { CONSUMABLE_GROUPS, CONSUMABLE_LABEL_OVERRIDES, consumableGroup } from "./consumables";

/**
 * Which unit each consumable belongs to, pinned against the source it was read from.
 *
 * The expectations below are the two sections of `getSupplies` in the decompiled a65 control plugin
 * (`_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`), identified by the
 * asset namespace each section's artwork comes from: `Supply.robot.*` for lines 654986-655386 and
 * `Supply.dock.*` for lines 655387-655776. Nothing here is derived from the state names.
 */

/** Every state name the adapter publishes today, with the unit the app files it under. */
const PUBLISHED_STATES: { state: string; part: string; group: "robot" | "station" }[] = [
	{ state: "main_brush_work_time", part: "main_brush", group: "robot" },
	{ state: "main_brush_life", part: "main_brush", group: "robot" },
	{ state: "side_brush_work_time", part: "side_brush", group: "robot" },
	{ state: "side_brush_life", part: "side_brush", group: "robot" },
	{ state: "filter_work_time", part: "filter", group: "robot" },
	{ state: "filter_life", part: "filter", group: "robot" },
	{ state: "filter_element_work_time", part: "filter_element", group: "robot" },
	{ state: "sensor_dirty_time", part: "sensor", group: "robot" },
	{ state: "mop_life", part: "mop", group: "robot" },
	{ state: "strainer_work_times", part: "strainer", group: "station" },
	{ state: "cleaning_brush_work_times", part: "cleaning_brush", group: "station" },
	{ state: "dust_collection_work_times", part: "dust_collection", group: "station" },
];

describe("consumableGroup", () => {
	it.each(PUBLISHED_STATES)("files $state with the $group", ({ state, part, group }) => {
		expect(consumableGroup(part, state)).toBe(group);
	});

	it("keeps the robot's water tank filter with the robot", () => {
		// `filter_element` is the trap: its counter reads like a station counter, and the adapter's
		// own lifetime table sits it next to `strainer`. The app puts it in the robot section
		// (line 655218, artwork `Supply.robot`), because it is the filter of the robot's water tank
		// - `supplies_waterbox_chip_name`, "Water Tank Filter". Only the strainer is the dock's.
		expect(consumableGroup("filter_element", "filter_element_work_time")).toBe("robot");
		expect(consumableGroup("strainer", "strainer_work_times")).toBe("station");
	});

	it("files an unknown part by its counter, so it is never dropped from the panel", () => {
		// A counter of cycles is what every station part has and no robot part has.
		expect(consumableGroup("wash_tray", "wash_tray_work_times")).toBe("station");
		expect(consumableGroup("wheel", "wheel_work_time")).toBe("robot");
		expect(consumableGroup("wheel", "wheel_dirty_time")).toBe("robot");
		expect(consumableGroup("wheel", "wheel_life")).toBe("robot");
	});

	it("lets the table outrank the counter, not the other way round", () => {
		// Were the suffix consulted first, `filter_element_work_time` would end up in the station.
		for (const [part, group] of Object.entries(CONSUMABLE_GROUPS)) {
			expect(consumableGroup(part, `${part}_work_times`), part).toBe(group);
			expect(consumableGroup(part, `${part}_work_time`), part).toBe(group);
		}
	});
});

describe("consumable label overrides", () => {
	it("renames only the dust filter, and does so deliberately", () => {
		// The app says plain "Filter" for this part. The user asked for "Staubfilter" because the
		// panel also shows the dock's water filter and the robot's water tank filter. Changing this
		// back to the Roborock wording undoes a requested change, it does not fix a bug.
		expect(Object.keys(CONSUMABLE_LABEL_OVERRIDES)).toEqual(["filter"]);
		expect(CONSUMABLE_LABEL_OVERRIDES.filter.key).toBe("ui_consumable_part_filter");
	});
});
