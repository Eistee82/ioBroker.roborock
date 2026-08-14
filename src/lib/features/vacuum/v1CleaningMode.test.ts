import { describe, expect, it, vi } from "vitest";

import { FeatureDependencies } from "../baseDeviceFeatures";
import { Feature } from "../features.enum";
import { A147Features } from "./a147_features";
import { A65Features } from "./a65_features";
import { A75Features } from "./a75_features";
import { BASE_FAN, BASE_MOP, BASE_WATER, V1VacuumFeatures, VacuumProfile } from "./v1VacuumFeatures";

function createDeps(): { deps: FeatureDependencies; adapter: any } {
	const adapter: any = {
		namespace: "roborock.0",
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
		translations: {},
		rLog: vi.fn(),
		setStateChanged: vi.fn().mockResolvedValue(undefined),
		extendObject: vi.fn().mockResolvedValue(undefined),
		getObjectAsync: vi.fn().mockResolvedValue({ common: {} }),
		getStateAsync: vi.fn().mockResolvedValue(undefined),
		getDeviceProtocolVersion: vi.fn().mockResolvedValue("1.0"),
		http_api: {
			getDevices: vi.fn().mockReturnValue([]),
			getFwFeaturesResult: vi.fn(),
			storeFwFeaturesResult: vi.fn()
		},
		requestsHandler: { sendRequest: vi.fn().mockResolvedValue({}) },
		translationManager: { get: vi.fn().mockImplementation((key, def) => def || key) }
	};

	const deps = {
		adapter,
		http_api: adapter.http_api,
		ensureState: vi.fn().mockResolvedValue(undefined),
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		log: adapter.log,
		config: { staticFeatures: [] }
	} as unknown as FeatureDependencies;

	return { deps, adapter };
}

/** A generic vacuum on the default profile - what a model without its own class gets. */
class GenericVacuum extends V1VacuumFeatures {
	protected getDynamicFeatures(): Set<Feature> {
		return new Set();
	}
	public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
		return false;
	}
}

function genericVacuum(model: string, profile?: VacuumProfile): { vacuum: any; adapter: any; deps: FeatureDependencies } {
	const { deps, adapter } = createDeps();
	const vacuum = new GenericVacuum(deps, "duid1", model, { staticFeatures: [] }, profile);
	return { vacuum: vacuum as any, adapter, deps };
}

describe("MAX+ is offered where the model table proves it", () => {
	it("adds fan_power 108 to a proven model that has no class of its own", () => {
		// UltronSC copies Ultron's features, which spread newDefaultFeatures - the feature is never
		// written next to the model, which is why a plain search for it misses these.
		const { vacuum } = genericVacuum("roborock.vacuum.a94");

		expect(vacuum.profile.mappings.fan_power[108]).toBe("Max+");
	});

	it("leaves a model the table does not prove on the four regular levels", () => {
		const { vacuum } = genericVacuum("roborock.vacuum.a39"); // TanosSC, no MAX+

		expect(vacuum.profile.mappings.fan_power[108]).toBeUndefined();
		expect(vacuum.profile.mappings.fan_power).toEqual(BASE_FAN);
	});

	it("does not give MAX+ to the models whose config filters it out again", () => {
		// Pearl spreads newDefaultFeatures and removes CleanMode_MaxPlus in its `remake` callback.
		const { vacuum } = genericVacuum("roborock.vacuum.a74");

		expect(vacuum.profile.mappings.fan_power[108]).toBeUndefined();
	});

	it("never takes a level away that a model profile declares itself", () => {
		// The a75 profile declares 108 although the plugin table filters it out for Pearl. The
		// profile was written for that device; withholding a level the robot may have is the worse
		// error, so it stays.
		const { deps } = createDeps();
		const vacuum = new A75Features(deps, "duid1") as any;

		expect(vacuum.profile.mappings.fan_power[108]).toBe("Max+");
	});

	it("leaves a profile alone that maps MAX+ onto another value", () => {
		// The Saros 10 profile calls fan_power 110 "Max+"; adding a second entry with the same label
		// would show the level twice.
		const { deps } = createDeps();
		const vacuum = new A147Features(deps, "duid1") as any;

		expect(vacuum.profile.mappings.fan_power[110]).toBe("Max+");
		expect(vacuum.profile.mappings.fan_power[108]).toBeUndefined();
	});

	it("keeps its hands off a model with a value range of its own", () => {
		const { vacuum } = genericVacuum("roborock.vacuum.a94", {
			mappings: { fan_power: { 1: "Low", 2: "High" } }
		});

		expect(vacuum.profile.mappings.fan_power).toEqual({ 1: "Low", 2: "High" });
	});

	it("does not mutate the shared BASE_FAN constant", () => {
		genericVacuum("roborock.vacuum.a94");

		expect(BASE_FAN[108]).toBeUndefined();
	});
});

