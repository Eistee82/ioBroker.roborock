import { describe, expect, it, vi } from "vitest";

import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { resultStateKeyForMethod } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";

/**
 * An answer the adapter has no name for still has to become a state.
 *
 * `requestAndProcess` wrote states only when the answer unwrapped to a plain object. Anything else
 * - a bare value, a list, an empty list - reached the end of the `try` block and disappeared: no
 * state, no log, no error. Measured against all 43 answers the reference robot gives
 * (`_appanalysis/19-geraetefaehigkeiten.md` §2), 28 arrived and **15 were dropped**.
 *
 * Two things this suite deliberately does *not* assert, because checking them showed they are not
 * true:
 *
 * - It is **not** the case that eight visible states are missing today. V1 overrides
 *   `updateTimers` and `updateRoomMapping` with its own parsers, and `Feature.FirmwareInfo` and
 *   `Feature.Timers` are granted by no model class at all, so two base callers return before
 *   reaching the code under test. `updateFirmwareFeatures` below runs only because the harness
 *   grants the feature by hand.
 * - The fix therefore repairs the **mechanism**, which is what publishing unknown values needs -
 *   not a list of four broken states.
 *
 * Every fixture is a **recorded answer** from that measurement, not an invented one. The duid is
 * made up; the robot's real one is a device secret and does not belong in the repository.
 *
 * Counter-checked: with the old `if (resultObj) { … }` in place, all five "used to vanish" cases
 * below fail and the four regression cases pass unchanged.
 */

interface Harness {
	deps: FeatureDependencies;
	/** `[id, common]` for every object created. */
	ensured: [string, Record<string, unknown>][];
	/** `[id, value]` for every state write. */
	writes: [string, unknown][];
	/** Folder ids handed to `ensureFolder`. */
	folders: string[];
	/** `[level, message]` of every `rLog` call. */
	logs: [string, string][];
	/** The next answer `sendRequest` returns, keyed by method. */
	answers: Map<string, unknown>;
}

const DUID = "duid-under-test";

function createHarness(): Harness {
	const ensured: [string, Record<string, unknown>][] = [];
	const writes: [string, unknown][] = [];
	const folders: string[] = [];
	const logs: [string, string][] = [];
	const answers = new Map<string, unknown>();

	const adapter: any = {
		namespace: "roborock.0",
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
		translations: {},
		rLog: vi.fn().mockImplementation((...args: unknown[]) => {
			logs.push([String(args[6] ?? "debug"), String(args[5] ?? "")]);
		}),
		setState: vi.fn().mockResolvedValue(undefined),
		setStateChanged: vi.fn().mockImplementation(async (id: string, value: any) => {
			writes.push([id, value?.val]);
		}),
		extendObject: vi.fn().mockResolvedValue(undefined),
		applyCommonUpdate: vi.fn().mockResolvedValue(undefined),
		getObjectAsync: vi.fn().mockResolvedValue(null),
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
		requestsHandler: {
			sendRequest: vi.fn().mockImplementation(async (_duid: string, method: string) => {
				if (!answers.has(method)) throw new Error(`test did not stage an answer for ${method}`);
				return answers.get(method);
			})
		},
		translationManager: { get: vi.fn().mockImplementation((key: string, def: string) => def || key) }
	};

	const deps = {
		adapter,
		http_api: adapter.http_api,
		ensureState: vi.fn().mockImplementation(async (id: string, common: Record<string, unknown>) => {
			ensured.push([id, { ...common }]);
		}),
		ensureFolder: vi.fn().mockImplementation(async (id: string) => {
			folders.push(id);
		}),
		log: adapter.log,
		config: { staticFeatures: [] }
	} as unknown as FeatureDependencies;

	return { deps, ensured, writes, folders, logs, answers };
}

/**
 * Reaches `requestAndProcess` directly for the answer shapes no adapter caller produces today.
 * The four real callers are exercised through their own public methods further down.
 */
class ProbeFeatures extends V1VacuumFeatures {
	public async probe(method: string, folder: string): Promise<void> {
		await this.requestAndProcess(method, [], folder);
	}
}

function createRobot(harness: Harness): ProbeFeatures {
	return new ProbeFeatures(harness.deps, DUID, "roborock.vacuum.a65", {
		staticFeatures: [Feature.FirmwareInfo, Feature.Timers, Feature.RoomMapping, Feature.MultiMap]
	} as any);
}

/** The object created for `id`, or `undefined` when nothing was created. */
function objectFor(harness: Harness, id: string): Record<string, unknown> | undefined {
	return harness.ensured.find(([created]) => created === id)?.[1];
}

/** The value last written to `id`, or `undefined` when nothing was written. */
function valueFor(harness: Harness, id: string): unknown {
	const hit = [...harness.writes].reverse().find(([written]) => written === id);
	return hit?.[1];
}

