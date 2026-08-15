import type { FeatureDependencies } from "../baseDeviceFeatures";
import { DeviceStateWriter } from "../deviceStateWriter";

/**
 * Four robot functions the device has to be asked about: the dock's empty mode and drying setting,
 * the robot's own time zone, and the estimate it keeps while it cleans.
 *
 * ## Why they are here and not in a model class
 *
 * `a179_features.ts` declares `app_get_clean_estimate_info`, `app_get_dryer_setting` and
 * `app_set_dryer_setting` for one model class, and nothing declares `set_dust_collection_mode` at
 * all. The measurement of `_appanalysis/19-geraetefaehigkeiten.md` §4 showed the test device - an
 * a65, not an a179 - answers all four getters. Model class is the wrong criterion in both
 * directions, so these are unlocked by asking the robot (`../capabilityProbe.ts`) instead.
 *
 * ## Where every value here comes from
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`. The full proof chain
 * with the surrounding code is in `_appanalysis/22-einstellungsblock.md`.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `getTimeZone` | `Methods.GetTimezone` = `get_timezone` | `new Array(0)`, i.e. `[]` | A65:229095-229110 |
 * | `getCleanEstimateInfo` | `'app_get_clean_estimate_info'` | `r1 = {}`, i.e. `{}` | A65:228337-228346 |
 * | `getDustCollectionMode` | `'get_dust_collection_mode'` | `[]` | A65:228566-228575 |
 * | `setDustCollectionMode(a0)` | `'set_dust_collection_mode'` | `{mode: a0}` | A65:230399-230410 |
 * | `getDryerSetting` | `'app_get_dryer_setting'` | `[]` | A65:228556-228565 |
 * | `setDryerSetting(a0,a1)` | `'app_set_dryer_setting'` | `{on: {dry_time: a0}, status: a1}` | A65:230339-230374 |
 *
 * Note the payload of `app_get_clean_estimate_info`: an empty **object**, where its neighbours send
 * an empty array. That is not a transcription slip, it is what the wrapper builds.
 *
 * ## The empty mode does not write the value its debug table names
 *
 * Roborock's telemetry table translates the empty mode as `{0: 'Smart', 1: 'quick', 2: 'daily',
 * 3: 'very strong'}` (A65:379765, assigned to key 541 = 集尘模式 at A65:379766). Taking those four
 * numbers as the writable range would be wrong for the strongest step.
 *
 * The values the app really writes come from `getCollectionModes()` (A65:438312-438375), which
 * carries an explicit `key` per entry: **0, 1, 2 and 4** - three is skipped. Its `onChange` runs
 * `onChangeDustCollectionMode(a0)`, which takes `a0[0]` and hands it to `setDustCollectionMode`
 * unchanged (A65:908028-908055).
 *
 * Two independent confirmations that 3 is not offered:
 *
 *  - the constant list `DustCollectionModes` fills slots 0, 1, 2 and 4 and leaves 3 empty
 *    (A65:839767-839821);
 *  - the label of mode 3, `dust_collection_title_4`, exists in **no** language of
 *    `lib/protocols/roborock_strings.json`, while `_1`, `_2`, `_3` and `_5` exist in all of them.
 *
 * `DustCollectionModeSettingMap` (A65:238392) does name a `Strong: 3` beside `Max: 4`, so the value
 * exists in the enum. It has no user-facing name and no picker entry, which is why it is not
 * offered here. That is the one deliberate omission in this module.
 *
 * ## The drying setter builds its payload, it does not pass one through
 *
 * `setDryerSetting` was long held back because its argument was believed to be forwarded unread. It
 * is not: the wrapper composes `Object.assign({on: {dry_time: a0}, status: a1}, arguments[2] ?? {})`
 * (A65:230351-230370). Both arguments are proven at three independent call sites:
 *
 *  - `onPressDryerTimeMode(a0)` sends `a0[0]` as the time and `isDryOn ? 1 : 0` as the status
 *    (A65:909554-909579);
 *  - `setStartDryerSwitch(on)` sends the currently selected time with `on ? 1 : 0`
 *    (A65:780056-780073 and A65:855684-855716).
 *
 * The read side is the mirror image: `status` becomes the switch position and `on.dry_time` the
 * selected time (A65:779902-779912).
 *
 * The times are picker keys, not free numbers: 7200 / 10800 / 14400 from `getDryModes()`
 * (A65:438261-438311) and the same three plus 18000 on the second drying page
 * (A65:780146-780182). Their labels `dock_kit_setting2/3/1/0` read "2h" / "3h" / "4h" / "5h", so the
 * unit is seconds. Which of the two pages a given robot shows was not traced, so 18000 is offered
 * with that caveat recorded in the report rather than silently dropped or silently assumed.
 *
 * **What the setter does not carry.** The test device answers the getter with more than it is ever
 * sent: `cliff_on`, `cliff_off`, `count` and `dry_heating_film_time` inside `on`, plus a whole `off`
 * block. The app never returns any of them. This is therefore not a `save_map`-style full-inventory
 * write, and this module sends exactly what the app sends - no more, because a value invented for
 * those fields would be a guess, and no less, because that is the proven payload.
 */

