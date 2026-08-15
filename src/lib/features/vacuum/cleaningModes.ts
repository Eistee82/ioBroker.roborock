/**
 * # The cleaning mode: one thing the app shows, three values the robot carries
 *
 * The Roborock app presents **Vac & Mop / Mop / Vacuum / Customize** as four tabs, but there is no
 * "switch tab" command. The tab is a pure derivation from `fan_power`, `water_box_mode` and
 * `mop_mode`, and switching it sends all three values back in a single
 * `set_clean_motor_mode [{fan_power, water_box_mode, mop_mode}]`. Everything in this file is read
 * out of the decompiled control plugin `roborock.vacuum.a65_control_v5208`; the full derivation is
 * in `_appanalysis/16-reinigungsmodi.md`, which cites the bundle line for every statement below.
 *
 * Two consequences for the adapter:
 *
 * 1. The three values are **not independent**. `water_box_mode = 200` does not mean "water off
 *    while mopping", it means the robot is in the vacuum-only mode; `fan_power = 105` is not the
 *    weakest suction level, it is the mop-only mode. Reporting them as three unrelated dropdowns
 *    loses the only information the user actually looks for.
 * 2. Which values are legal depends on the mode. The app resets `mop_mode` 301/303/305 to 300 and
 *    `fan_power` 108 to 102 the moment the mode no longer allows them, so sending them anyway
 *    produces a state the app itself would immediately undo.
 *
 * ## Do not read the mode back with `get_clean_motor_mode`
 *
 * There is a getter of that name, and it looks like the obvious way to ask the robot which mode it
 * is in. It is not. Measured at the test device
 * (`_appanalysis/19-geraetefaehigkeiten.md` §6.2):
 *
 * ```
 * get_clean_motor_mode -> [{"water_box_mode":203,"fan_power":101,"mop_mode":-1225003008}]
 * get_prop get_status  ->   … "water_box_mode":203,"fan_power":101,"mop_mode":300 …
 * ```
 *
 * Two of the three agree with the status packet; `mop_mode` is rubbish. The adapter is not affected
 * because it derives the mode from `get_status`, and that is exactly where it has to stay - the
 * status is the only source that was measured to carry all three correctly.
 *
 * ## What is proven and what is not
 *
 * Every value, predicate and model list here has a line number in the bundle. Where this module
 * deliberately deviates from the app, the deviation is named at the place it happens - there is no
 * silent "probably". The two deviations are the SmartPlan detection (the app additionally checks a
 * firmware bit the adapter does not read yet) and the treatment of models the plugin's table does
 * not know at all.
 */

/** `CustomCleanMode` - the marker meaning "this room has its own suction level". A65:242972. */
export const FAN_POWER_CUSTOM = 106;

/** `CleanModeZero` - internally `NoClean`, shown to the user as *Gentle*. A65:242983. */
export const FAN_POWER_MOP_ONLY = 105;

/** `CleanModeNormal` - the level the app falls back to. A65:242981. */
export const FAN_POWER_NORMAL = 102;

/** `CleanModeMaxPlus` - the fifth suction level, offered on the vacuum-only tab. A65:242985. */
export const FAN_POWER_MAX_PLUS = 108;

/** `SmartCleanMode`. A65:243005. */
export const FAN_POWER_SMART = 110;

/** `WaterModeZero` - not "no water", but the vacuum-only mode. A65:242987. */
export const WATER_BOX_MODE_VACUUM_ONLY = 200;

/** `WaterModeNormal` - the level the app falls back to. A65:242989. */
export const WATER_BOX_MODE_NORMAL = 201;

/** `CustomWaterMode` - the per-room marker, not the user-defined amount (that is 207). A65:242975. */
export const WATER_BOX_MODE_CUSTOM = 204;

/** `SmartWaterMode`. A65:243008. */
export const WATER_BOX_MODE_SMART = 209;

/**
 * `MaxWater` - the *Extreme* level, offered only on robots that prove they have it. A65:243589.
 *
 * @see MOP_SHAKE_WATER_MAX_BIT
 */
export const WATER_BOX_MODE_MAX = 208;