describe("resultStateKeyForMethod", () => {
	it("names the state after the field the robot would have used", () => {
		expect(resultStateKeyForMethod("get_fw_features")).toBe("fw_features");
		expect(resultStateKeyForMethod("get_room_mapping")).toBe("room_mapping");
		expect(resultStateKeyForMethod("get_sound_volume")).toBe("sound_volume");
		expect(resultStateKeyForMethod("app_get_dryer_setting")).toBe("dryer_setting");
		expect(resultStateKeyForMethod("app_charge")).toBe("charge");
	});

	it("collapses Roborock's two method tables onto one name", () => {
		// A65:238176 lists 'GetTimer': 'user.get_timer', A65:238179 lists 'GetTimer': 'get_timer'.
		// Two states for one value, depending on which table a device uses, would be a silent split.
		expect(resultStateKeyForMethod("user.get_timer")).toBe(resultStateKeyForMethod("get_timer"));
		expect(resultStateKeyForMethod("user.app_get_status")).toBe("status");
	});

	it("cannot produce a path segment that escapes the folder", () => {
		// The method name is not a trusted string: it comes from a model class, and B01 builds it
		// from device data. It ends up appended to an object path.
		expect(resultStateKeyForMethod("../../evil")).toBe("_evil");
		expect(resultStateKeyForMethod("a.b/c")).toBe("b_c");
		expect(resultStateKeyForMethod("get_a b")).toBe("a_b");
		expect(resultStateKeyForMethod("")).toBe("result");
		expect(resultStateKeyForMethod("get_")).toBe("get_");
	});
});

describe("answers that used to vanish without a trace", () => {
	it("publishes get_fw_features, which the adapter has been asking for and discarding", async () => {
		const harness = createHarness();
		// Recorded from the reference robot, report 19 §2.
		harness.answers.set("get_fw_features", [111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125]);

		await createRobot(harness).updateFirmwareFeatures();

		const id = `Devices.${DUID}.firmwareFeatures.fw_features`;
		expect(objectFor(harness, id)).toMatchObject({ type: "array", role: "json", read: true, write: false });
		expect(JSON.parse(String(valueFor(harness, id)))).toHaveLength(15);
	});

	it("publishes an array of arrays, which the unwrapping never reached", async () => {
		// get_room_mapping. Driven through `probe` because V1 overrides updateRoomMapping with its
		// own parser - the shape is what is under test here, not that caller.
		const harness = createHarness();
		harness.answers.set("get_room_mapping", [
			[16, "23351030", 6],
			[17, "23935306", 15]
		]);

		await createRobot(harness).probe("get_room_mapping", "mapRaw");

		const id = `Devices.${DUID}.mapRaw.room_mapping`;
		expect(objectFor(harness, id)).toMatchObject({ type: "array" });
		expect(JSON.parse(String(valueFor(harness, id)))).toEqual([
			[16, "23351030", 6],
			[17, "23935306", 15]
		]);
	});

	it("keeps the payload of a single-element wrapper instead of dropping it", async () => {
		// get_server_timer: one element, so the unwrap loop strips the wrapper and leaves a
		// three-element array - which the old object check then threw away.
		const harness = createHarness();
		harness.answers.set("get_server_timer", [["1743140136890", "on", -1]]);

		await createRobot(harness).probe("get_server_timer", "timersRaw");

		expect(JSON.parse(String(valueFor(harness, `Devices.${DUID}.timersRaw.server_timer`)))).toEqual(["1743140136890", "on", -1]);
	});

	it("writes an empty list as [] rather than staying silent", async () => {
		// "answered, and there is nothing" and "did not answer" are different facts. Without a
		// state the user has no way to tell them apart - which is how the empty schedule list on
		// the reference robot looked like a broken adapter.
		const harness = createHarness();
		harness.answers.set("get_timer", []);

		await createRobot(harness).probe("get_timer", "timersRaw");

		const id = `Devices.${DUID}.timersRaw.timer`;
		expect(objectFor(harness, id)).toMatchObject({ type: "array" });
		expect(valueFor(harness, id)).toBe("[]");
	});

	it("unwraps a single value to a typed state, not to a JSON string", async () => {
		const harness = createHarness();
		// The seven bare-value answers of report 19 §2, one of each type.
		harness.answers.set("get_sound_volume", [90]);
		harness.answers.set("get_timezone", ["Europe/Berlin"]);

		const robot = createRobot(harness);
		await robot.probe("get_sound_volume", "settingsRaw");
		await robot.probe("get_timezone", "settingsRaw");

		const volume = `Devices.${DUID}.settingsRaw.sound_volume`;
		expect(objectFor(harness, volume)).toMatchObject({ type: "number" });
		expect(valueFor(harness, volume)).toBe(90);

		const zone = `Devices.${DUID}.settingsRaw.timezone`;
		expect(objectFor(harness, zone)).toMatchObject({ type: "string" });
		expect(valueFor(harness, zone)).toBe("Europe/Berlin");
	});
});

