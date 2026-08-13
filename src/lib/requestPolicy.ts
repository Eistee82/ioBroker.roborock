/**
 * Central, declarative policy for request handling.
 *
 * Everything that decides "how long do we wait" or "how often do we ask" lives here so the
 * values can be reviewed in one place instead of being scattered across the request path.
 *
 * Three concerns:
 *  1. {@link getRequestTimeoutMs}   — method dependent RPC timeouts.
 *  2. {@link getRetryDelayMs}       — exponential backoff with jitter after a failed attempt.
 *  3. {@link getPollIntervalSeconds} — adaptive polling cadence per device.
 */

/** Fallback timeout for methods that are not listed in {@link METHOD_TIMEOUTS_MS}. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Lower bound for any timeout, protects against a nonsensical caller override. */
export const MIN_REQUEST_TIMEOUT_MS = 1_000;

/** Upper bound for any timeout, keeps a stuck request from blocking a queue slot forever. */
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Timeout per RPC method in milliseconds.
 *
 * Rationale for the tiers:
 *  - 5 s  cheap status reads. They are polled constantly, so they must fail fast; a dead
 *         channel is then noticed within one poll cycle instead of after 10 s per request.
 *  - 8 s  small one-shot reads that are not on the hot polling path.
 *  - 15 s list/history reads, the cloud assembles them server side.
 *  - 20 s commands that make the robot move. The firmware acknowledges only after it has
 *         spun up, docked off, or resolved the segment list.
 *  - 25-60 s binary transfers (map, photo). These arrive chunked and are the slowest thing
 *         the adapter does.
 */
export const METHOD_TIMEOUTS_MS: Readonly<Record<string, number>> = Object.freeze({
	// --- hot polling path: fail fast -------------------------------------------------
	get_status: 5_000,
	get_prop: 5_000,
	"prop.get": 5_000,
	"service.get_net_info": 5_000,
	get_network_info: 5_000,

	// --- cheap one-shot reads --------------------------------------------------------
	get_consumable: 8_000,
	get_timer: 8_000,
	get_server_timer: 8_000,
	get_dnd_timer: 8_000,
	get_carpet_mode: 8_000,
	get_carpet_clean_mode: 8_000,
	get_customize_clean_mode: 8_000,
	get_serial_number: 8_000,
	get_fw_features: 8_000,
	get_sound_progress: 8_000,
	get_child_lock_status: 8_000,
	get_flow_led_status: 8_000,
	get_water_box_custom_mode: 8_000,

	// --- list / history reads --------------------------------------------------------
	get_clean_summary: 15_000,
	get_clean_record: 15_000,
	get_multi_maps_list: 15_000,
	get_room_mapping: 15_000,
	"service.get_record_list": 15_000,

	// --- movement / cleaning commands ------------------------------------------------
	app_start: 20_000,
	app_start_wash: 20_000,
	app_stop_wash: 20_000,
	app_segment_clean: 20_000,
	app_zoned_clean: 20_000,
	app_spot: 20_000,
	app_goto_target: 20_000,
	app_charge: 20_000,
	app_pause: 15_000,
	app_stop: 15_000,
	resume_segment_clean: 20_000,
	resume_zoned_clean: 20_000,
	set_led_status: 15_000,
	// Generic default; the floor-switch flow in main.ts overrides this with 60 s because it
	// waits for the full map reload. That override used to be swallowed by the old "map" rule.
	load_multi_map: 20_000,

	// --- binary transfers ------------------------------------------------------------
	get_map_v1: 25_000,
	"service.upload_by_maptype": 25_000,
	get_clean_record_map: 30_000,
	"service.upload_record_by_url": 30_000,
	get_photo: 30_000
});

/**
 * Fallback rules applied when a method has no entry in {@link METHOD_TIMEOUTS_MS}.
 * Evaluated top to bottom, first match wins.
 */
const METHOD_TIMEOUT_PATTERNS: ReadonlyArray<{ readonly test: (method: string) => boolean; readonly timeoutMs: number }> = Object.freeze([
	{ test: (m: string): boolean => m.includes("map"), timeoutMs: 25_000 },
	{ test: (m: string): boolean => m.includes("photo"), timeoutMs: 30_000 },
	{ test: (m: string): boolean => m.includes("record"), timeoutMs: 20_000 },
	{ test: (m: string): boolean => m.includes("room") || m.includes("segment") || m.includes("zone"), timeoutMs: 20_000 },
	{ test: (m: string): boolean => m.startsWith("app_"), timeoutMs: 20_000 },
	{ test: (m: string): boolean => m.startsWith("set_"), timeoutMs: 15_000 },
	{ test: (m: string): boolean => m.startsWith("get_") || m.startsWith("service.get") || m.endsWith(".get"), timeoutMs: 10_000 }
]);

function clampTimeout(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs)) return DEFAULT_REQUEST_TIMEOUT_MS;
	return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.round(timeoutMs)));
}

/**
 * Resolves the timeout for a single RPC.
 *
 * Precedence: explicit caller override > exact method entry > pattern rule > default.
 * An explicit override always wins — the previous implementation silently replaced it for
 * every method containing "map", which made `load_multi_map` time out far too early.
 */
