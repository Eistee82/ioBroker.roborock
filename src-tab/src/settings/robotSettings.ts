/**
 * The robot settings the tab can operate, built out of the objects the adapter published.
 *
 * ## Why this is a table and not a screen full of special cases
 *
 * This is the first of a series: the analysis lists the LED, the mop wash parameters, the drying,
 * the carpet behaviour and the door sills as the same kind of thing - a persistent robot setting
 * with an on/off or a small value. So an entry here says **which objects a setting is made of** and
 * **how it is operated**, and the panel renders whatever the table produced. Adding the next
 * setting is one entry, not another branch in a component.
 *
 * ## Why the labels are not in this file
 *
 * Every label comes from `common.name` of the object the adapter created, and the adapter has
 * already resolved it against the Roborock wordings in all eleven languages. A label table here
 * would be a second source that can disagree with the object tree - the same rule the mode
 * selectors and the dock panel follow.
 *
 * ## What is deliberately absent
 *
 * A "Do Not Disturb enabled" object. The protocol has none: `set_dnd_timer` carries the window and
 * switching it on is the same act, and `close_dnd_timer` switches it off. That is not this module's
 * reading of it, it is what the Roborock app's own switch handler does - see
 * `src/lib/features/vacuum/services/V1RobotSettingsService.ts` for the line numbers. The tab
 * therefore composes a switch out of the two commands rather than pretending there is a flag.
 */

/** The folder writable settings live in. */
export const SETTINGS_FOLDER = "settings";

/** The folder the robot's own reported values live in. */
export const STATUS_FOLDER = "deviceStatus";

/** How a setting is operated. */
export type SettingKind = "switch" | "timeWindow" | "choice" | "number";

interface SettingEntryBase {
	/** State name, which is also the command name the adapter registered. */
	command: string;
	/** Folder the writable state sits in. */
	folder: string;
	/** Resolved `common.name` of that object. */
	label: string;
	/** Resolved `common.desc`, or the empty string. */
	description: string;
	kind: SettingKind;
}

/** A setting with two positions. */
export interface SwitchSetting extends SettingEntryBase {
	kind: "switch";
	/** Reported position, or null while the robot has not said. */
	value: boolean | null;
}

/** A setting that is a window of the day plus an on/off. */
export interface TimeWindowSetting extends SettingEntryBase {
	kind: "timeWindow";
	/** Whether the window is currently active, or null while unknown. */
	enabled: boolean | null;
	/** Start as `HH:MM`, or null while the robot has not been asked. */
	start: string | null;
	/** End as `HH:MM`, or null while the robot has not been asked. */
	end: string | null;
	/** Command that switches the window off; writing {@link command} switches it on. */
	offCommand: string;
}

/** One position of a {@link ChoiceSetting}. */
export interface ChoiceOption {
	/** The number that is written to the robot. */
	value: number;
	/** Its label, as the adapter resolved it. */
	label: string;
}

/**
 * A setting with a small, fixed set of positions.
 *
 * The options are **not** listed in this file. They come from `common.states` of the object the
 * adapter published, for the same reason the labels do: the adapter is the side that proved which
 * values the robot accepts, and a second list here could disagree with it. A robot whose object
 * carries no usable `states` gets no control, because a picker without positions is a dead control.
 */
export interface ChoiceSetting extends SettingEntryBase {
	kind: "choice";
	/** Reported position, or null while the robot has not said. */
	value: number | null;
	options: ChoiceOption[];
}

/**
 * A setting that is a number over a continuous range, shown as a slider.
 *
 * The bounds are **not** listed in this file, for the same reason a choice's positions are not:
 * they come from `common.min`/`common.max` of the object the adapter published, and the adapter is
 * the side that proved which range the robot accepts. An object without both bounds gets no
 * control, because a slider with no ends is a control that can send anything.
 */
export interface NumberSetting extends SettingEntryBase {
	kind: "number";
	/** Reported value, or null while the robot has not said. */
	value: number | null;
	min: number;
	max: number;
	/** Unit to show beside the value, or the empty string. */
	unit: string;
}

export type SettingEntry = SwitchSetting | TimeWindowSetting | ChoiceSetting | NumberSetting;

/** Everything the settings panel shows for one robot. */
export interface RobotSettingsModel {
	entries: SettingEntry[];
}

/** The slice of an ioBroker state value this branch reads. */
export interface SettingStateValue {
	val: unknown;
}

