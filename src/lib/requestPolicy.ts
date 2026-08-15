/**
 * Central, declarative policy for request handling.
 *
 * Everything that decides "how long do we wait" or "how often do we ask" lives here so the
 * values can be reviewed in one place instead of being scattered across the request path.
 *
 * Four concerns:
 *  1. {@link getRequestTimeoutMs}   — method dependent RPC timeouts.
 *  2. {@link getRetryDelayMs}       — exponential backoff with jitter after a failed attempt.
 *  3. {@link getPollIntervalSeconds} — adaptive polling cadence per device.
 *  4. {@link getLiveMapIntervalSeconds} / {@link getLiveTrackIntervalSeconds} — the two live
 *     cadences, kept apart on purpose: the map is an expensive cloud transfer, the position is a
 *     cheap local read, and one must never be paced by the other.
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

	// --- schedule writes -------------------------------------------------------------
	// Counterpart of get_timer: enables/disables an existing timer. It is a small config
	// write, so it gets the same budget as the set_* commands rather than the read tier.
	upd_timer: 15_000,

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
	/** Default cadence while the robot is actively cleaning / moving; overridable per call. */
	activeIntervalSeconds: 5,
	/** Lower bound while the adapter is still starting up or a map/large payload is loading. */
	startupIntervalSeconds: 30,
	/** First delay after a failed poll. */
	errorBaseSeconds: 30,
	/** Multiplier per further consecutive failure. */
	errorFactor: 2,
	/** Default cap for the error backoff; overridable per call. */
	errorMaxSeconds: 300
});

/**
 * Bounds for the user configurable active cadence (`activePollInterval` in the admin UI).
 *
 * The lower bound is deliberately below {@link POLL_POLICY.minIntervalSeconds}: that constant is
 * the floor for cadences the adapter derives on its own, while an explicitly configured active
 * cadence is a conscious user decision and must not be silently slowed down.
 */
export const MIN_ACTIVE_POLL_INTERVAL_SECONDS = 2;
/** Upper bound for the configurable active cadence. */
export const MAX_ACTIVE_POLL_INTERVAL_SECONDS = 60;

/** Bounds for the user configurable error backoff cap (`pollBackoffMaxInterval`). */
export const MIN_POLL_BACKOFF_MAX_SECONDS = 30;
/** Upper bound for the configurable error backoff cap. */
export const MAX_POLL_BACKOFF_MAX_SECONDS = 900;

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
	return Math.min(max, Math.max(min, Math.round(numeric)));
}

/** Normalises the configured active cadence; falls back to the policy default. */
export function resolveActiveIntervalSeconds(configured?: number): number {
	return clampInteger(
		configured,
		MIN_ACTIVE_POLL_INTERVAL_SECONDS,
		MAX_ACTIVE_POLL_INTERVAL_SECONDS,
		POLL_POLICY.activeIntervalSeconds
	);
}

/** Normalises the configured error backoff cap; falls back to the policy default. */
export function resolveBackoffMaxSeconds(configured?: number): number {
	return clampInteger(
		configured,
		MIN_POLL_BACKOFF_MAX_SECONDS,
		MAX_POLL_BACKOFF_MAX_SECONDS,
		POLL_POLICY.errorMaxSeconds
	);
}

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
	/**
	 * Configured cadence while the robot is working (`activePollInterval`, seconds).
	 * Omitted or out of range -> {@link POLL_POLICY.activeIntervalSeconds}.
	 */
	activeIntervalSeconds?: number;
	/**
	 * Configured cap for the error backoff (`pollBackoffMaxInterval`, seconds).
	 * Omitted or out of range -> {@link POLL_POLICY.errorMaxSeconds}.
	 */
	errorMaxSeconds?: number;
};

/**
 * Resolves how often a single device should be polled.
 *
 * Order of precedence:
 *  1. consecutive errors  -> exponential backoff, never faster than the configured base
 *  2. startup / loading   -> never faster than `startupIntervalSeconds`
 *  3. active              -> configured fast cadence, but never below the effective floor
 *  4. idle                -> the configured base interval
 */
export function getPollIntervalSeconds(context: PollContext): number {
	const base = Number.isFinite(context.baseIntervalSeconds) && context.baseIntervalSeconds > 0
		? context.baseIntervalSeconds
		: 60;

	const errors = Math.max(0, Math.floor(context.consecutiveErrors ?? 0));
	if (errors > 0) {
		const backoff = Math.min(
			resolveBackoffMaxSeconds(context.errorMaxSeconds),
			POLL_POLICY.errorBaseSeconds * Math.pow(POLL_POLICY.errorFactor, errors - 1)
		);
		return Math.max(base, backoff);
	}

	if (context.isStartingUp) {
		return Math.max(base, POLL_POLICY.startupIntervalSeconds);
	}

	if (context.isActive) {
		const active = resolveActiveIntervalSeconds(context.activeIntervalSeconds);
		// The generic floor must never override a deliberately configured faster cadence,
		// otherwise a user setting of 2 s would silently stay at the 5 s default.
		const floor = Math.min(POLL_POLICY.minIntervalSeconds, active);
		return Math.max(floor, Math.min(base, active));
	}

	return Math.max(POLL_POLICY.minIntervalSeconds, base);
}

