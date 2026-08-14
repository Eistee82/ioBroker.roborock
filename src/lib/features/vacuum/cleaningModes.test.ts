import { describe, expect, it } from "vitest";

import {
	CLEANING_MODE_STATES,
	CLEANING_MODE_STATE_VALUES,
	CLEAN_MODE_MAX_PLUS_MODELS,
	MAX_PLUS_WITHOUT_PURE_CLEAN_MOP_MODELS,
	NO_PURE_CLEAN_MOP_MODELS,
	buildCleanMotorModePresets,
	cleaningModeRouteOptions,
	cleaningModeValues,
	cleaningModesForModel,
	deriveCleaningMode,
	supportsCleanModeMaxPlus,
	supportsPureCleanMop
} from "./cleaningModes";
import type { CleaningMode } from "./cleaningModes";

/** The values the S7 Max Ultra reports in the plain combined mode. */
const VAC_AND_MOP = { fan_power: 102, water_box_mode: 201, mop_mode: 300 };

describe("deriving the cleaning mode from the three values", () => {
	it("reads water_box_mode 200 as vacuum-only, not as 'water off'", () => {
		expect(deriveCleaningMode({ fan_power: 102, water_box_mode: 200, mop_mode: 300 })).toBe("vacuum");
	});

	it("reads fan_power 105 as mop-only, not as the weakest suction level", () => {
		expect(deriveCleaningMode({ fan_power: 105, water_box_mode: 202, mop_mode: 303 })).toBe("mop");
	});

	it("recognises the per-room markers on any of the three values", () => {
		expect(deriveCleaningMode({ fan_power: 106, water_box_mode: 201, mop_mode: 300 })).toBe("custom");
		expect(deriveCleaningMode({ fan_power: 102, water_box_mode: 204, mop_mode: 300 })).toBe("custom");
		expect(deriveCleaningMode({ fan_power: 102, water_box_mode: 201, mop_mode: 302 })).toBe("custom");
	});

	it("falls back to the combined mode for everything else", () => {
		expect(deriveCleaningMode(VAC_AND_MOP)).toBe("vacAndMop");
		expect(deriveCleaningMode({ fan_power: 108, water_box_mode: 203, mop_mode: 304 })).toBe("vacAndMop");
	});

	it("keeps the app's order: vacuum-only wins over mop-only and both win over the markers", () => {
		// The app tests water 200 first, then fan 105, then the markers (A65:251206-251233).
		expect(deriveCleaningMode({ fan_power: 105, water_box_mode: 200 })).toBe("vacuum");
		expect(deriveCleaningMode({ fan_power: 106, water_box_mode: 200 })).toBe("vacuum");
		expect(deriveCleaningMode({ fan_power: 105, water_box_mode: 204 })).toBe("mop");
	});

	it("recognises SmartPlan on any of its three values and lets a model opt out", () => {
		expect(deriveCleaningMode({ fan_power: 110, water_box_mode: 201, mop_mode: 300 })).toBe("smart");
		expect(deriveCleaningMode({ fan_power: 102, water_box_mode: 209, mop_mode: 300 })).toBe("smart");
		expect(deriveCleaningMode({ fan_power: 102, water_box_mode: 201, mop_mode: 306 })).toBe("smart");

		// A profile that gives 110 a meaning of its own (the Saros models call it Max+) turns the
		// interpretation off, and then 110 is just a suction level.
		expect(deriveCleaningMode({ fan_power: 110, water_box_mode: 201 }, { smartPlan: false })).toBe("vacAndMop");
	});

	it("gives robots without the pure modes the single combined tab", () => {
		expect(deriveCleaningMode({ fan_power: 102, water_box_mode: 200 }, { pureCleanMop: false })).toBe("general");
		expect(deriveCleaningMode({ fan_power: 105, water_box_mode: 201 }, { pureCleanMop: false })).toBe("general");
		expect(deriveCleaningMode({ fan_power: 106, water_box_mode: 201 }, { pureCleanMop: false })).toBe("custom");
	});

	it("says nothing rather than guessing when the robot reported none of the three", () => {
		expect(deriveCleaningMode({})).toBeNull();
		expect(deriveCleaningMode({ fan_power: null, water_box_mode: undefined, mop_mode: null })).toBeNull();
	});

	it("survives the values arriving as strings and ignores unusable ones", () => {
		expect(deriveCleaningMode({ fan_power: "105" as unknown as number })).toBe("mop");
		expect(deriveCleaningMode({ water_box_mode: "200" as unknown as number })).toBe("vacuum");
		expect(deriveCleaningMode({ fan_power: "" as unknown as number })).toBeNull();
		expect(deriveCleaningMode({ fan_power: "quiet" as unknown as number })).toBeNull();
	});

	it("does not treat an unknown value as a mode", () => {
		expect(deriveCleaningMode({ fan_power: 199, water_box_mode: 221, mop_mode: 399 })).toBe("vacAndMop");
	});
});