/**
 * Bit 45 of `new_feature_info_str` (`NewFeatureStrBit.MopShakeWaterMax`), the second half of the
 * app's gate on {@link WATER_BOX_MODE_MAX}.
 *
 * `MopWaterOrStrengths()` builds the water picker as a list it pushes entries onto. The *Extreme*
 * entry (`tanos_s_mop_mode_max`, `strength: 208`, A65:243576-243589) is the last one, and it is
 * pushed only after both halves of the predicate hold (A65:243597-243615):
 *
 * ```js
 * let ok = DM.support(MF.Mop_ShakeModule);              // A65:243294-243310, model table
 * if (ok) ok = DM.isNewFeatureStrSupport(NewFeatureStrBit.MopShakeWaterMax);
 * if (ok) list.push(extremeEntry);
 * ```
 *
 * `NewFeatureStrBit.MopShakeWaterMax = 45` is A65:231849; `isNewFeatureStrSupport` (A65:237242)
 * tests that bit of `DM.newFeatureInfoStr`, which is filled verbatim from the robot's
 * `new_feature_info_str` (A65:5804).
 *
 * The first half is a model table and is knowable before the robot answers - that is
 * `usesShakeMopWaterLabels`. This half is not, so it is applied as soon as the robot reports the
 * field; see `V1VacuumFeatures.applyShakeMopWaterMaxBit`.
 */
export const MOP_SHAKE_WATER_MAX_BIT = 45n;

/** `CleanRouteDailyMode` - the route the app falls back to. A65:242995. */
export const MOP_MODE_DAILY = 300;

/** `CleanRouteSubtlyMode`. A65:242997. */
export const MOP_MODE_SUBTLY = 301;

/** `CustomMopMode` - the per-room marker. A65:242978. */
export const MOP_MODE_CUSTOM = 302;

/** `CleanRouteDeepSlowMode`. A65:242999. */
export const MOP_MODE_DEEP_SLOW = 303;

/** `CleanRouteFastMode`. A65:243001. */
export const MOP_MODE_FAST = 304;

/** `CleanRouteDeepSlowPearlMode` - the regional variant of 303. A65:243003. */
export const MOP_MODE_DEEP_SLOW_PEARL = 305;

/** `SmartMopMode`. A65:243011. */
export const MOP_MODE_SMART = 306;

/**
 * The mode as the app names it.
 *
 * `general` is the app's own fifth case (`custom_mode_panel_tab_general`, "General"): robots that
 * cannot do vacuum-only or mop-only get one combined tab instead of three, so calling their mode
 * "Vac & Mop" would claim a distinction they do not have.
 */
export type CleaningMode = "vacAndMop" | "mop" | "vacuum" | "custom" | "smart" | "general";

/**
 * Numeric encoding published in `deviceStatus.clean_mode_tab`.
 *
 * 0-4 are the tab order the app renders when the SmartPlan tab is absent (A65:245669-245744,
 * report §1.3), which is the order a user sees on the device. 5 is appended for `general` because
 * the app never shows it next to the other four - a robot has either the three tabs or the one.
 */
export const CLEANING_MODE_STATE_VALUES: Record<CleaningMode, number> = {
	vacAndMop: 0,
	mop: 1,
	vacuum: 2,
	custom: 3,
	smart: 4,
	general: 5
};

/**
 * `common.states` for the published mode, worded the way the app's own tab labels are translated.
 *
 * String keys of the app: `robot_status_clean_mop_mode`, `robot_clean_status_only_mop`,
 * `robot_clean_status_only_clean`, `localization_strings_Common_custom_mode`,
 * `clean_mode_tab_title_smart`, `custom_mode_panel_tab_general` (report §1.2).
 */
export const CLEANING_MODE_STATES: Record<number, string> = {
	0: "Vac & Mop",
	1: "Mop",
	2: "Vacuum",
	3: "Custom",
	4: "SmartPlan",
	5: "General"
};

/** The three values that together make up a mode, as they arrive from the robot. */
export interface CleaningModeValues {
	fan_power?: number | null;
	water_box_mode?: number | null;
	mop_mode?: number | null;
}

/** The payload of `set_clean_motor_mode`: `mop_mode` is absent on models that have no routes. */
export interface CleanMotorModeParams {
	fan_power: number;
	mop_mode?: number;
	water_box_mode: number;
}

/** What the model can do. Both flags come from the plugin's static model table, see below. */
export interface CleaningModeCapabilities {
	/**
	 * `DM.support(MF.CleanMode_PureCleanMop)` - whether vacuum-only and mop-only exist as modes at
	 * all. Defaults to true, see {@link supportsPureCleanMop}.
	 */
	pureCleanMop?: boolean;
	/**
	 * Whether 110 / 209 / 306 mean SmartPlan on this model. Defaults to true; the caller turns it
	 * off for models whose own profile gives those values a different meaning.
	 */
	smartPlan?: boolean;
	/** Whether the model has mop routes at all; when false, no `mop_mode` is produced. */
	mopRoutes?: boolean;
}