describe("what the new path deliberately does not do", () => {
	it("never creates a writable state", async () => {
		// The gate this project has defended four times: a writable state whose range nobody knows
		// is how a wrong value reaches the robot. `save_map` drops every zone not sent with it.
		const harness = createHarness();
		harness.answers.set("get_fw_features", [111, 112]);
		harness.answers.set("get_room_mapping", [[16, "1", 6]]);
		harness.answers.set("get_timer", []);
		harness.answers.set("get_camera_status", [257]);

		const robot = createRobot(harness);
		await robot.updateFirmwareFeatures();
		await robot.probe("get_room_mapping", "mapRaw");
		await robot.probe("get_timer", "timersRaw");
		await robot.probe("get_camera_status", "settingsRaw");

		expect(harness.ensured.length).toBeGreaterThan(0);
		for (const [id, common] of harness.ensured) {
			expect(common.write, `${id} must not be writable`).not.toBe(true);
		}
	});

	it("invents neither unit nor value list", async () => {
		// A guessed unit is worse than none: it is wrong in a way the user cannot see. The labels
		// come from the extracted mode tables instead.
		const harness = createHarness();
		harness.answers.set("get_dust_collection_mode_raw", 4);

		await createRobot(harness).probe("get_dust_collection_mode_raw", "settingsRaw");

		const common = objectFor(harness, `Devices.${DUID}.settingsRaw.dust_collection_mode_raw`);
		expect(common).toBeDefined();
		expect(common).not.toHaveProperty("unit");
		expect(common).not.toHaveProperty("states");
		expect(common).not.toHaveProperty("min");
		expect(common).not.toHaveProperty("max");
	});

	it("says so in the log when the robot answers with nothing, instead of failing quietly", async () => {
		const harness = createHarness();
		harness.answers.set("get_carpet_clean_mode", null);

		await createRobot(harness).probe("get_carpet_clean_mode", "settingsRaw");

		expect(harness.ensured).toHaveLength(0);
		expect(harness.folders).toHaveLength(0);
		expect(harness.logs.some(([level, message]) => level === "debug" && message.includes("get_carpet_clean_mode"))).toBe(true);
	});
});

describe("object answers keep behaving exactly as before", () => {
	it("still spreads every key of the status packet into its own state", async () => {
		const harness = createHarness();
		harness.answers.set("get_prop", { state: 8, battery: 100, water_box_mode: 203 });

		await createRobot(harness).updateStatus();

		expect(valueFor(harness, `Devices.${DUID}.deviceStatus.state`)).toBe(8);
		expect(valueFor(harness, `Devices.${DUID}.deviceStatus.battery`)).toBe(100);
		expect(valueFor(harness, `Devices.${DUID}.deviceStatus.water_box_mode`)).toBe(203);
		// No state named after the method - that name is for keyless answers only.
		expect(objectFor(harness, `Devices.${DUID}.deviceStatus.prop`)).toBeUndefined();
	});

	it("still unwraps the single-element array around an object", async () => {
		const harness = createHarness();
		harness.answers.set("get_prop", [{ state: 8, msg_seq: 14270 }]);

		await createRobot(harness).updateStatus();

		expect(valueFor(harness, `Devices.${DUID}.deviceStatus.state`)).toBe(8);
		expect(valueFor(harness, `Devices.${DUID}.deviceStatus.msg_seq`)).toBe(14270);
	});

	it("still keeps a nested object as JSON, now labelled as one", async () => {
		const harness = createHarness();
		// app_get_dryer_setting, report 19 §2 - `on` and `off` are objects inside the answer.
		harness.answers.set("app_get_dryer_setting", { status: 1, on: { count: 10, dry_time: 7200 } });

		await createRobot(harness).probe("app_get_dryer_setting", "dock");

		expect(valueFor(harness, `Devices.${DUID}.dock.status`)).toBe(1);
		expect(objectFor(harness, `Devices.${DUID}.dock.on`)).toMatchObject({ type: "object", role: "json" });
		expect(JSON.parse(String(valueFor(harness, `Devices.${DUID}.dock.on`)))).toEqual({ count: 10, dry_time: 7200 });
	});

	it("still logs a warning and creates nothing when the request fails", async () => {
		const harness = createHarness();
		// No staged answer, so sendRequest throws.
		await createRobot(harness).probe("get_led_status", "settingsRaw");

		expect(harness.ensured).toHaveLength(0);
		expect(harness.logs.some(([level]) => level === "warn")).toBe(true);
	});
});