/**
 * Cadence of the live map update (`liveMapInterval` in the admin UI).
 *
 * The app checks for map changes every 1.2 s while the robot works and every 2 s while it stands
 * still (report section 15, §1.3). Those numbers are what a phone on the same Wi-Fi does with a
 * screen in front of it; an adapter that runs around the clock is a different case, so the
 * default here is deliberately slower and the whole thing can be switched off.
 */
export const LIVE_MAP_POLICY = Object.freeze({
	/** Cadence (seconds) of the change check while the robot is working. */
	activeIntervalSeconds: 3,
	/**
	 * Factor applied while the robot is idle or paused. The app slows from 1.2 s to 2 s in that
	 * situation; 2x keeps the same direction with one constant instead of two.
	 */
	idleFactor: 2,
	/**
	 * Floor (seconds) for a robot that cannot do incremental maps.
	 *
	 * Such a robot has no diff to ask for, so every check is a complete map transfer. The app
	 * pulls one every second in that case; the adapter must not, so the configured cadence is
	 * slowed to at least this value and suspended entirely while the robot is idle. Fidelity
	 * loses against load here on purpose.
	 */
	fullMapFloorSeconds: 5
});

/** Value of `liveMapInterval` that switches the live map update off entirely. */
export const LIVE_MAP_DISABLED = 0;
/** Fastest configurable live map cadence. */
export const MIN_LIVE_MAP_INTERVAL_SECONDS = 1;
/** Slowest configurable live map cadence. Beyond this the normal poll is the better tool. */
export const MAX_LIVE_MAP_INTERVAL_SECONDS = 30;

/**
 * Normalises the configured live map cadence.
 *
 * @param configured Raw `liveMapInterval` from the instance config.
 * @returns The cadence in seconds, or {@link LIVE_MAP_DISABLED} when the feature is off. An
 *          explicit 0 means off; anything unreadable falls back to the policy default rather
 *          than silently disabling a feature the user did not switch off.
 */
export function resolveLiveMapIntervalSeconds(configured?: number): number {
	const numeric = typeof configured === "number" ? configured : Number(configured);
	if (Number.isFinite(numeric) && numeric <= 0) return LIVE_MAP_DISABLED;
	return clampInteger(
		configured,
		MIN_LIVE_MAP_INTERVAL_SECONDS,
		MAX_LIVE_MAP_INTERVAL_SECONDS,
		LIVE_MAP_POLICY.activeIntervalSeconds
	);
}

/** Inputs that drive the live map cadence for one device. */
export type LiveMapContext = {
	/** Configured `liveMapInterval` (seconds); 0 switches the feature off. */
	configuredSeconds?: number;
	/** Robot is cleaning, returning, washing, mapping, ... */
	isActive: boolean;
	/** Robot announced the incremental map feature bit and its map carries a nonce. */
	supportsIncrementalMap: boolean;
};

/**
 * Resolves how often the live map check may run for one device.
 *
 * @param context See {@link LiveMapContext}.
 * @returns The cadence in seconds, or {@link LIVE_MAP_DISABLED} when nothing should run.
 */
export function getLiveMapIntervalSeconds(context: LiveMapContext): number {
	const configured = resolveLiveMapIntervalSeconds(context.configuredSeconds);
	if (configured === LIVE_MAP_DISABLED) return LIVE_MAP_DISABLED;

	// Without the diff there is nothing cheap to ask for: every check is a whole map transfer.
	// That is worth doing while the robot draws on the map, and pure waste while it sits on the
	// dock — where the adapter fetched nothing at all before this feature existed.
	if (!context.supportsIncrementalMap) {
		if (!context.isActive) return LIVE_MAP_DISABLED;
		return Math.max(configured, LIVE_MAP_POLICY.fullMapFloorSeconds);
	}

	return context.isActive ? configured : configured * LIVE_MAP_POLICY.idleFactor;
}

