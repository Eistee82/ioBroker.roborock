import type { FeatureDependencies } from "../baseDeviceFeatures";
import { DeviceStateWriter } from "../deviceStateWriter";
import { formatDndTime, formatDndWindow, parseDndWindow } from "./services/V1RobotSettingsService";
import type { DndWindow } from "./services/V1RobotSettingsService";

/**
 * Off-peak charging: the window in which the robot is allowed to fill its battery.
 *
 * ## What it actually does
 *
 * Not a guess, and not derived from the name. Roborock states it on the very switch this
 * implements (`robot_status_wait_charge1` / `…2`, read at A65:852386-852392):
 *
 * > **Off-Peak Charging** — The robot will only fully charge during off-peak hours. Minimum power
 * > will be maintained during other hours.
 *
 * With two exceptions the app spells out as well (`valley_charge_tip_4` / `…_5`): the robot still
 * charges outside the window when a clean is unfinished, and it always tops up to a minimum charge.
 * So this delays a full charge; it does not stop charging.
 *
 * ## Where every value here comes from
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `getValleyElectricityTimer` | `get_valley_electricity_timer` | `new Array(0)`, i.e. `[]` | A65:229209-229217 |
 * | `setValleyElectricityTimer(a0,a1,a2,a3)` | `set_valley_electricity_timer` | `new Array(4)` = `[a0,a1,a2,a3]` | A65:230931-230947 |
 * | `closeValleyElectricityTimer` | `close_valley_electricity_timer` | `[]` | A65:228049-228058 |
 *
 * **The order of the four numbers is read, not inferred.** The field names of the *answer*
 * (`start_hour`, `start_minute`, `end_hour`, `end_minute`) match `get_dnd_timer` exactly, which
 * makes the analogy to `set_dnd_timer` very strong - and an analogy is what put four numbers in
 * the wrong order into somebody's night once. `saveValleyElectricityData()` settles it
 * (A65:847576-847594):
 *
 * ```js
 * setValleyElectricityTimer(
 *   this.valleyElectricityBeginHour,    // a0
 *   this.valleyElectricityBeginMinute,  // a1
 *   this.valleyElectricityEndHour,      // a2
 *   this.valleyElectricityEndMinute     // a3
 * )
 * ```
 *
 * So `[startHour, startMinute, endHour, endMinute]` - the same order as Do Not Disturb, now proven
 * for this call too. The window helpers are imported from `V1RobotSettingsService` rather than
 * copied: two parsers for one wire format is how the two drift apart.
 *
 * ## There is no writable `enabled`, exactly as with Do Not Disturb
 *
 * Checked rather than assumed. `onValleyElectricitySwitchValueChanged(on)` (A65:847285-847360):
 *
 * - **off** sends `close_valley_electricity_timer` and resets its four local values to `-1`;
 * - **on** sends nothing at all unless all four are set - it shows
 *   `valley_electricity_not_set_hint` instead - and otherwise calls `saveValleyElectricityData()`.
 *
 * Sending a window *is* switching on. The `enabled` in the answer is therefore read-only here, and
 * the pair of commands mirrors `set_dnd_timer` / `close_dnd_timer`.
 *
 * ## The window has to be at least six hours long
 *
 * `handleTimeDifference()` runs before every save (A65:847664-847754). It computes the length in
 * fractional hours - `end > begin ? end - begin : 24 - (begin - end)`, so a window across midnight
 * counts correctly - and when the result is **under 6** it shows `robot_status_wait_charge6`
 * ("* Defined charging period must be longer than 6-hours.") and **moves one end** so the window
 * becomes six hours.
 *
 * **This module refuses such a window instead of stretching it.** The app can stretch because it
 * knows which field the user just touched (`isBeginTime` decides which end moves); a state write
 * carries no such context, so the adapter would have to pick an end at random and silently move a
 * time the user set. A refusal is visible, uses Roborock's own sentence, and leaves the decision
 * where it belongs. Whether the **robot** enforces the six hours is not established - this is the
 * app's rule, and it is applied here because sending what the app would never send is how unproven
 * territory gets entered by accident.
 */

/** RPC that reads the window; also the capability probe for the two below. */
export const GET_VALLEY_TIMER = "get_valley_electricity_timer";

