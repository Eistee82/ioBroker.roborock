import { afterEach, describe, expect, it, vi } from "vitest";
import { MapEngine } from "./MapEngine";
import { MAP_ZONE_DEFAULT_HALF_MM } from "./MapEngine";
import type { EngineConnection, MapEngineHost, MapZonesModel } from "./types";
import type { MapZone, MapZoneKind, ZoneBox } from "./mapZones";

/**
 * The robot's own walls and zones, as the engine wires them up.
 *
 * `mapZones.test.ts` proves the reading and the payloads, `mapZoneLayer.test.ts` the drawing and
 * the handles. What neither can prove is the wiring, and the wiring is where the risk is: what
 * finally goes out over `set_state` reaches a robot whose complete set of walls and zones is
 * rewritten by it.
 *
 * So this file drives the engine and inspects the message. Four properties are pinned:
 *
 *  1. **A zone being placed sends nothing.** Every move, resize and turn stays in the browser.
 *  2. **Saving sends exactly one `add_*`**, with the four corners as a JSON *string* - a
 *     `type: "json"` command state stringifies whatever it is given, so an array would arrive as
 *     "0,0,100,100".
 *  3. **Deleting names the zone by kind and index**, the position `remove_map_zone` counts.
 *  4. **A map the adapter would refuse is reported as refused**, rather than offered.
 */

interface EngineInternals {
	map: unknown;
	mapZones: MapZone[];
	mapZoneDraft: { kind: MapZoneKind; box: ZoneBox; origin: MapZone | null } | null;
	selectedMapZoneKey: string | null;
	refreshMapZones(): void;
	mapZoneParams(): unknown;
}

let live: MapEngine | null = null;

/** `[x0,y0, x1,y1, x2,y2, x3,y3]` of an upright zone, in the order the app writes. */
function uprightZone(left: number, bottom: number, right: number, top: number): number[] {
	return [left, top, right, top, right, bottom, left, bottom];
}

/**
 * A parsed V1 map with a readable geometry.
 *
 * `IMAGE.dimensions` and `position` are what `getMapParams()` needs; without them the engine has no
 * way to convert millimetres into pixels and reports the zones as unsupported.
 */
function mapWith(blocks: Record<string, unknown>): Record<string, unknown> {
	return {
		IMAGE: {
			dimensions: { width: 200, height: 200 },
			position: { left: 0, top: 0 },
			segments: { list: [] },
		},
		...blocks,
	};
}

async function startEngine(): Promise<{
	engine: MapEngine;
	internals: EngineInternals;
	sendTo: ReturnType<typeof vi.fn>;
	models: MapZonesModel[];
	errors: string[];
}> {
	const sendTo = vi.fn().mockResolvedValue({});
	const connection: EngineConnection = {
		sendTo,
		getObject: vi.fn().mockResolvedValue(null),
		getStates: vi.fn().mockResolvedValue({}),
		subscribeState: vi.fn().mockResolvedValue(undefined),
		unsubscribeState: vi.fn(),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const container = document.createElement("div");
	document.body.appendChild(container);

	const models: MapZonesModel[] = [];
	const errors: string[] = [];
	const host: MapEngineHost = {
		container,
		t: (_key: string, fallback: string, ...args: (string | number)[]) =>
			args.reduce<string>((text, value) => text.replace("%s", String(value)), fallback),
		onMapZones: (model) => models.push(model),
		onError: (message) => errors.push(message),
	};

	const engine = new MapEngine(connection, host);
	live = engine;
	await engine.init("roborock.0");

	const internals = engine as unknown as EngineInternals;
	// The engine reads the zones off whatever `this.map` holds; a map fixture is enough, and going
	// through the socket would test the subscription rather than the zones.
	(engine as unknown as { currentRobotDuid: string | null }).currentRobotDuid = "duid1";
	(engine as unknown as { mapImage: unknown }).mapImage = {
		dimensions: { width: 200, height: 200 },
		position: { left: 0, top: 0 },
	};

	return { engine, internals, sendTo, models, errors };
}

/** Loads a map into the engine and lets it read the zones off it. */
function loadMap(internals: EngineInternals, blocks: Record<string, unknown>): void {
	internals.map = mapWith(blocks);
	internals.refreshMapZones();
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.replaceChildren();
});

