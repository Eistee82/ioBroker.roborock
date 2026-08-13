// src/lib/manualDevices.ts
//
// Cloud-free operation: the user may declare devices manually with duid + localKey.
// The localKey cannot be derived locally (see _appanalysis/03-local-58867.md §5); it only
// exists in the cloud device list. It does however only change when the device is re-paired,
// so once it is known the adapter never needs the cloud again.
//
// The raw configuration value is a JSON string so it can be stored in `encryptedNative`
// (js-controller only encrypts string natives). Never log a localKey.

import { isIP } from "node:net";

/** Protocol versions the adapter can speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["1.0", "A01", "B01", "L01"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Roborock hard-checks the localKey length (16 chars) before building a frame. */
export const LOCAL_KEY_LENGTH = 16;

/** Default model/category used when the user does not supply one for a manual device. */
export const MANUAL_DEFAULT_MODEL = "roborock.vacuum";
export const MANUAL_DEFAULT_CATEGORY = "robot.vacuum.cleaner";

export interface ManualDevice {
	duid: string;
	localKey: string;
	/** Static IP. When set, UDP discovery is not required for this device. */
	ip?: string;
	pv: ProtocolVersion;
	name: string;
	model: string;
	category: string;
	/** Serial number, only needed by some B01 map decryptions. */
	sn?: string;
}

export interface ManualDeviceParseResult {
	devices: ManualDevice[];
	/** Human readable problems. Never contains a localKey. */
	errors: string[];
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return undefined;
}

function normalizeProtocolVersion(raw: string | undefined): ProtocolVersion | null {
	if (!raw) return null;
	const candidate = raw.trim();
	const match = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version.toLowerCase() === candidate.toLowerCase());
	return match ?? null;
}

/**
 * Parses the raw `manualDevices` configuration value.
 * Accepts a JSON string (how it is stored) or an already parsed array (defensive: some
 * js-controller/admin combinations hand arrays through untouched).
 */
export function parseManualDevices(raw: unknown): ManualDeviceParseResult {
	const result: ManualDeviceParseResult = { devices: [], errors: [], warnings: [] };

	let entries: unknown;
	if (raw === undefined || raw === null) return result;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed === "") return result;
		try {
			entries = JSON.parse(trimmed);
		} catch (e: unknown) {
			result.errors.push(`Manual device list is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
			return result;
		}
	} else {
		entries = raw;
	}

	if (!Array.isArray(entries)) {
		result.errors.push("Manual device list must be a JSON array.");
		return result;
	}

	const seen = new Set<string>();
	entries.forEach((entry, index) => {
		const position = `entry #${index + 1}`;
		if (!isRecord(entry)) {
			result.errors.push(`${position}: not an object.`);
			return;
		}

		const duid = readString(entry, "duid");
		if (!duid) {
			result.errors.push(`${position}: "duid" is missing.`);
			return;
		}
		if (seen.has(duid)) {
			result.errors.push(`${position}: duplicate duid ${duid}.`);
			return;
		}

		const localKey = readString(entry, "localKey", "local_key");
		if (!localKey) {
			result.errors.push(`${position} (${duid}): "localKey" is missing.`);
			return;
		}
		if (localKey.length !== LOCAL_KEY_LENGTH) {
			result.warnings.push(`${position} (${duid}): localKey has ${localKey.length} characters, expected ${LOCAL_KEY_LENGTH}. Encryption will most likely fail.`);
		}

		const rawIp = readString(entry, "ip", "address");
		let ip: string | undefined;
		if (rawIp) {
			if (isIP(rawIp) === 0) {
				result.errors.push(`${position} (${duid}): "${rawIp}" is not a valid IP address.`);
			} else {
				ip = rawIp;
			}
		}

		const rawPv = readString(entry, "pv", "protocolVersion", "localPv");
		const pv = normalizeProtocolVersion(rawPv);
		if (rawPv && !pv) {
			result.warnings.push(`${position} (${duid}): unknown protocol version "${rawPv}", falling back to "1.0".`);
		}

		seen.add(duid);
		result.devices.push({
			duid,
			localKey,
			ip,
			pv: pv ?? "1.0",
			name: readString(entry, "name") ?? duid,
			model: readString(entry, "model") ?? MANUAL_DEFAULT_MODEL,
			category: readString(entry, "category") ?? MANUAL_DEFAULT_CATEGORY,
			sn: readString(entry, "sn", "serial"),
		});
	});

	return result;
}

/** True when the adapter must not contact the Roborock cloud at all. */
export function isLocalOnlyMode(config: { connectionMode?: string } | undefined | null): boolean {
	return config?.connectionMode === "local";
}

/**
 * Features that are not available without the Roborock cloud.
 * Wording stays deliberately non-final: whether maps can be served over the local
 * channel as well is not yet measured on a real device.
 */
export const LOCAL_ONLY_LIMITATIONS = [
	"map retrieval currently needs the cloud connection",
	"saved scenes/programs, firmware update info and camera streaming stay unavailable",
	"device names, models and room names must be maintained manually",
];