describe("turning a mode back into set_clean_motor_mode values", () => {
	it("forces water_box_mode 200 for vacuum-only and fan_power 105 for mop-only", () => {
		expect(cleaningModeValues("vacuum", VAC_AND_MOP)).toEqual({ fan_power: 102, water_box_mode: 200, mop_mode: 300 });
		expect(cleaningModeValues("mop", VAC_AND_MOP)).toEqual({ fan_power: 105, water_box_mode: 201, mop_mode: 300 });
	});

	it("uses the app's own fixed triples for Customize and SmartPlan", () => {
		expect(cleaningModeValues("custom")).toEqual({ fan_power: 106, water_box_mode: 204, mop_mode: 302 });
		expect(cleaningModeValues("smart")).toEqual({ fan_power: 110, water_box_mode: 209, mop_mode: 306 });
	});

	it("falls back to the app's defaults 102 / 201 / 300 when nothing is known", () => {
		expect(cleaningModeValues("vacAndMop")).toEqual({ fan_power: 102, water_box_mode: 201, mop_mode: 300 });
	});

	it("keeps the user's suction and water levels across a mode switch", () => {
		const previous = { fan_power: 103, water_box_mode: 203, mop_mode: 300 };
		expect(cleaningModeValues("vacAndMop", previous)).toEqual({ fan_power: 103, water_box_mode: 203, mop_mode: 300 });
		expect(cleaningModeValues("vacuum", previous)).toEqual({ fan_power: 103, water_box_mode: 200, mop_mode: 300 });
	});

	it("drops the values that only ever describe a mode instead of carrying them along", () => {
		// Coming out of vacuum-only, the reported 200 must not survive into the combined mode.
		expect(cleaningModeValues("vacAndMop", { fan_power: 102, water_box_mode: 200, mop_mode: 300 }).water_box_mode).toBe(201);
		// Coming out of mop-only, 105 must not survive either.
		expect(cleaningModeValues("vacAndMop", { fan_power: 105, water_box_mode: 202, mop_mode: 303 }).fan_power).toBe(102);
		// Coming out of Customize, none of the three markers may survive.
		expect(cleaningModeValues("vacAndMop", { fan_power: 106, water_box_mode: 204, mop_mode: 302 })).toEqual({
			fan_power: 102,
			water_box_mode: 201,
			mop_mode: 300
		});
	});

	it("resets the route to Standard outside mop-only and keeps the full choice inside it", () => {
		expect(cleaningModeValues("vacAndMop", { ...VAC_AND_MOP, mop_mode: 303 }).mop_mode).toBe(300);
		expect(cleaningModeValues("vacuum", { ...VAC_AND_MOP, mop_mode: 304 }).mop_mode).toBe(300);
		expect(cleaningModeValues("mop", { ...VAC_AND_MOP, mop_mode: 303 }).mop_mode).toBe(303);
		expect(cleaningModeValues("mop", { ...VAC_AND_MOP, mop_mode: 305 }).mop_mode).toBe(305);
	});

	it("drops MAX+ everywhere but vacuum-only, exactly like the app", () => {
		const withMaxPlus = { fan_power: 108, water_box_mode: 201, mop_mode: 300 };
		expect(cleaningModeValues("vacuum", withMaxPlus).fan_power).toBe(108);
		expect(cleaningModeValues("vacAndMop", withMaxPlus).fan_power).toBe(102);
		expect(cleaningModeValues("mop", withMaxPlus).fan_power).toBe(105);
		expect(cleaningModeValues("general", withMaxPlus).fan_power).toBe(102);
	});

	it("leaves mop_mode out for models that have no routes", () => {
		const values = cleaningModeValues("vacAndMop", VAC_AND_MOP, { mopRoutes: false });
		expect(values).toEqual({ fan_power: 102, water_box_mode: 201 });
		expect(cleaningModeValues("custom", {}, { mopRoutes: false })).toEqual({ fan_power: 106, water_box_mode: 204 });
	});

	it("round-trips: what it produces derives back to the mode that was asked for", () => {
		const modes: CleaningMode[] = ["vacAndMop", "mop", "vacuum", "custom", "smart"];
		const starts = [
			{},
			VAC_AND_MOP,
			{ fan_power: 108, water_box_mode: 200, mop_mode: 304 },
			{ fan_power: 105, water_box_mode: 203, mop_mode: 305 },
			{ fan_power: 106, water_box_mode: 204, mop_mode: 302 },
			{ fan_power: 110, water_box_mode: 209, mop_mode: 306 }
		];

		for (const mode of modes) {
			for (const start of starts) {
				expect(deriveCleaningMode(cleaningModeValues(mode, start))).toBe(mode);
			}
		}
	});

	it("round-trips for robots without the pure modes too", () => {
		for (const start of [{}, VAC_AND_MOP, { fan_power: 106, water_box_mode: 204, mop_mode: 302 }]) {
			expect(deriveCleaningMode(cleaningModeValues("general", start), { pureCleanMop: false })).toBe("general");
			expect(deriveCleaningMode(cleaningModeValues("custom", start), { pureCleanMop: false })).toBe("custom");
		}
	});
});

