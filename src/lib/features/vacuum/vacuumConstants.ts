import { ADAPTER_ERRORS_EN } from "./adapterErrorMapping";
import { CLEANING_MODE_STATES } from "./cleaningModes";

/**
 * # The cleaning-mode enums, as the Roborock app itself labels them
 *
 * The values below are not guesses. They are read out of the decompiled device control plugin
 * `roborock.vacuum.a65_control_v5208`, module 565, where every entry of the app's own mode picker
 * carries the protocol value (`strength`) and the i18n key of its label in one object literal, and
 * out of module 1683 (`CleanSettingMode`, `WaterSettingMode`, `MopSettingMode`). The English and
 * German texts come from the translation dictionaries compiled into the same bundle (modules 489
 * and 496). See `_appanalysis/14-editor-methoden.md` §3.2-3.4 and
 * `lib/protocols/roborock_vacuum_enums.json`.
 *
 * Two things the app does that the adapter used to get wrong:
 *
 * 1. **105 is not "Off".** Its internal name is `NoClean` / `CleanModeZero`, but the picker shows
 *    it as **Gentle / Schonend** and lists it *first*, before Quiet. "Off" and "Gentle" are
 *    different things to a user.
 * 2. **Not every value is a level.** 106 / 302 / 204 are markers meaning "this room has its own
 *    setting", and 110 / 306 / 209 mean "SmartPlan decides". The app has no picker entry and no
 *    icon for any of them; they only ever arrive in `get_status`. They are therefore documented
 *    here so a reported value renders as text, but they are deliberately absent from the
 *    selectable sets in `v1VacuumFeatures.ts`.
 */

/** Marker value: the level is set per room, not globally. Never selectable. */
const LABEL_PER_ROOM = "Per-Room";

/** Marker value: SmartPlan picks the level. Never selectable. */
const LABEL_SMART_PLAN = "SmartPlan";

/**
 * Every `fan_power` value the control plugin knows, with the app's own English label.
 *
 * Order of the app's picker is 105, 101, 102, 103, 104 and then 108 - the strength order does not
 * start at 101. 107 and 109 appear nowhere in the bundle and stay out.
 */
export const FAN_POWER_LABELS: Readonly<Record<number, string>> = {
	101: "Quiet",       // SilentClean
	102: "Balanced",    // StandardClean / CleanModeNormal
	103: "Turbo",       // StrongClean
	104: "Max",         // MaxClean
	105: "Gentle",      // NoClean / CleanModeZero - shown as Gentle, not as Off
	106: LABEL_PER_ROOM, // CustomCleanMode
	108: "Max+",        // MaxPlus / CleanModeMaxPlus
	110: LABEL_SMART_PLAN // SmartCleanMode
};

/**
 * Every `mop_mode` value the control plugin knows, with the app's own English label.
 *
 * 303 and 305 share one label on purpose - the app shows "Deep+" for both and lets the firmware
 * capability decide which of the two it sends.
 */
export const MOP_MODE_LABELS: Readonly<Record<number, string>> = {
	300: "Standard",     // Normal / CleanRouteDailyMode
	301: "Deep",         // Intensive / CleanRouteSubtlyMode
	302: LABEL_PER_ROOM, // CustomMopMode
	303: "Deep+",        // SlowIntensive / CleanRouteDeepSlowMode
	304: "Fast",         // Fast / CleanRouteFastMode
	305: "Deep+",        // CleanRouteDeepSlowPearlMode - same label as 303
	306: LABEL_SMART_PLAN // SmartMopMode
};

/**
 * `water_box_mode` labels for robots **without** a vibrating mop module.
 *
 * Keys `water_box_small` / `water_box_middle` / `water_box_big` = Low / Medium / High
 * (Niedrig / Mittel / Hoch).
 */
export const WATER_BOX_MODE_LABELS_STANDARD: Readonly<Record<number, string>> = {
	200: "Off",     // NoWater / WaterModeZero
	201: "Low",     // LowWater / WaterModeNormal
	202: "Medium",  // MediumWater / WaterModeMiddle
	203: "High"     // HighWater
};

/**
 * `water_box_mode` labels for robots **with** a vibrating mop module (Roborock's SonicMop).
 *
 * Same protocol values, different words: keys `tanos_s_mop_mode_weak` / `_middle` / `_strong` =
 * Mild / Standard / Intense (Sanft / Standard / Intensiv). Which of the two sets applies is not in
 * `get_status`, `new_feature_info` or `firmwareFeatures` - see {@link SHAKE_MOP_MODELS}.
 */
export const WATER_BOX_MODE_LABELS_SHAKE_MOP: Readonly<Record<number, string>> = {
	200: "Off",
	201: "Mild",
	202: "Standard",
	203: "Intense"
};

/** `tanos_s_mop_mode_max` = Extreme / Extrem. Vibrating-mop hardware only, see below. */
export const WATER_BOX_MODE_EXTREME_LABEL = "Extreme";

