import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import {
	GET_MULTI_MAPS_LIST,
	MapInventoryStates,
	backupMenuOffered,
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

/**
 * `new_feature_info` of the test device, measured twice
 * (`_appanalysis/24-faehigkeitsmerkmale.md` §7): bit 49, `isSupportBackupMap`, is set.
 */
const WITH_BACKUP_BIT = 2247395306799103;

/** The same value with bit 49 cleared - a robot whose map menu offers no restore entry. */
const WITHOUT_BACKUP_BIT = WITH_BACKUP_BIT - 2 ** 49;

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
	function createService(featureInfo?: unknown): { service: V1MapInventoryService; written: Map<string, unknown> } {
		const written = new Map<string, unknown>();
		const deps = {
			adapter: {
				translationManager: { get: (_key: string, fallback: string) => fallback },
				setStateChanged: vi.fn(async (id: string, state: { val: unknown }) => {
					written.set(id, state.val);
				}),
				rLog: vi.fn(),
				errorMessage: (e) => String(e),
				getStateAsync: vi.fn(async () => (featureInfo === undefined ? null : { val: featureInfo }))
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

	it("offers a restore when there are backups and the firmware bit is set", async () => {
		// The two proven halves together. Bit 49 of `new_feature_info` is the whole `visible`
		// condition of the app's two backup menu entries (A65:725540-725576), and `bak_maps` is the
		// list they are filled from.
		const { service, written } = createService(WITH_BACKUP_BIT);
		await service.applyMultiMapsList(MEASURED_LIST);

		expect(written.get(id(MapInventoryStates.backupCount))).toBe(2);
		expect(written.get(id(MapInventoryStates.restoreSupported))).toBe(true);
	});

	it("says no when the firmware does not offer the menu, however many backups there are", async () => {
		const { service, written } = createService(WITHOUT_BACKUP_BIT);
		await service.applyMultiMapsList(MEASURED_LIST);

		expect(written.get(id(MapInventoryStates.backupCount))).toBe(2);
		expect(written.get(id(MapInventoryStates.restoreSupported))).toBe(false);
	});

	it("says no when the robot keeps no backups, bit or no bit", async () => {
		const { service, written } = createService(WITH_BACKUP_BIT);
		await service.applyMultiMapsList([{ max_multi_map: 4, max_bak_map: 1, multi_map_count: 1, map_info: [{ mapFlag: 0, add_time: 1, length: 3, name: "EG", bak_maps: [] }] }]);

		expect(written.get(id(MapInventoryStates.restoreSupported))).toBe(false);
	});

	it("lets the backup count decide alone when the bitfield is not there", async () => {
		// The asymmetry, and the whole reason this method was repaired: a **cleared** bit is the
		// robot saying no, a **missing** field says nothing. Answering "no" to silence is what told
		// the user his robot could not restore, on no evidence at all.
		const { service, written } = createService(undefined);
		await service.applyMultiMapsList(MEASURED_LIST);

		expect(written.get(id(MapInventoryStates.restoreSupported))).toBe(true);
	});

	it("reads bit 49 by dividing, because a shift would truncate", async () => {
		// Bit 49 is above 32; `value & (1 << 49)` gives the wrong answer in JavaScript. The app hits
		// the same wall and divides (A65:234000-234037). A test rather than a comment, because the
		// symptom is a silent false.
		expect(backupMenuOffered(WITH_BACKUP_BIT)).toBe(true);
		expect(backupMenuOffered(WITHOUT_BACKUP_BIT)).toBe(false);
		// The measured value of the test device, whose bit 49 is set.
		expect(backupMenuOffered(2247395306799103)).toBe(true);
	});

	it("tells a denial and a silence apart", async () => {
		expect(backupMenuOffered(null)).toBeNull();
		expect(backupMenuOffered(undefined)).toBeNull();
		expect(backupMenuOffered("")).toBeNull();
		expect(backupMenuOffered("not a number")).toBeNull();
		expect(backupMenuOffered(-1)).toBeNull();
		// A string that *is* a number still counts - ioBroker states carry whatever was written.
		expect(backupMenuOffered(String(WITH_BACKUP_BIT))).toBe(true);
	});
});

describe("who is offered the map inventory", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set<string>();
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

	it("reports that the test device would be offered its backups, and asks nothing extra for it", async () => {
		// The correction this state was repaired for. The old version probed `get_recover_maps`,
		// which belongs to the app's *other* restore flow and is rejected by this robot - so the
		// state said "no" while the app's backup menu would have shown two entries.
		const vacuum = createVacuum();
		await vacuum.runDetection();
		// The list read is deliberately not awaited by the detection, and the restore state is
		// written at the end of it. Three macrotasks rather than a count of microtasks: the chain
		// is `getState` -> parse -> five state writes, and counting its awaits is how a test starts
		// failing the next time one is added.
		for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(sendRequest.mock.calls.map((call) => call[1])).not.toContain("get_recover_maps");
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
