import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import {
	CLOSE_VALLEY_TIMER,
	GET_VALLEY_TIMER,
	MIN_WINDOW_HOURS,
	SET_VALLEY_TIMER,
	V1OffPeakChargingService,
	isSendableWindow,
	parseOffPeakResponse,
	valleyTimerParams,
	windowLengthHours
} from "../../src/lib/features/vacuum/v1OffPeakCharging";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * The off-peak charging window.
 *
 * Two things here are worth more than the rest and are tested first: **the order of the four
 * numbers**, which is read from the app's own caller rather than inferred from the Do Not Disturb
 * window it resembles, and **the six hour minimum**, which the app enforces and this adapter
 * refuses rather than silently works around.
 *
 * The measured answer of the test device is
 * `{start_hour:0, start_minute:0, end_hour:0, end_minute:0, enabled:0}`
 * (`_appanalysis/geraetefaehigkeiten-1786807834553.json`).
 */

describe("the four numbers that reach the robot", () => {
	it("sends start hour, start minute, end hour, end minute - in that order", () => {
		// A65:847576-847594: setValleyElectricityTimer(beginHour, beginMinute, endHour, endMinute).
		// A sign that this matters: swapped, 22:00-06:00 becomes a window at 06:22 to 00:00.
		expect(valleyTimerParams({ startHour: 22, startMinute: 30, endHour: 6, endMinute: 15 }))
			.toEqual([22, 30, 6, 15]);
	});

	it("wraps the window in a four element array, as the wrapper does", () => {
		// A65:230931-230947 builds `new Array(4)`, not an object with field names.
		const built = service().buildCommandParams(SET_VALLEY_TIMER, "22:00-06:00");
		expect(built).toEqual({ method: SET_VALLEY_TIMER, params: [22, 0, 6, 0] });
	});

	it("takes the wire spelling as well as the human one", () => {
		expect(service().buildCommandParams(SET_VALLEY_TIMER, [22, 0, 6, 0]).params).toEqual([22, 0, 6, 0]);
	});

	it("sends the two parameterless calls an empty array", () => {
		expect(service().buildCommandParams(GET_VALLEY_TIMER, undefined)).toEqual({ method: GET_VALLEY_TIMER, params: [] });
		expect(service().buildCommandParams(CLOSE_VALLEY_TIMER, true)).toEqual({ method: CLOSE_VALLEY_TIMER, params: [] });
	});

	it("refuses anything that is not a window", () => {
		for (const value of ["", "22:00", "22:00-25:00", "abends", null, 5, [22, 0, 6]]) {
			expect(() => service().buildCommandParams(SET_VALLEY_TIMER, value), `${JSON.stringify(value)}`).toThrow();
		}
	});
});

describe("the six hour minimum", () => {
	it("measures a window the way the app does, across midnight", () => {
		// A65:847668-847758: both ends as fractional hours, the wrap handled by subtracting from 24.
		expect(windowLengthHours({ startHour: 22, startMinute: 0, endHour: 6, endMinute: 0 })).toBe(8);
		expect(windowLengthHours({ startHour: 1, startMinute: 0, endHour: 9, endMinute: 30 })).toBe(8.5);
		expect(windowLengthHours({ startHour: 23, startMinute: 30, endHour: 0, endMinute: 30 })).toBe(1);
	});

	it("treats a window with both ends at the same time as empty, not as a full day", () => {
		// The app's own branch: `if (end === begin) length = 0`, which then fails the minimum.
		expect(windowLengthHours({ startHour: 3, startMinute: 0, endHour: 3, endMinute: 0 })).toBe(0);
		expect(isSendableWindow({ startHour: 3, startMinute: 0, endHour: 3, endMinute: 0 })).toBe(false);
	});

	it("accepts exactly six hours and refuses anything under it", () => {
		expect(MIN_WINDOW_HOURS).toBe(6);
		expect(isSendableWindow({ startHour: 0, startMinute: 0, endHour: 6, endMinute: 0 })).toBe(true);
		expect(isSendableWindow({ startHour: 0, startMinute: 1, endHour: 6, endMinute: 0 })).toBe(false);
	});

	it("refuses a short window with Roborock's own sentence instead of stretching it", () => {
		// The app stretches, because it knows which end the user just touched. A state write carries
		// no such context, so stretching here would move a time nobody asked to move.
		expect(() => service().buildCommandParams(SET_VALLEY_TIMER, "22:00-01:00"))
			.toThrow(/spans 3\.0 h.*6-hours/s);
	});
});

