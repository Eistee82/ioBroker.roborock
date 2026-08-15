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
 * One on/off setting whose read and write are a matching `get_*`/`set_*` pair around a `status`
 * field.
 *
 * ## Why they share one description
 *
 * These five look identical on the wire and differ only in their name, so anything they had in
 * common would otherwise be copied five times. What they must **not** share is their proof: each
 * line of the table below was read on its own, and two candidates that looked exactly like these
 * were dropped because theirs did not hold up (see the module comment of the table).
 */
export interface StatusToggle {
	/** Reading command; also the capability probe that decides whether the switch exists at all. */
	getter: string;
	/** Writing command. */
	setter: string;
	/** Roborock string key of the label, and what to show when the catalogue has no entry. */
	labelKey: string;
	labelFallback: string;
	/** Roborock string key of the explanation shown as the object's description. */
	descKey: string;
	descFallback: string;
	/**
	 * How this setting looks on the wire. Omitted means {@link STATUS_OBJECT}, which is what six of
	 * the seven use; see {@link ToggleShape} for why the seventh needed a second one.
	 */
	shape?: ToggleShape;
	/** Where the value and the payload were read; goes into the log of a refused write. */
	fundstelle: string;
}

/**
 * The two shapes an on/off setting takes on the wire.
 *
 * There are two and not one because the app really does both, and the difference is not cosmetic -
 * it decides what is sent to a machine. Adding the second one to this table was weighed against
 * giving the odd setting a module of its own, and the table won for the reason the Do Not Disturb
 * window parser was imported rather than copied last round: **two implementations of "read a flag,
 * write a flag" are how the two drift apart.** The cost is one discriminator that six of seven
 * entries never set; the alternative cost was a second copy of the whole read/write path.
 *
 * - `status-object` — `{status: 1|0}` out, `{"status":1}` back. The dock, floor and FlexiArm
 *   settings.
 * - `bare-array` — `[1|0]` out, `[1]` back. The status light, and so far only it.
 */
export type ToggleShape = "status-object" | "bare-array";

/** The shape all but one of the settings use. */
export const STATUS_OBJECT: ToggleShape = "status-object";

/** Reads the shape of a toggle, defaulting to the one most of them have. */
export function toggleShape(toggle: StatusToggle): ToggleShape {
	return toggle.shape ?? STATUS_OBJECT;
}

/**
 * The on/off settings this module offers, and the proof behind each one.
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device. **Every one of
 * these was re-read for this table**, wrapper *and* caller, because a wrapper alone does not prove a
 * payload: three of the five forward their argument unread, and it is the caller that builds the
 * `{status}` object. That is the same trap `app_set_dryer_setting` sat in - it was held back for a
 * while on the belief that it passed its argument through, which turned out to be wrong.
 *
 * | Setting | Wrapper | Where `{status: 1|0}` is built | Read back from |
 * | --- | --- | --- | --- |
 * | Clean along floor direction | A65:230453-230464, builds `{status: a0}` | caller A65:858136-858145, `on ? 1 : 0` | A65:859820-859826, `result.status == 1` |
 * | Auto emptying | A65:230411-230422, builds `{status: a0}` | **two** callers, A65:854949-854958 and A65:908317-908326, both `on ? 1 : 0` | switch state `dustCollectionSwitch` |
 * | Adjusted battery level | A65:230661-230672, builds `{status: a0}` | caller A65:847220-847229, `on ? 1 : 0` | A65:847519-847524, `result.status == 1` |
 * | Extended cleaning (side brush) | A65:230683-230692, **forwards `a0`** | caller A65:858511-858520, builds `{status: on ? 1 : 0}` | switch state `rightBrushStretch` |
 * | Extended mopping (corners) | A65:230217-230226, **forwards `a0`** | caller A65:858600-858609, builds `{status: on ? 1 : 0}` | switch state `cornerStrechSwitch` |
 * | Extended cleaning for crevices | A65:230497-230506, **forwards `a0`** | caller A65:946537-946546, builds `{status: on ? 1 : 0}` | switch state `gapDeepCleanEnabled` |
 *
 * The labels are the keys the app itself reads for these very switches - checked at
 * A65:861343 (floor direction), A65:852465/852471 (battery), A65:861012/861019 (side brush),
 * A65:861055/861062 (corner mopping) and A65:946938/946943 (crevices). Roborock spells two of them
 * twice; the app reads `…_stretch_…`, not the `…_strech_…` variant that also exists in the
 * catalogue, and both title and detail of all five exist in **all eleven** adapter languages.
 *
 * ## Two neighbours that are deliberately absent, and one that moved
 *
 * - **`set_corner_clean_mode`** was listed here as unreachable, on the grounds that there is no
 *   `get_corner_clean_mode` anywhere in the plugin. That part is still true, but the conclusion was
 *   wrong: the app does not use a getter for it either, it reads `corner_clean_mode` out of the
 *   **status packet**. It therefore lives in {@link STATUS_FIELD_TOGGLES} now, with the chain
 *   written out there.
 * - **`set_mop_motor_status`** builds `{status: a0}` (A65:230617-230628) and has **no caller in the
 *   entire plugin** - the argument is never computed anywhere, so whether 1 means on is a guess.
 *   Same shape as `set_airdry_hours` in `_appanalysis/18-funktionsluecken.md` §C18.
 * - **`set_identify_ground_material_status` / `set_identify_furniture_status`** have proven payloads
 *   (`{status: on ? 1 : 0}`, A65:837983-838005), but the app drives **both from one switch**,
 *   `onSceneSwitch`. Publishing them as two independent switches would let a user reach a
 *   combination the app never produces, and nothing read here says the robot handles it sensibly.
 */
