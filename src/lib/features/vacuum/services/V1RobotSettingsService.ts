import type { FeatureDependencies } from "../../baseDeviceFeatures";
import { DeviceStateWriter } from "../../deviceStateWriter";

/**
 * The persistent robot settings that are not a cleaning parameter: Do Not Disturb and the child lock.
 *
 * ## Where every value here comes from
 *
 * All line numbers refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js` (A65 below). The
 * wrappers do not spell their RPC names out as string literals - they go through the plugin's
 * `Methods` table (A65:238176-238179), which is why a plain text search for `get_dnd_timer` finds
 * only that table.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `getDndTimer` | `Methods.GetDndTimer` = `get_dnd_timer` | `new Array(0)`, i.e. `[]` | A65:228530-228545 |
 * | `setDndTimer(a0,a1,a2,a3)` | `Methods.SetDndTimer` = `set_dnd_timer` | `new Array(4)` = `[a0,a1,a2,a3]` | A65:230293-230316 |
 * | `closeDndTimer` | `Methods.CloseDndTimer` = `close_dnd_timer` | `[]` | A65:228033-228048 |
 * | `getChildLockStatus` | `'get_child_lock_status'` | `[]` | A65:228327-228340 |
 * | `setChildLockStatus(a0)` | `'set_child_lock_status'` | `{lock_status: a0}` | A65:230080-230091 |
 *
 * **The order of the four numbers is read, not guessed.** `saveDoNotDisturbData` (A65:849331-849341)
 * calls `setDndTimer(doNotDisturbBeginHour, doNotDisturbBeginMinute, doNotDisturbEndHour,
 * doNotDisturbEndMinute)`, and it refuses to send at all while any of the four is still `-1`
 * (A65:849318-849330). Swapping hours and minutes would produce a valid but wrong window, so this
 * is the one detail that had to come from the call site rather than from the wrapper.
 *
 * **There is no writable "enabled" flag.** `onDonotDisturbSwitchValueChanged(on)` (A65:851190-851262)
 * branches on the switch value: `on` runs `saveDoNotDisturbData()`, i.e. `set_dnd_timer` with the
 * four times, and `!on` runs `closeDndTimer()` with no arguments (A65:851259-851261 / :851194-851196).
 * Sending a window therefore *is* switching Do Not Disturb on, and that is why this service never
 * sends one on its own initiative.
 *
 * **`lock_status` is 1 for locked.** `_onSetChildLockValueChanged(on)` (A65:851706-851760) computes
 * `r2 = 0; if (on) r2 = 1;` and passes that to `setChildLockStatus` (A65:851729-851737); the reading
 * side does the mirror image, `childLockSwitch = (lock_status == 1)` (A65:851815-851822).
 *
 * ## Both settings can be read from the ordinary status
 *
 * `get_status` carries `dnd_enabled` and `lock_status`. That is not an assumption: the plugin's own
 * `getComputedState(status)` reads `status.lock_status` into `isLocked` right beside `status.state`
 * and `status.battery` (A65:222715-222725), the adapter has always declared both fields in
 * `VACUUM_CONSTANTS.deviceStates` (`vacuumConstants.ts:430`, `:435`), and the live capture of the
 * test device shows both in one status packet (`_appanalysis/local-mitschnitt.log:15`:
 * `"dnd_enabled":1 ... "lock_status":0`).
 *
 * So the on/off state of both settings arrives with every poll and needs no request of its own.
 * Only the **times** are missing from the status, and `get_dnd_timer` is asked for those.
 *
 * ## What this service deliberately leaves alone
 *
 * `set_dnd_timer_actions` (A65:230317-230326) is not implemented. Its wrapper passes its argument
 * straight through, the structure is never built in a place this analysis read, and the five
 * sub-switches it carries are only evaluated when `isSupportCustomDnd()` holds (A65:948705-948712) -
 * a predicate that was not checked for the test device either. A guessed payload here would set
 * real robot behaviour, so it stays out.
 */

/** RPC that reads the Do Not Disturb window. */
export const GET_DND_TIMER = "get_dnd_timer";

/** RPC that sets the window **and switches Do Not Disturb on**. */
export const SET_DND_TIMER = "set_dnd_timer";

/** RPC that switches Do Not Disturb off. */
export const CLOSE_DND_TIMER = "close_dnd_timer";

/** RPC that sets the child lock. */
export const SET_CHILD_LOCK_STATUS = "set_child_lock_status";

/** Status field carrying whether Do Not Disturb is on. */
export const DND_ENABLED_FIELD = "dnd_enabled";

/** Status field carrying whether the child lock is on. */
export const LOCK_STATUS_FIELD = "lock_status";

/** A Do Not Disturb window as the robot stores it. */
export interface DndWindow {
	startHour: number;
	startMinute: number;
	endHour: number;
	endMinute: number;
}

