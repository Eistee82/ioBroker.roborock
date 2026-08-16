import { afterEach, describe, expect, it, vi } from "vitest";
import { MAP_LIST_STATE, MapListSource, checkMapRename, mapNameBytes } from "./mapListSource";
import type { EngineConnection } from "../engine/types";

/**
 * The map list, and the rename that hangs off it.
 *
 * Two failures are worth guarding against here, and neither is "nothing is shown". The first is a
 * rename addressed to the **wrong slot** - the numbers start at 0 on every robot, so an off-by-one
 * renames the other floor. The second is the length rule: it counts the app's bytes, not characters,
 * and every test written with ASCII passes whether the rule is right or wrong. So the names below
 * are deliberately German.
 */

const ROOT = `roborock.0.Devices.duid1.${MAP_LIST_STATE}`;
const RENAME_OBJECT = "roborock.0.Devices.duid1.commands.name_multi_map";

/** What the adapter publishes for the test device. */
const MEASURED = JSON.stringify([
	{ mapFlag: 0, name: "Erdgeschoss", addTime: 1786788440, backupCount: 1, lastBackupTime: 1786781087 },
	{ mapFlag: 1, name: "Keller", addTime: 1733229641, backupCount: 1, lastBackupTime: 1733229675 },
]);

let live: MapListSource | null = null;

afterEach(() => {
	live?.destroy();
	live = null;
});

function harness(options: { list?: unknown; renameCommand?: boolean } = {}) {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();
	const reported: { maps: { mapFlag: number; name: string | null }[]; renameSupported: boolean }[] = [];
	const errors: string[] = [];
	const sendTo = vi.fn(async () => ({ result: "accepted" }));

	const connection = {
		sendTo,
		getObject: vi.fn(async (id: string) => (id === RENAME_OBJECT && options.renameCommand !== false ? { common: {} } : null)),
		getStates: vi.fn(async (ids: string[]) => {
			const answer: Record<string, any> = {};
			for (const id of ids) if (id === ROOT && options.list !== undefined) answer[id] = { val: options.list };
			return answer;
		}),
		subscribeState: vi.fn(async (id: string, handler: (id: string, state: any) => void) => {
			const list = subscriptions.get(id) ?? [];
			list.push(handler);
			subscriptions.set(id, list);
		}),
		unsubscribeState: vi.fn((id: string, handler: (id: string, state: any) => void) => {
			const list = (subscriptions.get(id) ?? []).filter(entry => entry !== handler);
			if (list.length) subscriptions.set(id, list);
			else subscriptions.delete(id);
		}),
		getObjectViewSystem: vi.fn(),
	} as unknown as EngineConnection;

	const source = new MapListSource(connection, {
		onMapList: model => reported.push({ maps: model.maps.map(entry => ({ mapFlag: entry.mapFlag, name: entry.name })), renameSupported: model.renameSupported }),
		onError: message => errors.push(message),
	});
	live = source;

	return {
		source,
		connection,
		sendTo,
		subscriptions,
		reported,
		errors,
		fire: (val: unknown) => {
			for (const handler of subscriptions.get(ROOT) ?? []) handler(ROOT, { val });
		},
	};
}

describe("checkMapRename", () => {
	const maps = [
		{ mapFlag: 0, name: "Erdgeschoss", addTime: null, backupCount: 0, lastBackupTime: null },
		{ mapFlag: 1, name: "Keller", addTime: null, backupCount: 0, lastBackupTime: null },
	];

	it("lets a new name through", () => {
		expect(checkMapRename("Dachgeschoss", 1, maps)).toBeNull();
	});

	it("trims before it judges", () => {
		expect(checkMapRename("  Dachgeschoss  ", 1, maps)).toBeNull();
		expect(checkMapRename("   ", 1, maps)).toBe("empty");
	});

	it("refuses a name another map carries, and allows the map's own", () => {
		// The app refuses the duplicate and permits the repeat (A65:919952-920008). The second half
		// matters: refusing it would turn a harmless re-send into an error.
		expect(checkMapRename("Erdgeschoss", 1, maps)).toBe("duplicate");
		expect(checkMapRename("Erdgeschoss", 0, maps)).toBe("unchanged");
	});

	it("counts bytes, not characters", () => {
		// Fifteen umlauts are fifteen *characters* and thirty of the app's bytes, and thirty is one
		// too many - the limit is `< 30`. A room name of the same length would be allowed, which is
		// exactly the confusion this test exists to catch.
		const fifteenUmlauts = "ü".repeat(15);
		expect(fifteenUmlauts.length).toBe(15);
		expect(mapNameBytes(fifteenUmlauts)).toBe(30);
		expect(checkMapRename(fifteenUmlauts, 1, maps)).toBe("too_long");

		expect(checkMapRename("ü".repeat(14), 1, maps)).toBeNull();
	});

	it("stops one character before the limit for plain letters too", () => {
		expect(checkMapRename("a".repeat(29), 1, maps)).toBeNull();
		expect(checkMapRename("a".repeat(30), 1, maps)).toBe("too_long");
	});
});

