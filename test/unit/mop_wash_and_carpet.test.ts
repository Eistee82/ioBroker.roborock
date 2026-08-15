import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import {
	GET_SMART_WASH_PARAMS,
	GET_WASH_TOWEL_MODE,
	SET_SMART_WASH_PARAMS,
	SET_WASH_TOWEL_MODE,
	SMART_WASH_BY_ROOM,
	SMART_WASH_BY_ROOM_INTERVAL,
	V1MopWashSettingsService,
	WASH_INTERVAL_MAX,
	WASH_INTERVAL_MIN,
	WASH_INTERVAL_STEP,
	WASH_TOWEL_MODES,
	parseSmartWashResponse,
	parseWashTowelModeResponse,
	smartWashStateValue,
	toSmartWashParams,
	toWashTowelMode,
	washIntervalSeconds
} from "../../src/lib/features/vacuum/v1MopWashSettings";
import {
	APP_GET_CARPET_DEEP_CLEAN_STATUS,
	APP_SET_CARPET_DEEP_CLEAN_STATUS,
	V1CarpetDeepCleanService,
	carpetDeepCleanParams,
	parseCarpetDeepCleanResponse
} from "../../src/lib/features/vacuum/v1CarpetDeepClean";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * The dock's two mop wash settings and the deep carpet cleaning switch.
 *
 * All three were held back by a note that said their setters pass their argument through unread.
 * That is true of exactly one of them, and the two tests this file exists for are the ones that pin
 * the difference: **the wash mode's value list**, which has holes a counting mind would fall into,
 * and **`smart_wash` being a flag** rather than the three-valued display mode that sits right next
 * to it in the plugin.
 *
 * The measured answers of the test device (`_appanalysis/geraetefaehigkeiten-1786807834553.json`):
 *
 * ```
 * get_wash_towel_mode              -> {wash_mode: 1}
 * get_smart_wash_params            -> {smart_wash: 0, wash_interval: 900}
 * app_get_carpet_deep_clean_status -> {status: 0}
 * ```
 */

describe("the wash mode values, which are not consecutive", () => {
	it("offers exactly the three entries the app shows unconditionally", () => {
		// A65:438082-438124 - the three whose `visible` is a literal `true`. The other two hang on
		// `isNewFeatureStrSupport(DirtyReplenishClean)` (bit 34, clear on the test device) and on
		// `isSuperDeepWashSupported() && RSM.isAMReady` (the fill&drain element, `dss & 3 === 2`,
		// and the test device reports `dss = 681`).
		expect(WASH_TOWEL_MODES.map((mode) => mode.value)).toEqual([0, 1, 2]);
	});

	it("refuses 8 and 10 rather than sending a mode the picker did not offer", () => {
		// `WashTowelModeMap` (A65:238431) is {Quick:0, Daily:1, Deep:2, SuperDeep:8, Smart:10}. Both
		// values exist - they are simply not offered here, and a refusal is visible where a silently
		// dropped command is not.
		expect(() => toWashTowelMode(8)).toThrow(/accepts 0, 1, 2/);
		expect(() => toWashTowelMode(10)).toThrow(/accepts 0, 1, 2/);
	});

	it("refuses 3, which is what counting upwards from Deep would produce", () => {
		// The whole reason the table is read rather than derived: after 2 the next value is 8.
		expect(() => toWashTowelMode(3)).toThrow();
		expect(() => toWashTowelMode(4)).toThrow();
	});

	it("takes the three offered values, including the measured one", () => {
		expect(toWashTowelMode(0)).toBe(0);
		expect(toWashTowelMode(1)).toBe(1);
		expect(toWashTowelMode(2)).toBe(2);
	});

	it("refuses anything that is not a number", () => {
		// `[]` is the one that has to be named: `Number([])` is 0, which is a valid mode, so the
		// loose reader would have turned an empty container into *Light*.
		for (const value of [null, undefined, "", "deep", {}, []]) {
			expect(() => toWashTowelMode(value), JSON.stringify(value)).toThrow();
		}
	});

	it("refuses an empty selection where the app sends undefined", () => {
		// A knowing difference from the app, kept: `onChangeWashTowelMode(null)` leaves its value
		// `undefined` and calls the wrapper anyway (A65:437090-437107), so `{wash_mode: undefined}`
		// goes on the wire. Pinned so it is not "corrected" back towards the app later.
		expect(() => toWashTowelMode(undefined)).toThrow();
		expect(() => toWashTowelMode(null)).toThrow();
	});

	it("wraps the mode in the object the wrapper builds", () => {
		// A65:231019-231030: `r3['wash_mode'] = a0`, i.e. `{wash_mode: value}` - not a bare number
		// and not an array.
		expect(mopWashService().buildCommandParams(SET_WASH_TOWEL_MODE, 2))
			.toEqual({ method: SET_WASH_TOWEL_MODE, params: { wash_mode: 2 } });
	});
});

