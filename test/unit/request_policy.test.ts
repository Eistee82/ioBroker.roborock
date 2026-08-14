import { describe, expect, it } from "vitest";
import {
	ChannelUnavailableError,
	DEFAULT_REQUEST_TIMEOUT_MS,
	MAX_REQUEST_TIMEOUT_MS,
	METHOD_TIMEOUTS_MS,
	MIN_REQUEST_TIMEOUT_MS,
	MAX_ACTIVE_POLL_INTERVAL_SECONDS,
	MAX_POLL_BACKOFF_MAX_SECONDS,
	MIN_ACTIVE_POLL_INTERVAL_SECONDS,
	MIN_POLL_BACKOFF_MAX_SECONDS,
	POLL_POLICY,
	RETRY_POLICY,
	getPollIntervalSeconds,
	getRequestTimeoutMs,
	getRetryDelayMs,
	isChannelUnavailableError,
	resolveActiveIntervalSeconds,
	resolveBackoffMaxSeconds
} from "../../src/lib/requestPolicy";

describe("requestPolicy: method dependent timeouts", () => {
	it("lets cheap status polls fail fast and gives binary transfers much more time", () => {
		// The whole point of the table: get_status must not block a queue slot for 10s.
		expect(getRequestTimeoutMs("get_status")).toBe(5000);
		expect(getRequestTimeoutMs("get_prop")).toBe(5000);
		expect(getRequestTimeoutMs("prop.get")).toBe(5000);

		expect(getRequestTimeoutMs("get_map_v1")).toBe(25000);
		expect(getRequestTimeoutMs("get_clean_record_map")).toBe(30000);
		expect(getRequestTimeoutMs("get_photo")).toBe(30000);

		// A cleaning start needs the robot to spin up before it acknowledges.
		expect(getRequestTimeoutMs("app_start")).toBe(20000);
		expect(getRequestTimeoutMs("app_segment_clean")).toBe(20000);

		expect(getRequestTimeoutMs("get_status")).toBeLessThan(getRequestTimeoutMs("app_start"));
		expect(getRequestTimeoutMs("app_start")).toBeLessThan(getRequestTimeoutMs("get_photo"));
	});

	it("falls back to pattern rules for unlisted methods and to the default for everything else", () => {
		expect(getRequestTimeoutMs("get_some_new_map_thing")).toBe(25000);
		expect(getRequestTimeoutMs("app_do_something_new")).toBe(20000);
		expect(getRequestTimeoutMs("set_something_new")).toBe(15000);
		expect(getRequestTimeoutMs("totally_unknown_method")).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
	});

	it("honours an explicit override, which the previous map/room rule silently discarded", () => {
		// Regression guard: load_multi_map contains "map"; the old code forced 20000 and threw
		// away the 60000 the floor switch flow in main.ts asks for.
		expect(getRequestTimeoutMs("load_multi_map")).toBe(20000);
		expect(getRequestTimeoutMs("load_multi_map", 60000)).toBe(60000);
		expect(getRequestTimeoutMs("get_map_v1", 45000)).toBe(45000);
	});

	it("clamps nonsensical overrides instead of trusting them", () => {
		expect(getRequestTimeoutMs("get_status", 10)).toBe(MIN_REQUEST_TIMEOUT_MS);
		expect(getRequestTimeoutMs("get_status", 10 * 60 * 1000)).toBe(MAX_REQUEST_TIMEOUT_MS);
		expect(getRequestTimeoutMs("get_status", 0)).toBe(5000);
		expect(getRequestTimeoutMs("get_status", Number.NaN)).toBe(5000);
	});

	it("keeps every declared timeout inside the allowed bounds", () => {
		for (const [method, timeout] of Object.entries(METHOD_TIMEOUTS_MS)) {
			expect(timeout, method).toBeGreaterThanOrEqual(MIN_REQUEST_TIMEOUT_MS);
			expect(timeout, method).toBeLessThanOrEqual(MAX_REQUEST_TIMEOUT_MS);
		}
	});
});

