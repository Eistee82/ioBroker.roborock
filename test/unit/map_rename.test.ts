import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import { GET_MULTI_MAPS_LIST, parseMultiMapsList } from "../../src/lib/features/vacuum/v1MapInventory";
import type { MapInventory } from "../../src/lib/features/vacuum/v1MapInventory";
import { MAX_MAP_NAME_LENGTH, isMapNameAcceptable, mapNameLength } from "../../src/common/mapNameLength";
import {
	NAME_MULTI_MAP,
	V1MapRenameService,
	buildNameMultiMapPayload,
	checkAgainstMapList,
	judgeRename,
	parseMapRenameRequest
} from "../../src/lib/features/vacuum/v1MapRename";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * Renaming a stored map.
 *
 * The list below is the **measured** answer of the test device
 * (`_appanalysis/geraetefaehigkeiten-1786790619395.json`). It matters here for one reason beyond
 * realism: the robot returns a `length` beside each name, and it is 11 for "Erdgeschoss" and 6 for
 * "Keller" - the same numbers {@link mapNameLength} computes. Write path and read path therefore
 * talk about the same quantity, and the fixture is what proves it rather than a comment.
 */
const MEASURED_LIST = [{
	max_multi_map: 4,
	max_bak_map: 1,
	multi_map_count: 2,
	map_info: [
		{ mapFlag: 0, add_time: 1786788440, length: 11, name: "Erdgeschoss", bak_maps: [{ mapFlag: 4, add_time: 1786781087 }] },
		{ mapFlag: 1, add_time: 1733229641, length: 6, name: "Keller", bak_maps: [{ mapFlag: 5, add_time: 1733229675 }] }
	]
}];

/** The measured list as this adapter reads it. */
function measuredInventory(): MapInventory {
	return parseMultiMapsList(MEASURED_LIST)!;
}

/** A list carrying exactly the given names, keyed 0, 1, 2 ... */
function inventoryOf(...names: string[]): MapInventory {
	return parseMultiMapsList([{ map_info: names.map((name, index) => ({ mapFlag: index, name })) }])!;
}

describe("how long the app thinks a name is", () => {
	it("agrees with the length the robot itself reports", () => {
		// `get_multi_maps_list` carries `"name":"Erdgeschoss","length":11` and
		// `"name":"Keller","length":6`. If this ever disagrees, the adapter is sending a number the
		// robot would not have sent for the same text.
		for (const slot of MEASURED_LIST[0].map_info) {
			expect(mapNameLength(slot.name)).toBe(slot.length);
		}
	});

	it("counts bytes, not characters", () => {
		// The single most likely mistake here: `MAX_ROOM_NAME_LENGTH` is 30 too and counts
		// characters. Five characters, six of what the robot counts.
		expect("Küche".length).toBe(5);
		expect(mapNameLength("Küche")).toBe(6);
	});

	it("follows the app's own arithmetic, including where it is not real UTF-8", () => {
		// getRealLength, A65:418603-418660: <=128 -> 1, <2048 -> 2, <0xD800 -> 3, <0xDC00 -> 4,
		// else 3. The last two rules mean a single emoji costs 4 + 3 = 7, where UTF-8 needs 4.
		// Kept deliberately - the robot echoes this counter back, so being "more correct" here would
		// make the adapter disagree with the device.
		expect(mapNameLength("a")).toBe(1);
		expect(mapNameLength("ü")).toBe(2);
		expect(mapNameLength("客")).toBe(3);
		expect(mapNameLength("🙂")).toBe(7);
		expect(mapNameLength("")).toBe(0);
	});

	it("answers the same question the tab asks, so the two cannot drift", () => {
		// The browser refuses with `isMapNameAcceptable` and the adapter with `parseMapRenameRequest`.
		// One shared predicate rather than two readings of the same rule - the split between them is
		// where a limit quietly becomes two limits.
		expect(isMapNameAcceptable("Keller")).toBe(true);
		expect(isMapNameAcceptable("")).toBe(false);
		expect(isMapNameAcceptable("a".repeat(MAX_MAP_NAME_LENGTH - 1))).toBe(true);
		expect(isMapNameAcceptable("a".repeat(MAX_MAP_NAME_LENGTH))).toBe(false);
		expect(isMapNameAcceptable("ä".repeat(15))).toBe(false);
	});
});