export const STATUS_TOGGLES: ReadonlyArray<StatusToggle> = [
	{
		getter: "get_clean_follow_ground_material_status",
		setter: "set_clean_follow_ground_material_status",
		labelKey: "ground_material_clean_direction_title",
		labelFallback: "Clean along floor direction",
		descKey: "ground_material_clean_direction_detail",
		descFallback: "The robot cleans along the direction of the floor to minimise scraping against the floor seams. The direction has to be set per room in the Roborock app; this adapter cannot set it.",
		fundstelle: "A65:230453-230464, A65:858136-858145"
	},
	{
		getter: "get_dust_collection_switch_status",
		setter: "set_dust_collection_switch_status",
		labelKey: "dust_collection_title",
		labelFallback: "Auto Emptying",
		descKey: "dust_collection_info",
		descFallback: "The dock empties the dustbin automatically after a clean.",
		fundstelle: "A65:230411-230422, A65:854949-854958"
	},
	{
		getter: "get_optimize_battery_status",
		setter: "set_optimize_battery_status",
		labelKey: "setting_optimize_batter_title",
		labelFallback: "Adjusted Battery Level",
		descKey: "setting_optimize_batter_detail",
		descFallback: "The battery level is calculated more accurately once this is on.",
		fundstelle: "A65:230661-230672, A65:847220-847229"
	},
	{
		getter: "get_right_brush_stretch_status",
		setter: "set_right_brush_stretch_status",
		labelKey: "setting_ground_right_brush_stretch_title",
		labelFallback: "FlexiArm Design Extended Cleaning",
		descKey: "setting_ground_right_brush_stretch_detail",
		descFallback: "The robot extends the flexible side brush along corners for better cleaning.",
		fundstelle: "A65:230683-230692, A65:858511-858520"
	},
	{
		getter: "get_stretch_tag_status",
		setter: "set_stretch_tag_status",
		labelKey: "setting_ground_corner_stretch_title",
		labelFallback: "FlexiArm Design Extended Mopping",
		descKey: "setting_ground_corner_stretch_detail",
		descFallback: "While mopping along edges and corners the right mop extends closer to the wall.",
		fundstelle: "A65:230217-230226, A65:858600-858609"
	},
	{
		getter: "get_gap_deep_clean_status",
		setter: "set_gap_deep_clean_status",
		labelKey: "setting_gap_deep_clean_title",
		labelFallback: "FlexiArm Design Extended Cleaning for Crevices",
		descKey: "setting_gap_deep_clean_detail",
		descFallback: "The robot identifies crevices below appliances and furniture and extends the flexible side brush into them.",
		fundstelle: "A65:230497-230506, A65:946537-946546"
	},
	{
		// The one entry with the other shape. Both sides read: the wrapper builds `new Array(1)`
		// (A65:230545-230561), the caller computes `on ? 1 : 0` (A65:849705-849712), and the app
		// reads the answer back as `result[0] == 1` (A65:849620-849627). Its getter still takes
		// `[]` like all the others (A65:228688-228703), so only the payload and the answer differ.
		getter: "get_led_status",
		setter: "set_led_status",
		labelKey: "led_status_title",
		labelFallback: "Button Lights",
		descKey: "led_status_detail",
		descFallback: "When this is off, the robot's indicator light goes out a minute after it is fully charged.",
		shape: "bare-array",
		fundstelle: "A65:230545-230561, A65:849705-849712"
	}
];