/**
 * Accepted spelling of a window in the writable state: `HH:MM-HH:MM`.
 *
 * Written out rather than parsed leniently on purpose. The four numbers reach the robot without
 * field names, so a value this module misreads becomes a valid window at the wrong time of day -
 * the robot then drives at night. Anything that does not match exactly is refused instead.
 */
const WINDOW_PATTERN = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/;

/** Formats one time of day as `HH:MM`. */
export function formatDndTime(hour: number, minute: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Formats a whole window as `HH:MM-HH:MM`. */
export function formatDndWindow(window: DndWindow): string {
	return `${formatDndTime(window.startHour, window.startMinute)}-${formatDndTime(window.endHour, window.endMinute)}`;
}

/** True for an hour of day. */
function isHour(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 23;
}

/** True for a minute of the hour. */
function isMinute(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 59;
}

/** Builds a window from four numbers, or null when any of them is out of range. */
export function windowFromNumbers(values: readonly unknown[]): DndWindow | null {
	if (values.length !== 4) return null;
	const numbers = values.map((value) => Number(value));
	if (!isHour(numbers[0]) || !isMinute(numbers[1]) || !isHour(numbers[2]) || !isMinute(numbers[3])) return null;
	return { startHour: numbers[0], startMinute: numbers[1], endHour: numbers[2], endMinute: numbers[3] };
}

/**
 * Reads a window out of whatever was written into the command state.
 *
 * Two spellings are accepted, and both are exact: the human one, `22:00-07:00`, and the wire one,
 * `[22, 0, 7, 0]`. The second exists because it is what really goes to the robot, so a script that
 * already thinks in those four numbers does not have to format a string for this adapter to parse
 * it back.
 *
 * @param value Raw state value.
 * @returns The window, or null when the value is not a window.
 */
export function parseDndWindow(value: unknown): DndWindow | null {
	if (Array.isArray(value)) return windowFromNumbers(value);

	if (typeof value !== "string") return null;
	const match = WINDOW_PATTERN.exec(value);
	if (!match) return null;
	return windowFromNumbers([Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]);
}

/** The four numbers `set_dnd_timer` expects, in the order the app sends them. */
export function dndTimerParams(window: DndWindow): number[] {
	return [window.startHour, window.startMinute, window.endHour, window.endMinute];
}

/**
 * Reads the answer of `get_dnd_timer`.
 *
 * The app takes `result[0]` and reads `start_hour`, `start_minute`, `end_hour`, `end_minute` and
 * `enabled` off it, with `isDoNotDisturbSwitchOn = (enabled == 1)` (A65:948702-948745). The
 * `actions` block beside them is only touched when `isSupportCustomDnd()` holds and is ignored here.
 *
 * The unwrapping is deliberately tolerant of one wrapping level: the same robot answers
 * `get_child_lock_status` with a bare object (A65:851815, `r1.result.lock_status`) and this one with
 * a single-element array, so neither shape may be assumed.
 *
 * @param response Raw robot answer.
 * @returns The window and whether it is active, or null when the answer carries neither.
 */
export function parseDndTimerResponse(response: unknown): { window: DndWindow | null; enabled: boolean | null } | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

	const source = payload as Record<string, unknown>;
	const window = windowFromNumbers([source.start_hour, source.start_minute, source.end_hour, source.end_minute]);
	const enabled = source.enabled === undefined ? null : Number(source.enabled) === 1;
	if (window === null && enabled === null) return null;
	return { window, enabled };
}

/** Reads the answer of `get_child_lock_status`; `lock_status == 1` means locked (A65:851815-851822). */
export function parseChildLockResponse(response: unknown): boolean | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

	const raw = (payload as Record<string, unknown>).lock_status;
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value === 1 : null;
}

/**
 * Publishes and drives the two settings.
 *
 * The service owns the state names and the payloads; the feature class only routes to it. Nothing
 * here holds a timer or a subscription, so there is nothing for `onUnload` to clean up.
 */
export class V1RobotSettingsService {
	private readonly stateWriter: DeviceStateWriter;

	/**
	 * Methods this service registered itself, and therefore the only ones it builds parameters for.
	 *
	 * The distinction matters because `A179Features` extends the V1 class, brings its own
	 * `set_child_lock_status` and its own parameter building, and calls `super.getCommandParams`
	 * **first** (`a179_features.ts:1304`). If this service answered for that command as well, the
	 * subclass would receive an already-built `{method, params}` object where it expects the raw
	 * value and would rebuild the payload out of it. So the feature class does not register what a
	 * model class already declared, and what was never registered is never claimed.
	 */
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

