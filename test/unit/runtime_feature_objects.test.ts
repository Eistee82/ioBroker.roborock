import { describe, expect, it, vi } from "vitest";

import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";

/**
 * A command a **runtime-detected** feature registers has to become an ioBroker object.
 *
 * It did not, and that was a real defect rather than a design question. The order inside
 * `BaseDeviceFeatures.initialize()` is:
 *
 * ```
 * setupProtocolFeatures()   -> fills this.commands with the base set
 * applyModelSpecifics()     -> applies the statically declared features
 * createCommandObjects()    -> writes the objects            <-- once, here
 * initializeDeviceData()    -> updateStatus() -> detectAndApplyRuntimeFeatures()
 * ```
 *
 * The status is the only thing that can say what a robot really has, and it arrives one step too
 * late. Mop drying, Do Not Disturb and the child lock are switched on from it, so all of them
 * existed in memory and nowhere else - no object, no control in the admin tab. The detection even
 * returned `changed: true`; the value was discarded at all three call sites.
 *
 * `applyRuntimeFeatureDetection` pairs the two: detect, and publish what was detected. These tests
 * are the earlier ones turned around - they used to assert the gap, they now assert it is closed.
 */

interface Harness {
	deps: FeatureDependencies;
	/** Object ids handed to `ensureState`, in order. */
	ensured: string[];
	/** Object ids whose `common` was rewritten because the definition differed. */
	updated: string[];
	/** `[id, value, ack]` of every state write. */
	stateWrites: [string, unknown, unknown][];
	/** Objects that already exist, keyed by id; `processCommand` reads these. */
	existing: Map<string, { common: Record<string, unknown> }>;
}

function createDeps(): Harness {
	const ensured: string[] = [];
	const updated: string[] = [];
	const stateWrites: [string, unknown, unknown][] = [];
	const existing = new Map<string, { common: Record<string, unknown> }>();

	const adapter: any = {
		namespace: "roborock.0",
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
		translations: {},
		rLog: vi.fn(),
		setState: vi.fn().mockImplementation(async (id: string, value: unknown, ack: unknown) => {
			stateWrites.push([id, value, ack]);
		}),
		setStateChanged: vi.fn().mockResolvedValue(undefined),
		extendObject: vi.fn().mockResolvedValue(undefined),
		applyCommonUpdate: vi.fn().mockImplementation(async (path: string) => {
			updated.push(path);
		}),
		getObjectAsync: vi.fn().mockImplementation(async (id: string) => existing.get(id) ?? null),
		getStateAsync: vi.fn().mockResolvedValue(null),
		getForeignStatesAsync: vi.fn().mockResolvedValue({}),
		getStatesAsync: vi.fn().mockResolvedValue({}),
		getDeviceProtocolVersion: vi.fn().mockResolvedValue("1.0"),
		errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
		http_api: {
			getDevices: vi.fn().mockReturnValue([]),
			getFwFeaturesResult: vi.fn(),
			storeFwFeaturesResult: vi.fn()
		},
		requestsHandler: { sendRequest: vi.fn().mockResolvedValue({}) },
		translationManager: { get: vi.fn().mockImplementation((key: string, def: string) => def || key) }
	};

	const deps = {
		adapter,
		http_api: adapter.http_api,
		ensureState: vi.fn().mockImplementation(async (id: string, common: Record<string, unknown>) => {
			ensured.push(id);
			// A created object exists from now on, which is what makes a second pass meaningful.
			existing.set(id, { common: { ...common } });
		}),
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		log: adapter.log,
		config: { staticFeatures: [] }
	} as unknown as FeatureDependencies;

	return { deps, ensured, updated, stateWrites, existing };
}

/** The status of the test device, reduced to the fields that switch features on. */
const STATUS_WITH_RUNTIME_FEATURES = {
	state: 8,
	battery: 100,
	// Switches on Feature.ChildLock and Feature.DoNotDisturb (V1RobotSettingsService).
	lock_status: 0,
	dnd_enabled: 0,
	// Switches on Feature.MopDry - the drying buttons.
	dry_status: 0
};

/**
 * Walks the steps of `initialize()` in their real order, without the network.
 * @param harness Mocked dependencies.
 * @param staticFeatures Features a model class declares up front.
 */
async function boot(harness: Harness, staticFeatures: string[] = []): Promise<V1VacuumFeatures> {
	const vacuum = new V1VacuumFeatures(harness.deps, "duid-test", "roborock.vacuum.a65", { staticFeatures } as any);
	await vacuum.setupProtocolFeatures();
	await vacuum.applyModelSpecifics();
	await vacuum.createCommandObjects();
	return vacuum;
}

/** Boots, then hands the robot its status - i.e. step 3 followed by step 4. */
async function bootAndDetect(harness: Harness): Promise<V1VacuumFeatures> {
	const vacuum = await boot(harness);
	await (vacuum as any).applyRuntimeFeatureDetection(STATUS_WITH_RUNTIME_FEATURES);
	return vacuum;
}