/** Finds the toggle a command belongs to, by either of its two names. */
export function statusToggleFor(command: string): StatusToggle | undefined {
	return STATUS_TOGGLES.find((toggle) => toggle.setter === command || toggle.getter === command);
}

/**
 * An on/off setting that has **no getter** - the robot carries it in the status packet instead.
 *
 * ## Why this is a second table and not a `StatusToggle` with an empty getter
 *
 * The two differ in the one thing that matters here: **what decides whether the switch exists.**
 * A {@link StatusToggle} asks the robot a `get_*` and takes `unknown_method` for a no. These have
 * nothing to ask, so the question becomes "does the robot mention this field when it reports its
 * status" - a different mechanism, on a different schedule (the status arrives on every poll, the
 * probe runs once), with a different failure mode. Folding them together would mean a `getter`
 * field that must be empty and a probe that must be skipped, i.e. two special cases inside the
 * existing path rather than one small path beside it.
 *
 * It also removes the need for the read-back these otherwise all do: the value is in the packet
 * that arrives anyway, so there is nothing to ask for after a write.
 */
export interface StatusFieldToggle {
	/** Key in the `get_status` answer that both unlocks the switch and carries its position. */
	statusField: string;
	/** Writing command. */
	setter: string;
	/** Roborock string key of the label, and what to show when the catalogue has no entry. */
	labelKey: string;
	labelFallback: string;
	/** Roborock string key of the explanation shown as the object's description. */
	descKey: string;
	descFallback: string;
	/** Where the field, the payload and the label were read; goes into the log of a refused write. */
	fundstelle: string;
}

/**
 * The status-carried on/off settings, and the proof behind each one.
 *
 * ## High-Intensity Corner Mopping
 *
 * This one entry closes a gap that was written up as unclosable. `v1ProbedCapabilities` used to say
 * so in as many words: the payload is the cleanest of any setting - the wrapper computes
 * `{status: a0 ? 1 : 0}` by itself, so not even a caller can get it wrong (A65:230197-230216) - but
 * there is no `get_corner_clean_mode` anywhere in the plugin, so there was no way to ask whether a
 * robot has it, and a switch for everyone was not an option.
 *
 * **There is a way, and the app uses it.** The switch position comes from the status packet:
 *
 * ```
 * status.corner_clean_mode  ->  RSM.cornerCleanOn        A65:223836-223839  (!!value)
 * RSM.cornerCleanOn         ->  component state          A65:251550-251551
 * component state           ->  ToggleSwitch.isOn        A65:249108-249112
 * ```
 *
 * That the object read at A65:223836 really is the status packet is not taken on the name: the same
 * function reads `dss`, `wash_status`, `error_code`, `dock_error_status`, `water_box_mode`,
 * `dock_type`, `auto_dust_collection`, `mop_mode`, `rdt`, `wash_ready` and `clean_percent` from it
 * (A65:223549-223796), all of which the test device really sends.
 *
 * So the field is the capability answer as well. The test device does **not** send it - its status
 * packet has 51 fields and `corner_clean_mode` is not among them, measured twice nearly five hours
 * apart - and independently it does not announce the feature either: bit 31 of
 * `new_feature_info_str` is clear, and that bit is what gates the whole view in the app
 * (`isCornerCleanModeSupported`, A65:236944-236972, read at A65:245600 and A65:251539). **Two
 * unrelated sources agree that this robot does not have it**, which is the strongest evidence in
 * the whole capability round that the field is the right question to ask.
 *
 * The bit is the app's gate and would be the more faithful copy, but it is not usable here: neither
 * feature bitfield reaches the adapter at all (see `lib/featureStr.ts`). The status field is
 * available today, it is what the app reads the *value* from, and on the one robot that can be
 * checked the two agree.
 *
 * ## What the switch does not copy, on purpose
 *
 * The app refuses to switch this **on** while the mopping route is *Fast*, with the toast
 * `cannot_cornerclean_withfastclean_toast` (A65:246775-246778 and A65:246819-246829); switching it
 * off is always allowed. That guard is not reproduced here, because it is a rule about a second
 * setting whose value this module does not own, and enforcing half of it would be worse than
 * naming it. It is in the description instead, in Roborock's own wording.
 *
 * Roborock also calls it a single-use mode (`corner_clean_switch_desc`), so the robot is expected
 * to clear the flag itself after a run. Nothing here fights that: the switch mirrors whatever the
 * next status packet says.
 */
