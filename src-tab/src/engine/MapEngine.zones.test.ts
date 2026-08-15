import * as d3 from "d3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapEngine } from "./MapEngine";
import type { EngineConnection, MapEngineHost } from "./types";
import { ZONE_HANDLE_OUTSET_PX } from "./zoneHandles";

/**
 * The zone handles as the engine wires them up.
 *
 * `zoneHandles.test.ts` proves the geometry and the DOM behaviour of the handles on their own.
 * What it cannot prove is the wiring: that the delete handle reaches `removeZoneById` with the
 * right id, that the dock's button still means "the last one", and that a zoom repositions the
 * handles the engine drew. Those three go through `MapEngine`, so they are tested through it.
 *
 * The engine is driven directly here instead of through a map: `drawZones` needs a rectangle
 * list and nothing else, and building a full map fixture would test the map pipeline rather than
 * the handles.
 */

interface EngineInternals {
	rects: { id: number; x: number; y: number; width: number; height: number }[];
	rectCounter: number;
	wheelZoom: number;
	drawZones(): void;
	handleZoom(event: { transform: d3.ZoomTransform }): void;
}

let live: MapEngine | null = null;

async function startEngine(): Promise<{ engine: MapEngine; host: MapEngineHost; internals: EngineInternals }> {
	const connection: EngineConnection = {
		sendTo: vi.fn().mockResolvedValue({}),
		getObject: vi.fn().mockResolvedValue(null),
		getStates: vi.fn().mockResolvedValue({}),
		subscribeState: vi.fn().mockResolvedValue(undefined),
		unsubscribeState: vi.fn(),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const container = document.createElement("div");
	document.body.appendChild(container);

	const host: MapEngineHost = {
		container,
		t: (_key: string, fallback: string) => fallback,
		onZones: vi.fn(),
	};

	const engine = new MapEngine(connection, host);
	live = engine;
	await engine.init("roborock.0");
	return { engine, host, internals: engine as unknown as EngineInternals };
}

/** Three zones on the map, the largest number the engine allows minus two. */
function drawThreeZones(internals: EngineInternals): void {
	internals.rects = [
		{ id: 1, x: 0, y: 0, width: 300, height: 300 },
		{ id: 2, x: 400, y: 0, width: 300, height: 300 },
		{ id: 3, x: 800, y: 0, width: 300, height: 300 },
	];
	internals.rectCounter = 4;
	internals.drawZones();
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.replaceChildren();
});

describe("the delete handle of a zone", () => {
	it("removes that zone, while the dock's button removes the last one", async () => {
		const { engine, internals } = await startEngine();
		drawThreeZones(internals);

		const zones = document.querySelectorAll("g.zone");
		expect(zones).toHaveLength(3);

		// The middle zone: neither the first nor the last, so neither an off-by-one nor "pop"
		// could produce this result by accident.
		zones[1].querySelector("g.zone-handle-delete")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(internals.rects.map((rect) => rect.id)).toEqual([1, 3]);
		expect(document.querySelectorAll("g.zone")).toHaveLength(2);

		// Unchanged, and deliberately so: a button next to the map has no zone to point at.
		engine.removeZone();
		expect(internals.rects.map((rect) => rect.id)).toEqual([1]);
	});

	it("republishes the zone count, so the dock and the start button follow along", async () => {
		const { host, internals } = await startEngine();
		drawThreeZones(internals);
		(host.onZones as ReturnType<typeof vi.fn>).mockClear();

		document.querySelector("g.zone g.zone-handle-delete")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(host.onZones).toHaveBeenCalledWith({ count: 2, max: 5, atLimit: false });
	});

	it("ignores an id that is no longer on the map", async () => {
		const { engine, internals } = await startEngine();
		drawThreeZones(internals);

		engine.removeZoneById(99);
		expect(internals.rects.map((rect) => rect.id)).toEqual([1, 2, 3]);
	});
});