/**
 * Models whose suction list ends in MAX+ (`fan_power` 108).
 *
 * `FM.isMaxPlusModeSupported()` is `DM.support(MF.CleanMode_MaxPlus)` (A65:235507-235525) and
 * resolves against the model table compiled into the plugin (module 516, 43 device configs,
 * A65:215934-216784). It is therefore **not** derivable from `get_status`, `new_feature_info` or
 * `firmwareFeatures`, but it is derivable from the model string.
 *
 * ## Reading that table correctly takes three steps, and skipping any of them gives a wrong list
 *
 * 1. **`newDefaultFeatures` contains `CleanMode_MaxPlus`.** It is `[Remote_Back,
 *    CleanMode_MaxPlus]` (A65:215739-215741, registers assigned at A65:215670 and A65:215672), so
 *    every entry that spreads it inherits MAX+ without naming it.
 * 2. **Three entries take it away again.** `Pearl`, `TopazS` and `TanosS` carry a `remake` callback
 *    that filters `CleanMode_MaxPlus` out of the finished config (A65:215958, A65:216397,
 *    A65:216537); `createDeviceModelConfig` applies it unconditionally (A65:217314). Those three
 *    are the reason a plain text search for the feature name is misleading: it finds them, and they
 *    are exactly the ones that do *not* have it.
 * 3. **Entries inherit.** `inheritedConfig` merges the parent's finished feature list
 *    (A65:217178-217203), and five more entries copy `<parent>.features` outright. Both paths carry
 *    MAX+ across.
 *
 * Because of step 2, the extraction file `model_features.tsv` is wrong for `TopazS` and `TanosS`
 * (it reads the `remake` filter as if it were a feature) and, because of steps 1 and 3, incomplete
 * for everyone else. This list is built from the bundle, not from that file.
 *
 * The list is a snapshot of plugin version 5208. A model that is not in it keeps whatever its own
 * profile declares - see {@link V1VacuumFeatures} - and never has a level taken away.
 */
export const CLEAN_MODE_MAX_PLUS_MODELS: ReadonlySet<string> = new Set([
	"roborock.vacuum.a20",  // Coral       - copies PearlPlus.features, A65:216175
	"roborock.vacuum.a21",  // Coral
	"roborock.vacuum.a26",  // TopazSV     - newDefaultFeatures, A65:216499
	"roborock.vacuum.a27",  // TopazSV
	"roborock.vacuum.a46",  // TopazSPlus  - newDefaultFeatures, A65:216427
	"roborock.vacuum.a47",  // TopazSPlus
	"roborock.vacuum.a50",  // Ultron      - newDefaultFeatures, A65:216230
	"roborock.vacuum.a51",  // Ultron
	"roborock.vacuum.a52",  // TanosSMax   - newDefaultFeatures, A65:216632
	"roborock.vacuum.a62",  // TopazSPower - newDefaultFeatures, A65:216453
	"roborock.vacuum.a64",  // TopazSC     - named outright, A65:216473
	"roborock.vacuum.a65",  // TopazSC
	"roborock.vacuum.a66",  // TopazSPlus
	"roborock.vacuum.a68",  // UltronSPlus - copies Ultron.features, A65:216329
	"roborock.vacuum.a69",  // UltronSPlus
	"roborock.vacuum.a70",  // UltronSPlus
	"roborock.vacuum.a86",  // PearlPlus   - newDefaultFeatures, A65:216030
	"roborock.vacuum.a87",  // PearlPlus
	"roborock.vacuum.a94",  // UltronSC    - copies Ultron.features, A65:216295
	"roborock.vacuum.a95",  // UltronSC
	"roborock.vacuum.a96",  // UltronSV    - newDefaultFeatures, A65:216347
	"roborock.vacuum.a97",  // UltronSV
	"roborock.vacuum.a116", // PearlPlusS  - copies PearlPlus.features, A65:216055
	"roborock.vacuum.a117", // PearlPlusS
	"roborock.vacuum.a134", // Vivian      - inheritedConfig PearlPlus, A65:216123
	"roborock.vacuum.a135", // Vivian
	"roborock.vacuum.a136", // PearlPlusS
	"roborock.vacuum.a143", // CoralPro    - inheritedConfig Coral, A65:216198
	"roborock.vacuum.a144", // CoralPro
	"roborock.vacuum.a146", // Verdelite   - inheritedConfig UltronSV, A65:216374
	"roborock.vacuum.a147", // Verdelite
	"roborock.vacuum.a155", // Vivian
	"roborock.vacuum.a156", // Vivian
	"roborock.vacuum.a157", // R50         - inheritedConfig CoralPro, A65:216213
	"roborock.vacuum.a179", // R50
	"roborock.vacuum.a182", // VivianF     - inheritedConfig Vivian, A65:216149
	"roborock.vacuum.a184", // VivianS     - inheritedConfig Vivian, A65:216162
	"roborock.vacuum.a185"  // VivianS
]);