export const STATUS_FIELD_TOGGLES: ReadonlyArray<StatusFieldToggle> = [
	{
		statusField: "corner_clean_mode",
		setter: "set_corner_clean_mode",
		labelKey: "corner_clean_switch_title",
		labelFallback: "High-Intensity Corner Mopping",
		descKey: "corner_clean_switch_desc",
		descFallback: "The robot will complete Deep mode around corners, which is a single-use mode. The Roborock app refuses to switch this on while the mopping route is set to Fast.",
		fundstelle: "A65:230197-230216, A65:223836-223839, A65:246779-246788"
	}
];

/** Finds the status-carried toggle a command or status field belongs to. */
export function statusFieldToggleFor(nameOrField: string): StatusFieldToggle | undefined {
	return STATUS_FIELD_TOGGLES.find((toggle) => toggle.setter === nameOrField || toggle.statusField === nameOrField);
}

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

/**
 * Turns whatever was written into a state into the 1 or 0 the robot expects.
 *
 * Deliberately permissive where ioBroker itself is: `main.ts` already converts a switch write with
 * its own `isTruthy` before this is reached, but a script can call the feature class directly, and
 * the strings `"false"` and `"0"` are what a text field produces. Reading either of those as **on**
 * would switch something on that the user switched off.
 *
 * @param value Raw value.
 * @returns 1 for on, 0 for off.
 */
export function toBooleanFlag(value: unknown): number {
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		if (text === "" || text === "false" || text === "0" || text === "off" || text === "no") return 0;
		return 1;
	}
	if (typeof value === "number") return value === 0 ? 0 : 1;
	return value ? 1 : 0;
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

/**
 * Reads the answer of one of the {@link STATUS_TOGGLES} getters, which arrives as `{"status":0}`.
 *
 * The comparison is against 1 and not "anything truthy", because that is what the app does on both
 * sides it was read on (A65:847523 and A65:859824-859826 both compute `1 == status`). A robot that
 * answered 2 would therefore read as off here, exactly as it would in the app.
 *
 * @param response Raw robot answer.
 * @returns Whether the setting is on, or null when the answer carries no `status`.
 */