/** RPC that reads the robot's own time zone. */
export const GET_TIMEZONE = "get_timezone";

/** RPC that reads the estimate of the running clean. */
export const GET_CLEAN_ESTIMATE_INFO = "app_get_clean_estimate_info";

/** RPC that reads the dock's empty mode; also the capability probe for the setter. */
export const GET_DUST_COLLECTION_MODE = "get_dust_collection_mode";

/** RPC that sets the dock's empty mode. */
export const SET_DUST_COLLECTION_MODE = "set_dust_collection_mode";

/** RPC that reads the drying setting; also the capability probe for the setter. */
export const GET_DRYER_SETTING = "app_get_dryer_setting";

/** RPC that sets the drying setting. */
export const SET_DRYER_SETTING = "app_set_dryer_setting";

/**
 * The empty modes the app offers, with the Roborock string key of each label.
 *
 * Mode 3 is absent on purpose; see the module comment. The keys are the ones `getCollectionModes()`
 * puts on its entries, and the label keys are the ones it reads for their titles.
 */
export const DUST_COLLECTION_MODES: ReadonlyArray<{ value: number; labelKey: string; fallback: string }> = [
	{ value: 0, labelKey: "dust_collection_title_1", fallback: "Smart" },
	{ value: 1, labelKey: "dust_collection_title_2", fallback: "Light" },
	{ value: 2, labelKey: "dust_collection_title_3", fallback: "Balanced" },
	{ value: 4, labelKey: "dust_collection_title_5", fallback: "Max" }
];

/**
 * The drying times the app offers, in seconds, with the Roborock string key of each label.
 *
 * 18000 comes from the second of the app's two drying pages only; see the module comment.
 */
export const DRYER_TIMES: ReadonlyArray<{ seconds: number; labelKey: string; fallback: string }> = [
	{ seconds: 7200, labelKey: "dock_kit_setting2", fallback: "2h" },
	{ seconds: 10800, labelKey: "dock_kit_setting3", fallback: "3h" },
	{ seconds: 14400, labelKey: "dock_kit_setting1", fallback: "4h" },
	{ seconds: 18000, labelKey: "dock_kit_setting0", fallback: "5h" }
];

/**
 * Time the app falls back to when it has to send one and knows none.
 *
 * Not this module's choice: the app does `dryTime || 7200` before it sends (A65:968341-968346). It
 * matters because switching drying **off** still carries a time, so a robot that was never read
 * would otherwise leave nothing to send.
 */
export const DEFAULT_DRY_TIME_SECONDS = 7200;

/** Value of the drying state that means "switched off". */
export const DRYER_OFF_VALUE = 0;

/** Unwraps the one or two layers the request layer and the robot put around a result. */
function unwrapPayload(response: unknown): unknown {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];
	return payload;
}

/** Reads a finite number out of a value the robot may have sent as a string. */
function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the answer of `get_timezone`, which arrives as `["Europe/Berlin"]`.
 *
 * **The array is required, not unwrapped away.** This is the one getter here whose payload is a
 * single string, and a bare string is exactly how the robot says it does not know a method:
 * `{"result": "unknown_method"}` (`_appanalysis/19-geraetefaehigkeiten.md` §0). Accepting a loose
 * string would turn every rejection into a time zone called "unknown_method". The array wrapper is
 * what tells the two apart, so it has to be there.
 *
 * @param response Raw robot answer.
 * @returns The zone name, or null when the answer carries none.
 */
