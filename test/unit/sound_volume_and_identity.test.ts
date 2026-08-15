import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import {
	CHANGE_SOUND_VOLUME,
	GET_SOUND_VOLUME,
	SOUND_VOLUME_MAX,
	SOUND_VOLUME_MIN,
	TEST_SOUND_VOLUME,
	V1SoundVolumeService,
	parseSoundVolumeResponse,
	toSoundVolume
} from "../../src/lib/features/vacuum/v1SoundVolume";
import {
	APP_GET_LOCALE,
	GET_SERIAL_NUMBER,
	V1DeviceIdentityService,
	parseLocaleResponse,
	parseSerialNumberResponse
} from "../../src/lib/features/vacuum/v1DeviceIdentity";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * The speaking volume and the read-only device identity.
 *
 * Both are proven in the module comments of `v1SoundVolume.ts` and `v1DeviceIdentity.ts`, with the
 * line of the decompiled plugin beside each value. What is pinned here is the part that can drift
 * without anybody noticing: the range that reaches a robot, and the fields that reach a user.
 *
 * The answers used below are the **measured** ones of the test device
 * (`_appanalysis/geraetefaehigkeiten-1786790619395.json`), not invented shapes.
 */

/** What the a65 really answers. */
const MEASURED = {
	[GET_SOUND_VOLUME]: [90],
	[GET_SERIAL_NUMBER]: [{ serial_number: "R50EED42502639" }],
	[APP_GET_LOCALE]: [{
		name: "custom_A.03.0309_CE",
		bom: "A.03.0309",
		location: "de",
		language: "en",
		wifiplan: "",
		timezone: "Europe/Berlin",
		logserver: "awsde0.fds.api.xiaomi.com",
		featureset: 3
	}]
} as Record<string, unknown>;

function createDeps(): { deps: FeatureDependencies; written: Array<{ id: string; val: unknown }> } {
	const written: Array<{ id: string; val: unknown }> = [];
	const deps = {
		adapter: {
			translationManager: { get: (_key: string, fallback: string) => fallback },
			setStateChanged: vi.fn(async (id: string, state: { val: unknown }) => {
				written.push({ id, val: state.val });
			}),
			rLog: vi.fn()
		},
		ensureState: vi.fn(async (id: string, _common: unknown) => {
			void id;
		}),
		ensureFolder: vi.fn().mockResolvedValue(undefined)
	} as unknown as FeatureDependencies;

	// `DeviceStateWriter` writes through `setStateChanged`, so both services land in the same list.
	return { deps, written };
}

describe("the range the volume is allowed to take", () => {
	it("is the one the app validates before sending, not the one its slider offers", () => {
		// A65:782569-782578 checks `>= 0 && <= 100` on the numeric-input path. The slider is
		// narrower and model-dependent (Default 30-90, A65:216992/217259-217272), which is a
		// property of a widget rather than of the command.
		expect(SOUND_VOLUME_MIN).toBe(0);
		expect(SOUND_VOLUME_MAX).toBe(100);
	});

	it("sends whole numbers, as every caller in the app does", () => {
		// `parseInt(value.toFixed(0))` at A65:862901-862906 and A65:930526-930531.
		expect(toSoundVolume(71.4)).toBe(71);
		expect(toSoundVolume(71.6)).toBe(72);
		expect(toSoundVolume("55")).toBe(55);
	});

	it("takes both ends", () => {
		expect(toSoundVolume(0)).toBe(0);
		expect(toSoundVolume(100)).toBe(100);
	});

	it("refuses everything outside it", () => {
		expect(() => toSoundVolume(101)).toThrow(/accepts 0 to 100/);
		expect(() => toSoundVolume(-1)).toThrow(/accepts 0 to 100/);
	});

	it("refuses a value that is not a number at all", () => {
		for (const value of [null, undefined, "", "   ", "loud", {}]) {
			expect(() => toSoundVolume(value), `${JSON.stringify(value)} should be refused`).toThrow();
		}
	});
});

describe("reading the volume back", () => {
	it("reads the array the robot really answers with", () => {
		expect(parseSoundVolumeResponse([90])).toBe(90);
		expect(parseSoundVolumeResponse({ data: [30] })).toBe(30);
	});

	it("refuses a bare value, because that is how a robot says it knows no such method", () => {
		expect(parseSoundVolumeResponse("unknown_method")).toBeNull();
		expect(parseSoundVolumeResponse(90)).toBeNull();
		expect(parseSoundVolumeResponse([])).toBeNull();
		expect(parseSoundVolumeResponse([90, 20])).toBeNull();
	});
});

describe("the payloads of the three sound commands", () => {
	function service(): V1SoundVolumeService {
		return new V1SoundVolumeService(createDeps().deps, "duid-test");
	}

	it("sends the two reads an empty array", () => {
		expect(service().buildCommandParams(GET_SOUND_VOLUME, undefined)).toEqual({ method: GET_SOUND_VOLUME, params: [] });
		expect(service().buildCommandParams(TEST_SOUND_VOLUME, true)).toEqual({ method: TEST_SOUND_VOLUME, params: [] });
	});

	it("wraps the volume in a one element array, as the wrapper does", () => {
		// A65:230787-230804 builds `new Array(1)`.
		expect(service().buildCommandParams(CHANGE_SOUND_VOLUME, 55)).toEqual({ method: CHANGE_SOUND_VOLUME, params: [55] });
	});

	it("publishes the volume onto the writable state", async () => {
		const { deps, written } = createDeps();
		const published = await new V1SoundVolumeService(deps, "duid-test").applyVolumeResponse([90]);

		expect(published).toBe(true);
		expect(written).toContainEqual({ id: "Devices.duid-test.settings.change_sound_volume", val: 90 });
	});
});