/**
 * The other way to MAX+: `CleanMode_NonePureCleanMopWithMaxPlus`.
 *
 * `FM.isNonePureCleanMopWithMaxPlus()` is `DM.support(MF.CleanMode_NonePureCleanMopWithMaxPlus)`
 * (A65:235529-235545). The plugin describes the feature as "supports the Max+ level but not
 * vacuum-only / mop-only - a very special kind of device" (A65:215677), and the suction list
 * appends 108 for either flag (A65:243124-243133). These models therefore get MAX+ **and** the
 * single combined tab, which is why they are all in {@link NO_PURE_CLEAN_MOP_MODELS} as well.
 *
 * `UltronE` names the feature outright; the other two copy `UltronE.features`.
 */
export const MAX_PLUS_WITHOUT_PURE_CLEAN_MOP_MODELS: ReadonlySet<string> = new Set([
	"roborock.vacuum.a72",  // UltronE   - named outright, A65:216252
	"roborock.vacuum.a84",  // UltronE
	"roborock.vacuum.a73",  // UltronLite - copies UltronE.features, A65:216271
	"roborock.vacuum.a85",  // UltronLite
	"roborock.vacuum.a124", // UltronSE  - copies UltronE.features, A65:216312
	"roborock.vacuum.a125", // UltronSE
	"roborock.vacuum.a139", // UltronSE
	"roborock.vacuum.a140"  // UltronSE
]);

/**
 * Models that do **not** have the vacuum-only and mop-only modes.
 *
 * `CleanMode_PureCleanMop` is one of three features `createDeviceModelConfig` appends implicitly to
 * every model except a hard-coded block list (A65:217466-217470, list at A65:217329-217449). It is
 * therefore absent from every model's feature array in the table, and a search for the feature name
 * inside module 516 finds a single hit that belongs to a *different* feature - which is how one
 * concludes that no model supports the modes at all. The evidence is the block list, not the
 * feature name.
 *
 * A model this list does not mention is treated as capable, including models the plugin's table
 * does not know at all. That is a deliberate deviation from the app, which would answer "no" for an
 * unknown model: all thirteen blocked products are the 2017-2021 generations (Tanos = S5/S6,
 * Ruby = S4/S5, the electronic-water-tank Ultrons), while every device released since has the
 * modes. Assuming a device from 2027 behaves like an S5 would hide a mode the robot really has.
 */
export const NO_PURE_CLEAN_MOP_MODELS: ReadonlySet<string> = new Set([
	"roborock.vacuum.t6",   // Tanos
	"roborock.vacuum.s6",   // Tanos
	"roborock.vacuum.t7",   // TanosE
	"roborock.vacuum.a11",  // TanosE
	"roborock.vacuum.t7p",  // TanosV
	"roborock.vacuum.a09",  // TanosV
	"roborock.vacuum.a10",  // TanosV
	"roborock.vacuum.a37",  // TanosSLite
	"roborock.vacuum.a38",  // TanosSLite
	"roborock.vacuum.a33",  // TanosSE
	"roborock.vacuum.a34",  // TanosSE
	"roborock.vacuum.a39",  // TanosSC
	"roborock.vacuum.a40",  // TanosSC
	"roborock.vacuum.a73",  // UltronLite
	"roborock.vacuum.a85",  // UltronLite
	"roborock.vacuum.a72",  // UltronE
	"roborock.vacuum.a84",  // UltronE
	"roborock.vacuum.a124", // UltronSE
	"roborock.vacuum.a125", // UltronSE
	"roborock.vacuum.a139", // UltronSE
	"roborock.vacuum.a140", // UltronSE
	"roborock.vacuum.t4",   // RubyPlus
	"roborock.vacuum.s4",   // RubyPlus
	"roborock.vacuum.p6",   // RubySLite
	"roborock.vacuum.s5e",  // RubySLite
	"roborock.vacuum.a05",  // RubySLite
	"roborock.vacuum.p5",   // RubySC
	"roborock.vacuum.a08",  // RubySC
	"roborock.vacuum.a19"   // RubySE
]);

