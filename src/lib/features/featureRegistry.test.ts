import { describe, expect, it, vi } from "vitest";
import { BaseDeviceFeatures } from "./baseDeviceFeatures";
import type { FeatureDependencies } from "./baseDeviceFeatures";
import { Feature } from "./features.enum";

/**
 * `applyFeature` has to find its method whichever way the decorator was compiled.
 *
 * ## What this guards, and what it cannot
 *
 * The loader js-controller starts a TypeScript adapter with does not pass
 * `experimentalDecorators` to esbuild, so which decorator semantics apply is decided by whichever
 * esbuild version happens to be installed. Measured, under the conditions of an installed adapter:
 * 0.11-0.17 give the legacy form (registry on the prototype), 0.21 and later the standard form
 * (registry on the method function). Both are pinned here.
 *
 * **The third case cannot be tested and cannot be guarded**: esbuild 0.18 to 0.20 emit the
 * decorator verbatim, Node rejects it as a `SyntaxError`, and no code in this module runs at all.
 * That limit is stated at {@link BaseDeviceFeatures.findFeatureMethod} rather than papered over.
 *
 * ## Why the registries are built by hand
 *
 * A test cannot ask its own toolchain for the other semantics - vitest reads `tsconfig.json` and
 * always produces the legacy form. So both shapes are written directly onto the class, exactly as
 * the two transpilers write them: a `Map` on the prototype with method **names**, and a `Map` on
 * each method function with the decorator **context objects**.
 */

const REGISTRY_KEY = Symbol.for("roborock.featureRegistry");

/** Minimal dependencies; nothing here reaches the adapter. */
function deps(): FeatureDependencies {
	const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() };
	return {
		adapter: { log, rLog: vi.fn(), errorMessage: (e: any) => String(e?.message ?? e) },
		log,
		ensureState: vi.fn(),
		ensureFolder: vi.fn(),
		config: { staticFeatures: [] },
	} as unknown as FeatureDependencies;
}

/** A device class with one feature method and no decorator on it - the registry is added per test. */
class Probe extends BaseDeviceFeatures {
	public calls: string[] = [];

	protected getDynamicFeatures(): Set<Feature> {
		return new Set();
	}
	public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
		return false;
	}

	public async initConsumables(): Promise<void> {
		this.calls.push("initConsumables");
	}

	// The rest of the abstract surface; none of it is reached by these tests.
	public getCommonConsumable(): Partial<ioBroker.StateCommon> | undefined {
		return undefined;
	}
	public isResetableConsumable(): boolean {
		return false;
	}
	public getCommonDeviceStates(): Partial<ioBroker.StateCommon> | undefined {
		return undefined;
	}
	public getCommonCleaningRecords(): Partial<ioBroker.StateCommon> | undefined {
		return undefined;
	}
	public getFirmwareFeatureName(): string {
		return "";
	}
	public getCommonCleaningInfo(): Partial<ioBroker.StateCommon> | undefined {
		return undefined;
	}

	/** Exposes the protected method under test. */
	public async apply(feature: Feature): Promise<boolean> {
		return this.applyFeature(feature);
	}
}

function probe(): Probe {
	return new Probe(deps(), "duid-test", "roborock.vacuum.a65", { staticFeatures: [] } as any);
}

/** Removes both registry forms, so each test starts from a class that declares nothing. */
function clearRegistries(): void {
	delete (Probe.prototype as any)[REGISTRY_KEY];
	for (const name of Object.getOwnPropertyNames(Probe.prototype)) {
		const value = Object.getOwnPropertyDescriptor(Probe.prototype, name)?.value;
		if (typeof value === "function") delete value[REGISTRY_KEY];
	}
}

/** Writes the registry the way TypeScript's legacy decorators do: on the prototype, name as value. */
function registerLegacy(feature: Feature, methodName: string): void {
	const registry: Map<Feature, unknown> = (Probe.prototype as any)[REGISTRY_KEY] ?? new Map();
	registry.set(feature, methodName);
	(Probe.prototype as any)[REGISTRY_KEY] = registry;
}

/** Writes it the way the standard decorators do: on the method function, context object as value. */
function registerStandard(feature: Feature, methodName: string): void {
	const method = Object.getOwnPropertyDescriptor(Probe.prototype, methodName)?.value;
	const registry: Map<Feature, unknown> = method[REGISTRY_KEY] ?? new Map();
	registry.set(feature, { kind: "method", name: methodName, static: false, private: false });
	method[REGISTRY_KEY] = registry;
}

describe("finding the feature method under either decorator semantics", () => {
	it("takes the legacy form: a registry on the prototype holding method names", async () => {
		clearRegistries();
		registerLegacy(Feature.Consumables, "initConsumables");

		const device = probe();
		await expect(device.apply(Feature.Consumables)).resolves.toBe(true);
		expect(device.calls).toEqual(["initConsumables"]);
	});

	it("takes the standard form: a registry on the method holding the decorator context", async () => {
		// This is the shape esbuild 0.21+ produces when nobody tells it about
		// `experimentalDecorators` - the case that used to leave every feature unapplied.
		clearRegistries();
		registerStandard(Feature.Consumables, "initConsumables");

		const device = probe();
		await expect(device.apply(Feature.Consumables)).resolves.toBe(true);
		expect(device.calls).toEqual(["initConsumables"]);
	});

	it("prefers the prototype when both are present, rather than whichever is met first", async () => {
		// Not a case any single toolchain produces, but the order has to be decided somewhere
		// rather than falling out of the property enumeration. The prototype is the form this
		// project declares in `tsconfig.json`, so it is the intended one.
		clearRegistries();
		registerLegacy(Feature.Consumables, "initConsumables");
		registerStandard(Feature.Consumables, "detectAndApplyRuntimeFeatures");

		const device = probe();
		await expect(device.apply(Feature.Consumables)).resolves.toBe(true);
		expect(device.calls).toEqual(["initConsumables"]);
	});

	it("reports nothing to apply when neither form registers the feature", async () => {
		clearRegistries();
		registerLegacy(Feature.Consumables, "initConsumables");

		const device = probe();
		await expect(device.apply(Feature.Map)).resolves.toBe(false);
		expect(device.calls).toEqual([]);
	});

	it("applies a feature once and refuses the second time", async () => {
		// Unchanged behaviour, pinned here because the guard rewrote the surrounding branch.
		clearRegistries();
		registerStandard(Feature.Consumables, "initConsumables");

		const device = probe();
		await expect(device.apply(Feature.Consumables)).resolves.toBe(true);
		await expect(device.apply(Feature.Consumables)).resolves.toBe(false);
		expect(device.calls).toEqual(["initConsumables"]);
	});

	it("refuses a value that is not a feature at all, before looking anything up", async () => {
		clearRegistries();
		const device = probe();
		await expect(device.apply("not-a-feature" as Feature)).resolves.toBe(false);
	});
});

/**
 * The real classes still carry their decorators, and this is what proves the guard did not break
 * the ordinary path: under vitest the legacy form applies, and it is found through the same
 * function.
 */
describe("the shipped classes register through the same lookup", () => {
	it("finds a decorated method on the real V1 class", async () => {
		const { V1VacuumFeatures } = await import("./vacuum/v1VacuumFeatures");
		const registry = (V1VacuumFeatures.prototype as any)[REGISTRY_KEY];

		expect(registry, "vitest compiles with experimentalDecorators, so the prototype form is expected here").toBeInstanceOf(Map);
		expect(registry.get(Feature.Consumables)).toBe("updateConsumables");
	});
});