describe("requestPolicy: retry backoff", () => {
	it("grows exponentially instead of retrying after a flat second", () => {
		const noJitter = (): number => 0.5; // -> jitter factor exactly 1

		expect(getRetryDelayMs(0, noJitter)).toBe(1000);
		expect(getRetryDelayMs(1, noJitter)).toBe(2000);
		expect(getRetryDelayMs(2, noJitter)).toBe(4000);
		expect(getRetryDelayMs(3, noJitter)).toBe(8000);
	});

	it("caps the delay so a retry chain cannot stall a queue slot for minutes", () => {
		const noJitter = (): number => 0.5;
		expect(getRetryDelayMs(10, noJitter)).toBe(RETRY_POLICY.maxDelayMs);
		expect(getRetryDelayMs(50, noJitter)).toBe(RETRY_POLICY.maxDelayMs);
	});

	it("applies symmetric jitter within the configured ratio", () => {
		const min = getRetryDelayMs(1, () => 0);
		const max = getRetryDelayMs(1, () => 0.999999);

		expect(min).toBe(Math.round(2000 * (1 - RETRY_POLICY.jitterRatio)));
		expect(max).toBeLessThanOrEqual(Math.round(2000 * (1 + RETRY_POLICY.jitterRatio)));
		expect(max).toBeGreaterThan(min);
	});

	it("treats negative or fractional retry counts as the first retry", () => {
		const noJitter = (): number => 0.5;
		expect(getRetryDelayMs(-5, noJitter)).toBe(1000);
		expect(getRetryDelayMs(0.7, noJitter)).toBe(1000);
	});
});

describe("requestPolicy: adaptive polling", () => {
	it("polls fast while cleaning and slow while idle", () => {
		const idle = getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: false });
		const active = getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: true });

		expect(idle).toBe(60);
		expect(active).toBe(POLL_POLICY.activeIntervalSeconds);
		expect(active).toBeLessThan(idle);
	});

	it("never polls faster than the floor, even for an aggressive configuration", () => {
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 1, isActive: true })).toBe(POLL_POLICY.minIntervalSeconds);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 1, isActive: false })).toBe(POLL_POLICY.minIntervalSeconds);
	});

	it("does not speed up beyond the configured interval when that is already fast", () => {
		// base 3s -> min floor 5s; base 10s while active -> stays 5s (activeIntervalSeconds)
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 10, isActive: true })).toBe(5);
		// A base slower than the active cadence still wins nothing: active must be <= base.
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 4, isActive: true })).toBe(5);
	});

	it("slows down while the adapter is still loading", () => {
		const startingUp = getPollIntervalSeconds({ baseIntervalSeconds: 10, isActive: true, isStartingUp: true });
		expect(startingUp).toBe(POLL_POLICY.startupIntervalSeconds);
		// Startup must never be faster than the configured base either.
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 120, isActive: false, isStartingUp: true })).toBe(120);
	});

	it("backs off exponentially after consecutive failures and caps out", () => {
		const base = 10;
		expect(getPollIntervalSeconds({ baseIntervalSeconds: base, isActive: true, consecutiveErrors: 1 })).toBe(30);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: base, isActive: true, consecutiveErrors: 2 })).toBe(60);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: base, isActive: true, consecutiveErrors: 3 })).toBe(120);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: base, isActive: true, consecutiveErrors: 9 })).toBe(POLL_POLICY.errorMaxSeconds);
	});

	it("lets the error backoff win over the active fast cadence", () => {
		const active = getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: true, consecutiveErrors: 0 });
		const failing = getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: true, consecutiveErrors: 2 });
		expect(failing).toBeGreaterThan(active);
	});

	it("falls back to 60s for a missing or invalid configured interval", () => {
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 0, isActive: false })).toBe(60);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: Number.NaN, isActive: false })).toBe(60);
	});
});

