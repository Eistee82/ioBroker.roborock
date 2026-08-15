import { describe, expect, it, vi } from "vitest";

import { FeatureDependencies } from "../baseDeviceFeatures";
import {
	COMMAND_VERIFY_GRACE_MS,
	CommandVerifier,
	VERIFIABLE_SET_COMMANDS,
	expectationFor
} from "./commandVerification";
import { V1VacuumFeatures } from "./v1VacuumFeatures";

function createDeps(): FeatureDependencies {
	const adapter: any = {
		namespace: "roborock.0",
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
		translations: {},
		rLog: vi.fn(),
		setState: vi.fn().mockResolvedValue(undefined),
		setStateChanged: vi.fn().mockResolvedValue(undefined),
		extendObject: vi.fn().mockResolvedValue(undefined),
		applyCommonUpdate: vi.fn().mockResolvedValue(undefined),
		getObjectAsync: vi.fn().mockResolvedValue(null),
		getStateAsync: vi.fn().mockResolvedValue(null),
		getDeviceProtocolVersion: vi.fn().mockResolvedValue("1.0"),
		http_api: {
			getDevices: vi.fn().mockReturnValue([]),
			getFwFeaturesResult: vi.fn(),
			storeFwFeaturesResult: vi.fn()
		},
		requestsHandler: { sendRequest: vi.fn().mockResolvedValue({}) },
		translationManager: { get: vi.fn().mockImplementation((key: string, def: string) => def || key) }
	};

	return {
		adapter,
		http_api: adapter.http_api,
		ensureState: vi.fn().mockResolvedValue(undefined),
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		log: adapter.log,
		config: { staticFeatures: [] }
	} as unknown as FeatureDependencies;
}

/** All log lines the adapter wrote, flattened to `<level>|<message>`. */
function logLines(deps: FeatureDependencies): string[] {
	const rLog = (deps as any).adapter.rLog as ReturnType<typeof vi.fn>;
	return rLog.mock.calls.map((call: any[]) => `${String(call[6])}|${String(call[5])}`);
}

describe("reading the expected status values out of a command", () => {
	it("takes the single value of the three mode commands", () => {
		expect(expectationFor("set_custom_mode", [104])).toEqual({ fan_power: 104 });
		expect(expectationFor("set_mop_mode", [300])).toEqual({ mop_mode: 300 });
		expect(expectationFor("set_water_box_custom_mode", [208])).toEqual({ water_box_mode: 208 });
	});

	it("takes the whole triple of set_clean_motor_mode", () => {
		expect(expectationFor("set_clean_motor_mode", [{ fan_power: 102, water_box_mode: 201, mop_mode: 300 }]))
			.toEqual({ fan_power: 102, water_box_mode: 201, mop_mode: 300 });
	});

	it("keeps only the keys a model actually sends", () => {
		expect(expectationFor("set_clean_motor_mode", [{ fan_power: 103, water_box_mode: 202 }]))
			.toEqual({ fan_power: 103, water_box_mode: 202 });
	});

	it("refuses commands whose effect the status does not show", () => {
		expect(expectationFor("set_clean_repeat_times", [2])).toBeNull();
		expect(expectationFor("app_start", [])).toBeNull();
		expect(expectationFor("set_water_box_distance_off", [{ distance_off: 205 }])).toBeNull();
	});

	it("refuses parameters it cannot read as a number", () => {
		expect(expectationFor("set_custom_mode", ["quiet"])).toBeNull();
		expect(expectationFor("set_custom_mode", [])).toBeNull();
		expect(expectationFor("set_clean_motor_mode", ["not json"])).toBeNull();
	});
});