describe("reading the robot's zones off the map", () => {
	it("draws every wall and zone the map carries", async () => {
		const { internals } = await startEngine();
		loadMap(internals, {
			FORBIDDEN_ZONES: [uprightZone(1000, 1000, 2000, 2000)],
			NO_MOP_ZONE: [uprightZone(3000, 3000, 4000, 4000)],
			VIRTUAL_WALLS: [[500, 500, 1500, 500]],
		});

		expect(document.querySelectorAll("g.map-zone")).toHaveLength(3);
		expect(document.querySelectorAll("g.map-zone-no_go")).toHaveLength(1);
		expect(document.querySelectorAll("g.map-zone-no_mop")).toHaveLength(1);
		expect(document.querySelectorAll("g.map-zone-wall")).toHaveLength(1);
	});

	it("publishes the count of each kind separately", async () => {
		const { internals, models } = await startEngine();
		loadMap(internals, {
			FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100), uprightZone(200, 200, 300, 300)],
			VIRTUAL_WALLS: [[0, 0, 100, 0]],
		});

		const model = models[models.length - 1];
		expect(model.counts).toEqual({ no_go: 2, no_mop: 0, wall: 1 });
		expect(model.supported).toBe(true);
		expect(model.refusalText).toBeNull();
	});

	it("reports a map the adapter would refuse, and draws none of its zones", async () => {
		const { internals, models } = await startEngine();
		loadMap(internals, {
			CL_FORBIDDEN_ZONES: [[1, 2, 3, 4, 5, 6, 7, 8]],
			FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100)],
		});

		expect(models[models.length - 1].refusalText).toContain("CL_FORBIDDEN_ZONES");
		expect(document.querySelectorAll("g.map-zone")).toHaveLength(0);
	});

	it("drops a selection whose zone the map no longer has", async () => {
		// Otherwise the handles would stay on a rectangle that has moved on, and the delete handle
		// would then remove whatever took that index.
		const { engine, internals } = await startEngine();
		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100), uprightZone(200, 200, 300, 300)] });
		engine.selectMapZone("no_go:1");
		expect(internals.selectedMapZoneKey).toBe("no_go:1");

		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100)] });
		expect(internals.selectedMapZoneKey).toBeNull();
	});
});

