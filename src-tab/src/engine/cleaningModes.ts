/**
 * The cleaning mode as a tab bar, and the levels each tab is allowed to offer.
 *
 * The robot has no "cleaning mode" field. What the app shows as **Vac & Mop / Mop / Vacuum /
 * Customize** is a derivation from `fan_power`, `water_box_mode` and `mop_mode`, and switching a tab
 * writes all three back in one `set_clean_motor_mode`. The adapter already does both halves: it
 * publishes the derived mode in `deviceStatus.clean_mode_tab` and offers one ready-made payload per
 * mode in `commands.set_clean_motor_mode.common.states`. This module is the third half - which
 * levels a mode may show - because that rule lives in the app's view layer and has no counterpart in
 * any object the adapter publishes.
 *
 * Every rule below is quoted from `_appanalysis/16-reinigungsmodi.md`, which cites the line of the
 * decompiled control plugin `roborock.vacuum.a65_control_v5208` for each statement.
 *
 * ## What this module does not decide
 *
 * Whether a robot *has* a level at all stays where it was: in the `common.states` of the command
 * object. MAX+ is the clearest case - `fan_power = 108` exists only on the models the plugin's
 * static table names (report §4.5), and the adapter resolves that table in
 * `src/lib/features/vacuum/cleaningModes.ts`. So the rule here is only "not outside the vacuum-only
 * tab"; a robot that never had MAX+ simply has no 108 to hide. The tab never adds a level.
 */

import type { CleaningModeTab, SelectOption } from "./types";

/**
 * The values of `deviceStatus.clean_mode_tab`, as `CLEANING_MODE_STATES` on the adapter side numbers
 * them (report §1.3: the tab order the app renders when the SmartPlan tab is absent).
 */
export const CLEANING_MODE_VAC_AND_MOP = 0;
export const CLEANING_MODE_MOP = 1;
export const CLEANING_MODE_VACUUM = 2;
export const CLEANING_MODE_CUSTOM = 3;
export const CLEANING_MODE_SMART = 4;
export const CLEANING_MODE_GENERAL = 5;

/** The three command objects the level pickers are built from. */
export const SUCTION_COMMAND = "set_custom_mode";
export const ROUTE_COMMAND = "set_mop_mode";
export const WATER_COMMAND = "set_water_box_custom_mode";

/** `CleanModeMaxPlus`, the fifth suction level (report §3, A65:242985). */
const FAN_POWER_MAX_PLUS = 108;

/** `WaterModeZero` - not "water off" but the vacuum-only mode (report §3, A65:242987). */
const WATER_BOX_MODE_VACUUM_ONLY = 200;

/**
 * The mop routes in the order `MopMethods()` builds them: Fast first, then Standard, Deep, Deep+
 * (report §5.2, A65:243825-243882). `305` is the regional variant of `303` and takes its place.
 *
 * The order matters because the adapter publishes its own (`300, 301, 303`), and a bar that lists
 * the routes differently from the app on one tab and like the app on another would look like a bug.
 */
const ROUTE_ORDER = [304, 300, 301, 303, 305];

/**
 * The two routes every mode but mop-only offers: Fast and Standard (report §5.3).
 *
 * `getCleanRouteItems` hands Vac & Mop and Vacuum exactly `[CleanRouteFast(), CleanRouteDaily()]`,
 * and `handleModeTabDidChange` enforces the same thing from the other side by resetting 301/303/305
 * to 300 as soon as the mode is left (report §2.1 step 3).
 */
const ROUTE_ORDER_RESTRICTED = [304, 300];

/** One mode: the label the adapter writes into its states, and the caption shown instead. */
interface CleaningModeDefinition {
	mode: number;
	/**
	 * Label of the adapter's preset, which is `CLEANING_MODE_STATES` and therefore always English -
	 * the join between a payload and the mode it stands for.
	 */
	adapterLabel: string;
	/**
	 * Translation key of the caption. The texts are the app's own tab labels, taken from
	 * `lib/protocols/roborock_strings.json` (report §1.2), not translated by hand.
	 */
	labelKey: string;
}

const CLEANING_MODE_DEFINITIONS: CleaningModeDefinition[] = [
	{ mode: CLEANING_MODE_VAC_AND_MOP, adapterLabel: "Vac & Mop", labelKey: "ui_clean_mode_vac_and_mop" },
	{ mode: CLEANING_MODE_MOP, adapterLabel: "Mop", labelKey: "ui_clean_mode_mop" },
	{ mode: CLEANING_MODE_VACUUM, adapterLabel: "Vacuum", labelKey: "ui_clean_mode_vacuum" },
	{ mode: CLEANING_MODE_CUSTOM, adapterLabel: "Custom", labelKey: "ui_clean_mode_custom" },
	{ mode: CLEANING_MODE_SMART, adapterLabel: "SmartPlan", labelKey: "ui_clean_mode_smart" },
	{ mode: CLEANING_MODE_GENERAL, adapterLabel: "General", labelKey: "ui_clean_mode_general" },
];

/**
 * The caption of a mode, so the bar can name the mode the robot is in even when no tab stands for
 * it - a robot in Customize lights up no tab, and a bar that then said nothing would look broken.
 *
 * @param mode Value of `deviceStatus.clean_mode_tab`, or null while unknown.
 * @returns The translation key, or null for an unknown mode.
 */
export function cleaningModeLabelKey(mode: number | null): string | null {
	return CLEANING_MODE_DEFINITIONS.find(definition => definition.mode === mode)?.labelKey ?? null;
}

