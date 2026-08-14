import { describe, expect, it, vi } from "vitest";

import { FeatureDependencies } from "../baseDeviceFeatures";
import {
	FAN_POWER_LABELS,
	MOP_MODE_LABELS,
	SHAKE_MOP_MODELS,
	VACUUM_CONSTANTS,
	WATER_BOX_MODE_LABELS,
	usesShakeMopWaterLabels
} from "./vacuumConstants";
import { BASE_WATER, V1VacuumFeatures } from "./v1VacuumFeatures";
import { A65Features } from "./a65_features";
import { A298Features } from "./a298_features";
import { A87Features } from "./a87_features";

function createDeps(): FeatureDependencies {
	const adapter: any = {
		namespace: "roborock.0",
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
		translations: {},
		rLog: vi.fn(),
		setStateChanged: vi.fn().mockResolvedValue(undefined),
		extendObject: vi.fn().mockResolvedValue(undefined),
		getDeviceProtocolVersion: vi.fn().mockResolvedValue("1.0"),
		http_api: {
			getDevices: vi.fn().mockReturnValue([]),
			getFwFeaturesResult: vi.fn(),
			storeFwFeaturesResult: vi.fn()
		},
		requestsHandler: { sendRequest: vi.fn().mockResolvedValue({}) },
		translationManager: { get: vi.fn().mockImplementation((key, def) => def || key) }
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

describe("cleaning mode labels", () => {
	it("shows fan_power 105 as Gentle, the way the app does, and never as Off", () => {
		expect(FAN_POWER_LABELS[105]).toBe("Gentle");
		expect(VACUUM_CONSTANTS.deviceStates.fan_power.states[105]).toBe("Gentle");
		expect(VACUUM_CONSTANTS.baseCommands.set_custom_mode.states[105]).toBe("Gentle");
		expect(VACUUM_CONSTANTS.deviceStates.wind.states[105]).toBe("Gentle");
		expect(Object.values(VACUUM_CONSTANTS.deviceStates.fan_power.states)).not.toContain("Off");
	});

	it("documents the fan_power markers without making them look like levels", () => {
		expect(FAN_POWER_LABELS[106]).toBe("Per-Room");
		expect(FAN_POWER_LABELS[110]).toBe("SmartPlan");
		expect(FAN_POWER_LABELS[108]).toBe("Max+");
		// 107 and 109 appear nowhere in the plugin bundle.
		expect(FAN_POWER_LABELS[107]).toBeUndefined();
		expect(FAN_POWER_LABELS[109]).toBeUndefined();
	});

	it("keeps the markers out of every selectable list", () => {
		for (const marker of [106, 110]) {
			expect(VACUUM_CONSTANTS.baseCommands.set_custom_mode.states).not.toHaveProperty(String(marker));
		}
	});

	it("completes mop_mode with 302, 305 and 306 and gives 303/305 the same label", () => {
		expect(MOP_MODE_LABELS[302]).toBe("Per-Room");
		expect(MOP_MODE_LABELS[305]).toBe(MOP_MODE_LABELS[303]);
		expect(MOP_MODE_LABELS[306]).toBe("SmartPlan");
		expect(VACUUM_CONSTANTS.deviceStates.mop_mode.states).toEqual(MOP_MODE_LABELS);
	});

	it("stops calling 208 and 209 Custom and names the one value that really is", () => {
		expect(WATER_BOX_MODE_LABELS[207]).toBe("Custom");
		expect(WATER_BOX_MODE_LABELS[208]).toBe("Extreme");
		expect(WATER_BOX_MODE_LABELS[209]).toBe("SmartPlan");
		expect(WATER_BOX_MODE_LABELS[204]).toBe("Per-Room");
	});

	it("leaves 205 and 206 alone - they are neither proven nor disproven", () => {
		expect(WATER_BOX_MODE_LABELS[205]).toBe("Custom");
		expect(WATER_BOX_MODE_LABELS[206]).toBe("Custom");
	});

	it("uses the app's standard water wording, not the invented 'Moderate'", () => {
		expect(BASE_WATER).toEqual({ 200: "Off", 201: "Low", 202: "Medium", 203: "High" });
		expect(Object.values(VACUUM_CONSTANTS.deviceStates.water.states)).not.toContain("Moderate");
	});

	it("resolves in_cleaning the way the second bundle proves it", () => {
		expect(VACUUM_CONSTANTS.deviceStates.in_cleaning.states).toMatchObject({
			0: "None",
			1: "Global Clean",
			2: "Zone Clean",
			3: "Segment Clean"
		});
	});
});

describe("vibrating-mop water wording", () => {
	it("recognises exactly the 18 models the plugin's feature table lists", () => {
		expect(SHAKE_MOP_MODELS.size).toBe(18);
		expect(usesShakeMopWaterLabels("roborock.vacuum.a65")).toBe(true);
		expect(usesShakeMopWaterLabels("ROBOROCK.VACUUM.A65 ")).toBe(true);
		expect(usesShakeMopWaterLabels("roborock.vacuum.a87")).toBe(false);
		expect(usesShakeMopWaterLabels(null)).toBe(false);
		expect(usesShakeMopWaterLabels(undefined)).toBe(false);
		expect(usesShakeMopWaterLabels("")).toBe(false);
	});

	it("words the S7 Max Ultra's water levels Mild / Standard / Intense and offers Extreme", () => {
		const vacuum = new A65Features(createDeps(), "duid1") as any;

		expect(vacuum.profile.mappings.water_box_mode).toEqual({
			200: "Off",
			201: "Mild",
			202: "Standard",
			203: "Intense",
			208: "Extreme"
		});
	});

	it("leaves a robot without the vibrating mop on the standard wording", () => {
		const vacuum = new A87Features(createDeps(), "duid1") as any;

		expect(vacuum.profile.mappings.water_box_mode).toEqual({
			200: "Off",
			201: "Low",
			202: "Medium",
			203: "High"
		});
		expect(vacuum.profile.mappings.water_box_mode[208]).toBeUndefined();
	});

	it("does not touch a model that declares its own water range", () => {
		const vacuum = new A298Features(createDeps(), "duid1") as any;

		expect(vacuum.profile.mappings.water_box_mode[221]).toBe("Very Light");
		expect(vacuum.profile.mappings.water_box_mode[208]).toBeUndefined();
	});

	it("keeps a deliberate per-model label instead of overwriting it", () => {
		const vacuum = new V1VacuumFeatures(
			createDeps(),
			"duid1",
			"roborock.vacuum.a65",
			{ staticFeatures: [] },
			{ mappings: { fan_power: { 102: "Balanced" }, water_box_mode: { 200: "Off", 202: "House blend", 203: "High" } } }
		) as any;

		expect(vacuum.profile.mappings.water_box_mode).toEqual({
			200: "Off",
			202: "House blend",
			203: "Intense",
			208: "Extreme"
		});
	});

	it("does not mutate the shared profile constants", () => {
		new A65Features(createDeps(), "duid1");

		expect(BASE_WATER[201]).toBe("Low");
		expect(BASE_WATER[208]).toBeUndefined();
	});
});