export function parseTimezoneResponse(response: unknown): string | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	if (!Array.isArray(payload) || payload.length !== 1) return null;

	const zone = payload[0];
	if (typeof zone !== "string") return null;
	const trimmed = zone.trim();
	return trimmed === "" ? null : trimmed;
}

/** The fields of `clean_estimate` whose meaning is proven, already converted. */
export interface CleanEstimate {
	/** Estimated area of the whole job, in m². */
	totalArea: number | null;
	/** Area still to do, in m². */
	remainingArea: number | null;
	/** Estimated duration of the whole job, in seconds. */
	totalTime: number | null;
	/** Time still to go, in seconds. */
	remainingTime: number | null;
	/** Progress in percent. */
	percent: number | null;
	/** Battery the remaining area is expected to need, in percent. */
	remainingBattery: number | null;
	/** Seconds per square metre. */
	timePerArea: number | null;
	/** Percent of battery per square metre. */
	batteryPerArea: number | null;
}

/** Turns square millimetres into square metres, keeping one decimal. */
function toSquareMetres(millimetres: number): number {
	return Math.round((millimetres / 1000000) * 10) / 10;
}

/**
 * Reads the answer of `app_get_clean_estimate_info`.
 *
 * The units are read from the app's own display code (`getMenuDatas`, A65:780879-781035): the two
 * areas go through `fromSqmmToSqm` or a division by 1000000, so they are square **millimetres**;
 * the two times go through `fromSecToMin`, so they are seconds; `clean_time_rate` is printed with
 * `s/㎡` and `battery_consumption_rate`, `remaining_battery` and `percent` with `%`.
 *
 * `total_battery`, `resume_wait_time` and `count` arrive from the robot but are **not** published:
 * the app reads the first into a state it never displays and never touches the other two, so their
 * meaning is unproven.
 *
 * @param response Raw robot answer.
 * @returns The converted estimate, or null when the answer carries no `clean_estimate`.
 */
export function parseCleanEstimateResponse(response: unknown): CleanEstimate | null {
	const payload = unwrapPayload(response);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

	const inner = (payload as Record<string, unknown>).clean_estimate;
	if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;

	const source = inner as Record<string, unknown>;
	const totalArea = finiteNumber(source.total_area);
	const remainingArea = finiteNumber(source.remaining_area);

	return {
		totalArea: totalArea === null ? null : toSquareMetres(totalArea),
		remainingArea: remainingArea === null ? null : toSquareMetres(remainingArea),
		totalTime: finiteNumber(source.total_time),
		remainingTime: finiteNumber(source.remaining_time),
		percent: finiteNumber(source.percent),
		remainingBattery: finiteNumber(source.remaining_battery),
		timePerArea: finiteNumber(source.clean_time_rate),
		batteryPerArea: finiteNumber(source.battery_consumption_rate)
	};
}

/**
 * Reads the answer of `get_dust_collection_mode`, which arrives as `{"mode":0}`.
 * @param response Raw robot answer.
 * @returns The mode, or null when the answer carries none.
 */
export function parseDustCollectionModeResponse(response: unknown): number | null {
	const payload = unwrapPayload(response);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	return finiteNumber((payload as Record<string, unknown>).mode);
}

/** What `app_get_dryer_setting` says about the drying add-on. */
export interface DryerSetting {
	/** Whether automatic drying is switched on. */
	enabled: boolean | null;
	/** Selected drying duration in seconds, from `on.dry_time`. */
	dryTimeSeconds: number | null;
}

/**
 * Reads the answer of `app_get_dryer_setting`.
 *
 * Only the two fields the app itself reads back are taken (A65:779902-779912). The rest of the
 * answer - the cliff thresholds, the counts, the heating film time and the whole `off` block - is
 * left alone, because nothing in the app reads or writes it and a state built on a guessed meaning
 * is worse than a missing one.
 *
 * @param response Raw robot answer.
 * @returns The setting, or null when the answer carries neither field.
 */
