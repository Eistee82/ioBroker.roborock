import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import {
	GET_MULTI_MAPS_LIST,
	MapInventoryStates,
	RESTORE_PROBE,
	V1MapInventoryService,
	allBackups,
	parseMultiMapsList
} from "../../src/lib/features/vacuum/v1MapInventory";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * Which map is loaded, and what the robot says about its backups.
 *
 * The answer below is the **measured** one of the test device
 * (`_appanalysis/geraetefaehigkeiten-1786790619395.json`): two floors, one backup each, and the
 * backups occupying slots 4 and 5 while the floors are 0 and 1. That gap between the two number
 * spaces is the reason several assertions here look pedantic - `recover_multi_map` is handed the
 * flag of the **live** map, so confusing the two would name a different floor.
 */

/** What the a65 really answers to `get_multi_maps_list`. */
const MEASURED_LIST = [{
	max_multi_map: 4,
	max_bak_map: 1,
	multi_map_count: 2,
	map_info: [
		{ mapFlag: 0, add_time: 1786788440, length: 11, name: "Erdgeschoss", bak_maps: [{ mapFlag: 4, add_time: 1786781087 }] },
		{ mapFlag: 1, add_time: 1733229641, length: 6, name: "Keller", bak_maps: [{ mapFlag: 5, add_time: 1733229675 }] }
	]
}];

describe("reading the map list", () => {
	it("reads the two floors of the test device with their backups", () => {
		const inventory = parseMultiMapsList(MEASURED_LIST);

		expect(inventory).not.toBeNull();
		expect([inventory?.maxMaps, inventory?.maxBackups, inventory?.mapCount]).toEqual([4, 1, 2]);
		expect(inventory?.maps.map((slot) => [slot.mapFlag, slot.name])).toEqual([[0, "Erdgeschoss"], [1, "Keller"]]);
	});

	it("keeps a backup attached to the floor it belongs to", () => {
		// The whole point of carrying `ofMapFlag`: on a two-floor robot, attaching the Keller backup
		// to Erdgeschoss would be a restore offer pointing at the wrong floor.
		const backups = allBackups(parseMultiMapsList(MEASURED_LIST)!);

		expect(backups).toEqual([
			{ mapFlag: 4, addTime: 1786781087, ofMapFlag: 0, ofMapName: "Erdgeschoss" },
			{ mapFlag: 5, addTime: 1733229675, ofMapFlag: 1, ofMapName: "Keller" }
		]);
	});

	it("keeps the backup's own slot apart from the flag a restore would be given", () => {
		// `recover_multi_map` takes the live map's flag (A65:691527-691529), not the backup's. The
		// two differ on the test device - 0/1 against 4/5 - so a test that let them collapse would
		// hide exactly the mistake worth preventing.
		const backups = allBackups(parseMultiMapsList(MEASURED_LIST)!);
		for (const backup of backups) {
			expect(backup.mapFlag).not.toBe(backup.ofMapFlag);
		}
	});

	it("reads the answer through the request layer's own wrapper", () => {
		expect(parseMultiMapsList({ data: MEASURED_LIST })?.mapCount).toBe(2);
		expect(parseMultiMapsList(MEASURED_LIST[0])?.mapCount).toBe(2);
	});

	it("takes a floor without a backup as a floor without a backup", () => {
		const inventory = parseMultiMapsList([{ map_info: [{ mapFlag: 0, name: "Erdgeschoss" }] }]);
		expect(inventory?.maps[0].backups).toEqual([]);
		expect(allBackups(inventory!)).toEqual([]);
	});

	it("skips a slot whose flag is unusable rather than inventing one", () => {
		// The flag is what every floor state in this adapter is keyed by; a guessed one would attach
		// rooms and backups to the wrong floor.
		const inventory = parseMultiMapsList([{ map_info: [{ name: "No flag" }, { mapFlag: -1 }, { mapFlag: 2, name: "Real" }] }]);
		expect(inventory?.maps.map((slot) => slot.mapFlag)).toEqual([2]);
	});

	it("says nothing when the answer carries no map list", () => {
		expect(parseMultiMapsList("unknown_method")).toBeNull();
		expect(parseMultiMapsList([{ max_multi_map: 4 }])).toBeNull();
		expect(parseMultiMapsList(null)).toBeNull();
	});
});

