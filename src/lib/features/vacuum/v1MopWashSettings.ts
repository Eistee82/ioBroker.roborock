import type { FeatureDependencies } from "../baseDeviceFeatures";

/**
 * The two settings behind the dock's mop wash: how thoroughly it washes, and how often.
 *
 * ## Where every value here comes from
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `getWashTowelMode` | `get_wash_towel_mode` | `{}` | A65:229273-229282 |
 * | `setWashTowelMode(a0)` | `set_wash_towel_mode` | `{wash_mode: a0}` | A65:231019-231030 |
 * | `getSmartWashParams` | `get_smart_wash_params` | `{}` | A65:229016-229025 |
 * | `setSmartWashParams(a0,a1)` | `set_smart_wash_params` | `{smart_wash: a0, wash_interval: a1}` | A65:230757-230770 |
 *
 * Both setters build their payload **inside the wrapper**, so the field names are read rather than
 * inferred. That is worth saying because the note this module replaces claimed the opposite - see
 * `V1VacuumFeatures.detectProbedCapabilities` for which of the three neighbours really does pass its
 * argument through unread.
 *
 * The test device answers both getters: `{wash_mode: 1}` and `{smart_wash: 0, wash_interval: 900}`
 * (`_appanalysis/geraetefaehigkeiten-1786807834553.json`).
 *
 * ## The wash mode is an enum with holes, and only three of its values are offered
 *
 * `WashTowelModeMap` (A65:238431) is exactly the kind of table that punishes counting:
 *
 * ```js
 * {WashTowelModeQuick: 0, WashTowelModeDaily: 1, WashTowelModeDeep: 2,
 *  WashTowelModeSuperDeep: 8, WashTowelModeSmart: 10}
 * ```
 *
 * 2 -> 8 -> 10. Any value derived by counting upwards would be a different command.
 *
 * What the picker actually offers is decided one entry at a time in `getWashModes()`
 * (A65:438032-438155), which builds five entries and then drops every one whose `visible` is false:
 *
 * | Key | Label | `visible` | Fundstelle |
 * | --- | --- | --- | --- |
 * | 10 | `wash_towel_mode_title_5` (Smart) | `isNewFeatureStrSupport(DirtyReplenishClean)`, bit 34 | A65:438059-438079 |
 * | 0 | `wash_towel_mode_title_1` (Light) | `true` | A65:438082-438095 |
 * | 1 | `wash_towel_mode_title_2` (Balanced) | `true` | A65:438097-438109 |
 * | 2 | `wash_towel_mode_title_3` (Deep) | `true` | A65:438111-438124 |
 * | 8 | `wash_towel_mode_title_4` (Super Deep) | `isSuperDeepWashSupported() && RSM.isAMReady && !bit 34` | A65:438042-438052, A65:438137-438143 |
 *
 * **Only the three unconditional ones are built here**, and that is a deliberate omission rather
 * than an oversight:
 *
 * - **Smart (10)** hangs on bit 34 of `new_feature_info_str`, which is **clear** on the reference
 *   robot (`0008004056C8FFFE`).
 * - **Super Deep (8)** hangs on bit 15 of the same field - set here - **and** on `RSM.isAMReady`,
 *   which is `(dss & 3) === 2` (A65:223553-223556, mask at A65:223331), i.e. the fill&drain element
 *   being fitted. The reference robot reports `dss = 681`, so `681 & 3 = 1`: not fitted. Its own
 *   description says as much - "Suitable for installing the fill&drain element".
 *
 * Both conditions are knowable, but only from the status packet, which arrives long after these
 * commands are registered. Offering a fourth value on the chance that it applies is precisely the
 * dead control this project keeps removing; leaving it out costs a robot a mode it may have, which
 * is the direction of error `capabilityProbe.ts` argues for at length. The two predicates are
 * written down above so that a later pass can add them without measuring again.
 *
 * ## The wash interval is in seconds, and that is proven three ways
 *
 * `wash_interval` is the second argument, and every one of the four call sites treats it as
 * **seconds**:
 *
 * | Call site | What it sends | Fundstelle |
 * | --- | --- | --- |
 * | `onChangeBackWashMode` | `60 * <minutes from the slider>` | A65:437384-437395 |
 * | `onChangeWashInterval` | `60 * parseInt(<minutes>)` | A65:437493-437502 |
 * | map-not-saved reset (two copies) | `900`, and then puts **15** on its minute-valued state | A65:433113-433125, A65:854579-854599 |
 *
 * And the read side divides: `parseInt(result.wash_interval / 60)` (A65:854540-854545). 900 s is
 * 15 min in the app's own arithmetic, in both directions.
 *
 * ## `smart_wash` is a flag, not the three-valued mode it looks like
 *
 * This is the trap. `BackWashModeMap` (A65:238470) has three members - `Smart` 0, `Custom` 1,
 * `Level` 2 - and it is tempting to send them. It is a **display** mode: the app derives it from the
 * answer (A65:433080-433097) and never sends it. What goes on the wire is 0 or 1, at all four call
 * sites:
 *
 * - Smart picked -> `smart_wash = 1`, interval **always** 20 min (A65:437316-437317 sets the
 *   default, the Smart branch at A65:437361-437363 keeps it) - the slider value is not used;
 * - anything else -> `smart_wash = 0` with the chosen interval.
 *
 * A `smart_wash` of 2 would be a value no caller in the plugin produces.
 *
 * ## One state for both, because there is one call
 *
 * The same reasoning `registerDryerSettingCommand` gives: `set_smart_wash_params` always carries
 * both fields, so a switch plus a duration would send the pair twice for one change and would send
 * an interval the user never chose whenever only the switch was touched.
 *
 * The app models it exactly this way too. Its dock panel has **one** row, titled
 * `back_wash_time_setting`, whose value reads either "By Room" or "N min" (A65:435021-435044). This
 * state is that row: `0` for by-room, and otherwise the interval in seconds.
 *
 * The offered intervals are the app's own slider - `minimumValue: 10, maximumValue: 50, step: 5`
 * minutes (A65:436653) - which is 600 to 3000 seconds in steps of 300.
 */