describe("smart_wash is a flag, not the three-valued mode beside it", () => {
	it("sends 1 for by-room and 0 for every interval", () => {
		// All four call sites agree: A65:437389-437394 computes `on ? 1 : 0`, A65:437501 sends a
		// literal 0, A65:433116 and A65:854582 send a literal 0. `BackWashModeMap` (Smart 0, Custom
		// 1, Level 2, A65:238470) is derived from the *answer* for display and never sent.
		expect(toSmartWashParams(SMART_WASH_BY_ROOM).smart_wash).toBe(1);
		for (const seconds of washIntervalSeconds()) {
			expect(toSmartWashParams(seconds).smart_wash, `${seconds} s`).toBe(0);
		}
	});

	it("never produces a smart_wash of 2", () => {
		const produced = [SMART_WASH_BY_ROOM, ...washIntervalSeconds()].map((value) => toSmartWashParams(value).smart_wash);
		expect(new Set(produced)).toEqual(new Set([0, 1]));
	});

	it("sends the app's own 20 minutes alongside by-room, not the last interval", () => {
		// A65:437316-437317 sets 20 as the default and the Smart branch (A65:437361-437363) keeps
		// it; the slider value is not read there. 20 min = 1200 s.
		expect(SMART_WASH_BY_ROOM_INTERVAL).toBe(1200);
		expect(toSmartWashParams(SMART_WASH_BY_ROOM)).toEqual({ smart_wash: 1, wash_interval: 1200 });
	});
});

describe("the wash interval is in seconds", () => {
	it("spans the app's own slider: 10 to 50 minutes in steps of 5", () => {
		// A65:436653: `minimumValue: 10, maximumValue: 50, step: 5`, in minutes, and every caller
		// multiplies by 60 before sending (A65:437386, A65:437497).
		expect(WASH_INTERVAL_MIN).toBe(10 * 60);
		expect(WASH_INTERVAL_MAX).toBe(50 * 60);
		expect(WASH_INTERVAL_STEP).toBe(5 * 60);
		expect(washIntervalSeconds()).toEqual([600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000]);
	});

	it("carries 900 seconds, which the app itself calls 15 minutes", () => {
		// The cleanest proof of the unit: the reset path sends 900 and then writes 15 onto its
		// minute-valued state (A65:854581-854599). The read side divides by 60 (A65:854540-854545).
		expect(toSmartWashParams(900)).toEqual({ smart_wash: 0, wash_interval: 900 });
	});

	it("refuses an interval the slider cannot reach", () => {
		for (const value of [60, 599, 601, 1260, 3300, -900]) {
			expect(() => toSmartWashParams(value), `${value}`).toThrow(/600 to 3000 seconds/);
		}
	});

	it("refuses a value that is not a number at all", () => {
		for (const value of [null, undefined, "", "15 min", {}]) {
			expect(() => toSmartWashParams(value), JSON.stringify(value)).toThrow();
		}
	});
});

describe("reading the two wash settings back", () => {
	it("reads the measured answers of the test device", () => {
		expect(parseWashTowelModeResponse({ wash_mode: 1 })).toBe(1);
		expect(parseSmartWashResponse({ smart_wash: 0, wash_interval: 900 }))
			.toEqual({ smartWash: 0, washIntervalSeconds: 900 });
	});

	it("reads them through the request layer's own wrappers", () => {
		expect(parseWashTowelModeResponse({ data: [{ wash_mode: 2 }] })).toBe(2);
		expect(parseSmartWashResponse([{ smart_wash: 1, wash_interval: 1200 }])?.smartWash).toBe(1);
	});

	it("turns by-room into the sentinel and by-time into its interval", () => {
		expect(smartWashStateValue({ smartWash: 1, washIntervalSeconds: 1200 })).toBe(SMART_WASH_BY_ROOM);
		expect(smartWashStateValue({ smartWash: 0, washIntervalSeconds: 900 })).toBe(900);
	});

	it("says nothing when a by-time answer carries no interval", () => {
		expect(smartWashStateValue({ smartWash: 0, washIntervalSeconds: null })).toBeNull();
	});

	it("says nothing when the robot does not know the method", () => {
		expect(parseWashTowelModeResponse("unknown_method")).toBeNull();
		expect(parseWashTowelModeResponse({})).toBeNull();
		expect(parseSmartWashResponse("unknown_method")).toBeNull();
		expect(parseSmartWashResponse({ wash_interval: 900 })).toBeNull();
	});
});