describe("what the inventory publishes", () => {
	function createService(): { service: V1MapInventoryService; written: Map<string, unknown> } {
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

		return { service: new V1MapInventoryService(deps, "duid-test"), written };
	}

	const id = (name: string): string => `Devices.duid-test.${name}`;

	it("counts the backups and publishes them as one value", async () => {
		const { service, written } = createService();
		await service.applyMultiMapsList(MEASURED_LIST);

		expect(written.get(id(MapInventoryStates.backupCount))).toBe(2);
		expect(JSON.parse(String(written.get(id(MapInventoryStates.backups))))).toHaveLength(2);
	});

	it("names the active map out of the list it already read", async () => {
		const { service, written } = createService();
		await service.applyMultiMapsList(MEASURED_LIST);
		await service.publishActiveMap(1);

		expect(written.get(id(MapInventoryStates.activeMapFlag))).toBe(1);
		expect(written.get(id(MapInventoryStates.activeMapName))).toBe("Keller");
	});

	it("publishes the flag even when it cannot name it", async () => {
		// A robot whose list has not been read yet still has an active slot, and the number is worth
		// more than nothing; the name simply stays empty rather than being invented.
		const { service, written } = createService();
		await service.publishActiveMap(1);

		expect(written.get(id(MapInventoryStates.activeMapFlag))).toBe(1);
		expect(written.get(id(MapInventoryStates.activeMapName))).toBeNull();
	});

	it("writes nothing while the active map did not move", async () => {
		// This runs on every status poll, which on this adapter is every couple of seconds.
		const { service, written } = createService();
		expect(await service.publishActiveMap(0)).toBe(true);
		written.clear();

		expect(await service.publishActiveMap(0)).toBe(false);
		expect(written.size).toBe(0);
	});

	it("re-names the active map when the list is read again", async () => {
		// A rename in the app changes the name without changing the flag, so the guard above must
		// not swallow it.
		const { service, written } = createService();
		await service.publishActiveMap(0);
		await service.applyMultiMapsList(MEASURED_LIST);

		expect(written.get(id(MapInventoryStates.activeMapName))).toBe("Erdgeschoss");
	});

	it("says plainly whether the robot can restore at all", async () => {
		const { service, written } = createService();
		await service.publishRestoreSupport(false);
		expect(written.get(id(MapInventoryStates.restoreSupported))).toBe(false);
	});
});

describe("who is offered the map inventory", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set([RESTORE_PROBE]); // what the test device really does
		sendRequest = vi.fn(async (_duid: string, method: string) => {
			if (rejected.has(method)) return "unknown_method";
			if (method === GET_MULTI_MAPS_LIST) return MEASURED_LIST;
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
	}

	function createVacuum(): TestVacuum {
		return new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
	}

	it("offers the read button to a robot that lists its maps", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(GET_MULTI_MAPS_LIST)).toBe("queries");
	});

	it("offers nothing to a robot that does not list them", async () => {
		rejected.add(GET_MULTI_MAPS_LIST);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(GET_MULTI_MAPS_LIST)).toBeNull();
	});

	it("reports that the test device cannot restore, although it lists backups", async () => {
		// The finding this whole state exists for: two backups in the list, `unknown_method` for
		// the restore list. Without saying so, the backups look like something a user could use.
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(sendRequest.mock.calls.map((call) => call[1])).toContain(RESTORE_PROBE);
		expect(adapterMock.setStateChanged).toHaveBeenCalledWith(
			`Devices.duid-test.${MapInventoryStates.restoreSupported}`,
			{ val: false, ack: true }
		);
	});

	it("reports that a robot which answers the restore list can restore", async () => {
		rejected.delete(RESTORE_PROBE);
		sendRequest.mockImplementation(async (_duid: string, method: string) => {
			if (method === RESTORE_PROBE) return [[3, 1786781087]];
			if (method === GET_MULTI_MAPS_LIST) return MEASURED_LIST;
			return "unknown_method";
		});

		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(adapterMock.setStateChanged).toHaveBeenCalledWith(
			`Devices.duid-test.${MapInventoryStates.restoreSupported}`,
			{ val: true, ack: true }
		);
	});

	it("never sends a destructive map command", async () => {
		// None of these is built, and the detection must not reach one by accident.
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const sent = sendRequest.mock.calls.map((call) => call[1]);
		for (const destructive of ["del_map", "recover_map", "recover_multi_map", "reset_map"]) {
			expect(sent).not.toContain(destructive);
		}
	});
});
