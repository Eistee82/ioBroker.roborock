import type { FeatureDependencies } from "../baseDeviceFeatures";

/**
 * The robot's speaking volume, and the sound it plays to demonstrate it.
 *
 * ## Where every value here comes from
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `getSoundVolume` | `Methods.GetSoundVolume` = `get_sound_volume` | `new Array(0)`, i.e. `[]` | A65:229042-229057 |
 * | `setSoundVolume(a0)` | `Methods.SetSoundVolume` = `change_sound_volume` | `new Array(1)` with `a0`, i.e. `[value]` | A65:230787-230804 |
 * | `testSoundVolume` | `Methods.TestSoundVolume` = `test_sound_volume` | `[]` | A65:231437-231452 |
 *
 * The value is an **integer**, not a fraction: every caller runs it through
 * `parseInt(value.toFixed(0))` before handing it over (A65:862901-862906, A65:930526-930531).
 *
 * ## The range is 0 to 100, and the slider is narrower than that
 *
 * Two different limits live in the app, and only one of them is a limit on the *command*.
 *
 * The **slider** runs from `DM.volumes.min` to `DM.volumes.max` in steps of 5 (A65:863941-863949).
 * Those two numbers are a property of the device model: the app knows six windows - `Default`
 * 30-90, `Type1` 30-100, `Type2` 50-90, `Type3` 20-90, `Type4` 5-90, `Type5` 10-100
 * (A65:216992-217005) - and falls back to `Default` for any model that declares none
 * (A65:217259-217272). The test device declares none, so its slider is 30 to 90; it reported 90.
 *
 * The **command** is bounded more widely. The app's numeric-input path validates
 * `value >= 0 && value <= 100` and sends anything inside that (A65:782569-782578) - the same
 * `setSoundVolume` wrapper, so the same RPC. That is the only place in the plugin where the range
 * of the *call* is stated rather than the range of a widget, and it is what this module offers.
 *
 * **Deliberately not ported: the model table.** Binding the range to a model name is exactly the
 * criterion this project keeps removing, and thirty-odd model ids would have to be mapped to
 * product names one by one to do it. The wider, proven bound is offered instead, and what happens
 * outside a robot's own comfort window is left to the robot - which answers, so a refusal is
 * visible on the command state.
 */

/** RPC that reads the volume; also the capability probe for the two below. */
export const GET_SOUND_VOLUME = "get_sound_volume";

/** RPC that sets the volume. Note the name: it is not `set_*`. */
export const CHANGE_SOUND_VOLUME = "change_sound_volume";

/** RPC that makes the robot say something at the current volume. */
export const TEST_SOUND_VOLUME = "test_sound_volume";

/** Lowest value the app is willing to send (A65:782569-782578). */
export const SOUND_VOLUME_MIN = 0;

/** Highest value the app is willing to send (A65:782573-782578). */
export const SOUND_VOLUME_MAX = 100;

/**
 * Reads the answer of `get_sound_volume`, which arrives as `[90]`.
 *
 * The array is required rather than unwrapped away, for the reason `parseTimezoneResponse` states:
 * a bare value is how the robot says it does not know a method. Accepting a loose number would turn
 * nothing into a volume, and this one is written back onto a writable state.
 *
 * @param response Raw robot answer.
 * @returns The volume, or null when the answer carries none.
 */
export function parseSoundVolumeResponse(response: unknown): number | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	if (!Array.isArray(payload) || payload.length !== 1) return null;

	const volume = Number(payload[0]);
	return Number.isFinite(volume) ? volume : null;
}

/**
 * Turns a written value into the integer the robot is sent.
 *
 * @param value Raw value written into the state.
 * @returns The integer to send.
 * @throws When the value is not a number, or outside the range the app itself enforces.
 */
export function toSoundVolume(value: unknown): number {
	const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "")
		? Number(value)
		: Number.NaN;

	if (!Number.isFinite(numeric)) {
		throw new Error(`${CHANGE_SOUND_VOLUME} needs a number; received ${JSON.stringify(value)}`);
	}

	// Rounded rather than refused: the app rounds too (`parseInt(value.toFixed(0))`), and a slider
	// that hands over 71.4 is a caller doing nothing wrong.
	const rounded = Math.round(numeric);
	if (rounded < SOUND_VOLUME_MIN || rounded > SOUND_VOLUME_MAX) {
		throw new Error(`${CHANGE_SOUND_VOLUME} accepts ${SOUND_VOLUME_MIN} to ${SOUND_VOLUME_MAX}; received ${JSON.stringify(value)}`);
	}
	return rounded;
}

/**
 * Publishes the volume and drives it.
 *
 * Owns its state names and its payloads; the feature class only routes to it. Holds no timer and no
 * subscription, so there is nothing for `onUnload` to clean up.
 */
export class V1SoundVolumeService {
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
	 * Registers the volume, its read button and the sound test.
	 *
	 * The test sits in `commands` rather than in `settings`: it is not a setting but a one-off
	 * action, and it is the only thing here that makes the robot do something audible.
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const label = this.text("setting_robot_volume", "Volume");

		addCommand(CHANGE_SOUND_VOLUME, {
			type: "number",
			role: "level.volume",
			name: label,
			desc: "The app's own slider is narrower and depends on the model - 30 to 90 on the test device. This is the range the app validates before sending.",
			min: SOUND_VOLUME_MIN,
			max: SOUND_VOLUME_MAX,
			unit: "%",
			def: SOUND_VOLUME_MIN,
			write: true
		}, "settings");

		addCommand(TEST_SOUND_VOLUME, {
			type: "boolean",
			role: "button",
			name: this.text("localization_strings_Setting_index_19", "Playing voice alert"),
			desc: "Makes the robot speak once at the volume it currently holds.",
			def: false
		});

		addCommand(GET_SOUND_VOLUME, {
			type: "boolean",
			role: "button",
			name: `Read ${label}`,
			def: false
		}, "queries");

		this.claimed.add(CHANGE_SOUND_VOLUME).add(TEST_SOUND_VOLUME).add(GET_SOUND_VOLUME);
	}

	/**
	 * Builds the parameters of one of the three methods.
	 *
	 * @param method Method as registered.
	 * @param value Raw value written into the state; only read for the volume itself.
	 * @returns The method and parameters to send.
	 */
	public buildCommandParams(method: string, value: unknown): { method: string; params: unknown } {
		if (method === GET_SOUND_VOLUME || method === TEST_SOUND_VOLUME) return { method, params: [] };
		return { method: CHANGE_SOUND_VOLUME, params: [toSoundVolume(value)] };
	}

	/**
	 * Publishes the volume the robot reports onto the writable state.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether a volume was published.
	 */
	public async applyVolumeResponse(response: unknown): Promise<boolean> {
		const volume = parseSoundVolumeResponse(response);
		if (volume === null) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_SOUND_VOLUME} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${CHANGE_SOUND_VOLUME}`, {
			val: volume,
			ack: true
		});
		return true;
	}
}