describe("deep carpet cleaning, whose wrapper proves nothing", () => {
	it("builds the object the caller builds, because the wrapper does not", () => {
		// A65:230030-230039 hands `a0` straight to the transport. A65:902697-902712 is what supplies
		// the shape: `{status: on ? 1 : 0}`.
		expect(carpetDeepCleanParams(true)).toEqual({ status: 1 });
		expect(carpetDeepCleanParams(false)).toEqual({ status: 0 });
	});

	it("sends 1 and 0, never true and false", () => {
		const service = carpetService();
		expect(service.buildCommandParams(APP_SET_CARPET_DEEP_CLEAN_STATUS, true))
			.toEqual({ method: APP_SET_CARPET_DEEP_CLEAN_STATUS, params: { status: 1 } });
		expect(service.buildCommandParams(APP_SET_CARPET_DEEP_CLEAN_STATUS, false))
			.toEqual({ method: APP_SET_CARPET_DEEP_CLEAN_STATUS, params: { status: 0 } });
	});

	it("reads the strings a plain Boolean() would get backwards", () => {
		// `Boolean("false")` and `Boolean("0")` are both **true**. Shared with the six status
		// toggles through `toBooleanFlag` rather than read a second way here.
		for (const off of ["false", "0", "off", "no", ""]) {
			expect(carpetService().buildCommandParams(APP_SET_CARPET_DEEP_CLEAN_STATUS, off).params, off).toEqual({ status: 0 });
		}
		expect(carpetService().buildCommandParams(APP_SET_CARPET_DEEP_CLEAN_STATUS, "true").params).toEqual({ status: 1 });
	});

	it("sends its getter an empty object, as the wrapper does", () => {
		// A65:228301-228310 builds `{}`, not `new Array(0)`.
		expect(carpetService().buildCommandParams(APP_GET_CARPET_DEEP_CLEAN_STATUS, true))
			.toEqual({ method: APP_GET_CARPET_DEEP_CLEAN_STATUS, params: {} });
	});

	it("reads the measured answer of the test device", () => {
		expect(parseCarpetDeepCleanResponse({ status: 0 })).toBe(false);
		expect(parseCarpetDeepCleanResponse([{ status: 1 }])).toBe(true);
		expect(parseCarpetDeepCleanResponse({ data: [{ status: 1 }] })).toBe(true);
	});

	it("says nothing when the answer carries no status", () => {
		expect(parseCarpetDeepCleanResponse("unknown_method")).toBeNull();
		expect(parseCarpetDeepCleanResponse({})).toBeNull();
		expect(parseCarpetDeepCleanResponse(null)).toBeNull();
	});
});

describe("what the three settings publish", () => {
	const id = (name: string): string => `Devices.duid-test.settings.${name}`;

	it("mirrors what the robot reports onto the writable states", async () => {
		const { mopWash, carpet, written } = harness();
		await mopWash.applyWashTowelModeResponse({ wash_mode: 2 });
		await mopWash.applySmartWashResponse({ smart_wash: 0, wash_interval: 900 });
		await carpet.applyResponse({ status: 1 });

		expect(written.get(id(SET_WASH_TOWEL_MODE))).toBe(2);
		expect(written.get(id(SET_SMART_WASH_PARAMS))).toBe(900);
		expect(written.get(id(APP_SET_CARPET_DEEP_CLEAN_STATUS))).toBe(true);
	});

	it("publishes a mode it would refuse to write, because the robot is the authority", async () => {
		// Hiding a mode the robot really is in would be the same lie as a dead switch. The write
		// side stays narrow.
		const { mopWash, written } = harness();
		await mopWash.applyWashTowelModeResponse({ wash_mode: 10 });

		expect(written.get(id(SET_WASH_TOWEL_MODE))).toBe(10);
		expect(() => mopWash.buildCommandParams(SET_WASH_TOWEL_MODE, 10)).toThrow();
	});

	it("publishes nothing it could not read", async () => {
		const { mopWash, carpet, written } = harness();
		await mopWash.applyWashTowelModeResponse("unknown_method");
		await mopWash.applySmartWashResponse("unknown_method");
		await carpet.applyResponse("unknown_method");

		expect(written.size).toBe(0);
	});
});

