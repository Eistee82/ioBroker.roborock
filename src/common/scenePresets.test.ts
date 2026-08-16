import { describe, expect, it } from "vitest";
import type { ScenePresetEntry } from "./scenePresets";
import { parseScenePresetList, sceneCleaningMode, scenePresetModes, sceneStepTarget } from "./scenePresets";

/**
 * The contract of `programs.list`.
 *
 * The value crosses to the browser as a JSON string, so most of this is about surviving what a state
 * can hold. The one rule that is more than robustness is {@link sceneCleaningMode}: it decides which
 * of the three pictograms a program tile shows, and a wrong answer there tells the user his program
 * mops when it vacuums.
 */

/** The four programs of the measured account, as `_appanalysis/szenen-roh.json` records them. */
const MEASURED = JSON.stringify([
	{
		id: "12101885", name: "Kamin", enabled: true, valid: true,
		steps: [{ method: "do_scenes_zones", tid: "1767377550650", target: "zone", targetIds: [1], mapFlag: 0, fanPower: 108, waterBoxMode: 200, mopMode: 300, repeat: 1, mode: "vacuum" }]
	},
	{
		id: "7085757", name: "Flur", enabled: true, valid: true,
		steps: [{ method: "do_scenes_segments", tid: "1745006747490", target: "segment", targetIds: [19], mapFlag: 0, fanPower: 104, waterBoxMode: 203, mopMode: 300, repeat: 1, mode: "vacmop" }]
	}
]);

describe("sceneCleaningMode", () => {
	it("reads the four measured programs the way the app's predicates do", () => {
		// Kamin: fan 108, water 200 -> isPureCleanMode -> Vacuum.
		expect(sceneCleaningMode(108, 200)).toBe("vacuum");
		// Flur, Küche, Terrassentür: fan 104, water 203 -> isCleanMopMode -> Vac & Mop.
		expect(sceneCleaningMode(104, 203)).toBe("vacmop");
	});

	it("calls fan_power 105 with water on the mop-only mode", () => {
		// The second step of the measured two-step program.
		expect(sceneCleaningMode(105, 203)).toBe("mop");
	});

	it("prefers the vacuum verdict when both of the first two predicates would match", () => {
		// `isPureCleanMode` is declared before `isPureMopMode` (A65:244587 vs A65:244610) and reads
		// only the water value, so the app reaches it first. Swapping the order here would put the
		// mop icon on a program that runs with the water off.
		expect(sceneCleaningMode(105, 200)).toBe("vacuum");
	});

	it("decides on the water value alone when there is no suction level", () => {
		// `isPureCleanMode(waterMode)` takes one argument, so this case is answerable.
		expect(sceneCleaningMode(null, 200)).toBe("vacuum");
	});

	it("refuses to decide when the values do not decide it", () => {
		// Not "vacmop by default": `isCleanMopMode` reads both values, and one of them is missing.
		expect(sceneCleaningMode(105, null)).toBeNull();
		expect(sceneCleaningMode(null, null)).toBeNull();
		expect(sceneCleaningMode(null, 203)).toBeNull();
	});
});

describe("sceneStepTarget", () => {
	it("knows the three measured RPCs", () => {
		expect(sceneStepTarget("do_scenes_segments")).toBe("segment");
		expect(sceneStepTarget("do_scenes_zones")).toBe("zone");
		expect(sceneStepTarget("do_scenes_app_start")).toBe("all");
	});

	it("answers null for a method this build has not seen", () => {
		// Null rather than a guess: the caller then prints the method name, which cannot be wrong.
		expect(sceneStepTarget("do_scenes_something_new")).toBeNull();
		expect(sceneStepTarget("")).toBeNull();
	});
});

describe("parseScenePresetList", () => {
	it("reads the list the adapter writes", () => {
		const entries = parseScenePresetList(MEASURED);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ id: "12101885", name: "Kamin", enabled: true, valid: true });
		expect(entries[0].steps[0]).toMatchObject({ tid: "1767377550650", target: "zone", targetIds: [1], fanPower: 108, mode: "vacuum" });
	});

	it("takes the already parsed array as well", () => {
		expect(parseScenePresetList(JSON.parse(MEASURED))).toHaveLength(2);
	});

	it("answers with an empty list for everything that is not one", () => {
		for (const value of ["", "   ", "not json", "{}", 42, null, undefined, {}]) {
			expect(parseScenePresetList(value)).toEqual([]);
		}
	});

	it("drops a row without an id rather than inventing one", () => {
		// The id is what a start is addressed to; a wrong one would run somebody else's program.
		const entries = parseScenePresetList(JSON.stringify([{ name: "Kamin", steps: [] }, { id: "7", name: "Flur", steps: [] }]));
		expect(entries.map(entry => entry.id)).toEqual(["7"]);
	});

	it("keeps a tid as the string it is", () => {
		// 13 digits fits a double, but the value is compared against the robot's own list and must
		// not depend on how a number was rendered back.
		const entries = parseScenePresetList(JSON.stringify([{ id: "1", steps: [{ method: "do_scenes_zones", tid: "1767377550650" }] }]));
		expect(entries[0].steps[0].tid).toBe("1767377550650");
	});

	it("recomputes the mode instead of trusting what was written", () => {
		// An older adapter wrote no `mode`, and a hand-edited state could carry any word. The rule and
		// the published value must not be able to drift apart.
		const entries = parseScenePresetList(JSON.stringify([
			{ id: "1", steps: [{ method: "do_scenes_zones", fanPower: 108, waterBoxMode: 200, mode: "mop" }] }
		]));
		expect(entries[0].steps[0].mode).toBe("vacuum");
	});

	it("treats an unknown target word as no target", () => {
		const entries = parseScenePresetList(JSON.stringify([{ id: "1", steps: [{ method: "x", target: "everything" }] }]));
		expect(entries[0].steps[0].target).toBeNull();
	});

	it("keeps valid at null unless it is a boolean", () => {
		// Null is "not checked" and must not be reachable from a string, or every program of a device
		// whose firmware lacks the getter would be marked.
		expect(parseScenePresetList(JSON.stringify([{ id: "1", valid: "true", steps: [] }]))[0].valid).toBeNull();
		expect(parseScenePresetList(JSON.stringify([{ id: "1", valid: false, steps: [] }]))[0].valid).toBe(false);
	});
});

describe("scenePresetModes", () => {
	/** Builds a row out of nothing but its steps' two cleaning values. */
	const withSteps = (pairs: Array<[number, number]>): ScenePresetEntry => ({
		id: "1",
		name: null,
		enabled: true,
		valid: null,
		steps: pairs.map(pair => ({
			method: "do_scenes_app_start", tid: null, target: "all" as const, targetIds: [], mapFlag: null,
			fanPower: pair[0], waterBoxMode: pair[1], mopMode: null, repeat: null,
			mode: sceneCleaningMode(pair[0], pair[1])
		}))
	});

	it("reports the two modes of the measured two-step program, in order", () => {
		// Scene 4841021: vacuum the flat (108/200), then mop it (105/203).
		expect(scenePresetModes(withSteps([[108, 200], [105, 203]]))).toEqual(["vacuum", "mop"]);
	});

	it("collapses repeats without reordering", () => {
		expect(scenePresetModes(withSteps([[104, 203], [104, 203]]))).toEqual(["vacmop"]);
	});

	it("reports none when no step decides a mode", () => {
		expect(scenePresetModes(withSteps([]))).toEqual([]);
	});
});