/** RPC that sets the window. Writing one also switches off-peak charging on. */
export const SET_VALLEY_TIMER = "set_valley_electricity_timer";

/** RPC that switches off-peak charging off; the robot keeps the window it had. */
export const CLOSE_VALLEY_TIMER = "close_valley_electricity_timer";

/** Shortest window the app will send, in hours (A65:847716, `robot_status_wait_charge6`). */
export const MIN_WINDOW_HOURS = 6;

/** Value the app uses for "no time set" in all four fields (A65:847311-847316). */
export const UNSET = -1;

/**
 * Length of a window in hours, counting across midnight.
 *
 * The app's own arithmetic (A65:847668-847758): both ends as fractional hours, and the wrap
 * handled by subtracting from 24 rather than by a special case.
 *
 * @param window The window.
 * @returns Its length in hours; 0 when both ends are the same time.
 */
export function windowLengthHours(window: DndWindow): number {
	const begin = window.startHour + window.startMinute / 60;
	const end = window.endHour + window.endMinute / 60;
	if (end === begin) return 0;
	return end > begin ? end - begin : 24 - (begin - end);
}

/** True for a window the app would be willing to send. */
export function isSendableWindow(window: DndWindow): boolean {
	return windowLengthHours(window) >= MIN_WINDOW_HOURS;
}

/** What `get_valley_electricity_timer` says. */
export interface OffPeakSetting {
	/** The window, or null while the robot reports none of the four values. */
	window: DndWindow | null;
	/** Whether off-peak charging is on, or null when the answer carries no flag. */
	enabled: boolean | null;
}

/** Reads a finite number out of a value the robot may have sent as a string. */
function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the answer of `get_valley_electricity_timer`.
 *
 * The answer arrives as `[{start_hour, start_minute, end_hour, end_minute, enabled}]`. A robot that
 * has no window set reports **zeros**, not `-1` - measured on the test device, which answers
 * `{start_hour:0, start_minute:0, end_hour:0, end_minute:0, enabled:0}`. That is a real time of
 * day, so it cannot be told from a window somebody deliberately set to midnight-to-midnight by its
 * values alone; `enabled` is what separates the two, and it is published beside the window rather
 * than folded into it.
 *
 * @param response Raw robot answer.
 * @returns The setting, or null when the answer carries neither a window nor a flag.
 */
export function parseOffPeakResponse(response: unknown): OffPeakSetting | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];

	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const source = payload as Record<string, unknown>;

	const startHour = finiteNumber(source.start_hour);
	const startMinute = finiteNumber(source.start_minute);
	const endHour = finiteNumber(source.end_hour);
	const endMinute = finiteNumber(source.end_minute);
	const rawEnabled = source.enabled;

	const hasWindow = startHour !== null && startMinute !== null && endHour !== null && endMinute !== null
		&& [startHour, startMinute, endHour, endMinute].every((value) => value !== UNSET);

	const enabled = rawEnabled === undefined ? null : Boolean(finiteNumber(rawEnabled));
	if (!hasWindow && enabled === null) return null;

	return {
		window: hasWindow ? { startHour, startMinute, endHour, endMinute } : null,
		enabled
	};
}

/** The four numbers `set_valley_electricity_timer` expects, in the order the app sends them. */
export function valleyTimerParams(window: DndWindow): number[] {
	return [window.startHour, window.startMinute, window.endHour, window.endMinute];
}

/**
 * Publishes off-peak charging and drives it.
 *
 * Owns its state names and its payloads; the feature class only routes to it. Holds no timer and no
 * subscription, so there is nothing for `onUnload` to clean up.
 */
export class V1OffPeakChargingService {
	private readonly stateWriter: DeviceStateWriter;

	/** Methods this service registered itself. */
	private readonly claimed = new Set<string>();

	constructor(
		private readonly deps: FeatureDependencies,
		private readonly duid: string
	) {
		this.stateWriter = new DeviceStateWriter(deps, duid);
	}

	/** Shorthand for a Roborock wording with an English fallback. */
	private text(key: string, fallback: string): string {
		return this.deps.adapter.translationManager.get(key, fallback);
	}

	/** Methods this service registered and is therefore responsible for. */
	public handles(method: string): boolean {
		return this.claimed.has(method);
	}