/**
 * Builds the tab bar out of the presets the adapter published.
 *
 * The payloads and their labels come from `commands.set_clean_motor_mode.common.states`, which the
 * adapter fills from the mode logic in `src/lib/features/vacuum/cleaningModes.ts`. Matching them by
 * their label is the join to the numbers `deviceStatus.clean_mode_tab` reports, because both sides
 * are the same table (`CLEANING_MODE_STATES`).
 *
 * A label this module does not know produces no tab. That is deliberate: a model profile may bring
 * presets of its own, and a tab whose payload means something else than its caption says would send
 * the robot somewhere the user did not ask for.
 *
 * Below two tabs the bar stays away entirely. A single tab cannot switch anything, and the robot is
 * in it already - it would only take space away from the map and suggest a choice that is none.
 *
 * @param states `common.states` of `commands.set_clean_motor_mode`, or null when the device
 *   publishes no such command.
 * @returns The tabs in the app's order, or an empty list when there is nothing to switch between.
 */
export function buildCleaningModeTabs(states: Record<string, string> | null | undefined): CleaningModeTab[] {
	if (!states) {
		return [];
	}

	const tabs: CleaningModeTab[] = [];
	for (const [payload, label] of Object.entries(states)) {
		const definition = CLEANING_MODE_DEFINITIONS.find(entry => entry.adapterLabel === String(label).trim());
		// Two payloads carrying the same label would make the highlight ambiguous; the first wins.
		if (!definition || tabs.some(tab => tab.mode === definition.mode)) {
			continue;
		}
		tabs.push({ mode: definition.mode, payload, labelKey: definition.labelKey });
	}

	if (tabs.length < 2) {
		return [];
	}

	tabs.sort((left, right) => left.mode - right.mode);
	return tabs;
}

/**
 * Puts the options the app knows into the app's order.
 *
 * @param options The levels the robot published, in the adapter's order.
 * @param known The values to place first, in the order they belong in.
 * @param keepRest Whether values the list does not mention survive, appended in the adapter's order.
 *   True wherever the app shows its full list: a model profile may declare a route of its own, and
 *   dropping it would hide a level the robot has. False where the app cuts the list down to two.
 */
function orderOptions(options: SelectOption[], known: number[], keepRest: boolean): SelectOption[] {
	const result: SelectOption[] = [];
	for (const value of known) {
		const option = options.find(entry => Number(entry.value) === value);
		if (option) {
			result.push(option);
		}
	}
	if (keepRest) {
		result.push(...options.filter(option => !known.includes(Number(option.value))));
	}
	return result;
}

/**
 * The levels a mode may offer, out of the levels the robot has.
 *
 * Three rules, all from the same two functions of the app's view layer:
 *
 * - **Mop-only shows no suction picker** and **vacuum-only shows no water picker.**
 *   `getSettingViewsShouldShowConfig` (report §6.1) computes `shouldShowCleanModeView` as
 *   "combined, vacuum-only or general" and `shouldShowWaterModeView` as "combined, mop-only or
 *   general". Both absences are the mode itself: mop-only *is* `fan_power = 105`, vacuum-only *is*
 *   `water_box_mode = 200`, so the missing picker is the one whose value the mode already spent.
 * - **Water level "Off" disappears** wherever the tab bar exists. `getWaterModeItems` drops it with
 *   a `shift()` when the robot has the pure modes (report §6.3) - "no water" is the Vacuum tab, not
 *   a level. Leaving it in would give the user a second, hidden way to switch modes.
 * - **MAX+ only on vacuum-only.** `shouldShowMaxPlus` (report §4.3) allows it on the vacuum-only tab
 *   and, for the handful of models that have MAX+ *without* the pure modes, on the general tab;
 *   everywhere else the component pops it off the list. `handleModeTabDidChange` agrees from the
 *   other side and resets 108 to 102 when the mode is left (report §2.1 step 4).
 * - **Four routes on mop-only, two everywhere else** (report §5.3), see {@link ROUTE_ORDER}.
 *
 * Customize and SmartPlan keep the full route list because `getCleanRouteItems` tests only the three
 * pure tabs and returns `MopMethods()` unchanged for everything else (report §5.3, table row
 * "Indiv. / SmartPlan"). The work order for this bar listed two routes for Customize instead; the
 * cited code says four, so four it is - and the difference is visible only on a robot that is in
 * Customize, where `mop_mode` is the per-room marker 302 and no route is highlighted anyway.
 *
 * @param mode Value of `deviceStatus.clean_mode_tab`, or null while it is unknown.
 * @param command Command object the picker belongs to.
 * @param options The levels the robot published, in the adapter's order.
 * @returns The levels to show; an empty list means the picker belongs to another mode and is hidden.
 */
export function cleaningModeOptions(mode: number | null, command: string, options: SelectOption[]): SelectOption[] {
	// Without a mode nothing may be hidden: a picker taken away on a guess is a control the user
	// cannot reach, while a level too many is one the robot answers for itself.
	if (mode === null) {
		return options;
	}

	if (command === SUCTION_COMMAND) {
		if (mode === CLEANING_MODE_MOP) {
			return [];
		}
		const maxPlusAllowed = mode === CLEANING_MODE_VACUUM || mode === CLEANING_MODE_GENERAL;
		return maxPlusAllowed ? options : options.filter(option => Number(option.value) !== FAN_POWER_MAX_PLUS);
	}

	if (command === WATER_COMMAND) {
		if (mode === CLEANING_MODE_VACUUM) {
			return [];
		}
		return options.filter(option => Number(option.value) !== WATER_BOX_MODE_VACUUM_ONLY);
	}

	if (command === ROUTE_COMMAND) {
		const restricted = mode === CLEANING_MODE_VAC_AND_MOP || mode === CLEANING_MODE_VACUUM;
		return restricted ? orderOptions(options, ROUTE_ORDER_RESTRICTED, false) : orderOptions(options, ROUTE_ORDER, true);
	}

	return options;
}
