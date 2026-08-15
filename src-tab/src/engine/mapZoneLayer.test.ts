import * as d3 from "d3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleKindsFor,
	layoutMapZoneHandles,
	MAP_ZONE_STROKE_PX,
	MAP_ZONE_WALL_STROKE_PX,
	renderMapZoneLayer,
	zoneTransform,
	type MapZoneShape,
} from "./mapZoneLayer";
import { ZONE_HANDLE_KINDS, ZONE_HANDLE_KINDS_ROTATABLE } from "./zoneHandles";

/**
 * The layer that makes the robot's own walls and zones operable.
 *
 * What is worth a test is what the field reports have already gone wrong on once, plus the two
 * decisions this layer makes that a reader would otherwise have to take on trust:
 *
 *  1. **A turned zone is drawn turned.** The tab used to draw every no-go zone as the bounding box
 *     of its four corners (`src/common/mapDrawing/drawMapV1.ts:252-259`), which is a different
 *     rectangle than the one on the floor.
 *  2. **Only the selected zone carries handles**, because a map holds up to ten of each kind and
 *     the app itself shows them on the focused rectangle alone.
 *  3. **A wall gets no rotate handle**, a zone does - straight from §B.4, not from what happened to
 *     be easy to build.
 */

function shape(overrides: Partial<MapZoneShape> = {}): MapZoneShape {
	return {
		key: "no_go:0",
		kind: "no_go",
		id: 0,
		cx: 100,
		cy: 50,
		width: 80,
		height: 40,
		angleDeg: 0,
		draft: false,
		...overrides,
	};
}

function makeGroup(): d3.Selection<SVGGElement, unknown, any, any> {
	return d3.select(document.body).append("svg").append("g") as unknown as d3.Selection<
		SVGGElement,
		unknown,
		any,
		any
	>;
}

function options(overrides: Partial<Parameters<typeof renderMapZoneLayer>[2]> = {}) {
	return {
		zoom: 1,
		selectedKey: null,
		t: (_key: string, fallback: string) => fallback,
		onSelect: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	document.body.replaceChildren();
});

describe("zoneTransform", () => {
	it("puts the zone into an upright frame running from 0,0 to width,height", () => {
		// This is what lets the handles be laid out as if nothing were turned: everything below the
		// group transform is in the zone's own frame.
		expect(zoneTransform(shape({ cx: 100, cy: 50, width: 80, height: 40, angleDeg: 0 }))).toBe(
			"translate(100, 50) rotate(0) translate(-40, -20)",
		);
	});

	it("turns about the centre, not about a corner", () => {
		const transform = zoneTransform(shape({ angleDeg: 30 }));
		// The rotation is written between the two translations, so it applies to the centred frame.
		expect(transform).toBe("translate(100, 50) rotate(30) translate(-40, -20)");
	});
});

describe("handleKindsFor", () => {
	it("gives a no-go and a no-mop zone the rotate handle", () => {
		// §B.4, A65:521762: the no-go zone is one of the three callers of `zoneRotateButton`.
		expect(handleKindsFor("no_go")).toEqual(ZONE_HANDLE_KINDS_ROTATABLE);
		expect(handleKindsFor("no_mop")).toEqual(ZONE_HANDLE_KINDS_ROTATABLE);
	});

	it("does not give one to an invisible wall", () => {
		// A65:523201/523224/523247 - three handles, no rotate.
		expect(handleKindsFor("wall")).toEqual(ZONE_HANDLE_KINDS);
	});
});

