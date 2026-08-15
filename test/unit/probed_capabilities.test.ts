import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_DRY_TIME_SECONDS,
	DRYER_OFF_VALUE,
	DRYER_TIMES,
	DUST_COLLECTION_MODES,
	GET_CLEAN_ESTIMATE_INFO,
	GET_DRYER_SETTING,
	GET_DUST_COLLECTION_MODE,
	GET_TIMEZONE,
	SET_DRYER_SETTING,
	SET_DUST_COLLECTION_MODE,
	V1ProbedCapabilityService,
	isKnownDryTime,
	isKnownDustCollectionMode,
	parseCleanEstimateResponse,
	parseDryerSettingResponse,
	parseDustCollectionModeResponse,
	parseTimezoneResponse
} from "../../src/lib/features/vacuum/v1ProbedCapabilities";

/**
 * The empty mode, the drying setting, the robot time zone and the cleaning estimate.
 *
 * The proofs live in the module comment with their line numbers in the decompiled control plugin.
 * These tests guard the two things a proof cannot: that the implementation still sends what the
 * proof says, and that it refuses what the proof does **not** cover. The second is the important
 * half here - the empty mode has a plausible-looking value 3 that the app never writes, and a
 * drying duration is a bare number in which any value looks equally valid.
 *
 * Every payload asserted below is taken from a real answer of the test device, recorded in
 * `_appanalysis/geraetefaehigkeiten-1786790619395.json`.
 */

/** A minimal `FeatureDependencies` double: it records writes instead of performing them. */
function createDeps() {
	const states = new Map<string, unknown>();
	const objects = new Map<string, unknown>();

	const deps = {
		adapter: {
			namespace: "roborock.0",
			translationManager: { get: (_key: string, fallback: string) => fallback },
			setStateChanged: vi.fn(async (id: string, value: { val: unknown }) => {
				states.set(id, value.val);
			}),
			setState: vi.fn(async (id: string, value: { val: unknown }) => {
				states.set(id, value.val);
			}),
			rLog: vi.fn(),
			errorMessage: (e: unknown) => String(e)
		},
		ensureState: vi.fn(async (id: string, common: unknown) => {
			objects.set(id, common);
		}),
		ensureFolder: vi.fn(async () => undefined),
		log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
	};

	return { deps: deps as any, states, objects };
}

/** The service with all four registered, which is what makes it answer for their methods. */
function createService() {
	const { deps, states, objects } = createDeps();
	const service = new V1ProbedCapabilityService(deps, "duid-test");
	const registered: { name: string; spec: Record<string, unknown>; group?: string }[] = [];
	const add = (name: string, spec: Record<string, unknown>, group?: string): void => {
		registered.push({ name, spec, group });
	};

	service.registerTimezoneCommand(add);
	service.registerCleanEstimateCommand(add);
	service.registerDustCollectionModeCommand(add);
	service.registerDryerSettingCommand(add);
	return { service, deps, states, objects, registered };
}

/** The empty mode answer of the test device. */
const DUST_MODE_ANSWER = { mode: 0 };

/** The drying answer of the test device, unabridged. */
const DRYER_ANSWER = {
	status: 1,
	on: { cliff_on: 1000, cliff_off: 1000, count: 10, dry_time: 7200, dry_heating_film_time: 3600 },
	off: { cliff_on: 500, cliff_off: 500, count: 10 }
};

/** The estimate answer of the test device, unabridged. */
const ESTIMATE_ANSWER = {
	clean_estimate: {
		total_area: 27070000,
		remaining_area: 2790000,
		total_battery: 13,
		remaining_battery: 1,
		total_time: 1949,
		remaining_time: 200,
		resume_wait_time: 0,
		count: 1,
		percent: 0,
		clean_time_rate: "72.00",
		battery_consumption_rate: "0.62"
	}
};

describe("the values the empty mode may be set to", () => {
	it("offers exactly the four keys getCollectionModes carries", () => {
		// A65:438312-438375 - keys 0, 1, 2 and 4; three is skipped.
		expect(DUST_COLLECTION_MODES.map((mode) => mode.value)).toEqual([0, 1, 2, 4]);
	});

	it("does not offer mode 3, which the debug table names but no picker writes", () => {
		// A65:379765 lists 0..3, but its fourth entry has no label in any language
		// (`dust_collection_title_4` is absent from lib/protocols/roborock_strings.json) and no
		// picker entry. Writing 3 would be a guessed device command.
		expect(isKnownDustCollectionMode(3)).toBe(false);
		expect(isKnownDustCollectionMode(0)).toBe(true);
		expect(isKnownDustCollectionMode(4)).toBe(true);
		expect(isKnownDustCollectionMode(5)).toBe(false);
	});
});