describe("what goes on the wire", () => {
	it("wraps the single entry in a list", () => {
		// The trap. The wrapper (A65:229457-229472) passes its argument through unchanged, so it
		// says nothing; the caller `editMapName` (A65:461846-461858) builds
		// `nameMultiMap([{multi_map, name, length}])`. A flat object looks right and is wrong.
		const payload = buildNameMultiMapPayload({ mapFlag: 1, name: "Dachboden" });

		expect(Array.isArray(payload)).toBe(true);
		expect(payload).toEqual([{ multi_map: 1, name: "Dachboden", length: 9 }]);
	});

	it("sends the name exactly as it was given", () => {
		// `specEncode` is `isSpecSupported() ? escape(s) : s`, and `isSpecSupported()` is
		// `isMiApp && (a14/a15 || a19)` with `isMiApp = !NativeModules.RRPluginSDK`
		// (A65:182830-182848, A65:185232-185249). The Roborock app has that bridge, so nothing is
		// escaped there - and the adapter reads names raw, so writing them escaped would make it
		// disagree with itself.
		const payload = buildNameMultiMapPayload({ mapFlag: 0, name: "Dachgeschoß" });

		expect(payload[0].name).toBe("Dachgeschoß");
		expect(payload[0].name).not.toContain("%");
	});
});

describe("what the adapter refuses to send", () => {
	it("takes a name one byte below the limit", () => {
		const name = "a".repeat(MAX_MAP_NAME_LENGTH - 1);
		expect(parseMapRenameRequest({ mapFlag: 0, name })).toEqual({ mapFlag: 0, name });
	});

	it("refuses a name of exactly the limit, because the app's test is strict", () => {
		// `if (len < 30)` - A65:920030-920036. A `<=` here would let through the one length the app
		// stops at, and the failure would arrive as a rename that silently did not happen.
		expect(() => parseMapRenameRequest({ mapFlag: 0, name: "a".repeat(MAX_MAP_NAME_LENGTH) }))
			.toThrow(/30 bytes/);
	});

	it("refuses fifteen umlauts, which are only fifteen characters", () => {
		// The counter-check that separates this limit from `MAX_ROOM_NAME_LENGTH`. Testing with
		// ASCII alone would never tell the two apart.
		const name = "ä".repeat(15);
		expect(name.length).toBeLessThan(MAX_MAP_NAME_LENGTH);
		expect(() => parseMapRenameRequest({ mapFlag: 0, name })).toThrow(/30/);
	});

	it("refuses an empty name instead of silently doing nothing", () => {
		// The app returns without sending anything (A65:920014-920020). A command state that
		// swallows a write looks exactly like one that worked, so this says so out loud.
		expect(() => parseMapRenameRequest({ mapFlag: 0, name: "   " })).toThrow(/empty/);
	});

	it("refuses a rename that does not name a map", () => {
		// Defaulting to the active map would rename the wrong floor on a robot that has just
		// switched.
		expect(() => parseMapRenameRequest({ name: "Keller" })).toThrow(/mapFlag/);
		expect(() => parseMapRenameRequest({ mapFlag: 1.5, name: "Keller" })).toThrow(/whole number/);
		expect(() => parseMapRenameRequest({ mapFlag: -1, name: "Keller" })).toThrow(/whole number/);
	});

	it("refuses a payload it cannot read", () => {
		expect(() => parseMapRenameRequest("")).toThrow(/payload/);
		expect(() => parseMapRenameRequest("not json")).toThrow(/JSON/);
		expect(() => parseMapRenameRequest([1, 2])).toThrow(/object/);
		expect(() => parseMapRenameRequest({ mapFlag: 0, name: 7 })).toThrow(/as text/);
	});

	it("reads the spellings somebody is likely to write", () => {
		expect(parseMapRenameRequest('{"mapFlag": 1, "name": "Keller"}')).toEqual({ mapFlag: 1, name: "Keller" });
		// The wire spelling, for anyone copying the payload out of the analysis.
		expect(parseMapRenameRequest({ multi_map: 1, name: "Keller" })).toEqual({ mapFlag: 1, name: "Keller" });
		// And the shape the method itself sends.
		expect(parseMapRenameRequest([{ mapFlag: 1, name: " Keller " }])).toEqual({ mapFlag: 1, name: "Keller" });
	});
});