describe("what the robot says about itself", () => {
	it("reads the serial number out of the measured answer", () => {
		expect(parseSerialNumberResponse(MEASURED[GET_SERIAL_NUMBER])).toBe("R50EED42502639");
		expect(parseSerialNumberResponse({ data: [{ serial_number: "X" }] })).toBe("X");
	});

	it("says nothing when the answer carries no serial number", () => {
		expect(parseSerialNumberResponse("unknown_method")).toBeNull();
		expect(parseSerialNumberResponse([{}])).toBeNull();
		expect(parseSerialNumberResponse([{ serial_number: "   " }])).toBeNull();
	});

	it("reads the five locale fields it publishes", () => {
		expect(parseLocaleResponse(MEASURED[APP_GET_LOCALE])).toEqual({
			packageName: "custom_A.03.0309_CE",
			bom: "A.03.0309",
			location: "de",
			language: "en",
			timezone: "Europe/Berlin"
		});
	});

	it("leaves out the three fields whose meaning is not established", () => {
		// `logserver`, `wifiplan` and `featureset` are in the answer and deliberately not published;
		// see the module comment for the reason behind each.
		const parsed = parseLocaleResponse(MEASURED[APP_GET_LOCALE]) as Record<string, unknown>;
		for (const absent of ["logserver", "wifiplan", "featureset"]) {
			expect(parsed).not.toHaveProperty(absent);
		}
	});

	it("says nothing when the answer carries none of them", () => {
		expect(parseLocaleResponse([{ logserver: "x", featureset: 3 }])).toBeNull();
		expect(parseLocaleResponse("unknown_method")).toBeNull();
	});

	it("publishes the five fields and never logs the serial number", async () => {
		const { deps, written } = createDeps();
		const identity = new V1DeviceIdentityService(deps, "duid-test");

		await identity.applySerialNumberResponse(MEASURED[GET_SERIAL_NUMBER]);
		await identity.applyLocaleResponse(MEASURED[APP_GET_LOCALE]);

		const ids = written.map((entry) => entry.id);
		expect(ids).toContain("Devices.duid-test.deviceInfo.serial_number");
		expect(ids).toContain("Devices.duid-test.deviceInfo.bom");
		expect(ids).toContain("Devices.duid-test.deviceInfo.location");
		expect(ids).toContain("Devices.duid-test.deviceInfo.language");
		expect(ids).toContain("Devices.duid-test.deviceInfo.robot_timezone");
		expect(ids).toContain("Devices.duid-test.deviceInfo.package_name");
		expect(ids).not.toContain("Devices.duid-test.deviceInfo.logserver");
	});

	it("keeps the serial number out of the log even when the answer is unreadable", async () => {
		// The one reader whose payload is a per-device identifier. A warning is still a log line, so
		// it names the method and not what came back.
		const { deps } = createDeps();
		await new V1DeviceIdentityService(deps, "duid-test").applySerialNumberResponse(["R50-NOT-A-SHAPE"]);

		const logged = (deps.adapter.rLog as unknown as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => String(call[5]))
			.join(" ");
		expect(logged).toContain(GET_SERIAL_NUMBER);
		expect(logged).not.toContain("R50-NOT-A-SHAPE");
	});
});

describe("who is offered the volume and the device identity", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set();
		sendRequest = vi.fn(async (_duid: string, method: string) => {
			if (rejected.has(method)) return "unknown_method";
			if (method in MEASURED) return MEASURED[method];
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

	it("gives the test device both, because it answers both getters", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(CHANGE_SOUND_VOLUME)).toBe("settings");
		expect(vacuum.folderOf(TEST_SOUND_VOLUME)).toBe("commands");
		expect(vacuum.folderOf(GET_SOUND_VOLUME)).toBe("queries");
		expect(vacuum.folderOf(GET_SERIAL_NUMBER)).toBe("queries");
		expect(vacuum.folderOf(APP_GET_LOCALE)).toBe("queries");
	});

	it("publishes the volume with the bounds the tab needs to draw a slider", async () => {
		// The tab refuses to render a slider without both bounds, so an object without them would
		// silently show nothing.
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const spec = vacuum.specOf("settings", CHANGE_SOUND_VOLUME);
		expect(spec.type).toBe("number");
		expect(spec.min).toBe(SOUND_VOLUME_MIN);
		expect(spec.max).toBe(SOUND_VOLUME_MAX);
		expect(spec.write).toBe(true);
	});

	it("offers no volume to a robot that does not know the getter", async () => {
		rejected.add(GET_SOUND_VOLUME);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(CHANGE_SOUND_VOLUME)).toBeNull();
		expect(vacuum.folderOf(TEST_SOUND_VOLUME)).toBeNull();
	});

	it("offers no device identity to a robot that does not know the serial number", async () => {
		rejected.add(GET_SERIAL_NUMBER);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(GET_SERIAL_NUMBER)).toBeNull();
		expect(vacuum.folderOf(APP_GET_LOCALE)).toBeNull();
	});

	it("reads the volume at start-up, because it is in no status packet", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		// Twice: once as the probe, once to seed the slider.
		expect(sendRequest.mock.calls.filter((call) => call[1] === GET_SOUND_VOLUME).length).toBe(2);
	});

	it("never plays a sound by itself", async () => {
		// The one command here that makes the robot audible. Nothing in the detection may trigger it.
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(sendRequest.mock.calls.map((call) => call[1])).not.toContain(TEST_SOUND_VOLUME);
	});
});