describe("the durations the drying setting may be set to", () => {
	it("offers the seconds the two drying pages carry", () => {
		// A65:438261-438311 (three) and A65:780146-780182 (the same three plus 18000).
		expect(DRYER_TIMES.map((time) => time.seconds)).toEqual([7200, 10800, 14400, 18000]);
	});

	it("refuses a duration that only looks reasonable", () => {
		expect(isKnownDryTime(3600)).toBe(false);
		expect(isKnownDryTime(7200)).toBe(true);
		expect(isKnownDryTime(21600)).toBe(false);
	});
});

describe("reading what the robot answers", () => {
	it("takes the time zone out of its one-element array", () => {
		expect(parseTimezoneResponse(["Europe/Berlin"])).toBe("Europe/Berlin");
		expect(parseTimezoneResponse({ data: ["Europe/Berlin"] })).toBe("Europe/Berlin");
	});

	it("refuses an empty or absent time zone rather than publishing one", () => {
		expect(parseTimezoneResponse([])).toBeNull();
		expect(parseTimezoneResponse([""])).toBeNull();
		expect(parseTimezoneResponse(null)).toBeNull();
		expect(parseTimezoneResponse({ timezone: "Europe/Berlin" })).toBeNull();
	});

	it("refuses a bare string, because that is how the robot rejects a method", () => {
		// Without the array the rejection `{"result":"unknown_method"}` would become a time zone
		// named "unknown_method". This is the one getter here where the two shapes could collide.
		expect(parseTimezoneResponse("unknown_method")).toBeNull();
		expect(parseTimezoneResponse("Europe/Berlin")).toBeNull();
	});

	it("takes the empty mode out of its object", () => {
		expect(parseDustCollectionModeResponse(DUST_MODE_ANSWER)).toBe(0);
		expect(parseDustCollectionModeResponse([{ mode: 4 }])).toBe(4);
		expect(parseDustCollectionModeResponse({ status: 1 })).toBeNull();
	});

	it("takes only status and on.dry_time out of the drying answer", () => {
		expect(parseDryerSettingResponse(DRYER_ANSWER)).toEqual({ enabled: true, dryTimeSeconds: 7200 });
		expect(parseDryerSettingResponse({ status: 0, on: { dry_time: 14400 } })).toEqual({
			enabled: false,
			dryTimeSeconds: 14400
		});
		expect(parseDryerSettingResponse({ off: { cliff_on: 500 } })).toBeNull();
	});

	it("converts the estimate into the units the app displays", () => {
		const estimate = parseCleanEstimateResponse(ESTIMATE_ANSWER);
		// Areas are square millimetres (A65:780898 divides by 1000000), times are seconds
		// (A65:780959 runs them through fromSecToMin).
		expect(estimate).toEqual({
			totalArea: 27.1,
			remainingArea: 2.8,
			totalTime: 1949,
			remainingTime: 200,
			percent: 0,
			remainingBattery: 1,
			timePerArea: 72,
			batteryPerArea: 0.62
		});
	});

	it("reads the two rates although the robot sends them as strings", () => {
		const estimate = parseCleanEstimateResponse(ESTIMATE_ANSWER);
		expect(typeof estimate?.timePerArea).toBe("number");
		expect(typeof estimate?.batteryPerArea).toBe("number");
	});

	it("refuses an answer without the clean_estimate wrapper", () => {
		expect(parseCleanEstimateResponse({ total_area: 27070000 })).toBeNull();
		expect(parseCleanEstimateResponse(null)).toBeNull();
	});
});