describe("the verifier itself", () => {
	it("confirms as soon as the status carries the value, however early that is", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_water_box_custom_mode", [203], 1_000);

		const results = verifier.evaluate({ water_box_mode: 203 }, 1_050);

		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("confirmed");
		expect(results[0].reported).toEqual({ water_box_mode: 203 });
		expect(verifier.pendingCount).toBe(0);
	});

	it("stays quiet while the robot may still be applying the value", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_water_box_custom_mode", [208], 1_000);

		// The status refresh that fires straight after the command still shows the old level.
		expect(verifier.evaluate({ water_box_mode: 203 }, 1_500)).toEqual([]);
		expect(verifier.pendingCount).toBe(1);
	});

	it("reports the mismatch once the grace window is over", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_water_box_custom_mode", [208], 1_000);
		verifier.evaluate({ water_box_mode: 203 }, 1_500);

		const results = verifier.evaluate({ water_box_mode: 203 }, 1_000 + COMMAND_VERIFY_GRACE_MS + 1);

		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("mismatch");
		expect(results[0].mismatches).toEqual([{ field: "water_box_mode", expected: 208, actual: 203 }]);
		expect(verifier.pendingCount).toBe(0);
	});

	it("confirms a value that arrives late, after the grace window", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_custom_mode", [104], 1_000);

		const results = verifier.evaluate({ fan_power: 104 }, 1_000 + COMMAND_VERIFY_GRACE_MS + 1);

		expect(results[0].kind).toBe("confirmed");
	});

	it("says so instead of guessing when the status never carries the field", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_mop_mode", [301], 1_000);

		expect(verifier.evaluate({ state: 8 }, 1_500)).toEqual([]);
		const results = verifier.evaluate({ state: 8 }, 1_000 + COMMAND_VERIFY_GRACE_MS + 1);

		expect(results[0].kind).toBe("unobservable");
		expect(results[0].mismatches).toEqual([]);
	});

	it("judges every field of set_clean_motor_mode, not just the first", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_clean_motor_mode", [{ fan_power: 102, water_box_mode: 201, mop_mode: 300 }], 1_000);

		const results = verifier.evaluate(
			{ fan_power: 102, water_box_mode: 203, mop_mode: 300 },
			1_000 + COMMAND_VERIFY_GRACE_MS + 1
		);

		expect(results[0].kind).toBe("mismatch");
		expect(results[0].mismatches).toEqual([{ field: "water_box_mode", expected: 201, actual: 203 }]);
	});

	it("watches several commands at once and lets a newer write replace an older one", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_custom_mode", [104], 1_000);
		verifier.record("set_water_box_custom_mode", [201], 1_000);
		expect(verifier.pendingCount).toBe(2);

		// The user picks another fan level before the first one was judged.
		verifier.record("set_custom_mode", [101], 2_000);
		expect(verifier.pendingCount).toBe(2);

		const results = verifier.evaluate({ fan_power: 101, water_box_mode: 201 }, 2_100);
		expect(results.map((r) => r.command).sort()).toEqual(["set_custom_mode", "set_water_box_custom_mode"]);
		expect(results.every((r) => r.kind === "confirmed")).toBe(true);
	});

	it("costs nothing when no command is waiting", () => {
		const verifier = new CommandVerifier();
		expect(verifier.evaluate({ fan_power: 102 })).toEqual([]);
	});

	it("survives a status that is not an object", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_custom_mode", [104], 1_000);
		expect(verifier.evaluate(null, 1_500)).toEqual([]);
		expect(verifier.evaluate(undefined, 1_000 + COMMAND_VERIFY_GRACE_MS + 1)[0].kind).toBe("unobservable");
	});

	it("can be emptied", () => {
		const verifier = new CommandVerifier();
		verifier.record("set_custom_mode", [104], 1_000);
		verifier.clear();
		expect(verifier.pendingCount).toBe(0);
	});
});

