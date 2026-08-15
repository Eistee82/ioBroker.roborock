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