/** RPC that reads the wash mode; also the capability probe for its setter. */
export const GET_WASH_TOWEL_MODE = "get_wash_towel_mode";

/** RPC that sets the wash mode. */
export const SET_WASH_TOWEL_MODE = "set_wash_towel_mode";

/** RPC that reads the wash frequency; also the capability probe for its setter. */
export const GET_SMART_WASH_PARAMS = "get_smart_wash_params";

/** RPC that sets the wash frequency. */
export const SET_SMART_WASH_PARAMS = "set_smart_wash_params";

/** One entry of the wash mode picker. */
export interface WashTowelModeOption {
	/** The number that reaches `wash_mode`. */
	value: number;
	/** Roborock's own key for the label. */
	labelKey: string;
	/** English wording, used when the strings file has nothing. */
	fallback: string;
}

/**
 * The wash modes offered here, in the order the app lists them.
 *
 * The three whose `visible` is a literal `true` in `getWashModes()`. See the module comment for the
 * two that are left out and for the exact predicate each of them hangs on.
 */
export const WASH_TOWEL_MODES: WashTowelModeOption[] = [
	{ value: 0, labelKey: "wash_towel_mode_title_1", fallback: "Light" },
	{ value: 1, labelKey: "wash_towel_mode_title_2", fallback: "Balanced" },
	{ value: 2, labelKey: "wash_towel_mode_title_3", fallback: "Deep" }
];

/** State value that stands for "let the dock decide", i.e. `smart_wash: 1`. */
export const SMART_WASH_BY_ROOM = 0;

/** Interval the app sends together with `smart_wash: 1`, in seconds (A65:437316-437317). */
export const SMART_WASH_BY_ROOM_INTERVAL = 1200;

/** Shortest interval the app's slider reaches, in seconds (10 min, A65:436653). */
export const WASH_INTERVAL_MIN = 600;

/** Longest interval the app's slider reaches, in seconds (50 min, A65:436653). */
export const WASH_INTERVAL_MAX = 3000;

