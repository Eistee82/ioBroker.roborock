import type { FeatureDependencies } from "../baseDeviceFeatures";
import { DeviceStateWriter } from "../deviceStateWriter";

/**
 * What the robot says about itself: its serial number and its locale block.
 *
 * Read-only from end to end. There is no setter here at all - `set_timezone` and
 * `set_app_timezone` exist in the method table, but writing either was not part of this and neither
 * payload was read.
 *
 * ## Where every value here comes from
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `getSerialNumber` | `Methods.GetSerialNumber` = `get_serial_number` | `new Array(0)`, i.e. `[]` | A65:228984-228999 |
 * | `getLocale` | `Methods.GetRobotLocale` = `app_get_locale` | `[]` | A65:228704-228719 |
 *
 * Both are in the read-only measurement of the test device
 * (`_appanalysis/geraetefaehigkeiten-1786790619395.json`) and both answer:
 *
 * ```
 * get_serial_number  [{"serial_number":"R50EED42502639"}]
 * app_get_locale     [{"name":"custom_A.03.0309_CE","bom":"A.03.0309","location":"de",
 *                      "language":"en","wifiplan":"","timezone":"Europe/Berlin",
 *                      "logserver":"awsde0.fds.api.xiaomi.com","featureset":3}]
 * ```
 *
 * ## Which fields are published, and which are not
 *
 * Five of the eight. `name`, `bom`, `location`, `language` and `timezone` are published; the other
 * three are not, and each for its own reason:
 *
 * - **`logserver`** is a Xiaomi log endpoint. It is infrastructure, it identifies the region twice
 *   over, and it is the kind of value that reads like a setting somebody could change here.
 * - **`wifiplan`** was empty on the only device measured, so nothing about its meaning is known.
 * - **`featureset`** is a bitfield the adapter already reads elsewhere (`lib/featureStr.ts`);
 *   publishing a second, differently-derived copy of it would invite the two to disagree.
 *
 * `bom` is published under its own name rather than as "firmware version", because that is not
 * proven. The test device reports firmware `V02.26.80` **and** `bom: A.03.0309`; the two are
 * different strings for the same robot, and nothing read says which one Roborock calls the firmware
 * version. Naming it would be a guess in a place a user would trust.
 *
 * ## The serial number is not logged
 *
 * It is a per-device identifier, so it is written to its own state and never into a log line - not
 * even at debug. `_appanalysis/18-funktionsluecken.md` §C16 asks for exactly that.
 */

/** RPC that reads the serial number; also the capability probe for this group. */
export const GET_SERIAL_NUMBER = "get_serial_number";

/** RPC that reads the locale block. */
export const APP_GET_LOCALE = "app_get_locale";

/** Folder the two publish into. */
const DEVICE_INFO_FOLDER = "deviceInfo";

/** Unwraps the layers the request layer and the robot put around a result. */
function unwrapEntry(response: unknown): Record<string, unknown> | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	while (Array.isArray(payload) && payload.length === 1) payload = payload[0];

	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	return payload as Record<string, unknown>;
}