describe("the payloads that go on the wire", () => {
	it("sends the empty mode as {mode}", () => {
		// A65:230399-230410 - setDustCollectionMode(a0) builds {mode: a0}.
		const { service } = createService();
		expect(service.buildCommandParams(SET_DUST_COLLECTION_MODE, 2)).toEqual({
			method: SET_DUST_COLLECTION_MODE,
			params: { mode: 2 }
		});
	});

	it("refuses an empty mode the app never writes", () => {
		const { service } = createService();
		expect(() => service.buildCommandParams(SET_DUST_COLLECTION_MODE, 3)).toThrow(/accepts 0, 1, 2, 4/);
		expect(() => service.buildCommandParams(SET_DUST_COLLECTION_MODE, "smart")).toThrow();
	});

	it("sends the drying setting as {on:{dry_time}, status}", () => {
		// A65:230339-230374 - Object.assign({on:{dry_time:a0}, status:a1}, {}).
		const { service } = createService();
		expect(service.buildCommandParams(SET_DRYER_SETTING, 10800)).toEqual({
			method: SET_DRYER_SETTING,
			params: { on: { dry_time: 10800 }, status: 1 }
		});
	});

	it("still carries a duration when drying is switched off", () => {
		// A65:780065-780073 - the off switch sends the currently selected time with status 0.
		const { service } = createService();
		expect(service.buildCommandParams(SET_DRYER_SETTING, DRYER_OFF_VALUE)).toEqual({
			method: SET_DRYER_SETTING,
			params: { on: { dry_time: DEFAULT_DRY_TIME_SECONDS }, status: 0 }
		});
	});

	it("switches off with the duration the robot last reported, not the fallback", async () => {
		const { service } = createService();
		await service.applyDryerSettingResponse({ status: 1, on: { dry_time: 14400 } });
		expect(service.buildCommandParams(SET_DRYER_SETTING, DRYER_OFF_VALUE)).toEqual({
			method: SET_DRYER_SETTING,
			params: { on: { dry_time: 14400 }, status: 0 }
		});
	});

	it("refuses a drying duration the app never writes", () => {
		const { service } = createService();
		expect(() => service.buildCommandParams(SET_DRYER_SETTING, 3600)).toThrow(/accepts 0 \(off\)/);
	});

	it("sends the estimate getter an empty object and the others an empty array", () => {
		// A65:228341 builds `{}` where its neighbours at A65:228560 and A65:229104 build `[]`.
		const { service } = createService();
		expect(service.buildCommandParams(GET_CLEAN_ESTIMATE_INFO, true)).toEqual({
			method: GET_CLEAN_ESTIMATE_INFO,
			params: {}
		});
		expect(service.buildCommandParams(GET_TIMEZONE, true)).toEqual({ method: GET_TIMEZONE, params: [] });
		expect(service.buildCommandParams(GET_DRYER_SETTING, true)).toEqual({ method: GET_DRYER_SETTING, params: [] });
		expect(service.buildCommandParams(GET_DUST_COLLECTION_MODE, true)).toEqual({
			method: GET_DUST_COLLECTION_MODE,
			params: []
		});
	});

	it("claims only what it registered", () => {
		const { service } = createService();
		for (const method of [GET_TIMEZONE, GET_CLEAN_ESTIMATE_INFO, GET_DUST_COLLECTION_MODE, SET_DUST_COLLECTION_MODE, GET_DRYER_SETTING, SET_DRYER_SETTING]) {
			expect(service.handles(method)).toBe(true);
		}
		expect(service.handles("set_dnd_timer")).toBe(false);
		expect(service.handles("app_set_dryer_status")).toBe(false);
	});
});

describe("the objects that are registered", () => {
	it("puts the two writable settings in settings and the read buttons in queries", () => {
		const { registered } = createService();
		const groupOf = (name: string): string | undefined => registered.find((entry) => entry.name === name)?.group;

		expect(groupOf(SET_DUST_COLLECTION_MODE)).toBe("settings");
		expect(groupOf(SET_DRYER_SETTING)).toBe("settings");
		expect(groupOf(GET_TIMEZONE)).toBe("queries");
		expect(groupOf(GET_CLEAN_ESTIMATE_INFO)).toBe("queries");
		expect(groupOf(GET_DUST_COLLECTION_MODE)).toBe("queries");
		expect(groupOf(GET_DRYER_SETTING)).toBe("queries");
	});

	it("offers the empty mode as a choice of exactly the four proven values", () => {
		const { registered } = createService();
		const spec = registered.find((entry) => entry.name === SET_DUST_COLLECTION_MODE)?.spec;
		expect(Object.keys(spec?.states as Record<string, string>)).toEqual(["0", "1", "2", "4"]);
	});

	it("offers the drying setting as off plus the four durations", () => {
		const { registered } = createService();
		const spec = registered.find((entry) => entry.name === SET_DRYER_SETTING)?.spec;
		expect(Object.keys(spec?.states as Record<string, string>)).toEqual(["0", "7200", "10800", "14400", "18000"]);
	});
});