describe("renderMapZoneLayer", () => {
	it("draws a zone as a rectangle and a wall as a line", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape(), shape({ key: "wall:0", kind: "wall", id: 1, height: 0 })], options());

		const zones = document.querySelectorAll("g.map-zone");
		expect(zones).toHaveLength(2);

		const zoneRect = zones[0].querySelector("rect.map-zone-rect") as SVGRectElement;
		expect(zoneRect.style.display).toBe("");
		expect(zoneRect.getAttribute("width")).toBe("80");
		expect((zones[0].querySelector("line.map-zone-line") as SVGLineElement).style.display).toBe("none");

		const wallLine = zones[1].querySelector("line.map-zone-line") as SVGLineElement;
		expect(wallLine.style.display).toBe("");
		expect(wallLine.getAttribute("x2")).toBe("80");
		expect((zones[1].querySelector("rect.map-zone-rect") as SVGRectElement).style.display).toBe("none");
	});

	it("carries the kind as a class, so the three can be told apart by colour", () => {
		const group = makeGroup();
		renderMapZoneLayer(
			group,
			[shape(), shape({ key: "no_mop:0", kind: "no_mop", id: 1 }), shape({ key: "wall:0", kind: "wall", id: 2 })],
			options(),
		);

		expect(document.querySelectorAll("g.map-zone-no_go")).toHaveLength(1);
		expect(document.querySelectorAll("g.map-zone-no_mop")).toHaveLength(1);
		expect(document.querySelectorAll("g.map-zone-wall")).toHaveLength(1);
	});

	it("marks the zone the user is placing so it can be told from a saved one", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape({ draft: true })], options());
		expect(document.querySelectorAll("g.map-zone-draft")).toHaveLength(1);
	});

	it("draws a turned zone turned instead of as its bounding box", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape({ angleDeg: 25 })], options());

		const zone = document.querySelector("g.map-zone") as SVGGElement;
		expect(zone.getAttribute("transform")).toContain("rotate(25)");
		// The body keeps its own size; only the frame is turned. A bounding box would have made it
		// wider and shorter instead.
		expect((zone.querySelector("rect.map-zone-rect") as SVGRectElement).getAttribute("width")).toBe("80");
	});

	it("gives handles to the selected zone only", () => {
		const group = makeGroup();
		const shapes = [shape(), shape({ key: "no_go:1", id: 1 })];
		renderMapZoneLayer(group, shapes, options({ selectedKey: "no_go:1" }));

		const zones = document.querySelectorAll("g.map-zone");
		const withHandles = [...zones].filter((zone) => zone.querySelector("g.zone-handles"));
		expect(withHandles).toHaveLength(1);
		expect(withHandles[0].classList.contains("map-zone-selected")).toBe(true);
	});

	it("takes the handles away again when the selection moves on", () => {
		const group = makeGroup();
		const shapes = [shape(), shape({ key: "no_go:1", id: 1 })];
		renderMapZoneLayer(group, shapes, options({ selectedKey: "no_go:0" }));
		renderMapZoneLayer(group, shapes, options({ selectedKey: "no_go:1" }));

		expect(document.querySelectorAll("g.zone-handles")).toHaveLength(1);
		expect(document.querySelectorAll("g.map-zone")[0].querySelector("g.zone-handles")).toBeNull();
	});

	it("shows the rotate handle on a selected zone and not on a selected wall", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape()], options({ selectedKey: "no_go:0" }));
		expect((document.querySelector("g.zone-handle-rotate") as SVGGElement).style.display).toBe("");

		document.body.replaceChildren();
		const wallGroup = makeGroup();
		renderMapZoneLayer(
			wallGroup,
			[shape({ key: "wall:0", kind: "wall", height: 0 })],
			options({ selectedKey: "wall:0" }),
		);
		expect((document.querySelector("g.zone-handle-rotate") as SVGGElement).style.display).toBe("none");
	});

	it("keeps the handles on a zone however small it is", () => {
		// One zone at a time carries handles, so the cleaning layer's reason for hiding them on
		// small rectangles does not apply - and a zone drawn too small is the one a user most needs
		// to reach.
		const group = makeGroup();
		renderMapZoneLayer(group, [shape({ width: 1, height: 1 })], options({ selectedKey: "no_go:0" }));
		expect((document.querySelector("g.zone-handles") as SVGGElement).style.display).toBe("");
	});

	it("selects on click and deselects when the same zone is clicked again", () => {
		const group = makeGroup();
		const onSelect = vi.fn();
		renderMapZoneLayer(group, [shape()], options({ onSelect }));
		(document.querySelector("g.map-zone") as SVGGElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onSelect).toHaveBeenCalledWith("no_go:0");

		onSelect.mockClear();
		renderMapZoneLayer(group, [shape()], options({ onSelect, selectedKey: "no_go:0" }));
		(document.querySelector("g.map-zone") as SVGGElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onSelect).toHaveBeenCalledWith(null);
	});

	it("reports the zone its own delete handle sits on", () => {
		const group = makeGroup();
		const onDelete = vi.fn();
		renderMapZoneLayer(
			group,
			[shape(), shape({ key: "no_go:1", id: 1 })],
			options({ selectedKey: "no_go:1", onDelete }),
		);

		document
			.querySelector("g.map-zone-selected g.zone-handle-delete")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(onDelete).toHaveBeenCalledWith("no_go:1");
	});

	it("removes a zone that is no longer on the map", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape(), shape({ key: "no_go:1", id: 1 })], options());
		expect(document.querySelectorAll("g.map-zone")).toHaveLength(2);

		renderMapZoneLayer(group, [shape()], options());
		expect(document.querySelectorAll("g.map-zone")).toHaveLength(1);
	});

	it("does not stack a second body when the same zone is drawn again", () => {
		const group = makeGroup();
		for (let i = 0; i < 3; i++) renderMapZoneLayer(group, [shape()], options());
		expect(document.querySelectorAll("g.map-zone rect.map-zone-rect")).toHaveLength(1);
		expect(document.querySelectorAll("g.map-zone line.map-zone-line")).toHaveLength(1);
	});
});

describe("the drawn weight", () => {
	it("is divided by the zoom, so the edge keeps its weight on screen", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape()], options({ zoom: 4 }));
		const rect = document.querySelector("rect.map-zone-rect") as SVGRectElement;
		expect(Number(rect.style.strokeWidth)).toBeCloseTo(MAP_ZONE_STROKE_PX / 4, 10);
	});

	it("is followed up on a zoom without redrawing the layer", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape(), shape({ key: "wall:0", kind: "wall", id: 1, height: 0 })], options());

		layoutMapZoneHandles(group, 2);
		const rect = document.querySelector("rect.map-zone-rect") as SVGRectElement;
		const line = document.querySelector("line.map-zone-line") as SVGLineElement;
		expect(Number(rect.style.strokeWidth)).toBeCloseTo(MAP_ZONE_STROKE_PX / 2, 10);
		expect(Number(line.style.strokeWidth)).toBeCloseTo(MAP_ZONE_WALL_STROKE_PX / 2, 10);
	});

	it("survives a zoom of zero rather than dividing by it", () => {
		const group = makeGroup();
		renderMapZoneLayer(group, [shape()], options({ zoom: 0 }));
		const rect = document.querySelector("rect.map-zone-rect") as SVGRectElement;
		expect(Number(rect.style.strokeWidth)).toBe(MAP_ZONE_STROKE_PX);
	});
});