/**
 * Normalises a model string the way the other model tables in this adapter do.
 *
 * @param model Model string as the adapter publishes it, e.g. `roborock.vacuum.a65`.
 * @returns The trimmed, lower-cased model, or an empty string when there is none.
 */
function normalizeModel(model: string | null | undefined): string {
	return model ? model.trim().toLowerCase() : "";
}

/**
 * Whether the model's suction list ends in MAX+ (`fan_power` 108).
 *
 * @param model Model string as the adapter publishes it.
 * @returns True when the plugin's model table proves MAX+ - by either of the two features.
 */
export function supportsCleanModeMaxPlus(model: string | null | undefined): boolean {
	const id = normalizeModel(model);
	return CLEAN_MODE_MAX_PLUS_MODELS.has(id) || MAX_PLUS_WITHOUT_PURE_CLEAN_MOP_MODELS.has(id);
}

/**
 * Whether the model has the vacuum-only and mop-only modes.
 *
 * @param model Model string as the adapter publishes it.
 * @returns True unless the model is one of the blocked legacy products.
 */
export function supportsPureCleanMop(model: string | null | undefined): boolean {
	return !NO_PURE_CLEAN_MOP_MODELS.has(normalizeModel(model));
}

/** Reads a value that may arrive as a string from the robot, and rejects everything unusable. */
function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether the three values say "every room carries its own setting".
 *
 * `isModeCustomized` (A65:242715-242773) is `clean === 106 || water === 204 || mop === 302` on
 * robots with a vibrating or spinning mop and drops the `mop` half on all others. The `mop` half is
 * kept here for every model: a robot without either module has no mop routes and therefore never
 * reports 302, so the two readings cannot disagree on real data - while carrying a second 63-entry
 * model table just to express that would add a transcription risk for no behavioural difference.
 *
 * @param values The three reported values.
 * @returns True when at least one of them is the per-room marker.
 */
function isModeCustomized(values: CleaningModeValues): boolean {
	return (
		toNumber(values.fan_power) === FAN_POWER_CUSTOM ||
		toNumber(values.water_box_mode) === WATER_BOX_MODE_CUSTOM ||
		toNumber(values.mop_mode) === MOP_MODE_CUSTOM
	);
}

/**
 * Derives the mode the app would show from the three values the robot reports.
 *
 * This is `currentTab` (A65:251161-251259) with the tab indices replaced by names, so the order of
 * the tests matters and is kept: SmartPlan wins over everything, vacuum-only wins over mop-only,
 * and both win over the per-room markers.
 *
 * The SmartPlan test is the one deviation from the app. `isSmartModeSet` (A65:242833-242869) reads
 * `(clean === 110 || water === 209 || mop === 306) ? isNewFeatureStrSupport(55) : false`, and the
 * adapter does not read `new_feature_info_str` yet. The bit governs whether the app *offers* the
 * SmartPlan tab, not whether the robot is in that mode, so a robot reporting 110 is treated as
 * being in it. Models whose own profile gives 110 / 209 / 306 a different meaning switch the test
 * off through {@link CleaningModeCapabilities.smartPlan}.
 *
 * @param values The three values out of `get_status`.
 * @param capabilities What the model can do; every flag defaults to true.
 * @returns The mode, or null when not one of the three values was reported.
 */
export function deriveCleaningMode(
	values: CleaningModeValues,
	capabilities: CleaningModeCapabilities = {}
): CleaningMode | null {
	const fan = toNumber(values.fan_power);
	const water = toNumber(values.water_box_mode);
	const mop = toNumber(values.mop_mode);

	if (fan === null && water === null && mop === null) {
		return null;
	}

	if (capabilities.smartPlan !== false && (fan === FAN_POWER_SMART || water === WATER_BOX_MODE_SMART || mop === MOP_MODE_SMART)) {
		return "smart";
	}

	const customized = isModeCustomized(values);

	// A65:251200-251205 - without the pure modes there is one combined tab, not three.
	if (capabilities.pureCleanMop === false) {
		return customized ? "custom" : "general";
	}

	if (water === WATER_BOX_MODE_VACUUM_ONLY) {
		return "vacuum"; // A65:251206-251214
	}
	if (fan === FAN_POWER_MOP_ONLY) {
		return "mop"; // A65:251215-251222
	}
	if (customized) {
		return "custom"; // A65:251223-251233
	}
	return "vacAndMop";
}