describe("placing a new zone", () => {
	it("sends nothing until it is saved", async () => {
		const { engine, internals, sendTo, models } = await startEngine();
		loadMap(internals, {});

		engine.startMapZone("no_go");
		expect(sendTo).not.toHaveBeenCalled();
		expect(models[models.length - 1].drafting).toBe(true);
		// It is on the map, and marked as not yet stored.
		expect(document.querySelectorAll("g.map-zone-draft")).toHaveLength(1);
	});

	it("puts a wall down as a line and a zone as a square", async () => {
		const { engine, internals } = await startEngine();
		loadMap(internals, {});

		engine.startMapZone("wall");
		expect(internals.mapZoneDraft?.box.halfHeight).toBe(0);
		expect(internals.mapZoneDraft?.box.halfWidth).toBe(MAP_ZONE_DEFAULT_HALF_MM);

		engine.cancelMapZone();
		engine.startMapZone("no_mop");
		expect(internals.mapZoneDraft?.box.halfHeight).toBe(MAP_ZONE_DEFAULT_HALF_MM);
	});

	it("sends one add command with the four corners as a JSON string", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadMap(internals, {});

		engine.startMapZone("no_go");
		await engine.saveMapZone();

		expect(sendTo).toHaveBeenCalledTimes(1);
		const [instance, command, message] = sendTo.mock.calls[0];
		expect(instance).toBe("roborock.0");
		expect(command).toBe("set_state");
		expect(message.duid).toBe("duid1");
		expect(message.folder).toBe("commands");
		expect(message.command).toBe("add_no_go_zone");

		// A string, not an array: `coerceCommandValue` stringifies a `type: "json"` value, so an
		// array would arrive as "0,0,100,100" and be refused.
		expect(typeof message.value).toBe("string");
		const payload = JSON.parse(message.value);
		expect(payload).toHaveLength(8);
		expect(payload.every((value: unknown) => Number.isInteger(value))).toBe(true);
	});

	it("sends a wall as its two end points", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadMap(internals, {});

		engine.startMapZone("wall");
		await engine.saveMapZone();

		const message = sendTo.mock.calls[0][2];
		expect(message.command).toBe("add_virtual_wall");
		expect(JSON.parse(message.value)).toHaveLength(4);
	});

	it("takes the one being placed off the map once it is on its way", async () => {
		// It must not stay beside the zone the robot now holds, which would read as two.
		const { engine, internals, models } = await startEngine();
		loadMap(internals, {});

		engine.startMapZone("no_go");
		await engine.saveMapZone();

		expect(internals.mapZoneDraft).toBeNull();
		expect(document.querySelectorAll("g.map-zone-draft")).toHaveLength(0);
		expect(models[models.length - 1].drafting).toBe(false);
	});

	it("drops it on cancel without sending anything", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadMap(internals, {});

		engine.startMapZone("no_go");
		engine.cancelMapZone();

		expect(sendTo).not.toHaveBeenCalled();
		expect(internals.mapZoneDraft).toBeNull();
		expect(document.querySelectorAll("g.map-zone")).toHaveLength(0);
	});

	it("refuses to start on a map the adapter would refuse, and says why", async () => {
		const { engine, internals, errors, sendTo } = await startEngine();
		loadMap(internals, { CLF_FORBIDDEN_ZONES: [[1, 2, 3, 4, 5, 6, 7, 8]] });

		engine.startMapZone("no_go");
		expect(internals.mapZoneDraft).toBeNull();
		expect(errors[errors.length - 1]).toContain("CLF_FORBIDDEN_ZONES");
		expect(sendTo).not.toHaveBeenCalled();
	});

	it("stops at ten of a kind, the limit the adapter enforces", async () => {
		const { engine, internals } = await startEngine();
		loadMap(internals, {
			FORBIDDEN_ZONES: Array.from({ length: 10 }, (_, i) => uprightZone(i * 100, 0, i * 100 + 50, 50)),
		});

		engine.startMapZone("no_go");
		expect(internals.mapZoneDraft).toBeNull();

		// The other kinds are untouched: the limit is per kind, not a shared budget.
		engine.startMapZone("no_mop");
		expect(internals.mapZoneDraft?.kind).toBe("no_mop");
	});
});

describe("deleting a zone", () => {
	it("names it by kind and index, and carries what the user pointed at", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadMap(internals, {
			FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100), uprightZone(200, 200, 300, 300)],
			NO_MOP_ZONE: [uprightZone(500, 500, 600, 600)],
		});

		await engine.deleteMapZone("no_mop:0");

		const message = sendTo.mock.calls[0][2];
		expect(message.command).toBe("remove_map_zone");
		const payload = JSON.parse(message.value);
		expect(payload.kind).toBe("no_mop");
		// Zero, not two: the index counts within its own kind, not across the whole reading.
		expect(payload.index).toBe(0);
		expect(payload.zone).toEqual([500, 600, 600, 600, 600, 500, 500, 500]);
	});

	it("sends nothing for a zone the map does not have", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100)] });

		await engine.deleteMapZone("no_go:7");
		expect(sendTo).not.toHaveBeenCalled();
	});

	it("only drops the draft when the delete handle of the draft is pressed", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadMap(internals, {});
		engine.startMapZone("no_go");

		await engine.deleteMapZone("draft");
		expect(sendTo).not.toHaveBeenCalled();
		expect(internals.mapZoneDraft).toBeNull();
	});
});