describe("the set_clean_motor_mode presets", () => {
	it("offers the three real modes on a robot that has them", async () => {
		const { deps } = createDeps();
		const vacuum = new A65Features(deps, "duid1") as any;
		await vacuum.setupProtocolFeatures();

		expect(vacuum.commands.set_clean_motor_mode.states).toEqual({
			'{"fan_power":102,"mop_mode":300,"water_box_mode":201}': "Vac & Mop",
			'{"fan_power":105,"mop_mode":300,"water_box_mode":201}': "Mop",
			'{"fan_power":102,"mop_mode":300,"water_box_mode":200}': "Vacuum"
		});
		expect(vacuum.commands.set_clean_motor_mode.def).toBe('{"fan_power":102,"mop_mode":300,"water_box_mode":201}');
	});

	it("no longer ships the four payloads that contradicted the app", async () => {
		const { deps } = createDeps();
		const vacuum = new A65Features(deps, "duid1") as any;
		await vacuum.setupProtocolFeatures();

		const labels = Object.values(vacuum.commands.set_clean_motor_mode.states);
		expect(labels).not.toContain("Indv.");
		expect(labels).not.toContain("Saugen, dann Wischen");
		expect(labels).not.toContain("Smart Plan");
		// mop_mode 301 was offered for "Vac & Mop", a mode on which the app resets it to 300.
		expect(Object.keys(vacuum.commands.set_clean_motor_mode.states).join()).not.toContain('"mop_mode":301');
	});

	it("lets a model profile keep its own presets", async () => {
		const { deps } = createDeps();
		const vacuum = new A147Features(deps, "duid1") as any;
		await vacuum.setupProtocolFeatures();

		expect(vacuum.commands.set_clean_motor_mode.states).toHaveProperty(
			'{"fan_power":110,"mop_mode":306,"water_box_mode":209}',
			"SmartPlan"
		);
	});
});

describe("the derived cleaning mode reaches the object tree", () => {
	async function statusOf(model: string, status: Record<string, unknown>): Promise<{ ensured: any[]; written: any[] }> {
		const { vacuum, adapter, deps } = genericVacuum(model);
		await vacuum.processStatus(status);

		const path = "Devices.duid1.deviceStatus.clean_mode_tab";
		return {
			ensured: (deps.ensureState as any).mock.calls.filter((call: any[]) => call[0] === path),
			written: adapter.setStateChanged.mock.calls.filter((call: any[]) => call[0] === path)
		};
	}

	it("publishes the mode as a read-only state with the app's own labels", async () => {
		const { ensured, written } = await statusOf("roborock.vacuum.a65", {
			fan_power: 102,
			water_box_mode: 201,
			mop_mode: 300
		});

		expect(ensured).toHaveLength(1);
		expect(ensured[0][1]).toMatchObject({ type: "number", write: false, read: true });
		expect(ensured[0][1].states[2]).toBe("Vacuum");
		expect(written[0][1]).toEqual({ val: 0, ack: true });
	});

	it("reports vacuum-only and mop-only rather than 'water off' and 'weakest suction'", async () => {
		const vacuumOnly = await statusOf("roborock.vacuum.a65", { fan_power: 102, water_box_mode: 200, mop_mode: 300 });
		expect(vacuumOnly.written[0][1]).toEqual({ val: 2, ack: true });

		const mopOnly = await statusOf("roborock.vacuum.a65", { fan_power: 105, water_box_mode: 202, mop_mode: 303 });
		expect(mopOnly.written[0][1]).toEqual({ val: 1, ack: true });
	});

	it("gives a legacy robot the single combined mode", async () => {
		// TanosSC is on the plugin's block list for the pure modes.
		const { written } = await statusOf("roborock.vacuum.a39", { fan_power: 102, water_box_mode: 200 });

		expect(written[0][1]).toEqual({ val: 5, ack: true });
	});

	it("stays silent when the robot reported none of the three values", async () => {
		const { ensured, written } = await statusOf("roborock.vacuum.a65", { battery: 100, state: 8 });

		expect(ensured).toHaveLength(0);
		expect(written).toHaveLength(0);
	});

	it("does not call 110 SmartPlan on a model whose profile calls it Max+", async () => {
		const { deps, adapter } = createDeps();
		const vacuum = new A147Features(deps, "duid1") as any;
		await vacuum.processStatus({ fan_power: 110, water_box_mode: 202, mop_mode: 300 });

		const written = adapter.setStateChanged.mock.calls.filter(
			(call: any[]) => call[0] === "Devices.duid1.deviceStatus.clean_mode_tab"
		);
		expect(written[0][1]).toEqual({ val: 0, ack: true }); // Vac & Mop, not SmartPlan
	});

	it("does call 110 SmartPlan on a model whose profile does not claim the value", async () => {
		const { written } = await statusOf("roborock.vacuum.a65", { fan_power: 110, water_box_mode: 209, mop_mode: 306 });

		expect(written[0][1]).toEqual({ val: 4, ack: true });
	});

	it("leaves mop_mode out of the mode for a profile that has no routes", () => {
		const { vacuum } = genericVacuum("roborock.vacuum.a94", {
			mappings: { fan_power: BASE_FAN, water_box_mode: BASE_WATER }
		});

		expect(vacuum.getCleaningModeCapabilities()).toEqual({
			pureCleanMop: true,
			smartPlan: true,
			mopRoutes: false
		});
	});

	it("reports the capabilities the plugin table proves for the test device", () => {
		const { deps } = createDeps();
		const vacuum = new A65Features(deps, "duid1") as any;

		expect(vacuum.getCleaningModeCapabilities()).toEqual({
			pureCleanMop: true,
			smartPlan: true,
			mopRoutes: true
		});
		expect(vacuum.profile.mappings.mop_mode).toEqual(BASE_MOP);
	});
});