describe("what the map list refuses", () => {
	it("refuses a slot the robot never listed", () => {
		expect(checkAgainstMapList({ mapFlag: 3, name: "Dachboden" }, measuredInventory().maps))
			.toMatch(/no map 3/);
	});

	it("refuses a name another map already carries, as the app does", () => {
		// `name_already_exists`, A65:919952-920008.
		expect(checkAgainstMapList({ mapFlag: 0, name: "Keller" }, measuredInventory().maps))
			.toMatch(/already called/);
	});

	it("lets a map keep the name it already has", () => {
		// The app's duplicate filter excludes the map being edited, and so does this. Turning a
		// harmless repeat into an error would be stricter than the thing being copied.
		expect(checkAgainstMapList({ mapFlag: 1, name: "Keller" }, measuredInventory().maps)).toBeNull();
	});

	it("refuses everything while no list has been read", () => {
		expect(checkAgainstMapList({ mapFlag: 0, name: "Keller" }, [])).toMatch(/not listed any maps/);
	});
});

describe("who decides whether it worked", () => {
	it("believes the list when it carries the new name", () => {
		expect(judgeRename({ mapFlag: 1, name: "Untergeschoss" }, inventoryOf("Erdgeschoss", "Untergeschoss")))
			.toEqual({ kind: "confirmed" });
	});

	it("calls it ineffective while the robot still reports the old name", () => {
		// `name_multi_map` has no documented reply, and `classifyRobotAnswer` only judges `set_*` -
		// so the answer alone would report success for a rename that changed nothing.
		expect(judgeRename({ mapFlag: 1, name: "Untergeschoss" }, measuredInventory()))
			.toEqual({ kind: "ineffective", reported: "'Keller'" });
	});

	it("says it does not know when the list could not be read", () => {
		// Weaker than "it failed", and that is the point: an unreadable list says nothing about the
		// robot's map.
		expect(judgeRename({ mapFlag: 1, name: "Keller" }, null).kind).toBe("no_answer");
		expect(judgeRename({ mapFlag: 9, name: "Keller" }, measuredInventory()).kind).toBe("no_answer");
	});
});