/**
 * Cadence of the live position channel (`liveTrackInterval` in the admin UI).
 *
 * This is a different question from {@link LIVE_MAP_POLICY} and therefore has its own numbers. The
 * map is a 7 KiB transfer that arrives over the cloud in 248 ms; the dynamic channel is two local
 * requests of 712 B and 309 B that answer in 58 ms and 57 ms (all four medians measured at the test
 * device, `PROJECT_STATE.md` section "Live-Karte: `get_dynamic_data` ist der schnelle Weg"). Tying
 * the cheap question to the expensive one is what made the position lag; these constants exist so
 * it cannot happen again.
 *
 * Both values are derived from measurements at the driving robot, not from the app:
 *
 *  - **1 s while working.** The driven track grows by about one point per second (`PATH` gained
 *    24-28 bytes per 6.3 s, `_appanalysis/fahrt.log`), so 1 Hz is the fastest cadence at which every
 *    single cycle still returns something new - asking faster would repeat the same track. The
 *    position does move continuously, measured at up to 216 mm/s, so this is also what bounds how
 *    far the drawn robot can be from the real one: about one robot radius instead of the 1.3 m a
 *    6 s cadence produces.
 *  - **2 s while idle.** A standing robot appends no path points and does not move, so a faster
 *    cadence provably cannot deliver anything. What the idle cadence really bounds is how long the
 *    *start* of a movement can stay invisible if the status poll has not classified the robot as
 *    working yet, and 2 s is the value the app itself uses in that situation (report section 15,
 *    §1.3).
 */
export const LIVE_TRACK_POLICY = Object.freeze({
	/** Cadence (seconds) of the position/track fetch while the robot is working. */
	activeIntervalSeconds: 1,
	/** Factor applied while the robot is idle or paused, giving the app's 2 s. */
	idleFactor: 2,
	/**
	 * Period (ms) of the ticker the live track rides on.
	 *
	 * It has to be shorter than the fastest configurable cadence, otherwise a 1 s cadence checked by
	 * a 1 s ticker degrades to 2 s: the slot falls due a few milliseconds after the tick that could
	 * have served it, so every second tick is wasted. Half the minimum cadence keeps the error below
	 * {@link LIVE_TRACK_TICK_MS} without polling the bookkeeping pointlessly often - the tick itself
	 * only compares two numbers per device when nothing is due.
	 */
	tickMs: 500
});

/** Period (ms) of the live track ticker; see {@link LIVE_TRACK_POLICY.tickMs}. */
export const LIVE_TRACK_TICK_MS = LIVE_TRACK_POLICY.tickMs;

/** Value of `liveTrackInterval` that switches the live position channel off entirely. */
export const LIVE_TRACK_DISABLED = 0;
/** Fastest configurable live track cadence; see {@link LIVE_TRACK_POLICY} for why it is not lower. */
export const MIN_LIVE_TRACK_INTERVAL_SECONDS = 1;
/** Slowest configurable live track cadence. */
export const MAX_LIVE_TRACK_INTERVAL_SECONDS = 30;

/**
 * Normalises the configured live track cadence.
 *
 * @param configured Raw `liveTrackInterval` from the instance config.
 * @returns The cadence in seconds, or {@link LIVE_TRACK_DISABLED} when the channel is off. An
 *          explicit 0 means off; anything unreadable falls back to the policy default rather than
 *          silently disabling a feature the user did not switch off.
 */
export function resolveLiveTrackIntervalSeconds(configured?: number): number {
	const numeric = typeof configured === "number" ? configured : Number(configured);
	if (Number.isFinite(numeric) && numeric <= 0) return LIVE_TRACK_DISABLED;
	return clampInteger(
		configured,
		MIN_LIVE_TRACK_INTERVAL_SECONDS,
		MAX_LIVE_TRACK_INTERVAL_SECONDS,
		LIVE_TRACK_POLICY.activeIntervalSeconds
	);
}

/** Inputs that drive the live track cadence for one device. */
export type LiveTrackContext = {
	/** Configured `liveTrackInterval` (seconds); 0 switches the channel off. */
	configuredSeconds?: number;
	/** Robot is cleaning, returning, washing, mapping, ... */
	isActive: boolean;
};

/**
 * Resolves how often the live position channel may be read for one device.
 *
 * Deliberately independent of {@link getLiveMapIntervalSeconds}: there is no
 * `supportsIncrementalMap` term here, because the two requests behind this cadence
 * (`get_dynamic_map_diff` and `get_dynamic_data`) are the same for every robot that answers them.
 * A robot that does not is switched off individually by the poller after a few failures, which is
 * a per-device fact and not something a cadence should encode.
 *
 * @param context See {@link LiveTrackContext}.
 * @returns The cadence in seconds, or {@link LIVE_TRACK_DISABLED} when nothing should run.
 */
export function getLiveTrackIntervalSeconds(context: LiveTrackContext): number {
	const configured = resolveLiveTrackIntervalSeconds(context.configuredSeconds);
	if (configured === LIVE_TRACK_DISABLED) return LIVE_TRACK_DISABLED;

	return context.isActive ? configured : configured * LIVE_TRACK_POLICY.idleFactor;
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