describe("the vacuum handler wired to the verifier", () => {
	function createVacuum(): { vacuum: V1VacuumFeatures; deps: FeatureDependencies } {
		const deps = createDeps();
		const vacuum = new V1VacuumFeatures(deps, "duid-test", "roborock.vacuum.a65");
		return { vacuum, deps };
	}

	it("watches a set command the robot answered with ok", async () => {
		const { vacuum } = createVacuum();
		await vacuum.onCommandResult("set_water_box_custom_mode", "set_water_box_custom_mode", ["ok"], [208]);
		expect((vacuum as any).commandVerifier.pendingCount).toBe(1);
	});

	it("leaves an answer that was not ok to the existing error path", async () => {
		const { vacuum } = createVacuum();
		await vacuum.onCommandResult("set_water_box_custom_mode", "set_water_box_custom_mode", ["unknown_method"], [208]);
		expect((vacuum as any).commandVerifier.pendingCount).toBe(0);
	});

	it("unwraps the data envelope some transports add", async () => {
		const { vacuum } = createVacuum();
		await vacuum.onCommandResult("set_custom_mode", "set_custom_mode", { data: ["ok"] }, [104]);
		expect((vacuum as any).commandVerifier.pendingCount).toBe(1);
	});

	it("warns when the robot keeps reporting the old value", async () => {
		const { vacuum, deps } = createVacuum();
		await vacuum.onCommandResult("set_water_box_custom_mode", "set_water_box_custom_mode", ["ok"], [208]);
		// Push the acknowledgement past the grace window without waiting for it in real time.
		(vacuum as any).commandVerifier.record("set_water_box_custom_mode", [208], Date.now() - COMMAND_VERIFY_GRACE_MS - 1);

		await vacuum.processStatus({ water_box_mode: 203 });

		const warnings = logLines(deps).filter((line) => line.startsWith("warn|") && line.includes("[Command check]"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("set_water_box_custom_mode");
		expect(warnings[0]).toContain("water_box_mode=203");
		expect(warnings[0]).toContain("requested 208");
	});

	it("says nothing at all when the robot took the value", async () => {
		const { vacuum, deps } = createVacuum();
		await vacuum.onCommandResult("set_water_box_custom_mode", "set_water_box_custom_mode", ["ok"], [203]);

		await vacuum.processStatus({ water_box_mode: 203 });

		expect(logLines(deps).filter((line) => line.includes("[Command check]"))).toEqual([]);
	});

	it("marks a confirmed command state acknowledged even when the value did not change", async () => {
		const { vacuum, deps } = createVacuum();
		await vacuum.onCommandResult("set_custom_mode", "set_custom_mode", ["ok"], [102]);

		await vacuum.processStatus({ fan_power: 102 });

		expect((deps as any).adapter.setState).toHaveBeenCalledWith(
			"Devices.duid-test.commands.set_custom_mode",
			{ val: 102, ack: true }
		);
	});

	it("never acknowledges a command state on a mismatch", async () => {
		const { vacuum, deps } = createVacuum();
		(vacuum as any).commandVerifier.record("set_custom_mode", [104], Date.now() - COMMAND_VERIFY_GRACE_MS - 1);

		await vacuum.processStatus({ fan_power: 102 });

		const acks = (deps as any).adapter.setState.mock.calls
			.filter((call: any[]) => String(call[0]).includes("commands.set_custom_mode"));
		expect(acks).toEqual([]);
	});

	it("leaves the preset state of set_clean_motor_mode alone, it is a JSON string", async () => {
		const { vacuum, deps } = createVacuum();
		await vacuum.onCommandResult(
			"set_clean_motor_mode",
			"set_clean_motor_mode",
			["ok"],
			[{ fan_power: 102, water_box_mode: 201, mop_mode: 300 }]
		);

		await vacuum.processStatus({ fan_power: 102, water_box_mode: 201, mop_mode: 300 });

		const acks = (deps as any).adapter.setState.mock.calls
			.filter((call: any[]) => String(call[0]).includes("commands.set_clean_motor_mode"));
		expect(acks).toEqual([]);
	});
});

describe("the boundaries of the check", () => {
	it("only covers commands the status can answer for", () => {
		expect(Object.keys(VERIFIABLE_SET_COMMANDS).sort()).toEqual([
			"set_clean_motor_mode",
			"set_custom_mode",
			"set_mop_mode",
			"set_water_box_custom_mode"
		]);
	});

	it("pairs each command with the very status field the adapter mirrors back into it", () => {
		// v1VacuumFeatures.processStatus writes deviceStatus.fan_power into commands.set_custom_mode,
		// water_box_mode into set_water_box_custom_mode and mop_mode into set_mop_mode. The check
		// must not invent a different pairing.
		expect(VERIFIABLE_SET_COMMANDS["set_custom_mode"]).toEqual(["fan_power"]);
		expect(VERIFIABLE_SET_COMMANDS["set_water_box_custom_mode"]).toEqual(["water_box_mode"]);
		expect(VERIFIABLE_SET_COMMANDS["set_mop_mode"]).toEqual(["mop_mode"]);
	});

	it("waits longer than the fastest poll cadence, so the immediate refresh can never trip it", () => {
		// get_prop timeout 5 s + POLL_POLICY.minIntervalSeconds 5 s.
		expect(COMMAND_VERIFY_GRACE_MS).toBeGreaterThanOrEqual(10_000);
	});
});