describe("changing a zone the robot already holds", () => {
	/** Grabs the move handle of the selected zone and drags it. */
	function dragSelected(engine: MapEngine): void {
		// The gesture itself is d3's; what matters here is that the engine turns the selected zone
		// into a draft when one starts, which is what `beginMapZoneEdit` does.
		(engine as unknown as { beginMapZoneEdit(): boolean }).beginMapZoneEdit();
	}

	it("turns the selected zone into a draft instead of sending anything", async () => {
		const { engine, internals, sendTo, models } = await startEngine();
		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 1000, 1000)] });

		engine.selectMapZone("no_go:0");
		dragSelected(engine);

		expect(sendTo).not.toHaveBeenCalled();
		expect(internals.mapZoneDraft?.origin?.index).toBe(0);
		const model = models[models.length - 1];
		expect(model.drafting).toBe(true);
		expect(model.editing).toBe(true);
	});

	it("keeps the zone's own key, so a redraw cannot pull it out from under the gesture", async () => {
		const { engine, internals } = await startEngine();
		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 1000, 1000)] });

		engine.selectMapZone("no_go:0");
		dragSelected(engine);

		// Still one element, still the same one - not a draft drawn beside the original.
		const zones = document.querySelectorAll("g.map-zone");
		expect(zones).toHaveLength(1);
		expect(zones[0].classList.contains("map-zone-draft")).toBe(true);
	});

	it("sends one update command carrying both the new and the old coordinates", async () => {
		const { engine, internals, sendTo } = await startEngine();
		const original = uprightZone(0, 0, 1000, 1000);
		loadMap(internals, { FORBIDDEN_ZONES: [original] });

		engine.selectMapZone("no_go:0");
		dragSelected(engine);
		// Move it by a metre without going through a pointer gesture.
		internals.mapZoneDraft!.box.cx += 1000;
		await engine.saveMapZone();

		expect(sendTo).toHaveBeenCalledTimes(1);
		const message = sendTo.mock.calls[0][2];
		expect(message.command).toBe("update_map_zone");

		const payload = JSON.parse(message.value);
		expect(payload.kind).toBe("no_go");
		expect(payload.index).toBe(0);
		// `from` is what the adapter checks the index against before it writes anything.
		expect(payload.from).toEqual(original);
		expect(payload.zone).not.toEqual(original);
		expect(payload.zone).toHaveLength(8);
	});

	it("puts the zone back where the robot has it when the change is cancelled", async () => {
		const { engine, internals, sendTo } = await startEngine();
		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 1000, 1000)] });

		engine.selectMapZone("no_go:0");
		dragSelected(engine);
		internals.mapZoneDraft!.box.cx += 5000;
		engine.cancelMapZone();

		expect(sendTo).not.toHaveBeenCalled();
		expect(internals.mapZoneDraft).toBeNull();
		expect(document.querySelectorAll("g.map-zone-draft")).toHaveLength(0);
		expect(document.querySelectorAll("g.map-zone")).toHaveLength(1);
	});

	it("keeps the selection on the draft, so an unsaved change cannot be clicked away", async () => {
		const { engine, internals } = await startEngine();
		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 1000, 1000), uprightZone(2000, 2000, 3000, 3000)] });

		engine.selectMapZone("no_go:0");
		dragSelected(engine);
		engine.selectMapZone("no_go:1");

		expect(internals.selectedMapZoneKey).toBe("no_go:0");
		expect(internals.mapZoneDraft).not.toBeNull();
	});
});

/*
 * The tab no longer waits thirty seconds for a zone edit to confirm itself.
 *
 * That wait existed because nothing said anything when an edit failed: the socket answers ok as
 * soon as the value is written, and every later refusal went to the adapter log. The adapter now
 * writes the outcome onto the command state itself - a quality and a reason on failure, both
 * cleared on success - and the tab surfaces that through `feedback/commandFeedbackSource.ts`,
 * which watches `commands.*` and therefore every zone command here.
 *
 * So the failure case is reported immediately and says **why**, instead of after thirty seconds
 * saying only that nothing came. The success case needs no message at all: the map redraws with
 * the change. Tests for the removed machinery went with it; what replaced it is tested in
 * `src/feedback/`.
 */

describe("switching robots", () => {
	it("takes the previous robot's zones and any draft with it", async () => {
		// A draft left over would be saved onto the wrong map.
		const { engine, internals, models } = await startEngine();
		loadMap(internals, { FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100)] });
		engine.startMapZone("no_mop");

		engine.selectRobot("duid2");

		expect(internals.mapZones).toEqual([]);
		expect(internals.mapZoneDraft).toBeNull();
		expect(document.querySelectorAll("g.map-zone")).toHaveLength(0);
		expect(models[models.length - 1].counts).toEqual({ no_go: 0, no_mop: 0, wall: 0 });
	});
});