export function parseDryerSettingResponse(response: unknown): DryerSetting | null {
	const payload = unwrapPayload(response);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

	const source = payload as Record<string, unknown>;
	const rawStatus = source.status;
	const enabled = rawStatus === undefined ? null : Boolean(finiteNumber(rawStatus));

	let dryTimeSeconds: number | null = null;
	const on = source.on;
	if (on && typeof on === "object" && !Array.isArray(on)) {
		dryTimeSeconds = finiteNumber((on as Record<string, unknown>).dry_time);
	}

	if (enabled === null && dryTimeSeconds === null) return null;
	return { enabled, dryTimeSeconds };
}

/** True for a value the empty mode may be set to. */
export function isKnownDustCollectionMode(value: number): boolean {
	return DUST_COLLECTION_MODES.some((mode) => mode.value === value);
}

/** True for a drying duration the app offers. */
export function isKnownDryTime(seconds: number): boolean {
	return DRYER_TIMES.some((time) => time.seconds === seconds);
}

/**
 * Publishes the four functions and drives the two writable ones.
 *
 * Owns its state names and its payloads; the feature class only routes to it. Holds no timer and no
 * subscription, so there is nothing for `onUnload` to clean up.
 *
 * This module sits directly under `features/vacuum/` rather than beside its siblings in
 * `features/vacuum/services/`, because that directory was held by another change while this one was
 * written. Moving it there later is a rename and nothing else.
 */
export class V1ProbedCapabilityService {
	private readonly stateWriter: DeviceStateWriter;

	/** Methods this service registered itself, and therefore the only ones it builds parameters for. */
	private readonly claimed = new Set<string>();

	/**
	 * Last drying duration the robot reported.
	 *
	 * Kept because switching drying off still has to carry a time (A65:780065-780073): the app sends
	 * the one currently selected. Without it the fallback of {@link DEFAULT_DRY_TIME_SECONDS} applies,
	 * which is the app's own.
	 */
	private lastDryTimeSeconds: number | null = null;

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

	// --- Registration -------------------------------------------------------------------------