/** Reads a non-empty string field, or null. */
function textField(source: Record<string, unknown>, key: string): string | null {
	const value = source[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * Reads the answer of `get_serial_number`.
 * @param response Raw robot answer.
 * @returns The serial number, or null when the answer carries none.
 */
export function parseSerialNumberResponse(response: unknown): string | null {
	const entry = unwrapEntry(response);
	return entry ? textField(entry, "serial_number") : null;
}

/** The fields of `app_get_locale` this module publishes. */
export interface RobotLocale {
	/** Name of the locale/sound package the robot runs, e.g. `custom_A.03.0309_CE`. */
	packageName: string | null;
	/** Roborock's `bom` string; deliberately not called a firmware version, see the module comment. */
	bom: string | null;
	/** Region the robot was set up for, e.g. `de`. */
	location: string | null;
	/** Language of the robot's own voice, e.g. `en`. */
	language: string | null;
	/** Time zone the robot keeps its own clock in. */
	timezone: string | null;
}

/**
 * Reads the answer of `app_get_locale`.
 * @param response Raw robot answer.
 * @returns The five published fields, or null when the answer carries none of them.
 */
export function parseLocaleResponse(response: unknown): RobotLocale | null {
	const entry = unwrapEntry(response);
	if (!entry) return null;

	const locale: RobotLocale = {
		packageName: textField(entry, "name"),
		bom: textField(entry, "bom"),
		location: textField(entry, "location"),
		language: textField(entry, "language"),
		timezone: textField(entry, "timezone")
	};

	const carriesSomething = Object.values(locale).some((value) => value !== null);
	return carriesSomething ? locale : null;
}

/**
 * Publishes what the robot says about itself.
 *
 * Holds no timer and no subscription, so there is nothing for `onUnload` to clean up.
 */
export class V1DeviceIdentityService {
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
	 * Registers the two read buttons.
	 *
	 * Both go into `queries`, because both are reads and neither belongs in a settings panel: there
	 * is nothing to set. The values themselves appear under `deviceInfo`.
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		addCommand(GET_SERIAL_NUMBER, {
			type: "boolean",
			role: "button",
			name: `Read ${this.text("debug_info_serial_number", "Serial Number")}`,
			def: false
		}, "queries");

		addCommand(APP_GET_LOCALE, {
			type: "boolean",
			role: "button",
			name: "Read the robot's region and language",
			def: false
		}, "queries");

		this.claimed.add(GET_SERIAL_NUMBER).add(APP_GET_LOCALE);
	}

	/** Both take an empty array (A65:228990 and A65:228710). */
	public buildCommandParams(method: string): { method: string; params: unknown } {
		return { method, params: [] };
	}

	/**
	 * Publishes the serial number.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether a serial number was published.
	 */
	public async applySerialNumberResponse(response: unknown): Promise<boolean> {
		const serial = parseSerialNumberResponse(response);
		if (serial === null) {
			// The answer is deliberately not quoted here, unlike everywhere else: this is the one
			// reader whose payload is a per-device identifier, and a warning is still a log line.
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${GET_SERIAL_NUMBER} answer.`, "warn");
			return false;
		}

		await this.stateWriter.ensureFolder(DEVICE_INFO_FOLDER);
		await this.stateWriter.ensureAndSetState(`${DEVICE_INFO_FOLDER}.serial_number`, {
			name: this.text("debug_info_serial_number", "Serial Number"),
			type: "string",
			role: "text",
			read: true,
			write: false
		}, serial);
		return true;
	}

	/**
	 * Publishes the locale block.
	 *
	 * @param response Raw robot answer.
	 * @returns Whether anything was published.
	 */
	public async applyLocaleResponse(response: unknown): Promise<boolean> {
		const locale = parseLocaleResponse(response);
		if (!locale) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Unreadable ${APP_GET_LOCALE} answer: ${JSON.stringify(response)}`, "warn");
			return false;
		}

		await this.stateWriter.ensureFolder(DEVICE_INFO_FOLDER);
		await this.publishText("package_name", "Voice package", locale.packageName);
		await this.publishText("bom", "BOM", locale.bom);
		await this.publishText("location", "Region", locale.location);
		await this.publishText("language", "Voice language", locale.language);
		await this.publishText("robot_timezone", this.text("setting_timezone_title", "Robot Time Zone"), locale.timezone);
		return true;
	}

	/** Creates one read-only string state and writes it, skipping a field the robot did not send. */
	private async publishText(name: string, label: string, value: string | null): Promise<void> {
		if (value === null) return;
		await this.stateWriter.ensureAndSetState(`${DEVICE_INFO_FOLDER}.${name}`, {
			name: label,
			type: "string",
			role: "text",
			read: true,
			write: false
		}, value);
	}
}