describe("requestPolicy: configurable poll cadence", () => {
	it("keeps the previous defaults when nothing is configured", () => {
		expect(resolveActiveIntervalSeconds(undefined)).toBe(POLL_POLICY.activeIntervalSeconds);
		expect(resolveBackoffMaxSeconds(undefined)).toBe(POLL_POLICY.errorMaxSeconds);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: true })).toBe(5);
	});

	it("uses the configured active cadence while the robot is working", () => {
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: true, activeIntervalSeconds: 2 })).toBe(2);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: true, activeIntervalSeconds: 15 })).toBe(15);
		// Idle is untouched by the active cadence.
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: false, activeIntervalSeconds: 2 })).toBe(60);
	});

	it("does not let the generic floor override a deliberately faster configuration", () => {
		// The 5s floor applies to cadences the adapter derives itself, not to an explicit 2s.
		expect(MIN_ACTIVE_POLL_INTERVAL_SECONDS).toBeLessThan(POLL_POLICY.minIntervalSeconds);
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 60, isActive: true, activeIntervalSeconds: 3 })).toBe(3);
	});

	it("clamps an out of range active cadence instead of trusting the instance config", () => {
		expect(resolveActiveIntervalSeconds(0)).toBe(POLL_POLICY.activeIntervalSeconds);
		expect(resolveActiveIntervalSeconds(-5)).toBe(POLL_POLICY.activeIntervalSeconds);
		expect(resolveActiveIntervalSeconds(Number.NaN)).toBe(POLL_POLICY.activeIntervalSeconds);
		expect(resolveActiveIntervalSeconds(1)).toBe(MIN_ACTIVE_POLL_INTERVAL_SECONDS);
		expect(resolveActiveIntervalSeconds(9999)).toBe(MAX_ACTIVE_POLL_INTERVAL_SECONDS);
		expect(resolveActiveIntervalSeconds(4.6)).toBe(5);
	});

	it("uses the configured backoff cap for the error path", () => {
		// 9 consecutive failures would reach 30 * 2^8 without a cap.
		const context = { baseIntervalSeconds: 60, isActive: false, consecutiveErrors: 9 };
		expect(getPollIntervalSeconds({ ...context, errorMaxSeconds: 60 })).toBe(60);
		expect(getPollIntervalSeconds({ ...context, errorMaxSeconds: 900 })).toBe(900);
		expect(getPollIntervalSeconds(context)).toBe(POLL_POLICY.errorMaxSeconds);
	});

	it("clamps an out of range backoff cap", () => {
		expect(resolveBackoffMaxSeconds(0)).toBe(POLL_POLICY.errorMaxSeconds);
		expect(resolveBackoffMaxSeconds(Number.NaN)).toBe(POLL_POLICY.errorMaxSeconds);
		expect(resolveBackoffMaxSeconds(1)).toBe(MIN_POLL_BACKOFF_MAX_SECONDS);
		expect(resolveBackoffMaxSeconds(100000)).toBe(MAX_POLL_BACKOFF_MAX_SECONDS);
	});

	it("still lets an already faster base interval win over the active cadence", () => {
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 7, isActive: true, activeIntervalSeconds: 10 })).toBe(7);
		// Below the generic floor the floor still applies, because 5s was not asked for explicitly.
		expect(getPollIntervalSeconds({ baseIntervalSeconds: 1, isActive: true, activeIntervalSeconds: 10 })).toBe(POLL_POLICY.minIntervalSeconds);
	});
});

describe("requestPolicy: ChannelUnavailableError", () => {
	it("is recognisable by instance and by code", () => {
		const error = new ChannelUnavailableError("cloud and local are down");

		expect(isChannelUnavailableError(error)).toBe(true);
		expect(isChannelUnavailableError({ code: "CHANNEL_UNAVAILABLE" })).toBe(true);
		expect(isChannelUnavailableError(new Error("cloud and local are down"))).toBe(false);
		expect(isChannelUnavailableError(undefined)).toBe(false);
		expect(error.message).toContain("down");
	});
});