/**
 * The mop routes a mode allows, in the order the app lists them.
 *
 * `getCleanRouteItems` (A65:245094-245173) hands the mop-only mode the full `MopMethods()` list and
 * cuts every other mode down to Fast and Standard. `handleModeTabDidChange` enforces the same thing
 * from the other side by resetting 301/303/305 to 300 outside the mop-only mode
 * (A65:247157-247192), so the two are consistent.
 *
 * Which of the four the robot really offers additionally depends on two firmware bits the adapter
 * does not read yet (`new_feature_info_str` bit 8 for Fast, `new_feature_info` bit 41 for Deep+,
 * report §5.4). This function answers what the *mode* allows, not what the firmware has.
 *
 * @param mode The mode in question.
 * @returns The allowed `mop_mode` values.
 */
export function cleaningModeRouteOptions(mode: CleaningMode): number[] {
	if (mode === "mop") {
		return [MOP_MODE_FAST, MOP_MODE_DAILY, MOP_MODE_SUBTLY, MOP_MODE_DEEP_SLOW];
	}
	return [MOP_MODE_FAST, MOP_MODE_DAILY];
}

/**
 * Values that only ever describe a mode, never a level a user picked.
 *
 * When the app switches tabs it restores the last picked levels from its own storage
 * (A65:246964-247075), which by construction holds picker values only. The adapter has no such
 * storage and uses the reported values instead, so the markers have to be dropped here - otherwise
 * "switch to Vac & Mop" while the robot sits in vacuum-only would carry `water_box_mode = 200`
 * along and leave the robot exactly where it was.
 */
const FAN_POWER_NON_LEVELS = new Set([FAN_POWER_MOP_ONLY, FAN_POWER_CUSTOM, FAN_POWER_SMART]);
const WATER_BOX_MODE_NON_LEVELS = new Set([WATER_BOX_MODE_VACUUM_ONLY, WATER_BOX_MODE_CUSTOM, WATER_BOX_MODE_SMART]);
const MOP_MODE_NON_LEVELS = new Set([MOP_MODE_CUSTOM, MOP_MODE_SMART]);

function restoreLevel(value: unknown, nonLevels: ReadonlySet<number>, fallback: number): number {
	const parsed = toNumber(value);
	return parsed === null || nonLevels.has(parsed) ? fallback : parsed;
}

/**
 * The counterpart of {@link deriveCleaningMode}: the values `set_clean_motor_mode` needs.
 *
 * This is `handleModeTabDidChange` (A65:246913-247289) in the same four steps the app runs them:
 *
 * 1. **Base values.** Customize and SmartPlan have fixed triples; every other mode restores the
 *    levels last in effect and falls back to the app's own defaults 102 / 201 / 300.
 * 2. **Mode coercion.** Vacuum-only forces `water_box_mode = 200`, mop-only forces
 *    `fan_power = 105` (A65:247104-247119).
 * 3. **Route reset.** Every mode but mop-only goes back to the Standard route
 *    (A65:247120-247192). The app does this on every tab switch, not only for the thorough routes:
 *    Fast stays *selectable* afterwards ({@link cleaningModeRouteOptions}), it just is not what a
 *    mode switch leaves behind.
 * 4. **MAX+ coercion.** Outside vacuum-only, `fan_power = 108` falls back to 102
 *    (A65:247198-247210).
 *
 * Steps 2 to 4 are what makes the result round-trip: feeding it back into
 * {@link deriveCleaningMode} returns the mode that was asked for.
 *
 * @param mode The mode to switch to.
 * @param previous The values currently in effect, used to keep the user's levels across the switch.
 * @param capabilities Set `mopRoutes: false` for models that have no `mop_mode` at all.
 * @returns The payload of `set_clean_motor_mode`, without the keys the model does not use.
 */