/**
 * Every `water_box_mode` value the control plugin knows, in the standard wording.
 *
 * 205 and 206 appear nowhere in the bundle. They are neither proven nor disproven, so they keep
 * the label the adapter has always given them rather than gaining a made-up one.
 */
export const WATER_BOX_MODE_LABELS: Readonly<Record<number, string>> = {
	...WATER_BOX_MODE_LABELS_STANDARD,
	204: LABEL_PER_ROOM, // CustomWaterMode - the marker, not the user-defined amount
	205: "Custom",       // not in the bundle - unchanged
	206: "Custom",       // not in the bundle - unchanged
	207: "Custom",       // WaterModeUserCustom - this is the real user-defined amount
	208: WATER_BOX_MODE_EXTREME_LABEL, // MaxWater
	209: LABEL_SMART_PLAN              // SmartWaterMode
};

/**
 * Models whose water levels the app words as Mild / Standard / Intense.
 *
 * The app decides this with `DM.support(MF.Mop_ShakeModule)` (module 565), which resolves against
 * a model table compiled into the plugin (module 516, 43 device configs, each with a `shortModels`
 * array and a `features` array). `mf.mop_shake_module` is described there as wiping with a
 * vibration module - Roborock's SonicMop. The condition is therefore **not** derivable from any
 * device response, but it is derivable from the model string, which the adapter already has.
 *
 * The list is a snapshot of plugin version 5208 and is kept identical to `SHAKE_MOP_MODELS` in
 * `src-tab/src/engine/modeIcons.ts`, which picks the matching artwork. A model that is not in it
 * falls back to the standard wording - newer devices may well belong here, and the established
 * words are the safer error.
 *
 * @see lib/protocols/roborock_map_edit.json - `modeIcons.waterBoxMode.shakeMopPredicate`
 */
export const SHAKE_MOP_MODELS: ReadonlySet<string> = new Set([
	"roborock.vacuum.a14", // TanosS
	"roborock.vacuum.a15", // TanosS
	"roborock.vacuum.a26", // TopazSV
	"roborock.vacuum.a27", // TopazSV
	"roborock.vacuum.a29", // TopazS
	"roborock.vacuum.a30", // TopazS
	"roborock.vacuum.a46", // TopazSPlus
	"roborock.vacuum.a47", // TopazSPlus
	"roborock.vacuum.a50", // Ultron
	"roborock.vacuum.a51", // Ultron
	"roborock.vacuum.a52", // TanosSMax
	"roborock.vacuum.a62", // TopazSPower
	"roborock.vacuum.a64", // TopazSC
	"roborock.vacuum.a65", // TopazSC
	"roborock.vacuum.a66", // TopazSPlus
	"roborock.vacuum.a76", // TopazS
	"roborock.vacuum.a96", // UltronSV
	"roborock.vacuum.a97"  // UltronSV
]);

/**
 * Whether this model words its water levels Mild / Standard / Intense instead of Low / Medium /
 * High.
 *
 * @param model Model string as the adapter publishes it, e.g. `roborock.vacuum.a65`.
 * @returns True when the vibrating-mop wording applies.
 */
export function usesShakeMopWaterLabels(model: string | null | undefined): boolean {
	return !!model && SHAKE_MOP_MODELS.has(model.trim().toLowerCase());
}

/**
 * The i18n keys the Roborock app itself uses for these labels.
 *
 * `lib/protocols/roborock_strings.json` ships every one of them in ~30 languages, so a future
 * change that wants localized `common.states` can resolve them through
 * `adapter.translationManager.get(key, englishFallback)` exactly the way the error codes already
 * do - no new translation work needed. Recorded here so the evidence does not live only in a
 * report.
 */
export const MODE_LABEL_TRANSLATION_KEYS = {
	fan_power: {
		101: "localization_strings_Common_Protocol_0", // Quiet / Leise
		102: "localization_strings_Common_Protocol_1", // Balanced / Normal
		103: "localization_strings_Common_Protocol_2", // Turbo / Turbo
		104: "localization_strings_Common_Protocol_3", // Max / Max.
		105: "localization_strings_Common_Protocol_4", // Gentle / Schonend
		108: "clean_mode_max_plus"                     // MAX+ / MAX+
	},
	water_box_mode_standard: {
		200: "debug_info_close",  // Off / Aus
		201: "water_box_small",   // Low / Niedrig
		202: "water_box_middle",  // Medium / Mittel
		203: "water_box_big",     // High / Hoch
		207: "localization_strings_Setting_Timer_Common_4", // Custom / Benutzerdefiniert
		208: "tanos_s_mop_mode_max"                        // Extreme / Extrem
	},
	water_box_mode_shake_mop: {
		201: "tanos_s_mop_mode_weak",   // Mild / Sanft
		202: "tanos_s_mop_mode_middle", // Standard / Standard
		203: "tanos_s_mop_mode_strong"  // Intense / Intensiv
	},
	mop_mode: {
		300: "tanos_s_mop_mode_general_frag", // Standard / Standard
		301: "tanos_s_mop_mode_fine_frag",    // Deep / Gründlich
		303: "mop_method_careful_slow",       // Deep+ / Gründlich+
		304: "clean_route_fast_mode_title",   // Fast / Schnell
		305: "mop_method_careful_slow"        // Deep+ / Gründlich+
	}
} as const;

