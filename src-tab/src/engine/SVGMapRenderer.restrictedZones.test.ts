import * as d3 from "d3";
import { afterEach, describe, expect, it } from "vitest";
import { SVGMapRenderer } from "./SVGMapRenderer";
import type { SVGMapRendererGroups } from "./SVGMapRenderer";
import type { DrawZoneRectInput } from "@adapter/common/mapDrawing/types";

/**
 * That the tab's renderer draws a stored zone as the shape it is.
 *
 * The counterpart of `test/unit/map_zone_polygon_renderers.test.ts`, which pins the same for the
 * adapter's own PNG. Both halves are needed: `drawMapV1` hands the four corners over, and a
 * renderer that ignored them would keep painting the bounding box - a larger rectangle covering
 * floor the robot is perfectly happy to drive on.
 *
 * The tab reaches this path for the overlays it does **not** operate itself (`CURTAIN`,
 * `MISS_ZONE`); the three it does are drawn by `mapZoneLayer.ts` instead. Both are shapes a map
 * can store turned, so both are drawn from their corners.
 */

function svgGroup(): d3.Selection<SVGGElement, unknown, HTMLElement, unknown> {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	document.body.appendChild(svg);
	const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
	svg.appendChild(g);
	return d3.select(g) as unknown as d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
}

function makeRenderer(zonesOverlayGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>): SVGMapRenderer {
	const groups: SVGMapRendererGroups = {
		carpetGroup: svgGroup(),
		pathGroup: svgGroup(),
		mopPathGroup: svgGroup(),
		backwashPathGroup: svgGroup(),
		pureCleanPathGroup: svgGroup(),
		chargerGroup: svgGroup(),
		robotGroup: svgGroup(),
		pinGroup: svgGroup(),
		obstacleGroup: svgGroup(),
		roomNameGroup: svgGroup(),
		furnitureGroup: svgGroup(),
		zonesOverlayGroup,
	};
	return new SVGMapRenderer({
		groups,
		pathMainWidth: 1,
		pathMopWidth: 1,
		pathBackwashWidth: 1,
		robotSize: 5,
		chargerSize: 3,
		pinWidth: 29,
		pinHeight: 24,
		pinYOffset: 5,
		obstacleRadius: 3,
		obstacleImageSize: 5,
		obstacleAssetBaseUrl: "assets/roborock.vacuum.a65/drawable-mdpi/",
		obstacleMapping: {},
		obstacleFileName: (suffix: string) => `${suffix}.png`,
		obstacleFileNameAlt: (suffix: string) => `${suffix}_alt.png`,
		robotImageHref: "robot.png",
		chargerImageHref: "charger.png",
		goToPinImageHref: "pin.png",
	});
}

/** A turned zone: four corners, no two sharing an x or a y. */
const TURNED: DrawZoneRectInput = {
	x: 10,
	y: 10,
	w: 90,
	h: 90,
	fill: "#ff000066",
	stroke: "#ff0000",
	points: [
		{ x: 20, y: 10 },
		{ x: 100, y: 40 },
		{ x: 90, y: 100 },
		{ x: 10, y: 70 },
	],
};

/** The same zone as the older half of the interface alone can describe it. */
const BOX: DrawZoneRectInput = { x: 10, y: 10, w: 90, h: 90, fill: "#ff000066", stroke: "#ff0000" };

afterEach(() => {
	document.body.replaceChildren();
});

describe("drawRestrictedZones and a turned zone", () => {
	it("draws a polygon of its corners instead of a rectangle", () => {
		const overlay = svgGroup();
		makeRenderer(overlay).drawRestrictedZones([TURNED], []);

		const polygon = document.querySelector("polygon.restricted-zone") as SVGPolygonElement;
		expect(polygon).not.toBeNull();
		expect(polygon.getAttribute("points")).toBe("20,10 100,40 90,100 10,70");
		// The bounding box must not be drawn underneath.
		expect(document.querySelector("rect.restricted-zone")).toBeNull();
	});

	it("keeps the rectangle for an input without corners", () => {
		// The Q10 overlay path calls this method with zones that carry none; it has to be unchanged.
		const overlay = svgGroup();
		makeRenderer(overlay).drawRestrictedZones([BOX], []);

		const rect = document.querySelector("rect.restricted-zone") as SVGRectElement;
		expect(rect).not.toBeNull();
		expect(rect.getAttribute("width")).toBe("90");
		expect(document.querySelector("polygon.restricted-zone")).toBeNull();
	});

	it("clears the previous shapes on a redraw, whichever kind they were", () => {
		// The layer is rebuilt from scratch on every pass; a polygon left over from the previous
		// map would sit on the new one as a zone that is no longer there.
		const overlay = svgGroup();
		const renderer = makeRenderer(overlay);

		renderer.drawRestrictedZones([TURNED], []);
		renderer.drawRestrictedZones([BOX], []);
		expect(document.querySelectorAll(".restricted-zone")).toHaveLength(1);
		expect(document.querySelector("polygon.restricted-zone")).toBeNull();

		renderer.drawRestrictedZones([TURNED], []);
		expect(document.querySelectorAll(".restricted-zone")).toHaveLength(1);
		expect(document.querySelector("rect.restricted-zone")).toBeNull();
	});

	it("ignores a degenerate corner list rather than drawing a sliver", () => {
		const overlay = svgGroup();
		makeRenderer(overlay).drawRestrictedZones([{ ...TURNED, points: [{ x: 1, y: 2 }] }], []);

		expect(document.querySelector("polygon.restricted-zone")).toBeNull();
		expect(document.querySelector("rect.restricted-zone")).not.toBeNull();
	});
});