	/**
	 * Registers the time zone read button.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerTimezoneCommand(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		addCommand(GET_TIMEZONE, {
			type: "boolean",
			role: "button",
			name: `Read ${this.text("setting_timezone_title", "Robot Time Zone")}`,
			def: false
		}, "queries");

		this.claimed.add(GET_TIMEZONE);
	}

	/**
	 * Registers the clean estimate read button.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerCleanEstimateCommand(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		addCommand(GET_CLEAN_ESTIMATE_INFO, {
			type: "boolean",
			role: "button",
			name: "Read cleaning estimate",
			desc: "The robot only keeps an estimate while it is cleaning; in the dock it reports the one of the last run.",
			def: false
		}, "queries");

		this.claimed.add(GET_CLEAN_ESTIMATE_INFO);
	}

	/**
	 * Registers the empty mode selector and its read button.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerDustCollectionModeCommand(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const states: Record<number, string> = {};
		for (const mode of DUST_COLLECTION_MODES) states[mode.value] = this.text(mode.labelKey, mode.fallback);

		addCommand(SET_DUST_COLLECTION_MODE, {
			type: "number",
			role: "level",
			name: this.text("dust_collection_desc_title", "Empty Mode"),
			states,
			def: DUST_COLLECTION_MODES[0].value,
			write: true
		}, "settings");

		addCommand(GET_DUST_COLLECTION_MODE, {
			type: "boolean",
			role: "button",
			name: `Read ${this.text("dust_collection_desc_title", "Empty Mode")}`,
			def: false
		}, "queries");

		this.claimed.add(SET_DUST_COLLECTION_MODE).add(GET_DUST_COLLECTION_MODE);
	}

	/**
	 * Registers the drying selector and its read button.
	 *
	 * One state and not two, because the protocol has one call: `app_set_dryer_setting` always
	 * carries both the duration and the on/off. Modelling it as a switch plus a duration would mean
	 * sending the pair twice for one change, and sending a duration the user did not choose when only
	 * the switch was touched.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerDryerSettingCommand(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const states: Record<number, string> = { [DRYER_OFF_VALUE]: this.text("dry_interval_off_title", "No-Drying") };
		for (const time of DRYER_TIMES) states[time.seconds] = this.text(time.labelKey, time.fallback);

		addCommand(SET_DRYER_SETTING, {
			type: "number",
			role: "level",
			name: this.text("dock_kit_setting5", "Auto Drying"),
			states,
			def: DRYER_OFF_VALUE,
			write: true
		}, "settings");

		addCommand(GET_DRYER_SETTING, {
			type: "boolean",
			role: "button",
			name: `Read ${this.text("dock_kit_setting4", "Drying Settings")}`,
			def: false
		}, "queries");

		this.claimed.add(SET_DRYER_SETTING).add(GET_DRYER_SETTING);
	}

	// --- Parameters ---------------------------------------------------------------------------

	/**
	 * Builds the parameters of one of the registered methods.
	 *
	 * Refuses rather than sending something else when a value is not one the app writes. A rejected
	 * write is visible and costs nothing; a number the robot accepts and reads as a different mode is
	 * a dock that behaves differently for reasons nobody can see.
	 *
	 * @param method Method as registered in the settings or queries folder.
	 * @param value  Raw value written into the state.
	 * @returns The method and parameters to send.
	 */
	public buildCommandParams(method: string, value: unknown): { method: string; params: unknown } {
		if (method === GET_TIMEZONE) return { method: GET_TIMEZONE, params: [] };
		if (method === GET_DUST_COLLECTION_MODE) return { method: GET_DUST_COLLECTION_MODE, params: [] };
		if (method === GET_DRYER_SETTING) return { method: GET_DRYER_SETTING, params: [] };

		// The one wrapper of the six that sends an object rather than an array (A65:228341).
		if (method === GET_CLEAN_ESTIMATE_INFO) return { method: GET_CLEAN_ESTIMATE_INFO, params: {} };

		if (method === SET_DUST_COLLECTION_MODE) {
			const mode = finiteNumber(value);
			if (mode === null || !isKnownDustCollectionMode(mode)) {
				throw new Error(
					`${SET_DUST_COLLECTION_MODE} accepts ${DUST_COLLECTION_MODES.map((entry) => entry.value).join(", ")}; received ${JSON.stringify(value)}`
				);
			}
			return { method: SET_DUST_COLLECTION_MODE, params: { mode } };
		}

		if (method === SET_DRYER_SETTING) {
			const selected = finiteNumber(value);
			if (selected === null || (selected !== DRYER_OFF_VALUE && !isKnownDryTime(selected))) {
				throw new Error(
					`${SET_DRYER_SETTING} accepts ${DRYER_OFF_VALUE} (off) or ${DRYER_TIMES.map((entry) => entry.seconds).join(", ")} seconds; received ${JSON.stringify(value)}`
				);
			}

			const dryTime = selected === DRYER_OFF_VALUE
				? (this.lastDryTimeSeconds ?? DEFAULT_DRY_TIME_SECONDS)
				: selected;
			const status = selected === DRYER_OFF_VALUE ? 0 : 1;
			return { method: SET_DRYER_SETTING, params: { on: { dry_time: dryTime }, status } };
		}

		return { method, params: value };
	}

	// --- Publishing ---------------------------------------------------------------------------

