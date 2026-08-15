import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * Removing an entry from `common.states` - the one object update js-controller cannot express.
 *
 * `extendObject` merges the update into the stored object with `node.extend(true, …)`, which
 * descends into nested objects and only ever adds or overwrites. A key left out of the update
 * therefore survives, so every deletion the adapter makes - a water level the robot proves it does
 * not have, a suction level a model never had - would reach a fresh installation and no other.
 *
 * The store below reproduces that merge faithfully (see `node.extend@2.0.3/lib/extend.js`), so a
 * test that passes here would have failed against the real controller too.
 *
 * `node.extend(true, target, source)`: recurse into plain objects, skip `undefined`.
 */
function deepExtend(target: any, source: any): any {
	const merged: Record<string, any> = { ...target };
	for (const key of Object.keys(source ?? {})) {
		const value = source[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const base = merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key]) ? merged[key] : {};
			merged[key] = deepExtend(base, value);
		} else if (value !== undefined) {
			merged[key] = value;
		}
	}
	return merged;
}

async function createRoborock(): Promise<{ adapter: any; store: Record<string, any>; extendObject: any; setObject: any }> {
	const { Roborock } = await import("../../src/main");
	const store: Record<string, any> = {};

	const extendObject = vi.fn().mockImplementation(async (id: string, obj: any) => {
		store[id] = deepExtend(store[id] ?? {}, obj);
	});

	// `setObject` replaces instead of merging; the objects client carries `common.custom` and the
	// other preserved settings over by itself, which is why nothing a user configured is lost.
	const setObject = vi.fn().mockImplementation(async (id: string, obj: any) => {
		const preserved = store[id]?.common?.custom;
		store[id] = { ...obj, common: preserved === undefined ? obj.common : { custom: preserved, ...obj.common } };
	});

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		translations: {},
		rLog: vi.fn(),
		errorMessage: (error: unknown): string => error instanceof Error ? error.message : String(error),
		extendObject,
		setObject,
		getObjectAsync: vi.fn().mockImplementation(async (id: string) => store[id] ?? null),
		setObjectNotExistsAsync: vi.fn().mockImplementation(async (id: string, obj: any) => {
			if (!store[id]) store[id] = obj;
		})
	});

	return { adapter, store, extendObject, setObject };
}

const PATH = "Devices.duid1.commands.set_water_box_custom_mode";

function seedWaterCommand(store: Record<string, any>, extra: Record<string, unknown> = {}): void {
	store[PATH] = {
		type: "state",
		common: {
			name: "Water Box Mode",
			type: "number",
			role: "level",
			read: true,
			write: true,
			def: 201,
			states: { 201: "Mild", 202: "Standard", 203: "Intense", 208: "Extreme" },
			...extra
		},
		native: { origin: "vacuum" }
	};
}