describe("route options per mode", () => {
	it("offers all four routes on mop-only and two everywhere else", () => {
		expect(cleaningModeRouteOptions("mop")).toEqual([304, 300, 301, 303]);
		for (const mode of ["vacAndMop", "vacuum", "custom", "smart", "general"] as CleaningMode[]) {
			expect(cleaningModeRouteOptions(mode)).toEqual([304, 300]);
		}
	});
});

describe("which models have MAX+", () => {
	it("covers the test device and the other models the plugin table proves", () => {
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a65")).toBe(true); // TopazSC, named outright
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a64")).toBe(true);
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a50")).toBe(true); // Ultron, newDefaultFeatures
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a94")).toBe(true); // UltronSC, copies Ultron
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a147")).toBe(true); // Verdelite, inherits UltronSV
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a179")).toBe(true); // R50, two inheritance hops
	});

	it("excludes the three models whose config filters the feature out again", () => {
		// Pearl, TopazS and TanosS spread newDefaultFeatures - which contains CleanMode_MaxPlus - and
		// then remove it again in their `remake` callback. A text search for the feature name finds
		// exactly these three and gets them backwards.
		for (const model of ["a74", "a75", "a29", "a30", "a76", "a14", "a15"]) {
			expect(supportsCleanModeMaxPlus(`roborock.vacuum.${model}`)).toBe(false);
		}
	});

	it("counts the models of both features", () => {
		expect(CLEAN_MODE_MAX_PLUS_MODELS.size).toBe(38);
		expect(MAX_PLUS_WITHOUT_PURE_CLEAN_MOP_MODELS.size).toBe(8);
	});

	it("also accepts the second route to MAX+, the one without the pure modes", () => {
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a72")).toBe(true); // UltronE
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a124")).toBe(true); // UltronSE, copies UltronE
		// ...and those models are exactly the ones that have no vacuum-only / mop-only mode.
		for (const model of MAX_PLUS_WITHOUT_PURE_CLEAN_MOP_MODELS) {
			expect(NO_PURE_CLEAN_MOP_MODELS.has(model)).toBe(true);
		}
	});

	it("says no for an unknown model and for no model at all", () => {
		expect(supportsCleanModeMaxPlus("roborock.vacuum.a999")).toBe(false);
		expect(supportsCleanModeMaxPlus(null)).toBe(false);
		expect(supportsCleanModeMaxPlus(undefined)).toBe(false);
		expect(supportsCleanModeMaxPlus("")).toBe(false);
	});

	it("normalises the model string the way the other model tables do", () => {
		expect(supportsCleanModeMaxPlus(" ROBOROCK.VACUUM.A65 ")).toBe(true);
	});

	it("keeps the two feature lists disjoint - the plugin never gives a model both", () => {
		for (const model of CLEAN_MODE_MAX_PLUS_MODELS) {
			expect(MAX_PLUS_WITHOUT_PURE_CLEAN_MOP_MODELS.has(model)).toBe(false);
		}
	});
});