describe("commands registered by a runtime-detected feature", () => {
	it("get their objects once the status switched the feature on", async () => {
		const harness = createDeps();
		await bootAndDetect(harness);

		expect(harness.ensured.some((id) => id.endsWith("settings.set_child_lock_status"))).toBe(true);
		expect(harness.ensured.some((id) => id.endsWith("settings.set_dnd_timer"))).toBe(true);
		expect(harness.ensured.some((id) => id.endsWith("settings.close_dnd_timer"))).toBe(true);
		expect(harness.ensured.some((id) => id.endsWith("queries.get_dnd_timer"))).toBe(true);
		expect(harness.ensured.some((id) => id.endsWith("commands.app_start_mop_drying"))).toBe(true);
	});

	it("are in the in-memory table as well, so the write path can find their spec", async () => {
		const harness = createDeps();
		const vacuum = await bootAndDetect(harness);

		expect(vacuum.getCommandSpec("settings", "set_child_lock_status")).toBeDefined();
		expect(vacuum.getCommandSpec("settings", "set_dnd_timer")).toBeDefined();
		expect(vacuum.getCommandSpec("commands", "app_start_mop_drying")).toBeDefined();
	});

	it("runs the detection only once, however often a status arrives", async () => {
		const harness = createDeps();
		const vacuum = await boot(harness);
		const detect = vi.spyOn(vacuum, "detectAndApplyRuntimeFeatures");
		for (let poll = 0; poll < 5; poll++) {
			await (vacuum as any).applyRuntimeFeatureDetection(STATUS_WITH_RUNTIME_FEATURES);
		}

		expect(detect).toHaveBeenCalledTimes(1);
	});

	it("writes nothing on the second pass for a definition that did not change", async () => {
		// The guard against a write storm: the adapter runs for months, and re-publishing every
		// command object on every status would be a real load on the object database.
		const harness = createDeps();
		await bootAndDetect(harness);

		const writesBefore = harness.updated.length;
		const ensuredBefore = harness.ensured.length;

		await boot(harness);

		// Everything already exists with the very same `common`, so nothing is touched.
		expect(harness.updated.length).toBe(writesBefore);
		expect(harness.ensured.length).toBe(ensuredBefore);
	});

	it("rewrites an object whose definition really did change", async () => {
		// The counterpart: a stored definition that differs has to be corrected, and it goes
		// through applyCommonUpdate so that a shortened value list is really removed.
		const harness = createDeps();
		await bootAndDetect(harness);
		harness.updated.length = 0;

		const id = "Devices.duid-test.commands.set_custom_mode";
		harness.existing.set(id, { common: { name: "stale", type: "number", states: { 999: "gone" } } });

		await boot(harness);

		expect(harness.updated).toContain(id);
	});

	it("acknowledges a button it resets, so the reset cannot re-trigger the command", async () => {
		// `processCommand` puts every button back to false. On a second pass that would be a state
		// write while the adapter is running - it must not look like a user pressing the button.
		const harness = createDeps();
		await bootAndDetect(harness);

		const buttonWrites = harness.stateWrites.filter(([id]) => String(id).endsWith("commands.app_start"));
		expect(buttonWrites.length).toBeGreaterThan(0);
		for (const [, value, ack] of buttonWrites) {
			expect(value).toBe(false);
			expect(ack).toBe(true);
		}
	});

	it("leaves a switch alone, unlike a button", async () => {
		// The child lock is a switch, not a button; resetting it to false on every object pass
		// would fight the value the robot reports.
		const harness = createDeps();
		await bootAndDetect(harness);

		expect(harness.stateWrites.some(([id]) => String(id).endsWith("settings.set_child_lock_status"))).toBe(false);
	});

	it("does nothing at all when the detection added no command", async () => {
		// The narrow trigger, and the reason for it: `changed` is set by every implementation on its
		// first run, and by the B01 one whenever the status carries `dss` - regardless of whether a
		// command was added. Acting on the flag would hand an object pass to every device, including
		// the B01 and Q10 hardware this project cannot test against. A status without any of the
		// fields that switch a feature on must therefore leave everything untouched.
		const harness = createDeps();
		const vacuum = await boot(harness);

		const ensuredBefore = harness.ensured.length;
		const updatedBefore = harness.updated.length;
		const writesBefore = harness.stateWrites.length;

		const published = await (vacuum as any).applyRuntimeFeatureDetection({ state: 8, battery: 100 });

		expect(published).toBe(false);
		expect(harness.ensured.length).toBe(ensuredBefore);
		expect(harness.updated.length).toBe(updatedBefore);
		expect(harness.stateWrites.length).toBe(writesBefore);
	});

	it("reports that it published, so the decision is visible in the log", async () => {
		const harness = createDeps();
		const vacuum = await boot(harness);

		const published = await (vacuum as any).applyRuntimeFeatureDetection(STATUS_WITH_RUNTIME_FEATURES);

		expect(published).toBe(true);
		const lines = ((harness.deps as any).adapter.rLog as ReturnType<typeof vi.fn>).mock.calls
			.map((call: any[]) => String(call[5]));
		expect(lines.some((line) => line.includes("Runtime detection added") && line.includes("set_child_lock_status"))).toBe(true);
	});

	it("still gives a statically declared feature its object", async () => {
		// The control from the original investigation: applied before the objects are written, so
		// it never depended on this path and must keep working.
		const harness = createDeps();
		await boot(harness, ["MopDry"]);

		expect(harness.ensured.some((id) => id.endsWith("commands.app_start_mop_drying"))).toBe(true);
	});
});