describe("removing an entry from common.states", () => {
	it("proves the problem: a plain extendObject leaves the removed level standing", async () => {
		const { store, extendObject } = await createRoborock();
		seedWaterCommand(store);

		await extendObject(PATH, { common: { states: { 201: "Mild", 202: "Standard", 203: "Intense" } } });

		expect(store[PATH].common.states).toHaveProperty("208", "Extreme");
	});

	it("writes the whole object instead, so the level really disappears", async () => {
		const { adapter, store, setObject, extendObject } = await createRoborock();
		seedWaterCommand(store);

		await adapter.applyCommonUpdate(PATH, store[PATH], { states: { 201: "Mild", 202: "Standard", 203: "Intense" } });

		expect(store[PATH].common.states).toEqual({ 201: "Mild", 202: "Standard", 203: "Intense" });
		expect(setObject).toHaveBeenCalledTimes(1);
		expect(extendObject).not.toHaveBeenCalled();
	});

	it("keeps the rest of common and the native block while doing so", async () => {
		const { adapter, store } = await createRoborock();
		seedWaterCommand(store, { unit: "" });

		await adapter.applyCommonUpdate(PATH, store[PATH], { states: { 201: "Mild" } });

		expect(store[PATH].common).toMatchObject({ name: "Water Box Mode", role: "level", def: 201, unit: "", write: true });
		expect(store[PATH].native).toEqual({ origin: "vacuum" });
		expect(store[PATH].type).toBe("state");
	});

	it("does not throw away a user's history settings", async () => {
		const { adapter, store } = await createRoborock();
		seedWaterCommand(store, { custom: { "history.0": { enabled: true } } });

		await adapter.applyCommonUpdate(PATH, store[PATH], { states: { 201: "Mild" } });

		expect(store[PATH].common.custom).toEqual({ "history.0": { enabled: true } });
	});

	it("stays on the cheap merge when the update only adds", async () => {
		const { adapter, store, setObject, extendObject } = await createRoborock();
		seedWaterCommand(store);

		await adapter.applyCommonUpdate(PATH, store[PATH], {
			states: { 201: "Mild", 202: "Standard", 203: "Intense", 208: "Extreme", 207: "Custom" }
		});

		expect(extendObject).toHaveBeenCalledTimes(1);
		expect(setObject).not.toHaveBeenCalled();
		expect(store[PATH].common.states).toHaveProperty("207", "Custom");
	});

	it("leaves an unchanged object alone", async () => {
		const { adapter, store, setObject, extendObject } = await createRoborock();
		seedWaterCommand(store);

		await adapter.applyCommonUpdate(PATH, store[PATH], { role: "level" });

		expect(setObject).not.toHaveBeenCalled();
		expect(extendObject).toHaveBeenCalledTimes(1);
	});
});

describe("ensureState on an object whose states shrank", () => {
	const STATUS_PATH = "Devices.duid1.deviceStatus.water_box_mode";

	function seedStatus(store: Record<string, any>): void {
		store[STATUS_PATH] = {
			type: "state",
			common: {
				name: "water_box_mode",
				type: "number",
				role: "value",
				read: true,
				write: false,
				states: { 201: "Mild", 202: "Standard", 203: "Intense", 208: "Extreme" }
			},
			native: {}
		};
	}

	it("drops the removed level from the stored object", async () => {
		const { adapter, store } = await createRoborock();
		seedStatus(store);

		await adapter.ensureState(STATUS_PATH, { type: "number", states: { 201: "Mild", 202: "Standard", 203: "Intense" } });

		expect(store[STATUS_PATH].common.states).toEqual({ 201: "Mild", 202: "Standard", 203: "Intense" });
	});

	it("still creates a missing object the ordinary way", async () => {
		const { adapter, store, setObject } = await createRoborock();

		await adapter.ensureState(STATUS_PATH, { type: "number", states: { 201: "Mild" } });

		expect(store[STATUS_PATH].common.states).toEqual({ 201: "Mild" });
		expect(setObject).not.toHaveBeenCalled();
	});

	it("writes nothing at all when the definition did not change", async () => {
		const { adapter, store, setObject, extendObject } = await createRoborock();
		seedStatus(store);

		await adapter.ensureState(STATUS_PATH, {
			type: "number",
			states: { 201: "Mild", 202: "Standard", 203: "Intense", 208: "Extreme" }
		});

		expect(setObject).not.toHaveBeenCalled();
		expect(extendObject).not.toHaveBeenCalled();
	});
});

/**
 * The whole chain at once, on the installation the fault was reported from.
 *
 * Everything above tests one link. This runs the real `A65Features` against the real `ensureState`
 * and `applyCommonUpdate` from `src/main.ts` and the real object store, starting from **objects
 * that already exist and already carry 208** - an upgraded installation, not a fresh one, which is
 * the case a mocked `getObjectAsync` returning null cannot reproduce.
 *
 * The robot's answers are the measured ones: `get_status` as the reference device really sends it,
 * without either feature bitfield, and `app_get_init_status` with the string that has bit 45 clear
 * (`_appanalysis/geraetefaehigkeiten-1786790619395.json`).
 *
 * It also settles the "second copy of the list" question, which cannot be answered by reading:
 * whatever source each of the two objects is written from, the level has to be gone from both when
 * the poll is over.
 */