describe("the handles under a zoom", () => {
	it("keeps them the same size on screen while the zone scales with the map", async () => {
		const { internals } = await startEngine();
		drawThreeZones(internals);

		const zone = document.querySelector("g.zone") as SVGGElement;
		const body = zone.querySelector("rect.zone-rect") as SVGRectElement;
		const readScale = (): number => {
			const transform = zone.querySelector("g.zone-handle-delete")?.getAttribute("transform") ?? "";
			return Number(/scale\(([-\d.e]+)\)/.exec(transform)?.[1]);
		};

		for (const zoom of [0.5, 3]) {
			internals.handleZoom({ transform: d3.zoomIdentity.scale(zoom) });

			// The rectangle keeps its world size - it stands for an area on the floor, and the
			// map transform above it does the scaling.
			expect(body.getAttribute("width")).toBe("300");
			// The handle undoes exactly that transform, so it comes out the same size on screen.
			expect(readScale()).toBeCloseTo(1 / zoom, 10);
			const offset = Number(
				/translate\(([-\d.e]+),/.exec(zone.querySelector("g.zone-handle-delete")?.getAttribute("transform") ?? "")?.[1],
			);
			expect(offset * zoom).toBeCloseTo(-ZONE_HANDLE_OUTSET_PX, 10);
		}
	});

	it("hides the handles once a zone is smaller on screen than one of its own glyphs", async () => {
		const { internals } = await startEngine();
		drawThreeZones(internals);
		const handles = document.querySelector("g.zone g.zone-handles") as SVGGElement;

		internals.handleZoom({ transform: d3.zoomIdentity.scale(1) });
		expect(handles.style.display).toBe("");

		// 300 world units at 1/25 of the zoom is a 12 px zone: the controls would be larger than
		// the thing they operate, and with several zones no longer attributable to one of them.
		internals.handleZoom({ transform: d3.zoomIdentity.scale(0.04) });
		expect(handles.style.display).toBe("none");
		// The zone itself stays - it can still be dragged, and the dock can still remove it.
		expect(document.querySelectorAll("g.zone rect.zone-rect")).toHaveLength(3);

		internals.handleZoom({ transform: d3.zoomIdentity.scale(1) });
		expect(handles.style.display).toBe("");
	});
});

/**
 * Where the zone layer sits among the others.
 *
 * SVG paints in document order, so the group order in `MapEngine.setupSvg` decides what covers
 * what. This was wrong in the field: a no-go zone read off the map was painted over the rectangle
 * the user had drawn on top of it.
 *
 * The order is asserted here rather than left to the reading of one `append` chain, because the
 * consequence is not cosmetic - the handles sit outside the rectangle, and any group drawn later
 * takes their clicks.
 */
describe("layer order", () => {
	/** Class names of the engine's own groups, in the order they are painted. */
	function layerOrder(): string[] {
		const main = document.querySelector("svg g") as SVGGElement | null;
		if (!main) return [];
		return Array.from(main.children)
			.filter(child => child.tagName === "g")
			.map(child => child.getAttribute("class") ?? "");
	}

	it("puts the drawn zones last, above the no-go zones read off the map", async () => {
		await startEngine();
		const order = layerOrder();

		expect(order).toContain("zones");
		expect(order).toContain("zones-overlay");
		expect(order.indexOf("zones")).toBeGreaterThan(order.indexOf("zones-overlay"));
	});

	it("leaves nothing on top of the zones that could take a handle's click", async () => {
		await startEngine();
		const order = layerOrder();

		// Not "above these three" but "above everything": a layer added later would silently end up
		// over the handles again, and this is the assertion that notices.
		expect(order[order.length - 1]).toBe("zones");
		for (const covered of ["robot", "live-robot-marker", "pins", "room-names", "obstacles", "charger"]) {
			expect(order.indexOf(covered)).toBeLessThan(order.indexOf("zones"));
		}
	});
});