	/**
	 * Registers the window, its off button and its read button.
	 *
	 * Two commands and not one switch, for the reason the Do Not Disturb pair states: the protocol
	 * has no field that switches the mode, only "here is a window" and "stop".
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const title = this.text("robot_status_wait_charge1", "Off-Peak Charging");

		addCommand(SET_VALLEY_TIMER, {
			type: "string",
			role: "text",
			name: title,
			desc: `Window as HH:MM-HH:MM, e.g. 22:00-06:00. Writing it also switches off-peak charging on. The window has to span at least ${MIN_WINDOW_HOURS} hours.`,
			def: "",
			write: true
		}, "settings");

		addCommand(CLOSE_VALLEY_TIMER, {
			type: "boolean",
			role: "button",
			name: `${title} off`,
			desc: "Switches off-peak charging off; the robot keeps the window it had.",
			def: false
		}, "settings");

		addCommand(GET_VALLEY_TIMER, {
			type: "boolean",
			role: "button",
			name: `Read ${title}`,
			def: false
		}, "queries");

		this.claimed.add(SET_VALLEY_TIMER).add(CLOSE_VALLEY_TIMER).add(GET_VALLEY_TIMER);
	}

	/** Creates the read-only states the window is published in. */
	public async ensureStates(): Promise<void> {
		await this.stateWriter.ensureFolder("deviceStatus");
		await this.stateWriter.ensureState("deviceStatus.valley_electricity_start", {
			name: this.text("localization_strings_Setting_DoNotDisturbPage_0", "Start"),
			type: "string",
			role: "text",
			read: true,
			write: false
		});
		await this.stateWriter.ensureState("deviceStatus.valley_electricity_end", {
			name: this.text("localization_strings_Setting_DoNotDisturbPage_1", "End"),
			type: "string",
			role: "text",
			read: true,
			write: false
		});
		await this.stateWriter.ensureState("deviceStatus.valley_electricity_enabled", {
			name: this.text("robot_status_wait_charge1", "Off-Peak Charging"),
			type: "boolean",
			role: "indicator",
			read: true,
			write: false
		});
	}

	/**
	 * Builds the parameters of one of the three methods.
	 *
	 * @param method Method as registered.
	 * @param value Raw value written into the state; only read for the window.
	 * @returns The method and parameters to send.
	 * @throws When the value is not a window, or is one the app would refuse.
	 */
	public buildCommandParams(method: string, value: unknown): { method: string; params: unknown } {
		if (method === GET_VALLEY_TIMER || method === CLOSE_VALLEY_TIMER) return { method, params: [] };

		const window = parseDndWindow(value);
		if (!window) {
			throw new Error(
				`${SET_VALLEY_TIMER} needs a window like "22:00-06:00" (or the four numbers [22,0,6,0]); received ${JSON.stringify(value)}`
			);
		}

		if (!isSendableWindow(window)) {
			// Roborock's own sentence, so the refusal reads the way the app words the same rule.
			const hint = this.text("robot_status_wait_charge6", `* Defined charging period must be longer than ${MIN_WINDOW_HOURS}-hours.`);
			throw new Error(
				`${SET_VALLEY_TIMER} refused ${formatDndWindow(window)}: it spans ${windowLengthHours(window).toFixed(1)} h. ${hint}`
			);
		}

		return { method: SET_VALLEY_TIMER, params: valleyTimerParams(window) };
	}

	/**
	 * Publishes the window and the flag the robot reports.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether anything was published.
	 */
	public async applyResponse(response: unknown): Promise<boolean> {
		const setting = parseOffPeakResponse(response);
		if (!setting) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_VALLEY_TIMER} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.ensureStates();
		await this.stateWriter.setState("deviceStatus.valley_electricity_start",
			setting.window ? formatDndTime(setting.window.startHour, setting.window.startMinute) : "");
		await this.stateWriter.setState("deviceStatus.valley_electricity_end",
			setting.window ? formatDndTime(setting.window.endHour, setting.window.endMinute) : "");
		await this.stateWriter.setState("deviceStatus.valley_electricity_enabled", setting.enabled);

		// The writable state mirrors the window the robot holds, so the tab shows what is set rather
		// than what was last typed. Empty while the robot reports none.
		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${SET_VALLEY_TIMER}`, {
			val: setting.window ? formatDndWindow(setting.window) : "",
			ack: true
		});
		return true;
	}
}
