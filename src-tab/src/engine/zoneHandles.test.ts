import * as d3 from "d3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import de from "@i18n/de.json";
import en from "@i18n/en.json";
import es from "@i18n/es.json";
import fr from "@i18n/fr.json";
import it_ from "@i18n/it.json";
import nl from "@i18n/nl.json";
import pl from "@i18n/pl.json";
import pt from "@i18n/pt.json";
import ru from "@i18n/ru.json";
import uk from "@i18n/uk.json";
import zhCn from "@i18n/zh-cn.json";
import {
	layoutZoneHandles,
	renderZoneHandles,
	ZONE_HANDLE_GLYPH_ROTATION,
	ZONE_HANDLE_HIT_PX,
	ZONE_HANDLE_ICON_PX,
	ZONE_HANDLE_LEASH_PX,
	ZONE_HANDLE_KINDS,
	ZONE_HANDLE_KINDS_ROTATABLE,
	ZONE_HANDLE_LABEL_KEYS,
	ZONE_HANDLE_MIN_ZONE_PX,
	ZONE_HANDLE_OUTSET_PX,
	zoneHandleLayout,
	type ZoneHandleRect,
} from "./zoneHandles";

/**
 * The handles of a cleaning zone.
 *
 * Three properties are worth a test, and they are the three the map got wrong before:
 *
 *  1. **Delete hits the zone it sits on.** The dock's button removes the zone added last, which
 *     is right for a dock button and wrong for a handle drawn on a specific rectangle.
 *  2. **The handles do not scale with the map.** The zone has to - it stands for an area on the
 *     floor - the controls must not, or they are unusable at either end of the zoom range.
 *  3. **A zone that is tiny on screen behaves.** The controls are larger than it, so what
 *     happens then is a decision, not an accident, and it should stay the decided one.
 *
 * The positions are checked against `_appanalysis/17-raumauswahl.md` §B.3 rather than against
 * whatever the code happens to produce: 16 px outwards from the corner, the move handle 30 px
 * further out per axis on its leash.
 */

