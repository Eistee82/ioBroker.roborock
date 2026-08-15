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
		errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
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
			201: "Mild",
			202: "Standard",
			203: "Intense",
			208: "Extreme"
		});
	});

	it("leaves a robot without the vibrating mop on the standard wording", () => {
		const vacuum = new A87Features(createDeps(), "duid1") as any;

		expect(vacuum.profile.mappings.water_box_mode).toEqual({
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

/**
 * `water_box_mode = 208` is gated on `DM.support(MF.Mop_ShakeModule)` *and*
 * `isNewFeatureStrSupport(NewFeatureStrBit.MopShakeWaterMax)`, and `MopShakeWaterMax` is bit 45 of
 * `new_feature_info_str` (control plugin lines 231849, 237242, 243294-243615 - see
 * {@link MOP_SHAKE_WATER_MAX_BIT}). The model half is applied in the constructor; this is the half
 * only the robot can answer.
 */
describe("the Extreme water level and feature bit 45", () => {
	/** Hex string with the given bits set, in the shape the robot reports. */
	function featureStr(...bits: number[]): string {
		return bits.reduce((value, bit) => value | (1n << BigInt(bit)), 0n).toString(16);
	}

	async function processStatus(status: Record<string, unknown>): Promise<{ vacuum: any; deps: FeatureDependencies }> {
		const deps = createDeps();
		const vacuum = new A65Features(deps, "duid1") as any;
		await vacuum.processStatus({ state: 8, ...status });
		return { vacuum, deps };
	}

	it("removes it when the robot reports the field without bit 45", async () => {
		const { vacuum } = await processStatus({ new_feature_info_str: featureStr(22, 67) });

		expect(vacuum.profile.mappings.water_box_mode).toEqual({ 201: "Mild", 202: "Standard", 203: "Intense" });
	});

	it("keeps it when the robot announces bit 45", async () => {
		const { vacuum } = await processStatus({ new_feature_info_str: featureStr(45) });

		expect(vacuum.profile.mappings.water_box_mode[208]).toBe("Extreme");
	});

	it("keeps it when the robot does not report the field at all", async () => {
		const { vacuum } = await processStatus({});

		expect(vacuum.profile.mappings.water_box_mode[208]).toBe("Extreme");
	});

	it("keeps it when the field is there but unreadable - a broken value takes nothing away", async () => {
		for (const raw of ["", "   ", "not hex", 45, null]) {
			const { vacuum } = await processStatus({ new_feature_info_str: raw });

			expect(vacuum.profile.mappings.water_box_mode[208]).toBe("Extreme");
		}
	});

	it("treats a string too short to hold bit 45 as 'not announced'", async () => {
		// The app reads bit 45 as nibble 11 counted from the end; on an eight-character string that
		// slice is empty and it reads 0. Anything shorter than twelve hex digits cannot carry it.
		const { vacuum } = await processStatus({ new_feature_info_str: "ffffffff" });

		expect(vacuum.profile.mappings.water_box_mode[208]).toBeUndefined();
	});

	it("rewrites the command object so the picker loses the entry too", async () => {
		const deps = createDeps();
		const adapter = deps.adapter as any;
		adapter.getObjectAsync = vi.fn().mockResolvedValue({
			type: "state",
			common: { states: { 201: "Mild", 202: "Standard", 203: "Intense", 208: "Extreme" } },
			native: {}
		});
		const vacuum = new A65Features(deps, "duid1") as any;

		await vacuum.processStatus({ water_box_mode: 201, new_feature_info_str: featureStr(22) });

		const call = adapter.applyCommonUpdate.mock.calls.find((c: any[]) => String(c[0]).endsWith("commands.set_water_box_custom_mode"));
		expect(call).toBeDefined();
		expect(call![2].states).toEqual({ 201: "Mild", 202: "Standard", 203: "Intense" });
	});

	it("publishes the shortened list on deviceStatus in the same pass", async () => {
		const { deps } = await processStatus({ water_box_mode: 201, new_feature_info_str: featureStr(22) });

		const call = (deps.ensureState as any).mock.calls.find((c: any[]) => String(c[0]).endsWith("deviceStatus.water_box_mode"));
		expect(call).toBeDefined();
		expect(call![1].states).toEqual({ 201: "Mild", 202: "Standard", 203: "Intense" });
	});

	it("also closes the write path, so the level cannot be set by hand any more", async () => {
		const vacuum = new A65Features(createDeps(), "duid1") as any;
		// The command specs exist by the time a status arrives: `initialize()` builds them before it
		// fetches anything. Only that first step is needed here.
		await vacuum.setupProtocolFeatures();
		expect(vacuum.getCommandSpec("commands", "set_water_box_custom_mode").states[208]).toBe("Extreme");

		await vacuum.processStatus({ new_feature_info_str: featureStr(22) });

		expect(vacuum.getCommandSpec("commands", "set_water_box_custom_mode").states).toEqual({
			201: "Mild",
			202: "Standard",
			203: "Intense"
		});
	});

	it("does the work once and then stops touching the objects", async () => {
		const deps = createDeps();
		const adapter = deps.adapter as any;
		const vacuum = new A65Features(deps, "duid1") as any;
		const status = { water_box_mode: 201, new_feature_info_str: featureStr(22) };

		await vacuum.processStatus({ ...status });
		const afterFirst = adapter.applyCommonUpdate.mock.calls.length;
		await vacuum.processStatus({ ...status });

		expect(adapter.applyCommonUpdate.mock.calls.length).toBe(afterFirst);
	});

	it("leaves a level a model profile worded itself alone", async () => {
		const deps = createDeps();
		const vacuum = new V1VacuumFeatures(
			deps,
			"duid1",
			"roborock.vacuum.a65",
			{ staticFeatures: [] },
			{ mappings: { fan_power: { 102: "Balanced" }, water_box_mode: { 201: "Low", 203: "High", 208: "Flood" } } }
		) as any;

		await vacuum.processStatus({ new_feature_info_str: featureStr(22) });

		expect(vacuum.profile.mappings.water_box_mode[208]).toBe("Flood");
	});

	it("does not go looking for the level on a robot that never had it", async () => {
		const deps = createDeps();
		const adapter = deps.adapter as any;
		const vacuum = new A87Features(deps, "duid1") as any;

		await vacuum.processStatus({ water_box_mode: 201, new_feature_info_str: featureStr(22) });

		expect(vacuum.profile.mappings.water_box_mode[208]).toBeUndefined();
		expect(adapter.applyCommonUpdate).not.toHaveBeenCalled();
	});
});

/**
 * The gate above is correct and did nothing on the reference robot, because the field it reads is
 * not in that robot's status packet: `get_status` answers 51 fields and carries neither bitfield,
 * measured twice 4 h 47 min apart (`_appanalysis/geraetefaehigkeiten-1786790619395.json` and
 * `…-1786807834553.json`). Both are answered by `app_get_init_status` alone, which the adapter did
 * not call at all - so `readFeatureStr(undefined)` returned null, the conservative branch kept the
 * level, and the dead control stayed on screen.
 */
describe("where the feature bitfields come from", () => {
	/** The reference robot's own answer, verbatim from the measurement. */
	const A65_FEATURE_STR = "0008004056C8FFFE";
	const A65_FEATURE_INFO = 2247395306799103;
	const INIT_ANSWER = [{
		local_info: { name: "custom_A.03.0309_CE", featureset: 3 },
		feature_info: [111, 125],
		new_feature_info: A65_FEATURE_INFO,
		new_feature_info_str: A65_FEATURE_STR
	}];

	/**
	 * A65 whose robot answers `app_get_init_status` with `answer` and everything else with `{}`.
	 * @param answer What the method returns, or an Error it throws.
	 */
	function createVacuum(answer: unknown): { vacuum: any; deps: FeatureDependencies; sent: string[] } {
		const deps = createDeps();
		const adapter = deps.adapter as any;
		const sent: string[] = [];

		adapter.requestsHandler.sendRequest = vi.fn().mockImplementation(async (_duid: string, method: string) => {
			sent.push(method);
			if (method !== "app_get_init_status") return {};
			if (answer instanceof Error) throw answer;
			return answer;
		});

		return { vacuum: new A65Features(deps, "duid1") as any, deps, sent };
	}

	it("takes Extreme away on a robot whose status packet never carries the field", async () => {
		const { vacuum } = createVacuum(INIT_ANSWER);

		await vacuum.updateInitStatus();
		// The reference robot's status: no `new_feature_info_str` anywhere in it.
		await vacuum.processStatus({ state: 8, water_box_mode: 201 });

		expect(vacuum.profile.mappings.water_box_mode).toEqual({ 201: "Mild", 202: "Standard", 203: "Intense" });
	});

	it("asks for the bitfields before the status packet that acts on them", async () => {
		const { vacuum, sent } = createVacuum(INIT_ANSWER);

		await vacuum.initializeDeviceData();

		expect(sent).toContain("app_get_init_status");
		expect(sent.indexOf("app_get_init_status")).toBeLessThan(sent.indexOf("get_prop"));
		expect(vacuum.profile.mappings.water_box_mode[208]).toBeUndefined();
	});

	it("publishes both bitfields as deviceStatus states, which is where the other three readers look", async () => {
		const { vacuum, deps } = createVacuum(INIT_ANSWER);

		await vacuum.updateInitStatus();

		const written = (deps.ensureState as any).mock.calls.map((call: any[]) => String(call[0]));
		expect(written).toContain("Devices.duid1.deviceStatus.new_feature_info_str");
		expect(written).toContain("Devices.duid1.deviceStatus.new_feature_info");

		const setState = (deps.adapter as any).setStateChanged.mock.calls;
		expect(setState.find((c: any[]) => String(c[0]).endsWith("new_feature_info_str"))![1].val).toBe(A65_FEATURE_STR);
		expect(setState.find((c: any[]) => String(c[0]).endsWith(".new_feature_info"))![1].val).toBe(A65_FEATURE_INFO);
	});

	it("keeps the level when the robot does not answer the method - silence is not a denial", async () => {
		const { vacuum } = createVacuum(new Error("unknown method"));

		await vacuum.updateInitStatus();
		await vacuum.processStatus({ state: 8, water_box_mode: 201 });

		expect(vacuum.profile.mappings.water_box_mode[208]).toBe("Extreme");
	});

	it("keeps the level when the answer has no shape it can read", async () => {
		for (const answer of [[], ["ok"], null, 5, [{ local_info: { featureset: 3 } }]]) {
			const { vacuum } = createVacuum(answer);

			await vacuum.updateInitStatus();
			await vacuum.processStatus({ state: 8 });

			expect(vacuum.profile.mappings.water_box_mode[208]).toBe("Extreme");
		}
	});

	it("lets the status packet win where a robot does report the field there", async () => {
		const { vacuum } = createVacuum(INIT_ANSWER);

		await vacuum.updateInitStatus();
		await vacuum.processStatus({ state: 8, new_feature_info_str: (1n << 45n).toString(16) });

		expect(vacuum.profile.mappings.water_box_mode[208]).toBe("Extreme");
	});
});