describe("the Extreme level on an installation that already has it", () => {
	const COMMAND_PATH = "Devices.duid1.commands.set_water_box_custom_mode";
	const STATUS_PATH = "Devices.duid1.deviceStatus.water_box_mode";
	const WITH_EXTREME = { 201: "Mild", 202: "Standard", 203: "Intense", 208: "Extreme" };
	const WITHOUT_EXTREME = { 201: "Mild", 202: "Standard", 203: "Intense" };

	/** `app_get_init_status` of the reference robot, verbatim. Bit 45 of the string is clear. */
	const INIT_ANSWER = [{
		local_info: { name: "custom_A.03.0309_CE", featureset: 3 },
		feature_info: [111, 112, 125],
		new_feature_info: 2247395306799103,
		new_feature_info_str: "0008004056C8FFFE"
	}];

	/** `get_prop(["get_status"])` of the reference robot - neither bitfield among its fields. */
	const STATUS_ANSWER = [{
		state: 8, battery: 100, fan_power: 102, water_box_mode: 201, mop_mode: 300,
		error_code: 0, in_cleaning: 0, map_status: 3, lock_status: 0, dss: 0
	}];

	async function runPoll(): Promise<Record<string, any>> {
		const { adapter, store } = await createRoborock();

		for (const [path, common] of [
			[COMMAND_PATH, { name: "Water Box Mode", type: "number", role: "level", read: true, write: true, def: 201, states: { ...WITH_EXTREME } }],
			[STATUS_PATH, { name: "water_box_mode", type: "number", role: "value", read: true, write: false, states: { ...WITH_EXTREME } }]
		] as [string, Record<string, unknown>][]) {
			store[path] = { type: "state", common, native: {} };
		}

		Object.assign(adapter, {
			namespace: "roborock.0",
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
			setStateChanged: vi.fn().mockResolvedValue(undefined),
			setState: vi.fn().mockResolvedValue(undefined),
			getStateAsync: vi.fn().mockResolvedValue(null),
			delObjectAsync: vi.fn().mockResolvedValue(undefined),
			getDeviceProtocolVersion: vi.fn().mockResolvedValue("1.0"),
			translationManager: { get: vi.fn().mockImplementation((_key: string, def: string) => def) },
			http_api: { getDevices: vi.fn().mockReturnValue([]), getFwFeaturesResult: vi.fn(), storeFwFeaturesResult: vi.fn() },
			requestsHandler: {
				sendRequest: vi.fn().mockImplementation(async (_duid: string, method: string, params: unknown) => {
					if (method === "app_get_init_status") return INIT_ANSWER;
					if (method === "get_prop" && Array.isArray(params) && params[0] === "get_status") return STATUS_ANSWER;
					return {};
				})
			}
		});

		const deps = {
			adapter,
			http_api: adapter.http_api,
			log: adapter.log,
			config: { staticFeatures: [] },
			ensureState: (path: string, common: any, native?: any) => adapter.ensureState(path, common, native),
			ensureFolder: vi.fn().mockResolvedValue(undefined)
		};

		const { A65Features } = await import("../../src/lib/features/vacuum/a65_features");
		const vacuum = new A65Features(deps as any, "duid1") as any;

		await vacuum.setupProtocolFeatures();
		await vacuum.updateInitStatus();
		await vacuum.updateStatus();

		return store;
	}

	it("takes the level off both objects, though the robot never puts the bit in its status", async () => {
		const store = await runPoll();

		expect(store[COMMAND_PATH].common.states).toEqual(WITHOUT_EXTREME);
		expect(store[STATUS_PATH].common.states).toEqual(WITHOUT_EXTREME);
	});

	it("leaves everything else on those objects intact", async () => {
		const store = await runPoll();

		expect(store[COMMAND_PATH].common).toMatchObject({ name: "Water Box Mode", role: "level", write: true, def: 201 });
		expect(store[COMMAND_PATH].type).toBe("state");
	});

	it("publishes the bitfields the other three readers go looking for", async () => {
		const store = await runPoll();

		expect(store["Devices.duid1.deviceStatus.new_feature_info_str"].common.type).toBe("string");
		expect(store["Devices.duid1.deviceStatus.new_feature_info"].common.type).toBe("number");
	});
});