describe("the rename command", () => {
	let logged: string[];
	let marks: Array<Record<string, unknown>>;
	let inventory: MapInventory | null;
	let reread: ReturnType<typeof vi.fn>;
	let service: V1MapRenameService;
	let translations: Record<string, string>;

	beforeEach(() => {
		logged = [];
		marks = [];
		translations = {};
		inventory = measuredInventory();
		reread = vi.fn(async () => inventory);

		const deps = {
			adapter: {
				translations,
				translationManager: { get: (_key: string, fallback: string) => fallback },
				rLog: vi.fn((..._args: unknown[]) => {
					logged.push(String(_args[5]));
				}),
				markCommandOutcome: vi.fn(async (_duid: string, report: Record<string, unknown>) => {
					marks.push(report);
				}),
				errorMessage: (e: unknown) => String(e)
			}
		} as unknown as FeatureDependencies;

		service = new V1MapRenameService(deps, "duid-test", {
			lastInventory: () => inventory,
			rereadMapList: reread
		});
	});

	it("declares one JSON command and says the limit in it", () => {
		const registered = new Map<string, Record<string, unknown>>();
		service.registerCommands((name, spec) => registered.set(name, spec));

		expect([...registered.keys()]).toEqual([NAME_MULTI_MAP]);
		// `type: "json"` is this adapter's own spelling; `processCommand` turns it into a string
		// state with `role: "json"`, exactly as `name_segment` is declared.
		expect(registered.get(NAME_MULTI_MAP)?.type).toBe("json");
		expect(String(registered.get(NAME_MULTI_MAP)?.desc)).toContain(String(MAX_MAP_NAME_LENGTH));
	});

	it("puts the limit into the translated hint rather than into eleven files", () => {
		// A `%s` in the translation, filled here. Otherwise changing the constant would leave eleven
		// language files claiming the old number, and nothing would fail.
		translations["map_rename_hint"] = "Kartenname, weniger als %s Byte.";
		const registered = new Map<string, Record<string, unknown>>();
		service.registerCommands((name, spec) => registered.set(name, spec));

		expect(registered.get(NAME_MULTI_MAP)?.desc).toBe(`Kartenname, weniger als ${MAX_MAP_NAME_LENGTH} Byte.`);
	});

	it("builds the request the analysis proves", () => {
		expect(service.buildCommandParams(NAME_MULTI_MAP, '{"mapFlag": 1, "name": "Untergeschoss"}')).toEqual({
			method: NAME_MULTI_MAP,
			params: [{ multi_map: 1, name: "Untergeschoss", length: 13 }]
		});
	});

	it("stops a name that is too long before anything is sent", () => {
		// The limit bites in the adapter, not at the robot. A firmware that truncates or drops the
		// name would leave the adapter showing a rename that never happened.
		expect(() => service.buildCommandParams(NAME_MULTI_MAP, { mapFlag: 1, name: "ä".repeat(15) })).toThrow();
		expect(reread).not.toHaveBeenCalled();
	});

	it("confirms out of the freshly read list", async () => {
		service.buildCommandParams(NAME_MULTI_MAP, { mapFlag: 1, name: "Untergeschoss" });
		inventory = inventoryOf("Erdgeschoss", "Untergeschoss");
		await service.confirmPendingRenames();

		expect(reread).toHaveBeenCalledTimes(1);
		expect(marks).toEqual([{ command: NAME_MULTI_MAP, outcome: "confirmed", folder: "commands", extraArgs: undefined }]);
	});

	it("says so when the robot kept the old name", async () => {
		service.buildCommandParams(NAME_MULTI_MAP, { mapFlag: 1, name: "Untergeschoss" });
		await service.confirmPendingRenames();

		expect(marks[0].outcome).toBe("ineffective");
		expect(marks[0].extraArgs).toEqual(["immediately afterwards", "'Keller'"]);
	});

	it("claims nothing when the list could not be read back", async () => {
		service.buildCommandParams(NAME_MULTI_MAP, { mapFlag: 1, name: "Untergeschoss" });
		inventory = null;
		await service.confirmPendingRenames();

		expect(marks[0].outcome).toBe("no_answer");
	});

	it("asks nothing when no rename is waiting", async () => {
		await service.confirmPendingRenames();

		expect(reread).not.toHaveBeenCalled();
		expect(marks).toEqual([]);
	});

	it("judges only the newest rename, because both would land on the same state", async () => {
		service.buildCommandParams(NAME_MULTI_MAP, { mapFlag: 0, name: "Parterre" });
		service.buildCommandParams(NAME_MULTI_MAP, { mapFlag: 1, name: "Untergeschoss" });
		inventory = inventoryOf("Erdgeschoss", "Untergeschoss");
		await service.confirmPendingRenames();

		expect(marks).toHaveLength(1);
		expect(marks[0].outcome).toBe("confirmed");
	});
});

describe("who is offered the rename", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set<string>();
		const sendRequest = vi.fn(async (_duid: string, method: string) => {
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
			translations: {},
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

	it("offers it to a robot that lists its maps", async () => {
		// The capability question is "does this robot list maps at all", which is the very probe
		// `Feature.MapInventory` already runs. Nothing calls `name_multi_map` to find out whether it
		// works - a probe that renames a map is the rename, not a test.
		const vacuum = new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
		await vacuum.runDetection();

		expect(vacuum.folderOf(NAME_MULTI_MAP)).toBe("commands");
	});

	it("offers nothing to a robot that does not list them", async () => {
		rejected.add(GET_MULTI_MAPS_LIST);
		const vacuum = new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
		await vacuum.runDetection();

		expect(vacuum.folderOf(NAME_MULTI_MAP)).toBeNull();
	});
});