/** Reads the `translate(x, y) scale(s)` a handle group carries. */
function handleTransform(zone: Element, kind: string): { x: number; y: number; scale: number } {
	const transform = zone.querySelector(`g.zone-handle-${kind}`)?.getAttribute("transform") ?? "";
	const match = /translate\(([-\d.e]+), ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(transform);
	if (!match) throw new Error(`no transform on the ${kind} handle: ${JSON.stringify(transform)}`);
	return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

function makeZones(rects: ZoneHandleRect[]): d3.Selection<SVGGElement, ZoneHandleRect, any, any> {
	const svg = d3.select(document.body).append("svg");
	return svg
		.selectAll<SVGGElement, ZoneHandleRect>("g.zone")
		.data(rects, (rect: ZoneHandleRect) => rect.id)
		.enter()
		.append("g")
		.attr("class", "zone");
}

function renderOptions(overrides: Partial<Parameters<typeof renderZoneHandles>[1]> = {}) {
	return {
		zoom: 1,
		t: (_key: string, fallback: string) => fallback,
		onDelete: vi.fn(),
		scaleDrag: d3.drag<SVGGElement, ZoneHandleRect>(),
		...overrides,
	};
}

beforeEach(() => {
	document.body.replaceChildren();
});

describe("zoneHandleLayout", () => {
	const rect = { width: 200, height: 100 };

	it("gives a cleaning zone three handles and no rotate handle", () => {
		// A rotate handle is offered by the app for no-go zones, carpets and furniture only:
		// `app_zoned_clean` takes axis-parallel rectangles (report §B.4).
		expect(zoneHandleLayout(rect, 1).handles.map((handle) => handle.kind)).toEqual(["delete", "scale", "move"]);
	});

	it("puts delete on the top left and scale on the bottom right, 16 px outside the corner", () => {
		const layout = zoneHandleLayout(rect, 1);
		const [remove, scale] = layout.handles;
		expect([remove.cx, remove.cy]).toEqual([-ZONE_HANDLE_OUTSET_PX, -ZONE_HANDLE_OUTSET_PX]);
		expect([scale.cx, scale.cy]).toEqual([rect.width + ZONE_HANDLE_OUTSET_PX, rect.height + ZONE_HANDLE_OUTSET_PX]);
	});

	it("hangs move below left, on the end of a 30 px diagonal from the frame corner", () => {
		const layout = zoneHandleLayout(rect, 1);
		const move = layout.handles[2];
		const reach = ZONE_HANDLE_OUTSET_PX + ZONE_HANDLE_LEASH_PX;
		expect([move.cx, move.cy]).toEqual([-reach, rect.height + reach]);
		// The leash runs from the frame's bottom left corner to exactly that point.
		expect(layout.leash).toEqual({
			x1: -ZONE_HANDLE_OUTSET_PX,
			y1: rect.height + ZONE_HANDLE_OUTSET_PX,
			x2: move.cx,
			y2: move.cy,
		});
	});

	it("draws the focus frame 16 px around the rectangle, which is what the corners refer to", () => {
		expect(zoneHandleLayout(rect, 1).frame).toEqual({
			x: -ZONE_HANDLE_OUTSET_PX,
			y: -ZONE_HANDLE_OUTSET_PX,
			width: rect.width + 2 * ZONE_HANDLE_OUTSET_PX,
			height: rect.height + 2 * ZONE_HANDLE_OUTSET_PX,
		});
	});

	it("keeps every distance constant on screen across the whole zoom range", () => {
		// World units × zoom = screen pixels. The offsets must come out the same at every zoom,
		// which is the property `zoneStrokeWidth()` achieves for the zone edge.
		for (const zoom of [0.1, 0.5, 1, 2.5, 10]) {
			const layout = zoneHandleLayout(rect, zoom);
			expect(layout.unit * zoom).toBeCloseTo(1, 10);
			const [remove, scale, move] = layout.handles;
			expect(remove.cx * zoom).toBeCloseTo(-ZONE_HANDLE_OUTSET_PX, 10);
			expect((scale.cx - rect.width) * zoom).toBeCloseTo(ZONE_HANDLE_OUTSET_PX, 10);
			expect(move.cx * zoom).toBeCloseTo(-(ZONE_HANDLE_OUTSET_PX + ZONE_HANDLE_LEASH_PX), 10);
		}
	});

	it("never lets a hit area reach into the rectangle, at any size and any zoom", () => {
		// The hit circle has radius 18 and its centre is 16 px diagonally outside the corner,
		// which is 22.6 px away - so a click inside the zone always belongs to the zone. This is
		// what a square hit box (the app's) would not give: its corner would overlap by 2 px.
		const clearance = Math.hypot(ZONE_HANDLE_OUTSET_PX, ZONE_HANDLE_OUTSET_PX) - ZONE_HANDLE_HIT_PX / 2;
		expect(clearance).toBeGreaterThan(0);

		for (const zoom of [0.2, 1, 6]) {
			for (const size of [20, 60, 4000]) {
				const layout = zoneHandleLayout({ width: size, height: size }, zoom);
				for (const handle of layout.handles) {
					const nearestCornerX = handle.cx < 0 ? 0 : size;
					const nearestCornerY = handle.cy < 0 ? 0 : size;
					const distanceOnScreen = Math.hypot(handle.cx - nearestCornerX, handle.cy - nearestCornerY) * zoom;
					expect(distanceOnScreen).toBeGreaterThan(ZONE_HANDLE_HIT_PX / 2);
				}
			}
		}
	});

	it("survives a zoom of zero or NaN instead of placing handles at infinity", () => {
		for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const layout = zoneHandleLayout(rect, zoom);
			expect(layout.unit).toBe(1);
			expect(layout.handles.every((handle) => Number.isFinite(handle.cx) && Number.isFinite(handle.cy))).toBe(true);
		}
	});
});

describe("the rotate handle", () => {
	const rect = { width: 200, height: 100 };

	it("is offered to a no-go zone and lands on the top right corner", () => {
		// §B.4: the no-go zone calls all four (A65:521728/521734/521762/521774), and §B.3 puts
		// rotate on the top right - the one corner the three-handle set leaves free.
		const layout = zoneHandleLayout(rect, 1, false, ZONE_HANDLE_KINDS_ROTATABLE);
		expect(layout.handles.map((handle) => handle.kind)).toEqual(["delete", "rotate", "scale", "move"]);

		const rotate = layout.handles[1];
		expect([rotate.cx, rotate.cy]).toEqual([rect.width + ZONE_HANDLE_OUTSET_PX, -ZONE_HANDLE_OUTSET_PX]);
	});

	it("is not offered to an invisible wall, because the app does not offer it either", () => {
		// A65:523201/523224/523247 - delete, scale and move, no rotate. A wall is two end points;
		// it already says which way it runs.
		expect(zoneHandleLayout(rect, 1, false, ZONE_HANDLE_KINDS).handles.map((handle) => handle.kind)).toEqual([
			"delete",
			"scale",
			"move",
		]);
	});

	it("comes out in the app's order round the frame whatever order it was asked for", () => {
		const layout = zoneHandleLayout(rect, 1, false, ["move", "rotate", "delete"]);
		expect(layout.handles.map((handle) => handle.kind)).toEqual(["delete", "rotate", "move"]);
	});

	it("keeps its distance on screen at every zoom, like the other three", () => {
		for (const zoom of [0.1, 1, 10]) {
			const rotate = zoneHandleLayout(rect, zoom, false, ZONE_HANDLE_KINDS_ROTATABLE).handles[1];
			expect((rotate.cx - rect.width) * zoom).toBeCloseTo(ZONE_HANDLE_OUTSET_PX, 10);
			expect(rotate.cy * zoom).toBeCloseTo(-ZONE_HANDLE_OUTSET_PX, 10);
		}
	});

	it("is hidden on a rectangle that does not offer it, not left where another one put it", () => {
		// The handles are built once per zone and only laid out afterwards, so all four exist in
		// the DOM. One that stayed visible without being placed would sit at the coordinates of
		// whichever rectangle it last belonged to - a live control on the wrong zone.
		const zones = makeZones([{ id: 1, width: 200, height: 200 }]);
		renderZoneHandles(zones, renderOptions({ kinds: ZONE_HANDLE_KINDS_ROTATABLE }));
		const rotate = document.querySelector("g.zone-handle-rotate") as SVGGElement;
		expect(rotate.style.display).toBe("");

		layoutZoneHandles(zones, { zoom: 1, kinds: ZONE_HANDLE_KINDS });
		expect(rotate.style.display).toBe("none");
	});

	it("follows the datum when the handle set differs from zone to zone", () => {
		const zones = makeZones([
			{ id: 1, width: 200, height: 200 },
			{ id: 2, width: 200, height: 200 },
		]);
		renderZoneHandles(
			zones,
			renderOptions({
				kinds: (rect: ZoneHandleRect) => (rect.id === 1 ? ZONE_HANDLE_KINDS_ROTATABLE : ZONE_HANDLE_KINDS),
			}),
		);

		const groups = document.querySelectorAll("g.zone");
		expect((groups[0].querySelector("g.zone-handle-rotate") as SVGGElement).style.display).toBe("");
		expect((groups[1].querySelector("g.zone-handle-rotate") as SVGGElement).style.display).toBe("none");
	});

	it("swallows the press when it has no gesture, instead of dragging the zone away", () => {
		// A handle drawn but left inert must still not fall through to `g.zone`: a press that
		// promised a turn and moved the zone instead is worse than one that does nothing.
		const zones = makeZones([{ id: 1, width: 200, height: 200 }]);
		renderZoneHandles(zones, renderOptions({ kinds: ZONE_HANDLE_KINDS_ROTATABLE }));

		const reachedTheZone = vi.fn();
		(document.querySelector("g.zone") as SVGGElement).addEventListener("pointerdown", reachedTheZone);
		document
			.querySelector("g.zone-handle-rotate circle.zone-handle-hit")
			?.dispatchEvent(new Event("pointerdown", { bubbles: true }));

		expect(reachedTheZone).not.toHaveBeenCalled();
	});
});

describe("a zone too small to carry its handles", () => {
	it("keeps them while it is at least as large on screen as one glyph", () => {
		const size = ZONE_HANDLE_MIN_ZONE_PX;
		expect(zoneHandleLayout({ width: size, height: size }, 1).visible).toBe(true);
	});

	it("drops them below that, rather than surrounding a 10 px zone with 36 px controls", () => {
		const rect = { width: ZONE_HANDLE_MIN_ZONE_PX * 4, height: ZONE_HANDLE_MIN_ZONE_PX * 4 };
		// The same rectangle, only zoomed out far enough to make it smaller than a glyph.
		expect(zoneHandleLayout(rect, 1).visible).toBe(true);
		expect(zoneHandleLayout(rect, 0.2).visible).toBe(false);
	});

	it("judges by the shorter edge, so a thin strip loses them too", () => {
		expect(zoneHandleLayout({ width: 400, height: ZONE_HANDLE_MIN_ZONE_PX - 1 }, 1).visible).toBe(false);
	});

	it("keeps them on the zone under an active gesture, so resizing cannot lose its own handle", () => {
		const tiny = { width: 4, height: 4 };
		expect(zoneHandleLayout(tiny, 1).visible).toBe(false);
		expect(zoneHandleLayout(tiny, 1, true).visible).toBe(true);
	});

	it("hides the handle group in the DOM instead of leaving invisible hit areas behind", () => {
		const zones = makeZones([{ id: 1, width: 4, height: 4 }]);
		renderZoneHandles(zones, renderOptions());
		const group = document.querySelector("g.zone-handles") as SVGGElement;
		expect(group.style.display).toBe("none");

		// Zooming in brings them back; nothing has to be rebuilt for that.
		layoutZoneHandles(zones, { zoom: 20 });
		expect(group.style.display).toBe("");
	});

	it("still lets the dock and the zone itself work while the handles are away", () => {
		// The zone group keeps its rectangle, which is what the drag handler of `g.zone` listens
		// on - a zone without handles is still a zone that can be dragged.
		const zones = makeZones([{ id: 1, width: 4, height: 4 }]);
		zones.append("rect").attr("class", "zone-rect");
		renderZoneHandles(zones, renderOptions());
		expect(document.querySelectorAll("g.zone rect.zone-rect")).toHaveLength(1);
	});
});

describe("renderZoneHandles", () => {
	it("builds a hit area, a disc and a glyph for each of the three handles", () => {
		const zones = makeZones([{ id: 7, width: 200, height: 200 }]);
		renderZoneHandles(zones, renderOptions());

		for (const kind of ["delete", "scale", "move"]) {
			const handle = document.querySelector(`g.zone-handle-${kind}`) as SVGGElement;
			expect(handle).not.toBeNull();
			expect(handle.querySelector("circle.zone-handle-hit")?.getAttribute("r")).toBe(String(ZONE_HANDLE_HIT_PX / 2));
			expect(handle.querySelector("path.zone-handle-glyph")?.getAttribute("d")).toBeTruthy();
			// The glyph is drawn in Material's 24 × 24 box and shifted onto the group's centre,
			// plus the per-glyph rotation - the scale arrows have to run along the corner they sit
			// on, not across it.
			const rotation = ZONE_HANDLE_GLYPH_ROTATION[kind as keyof typeof ZONE_HANDLE_GLYPH_ROTATION];
			expect(handle.querySelector("path.zone-handle-glyph")?.getAttribute("transform")).toBe(
				`translate(${-ZONE_HANDLE_ICON_PX / 2}, ${-ZONE_HANDLE_ICON_PX / 2})` +
					(rotation ? ` rotate(${rotation} 12 12)` : ""),
			);
		}
	});

	it("labels every handle for the tooltip and for a screen reader", () => {
		const zones = makeZones([{ id: 7, width: 200, height: 200 }]);
		const translate = vi.fn((key: string, fallback: string) => `${fallback} [${key}]`);
		renderZoneHandles(zones, renderOptions({ t: translate }));

		const remove = document.querySelector("g.zone-handle-delete") as SVGGElement;
		expect(remove.querySelector("title")?.textContent).toBe("Delete this zone [ui_zone_handle_delete]");
		expect(remove.getAttribute("aria-label")).toBe("Delete this zone [ui_zone_handle_delete]");
		// All four are built and therefore all four are labelled; which of them a given rectangle
		// shows is decided when it is laid out, not when it is built.
		expect(translate.mock.calls.map((call) => call[0])).toEqual([
			"ui_zone_handle_delete",
			"ui_zone_handle_rotate",
			"ui_zone_handle_resize",
			"ui_zone_handle_move",
		]);
	});

	it("is idempotent, so a redraw does not stack a second set of handles", () => {
		const zones = makeZones([{ id: 1, width: 200, height: 200 }]);
		const options = renderOptions();
		renderZoneHandles(zones, options);
		renderZoneHandles(zones, options);
		renderZoneHandles(zones, options);

		expect(document.querySelectorAll("g.zone-handles")).toHaveLength(1);
		expect(document.querySelectorAll("g.zone-handle")).toHaveLength(ZONE_HANDLE_KINDS_ROTATABLE.length);

		// And the delete listener was attached once, not three times.
		(document.querySelector("g.zone-handle-delete") as SVGGElement).dispatchEvent(
			new MouseEvent("click", { bubbles: true }),
		);
		expect(options.onDelete).toHaveBeenCalledTimes(1);
	});
});

describe("the delete handle", () => {
	const rects: ZoneHandleRect[] = [
		{ id: 11, width: 200, height: 200 },
		{ id: 22, width: 200, height: 200 },
		{ id: 33, width: 200, height: 200 },
	];

	it("removes the zone it belongs to, not the one added last", () => {
		// This is the whole point of the handle: the dock button pops the last zone, and with
		// three zones on the map that is the wrong one two times out of three.
		const zones = makeZones(rects);
		const options = renderOptions();
		renderZoneHandles(zones, options);

		const middle = document.querySelectorAll("g.zone")[1];
		middle.querySelector("circle.zone-handle-hit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(options.onDelete).toHaveBeenCalledTimes(1);
		expect(options.onDelete).toHaveBeenCalledWith(22);
	});

	it("reports the right zone even after the others were removed around it", () => {
		const zones = makeZones(rects);
		const options = renderOptions();
		renderZoneHandles(zones, options);

		// What the engine does on a delete: drop the rectangle and redraw. The exit selection
		// takes its group with it; the survivors keep theirs.
		const remaining = rects.filter((rect) => rect.id !== 11);
		const join = d3
			.select("svg")
			.selectAll<SVGGElement, ZoneHandleRect>("g.zone")
			.data(remaining, (rect: ZoneHandleRect) => rect.id);
		join.exit().remove();
		renderZoneHandles(join as d3.Selection<SVGGElement, ZoneHandleRect, any, any>, options);

		const last = document.querySelectorAll("g.zone")[1];
		last.querySelector("g.zone-handle-delete")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(options.onDelete).toHaveBeenCalledWith(33);
	});

	it("stops the pointer press, so pressing it never drags the zone away underneath", () => {
		const zones = makeZones([{ id: 1, width: 200, height: 200 }]);
		renderZoneHandles(zones, renderOptions());

		const onZonePress = vi.fn();
		(document.querySelector("g.zone") as SVGGElement).addEventListener("pointerdown", onZonePress);

		document
			.querySelector("g.zone-handle-delete")
			?.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		expect(onZonePress).not.toHaveBeenCalled();

		// The move handle does the opposite on purpose: its press reaches `g.zone`, whose drag
		// handler moves the zone (report §B.2 - the app passes it the zone's own pan responder).
		document
			.querySelector("g.zone-handle-move")
			?.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		expect(onZonePress).toHaveBeenCalledTimes(1);
	});
});

describe("the tooltips", () => {
	// The adapter ships eleven languages and the checklist treats a missing one as a blocker.
	// `test/unit/i18n_key_parity.test.ts` proves the files carry the same keys; this proves the
	// keys the handles ask for are among them, and that none of them is an empty string.
	const DICTIONARIES: Record<string, Record<string, string>> = {
		en,
		de,
		ru,
		pt,
		nl,
		fr,
		it: it_,
		es,
		pl,
		uk,
		"zh-cn": zhCn,
	};

	it("covers all eleven admin languages", () => {
		expect(Object.keys(DICTIONARIES)).toHaveLength(11);
	});

	it.each(Object.entries(DICTIONARIES))("is translated in %s", (_language, dictionary) => {
		for (const kind of ZONE_HANDLE_KINDS) {
			const text = dictionary[ZONE_HANDLE_LABEL_KEYS[kind]];
			expect(text, ZONE_HANDLE_LABEL_KEYS[kind]).toBeTypeOf("string");
			expect(text.trim().length).toBeGreaterThan(0);
		}
	});

	it("says something else than the dock's remove button, which removes a different zone", () => {
		// Two controls, two meanings: the dock pops the zone added last, the handle deletes the
		// one it sits on. Identical wording would make that difference invisible.
		expect(DICTIONARIES.en[ZONE_HANDLE_LABEL_KEYS.delete]).not.toBe(en.ui_remove_zone);
		expect(DICTIONARIES.de[ZONE_HANDLE_LABEL_KEYS.delete]).not.toBe(de.ui_remove_zone);
	});
});

describe("layoutZoneHandles", () => {
	it("holds the handles at the same screen size while the map zooms", () => {
		const zones = makeZones([{ id: 1, width: 300, height: 300 }]);
		renderZoneHandles(zones, renderOptions({ zoom: 1 }));
		const zone = document.querySelector("g.zone") as SVGGElement;

		for (const zoom of [0.25, 1, 4]) {
			layoutZoneHandles(zones, { zoom });
			const remove = handleTransform(zone, "delete");
			// The group undoes the zoom, so its contents - hit circle and 24 px glyph - come out
			// the same size on screen whatever the map does.
			expect(remove.scale).toBeCloseTo(1 / zoom, 10);
			expect(remove.x * zoom).toBeCloseTo(-ZONE_HANDLE_OUTSET_PX, 10);
			// The hit radius stays the number it was built with; only the group transform moves.
			expect(zone.querySelector("circle.zone-handle-hit")?.getAttribute("r")).toBe(String(ZONE_HANDLE_HIT_PX / 2));
		}
	});

	it("thins the frame and the leash with the zoom, so both stay 2 px on screen", () => {
		const zones = makeZones([{ id: 1, width: 300, height: 300 }]);
		renderZoneHandles(zones, renderOptions({ zoom: 1 }));
		const frame = document.querySelector("rect.zone-focus-frame") as SVGRectElement;
		const leash = document.querySelector("line.zone-leash") as SVGLineElement;

		layoutZoneHandles(zones, { zoom: 4 });
		expect(Number(frame.style.strokeWidth) * 4).toBeCloseTo(2, 10);
		expect(Number(leash.style.strokeWidth) * 4).toBeCloseTo(2, 10);
		// The dashes are in world units as well, or the pattern would change with the zoom.
		expect(frame.style.strokeDasharray.split(" ").map((dash) => Number(dash) * 4)).toEqual([6, 4]);
	});

	it("follows the rectangle while it is being resized", () => {
		const rect: ZoneHandleRect = { id: 1, width: 300, height: 300 };
		const zones = makeZones([rect]);
		renderZoneHandles(zones, renderOptions());
		const zone = document.querySelector("g.zone") as SVGGElement;

		// The resize gesture mutates the bound rectangle in place and asks for a new layout.
		rect.width = 500;
		rect.height = 120;
		layoutZoneHandles(zones, { zoom: 1 });

		expect(handleTransform(zone, "scale")).toMatchObject({ x: 500 + ZONE_HANDLE_OUTSET_PX, y: 120 + ZONE_HANDLE_OUTSET_PX });
		expect(handleTransform(zone, "move").y).toBe(120 + ZONE_HANDLE_OUTSET_PX + ZONE_HANDLE_LEASH_PX);
		expect((document.querySelector("rect.zone-focus-frame") as SVGRectElement).getAttribute("width")).toBe(
			String(500 + 2 * ZONE_HANDLE_OUTSET_PX),
		);
	});

	it("leaves a zone group that carries no handles alone", () => {
		// `layoutZoneHandles` runs on every zoom tick, over whatever the zone layer holds.
		const zones = makeZones([{ id: 1, width: 300, height: 300 }]);
		expect(() => layoutZoneHandles(zones, { zoom: 2 })).not.toThrow();
		expect(document.querySelectorAll("g.zone-handles")).toHaveLength(0);
	});
});