describe("reading the window back", () => {
	it("reads the measured answer of the test device", () => {
		expect(parseOffPeakResponse([{ start_hour: 0, start_minute: 0, end_hour: 0, end_minute: 0, enabled: 0 }]))
			.toEqual({ window: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 }, enabled: false });
	});

	it("reads a window the robot really holds", () => {
		expect(parseOffPeakResponse([{ start_hour: 22, start_minute: 30, end_hour: 6, end_minute: 0, enabled: 1 }]))
			.toEqual({ window: { startHour: 22, startMinute: 30, endHour: 6, endMinute: 0 }, enabled: true });
	});

	it("reads the answer through the request layer's own wrapper", () => {
		expect(parseOffPeakResponse({ data: [{ start_hour: 1, start_minute: 0, end_hour: 8, end_minute: 0, enabled: 1 }] })?.enabled).toBe(true);
	});

	it("reports no window when the robot marks the fields as unset", () => {
		// -1 is what the app writes locally for "not set" (A65:847311-847316).
		const parsed = parseOffPeakResponse([{ start_hour: -1, start_minute: -1, end_hour: -1, end_minute: -1, enabled: 0 }]);
		expect(parsed).toEqual({ window: null, enabled: false });
	});

	it("says nothing when the answer carries neither a window nor a flag", () => {
		expect(parseOffPeakResponse("unknown_method")).toBeNull();
		expect(parseOffPeakResponse([{}])).toBeNull();
		expect(parseOffPeakResponse(null)).toBeNull();
	});
});

/** A service whose writes can be inspected. */
function harness(): { service: V1OffPeakChargingService; written: Map<string, unknown> } {
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
	return { service: new V1OffPeakChargingService(deps, "duid-test"), written };
}

function service(): V1OffPeakChargingService {
	return harness().service;
}

describe("what the window publishes", () => {
	const id = (name: string): string => `Devices.duid-test.${name}`;

	it("publishes both ends, the flag and the writable mirror", async () => {
		const { service: s, written } = harness();
		await s.applyResponse([{ start_hour: 22, start_minute: 30, end_hour: 6, end_minute: 0, enabled: 1 }]);

		expect(written.get(id("deviceStatus.valley_electricity_start"))).toBe("22:30");
		expect(written.get(id("deviceStatus.valley_electricity_end"))).toBe("06:00");
		expect(written.get(id("deviceStatus.valley_electricity_enabled"))).toBe(true);
		expect(written.get(id(`settings.${SET_VALLEY_TIMER}`))).toBe("22:30-06:00");
	});

	it("leaves the fields empty when the robot reports no window", async () => {
		const { service: s, written } = harness();
		await s.applyResponse([{ start_hour: -1, start_minute: -1, end_hour: -1, end_minute: -1, enabled: 0 }]);

		expect(written.get(id("deviceStatus.valley_electricity_start"))).toBe("");
		expect(written.get(id(`settings.${SET_VALLEY_TIMER}`))).toBe("");
	});
});

describe("who is offered off-peak charging", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set();
		sendRequest = vi.fn(async (_duid: string, method: string) => {
			if (rejected.has(method)) return "unknown_method";
			if (method === GET_VALLEY_TIMER) return [{ start_hour: 0, start_minute: 0, end_hour: 0, end_minute: 0, enabled: 0 }];
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

	it("offers all three commands to a robot that answers the getter", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(SET_VALLEY_TIMER)).toBe("settings");
		expect(vacuum.folderOf(CLOSE_VALLEY_TIMER)).toBe("settings");
		expect(vacuum.folderOf(GET_VALLEY_TIMER)).toBe("queries");
	});

	it("offers nothing to a robot that does not know it", async () => {
		rejected.add(GET_VALLEY_TIMER);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(SET_VALLEY_TIMER)).toBeNull();
		expect(vacuum.folderOf(CLOSE_VALLEY_TIMER)).toBeNull();
	});

	it("registers the window as text and the off command as a button, not as one switch", async () => {
		// The protocol has no field that switches the mode; modelling it as a switch would mean
		// inventing a window whenever somebody turns it on.
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.specOf("settings", SET_VALLEY_TIMER).type).toBe("string");
		expect(vacuum.specOf("settings", CLOSE_VALLEY_TIMER).role).toBe("button");
	});

	it("reads the window at start-up, because it is in no status packet", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		// Twice: once as the probe, once to seed the states.
		expect(sendRequest.mock.calls.filter((call) => call[1] === GET_VALLEY_TIMER).length).toBe(2);
	});

	it("never switches anything on by itself", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const sent = sendRequest.mock.calls.map((call) => call[1]);
		expect(sent).not.toContain(SET_VALLEY_TIMER);
		expect(sent).not.toContain(CLOSE_VALLEY_TIMER);
	});
});