/** Slider granularity, in seconds (5 min, A65:436653). */
export const WASH_INTERVAL_STEP = 300;

/** Every interval the app's slider can produce, in seconds. */
export function washIntervalSeconds(): number[] {
	const values: number[] = [];
	for (let seconds = WASH_INTERVAL_MIN; seconds <= WASH_INTERVAL_MAX; seconds += WASH_INTERVAL_STEP) {
		values.push(seconds);
	}
	return values;
}

/** Digs the robot's payload out of the shapes the request layer hands back. */
function unwrapPayload(response: unknown): Record<string, unknown> | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];

	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	return payload as Record<string, unknown>;
}

/** Reads a finite number out of a value the robot may have sent as a string. */
function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads a finite number out of a value somebody **wrote into a state**.
 *
 * Stricter than {@link finiteNumber} on purpose, and the same shape `toSoundVolume` uses. `Number()`
 * turns `[]` into `0` and `[600]` into `600`, so the loose reader would have accepted an empty array
 * as the wash mode *Light* and as *by room* - a value nobody typed, built out of a container that
 * was never a number. On the reading side that shape cannot arrive; on the writing side it decides
 * what the robot is told to do.
 *
 * @param value Raw value written into the state.
 * @returns The number, or null when the value is not one.
 */
function writtenNumber(value: unknown): number | null {
	const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "")
		? Number(value)
		: Number.NaN;
	return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Reads the answer of `get_wash_towel_mode`, which arrives as `{wash_mode: 1}`.
 *
 * @param response Raw robot answer.
 * @returns The mode, or null when the answer carries none.
 */
export function parseWashTowelModeResponse(response: unknown): number | null {
	const payload = unwrapPayload(response);
	if (!payload) return null;
	return finiteNumber(payload.wash_mode);
}

/** What `get_smart_wash_params` says, in the robot's own units. */
export interface SmartWashSetting {
	/** 1 when the dock decides by room, 0 when it washes on the interval below. */
	smartWash: number;
	/** The interval in seconds, or null when the answer carries none. */
	washIntervalSeconds: number | null;
}

/**
 * Reads the answer of `get_smart_wash_params`, which arrives as
 * `{smart_wash: 0, wash_interval: 900}`.
 *
 * @param response Raw robot answer.
 * @returns The setting, or null when the answer carries no `smart_wash`.
 */
export function parseSmartWashResponse(response: unknown): SmartWashSetting | null {
	const payload = unwrapPayload(response);
	if (!payload) return null;

	const smartWash = finiteNumber(payload.smart_wash);
	if (smartWash === null) return null;

	return { smartWash, washIntervalSeconds: finiteNumber(payload.wash_interval) };
}

/**
 * Turns the robot's answer into the single number this module publishes.
 *
 * @param setting The setting as the robot reported it.
 * @returns {@link SMART_WASH_BY_ROOM} while the dock decides, otherwise the interval in seconds;
 *          null when the robot reported by-time without an interval, which is nothing to show.
 */
export function smartWashStateValue(setting: SmartWashSetting): number | null {
	if (setting.smartWash === 1) return SMART_WASH_BY_ROOM;
	return setting.washIntervalSeconds;
}

/**
 * Turns a written value into the mode the robot is sent.
 *
 * **Stricter than the app on purpose, and this is the one place that is true.** The app's own
 * handler has no guard for an empty selection: `onChangeWashTowelMode(a0)` takes `a0[0]`, and when
 * `a0` is null it leaves the value `undefined` and calls `setWashTowelMode(undefined)` anyway
 * (A65:437090-437107) - so it sends `{wash_mode: undefined}`. This refuses instead. Left as a
 * difference rather than copied, and written down here so that nobody later reads it as a deviation
 * to be "corrected" back towards the app.
 *
 * @param value Raw value written into the state.
 * @returns The mode to send.
 * @throws When the value is not one of the offered modes. Refused rather than rounded: the values
 *         have holes, so a neighbouring number is a different command rather than a near miss.
 */
