import type { FeatureDependencies } from "../baseDeviceFeatures";
import { toBooleanFlag } from "./v1ProbedCapabilities";

/**
 * Deep carpet cleaning: after a room clean, the robot goes back over each room's carpets.
 *
 * What it does is Roborock's own sentence on the very switch this implements
 * (`setting_carpet_deep_clean_switch_desc`, read at A65:905133):
 *
 * > After Room Cleaning, the robot will separately clean carpets in each room.
 * > *Not including mats.
 *
 * ## The wrapper proves nothing, so the caller had to
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `getCarpetDeepClean` | `app_get_carpet_deep_clean_status` | `{}` | A65:228301-228310 |
 * | `setCarpetDeepClean(a0)` | `app_set_carpet_deep_clean_status` | **`a0` unchanged** | A65:230030-230039 |
 *
 * The setter is the one of its three neighbours that really does hand its argument straight to the
 * transport - `r1 = a0` with no object built around it. So the wrapper says nothing at all about the
 * shape, and this is the case where reading the caller is not diligence but the only evidence there
 * is.
 *
 * The caller settles it (A65:902697-902712), and it builds the object the wrapper does not:
 *
 * ```js
 * this.setState({isCarpetDeepClean: on});
 * setCarpetDeepClean({status: on ? 1 : 0});
 * ```
 *
 * `{status: 0 | 1}`, from the same switch whose label and visibility are read at A65:905126-905156.
 * The getter's measured answer agrees: the test device replies `{status: 0}`
 * (`_appanalysis/geraetefaehigkeiten-1786807834553.json`).
 *
 * ## Why this is bound to the probe and not to the feature bit
 *
 * The app gates the switch on `isCarpetDeepCleanSupported()`, which is bit 3 of the last eight hex
 * characters of `new_feature_info_str` (A65:235883-235906). On the reference robot that field is
 * `0008004056C8FFFE`, so the bit is set - the capability is there, and this is not in doubt.
 *
 * The probe is used anyway, because it is the stronger of the two: the bitfield only arrives with
 * `app_get_init_status`, which runs **after** the commands are registered
 * (`baseDeviceFeatures.initialize` step 1b versus `initializeDeviceData`), while the getter answers
 * at exactly the moment the decision is made. The bit is written down here so that the two can be
 * compared if a robot ever disagrees with itself.
 */

/** RPC that reads the switch; also the capability probe for its setter. */
export const APP_GET_CARPET_DEEP_CLEAN_STATUS = "app_get_carpet_deep_clean_status";

/** RPC that sets the switch. */
export const APP_SET_CARPET_DEEP_CLEAN_STATUS = "app_set_carpet_deep_clean_status";

/**
 * Bit of `new_feature_info_str` the app's `isCarpetDeepCleanSupported()` tests (A65:235904).
 *
 * Not read anywhere in the adapter - see the module comment for why the probe is used instead. Kept
 * as the written-down half of that decision.
 */
export const CARPET_DEEP_CLEAN_BIT = 3n;

/**
 * Reads the answer of `app_get_carpet_deep_clean_status`, which arrives as `{status: 0}`.
 *
 * The app reads the same field as `result.status === 1` (A65:906125-906134). This treats every
 * non-zero value as on, which is a knowing difference in one case that cannot occur: `status` is
 * written by this adapter and by the app as 0 or 1 and by nothing else. It is kept because the six
 * status toggles of `v1ProbedCapabilities.ts` read their identical `{status}` answer exactly this
 * way, and one wire shape read two ways in one adapter is how the two drift apart. Noted rather
 * than silently different, so that a later reader finds the reason instead of a discrepancy.
 *
 * @param response Raw robot answer.
 * @returns Whether deep carpet cleaning is on, or null when the answer carries no `status`.
 */
export function parseCarpetDeepCleanResponse(response: unknown): boolean | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];

	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

	const status = (payload as Record<string, unknown>).status;
	if (status === null || status === undefined || status === "") return null;

	const numeric = Number(status);
	return Number.isFinite(numeric) ? numeric !== 0 : null;
}

/**
 * The payload `app_set_carpet_deep_clean_status` expects, as the app's caller builds it.
 *
 * @param on Whether deep carpet cleaning should run.
 * @returns `{status: 1}` or `{status: 0}`.
 */
export function carpetDeepCleanParams(on: boolean): { status: number } {
	return { status: on ? 1 : 0 };
}

/**
 * Publishes the deep carpet cleaning switch and drives it.
 *
 * Owns its state names and its payloads; the feature class only routes to it. Holds no timer and no
 * subscription, so there is nothing for `onUnload` to clean up.
 */
export class V1CarpetDeepCleanService {
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
	 * Registers the switch and its read button.
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		const title = this.text("setting_carpet_deep_clean_switch_title", "Deep Carpet Cleaning");

		addCommand(APP_SET_CARPET_DEEP_CLEAN_STATUS, {
			type: "boolean",
			role: "switch",
			name: title,
			desc: this.text(
				"setting_carpet_deep_clean_switch_desc",
				"After Room Cleaning, the robot will separately clean carpets in each room. *Not including mats."
			),
			def: false,
			write: true
		}, "settings");

		addCommand(APP_GET_CARPET_DEEP_CLEAN_STATUS, {
			type: "boolean",
			role: "button",
			name: `Read ${title}`,
			def: false
		}, "queries");

		this.claimed.add(APP_SET_CARPET_DEEP_CLEAN_STATUS).add(APP_GET_CARPET_DEEP_CLEAN_STATUS);
	}

	/**
	 * Builds the parameters of one of the two methods.
	 *
	 * @param method Method as registered.
	 * @param value Raw value written into the state; only read for the switch.
	 * @returns The method and parameters to send.
	 */
	public buildCommandParams(method: string, value: unknown): { method: string; params: unknown } {
		// The getter sends `{}`, read off its wrapper at A65:228301-228310.
		if (method === APP_GET_CARPET_DEEP_CLEAN_STATUS) return { method, params: {} };

		// The app's own `on ? 1 : 0`. `toBooleanFlag` is shared with the six status toggles rather
		// than reimplemented, for the reason the off-peak window imports its parser: a second
		// reading of "what counts as off" is how the two drift apart. It is what catches `"false"`
		// and `"0"`, both of which a plain `Boolean()` would read as **on**.
		return { method: APP_SET_CARPET_DEEP_CLEAN_STATUS, params: { status: toBooleanFlag(value) } };
	}

	/**
	 * Publishes the switch position the robot reports onto its writable state.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether a position was published.
	 */
	public async applyResponse(response: unknown): Promise<boolean> {
		const on = parseCarpetDeepCleanResponse(response);
		if (on === null) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${APP_GET_CARPET_DEEP_CLEAN_STATUS} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.settings.${APP_SET_CARPET_DEEP_CLEAN_STATUS}`, {
			val: on,
			ack: true
		});
		return true;
	}
}