export function getRequestTimeoutMs(method: string, overrideMs?: number): number {
	if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs > 0) {
		return clampTimeout(overrideMs);
	}

	const exact = METHOD_TIMEOUTS_MS[method];
	if (typeof exact === "number") return clampTimeout(exact);

	const normalized = method.toLowerCase();
	for (const rule of METHOD_TIMEOUT_PATTERNS) {
		if (rule.test(normalized)) return clampTimeout(rule.timeoutMs);
	}

	return DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Retry/backoff parameters for {@link getRetryDelayMs}. */
export const RETRY_POLICY = Object.freeze({
	/** Additional attempts after the first one. Total attempts = 1 + maxRetries. */
	maxRetries: 2,
	/** Delay before the first retry. */
	baseDelayMs: 1_000,
	/** Multiplier per further retry. */
	factor: 2,
	/** Hard cap so a long retry chain never stalls a queue slot for minutes. */
	maxDelayMs: 15_000,
	/** +/- share of the computed delay added as jitter, avoids thundering herds after an outage. */
	jitterRatio: 0.25
});

/**
 * Exponential backoff with symmetric jitter.
 *
 * @param retryCount zero based index of the retry that is about to be scheduled
 *                   (0 = first retry, so the delay is `baseDelayMs`).
 * @param random     injectable RNG so tests can be deterministic.
 */
export function getRetryDelayMs(retryCount: number, random: () => number = Math.random): number {
	const safeCount = Math.max(0, Math.floor(retryCount));
	const raw = RETRY_POLICY.baseDelayMs * Math.pow(RETRY_POLICY.factor, safeCount);
	const capped = Math.min(RETRY_POLICY.maxDelayMs, raw);
	// random() in [0,1) -> jitter factor in [1 - jitterRatio, 1 + jitterRatio)
	const jitterFactor = 1 + (random() * 2 - 1) * RETRY_POLICY.jitterRatio;
	return Math.max(0, Math.round(capped * jitterFactor));
}

/** Adaptive polling parameters for {@link getPollIntervalSeconds}. */
export const POLL_POLICY = Object.freeze({
	/** Never poll a device faster than this, whatever the other rules compute. */
	minIntervalSeconds: 5,
	/** Cadence while the robot is actively cleaning / moving. */
	activeIntervalSeconds: 5,
	/** Lower bound while the adapter is still starting up or a map/large payload is loading. */
	startupIntervalSeconds: 30,
	/** First delay after a failed poll. */
	errorBaseSeconds: 30,
	/** Multiplier per further consecutive failure. */
	errorFactor: 2,
	/** Cap for the error backoff. */
	errorMaxSeconds: 300
});

/** Inputs that drive the adaptive polling cadence for one device. */
export type PollContext = {
	/** Configured `updateInterval` (seconds) from the adapter settings. */
	baseIntervalSeconds: number;
	/** Robot is cleaning, returning, washing, mapping, ... */
	isActive: boolean;
	/** Adapter is still initialising, or a heavy transfer for this device is in flight. */
	isStartingUp?: boolean;
	/** Number of consecutive failed poll cycles for this device. */
	consecutiveErrors?: number;
};

/**
 * Resolves how often a single device should be polled.
 *
 * Order of precedence:
 *  1. consecutive errors  -> exponential backoff, never faster than the configured base
 *  2. startup / loading   -> never faster than `startupIntervalSeconds`
 *  3. active              -> fast cadence, but never below `minIntervalSeconds`
 *  4. idle                -> the configured base interval
 */
export function getPollIntervalSeconds(context: PollContext): number {
	const base = Number.isFinite(context.baseIntervalSeconds) && context.baseIntervalSeconds > 0
		? context.baseIntervalSeconds
		: 60;

	const errors = Math.max(0, Math.floor(context.consecutiveErrors ?? 0));
	if (errors > 0) {
		const backoff = Math.min(
			POLL_POLICY.errorMaxSeconds,
			POLL_POLICY.errorBaseSeconds * Math.pow(POLL_POLICY.errorFactor, errors - 1)
		);
		return Math.max(base, backoff);
	}

	if (context.isStartingUp) {
		return Math.max(base, POLL_POLICY.startupIntervalSeconds);
	}

	if (context.isActive) {
		return Math.max(POLL_POLICY.minIntervalSeconds, Math.min(base, POLL_POLICY.activeIntervalSeconds));
	}

	return Math.max(POLL_POLICY.minIntervalSeconds, base);
}

/** Error code carried by {@link ChannelUnavailableError}. */
export const CHANNEL_UNAVAILABLE_CODE = "CHANNEL_UNAVAILABLE";

/**
 * Thrown when the transport towards a robot is known to be down.
 *
 * Requests rejected with this error never touched the wire, so there is nothing to retry and
 * nothing to wait for — this is what breaks the timeout cascade.
 */
export class ChannelUnavailableError extends Error {
	public readonly code = CHANNEL_UNAVAILABLE_CODE;

	constructor(message: string) {
		super(message);
		this.name = "ChannelUnavailableError";
	}
}

/** Type guard for {@link ChannelUnavailableError}, also matches structurally cloned errors. */
export function isChannelUnavailableError(error: unknown): boolean {
	if (error instanceof ChannelUnavailableError) return true;
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === CHANNEL_UNAVAILABLE_CODE;
}