export function toWashTowelMode(value: unknown): number {
	const numeric = writtenNumber(value);
	if (numeric === null || !WASH_TOWEL_MODES.some((mode) => mode.value === numeric)) {
		const offered = WASH_TOWEL_MODES.map((mode) => mode.value).join(", ");
		throw new Error(`${SET_WASH_TOWEL_MODE} accepts ${offered}; received ${JSON.stringify(value)}`);
	}
	return numeric;
}

/** The pair `set_smart_wash_params` expects, named as the wrapper names them. */
export interface SmartWashParams {
	smart_wash: number;
	wash_interval: number;
}

/**
 * Turns a written value into the pair the robot is sent.
 *
 * @param value Raw value written into the state: {@link SMART_WASH_BY_ROOM} or an interval in
 *              seconds.
 * @returns Both fields, as the wrapper builds them.
 * @throws When the value is neither the by-room sentinel nor an interval the app's slider reaches.
 */
export function toSmartWashParams(value: unknown): SmartWashParams {
	const numeric = writtenNumber(value);
	if (numeric === null) {
		throw new Error(`${SET_SMART_WASH_PARAMS} needs a number; received ${JSON.stringify(value)}`);
	}

	if (numeric === SMART_WASH_BY_ROOM) {
		// The app sends its own 20 minutes here and ignores whatever the slider held; see the module
		// comment. Sending the interval the user last chose would be a value the app never sends.
		return { smart_wash: 1, wash_interval: SMART_WASH_BY_ROOM_INTERVAL };
	}

	if (!washIntervalSeconds().includes(numeric)) {
		throw new Error(
			`${SET_SMART_WASH_PARAMS} accepts ${SMART_WASH_BY_ROOM} (by room) or ${WASH_INTERVAL_MIN} to ${WASH_INTERVAL_MAX} seconds in steps of ${WASH_INTERVAL_STEP}; received ${JSON.stringify(value)}`
		);
	}

	return { smart_wash: 0, wash_interval: numeric };
}

/**
 * Publishes the two mop wash settings and drives them.
 *
 * Owns its state names and its payloads; the feature class only routes to it. Holds no timer and no
 * subscription, so there is nothing for `onUnload` to clean up.
 */
export class V1MopWashSettingsService {
	/** Methods this service registered itself, and therefore the only ones it builds parameters for. */
	private readonly claimed = new Set<string>();

	constructor(
		private readonly deps: FeatureDependencies,
		private readonly duid: string
	) {}

	/** Shorthand for a Roborock wording with an English fallback. */
	private text(key: string, fallback: string): string {
		return this.deps.adapter.translationManager.get(key, fallback);
	}

	/** Methods this service registered and is therefore responsible for. */
	public handles(method: string): boolean {
		return this.claimed.has(method);
	}

	/**
	 * Builds the label of one interval out of Roborock's own template.
	 *
	 * `setting_back_wash_interval` is `" ${minute} min"` in English and `"${minute} Minuten"` in
	 * German (A65:435035-435039 substitutes the same placeholder). Using it means the picker reads
	 * the way the app reads, in all 24 languages the strings file carries, and costs no translation
	 * of our own.
	 *
	 * @param seconds The interval.
	 * @returns The label.
	 */
	private intervalLabel(seconds: number): string {
		const minutes = seconds / 60;
		const template = this.text("setting_back_wash_interval", " ${minute} min");
		if (!template.includes("${minute}")) return `${minutes} min`;
		return template.replace("${minute}", String(minutes)).trim();
	}