export function parseStatusToggleResponse(response: unknown, shape: ToggleShape = STATUS_OBJECT): boolean | null {
	if (shape === "bare-array") {
		// `[1]` or `[0]`. Deliberately **not** unwrapped down to the bare number first: a robot that
		// does not know the method answers with a bare string, and accepting a loose value would
		// turn `unknown_method` into a switch position. The array is what tells the two apart, so it
		// has to be there - the same reasoning `parseTimezoneResponse` is built on.
		let payload: unknown = response;
		if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
			payload = (payload as Record<string, unknown>).data;
		}
		if (!Array.isArray(payload) || payload.length !== 1) return null;
		const value = finiteNumber(payload[0]);
		return value === null ? null : value === 1;
	}

	const payload = unwrapPayload(response);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

	const status = finiteNumber((payload as Record<string, unknown>).status);
	return status === null ? null : status === 1;
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

	/**
	 * Registers one on/off setting and its read button.
	 *
	 * `role: "switch.enable"` is not decoration: `main.ts` sends **both** positions of a boolean only
	 * for a command whose role is in ioBroker's switch family, and treats every other boolean as a
	 * button that fires on `true` and springs back. A switch registered without it could be turned
	 * on and never off - the fault nineteen commands had until the switch/button distinction was
	 * introduced.
	 *
	 * @param toggle Which setting to register.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerStatusToggle(toggle: StatusToggle, addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const label = this.text(toggle.labelKey, toggle.labelFallback);

		addCommand(toggle.setter, {
			type: "boolean",
			role: "switch.enable",
			name: label,
			desc: this.text(toggle.descKey, toggle.descFallback),
			def: false,
			write: true
		}, "settings");

		addCommand(toggle.getter, {
			type: "boolean",
			role: "button",
			name: `Read ${label}`,
			def: false
		}, "queries");

		this.claimed.add(toggle.setter).add(toggle.getter);
	}

	/**
	 * Registers one status-carried on/off setting.
	 *
	 * No read button beside it, unlike {@link registerStatusToggle}: there is nothing to read. The
	 * value arrives with the next status packet whether anyone asks or not, so a button would be a
	 * control that does nothing.
	 *
	 * @param toggle Which setting to register.
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerStatusFieldToggle(toggle: StatusFieldToggle, addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		addCommand(toggle.setter, {
			type: "boolean",
			// Same reasoning as `registerStatusToggle`: without a switch role `main.ts` treats a
			// boolean as a button that only ever fires `true`, and the switch could not be turned off.
			role: "switch.enable",
			name: this.text(toggle.labelKey, toggle.labelFallback),
			desc: this.text(toggle.descKey, toggle.descFallback),
			def: false,
			write: true
		}, "settings");

		this.claimed.add(toggle.setter);
	}

	/**
	 * Publishes the position of one status-carried setting onto its switch.
	 *
	 * @param toggle Which setting the value belongs to.
	 * @param raw Value of the status field, as the robot sent it.
	 */
	public async applyStatusFieldValue(toggle: StatusFieldToggle, raw: unknown): Promise<void> {
		// `!!value` is what the app does (A65:223837-223839), not a comparison against 1 - this is
		// the one place where the two differ, and copying the app is what keeps an unexpected value
		// from reading as "off".
		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${toggle.setter}`, {
			val: Boolean(finiteNumber(raw) ?? raw),
			ack: true
		});
	}

	/**
	 * Publishes the position of one on/off setting.
	 *
	 * Written onto the switch itself rather than into a second read-only state. These five are not
	 * in the status packet of any robot measured so far, so the switch is the only place the value
	 * can live, and a mirror state beside it would only be a second thing to keep in step.
	 *
	 * @param toggle Which setting the answer belongs to.
	 * @param response Raw robot answer.
	 * @returns Whether a position was published.
	 */
	public async applyStatusToggleResponse(toggle: StatusToggle, response: unknown): Promise<boolean> {
		const enabled = parseStatusToggleResponse(response, toggleShape(toggle));
		if (enabled === null) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${toggle.getter} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${toggle.setter}`, {
			val: enabled,
			ack: true
		});
		return true;
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
		const toggle = statusToggleFor(method);
		if (toggle) {
			// Every getter here takes `new Array(0)`, whatever shape its answer has - checked for
			// all seven, the status light included (A65:228688-228703).
			if (method === toggle.getter) return { method, params: [] };

			const flag = toBooleanFlag(value);
			return toggleShape(toggle) === "bare-array"
				? { method, params: [flag] }
				: { method, params: { status: flag } };
		}

		// The status-carried settings have no getter, so there is only the one direction to build.
		// The wrapper of `set_corner_clean_mode` composes the object itself (A65:230201-230212); the
		// same shape is sent here, because what goes on the wire is the wrapper's output, not its
		// argument.
		const fieldToggle = statusFieldToggleFor(method);
		if (fieldToggle) return { method, params: { status: toBooleanFlag(value) } };

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