describe("which models have the pure modes", () => {
	it("blocks exactly the legacy products the plugin's block list names", () => {
		expect(NO_PURE_CLEAN_MOP_MODELS.size).toBe(29);
		for (const model of ["s6", "t7", "a10", "a38", "a40", "s4", "s5e", "a08", "a19", "a72", "a124"]) {
			expect(supportsPureCleanMop(`roborock.vacuum.${model}`)).toBe(false);
		}
	});

	it("treats every other model, known or not, as capable", () => {
		expect(supportsPureCleanMop("roborock.vacuum.a65")).toBe(true);
		expect(supportsPureCleanMop("roborock.vacuum.a999")).toBe(true);
		expect(supportsPureCleanMop(null)).toBe(true);
	});

	it("offers the three real modes, or the single combined one", () => {
		expect(cleaningModesForModel("roborock.vacuum.a65")).toEqual(["vacAndMop", "mop", "vacuum"]);
		expect(cleaningModesForModel("roborock.vacuum.s6")).toEqual(["general"]);
	});
});

describe("the generated set_clean_motor_mode presets", () => {
	it("replaces the four wrong hand-written entries with payloads the app would send", () => {
		const presets = buildCleanMotorModePresets("roborock.vacuum.a65");

		expect(presets).toEqual({
			'{"fan_power":102,"mop_mode":300,"water_box_mode":201}': "Vac & Mop",
			'{"fan_power":105,"mop_mode":300,"water_box_mode":201}': "Mop",
			'{"fan_power":102,"mop_mode":300,"water_box_mode":200}': "Vacuum"
		});
	});

	it("never offers a payload the app itself would undo", () => {
		for (const model of ["roborock.vacuum.a65", "roborock.vacuum.s6"]) {
			for (const payload of Object.keys(buildCleanMotorModePresets(model))) {
				const values = JSON.parse(payload);
				expect(values.mop_mode).not.toBe(301);
				expect(values.mop_mode).not.toBe(303);
				expect(values.mop_mode).not.toBe(305);
				expect(values.mop_mode).not.toBe(306);
				if (values.fan_power === 108) {
					expect(values.water_box_mode).toBe(200);
				}
			}
		}
	});

	it("labels every preset with the mode it really is", () => {
		const presets = buildCleanMotorModePresets("roborock.vacuum.a65");
		for (const [payload, label] of Object.entries(presets)) {
			const mode = deriveCleaningMode(JSON.parse(payload));
			expect(mode).not.toBeNull();
			expect(label).toBe(CLEANING_MODE_STATES[CLEANING_MODE_STATE_VALUES[mode as CleaningMode]]);
		}
	});

	it("gives a robot without the pure modes its one combined entry", () => {
		expect(buildCleanMotorModePresets("roborock.vacuum.s6")).toEqual({
			'{"fan_power":102,"mop_mode":300,"water_box_mode":201}': "General"
		});
	});

	it("leaves mop_mode out of the payload for models without routes", () => {
		const presets = buildCleanMotorModePresets("roborock.vacuum.a65", {}, { mopRoutes: false });
		expect(Object.keys(presets)).toEqual([
			'{"fan_power":102,"water_box_mode":201}',
			'{"fan_power":105,"water_box_mode":201}',
			'{"fan_power":102,"water_box_mode":200}'
		]);
	});

	it("has a label for every encoded mode and no duplicates", () => {
		const values = Object.values(CLEANING_MODE_STATE_VALUES);
		expect(new Set(values).size).toBe(values.length);
		for (const value of values) {
			expect(typeof CLEANING_MODE_STATES[value]).toBe("string");
		}
	});
});
