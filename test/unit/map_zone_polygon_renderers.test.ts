import { describe, expect, it, vi } from "vitest";

import { CanvasMapRenderer } from "../../src/lib/map/v1/CanvasMapRenderer";
import type { NodeCanvasContext2D } from "../../src/lib/map/v1/CanvasMapRenderer";
import type { DrawZoneRectInput } from "../../src/common/mapDrawing/types";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * That the **rendered PNG** draws a turned zone as the shape it is.
 *
 * `map_editable_zone_drawing.test.ts` proves that `drawMapV1` hands the corners over. This one
 * proves the other half: that the renderer behind the adapter's own picture uses them. Without it,
 * the corners would travel all the way to a renderer that quietly keeps drawing the bounding box -
 * and the fault would live on in exactly the picture most users look at, the one in VIS and in the
 * object tree.
 *
 * The context is a recorder rather than a real canvas: what has to be pinned is *which* drawing
 * calls are made, and comparing pixels would test `@napi-rs/canvas` instead.
 */

interface Recorded {
	path: { x: number; y: number }[];
	rects: { x: number; y: number; w: number; h: number }[];
	filled: number;
	stroked: number;
	closed: number;
}

/** A 2D context that writes down what it was asked to draw. */
function recordingContext(): { ctx: NodeCanvasContext2D; recorded: Recorded } {
	const recorded: Recorded = { path: [], rects: [], filled: 0, stroked: 0, closed: 0 };
	const ctx = {
		canvas: { width: 100, height: 100 },
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		globalAlpha: 1,
		imageSmoothingEnabled: false,
		font: "",
		textAlign: "",
		textBaseline: "",
		drawImage: () => undefined,
		getImageData: () => ({}) as ImageData,
		putImageData: () => undefined,
		save: () => undefined,
		restore: () => undefined,
		beginPath: () => undefined,
		moveTo: (x: number, y: number) => recorded.path.push({ x, y }),
		lineTo: (x: number, y: number) => recorded.path.push({ x, y }),
		closePath: () => (recorded.closed += 1),
		stroke: () => (recorded.stroked += 1),
		fill: () => (recorded.filled += 1),
		fillRect: (x: number, y: number, w: number, h: number) => recorded.rects.push({ x, y, w, h }),
		strokeRect: (x: number, y: number, w: number, h: number) => recorded.rects.push({ x, y, w, h }),
		arc: () => undefined,
		setLineDash: () => undefined,
		translate: () => undefined,
		rotate: () => undefined,
		strokeText: () => undefined,
		fillText: () => undefined
	} as unknown as NodeCanvasContext2D;

	return { ctx, recorded };
}

function makeRenderer(ctx: NodeCanvasContext2D): CanvasMapRenderer {
	const image = {} as never;
	return new CanvasMapRenderer({ ctx, robotImage: image, chargerImage: image, goToPinImage: image });
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
		{ x: 10, y: 70 }
	]
};

/** The same zone as the older half of the interface alone can describe it. */
const BOX: DrawZoneRectInput = { x: 10, y: 10, w: 90, h: 90, fill: "#ff000066", stroke: "#ff0000" };

describe("the PNG renderer and a turned zone", () => {
	it("draws the polygon of its corners and no rectangle at all", () => {
		const { ctx, recorded } = recordingContext();
		makeRenderer(ctx).drawRestrictedZones([TURNED], []);

		expect(recorded.path).toEqual(TURNED.points);
		expect(recorded.closed).toBe(1);
		expect(recorded.filled).toBe(1);
		expect(recorded.stroked).toBe(1);
		// The bounding box must not be painted underneath: it covers floor the robot may drive on.
		expect(recorded.rects).toEqual([]);
	});

	it("falls back to the rectangle for an input that carries no corners", () => {
		// Every other caller of this method - the Q10 overlay path passes zones without corners -
		// has to keep working exactly as before.
		const { ctx, recorded } = recordingContext();
		makeRenderer(ctx).drawRestrictedZones([BOX], []);

		expect(recorded.rects).toEqual([
			{ x: 10, y: 10, w: 90, h: 90 },
			{ x: 10, y: 10, w: 90, h: 90 }
		]);
		expect(recorded.path).toEqual([]);
	});

	it("ignores a degenerate corner list rather than drawing a sliver", () => {
		const { ctx, recorded } = recordingContext();
		makeRenderer(ctx).drawRestrictedZones([{ ...TURNED, points: [{ x: 1, y: 2 }] }], []);

		expect(recorded.path).toEqual([]);
		expect(recorded.rects).toHaveLength(2);
	});

	it("still draws the virtual walls beside it", () => {
		const { ctx, recorded } = recordingContext();
		makeRenderer(ctx).drawRestrictedZones([TURNED], [{ x1: 0, y1: 0, x2: 50, y2: 0, stroke: "#f00", lineWidth: 3 }]);

		// Four corners of the zone plus the two end points of the wall.
		expect(recorded.path).toHaveLength(6);
		expect(recorded.stroked).toBe(2);
	});
});