	/**
	 * Registers the wash mode and its read button.
	 *
	 * Separate from {@link registerSmartWashCommands} although both live in this service, and that
	 * separation is not cosmetic: `probeAndApply` skips a capability whose command is already
	 * registered, so registering both here would make the first probe swallow the second one - the
	 * frequency would never be asked about and never appear. It also happens to be the honest
	 * split, because a robot can answer one of the two getters and not the other.
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerWashTowelModeCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const title = this.text("wash_towel_mode_title", "Washing Mode");

		const states: Record<number, string> = {};
		for (const mode of WASH_TOWEL_MODES) states[mode.value] = this.text(mode.labelKey, mode.fallback);

		addCommand(SET_WASH_TOWEL_MODE, {
			type: "number",
			role: "level",
			name: title,
			desc: "How much water and time the dock spends washing the mop.",
			states,
			def: WASH_TOWEL_MODES[0].value,
			write: true
		}, "settings");

		addCommand(GET_WASH_TOWEL_MODE, {
			type: "boolean",
			role: "button",
			name: `Read ${title}`,
			def: false
		}, "queries");

		this.claimed.add(SET_WASH_TOWEL_MODE).add(GET_WASH_TOWEL_MODE);
	}

	/**
	 * Registers the wash frequency and its read button.
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerSmartWashCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const title = this.text("back_wash_time_setting", "Mop Wash Frequency");

		const states: Record<number, string> = {
			[SMART_WASH_BY_ROOM]: this.text("back_wash_title1", "By Room").trim()
		};
		for (const seconds of washIntervalSeconds()) states[seconds] = this.intervalLabel(seconds);

		addCommand(SET_SMART_WASH_PARAMS, {
			type: "number",
			role: "level",
			name: title,
			desc: this.text(
				"back_wash_desc",
				"Dynamically adjust the wash interval according to room partitioning, automatically back&wash the mop."
			),
			unit: "s",
			states,
			def: SMART_WASH_BY_ROOM,
			write: true
		}, "settings");

		addCommand(GET_SMART_WASH_PARAMS, {
			type: "boolean",
			role: "button",
			name: `Read ${title}`,
			def: false
		}, "queries");

		this.claimed.add(SET_SMART_WASH_PARAMS).add(GET_SMART_WASH_PARAMS);
	}

	/**
	 * Builds the parameters of one of the four methods.
	 *
	 * @param method Method as registered.
	 * @param value Raw value written into the state; only read for the two settings.
	 * @returns The method and parameters to send.
	 * @throws When the value is outside what the app itself would send.
	 */
	public buildCommandParams(method: string, value: unknown): { method: string; params: unknown } {
		// Both getters send `{}` rather than `[]` - read off their wrappers, A65:229273-229282 and
		// A65:229016-229025. Their neighbour `get_wash_towel_params` sends `[]`, which is the
		// standing reminder that this is not uniform even within one function group.
		if (method === GET_WASH_TOWEL_MODE || method === GET_SMART_WASH_PARAMS) return { method, params: {} };

		if (method === SET_WASH_TOWEL_MODE) {
			return { method, params: { wash_mode: toWashTowelMode(value) } };
		}

		return { method: SET_SMART_WASH_PARAMS, params: toSmartWashParams(value) };
	}

	/**
	 * Publishes the wash mode the robot reports onto its writable state.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether a mode was published.
	 */
	public async applyWashTowelModeResponse(response: unknown): Promise<boolean> {
		const mode = parseWashTowelModeResponse(response);
		if (mode === null) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_WASH_TOWEL_MODE} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		// Published even when it is not one of the three offered here. The robot is the authority on
		// what it holds, and hiding a mode it really is in would be the same lie as a dead switch -
		// the write side stays narrow either way.
		if (!WASH_TOWEL_MODES.some((offered) => offered.value === mode)) {
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
				`The robot reports wash mode ${mode}, which is not one of the offered ${WASH_TOWEL_MODES.map((o) => o.value).join(", ")}. Publishing it anyway; writing it back is refused.`, "info");
		}

		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${SET_WASH_TOWEL_MODE}`, {
			val: mode,
			ack: true
		});
		return true;
	}

	/**
	 * Publishes the wash frequency the robot reports onto its writable state.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether a frequency was published.
	 */
	public async applySmartWashResponse(response: unknown): Promise<boolean> {
		const setting = parseSmartWashResponse(response);
		if (!setting) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_SMART_WASH_PARAMS} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		const value = smartWashStateValue(setting);
		if (value === null) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`${GET_SMART_WASH_PARAMS} reported smart_wash ${setting.smartWash} without a wash_interval; nothing to publish.`, "warn");
			return false;
		}

		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${SET_SMART_WASH_PARAMS}`, {
			val: value,
			ack: true
		});
		return true;
	}
}