	/**
	 * Publishes the robot's time zone.
	 *
	 * Worth a state of its own because the Do Not Disturb window is kept in the robot's clock, not
	 * the user's. Roborock says so itself: `setting_timezone_remark_owner` reads "Inaccurate robot
	 * time zone may affect DND mode accuracy." Until now the documentation had to carry that as an
	 * unanswerable caveat; with this state a user can check it.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether a zone was published.
	 */
	public async applyTimezoneResponse(response: unknown): Promise<boolean> {
		const zone = parseTimezoneResponse(response);
		if (zone === null) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_TIMEZONE} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.stateWriter.ensureFolder("deviceStatus");
		await this.stateWriter.ensureAndSetState("deviceStatus.timezone", {
			name: this.text("setting_timezone_title", "Robot Time Zone"),
			type: "string",
			role: "text",
			read: true,
			write: false
		}, zone);
		return true;
	}

	/**
	 * Publishes the estimate of the running clean.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether an estimate was published.
	 */
	public async applyCleanEstimateResponse(response: unknown): Promise<boolean> {
		const estimate = parseCleanEstimateResponse(response);
		if (!estimate) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_CLEAN_ESTIMATE_INFO} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.stateWriter.ensureFolder("cleaningInfo");
		await this.publishNumber("cleaningInfo.estimateTotalArea", "Estimated total area", "m²", estimate.totalArea);
		await this.publishNumber("cleaningInfo.estimateRemainingArea", "Estimated remaining area", "m²", estimate.remainingArea);
		await this.publishNumber("cleaningInfo.estimateTotalTime", "Estimated total time", "s", estimate.totalTime);
		await this.publishNumber("cleaningInfo.estimateRemainingTime", "Estimated remaining time", "s", estimate.remainingTime);
		await this.publishNumber("cleaningInfo.estimateProgress", "Cleaning progress", "%", estimate.percent);
		await this.publishNumber("cleaningInfo.estimateRemainingBattery", "Battery needed for the remaining area", "%", estimate.remainingBattery);
		await this.publishNumber("cleaningInfo.estimateTimePerArea", "Cleaning time per area", "s/m²", estimate.timePerArea);
		await this.publishNumber("cleaningInfo.estimateBatteryPerArea", "Battery use per area", "%/m²", estimate.batteryPerArea);
		return true;
	}

	/**
	 * Publishes the empty mode and mirrors it into the writable state.
	 * @param response Raw robot answer.
	 * @returns Whether a mode was published.
	 */
	public async applyDustCollectionModeResponse(response: unknown): Promise<boolean> {
		const mode = parseDustCollectionModeResponse(response);
		if (mode === null) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_DUST_COLLECTION_MODE} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		// Reported even when it is not one of the four the app offers: what the robot says about
		// itself is a fact, and hiding it would make an unexpected mode look like a missing answer.
		if (!isKnownDustCollectionMode(mode)) {
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
				`The robot reports empty mode ${mode}, which the app does not offer. Publishing it unchanged; it cannot be written back.`, "info");
		}

		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${SET_DUST_COLLECTION_MODE}`, {
			val: mode,
			ack: true
		});
		return true;
	}

	/**
	 * Publishes the drying setting and mirrors it into the writable state.
	 * @param response Raw robot answer.
	 * @returns Whether a setting was published.
	 */
	public async applyDryerSettingResponse(response: unknown): Promise<boolean> {
		const setting = parseDryerSettingResponse(response);
		if (!setting) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_DRYER_SETTING} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		if (setting.dryTimeSeconds !== null) this.lastDryTimeSeconds = setting.dryTimeSeconds;

		await this.stateWriter.ensureFolder("deviceStatus");
		await this.stateWriter.ensureAndSetState("deviceStatus.dryer_dry_time", {
			name: this.text("dry_interval_timer_picker_title", "Drying Time"),
			type: "number",
			role: "value",
			unit: "s",
			read: true,
			write: false
		}, setting.dryTimeSeconds);
		await this.stateWriter.ensureAndSetState("deviceStatus.dryer_enabled", {
			name: this.text("dock_kit_setting5", "Auto Drying"),
			type: "boolean",
			role: "indicator",
			read: true,
			write: false
		}, setting.enabled);

		// The selector shows the duration while drying is on and the off position while it is not -
		// exactly the two things the one call can express.
		const selected = setting.enabled === true
			? (setting.dryTimeSeconds ?? DEFAULT_DRY_TIME_SECONDS)
			: DRYER_OFF_VALUE;
		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${SET_DRYER_SETTING}`, {
			val: selected,
			ack: true
		});
		return true;
	}

	/** Creates one read-only number state and writes it, skipping a value the robot did not send. */
	private async publishNumber(path: string, name: string, unit: string, value: number | null): Promise<void> {
		if (value === null) return;
		await this.stateWriter.ensureAndSetValueState(path, { name, type: "number", unit }, value);
	}
}
