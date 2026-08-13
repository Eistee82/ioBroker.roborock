/**
 * The robot state table: one row per value the adapter can publish in
 * `Devices.<duid>.deviceStatus.state` (V1) or `Devices.<duid>.deviceStatus.status` (B01/Q10).
 *
 * Both objects use the same numeric codes. The V1 list is `VACUUM_CONSTANTS.stateCodes` in
 * `src/lib/features/vacuum/vacuumConstants.ts`, the B01/Q10 list is the `status`/`state`
 * branch of `B01BaseVacuumFeatures.getAttributeDefinition()` - a subset of the same codes
 * with a slightly different capitalisation, which is why keying by the number is safe.
 *
 * Every row carries two things the tab needs and cannot derive from the object alone:
 *
 *  - `key`: the adapter writes those `common.states` in English, so the strip would say
 *    "Charging" in a German admin. The key resolves the code through `admin/i18n/<lang>.json`
 *    instead, with the object's own English wording as the fallback.
 *  - `phase`: what the robot is actually doing, condensed to the six situations the controls
 *    have to tell apart. Showing both Start and Stop at all times means one of them is
 *    always meaningless.
 */

import type { DockActivity, RobotPhase } from "./types";

/** One row of the state table. */
export interface RobotStateInfo {
	/** Translation key in `admin/i18n/<lang>.json`. */
	key: string;
	/** English wording of the adapter object, kept here as the last-resort fallback. */
	en: string;
	/** Situation the controls derive from this state. */
	phase: RobotPhase;
}

/**
 * Code -> state. Codes the table does not list are not an error: a firmware may report
 * anything, and both consumers fall back rather than hide something.
 */
export const ROBOT_STATES: Readonly<Record<number, RobotStateInfo>> = {
	0: { key: "ui_state_unknown", en: "Unknown", phase: "unknown" },
	1: { key: "ui_state_initiating", en: "Initiating", phase: "idle" },
	2: { key: "ui_state_sleeping", en: "Sleeping", phase: "idle" },
	3: { key: "ui_state_idle", en: "Idle", phase: "idle" },
	4: { key: "ui_state_remote_control", en: "Remote Control", phase: "idle" },
	5: { key: "ui_state_cleaning", en: "Cleaning", phase: "cleaning" },
	6: { key: "ui_state_returning_dock", en: "Returning Dock", phase: "returning" },
	7: { key: "ui_state_manual_mode", en: "Manual Mode", phase: "idle" },
	8: { key: "ui_state_charging", en: "Charging", phase: "docked" },
	9: { key: "ui_state_charging_error", en: "Charging Error", phase: "docked" },
	10: { key: "ui_state_paused", en: "Paused", phase: "paused" },
	11: { key: "ui_state_spot_cleaning", en: "Spot Cleaning", phase: "cleaning" },
	12: { key: "ui_state_in_error", en: "In Error", phase: "idle" },
	13: { key: "ui_state_shutting_down", en: "Shutting Down", phase: "idle" },
	14: { key: "ui_state_updating", en: "Updating", phase: "idle" },
	15: { key: "ui_state_docking", en: "Docking", phase: "returning" },
	16: { key: "ui_state_go_to", en: "Go To", phase: "cleaning" },
	17: { key: "ui_state_zone_clean", en: "Zone Clean", phase: "cleaning" },
	18: { key: "ui_state_room_clean", en: "Room Clean", phase: "cleaning" },
	22: { key: "ui_state_emptying_dust", en: "Emptying dust container", phase: "docked" },
	23: { key: "ui_state_washing_mop", en: "Washing the mop", phase: "docked" },
	25: { key: "ui_state_washing_duster", en: "Washing duster", phase: "docked" },
	26: { key: "ui_state_going_to_wash_mop", en: "Going to wash the mop", phase: "returning" },
	28: { key: "ui_state_in_call", en: "In call", phase: "idle" },
	29: { key: "ui_state_mapping", en: "Mapping", phase: "cleaning" },
	30: { key: "ui_state_egg_attack", en: "Egg attack", phase: "cleaning" },
	32: { key: "ui_state_patrol", en: "Patrol", phase: "cleaning" },
	33: { key: "ui_state_mop_attaching", en: "Setting up the mop", phase: "docked" },
	34: { key: "ui_state_mop_removing", en: "Removing the mop", phase: "docked" },
	36: { key: "ui_state_exhibition", en: "Exhibition mode", phase: "idle" },
	37: { key: "ui_state_dance", en: "Dance", phase: "idle" },
	38: { key: "ui_state_tidy_up", en: "Tidy-up housework", phase: "cleaning" },
	39: { key: "ui_state_remote_pickup", en: "Remote pick-up", phase: "cleaning" },
	40: { key: "ui_state_emergency_stop", en: "Emergency stop", phase: "idle" },
	41: { key: "ui_state_arm_resetting", en: "Arm resetting", phase: "docked" },
	42: { key: "ui_state_program_mode", en: "Program mode", phase: "idle" },
	100: { key: "ui_state_fully_charged", en: "Fully Charged", phase: "docked" },
	101: { key: "ui_state_offline", en: "Offline", phase: "unknown" },
	102: { key: "ui_state_unknown", en: "Unknown", phase: "unknown" },
};

/**
 * Situation the reported code belongs to.
 *
 * A code nobody anticipated - and a device that has not reported anything yet - counts as
 * `unknown`, never as "nothing to do here": the controls answer an unknown phase with the
 * Start button, because an empty control bar is worse than one button too many.
 *
 * @param stateCode Value of `deviceStatus.state` / `deviceStatus.status`, or null while none arrived.
 */
export function robotPhase(stateCode: number | null): RobotPhase {
	if (stateCode === null) return "unknown";
	return ROBOT_STATES[stateCode]?.phase ?? "unknown";
}

/**
 * Which station job the robot reports right now.
 *
 * The dock has no separate "is washing" flag we could rely on across models, but the robot
 * state says it plainly: while the station washes the mop or empties the dust container, the
 * robot reports that instead of plain charging. That is enough to offer Stop instead of Start
 * for the job that is actually running, rather than both next to each other.
 *
 * `25 Washing duster` counts as washing as well - it is the same wash cycle on the models that
 * carry a duster, and `app_stop_wash` is what ends it.
 *
 * Anything else yields `null`, which the panel reads as "nothing running" and answers with the
 * Start buttons. An unlisted code must never hide a control.
 *
 * @param stateCode Value of `deviceStatus.state` / `deviceStatus.status`, or null while none arrived.
 */
export function dockActivity(stateCode: number | null): DockActivity {
	switch (stateCode) {
		case 23:
		case 25:
			return "washing";
		case 22:
			return "emptying";
		default:
			return null;
	}
}

/**
 * Station commands that come in a Start/Stop pair, keyed by the job they belong to.
 *
 * The adapter publishes them as four independent buttons; only their names tie them together.
 * Listing the pairs here keeps that knowledge in one place instead of spreading string tests
 * through the panel.
 */
export const DOCK_COMMAND_PAIRS: Readonly<Record<string, { start: string; stop: string }>> = {
	washing: { start: "app_start_wash", stop: "app_stop_wash" },
	emptying: { start: "app_start_collect_dust", stop: "app_stop_collect_dust" },
};
