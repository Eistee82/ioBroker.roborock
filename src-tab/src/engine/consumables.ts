import type { ConsumableGroup } from "./types";

/**
 * Which unit every consumable the adapter can publish belongs to.
 *
 * This is not a guess from the state names. The Roborock app builds its supplies page from a
 * two-section list, and each section pulls its artwork from its own asset namespace, which names
 * the unit outright. In the decompiled a65 control plugin
 * (`_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`, function
 * `getSupplies`, module 2424):
 *
 *  - section 0, lines 654986-655386, artwork from `Supply.robot.*`:
 *    `filter_work_time`, `main_brush_work_time`, `side_brush_work_time`, `sensor_dirty_time`,
 *    `filter_element_work_time`, `mopSwabSupplies`
 *  - section 1, lines 655387-655776, artwork from `Supply.dock.*`:
 *    `strainer_work_times`, `cleaning_brush_work_times`, `dust_collection_work_times`,
 *    `dust_bag_work_times`, `floor_cleaning_fluid`
 *
 * Note `filter_element`, the robot's water tank filter (`supplies_waterbox_chip_name`): the app
 * files it under the robot, and the two descriptions agree - `supplies_strainer_description` calls
 * the strainer the *dock* water filter, `supplies_waterbox_chip_description` says nothing about a
 * dock. Grouping it with the station because its counter looks station-like would be wrong.
 *
 * `mop`/`moproller` is the robot's own wiping part (`supplies_moproller_description`: "the robot's
 * main mopping element"), so it stays with the robot even though this plugin lists it under the
 * name `mopSwabSupplies`.
 */
export const CONSUMABLE_GROUPS: Record<string, ConsumableGroup> = {
	main_brush: "robot",
	side_brush: "robot",
	filter: "robot",
	filter_element: "robot",
	sensor: "robot",
	mop: "robot",
	moproller: "robot",
	strainer: "station",
	cleaning_brush: "station",
	dust_collection: "station",
	dust_bag: "station",
};

/**
 * Suffix the fallback keys off. Across all nine parts the adapter publishes today the counting
 * unit and the group coincide: robot parts count run time (`_work_time`, `_dirty_time`, `_life`),
 * station parts count cycles (`_work_times`). A part a future firmware adds is therefore filed by
 * that suffix rather than dropped from the panel - a wrong heading is a smaller harm than a
 * consumable the user never gets to see.
 */
const CYCLE_SUFFIX = "_work_times";

/**
 * Part labels the tab spells out itself instead of taking the adapter's translated object name.
 *
 * Only `filter`, and deliberately so: the app calls it plain "Filter", which is unhelpful next to
 * the strainer ("Water filter") and the water tank filter, both of which are filters too. The user
 * asked for "Staubfilter" - the dust filter - and that request outranks the app's wording. Please
 * do not "correct" this back to the Roborock string.
 */
export const CONSUMABLE_LABEL_OVERRIDES: Record<string, { key: string; fallback: string }> = {
	filter: { key: "ui_consumable_part_filter", fallback: "Dust filter" },
};

/**
 * Files a part with the robot or with its station.
 * @param partName Part name with the value suffix already stripped, e.g. `main_brush`.
 * @param stateName Full state name, which still carries the suffix the fallback needs.
 */
export function consumableGroup(partName: string, stateName: string): ConsumableGroup {
	const known = CONSUMABLE_GROUPS[partName];
	if (known) return known;
	return stateName.endsWith(CYCLE_SUFFIX) ? "station" : "robot";
}