/** The slice of an ioBroker state object this branch reads. */
export interface SettingStateDefinition {
	id: string;
	common?: {
		name?: unknown;
		desc?: unknown;
		type?: unknown;
		states?: unknown;
		min?: unknown;
		max?: unknown;
		unit?: unknown;
	};
}

/**
 * The settings this build knows how to operate.
 *
 * Order is the order they appear in. A setting whose writable object the device did not publish is
 * skipped entirely - the adapter only creates it for a robot that reports the matching status
 * field, so an absent object means "this robot does not have it", never "not loaded yet".
 */
const KNOWN_SETTINGS: ReadonlyArray<
	| { kind: "switch"; command: string }
	| { kind: "choice"; command: string }
	| { kind: "number"; command: string }
	| { kind: "timeWindow"; command: string; offCommand: string; enabledStatus: string; startStatus: string; endStatus: string }
> = [
	{
		kind: "timeWindow",
		command: "set_dnd_timer",
		offCommand: "close_dnd_timer",
		enabledStatus: "dnd_enabled",
		startStatus: "dnd_start",
		endStatus: "dnd_end",
	},
	{ kind: "switch", command: "set_child_lock_status" },
	// Only exists for a robot that answered `get_collision_avoid_status` when the adapter asked
	// it at start-up - see `src/lib/features/capabilityProbe.ts`. Nothing has to be done about
	// that here: an absent object means no entry, which is the same rule every setting follows.
	{ kind: "switch", command: "set_collision_avoid_status" },
	// The two dock settings, each unlocked by its own getter rather than by a model class - see
	// `src/lib/features/vacuum/v1ProbedCapabilities.ts` for the proof of their payloads. Their
	// positions travel in `common.states`, so nothing about them is decided here.
	{ kind: "choice", command: "set_dust_collection_mode" },
	{ kind: "choice", command: "app_set_dryer_setting" },
	// Five on/off settings that share one shape on the wire - a `get_*`/`set_*` pair around a
	// `status` field - and are each unlocked by their own getter, like the two above. Their labels
	// and explanations travel on the object in Roborock's own wording, so nothing about them is
	// decided here either; the entry is only which command to look for.
	//
	// Measured on the test device, four of the five are answered with `unknown_method` and never get
	// an object (`_appanalysis/geraetefaehigkeiten-1786790619395.json`). That is the intended
	// outcome, not a gap: a robot that cannot do something shows nothing rather than a dead switch.
	{ kind: "switch", command: "set_dust_collection_switch_status" },
	{ kind: "switch", command: "set_clean_follow_ground_material_status" },
	{ kind: "switch", command: "set_optimize_battery_status" },
	{ kind: "switch", command: "set_right_brush_stretch_status" },
	{ kind: "switch", command: "set_stretch_tag_status" },
	{ kind: "switch", command: "set_gap_deep_clean_status" },
	// The robot's speaking volume. Its bounds travel on the object like everything else here; the
	// adapter offers the range the app validates before sending, which is wider than the app's own
	// slider - see `src/lib/features/vacuum/v1SoundVolume.ts`.
	{ kind: "number", command: "change_sound_volume" },
];

/** Builds the object id of the settings folder of one device. */
export function settingsRoot(instanceId: string, duid: string): string {
	return `${instanceId}.Devices.${duid}`;
}