/**
 * `in_cleaning` - which kind of task the robot could resume.
 *
 * `12-plugins-cloud.md` §2.4 flagged a contradiction: the `CleanResumeFlag` declaration comments
 * claimed 2 = Segment and 3 = Zone, while the executed `CleanResumeFlagCodeMap` mapped the other
 * way round. `14-editor-methoden.md` §3.5 settles it from a second, independent bundle (module
 * 522, status parser): that bundle carries no contradicting comment and maps
 * 2 -> `Zone_Clean`, 3 -> `Segment_Clean`. That is what the adapter had assumed all along.
 */
const IN_CLEANING_STATES: Record<number, string> = {
	0: "None",
	1: "Global Clean",
	2: "Zone Clean",
	3: "Segment Clean",
	// Only in the earlier bundle (roborock_vacuum_enums.json), not re-proven in module 522.
	4: "Quick Build Map",
};

const Z70_TIDY_UP_TASK_STATES: Record<number, string> = {
	0: "No Need",
	1: "Need",
	2: "To Tidy",
	3: "Success",
	4: "Not Found",
	5: "User Handled",
	6: "Shoes Unsupported",
	7: "Object Unreachable",
	8: "Object On Carpet",
	9: "Object In Forbidden Zone",
	10: "Object In Low Area",
	11: "Object In Unsafe Area",
	12: "Object Overweight",
	13: "Put Point Unreachable",
	14: "Put Point Not Found",
	15: "Put Down Failed",
	16: "Failed To Grasp",
	17: "Failed To Compute Joints",
	18: "Out Compartment Failed",
	19: "Out Compartment Invalid Area",
	20: "Grasp Position Unreachable",
	21: "Already In Storage Zone",
};

const Z70_BACK_TYPE_STATES: Record<number, string> = {
	1: "Washing Mop",
	2: "Setting Up Mop",
	3: "Removing Mop",
	4: "Collecting Dust",
};

const Z70_WASH_PHASE_STATES: Record<number, string> = {
	11: "Running",
	17: "Pumping",
};

const Z70_WASHING_MODE_STATES: Record<number, string> = {
	6: "Dock Self-Cleaning",
	7: "Water Draining",
	11: "Pumping Water",
};

const Z70_WATER_SHORTAGE_STATES: Record<number, string> = {
	0: "Normal",
	1: "Water Shortage",
};