describe("who is offered the three settings", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set();
		sendRequest = vi.fn(async (_duid: string, method: string) => {
			if (rejected.has(method)) return "unknown_method";
			if (method === GET_WASH_TOWEL_MODE) return { wash_mode: 1 };
			if (method === GET_SMART_WASH_PARAMS) return { smart_wash: 0, wash_interval: 900 };
			if (method === APP_GET_CARPET_DEEP_CLEAN_STATUS) return { status: 0 };
			if (method === "get_fw_features") return [];
			return "unknown_method";
		});

		adapterMock = {
			namespace: "roborock.0",
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
			setStateChanged: vi.fn().mockResolvedValue(undefined),
			setState: vi.fn().mockResolvedValue(undefined),
			getObjectAsync: vi.fn().mockResolvedValue({ common: {} }),
			getStateAsync: vi.fn().mockResolvedValue(null),
			requestsHandler: { sendRequest },
			rLog: vi.fn(),
			errorMessage: (e: unknown) => String(e),
			translationManager: { get: (_key: string, fallback: string) => fallback },
			http_api: {
				getRobotModel: vi.fn().mockReturnValue("roborock.vacuum.a65"),
				getDevices: vi.fn().mockReturnValue([]),
				getFwFeaturesResult: vi.fn().mockReturnValue(undefined),
				storeFwFeaturesResult: vi.fn()
			}
		};

		depsMock = {
			adapter: adapterMock,
			http_api: adapterMock.http_api,
			ensureState: vi.fn().mockResolvedValue(undefined),
			ensureFolder: vi.fn().mockResolvedValue(undefined),
			log: adapterMock.log,
			config: { staticFeatures: [] }
		} as unknown as FeatureDependencies;
	});

	class TestVacuum extends V1VacuumFeatures {
		protected getDynamicFeatures(): Set<Feature> {
			return new Set();
		}
		public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
			return false;
		}
		public async runDetection(): Promise<void> {
			await this.detectProbedCapabilities();
		}
		public declareCommand(name: string, group: string): void {
			this.addCommand(name, { type: "boolean", role: "button", def: false }, group);
		}
		public folderOf(command: string): string | null {
			for (const folder of this.getCommandFolders()) {
				if (this.getCommandSpec(folder, command)) return folder;
			}
			return null;
		}
		public specOf(folder: string, command: string): any {
			return this.getCommandSpec(folder, command);
		}
	}

	function createVacuum(): TestVacuum {
		return new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
	}

	it("offers all three to a robot that answers all three getters", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(SET_WASH_TOWEL_MODE)).toBe("settings");
		expect(vacuum.folderOf(SET_SMART_WASH_PARAMS)).toBe("settings");
		expect(vacuum.folderOf(APP_SET_CARPET_DEEP_CLEAN_STATUS)).toBe("settings");
		expect(vacuum.folderOf(GET_WASH_TOWEL_MODE)).toBe("queries");
		expect(vacuum.folderOf(GET_SMART_WASH_PARAMS)).toBe("queries");
		expect(vacuum.folderOf(APP_GET_CARPET_DEEP_CLEAN_STATUS)).toBe("queries");
	});

	it("offers nothing to a robot that knows none of them", async () => {
		rejected.add(GET_WASH_TOWEL_MODE).add(GET_SMART_WASH_PARAMS).add(APP_GET_CARPET_DEEP_CLEAN_STATUS);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(SET_WASH_TOWEL_MODE)).toBeNull();
		expect(vacuum.folderOf(SET_SMART_WASH_PARAMS)).toBeNull();
		expect(vacuum.folderOf(APP_SET_CARPET_DEEP_CLEAN_STATUS)).toBeNull();
	});

	it("keeps the carpet switch away from a robot that only knows the wash settings", async () => {
		// The point of one getter per capability: `get_wash_towel_mode` yes and
		// `get_wash_towel_params` no on one robot is what this rule was written for.
		rejected.add(APP_GET_CARPET_DEEP_CLEAN_STATUS);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(SET_WASH_TOWEL_MODE)).toBe("settings");
		expect(vacuum.folderOf(APP_SET_CARPET_DEEP_CLEAN_STATUS)).toBeNull();
	});

	it("leaves a model class that already declared one of them alone", async () => {
		// Exactly the a179 situation: it registers all three itself, with its own parameter building.
		const vacuum = createVacuum();
		vacuum.declareCommand(SET_WASH_TOWEL_MODE, "settings");
		await vacuum.runDetection();

		const asked = sendRequest.mock.calls.map((call) => call[1]);
		expect(asked).not.toContain(GET_WASH_TOWEL_MODE);
		// and the rest is still asked about
		expect(asked).toContain(GET_SMART_WASH_PARAMS);
		expect(vacuum.folderOf(SET_SMART_WASH_PARAMS)).toBe("settings");
	});

	it("does not let the mode's probe swallow the frequency's", async () => {
		// The fault this test was written for. Both wash settings live in one service, and when that
		// service registered all four of its commands at once, `probeAndApply`'s guard - "skip a
		// capability whose command is already registered" - fired on the frequency the moment the
		// mode was unlocked. `get_smart_wash_params` was then never sent and the setting never
		// appeared, with nothing in the log to say so. Registration is split for that reason.
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const asked = sendRequest.mock.calls.map((call) => call[1]);
		expect(asked).toContain(GET_WASH_TOWEL_MODE);
		expect(asked).toContain(GET_SMART_WASH_PARAMS);
		expect(vacuum.folderOf(SET_SMART_WASH_PARAMS)).toBe("settings");
	});

	it("sends each probe the empty object its wrapper builds", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const payloadOf = (method: string): unknown => sendRequest.mock.calls.find((call) => call[1] === method)?.[2];
		expect(payloadOf(GET_WASH_TOWEL_MODE)).toEqual({});
		expect(payloadOf(GET_SMART_WASH_PARAMS)).toEqual({});
		expect(payloadOf(APP_GET_CARPET_DEEP_CLEAN_STATUS)).toEqual({});
	});

	it("reads all three at start-up, because none of them is in the status packet", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		for (const getter of [GET_WASH_TOWEL_MODE, GET_SMART_WASH_PARAMS, APP_GET_CARPET_DEEP_CLEAN_STATUS]) {
			// Twice: once as the probe, once to seed the state.
			expect(sendRequest.mock.calls.filter((call) => call[1] === getter).length, getter).toBe(2);
		}
	});

	it("never writes anything by itself", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const sent = sendRequest.mock.calls.map((call) => call[1]);
		for (const setter of [SET_WASH_TOWEL_MODE, SET_SMART_WASH_PARAMS, APP_SET_CARPET_DEEP_CLEAN_STATUS]) {
			expect(sent, setter).not.toContain(setter);
		}
	});

	it("registers the frequency as a picker whose entries are seconds plus a by-room sentinel", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const spec = vacuum.specOf("settings", SET_SMART_WASH_PARAMS);
		expect(spec.type).toBe("number");
		expect(Object.keys(spec.states).map(Number)).toEqual([SMART_WASH_BY_ROOM, ...washIntervalSeconds()]);
	});

	it("registers the carpet setting as a switch, because the app's is one", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.specOf("settings", APP_SET_CARPET_DEEP_CLEAN_STATUS).type).toBe("boolean");
		expect(vacuum.specOf("settings", APP_SET_CARPET_DEEP_CLEAN_STATUS).role).toBe("switch");
	});

	it("survives a robot that answers nothing at all", async () => {
		sendRequest.mockRejectedValue(new Error("EHOSTUNREACH"));
		const vacuum = createVacuum();
		await expect(vacuum.runDetection()).resolves.toBeUndefined();

		expect(vacuum.folderOf(SET_WASH_TOWEL_MODE)).toBeNull();
		expect(vacuum.folderOf(APP_SET_CARPET_DEEP_CLEAN_STATUS)).toBeNull();
	});
});

/** Both services, sharing one recording of what they wrote. */
function harness(): {
	mopWash: V1MopWashSettingsService;
	carpet: V1CarpetDeepCleanService;
	written: Map<string, unknown>;
} {
	const written = new Map<string, unknown>();
	const deps = {
		adapter: {
			translationManager: { get: (_key: string, fallback: string) => fallback },
			setStateChanged: vi.fn(async (id: string, state: { val: unknown }) => {
				written.set(id, state.val);
			}),
			rLog: vi.fn()
		},
		ensureState: vi.fn().mockResolvedValue(undefined),
		ensureFolder: vi.fn().mockResolvedValue(undefined)
	} as unknown as FeatureDependencies;

	return {
		mopWash: new V1MopWashSettingsService(deps, "duid-test"),
		carpet: new V1CarpetDeepCleanService(deps, "duid-test"),
		written
	};
}

function mopWashService(): V1MopWashSettingsService {
	return harness().mopWash;
}

function carpetService(): V1CarpetDeepCleanService {
	return harness().carpet;
}