describe("MapListSource", () => {
	it("reads the list the adapter published", async () => {
		const h = harness({ list: MEASURED });
		await h.source.setDevice("roborock.0", "duid1");

		expect(h.reported.at(-1)?.maps).toEqual([
			{ mapFlag: 0, name: "Erdgeschoss" },
			{ mapFlag: 1, name: "Keller" },
		]);
		expect(h.reported.at(-1)?.renameSupported).toBe(true);
	});

	it("follows a rename made elsewhere", async () => {
		// The whole reason the list is read from `mapInventory.maps`: the adapter re-reads the robot's
		// list to judge a rename, so the new name arrives here on its own.
		const h = harness({ list: MEASURED });
		await h.source.setDevice("roborock.0", "duid1");

		h.fire(JSON.stringify([{ mapFlag: 0, name: "Parterre" }, { mapFlag: 1, name: "Keller" }]));
		expect(h.reported.at(-1)?.maps.map(entry => entry.name)).toEqual(["Parterre", "Keller"]);
	});

	it("lists the maps but hides the rename when the adapter published no command", async () => {
		const h = harness({ list: MEASURED, renameCommand: false });
		await h.source.setDevice("roborock.0", "duid1");

		expect(h.reported.at(-1)?.maps).toHaveLength(2);
		expect(h.reported.at(-1)?.renameSupported).toBe(false);
	});

	it("reports nothing for a robot that never published the state", async () => {
		const h = harness();
		await h.source.setDevice("roborock.0", "duid1");

		expect(h.reported.at(-1)?.maps).toEqual([]);
	});

	it("reports nothing rather than failing when the state cannot be read", async () => {
		const h = harness({ list: MEASURED });
		(h.connection.getStates as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no socket"));

		await expect(h.source.setDevice("roborock.0", "duid1")).resolves.toBeUndefined();
		expect(h.reported.at(-1)?.maps).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("does not carry one robot's maps over to the next", async () => {
		const h = harness({ list: MEASURED });
		await h.source.setDevice("roborock.0", "duid1");

		await h.source.setDevice("roborock.0", "duid2");
		expect(h.reported.at(-1)?.maps).toEqual([]);
		expect(h.subscriptions.has(ROOT)).toBe(false);
	});

	it("sends the rename as the object the command state documents", async () => {
		const h = harness({ list: MEASURED });
		await h.source.setDevice("roborock.0", "duid1");

		expect(await h.source.rename(1, "  Untergeschoss  ")).toBeNull();
		expect(h.sendTo).toHaveBeenCalledWith("roborock.0", "set_state", {
			duid: "duid1",
			folder: "commands",
			command: "name_multi_map",
			// Trimmed here, and the wire shape - an array holding `{multi_map, name, length}` - is the
			// adapter's job. Building it here would put the byte count in two places.
			value: JSON.stringify({ mapFlag: 1, name: "Untergeschoss" }),
		});
	});

	it("sends nothing that the adapter would refuse", async () => {
		const h = harness({ list: MEASURED });
		await h.source.setDevice("roborock.0", "duid1");

		expect(await h.source.rename(1, "Erdgeschoss")).toBe("duplicate");
		expect(await h.source.rename(1, "")).toBe("empty");
		expect(await h.source.rename(1, "ü".repeat(15))).toBe("too_long");
		expect(await h.source.rename(1, "Keller")).toBe("unchanged");
		expect(h.sendTo).not.toHaveBeenCalled();
	});

	it("refuses with a reason rather than swallowing the click when there is no command", async () => {
		const h = harness({ list: MEASURED, renameCommand: false });
		await h.source.setDevice("roborock.0", "duid1");

		expect(await h.source.rename(1, "Untergeschoss")).toBe("unavailable");
		expect(h.sendTo).not.toHaveBeenCalled();
	});

	it("reports a send that failed", async () => {
		const h = harness({ list: MEASURED });
		await h.source.setDevice("roborock.0", "duid1");
		(h.sendTo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("instance is down"));

		await h.source.rename(1, "Untergeschoss");
		expect(h.errors).toEqual(["instance is down"]);
	});

	it("stops reporting once it is destroyed", async () => {
		const h = harness({ list: MEASURED });
		await h.source.setDevice("roborock.0", "duid1");
		const before = h.reported.length;

		h.source.destroy();
		h.fire("[]");
		expect(h.reported.length).toBe(before);
	});
});