export const VACUUM_CONSTANTS = {
	errorCodes: {
		0: "No error",
		// Use S7 MaxV English defaults as the standardized error definition for the entire adapter
		// This supersedes legacy hardcoded lists and serves as the baseline for V1 and B01
		...ADAPTER_ERRORS_EN,
		// Add legacy/missing codes
		254: "Bin full",
		255: "Internal error",
		"-1": "Unknown Error",
	},
	stateCodes: {
		0: "Unknown",
		1: "Initiating",
		2: "Sleeping",
		3: "Idle",
		4: "Remote Control",
		5: "Cleaning",
		6: "Returning Dock",
		7: "Manual Mode",
		8: "Charging",
		9: "Charging Error",
		10: "Paused",
		11: "Spot Cleaning",
		12: "In Error",
		13: "Shutting Down",
		14: "Updating",
		15: "Docking",
		16: "Go To",
		17: "Zone Clean",
		18: "Room Clean",
		22: "Emptying dust container",
		23: "Washing the mop",
		25: "Washing duster",
		26: "Going to wash the mop",
		28: "In call",
		29: "Mapping",
		30: "Egg attack",
		32: "Patrol",
		33: "Setting up the mop",
		34: "Removing the mop",
		36: "Exhibition mode",
		37: "Dance",
		38: "Tidy-up housework",
		39: "Remote pick-up",
		40: "Emergency stop",
		41: "Arm resetting",
		42: "Program mode",
		100: "Fully Charged",
		101: "Offline",
		102: "Unknown",
	},
	dockTypes: {
		0: "Charging dock",
		1: "Auto-Empty Dock",
		2: "Empty Wash Fill Dock",
		3: "Empty Wash Fill (Dry) Dock",
		5: "Auto-Empty Dock (Q8 Max+)",
		6: "Empty Wash Fill Dry Dock (S8 Pro Ultra)",
		7: "Empty Wash Fill Dry Dock (S8 Pro Ultra)",
		8: "Empty Wash Fill Dry Dock (Q Revo)",
		9: "Empty Wash Fill Dry Dock (Q Revo Pro)",
		10: "Empty Wash Fill Dock (S7 MaxV Ultra)",
		14: "Empty Wash Fill Dry Dock (Qrevo Master)",
		15: "Empty Wash Fill Dry Dock (Qrevo S)",
		16: "Empty Wash Fill Dry Dock (Saros 10R / Saros Z70)",
		17: "Empty Wash Fill Dry Dock (Qrevo Curv)",
		18: "Empty Wash Fill Dry Dock (S8 Pro)",
	},
	// B01 Devices: Property lists (Protocol 101/102 via prop.get)
	b01StatusProps: [
		"status", "fault", "wind", "water", "mode", "quantity", "repeat_state", "tank_state",
		"sweep_type", "clean_path_preference", "cloth_state", "time_zone", "time_zone_info",
		"language", "cleaning_time", "real_clean_time", "cleaning_area", "custom_type",
		"work_mode", "charge_state", "current_map_id", "map_num", "dust_action",
		"quiet_is_open", "clean_finish", "build_map", "dust_frequency", "multi_floor",
		"pv_charging", "recommend", "add_sweep_status", "clean_fluid"
	],
	b01SettingsProps: [
		"alarm", "volume", "hypa", "main_brush", "side_brush", "mop_life", "main_sensor",
		"net_status", "sound", "station_act", "quiet_begin_time", "quiet_end_time",
		"voice_type", "voice_type_version", "order_total", "privacy", "dust_auto_state",
		"light_mode", "order_save_mode", "manufacturer", "child_lock", "charge_station_type",
		"carpet_turbo", "green_laser"
	],

	baseCommands: {
		app_start: { type: "boolean", def: false },
		app_segment_clean: { type: "boolean", def: false },
		app_stop: { type: "boolean", def: false },
		app_pause: { type: "boolean", def: false },
		app_charge: { type: "boolean", def: false },
		app_spot: { type: "boolean", def: false },
		app_zoned_clean: { type: "json" },
		resume_zoned_clean: { type: "boolean", def: false },
		stop_zoned_clean: { type: "boolean", def: false },
		resume_segment_clean: { type: "boolean", def: false },
		stop_segment_clean: { type: "boolean", def: false },
		// Selectable levels only - the markers 106 and 110 are status values, never commands.
		set_custom_mode: { type: "number", def: 102, states: { 101: "Quiet", 102: "Balanced", 103: "Turbo", 104: "Max", 105: "Gentle" } },
		find_me: { type: "boolean", def: false },
		app_goto_target: { type: "json" },
		set_clean_motor_mode: { type: "json", def: '{"fan_power":102,"mop_mode":300,"water_box_mode":201}' },
	},
	deviceStates: {
		dock_type: {
			name: "Dock Type",
			type: "number",
			states: {
				0: "Charging dock",
				1: "Auto-Empty Dock",
				2: "Empty Wash Fill Dock",
				3: "Empty Wash Fill (Dry) Dock",
				5: "Auto-Empty Dock (Q8 Max+)",
				6: "Empty Wash Fill Dry Dock (S8 Pro Ultra)",
				7: "Empty Wash Fill Dry Dock (S8 Pro Ultra)",
				8: "Empty Wash Fill Dry Dock (Q Revo)",
				9: "Empty Wash Fill Dry Dock (Q Revo Pro)",
				10: "Empty Wash Fill Dock (S7 MaxV Ultra)",
				14: "Empty Wash Fill Dry Dock (Qrevo Master)",
				15: "Empty Wash Fill Dry Dock (Qrevo S)",
				16: "Empty Wash Fill Dry Dock (Saros 10R / Saros Z70)",
				17: "Empty Wash Fill Dry Dock (Qrevo Curv)",
				18: "Empty Wash Fill Dry Dock (S8 Pro)",
			}
		},
		error_code: { type: "number", states: {} },
		clean_area: { type: "number", unit: "m²" },
		clean_time: { type: "number", unit: "min" },
		battery: { type: "number", unit: "%" },
		state: { type: "number", states: {} },
		// Read-side fallbacks: every value the robot may report, markers included. The selectable
		// subsets live in v1VacuumFeatures.ts (BASE_FAN / BASE_WATER / BASE_MOP).
		fan_power: { type: "number", states: FAN_POWER_LABELS },
		clean_percent: { type: "number", unit: "%" },
		water_box_mode: { type: "number", states: WATER_BOX_MODE_LABELS },
		mop_mode: { type: "number", states: MOP_MODE_LABELS },
		// Derived, not reported: what the three values above mean together. See cleaningModes.ts.
		clean_mode_tab: { type: "number", states: CLEANING_MODE_STATES },
		carpet_mode: {
			type: "string",
			states: {
				'[{"enable":0,"stall_time":10,"current_low":400,"current_high":500,"current_integral":450}]': "off",
				'[{"enable":1,"stall_time":10,"current_low":400,"current_high":500,"current_integral":450}]': "on",
			},
		},
		carpet_clean_mode: {
			type: "number",
			states: {
				0: "Avoid",
				1: "Rise",
				2: "Ignore",
			},
		},
		unsave_map_flag: { type: "number" },
		unsave_map_reason: { type: "number" },
		dock_error_status: { type: "number" },
		debug_mode: { type: "number" },
		auto_dust_collection: { type: "number" },
		dust_collection_status: { type: "number" },
		adbumper_status: { type: "string" },
		lock_status: { type: "number" },
		is_locating: { type: "number" },
		map_status: { type: "number" },
		dnd_enabled: { type: "number" },
		lab_status: { type: "number" },
		in_fresh_state: { type: "number" },
		in_returning: { type: "number" },
		in_cleaning: { type: "number", states: IN_CLEANING_STATES },
		in_warmup: { type: "number" },
		map_present: { type: "number" },
		is_exploring: { type: "number" },
		events: { type: "string" },
		subdivision_sets: { type: "number" },
		repeat: { type: "number" },
		replenish_mode: { type: "number" },
		rdt: { type: "number" },
		camera_status: { type: "number" },
		distance_off: { name: "Distance Off", type: "number" },
		wash_phase: { type: "number", states: Z70_WASH_PHASE_STATES },
		wash_ready: { type: "number" },
		wash_status: { type: "number" },
		back_type: { type: "number", states: Z70_BACK_TYPE_STATES },
		backTypeLabel: { name: "Back Dock Substate", type: "string" },
		collision_avoid_status: { type: "number" },
		avoid_count: { type: "number" },
		switch_map_mode: { type: "number" },
		charge_status: { type: "number" },
		dry_status: { type: "number" },
		extra_time: { type: "number" },
		rss: { type: "number" },
		dss: { type: "number" },
		common_status: { type: "number" },
		hasDockError: { name: "Dock Error Active", type: "boolean" },
		isAutoDeliveryOn: { name: "Auto Delivery Active", type: "boolean" },
		isVocieControlActive: { name: "Voice Control Active", type: "boolean" },
		patrolStatus: { name: "Patrol Status", type: "number" },
		patrolActive: { name: "Patrol Active", type: "boolean" },
		mechanicalTidyUpHouseworkState: {
			name: "Mechanical Tidy-Up Housework State",
			type: "number",
			states: {
				0: "Idle",
				1: "Active",
			},
		},
		mechanicalArmGrabStatus: {
			name: "Mechanical Arm Grab Status",
			type: "number",
			states: {
				0: "Not Started",
				1: "Exiting Door",
				2: "Entering Door",
				3: "Waiting",
				4: "Grabbing",
				5: "Putting Down",
				7: "Continue",
				8: "Mode Changing",
				9: "Continue to Grab",
				10: "Continue to Put Down",
			},
		},
		mechanicalArmGrabMode: {
			name: "Mechanical Arm Grab Mode",
			type: "number",
			states: {
				0: "Off",
				1: "Manual",
				2: "Auto",
			},
		},
		mechanicalArmGrabResult: {
			name: "Mechanical Arm Grab Result",
			type: "number",
			states: {
				0: "No Success",
				1: "Success",
			},
		},
		assistedTidyUp: {
			name: "Assisted Tidy-Up",
			type: "number",
			states: {
				0: "Off",
				1: "On",
			},
		},
		mechanicalArmActiveStatus: {
			name: "Mechanical Arm Active Status",
			type: "number",
			states: {
				0: "Inactive",
				1: "Active",
			},
		},
		canChangeCameraStatus: {
			name: "Can Change Camera Status",
			type: "number",
			states: {
				0: "No",
				1: "Yes",
			},
		},
		notInGrabMode: { name: "Not In Grab Mode", type: "boolean" },
		manualGrabMode: { name: "Manual Grab Mode", type: "boolean" },
		autoGrabMode: { name: "Auto Grab Mode", type: "boolean" },
		notStart: { name: "Grab Not Started", type: "boolean" },
		isExitingDoor: { name: "Arm Exiting Door", type: "boolean" },
		isEnteringDoor: { name: "Arm Entering Door", type: "boolean" },
		isWaiting: { name: "Arm Waiting", type: "boolean" },
		isGrabing: { name: "Arm Grabbing", type: "boolean" },
		isPuttingDown: { name: "Arm Putting Down", type: "boolean" },
		isContinue: { name: "Arm Continue", type: "boolean" },
		isContinueToGrab: { name: "Arm Continue To Grab", type: "boolean" },
		isContinueToPutDown: { name: "Arm Continue To Put Down", type: "boolean" },
		isMechanicalModeChanging: { name: "Mechanical Mode Changing", type: "boolean" },
		isGrabSucessful: { name: "Grab Successful", type: "boolean" },
		isEmergencyStopStatus: { name: "Emergency Stop Active", type: "boolean" },
		isArmResetting: { name: "Arm Resetting", type: "boolean" },
		isProgramMode: { name: "Program Mode Active", type: "boolean" },
		isLocked: { name: "Locked", type: "boolean" },
		isDrying: { name: "Drying", type: "boolean" },
		isExitingDock: { name: "Exiting Dock", type: "boolean" },
		isBackDockWashingDusterMode: { name: "Back Dock Washing Duster Mode", type: "boolean" },
		isWashing: { name: "Washing", type: "boolean" },
		isSpotCleaning: { name: "Spot Cleaning", type: "boolean" },
		isZonedCleaning: { name: "Zoned Cleaning", type: "boolean" },
		isSegmentCleaning: { name: "Segment Cleaning", type: "boolean" },
		dockCanStopCollectDust: { name: "Dock Can Stop Collect Dust", type: "boolean" },
		dockCanStopWash: { name: "Dock Can Stop Wash", type: "boolean" },
		isInBackDockTask: { name: "In Back Dock Task", type: "boolean" },
		isBackDockTaskResumeable: { name: "Back Dock Task Resumeable", type: "boolean" },
		isReadyToCmd: { name: "Ready To Command", type: "boolean" },
		canPauseByToast: { name: "Can Pause By Toast", type: "boolean" },
		isTidyUpHouseWork: { name: "Tidy-Up Housework", type: "boolean" },
		offlineMapEnabled: { name: "Offline Map Enabled", type: "boolean" },
		hasCleanFluidModule: { name: "Clean Fluid Module Installed", type: "boolean" },
		isSettingCarpetFirstOn: { name: "Carpet-First Cleaning Enabled", type: "boolean" },
		isSettingCarpetCrossOn: { name: "Cross-Carpet Cleaning Enabled", type: "boolean" },
		isSettingDirtyReplenishOn: { name: "Dirty-Replenish Cleaning Enabled", type: "boolean" },
		washPhaseLabel: { name: "Wash Phase", type: "string" },
		isHomeButtonsEnabled: { name: "Home Buttons Enabled", type: "boolean" },
		isHomeModeControlButtonsEnabled: { name: "Home Mode Control Buttons Enabled", type: "boolean" },
		isHomeMapEditButtonsEnabled: { name: "Home Map Edit Buttons Enabled", type: "boolean" },
		isHomeSettingButtonEnabled: { name: "Home Setting Button Enabled", type: "boolean" },
		hasMechanicalArmEmergencyError: { name: "Mechanical Arm Emergency Error", type: "boolean" },
		mechArmTidyupTaskState: {
			name: "Mechanical Tidy-Up Task State",
			type: "number",
			states: Z70_TIDY_UP_TASK_STATES,
		},
		mechArmTidyupObjectType: {
			name: "Mechanical Tidy-Up Object Type",
			type: "number",
			states: {
				0: "None",
				2: "Shoes",
				34: "Fabrics / Sock",
				51: "Clumps / Curled Fabric",
			},
		},
		mechArmTidyupObjectLabel: { name: "Mechanical Tidy-Up Object Label", type: "string" },
		mechArmMoveTaskState: {
			name: "Mechanical Move Task State",
			type: "number",
			states: Z70_TIDY_UP_TASK_STATES,
		},
		mechArmMoveObjectType: {
			name: "Mechanical Move Object Type",
			type: "number",
			states: {
				0: "None",
				2: "Shoes",
				34: "Fabrics / Sock",
				51: "Clumps / Curled Fabric",
			},
		},
		mechArmMoveObjectLabel: { name: "Mechanical Move Object Label", type: "string" },
		isMechArmDoingTidyupTask: { name: "Mechanical Tidy-Up Task Active", type: "boolean" },
		isMechArmDoingMoveTask: { name: "Mechanical Move Task Active", type: "boolean" },
		cameraEnabled: { name: "Camera Enabled", type: "boolean" },
		petModeEnabled: { name: "Pet Mode Enabled", type: "boolean" },
		realTimeMonitorEnabled: { name: "Real-Time Monitor Enabled", type: "boolean" },
		ledSetting: { name: "Camera LED Setting", type: "number" },
		monitorPrivacyPolicyAgreed: { name: "Monitor Privacy Policy Agreed", type: "boolean" },
		explorationEnabled: { name: "Exploration Enabled", type: "boolean" },
		hasShownPetModeAlert: { name: "Has Shown Pet Mode Alert", type: "boolean" },
		realVideoSetting: {
			name: "Real Video Setting",
			type: "number",
			states: {
				0: "Lightly Disturb",
				1: "Strong Reminder",
				2: "Do Not Disturb",
			},
		},
		mapObjectPhotoEnabled: { name: "Map Object Photo Enabled", type: "boolean" },
		mapObjectPhotoPrivacyPolicyAgreed: { name: "Map Object Photo Privacy Policy Agreed", type: "boolean" },
		realTimeVideoWithTwoKeysStatus: {
			name: "Real-Time Video Two-Key Status",
			type: "number",
			states: {
				0: "Off",
				1: "Waiting Activation",
				2: "Active",
			},
		},
		petSnapshotEnabled: { name: "Pet Snapshot Enabled", type: "boolean" },
		mechanicalCameraEnabled: { name: "Mechanical Camera Enabled", type: "boolean" },
		kct: { type: "number" },
		sterilize_status: { type: "number" },
		rst: { type: "number" },
		switch_status: { type: "number" },
		last_clean_t: { type: "string" },
		cleaning_info: { type: "string" },
		exit_dock: { type: "number" },
		clean_tidyup_status: { name: "Tidy-Up Status", type: "number" },
		assist_clean_status: { name: "Assist Clean Status", type: "number" },
		sub_error_code: { name: "Sub Error Code", type: "number" },
		dtof_status: { type: "number" },
		seq_type: { type: "number" },
		mop_forbidden_enable: { type: "number" },
		voice_chat_status: {
			type: "number",
			states: {
				0: "Inactive",
				1: "Active",
			},
		},
		corner_clean_mode: { type: "number" },
		home_sec_status: {
			type: "number",
			states: {
				0: "Disconnected",
				1: "Connected",
				2: "Disconnecting",
			},
		},
		home_sec_enable_password: {
			type: "number",
			states: {
				0: "Disabled",
				1: "Enabled",
			},
		},
		monitor_status: {
			type: "number",
			states: {
				0: "Inactive",
				1: "Active",
			},
		},
		homeSecClientId: { name: "Home Security Client ID", type: "string" },
		isHomeSecControlledByCurrentClient: { name: "Home Security Controlled By Current Client", type: "boolean" },
		isHomeSecFreeControl: { name: "Home Security Free Control", type: "boolean" },
		isHomeSecRunning: { name: "Home Security Running", type: "boolean" },
		isHomeSecDisconnected: { name: "Home Security Disconnected", type: "boolean" },
		isHomeSecDisconnecting: { name: "Home Security Disconnecting", type: "boolean" },
		isHomeSecPreviewStartReady: { name: "Home Security Preview Start Ready", type: "boolean" },
		isHomeSecPreviewRetryPending: { name: "Home Security Preview Retry Pending", type: "boolean" },
		isHomeSecPreviewOwnedByCurrentClient: { name: "Home Security Preview Owned By Current Client", type: "boolean" },
		isHomeSecPreviewBlockedByOtherClient: { name: "Home Security Preview Blocked By Other Client", type: "boolean" },
		homeSecPasswordEnabled: { name: "Home Security Password Enabled", type: "boolean" },
		monitorActive: { name: "Monitor Active", type: "boolean" },
		voiceChatActive: { name: "Voice Chat Active", type: "boolean" },
		clean_fluid: { type: "number" },
		water_box_carriage_status: { type: "number" },
		water_box_status: { type: "number" },
		water_shortage_status: { type: "number", states: Z70_WATER_SHORTAGE_STATES },
		waterShortageActive: { name: "Water Shortage Active", type: "boolean" },
		cleaned_area: { type: "number", unit: "m²" },
		clean_times: { type: "number" },
		// deviceStatus mirrors what the robot reports. The write surface for these values is the
		// commands folder (commands.green_laser, commands.set_custom_mode, ...), which is the only
		// one that is subscribed – a writable mirror here would look operable and do nothing.
		along_floor: { type: "number", def: 0, states: { 0: "Off", 1: "On" } },
		green_laser: { type: "number", def: 0, states: { 0: "Off", 1: "On" } },
		dust_bag_used: { type: "number", def: 0 },
		add_sweep_status: { type: "number", def: 0, states: { 0: "None", 1: "Active" } },
		clean_finish: { type: "string" },

		status: {
			type: "number",
			def: 3,
			states: {
				1: "Start",
				2: "Stop",
				3: "Idle",
				5: "Cleaning",
				6: "Home",
				7: "Manual",
				8: "Charging",
				9: "Charge Error",
				10: "Pause",
				11: "Spot",
				12: "Error",
				14: "Updating",
				15: "Docking",
				16: "Go To",
				17: "Zone Clean",
				18: "Room Clean",
				22: "Emptying",
				23: "Washing",
				26: "Going to Wash",
				28: "In Call",
				29: "Mapping",
				100: "Fully Charged",
			},
		},
		washingTaskStatus: { name: "Washing Task Status", type: "number", def: 0, states: {} },
		washingMode: { name: "Washing Mode", type: "number", def: 0, states: Z70_WASHING_MODE_STATES },
		washingModeLabel: { name: "Washing Mode Label", type: "string" },
		isCleanCarouselSelfCleaning: { name: "Dock Self-Cleaning Active", type: "boolean" },
		isWaterDraining: { name: "Water Draining Active", type: "boolean" },
		isPumpingWater: { name: "Water Pumping Active", type: "boolean" },
		// `wind` / `water` are the B01 aliases of fan_power / water_box_mode. B01 handlers build
		// their own localized states; these stay as the documented fallback. B01 hardware has no
		// vibrating mop module, so the standard wording is the right one here.
		wind: {
			type: "number",
			def: 102,
			states: { 101: "Quiet", 102: "Balanced", 103: "Turbo", 104: "Max", 105: "Gentle", 108: "Max+" },
		},
		water: {
			type: "number",
			def: 201,
			states: { ...WATER_BOX_MODE_LABELS_STANDARD, 204: LABEL_PER_ROOM },
		},
	},
	consumables: {
		// Raw keys from robot (converted to hours/cycles where applicable)
		main_brush_work_time: { type: "number", unit: "h" },
		side_brush_work_time: { type: "number", unit: "h" },
		filter_work_time: { type: "number", unit: "h" },
		filter_element_work_time: { type: "number", unit: "h" },
		sensor_dirty_time: { type: "number", unit: "h" },
		main_brush_life: { type: "number", unit: "%" },
		side_brush_life: { type: "number", unit: "%" },
		filter_life: { type: "number", unit: "%" },
		dust_collection_work_times: { type: "number", unit: "cycles" },
		strainer_work_times: { type: "number", unit: "cycles" },
		cleaning_brush_work_times: { type: "number", unit: "cycles" },
	} as const,
	consumableTranslationKeys: {
		main_brush: "localization_strings_Setting_Supplies_Common_4",
		side_brush: "localization_strings_Setting_Supplies_Common_2",
		filter: "localization_strings_Setting_Supplies_Common_0",
		filter_element: "supplies_waterbox_chip_name",
		sensor: "supplies_sensors_name",
		mop: "custom_mode_panel_mop_gear_title",
		strainer: "supplies_strainer_name",
		dust_collection: "dust_collection_life5",
		cleaning_brush: "home_page_supplies_cleaning_brush1"
	} as const,
	dockingStationTranslationKeys: {
		cleanFluidStatus: "dock_info_clean_fluid_title",
		waterBoxFilterStatus: "dock_info_water_box_filter_title",
		dustBagStatus: "dust_collection_life5",
		dirtyWaterBoxStatus: "dock_info_dirty_water_box_title",
		clearWaterBoxStatus: "dock_info_clear_water_box_title",
		isUpdownWaterReady: "inner_error_name_152"
	} as const,
	resetConsumables: new Set([
		"main_brush_work_time",
		"side_brush_work_time",
		"filter_work_time",
		"filter_element_work_time",
		"sensor_dirty_time",
		"dust_collection_work_times",
		"strainer_work_times",
		"cleaning_brush_work_times",
	]),
	cleaningRecords: {
		0: { type: "string" }, // begin
		1: { type: "string" }, // end
		2: { type: "number", unit: "min" }, // duration
		3: { type: "number", unit: "m²" }, // area
		4: { type: "number" }, // error
		5: { type: "number" }, // complete
		6: { type: "number" }, // start_type
		7: { type: "number" }, // clean_type
		8: { type: "number" }, // finish_reason
		9: { type: "number" }, // dust_collection_status

		// Mapped from name
		begin: { type: "string" },
		end: { type: "string" },
		duration: { type: "number", unit: "min" },
		area: { type: "number", unit: "m²" },
		error: { type: "number" },
		complete: { type: "number" },
		start_type: { type: "number" },
		clean_type: { type: "number" },
		finish_reason: { type: "number" },
		dust_collection_status: { type: "number" },

		cleaned_area: { type: "number", unit: "m²" },
		task_id: { type: "number" },
		clean_times: { type: "number" },
		dirty_replenish: { type: "number" },
		manual_replenish: { type: "number" },
		map_flag: { type: "number" },
		wash_count: { type: "number" },
		avoid_count: { type: "number" },
		sub_source: { type: "number" },
		extra_time: { type: "number" },
	},
	cleaningInfo: {
		0: { type: "number", unit: "h" },
		1: { type: "number", unit: "m²" },
		clean_time: { type: "number", unit: "h" },
		clean_area: { type: "number", unit: "m²" },
		clean_count: { type: "number" },
		dust_collection_count: { type: "number" },
	},
	firmwareFeatures: {
		41: "isHotWashTowelSupported",
		111: "isSupportFDSEndPoint",
		112: "isSupportAutoSplitSegments",
		114: "isSupportOrderSegmentClean",
		107: "isSoakAndWashSupported",
		109: "isBackWashNewSmartSupported",
		116: "isMapSegmentSupported",
		119: "isSupportLedStatusSwitch",
		120: "isMultiFloorSupported",
		122: "isSupportFetchTimerSummary",
		123: "isOrderCleanSupported",
		125: "isRemoteSupported",
	} as const,
};

export type FirmwareFeatures = typeof VACUUM_CONSTANTS.firmwareFeatures;
export type FirmwareFeatureId = keyof FirmwareFeatures;