describe("what is published", () => {
	it("writes the time zone into a read-only state", async () => {
		const { service, states, objects } = createService();
		await expect(service.applyTimezoneResponse(["Europe/Berlin"])).resolves.toBe(true);
		expect(states.get("roborock.0.Devices.duid-test.deviceStatus.timezone")).toBeUndefined();
		expect(states.get("Devices.duid-test.deviceStatus.timezone")).toBe("Europe/Berlin");
		expect((objects.get("Devices.duid-test.deviceStatus.timezone") as { write?: boolean }).write).toBe(false);
	});

	it("publishes the eight estimate fields whose meaning is proven", async () => {
		const { service, states } = createService();
		await expect(service.applyCleanEstimateResponse(ESTIMATE_ANSWER)).resolves.toBe(true);

		expect(states.get("Devices.duid-test.cleaningInfo.estimateTotalArea")).toBe(27.1);
		expect(states.get("Devices.duid-test.cleaningInfo.estimateRemainingArea")).toBe(2.8);
		expect(states.get("Devices.duid-test.cleaningInfo.estimateTotalTime")).toBe(1949);
		expect(states.get("Devices.duid-test.cleaningInfo.estimateRemainingTime")).toBe(200);
		expect(states.get("Devices.duid-test.cleaningInfo.estimateProgress")).toBe(0);
		expect(states.get("Devices.duid-test.cleaningInfo.estimateRemainingBattery")).toBe(1);
		expect(states.get("Devices.duid-test.cleaningInfo.estimateTimePerArea")).toBe(72);
		expect(states.get("Devices.duid-test.cleaningInfo.estimateBatteryPerArea")).toBe(0.62);
	});

	it("does not publish the three fields the app never reads", async () => {
		const { service, states } = createService();
		await service.applyCleanEstimateResponse(ESTIMATE_ANSWER);
		for (const name of ["estimateTotalBattery", "estimateResumeWaitTime", "estimateCount"]) {
			expect(states.has(`Devices.duid-test.cleaningInfo.${name}`)).toBe(false);
		}
	});

	it("mirrors the empty mode into the writable state", async () => {
		const { service, states } = createService();
		await expect(service.applyDustCollectionModeResponse(DUST_MODE_ANSWER)).resolves.toBe(true);
		expect(states.get(`Devices.duid-test.settings.${SET_DUST_COLLECTION_MODE}`)).toBe(0);
	});

	it("publishes a mode outside the four rather than hiding it", async () => {
		const { service, states, deps } = createService();
		await expect(service.applyDustCollectionModeResponse({ mode: 3 })).resolves.toBe(true);
		expect(states.get(`Devices.duid-test.settings.${SET_DUST_COLLECTION_MODE}`)).toBe(3);
		expect(deps.adapter.rLog).toHaveBeenCalled();
	});

	it("shows the duration while drying is on and the off position while it is not", async () => {
		const { service, states } = createService();
		await service.applyDryerSettingResponse(DRYER_ANSWER);
		expect(states.get(`Devices.duid-test.settings.${SET_DRYER_SETTING}`)).toBe(7200);
		expect(states.get("Devices.duid-test.deviceStatus.dryer_enabled")).toBe(true);
		expect(states.get("Devices.duid-test.deviceStatus.dryer_dry_time")).toBe(7200);

		await service.applyDryerSettingResponse({ status: 0, on: { dry_time: 7200 } });
		expect(states.get(`Devices.duid-test.settings.${SET_DRYER_SETTING}`)).toBe(DRYER_OFF_VALUE);
	});

	it("reports an unreadable answer instead of writing something", async () => {
		const { service, states, deps } = createService();
		await expect(service.applyDryerSettingResponse("unknown_method")).resolves.toBe(false);
		await expect(service.applyTimezoneResponse("unknown_method")).resolves.toBe(false);
		await expect(service.applyDustCollectionModeResponse("unknown_method")).resolves.toBe(false);
		await expect(service.applyCleanEstimateResponse("unknown_method")).resolves.toBe(false);
		expect(states.size).toBe(0);
		expect(deps.adapter.rLog).toHaveBeenCalledTimes(4);
	});
});