/** Resolves `common.name`, which ioBroker allows to be a plain string or a per-language map. */
export function settingLabel(name: unknown, language: string, fallback: string): string {
	if (typeof name === "string" && name.trim()) return name;
	if (name && typeof name === "object") {
		const translated = name as Record<string, unknown>;
		const candidate = translated[language] ?? translated.en;
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return fallback;
}

/** Reads a state value as a boolean; `1`/`0` count, because the status reports numbers. */
function booleanValue(state: SettingStateValue | null | undefined): boolean | null {
	if (!state || state.val === null || state.val === undefined) return null;
	if (typeof state.val === "boolean") return state.val;
	if (typeof state.val === "number") return state.val === 1;
	if (state.val === "true" || state.val === "1") return true;
	if (state.val === "false" || state.val === "0") return false;
	return null;
}

/** Reads a state value as a number; the robot reports these as numbers, scripts may write strings. */
function numberValue(state: SettingStateValue | null | undefined): number | null {
	if (!state || state.val === null || state.val === undefined || state.val === "") return null;
	const parsed = Number(state.val);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the positions out of `common.states`.
 *
 * ioBroker allows three spellings and the adapter uses the first, but a state object can be edited
 * by hand in the admin, so all three are read. Anything whose key is not a number is dropped: this
 * picker writes the key, and a key that is not a number cannot be what the robot expects.
 *
 * @param states Raw `common.states`.
 */
export function parseChoiceOptions(states: unknown): ChoiceOption[] {
	const collected: ChoiceOption[] = [];

	const add = (rawValue: unknown, rawLabel: unknown): void => {
		const value = Number(rawValue);
		if (!Number.isFinite(value)) return;
		const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel : String(value);
		collected.push({ value, label });
	};

	if (typeof states === "string") {
		// "0:Smart;1:Light"
		for (const pair of states.split(";")) {
			const separator = pair.indexOf(":");
			if (separator === -1) continue;
			add(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
		}
	} else if (Array.isArray(states)) {
		states.forEach((label, index) => add(index, label));
	} else if (states && typeof states === "object") {
		for (const [key, label] of Object.entries(states as Record<string, unknown>)) add(key, label);
	}

	return collected;
}

/** Reads a state value as a non-empty string. */
function textValue(state: SettingStateValue | null | undefined): string | null {
	if (!state || typeof state.val !== "string" || !state.val.trim()) return null;
	return state.val;
}

/** Every state id the model needs, so the source can read them in one call. */
export function settingsStateIds(root: string): string[] {
	const ids: string[] = [];
	for (const setting of KNOWN_SETTINGS) {
		ids.push(`${root}.${SETTINGS_FOLDER}.${setting.command}`);
		if (setting.kind === "timeWindow") {
			ids.push(`${root}.${SETTINGS_FOLDER}.${setting.offCommand}`);
			ids.push(`${root}.${STATUS_FOLDER}.${setting.enabledStatus}`);
			ids.push(`${root}.${STATUS_FOLDER}.${setting.startStatus}`);
			ids.push(`${root}.${STATUS_FOLDER}.${setting.endStatus}`);
		}
	}
	return ids;
}

/**
 * Builds the model out of the published objects and their values.
 *
 * @param input Object definitions and state values below {@link settingsRoot}.
 */
export function buildRobotSettings(input: {
	root: string;
	definitions: SettingStateDefinition[];
	values: Record<string, SettingStateValue | null>;
	/** Admin language, used to resolve per-language object names. */
	language: string;
}): RobotSettingsModel {
	const { root, values, language } = input;
	const definitions = new Map<string, SettingStateDefinition>();
	for (const definition of input.definitions) definitions.set(definition.id, definition);

	const entries: SettingEntry[] = [];

	for (const setting of KNOWN_SETTINGS) {
		const id = `${root}.${SETTINGS_FOLDER}.${setting.command}`;
		const definition = definitions.get(id);
		if (!definition) continue;

		const label = settingLabel(definition.common?.name, language, setting.command);
		const description = typeof definition.common?.desc === "string" ? definition.common.desc : "";

		if (setting.kind === "switch") {
			entries.push({
				kind: "switch",
				command: setting.command,
				folder: SETTINGS_FOLDER,
				label,
				description,
				value: booleanValue(values[id]),
			});
			continue;
		}

		if (setting.kind === "choice") {
			const options = parseChoiceOptions(definition.common?.states);
			// A picker with nothing to pick is a dead control, which is the one thing this panel
			// exists to avoid. An object without usable positions is treated as no object.
			if (!options.length) continue;
			entries.push({
				kind: "choice",
				command: setting.command,
				folder: SETTINGS_FOLDER,
				label,
				description,
				value: numberValue(values[id]),
				options,
			});
			continue;
		}

		if (setting.kind === "number") {
			const min = numericCommon(definition.common?.min);
			const max = numericCommon(definition.common?.max);
			// A slider needs both ends. Inventing one here would let the panel send a value the
			// adapter never said the robot accepts, which is the whole thing this table avoids.
			if (min === null || max === null || min >= max) continue;

			entries.push({
				kind: "number",
				command: setting.command,
				folder: SETTINGS_FOLDER,
				label,
				description,
				value: numberValue(values[id]),
				min,
				max,
				unit: typeof definition.common?.unit === "string" ? definition.common.unit : "",
			});
			continue;
		}

		// Both halves have to exist: without the off command the switch would be one-way.
		if (!definitions.has(`${root}.${SETTINGS_FOLDER}.${setting.offCommand}`)) continue;

		entries.push({
			kind: "timeWindow",
			command: setting.command,
			offCommand: setting.offCommand,
			folder: SETTINGS_FOLDER,
			label,
			description,
			enabled: booleanValue(values[`${root}.${STATUS_FOLDER}.${setting.enabledStatus}`]),
			start: textValue(values[`${root}.${STATUS_FOLDER}.${setting.startStatus}`]),
			end: textValue(values[`${root}.${STATUS_FOLDER}.${setting.endStatus}`]),
		});
	}

	return { entries };
}

/** Accepted spelling of one time of day in the panel's inputs. */
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/**
 * Checks one `HH:MM` the user typed.
 *
 * The tab validates before it writes because the four numbers reach the robot without field names:
 * a value that slips through as a valid but different time is a robot that drives at night. The
 * adapter refuses the same values a second time - this check is the earlier, friendlier one, not
 * the only one.
 * @param text Time of day.
 */
export function isValidTimeOfDay(text: string): boolean {
	const match = TIME_PATTERN.exec(text);
	if (!match) return false;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Builds the value that is written to switch a window on.
 * @param start Start of the window as `HH:MM`.
 * @param end End of the window as `HH:MM`.
 * @returns The window, or null when either time is unusable.
 */
export function composeWindow(start: string, end: string): string | null {
	if (!isValidTimeOfDay(start) || !isValidTimeOfDay(end)) return null;
	return `${padTime(start)}-${padTime(end)}`;
}

/** Normalises `9:30` to `09:30`, which is what the adapter publishes back. */
function padTime(text: string): string {
	const match = TIME_PATTERN.exec(text);
	if (!match) return text;
	return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/** What a write to one setting looks like; the source turns it into a `set_state` message. */
export interface SettingWrite {
	folder: string;
	command: string;
	value: unknown;
}

/**
 * Works out what to write when a time window is switched or retimed.
 *
 * The rules are the app's, not this module's invention:
 *
 *  - switching **on** writes the window, because in this protocol sending a window *is* switching
 *    the mode on;
 *  - switching **off** presses the off command, which carries no window at all;
 *  - changing a time while the window is **on** rewrites it, which keeps it on;
 *  - changing a time while it is **off** writes nothing. Sending the window would switch Do Not
 *    Disturb on behind the user's back, and nobody edits a time in order to activate a mode.
 *
 * @param setting The window as published.
 * @param next What the user wants: the two times and the switch position.
 * @returns The write to perform, or null when nothing should be sent.
 */
export function planTimeWindowWrite(
	setting: TimeWindowSetting,
	next: { start: string; end: string; enabled: boolean },
): SettingWrite | null {
	if (!next.enabled) {
		// Already off, and nothing to switch off: pressing again would be a request for nothing.
		if (setting.enabled === false) return null;
		return { folder: setting.folder, command: setting.offCommand, value: true };
	}

	const window = composeWindow(next.start, next.end);
	if (!window) return null;

	return { folder: setting.folder, command: setting.command, value: window };
}

/** The write that flips a switch setting. */
export function planSwitchWrite(setting: SwitchSetting, next: boolean): SettingWrite {
	return { folder: setting.folder, command: setting.command, value: next };
}

/**
 * The write that moves a choice setting to one of its positions.
 *
 * Refuses a value that is not one of the published positions. The adapter refuses it a second time
 * and would be the one to catch it anyway - this is the earlier check, and it keeps a stale picker
 * from sending a number that no longer exists after a firmware change.
 *
 * @param setting The choice as published.
 * @param next The position the user picked.
 * @returns The write to perform, or null when that position is not offered.
 */
export function planChoiceWrite(setting: ChoiceSetting, next: number): SettingWrite | null {
	if (!setting.options.some(option => option.value === next)) return null;
	return { folder: setting.folder, command: setting.command, value: next };
}

/**
 * The write that moves a number setting to a value.
 *
 * Rounds and clamps rather than refusing. A slider produces fractions and, at its very ends,
 * values a pixel outside the range; refusing those would make the ends of the track unreachable.
 * Anything that is not a number at all is refused, because that is a caller error rather than a
 * rounding artefact.
 *
 * @param setting The number setting as published.
 * @param next The value the user picked.
 * @returns The write to perform, or null when `next` is not a number.
 */
export function planNumberWrite(setting: NumberSetting, next: number): SettingWrite | null {
	if (!Number.isFinite(next)) return null;
	const clamped = Math.min(setting.max, Math.max(setting.min, Math.round(next)));
	return { folder: setting.folder, command: setting.command, value: clamped };
}

/** Reads a bound off `common`, which ioBroker allows to be a number or a numeric string. */
function numericCommon(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