	/**
	 * Registers the two Do Not Disturb objects.
	 *
	 * They are two and not one because the protocol has two: there is no field that switches the
	 * mode, only "here is a window" and "stop". Modelling it as a single writable flag would mean
	 * inventing a window whenever somebody switches it on, and this module has no business choosing
	 * when the robot should be quiet.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerDoNotDisturbCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const title = this.text("localization_strings_Setting_DoNotDisturbPage_12", "Do Not Disturb Mode");

		addCommand(SET_DND_TIMER, {
			type: "string",
			role: "text",
			name: title,
			// The format belongs in the description, not in the name: the name is what the admin
			// tab puts next to the control, and a control does not need to explain the wire format
			// it is not showing.
			desc: "Window as HH:MM-HH:MM, e.g. 22:00-07:00. Writing it also switches Do Not Disturb on.",
			def: "",
			write: true
		}, "settings");

		addCommand(CLOSE_DND_TIMER, {
			type: "boolean",
			role: "button",
			name: `${title} off`,
			desc: "Switches Do Not Disturb off; the robot keeps the window it had.",
			def: false
		}, "settings");

		addCommand(GET_DND_TIMER, {
			type: "boolean",
			role: "button",
			name: "Read Do Not Disturb window",
			def: false
		}, "queries");

		this.claimed.add(SET_DND_TIMER).add(CLOSE_DND_TIMER).add(GET_DND_TIMER);
	}

	/**
	 * Registers the child lock switch.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerChildLockCommand(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		addCommand(SET_CHILD_LOCK_STATUS, {
			type: "boolean",
			role: "switch.enable",
			name: this.text("child_lock_title", "Child Lock"),
			def: false
		}, "settings");

		this.claimed.add(SET_CHILD_LOCK_STATUS);
	}

	/** Creates the two read-only states the window is published in. */
	public async ensureDndStates(): Promise<void> {
		await this.stateWriter.ensureFolder("deviceStatus");
		await this.stateWriter.ensureState("deviceStatus.dnd_start", {
			name: this.text("localization_strings_Setting_DoNotDisturbPage_0", "Start"),
			type: "string",
			role: "text",
			read: true,
			write: false
		});
		await this.stateWriter.ensureState("deviceStatus.dnd_end", {
			name: this.text("localization_strings_Setting_DoNotDisturbPage_1", "End"),
			type: "string",
			role: "text",
			read: true,
			write: false
		});
	}

	/**
	 * Builds the parameters of one of the four methods.
	 *
	 * Throws rather than sending something else when the window cannot be read. The alternative
	 * would be a request built from a misread value, and these four numbers travel without field
	 * names - a wrong one is a quiet, working, wrong night-time window.
	 *
	 * @param method Method as registered in the settings or queries folder.
	 * @param value  Raw value written into the state.
	 * @returns The method and parameters to send.
	 */
	public buildCommandParams(method: string, value: unknown): { method: string; params: unknown } {
		if (method === SET_DND_TIMER) {
			const window = parseDndWindow(value);
			if (!window) {
				throw new Error(
					`${SET_DND_TIMER} needs a window like "22:00-07:00" (or the four numbers [22,0,7,0]); received ${JSON.stringify(value)}`
				);
			}
			return { method: SET_DND_TIMER, params: dndTimerParams(window) };
		}

		if (method === CLOSE_DND_TIMER) return { method: CLOSE_DND_TIMER, params: [] };
		if (method === GET_DND_TIMER) return { method: GET_DND_TIMER, params: [] };

		if (method === SET_CHILD_LOCK_STATUS) {
			return { method: SET_CHILD_LOCK_STATUS, params: { lock_status: this.toBinary(value) } };
		}

		return { method, params: value };
	}

	/** True for every spelling of "on" a state value can arrive in. */
	private toBinary(value: unknown): number {
		if (value === true || value === 1 || value === "1" || value === "true") return 1;
		return 0;
	}

	/** Methods this service registered and is therefore responsible for; see {@link claimed}. */
	public handles(method: string): boolean {
		return this.claimed.has(method);
	}

	/**
	 * Publishes the window an answer of `get_dnd_timer` carried.
	 * @param response Raw robot answer.
	 * @returns `true` when a window was published.
	 */
	public async applyDndTimerResponse(response: unknown): Promise<boolean> {
		const parsed = parseDndTimerResponse(response);
		if (!parsed) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_DND_TIMER} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.ensureDndStates();

		if (parsed.window) {
			await this.stateWriter.setState("deviceStatus.dnd_start", formatDndTime(parsed.window.startHour, parsed.window.startMinute));
			await this.stateWriter.setState("deviceStatus.dnd_end", formatDndTime(parsed.window.endHour, parsed.window.endMinute));
			// The writable state shows the window that is really set, so a user who only wants to
			// shift the end by an hour does not have to retype the start.
			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${SET_DND_TIMER}`, {
				val: formatDndWindow(parsed.window),
				ack: true
			});
		}

		return parsed.window !== null;
	}

	/**
	 * Mirrors the on/off state the status carries into the writable switch.
	 *
	 * Only called for the two fields named at the top of this file, and only once the matching
	 * feature was applied - a device that never reports the field never gets the object either.
	 * @param field Status field name.
	 * @param value Reported value.
	 */
	public async mirrorStatusField(field: string, value: unknown): Promise<void> {
		if (field === LOCK_STATUS_FIELD) {
			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${SET_CHILD_LOCK_STATUS}`, {
				val: Number(value) === 1,
				ack: true
			});
		}
	}
}
