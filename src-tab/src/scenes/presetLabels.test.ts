import { describe, expect, it } from "vitest";
import { sceneCleaningMode } from "@adapter/common/scenePresets";
import type { ScenePresetEntry, ScenePresetStep } from "@adapter/common/scenePresets";
import { presetLevelLabel, presetModeLabels, presetStepTarget, presetTarget } from "./presetLabels";
import type { ModeModel } from "../engine/types";

/**
 * The two lines a program tile shows.
 *
 * Both have a failure mode worth pinning. A target may name a room the **loaded map** does not have -
 * a program made on another floor - and dropping it would make two programs look identical. A
 * suction level may be a number the robot never offered as an option, and inventing a name for it
 * would tell the user a level he did not pick.
 */

/** The translations the tests read; `%s` is filled by the code under test. */
const TEXTS: Record<string, string> = {
	ui_preset_target_all: "Ganze Wohnung",
	ui_preset_target_segment: "Raum %s",
	ui_preset_target_zone: "Zone %s",
	ui_clean_mode_vacuum: "Saugen",
	ui_clean_mode_mop: "Wischen",
	ui_clean_mode_vac_and_mop: "Vac & Mop",
};

const t = (key: string): string => TEXTS[key] ?? key;

/** One step with the target and the two cleaning values that matter here. */
function step(partial: Partial<ScenePresetStep>): ScenePresetStep {
	const fanPower = partial.fanPower ?? null;
	const waterBoxMode = partial.waterBoxMode ?? null;
	return {
		method: partial.method ?? "do_scenes_segments",
		tid: partial.tid ?? null,
		// `in` rather than `??`, so an explicit null stays null - that is the case the fallback to the
		// method name exists for, and `??` would quietly turn it back into a segment.
		target: "target" in partial ? (partial.target ?? null) : "segment",
		targetIds: partial.targetIds ?? [],
		mapFlag: partial.mapFlag ?? null,
		fanPower,
		waterBoxMode,
		mopMode: partial.mopMode ?? null,
		repeat: partial.repeat ?? null,
		mode: partial.mode ?? sceneCleaningMode(fanPower, waterBoxMode),
	};
}

/** One program made of the given steps. */
function entry(steps: ScenePresetStep[]): ScenePresetEntry {
	return { id: "1", name: "Test", enabled: true, valid: null, steps };
}

/** The rooms of the measured ground floor. */
const ROOMS = new Map<number, string>([[18, "Küche"], [19, "Flur"]]);

describe("presetStepTarget", () => {
	it("names a segment by the room it is", () => {
		expect(presetStepTarget(step({ target: "segment", targetIds: [18] }), ROOMS, t)).toBe("Küche");
	});

	it("keeps the number for a room the loaded map does not have", () => {
		// A program made on the cellar map names ids the ground floor does not carry. Hiding it would
		// make it indistinguishable from another program.
		expect(presetStepTarget(step({ target: "segment", targetIds: [77] }), ROOMS, t)).toBe("Raum 77");
	});

	it("lists several rooms", () => {
		expect(presetStepTarget(step({ target: "segment", targetIds: [18, 19] }), ROOMS, t)).toBe("Küche, Flur");
	});

	it("names a zone by its number, because a zone has no name anywhere", () => {
		// "Kamin" is the name of the *scene*, not of the zone; the robot knows the zone only as `zid`.
		expect(presetStepTarget(step({ target: "zone", targetIds: [1] }), ROOMS, t)).toBe("Zone 1");
	});

	it("names the whole home for a step with no target", () => {
		expect(presetStepTarget(step({ target: "all", method: "do_scenes_app_start" }), ROOMS, t)).toBe("Ganze Wohnung");
	});

	it("falls back to the method name for an RPC this build has not seen", () => {
		// The one thing that cannot be wrong about it, and more use to a bug report than "unknown".
		expect(presetStepTarget(step({ target: null, method: "do_scenes_future" }), ROOMS, t)).toBe("do_scenes_future");
	});
});

describe("presetTarget", () => {
	it("joins the steps in the order they run", () => {
		const model = entry([
			step({ target: "segment", targetIds: [18] }),
			step({ target: "segment", targetIds: [19] }),
		]);
		expect(presetTarget(model, ROOMS, t)).toBe("Küche → Flur");
	});

	it("says a repeated target once", () => {
		// The measured two-step program cleans the whole flat twice over. Two identical halves in the
		// line would say nothing; the two mode icons beside it carry that there are two steps.
		const model = entry([
			step({ target: "all", method: "do_scenes_app_start", fanPower: 108, waterBoxMode: 200 }),
			step({ target: "all", method: "do_scenes_app_start", fanPower: 105, waterBoxMode: 203 }),
		]);
		expect(presetTarget(model, ROOMS, t)).toBe("Ganze Wohnung");
	});

	it("is empty for a program with no steps", () => {
		expect(presetTarget(entry([]), ROOMS, t)).toBe("");
	});
});

describe("presetLevelLabel", () => {
	const modes: ModeModel[] = [{
		command: "set_custom_mode",
		labelKey: "fan_power",
		value: "104",
		options: [{ value: "104", label: "Max" }, { value: "108", label: "Max+" }],
	}];

	it("uses the robot's own wording", () => {
		expect(presetLevelLabel(modes, "set_custom_mode", 108)).toBe("Max+");
	});

	it("prints the bare number for a level the robot does not list", () => {
		// Never an invented name: an unlisted level is one this build knows nothing about, and the
		// number says exactly that much.
		expect(presetLevelLabel(modes, "set_custom_mode", 999)).toBe("999");
	});

	it("answers null when there is no value at all", () => {
		expect(presetLevelLabel(modes, "set_custom_mode", null)).toBeNull();
	});

	it("prints the number when the selector itself is absent", () => {
		expect(presetLevelLabel([], "set_custom_mode", 104)).toBe("104");
	});
});

describe("presetModeLabels", () => {
	it("reuses the wording of the cleaning-mode tabs", () => {
		// Deliberately the same keys: a second set of words is how the tab bar ends up disagreeing
		// with a program tile about what "Wischen" means.
		const model = entry([step({ fanPower: 108, waterBoxMode: 200 })]);
		expect(presetModeLabels(model, t)).toEqual([{ mode: "vacuum", label: "Saugen" }]);
	});

	it("reports both modes of a two-step program, in order", () => {
		const model = entry([
			step({ fanPower: 108, waterBoxMode: 200 }),
			step({ fanPower: 105, waterBoxMode: 203 }),
		]);
		expect(presetModeLabels(model, t).map(item => item.mode)).toEqual(["vacuum", "mop"]);
	});

	it("reports nothing when no step decides a mode", () => {
		expect(presetModeLabels(entry([step({})]), t)).toEqual([]);
	});
});
