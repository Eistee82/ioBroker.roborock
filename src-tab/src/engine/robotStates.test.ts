import { describe, expect, it } from "vitest";
import { DOCK_COMMAND_PAIRS, ROBOT_STATES, dockActivity, robotPhase } from "./robotStates";
import type { RobotPhase } from "./types";

/**
 * The state table decides which controls the user gets. The dangerous direction is not a wrong
 * label but a *missing button*: every fallback here has to end up offering an action, because an
 * empty action bar leaves the user with no way to reach the robot at all.
 */

describe("robotPhase", () => {
	it("maps the codes that mean the robot is working", () => {
		for (const code of [5, 11, 16, 17, 18, 29, 30, 32, 38, 39]) {
			expect(robotPhase(code), `code ${code}`).toBe("cleaning");
		}
	});

	it("maps the codes that mean the robot is on its way to the station", () => {
		for (const code of [6, 15, 26]) {
			expect(robotPhase(code), `code ${code}`).toBe("returning");
		}
	});

	it("maps the codes that mean the robot is standing in its station", () => {
		for (const code of [8, 9, 22, 23, 25, 33, 34, 41, 100]) {
			expect(robotPhase(code), `code ${code}`).toBe("docked");
		}
	});

	it("maps pausing and the idle codes", () => {
		expect(robotPhase(10)).toBe("paused");
		for (const code of [1, 2, 3, 4, 7, 12, 13, 14, 28, 36, 37, 40, 42]) {
			expect(robotPhase(code), `code ${code}`).toBe("idle");
		}
	});

	it("answers 'unknown' rather than throwing for a code no firmware version anticipated", () => {
		expect(robotPhase(999)).toBe("unknown");
		expect(robotPhase(-1)).toBe("unknown");
		expect(robotPhase(24)).toBe("unknown"); // a gap inside the listed range
	});

	it("answers 'unknown' while no state has arrived yet", () => {
		expect(robotPhase(null)).toBe("unknown");
	});

	it("treats the explicit unknown and offline codes as unknown", () => {
		expect(robotPhase(0)).toBe("unknown");
		expect(robotPhase(101)).toBe("unknown");
		expect(robotPhase(102)).toBe("unknown");
	});

	it("never invents a phase outside the six the controls understand", () => {
		const allowed: RobotPhase[] = ["cleaning", "paused", "returning", "docked", "idle", "unknown"];
		for (const [code, info] of Object.entries(ROBOT_STATES)) {
			expect(allowed, `code ${code}`).toContain(info.phase);
		}
	});
});

describe("ROBOT_STATES table", () => {
	it("gives every row a translation key and an English fallback", () => {
		// The strip shows `en` when the admin language has no entry, so an empty one would leave
		// the user staring at a blank status line.
		for (const [code, info] of Object.entries(ROBOT_STATES)) {
			expect(info.key, `code ${code}`).toMatch(/^ui_state_\w+$/);
			expect(info.en.length, `code ${code}`).toBeGreaterThan(0);
		}
	});

	it("keys every row by a number, because V1 and B01/Q10 differ only in capitalisation", () => {
		for (const code of Object.keys(ROBOT_STATES)) {
			expect(code).toMatch(/^\d+$/);
		}
	});
});

describe("dockActivity", () => {
	it("reports washing for both the mop and the duster cycle", () => {
		// 25 is the same wash cycle on models with a duster, and `app_stop_wash` ends it.
		expect(dockActivity(23)).toBe("washing");
		expect(dockActivity(25)).toBe("washing");
	});

	it("reports emptying while the station pulls the dust container", () => {
		expect(dockActivity(22)).toBe("emptying");
	});

	it("reports nothing running for every other state", () => {
		for (const code of [null, 0, 5, 8, 10, 24, 100, 999]) {
			expect(dockActivity(code), `code ${String(code)}`).toBeNull();
		}
	});

	it("reports drying from the station flag, since no state code names it", () => {
		// While the station dries the mop the robot reports plain charging (8).
		expect(dockActivity(8, true)).toBe("drying");
		expect(dockActivity(null, true)).toBe("drying");
	});

	it("does not read a silent or negative drying flag as a running job", () => {
		expect(dockActivity(8, false)).toBeNull();
		expect(dockActivity(8, null)).toBeNull();
	});

	it("lets the job the robot itself reports win over the drying flag", () => {
		// The two never overlap in practice, and a Stop button must match the state that is shown.
		expect(dockActivity(23, true)).toBe("washing");
		expect(dockActivity(22, true)).toBe("emptying");
	});

	it("only ever reports a job while the robot counts as docked", () => {
		// A Stop button for a wash cycle would be pointless if the robot were out cleaning.
		for (const code of [22, 23, 25]) {
			expect(robotPhase(code), `code ${code}`).toBe("docked");
		}
	});
});

describe("DOCK_COMMAND_PAIRS", () => {
	it("names both halves of each station job", () => {
		expect(DOCK_COMMAND_PAIRS.washing).toEqual({ start: "app_start_wash", stop: "app_stop_wash" });
		expect(DOCK_COMMAND_PAIRS.emptying).toEqual({
			start: "app_start_collect_dust",
			stop: "app_stop_collect_dust",
		});
		expect(DOCK_COMMAND_PAIRS.drying).toEqual({
			start: "app_start_mop_drying",
			stop: "app_stop_mop_drying",
		});
	});

	it("is keyed by exactly the jobs dockActivity can report", () => {
		// A key that no state ever produces would leave its Stop button permanently hidden.
		const reported = new Set([dockActivity(23), dockActivity(22), dockActivity(8, true)]);
		expect(new Set(Object.keys(DOCK_COMMAND_PAIRS))).toEqual(reported);
	});

	it("keeps start and stop distinct across all pairs", () => {
		const commands = Object.values(DOCK_COMMAND_PAIRS).flatMap(pair => [pair.start, pair.stop]);
		expect(new Set(commands).size).toBe(commands.length);
	});
});