export function cleaningModeValues(
	mode: CleaningMode,
	previous: CleaningModeValues = {},
	capabilities: CleaningModeCapabilities = {}
): CleanMotorModeParams {
	const withRoutes = capabilities.mopRoutes !== false;

	// 1. Base values.
	let fan: number;
	let water: number;
	let mop: number | null;
	if (mode === "smart") {
		fan = FAN_POWER_SMART;
		water = WATER_BOX_MODE_SMART;
		mop = withRoutes ? MOP_MODE_SMART : null;
	} else if (mode === "custom") {
		fan = FAN_POWER_CUSTOM;
		water = WATER_BOX_MODE_CUSTOM;
		mop = withRoutes ? MOP_MODE_CUSTOM : null;
	} else {
		fan = restoreLevel(previous.fan_power, FAN_POWER_NON_LEVELS, FAN_POWER_NORMAL);
		water = restoreLevel(previous.water_box_mode, WATER_BOX_MODE_NON_LEVELS, WATER_BOX_MODE_NORMAL);
		mop = withRoutes ? restoreLevel(previous.mop_mode, MOP_MODE_NON_LEVELS, MOP_MODE_DAILY) : null;

		// 2. Mode coercion.
		if (mode === "vacuum") {
			water = WATER_BOX_MODE_VACUUM_ONLY;
		}
		if (mode === "mop") {
			fan = FAN_POWER_MOP_ONLY;
		}

		// 3. Route reset.
		if (mode !== "mop" && mop !== null) {
			mop = MOP_MODE_DAILY;
		}

		// 4. MAX+ coercion.
		if (fan === FAN_POWER_MAX_PLUS && mode !== "vacuum") {
			fan = FAN_POWER_NORMAL;
		}
	}

	const values: CleanMotorModeParams = { fan_power: fan, water_box_mode: water };
	if (mop !== null) {
		values.mop_mode = mop;
	}
	return values;
}

/**
 * The modes a model can actually be put into, in the app's tab order.
 *
 * SmartPlan is left out on purpose: whether a robot has it hangs on `new_feature_info_str` bit 55
 * (A65:251289-251320), which the adapter does not read, and sending 110 / 209 / 306 to a robot
 * without it is a guess at the robot's expense. Customize is left out for the same class of reason
 * turned around - `isCustomModeSupported()` excludes four legacy products (A65:232055-232114), all
 * of which are in {@link NO_PURE_CLEAN_MOP_MODELS} and therefore already covered.
 *
 * @param model Model string as the adapter publishes it.
 * @returns `general` alone for the legacy products, otherwise the three real modes.
 */
export function cleaningModesForModel(model: string | null | undefined): CleaningMode[] {
	if (!supportsPureCleanMop(model)) {
		return ["general"];
	}
	return ["vacAndMop", "mop", "vacuum"];
}

/**
 * Builds the `common.states` of the `set_clean_motor_mode` command: one JSON payload per mode.
 *
 * The command has always taken a JSON string, so a dropdown of ready-made payloads is the shape it
 * already had. What changes is that the payloads now come from the mode logic instead of being
 * written out by hand - the six hand-written ones were wrong in four places (report §10.1): they
 * labelled the Vac & Mop triple "Indv.", used `mop_mode = 301` on a mode that forbids it, called
 * `mop_mode = 306` "vacuum, then mop" when it is SmartPlan, and labelled the Customize triple
 * "Smart Plan".
 *
 * @param model Model string as the adapter publishes it.
 * @param defaults The levels to carry into the modes; pass the robot's current ones when known.
 * @param capabilities Set `mopRoutes: false` for models without `mop_mode`.
 * @returns Payload JSON as key, mode label as value, in the app's tab order.
 */
export function buildCleanMotorModePresets(
	model: string | null | undefined,
	defaults: CleaningModeValues = {},
	capabilities: CleaningModeCapabilities = {}
): Record<string, string> {
	const presets: Record<string, string> = {};
	for (const mode of cleaningModesForModel(model)) {
		const values = cleaningModeValues(mode, defaults, capabilities);
		// Key order matches the payloads the adapter has always written, so an existing selection
		// keeps matching its entry after the update.
		const payload: Record<string, number> = { fan_power: values.fan_power };
		if (values.mop_mode !== undefined) {
			payload.mop_mode = values.mop_mode;
		}
		payload.water_box_mode = values.water_box_mode;
		presets[JSON.stringify(payload)] = CLEANING_MODE_STATES[CLEANING_MODE_STATE_VALUES[mode]];
	}
	return presets;
}
