import { afterEach, describe, expect, it, vi } from "vitest";
import { MapEngine } from "./MapEngine";
import type { EngineConnection, MapEngineHost, SelectOption } from "./types";

/**
 * The floor selector's labels, and where they come from after a rename.
 *
 * The selector itself is built from `commands.load_multi_map.common.states`, read once when the
 * device is chosen. That object is rewritten by the adapter's polling cycle, so a map renamed from
 * this tab keeps its old label in the selector for as long as the tab stays open - the second of the
 * two faults that made a rename on the selector unworkable.
 *
 * The map list is re-read the moment a rename is judged, so its names are the fresher ones and
 * `setMapNames` lets them win. What it must **not** do is change which floors exist: `selectFloor`
 * writes to `commands.load_multi_map`, and offering a switch to a slot that command does not know
 * would be a control that cannot work.
 */

let live: MapEngine | null = null;

async function startEngine(states: Record<string, string> | null): Promise<{
	engine: MapEngine;
	floors: SelectOption[][];
}> {
	const connection: EngineConnection = {
		sendTo: vi.fn().mockResolvedValue({}),
		getObject: vi.fn(async (id: string) =>
			id.endsWith("commands.load_multi_map") && states ? { common: { states } } : null,
		),
		getStates: vi.fn().mockResolvedValue({}),
		subscribeState: vi.fn().mockResolvedValue(undefined),
		unsubscribeState: vi.fn(),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const container = document.createElement("div");
	document.body.appendChild(container);

	const floors: SelectOption[][] = [];
	const host: MapEngineHost = {
		container,
		t: (_key: string, fallback: string) => fallback,
		onFloors: (list) => floors.push(list),
	};

	const engine = new MapEngine(connection, host);
	live = engine;
	await engine.init("roborock.0");

	// `init` picks no robot without a device list, so the definitions are loaded by hand - the same
	// call `selectRobot` makes.
	(engine as unknown as { currentRobotDuid: string | null }).currentRobotDuid = "duid1";
	await (engine as unknown as { populateFloors(duid: string, root: string): Promise<void> })
		.populateFloors("duid1", "roborock.0.Devices.duid1");

	return { engine, floors };
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.replaceChildren();
});

describe("floor labels", () => {
	it("takes the name the map list reports over the one the command object carries", async () => {
		const { engine, floors } = await startEngine({ "0": "Erdgeschoss", "1": "Keller" });
		expect(floors.at(-1)).toEqual([
			{ value: "0", label: "Erdgeschoss" },
			{ value: "1", label: "Keller" },
		]);

		engine.setMapNames({ "0": "Parterre", "1": "Keller" });

		expect(floors.at(-1)).toEqual([
			{ value: "0", label: "Parterre" },
			{ value: "1", label: "Keller" },
		]);
	});

	it("says nothing when no label actually changed", async () => {
		// The map list is re-read on every polling cycle, so this runs often. Re-emitting an unchanged
		// list would re-render the top bar for nothing.
		const { engine, floors } = await startEngine({ "0": "Erdgeschoss", "1": "Keller" });
		const before = floors.length;

		engine.setMapNames({ "0": "Erdgeschoss", "1": "Keller" });
		expect(floors.length).toBe(before);
	});

	it("does not invent a floor the command object does not know", async () => {
		// The list can hold a slot `load_multi_map` was never given - and `selectFloor` writes to that
		// very command. A selector entry for it would be a switch the adapter cannot carry out.
		const { engine, floors } = await startEngine({ "0": "Erdgeschoss", "1": "Keller" });

		engine.setMapNames({ "0": "Erdgeschoss", "1": "Keller", "2": "Dachgeschoss" });

		expect(floors.at(-1)?.map((floor) => floor.value)).toEqual(["0", "1"]);
	});

	it("leaves a robot without a selector without one", async () => {
		// A single map is not a choice, and the adapter does not even create the command object below
		// `max_multi_map > 1`. The map list must not turn that into a dropdown of one.
		const { engine, floors } = await startEngine(null);
		expect(floors.at(-1)).toEqual([]);

		engine.setMapNames({ "0": "Erdgeschoss" });
		expect(floors.at(-1)).toEqual([]);
	});

	it("keeps the fresher name when the floors are rebuilt", async () => {
		// The two arrive independently: the list through a state subscription, the floors through the
		// object read of a device switch. Whichever lands second must not undo the other, or the label
		// would depend on the order two unrelated round trips happen to finish in.
		const { engine, floors } = await startEngine({ "0": "Erdgeschoss", "1": "Keller" });
		engine.setMapNames({ "0": "Parterre" });

		await (engine as unknown as { populateFloors(duid: string, root: string): Promise<void> })
			.populateFloors("duid1", "roborock.0.Devices.duid1");

		expect(floors.at(-1)).toEqual([
			{ value: "0", label: "Parterre" },
			{ value: "1", label: "Keller" },
		]);
	});
});
