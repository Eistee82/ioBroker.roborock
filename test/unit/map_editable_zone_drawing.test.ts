import { describe, expect, it, vi } from "vitest";

import { drawMapV1 } from "../../src/common/mapDrawing/drawMapV1";
import type { V1MapDataForDrawing } from "../../src/common/mapDrawing/drawMapV1";
import type {
	DrawVirtualWallInput,
	DrawZoneRectInput,
	IMapRenderer
} from "../../src/common/mapDrawing/types";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * Who draws the three editable overlays.
 *
 * The admin tab draws no-go zones, no-mop zones and invisible walls in a layer of its own, where
 * they are controls rather than decoration: they can be selected, turned and deleted. It therefore
 * asks `drawMapV1` to leave them out, and this pins that the switch does exactly that and no more.
 *
 * Both halves matter:
 *
 *  - **Left out when asked.** Otherwise every zone would be drawn twice, and the second copy would
 *    be wrong: the rectangles below are reduced to the bounding box of their four corners, which is
 *    a different shape as soon as a zone is turned.
 *  - **Drawn when not asked.** The adapter's own PNG has no such layer. Omitting them there would
 *    silently drop the user's boundaries from every rendered map - including the ones in VIS.
 */

/** Records the two calls that carry the overlays. */
function createRecordingRenderer(): {
	renderer: IMapRenderer;
	zones: DrawZoneRectInput[];
	walls: DrawVirtualWallInput[];
} {
	const zones: DrawZoneRectInput[] = [];
	const walls: DrawVirtualWallInput[] = [];
	const renderer: IMapRenderer = {
		drawFloor: () => undefined,
		drawSegmentRects: () => undefined,
		drawCarpet: () => undefined,
		drawPath: () => undefined,
		drawRobot: () => undefined,
		drawCharger: () => undefined,
		drawGoToPin: () => undefined,
		drawObstacles: () => undefined,
		drawRoomLabels: () => undefined,
		drawActiveZones: () => undefined,
		drawRestrictedZones: (restricted, virtualWalls) => {
			zones.push(...restricted);
			walls.push(...virtualWalls);
		},
		drawPredictedPath: () => undefined
	};
	return { renderer, zones, walls };
}

/** `[x0,y0, x1,y1, x2,y2, x3,y3]` of an upright zone, as the map stores it. */
function uprightZone(left: number, bottom: number, right: number, top: number): number[] {
	return [left, top, right, top, right, bottom, left, bottom];
}

/** A map carrying one of each editable overlay plus one that is not editable. */
function createMapFixture(): V1MapDataForDrawing {
	return {
		IMAGE: {
			position: { left: 0, top: 0 },
			dimensions: { width: 8, height: 8 },
			pixels: { floor: [0, 1], obstacle: [], segments: [] }
		},
		FORBIDDEN_ZONES: [uprightZone(0, 0, 200, 200)],
		NO_MOP_ZONE: [uprightZone(400, 400, 600, 600)],
		VIRTUAL_WALLS: [[0, 0, 200, 0]],
		// Not editable from the tab, and therefore never left out.
		CURTAIN: [uprightZone(700, 700, 800, 800)]
	} as V1MapDataForDrawing;
}

describe("the shape a stored zone is drawn as", () => {
	/** A zone turned by roughly 17 degrees; no two corners share an x or a y. */
	const TURNED = [1000, 2000, 2910, 2580, 3490, 1670, 1580, 1090];

	it("hands the renderer the four corners, not just a box around them", async () => {
		const { renderer, zones } = createRecordingRenderer();
		await drawMapV1(
			{
				IMAGE: {
					position: { left: 0, top: 0 },
					dimensions: { width: 100, height: 100 },
					pixels: { floor: [0], obstacle: [], segments: [] }
				},
				FORBIDDEN_ZONES: [TURNED]
			} as V1MapDataForDrawing,
			renderer
		);

		expect(zones).toHaveLength(1);
		expect(zones[0].points).toHaveLength(4);

		// The corners really are turned: reduced to a box, all four would sit on two x values and
		// two y values. This is the fault the polygon fixes - the box covers floor the robot drives.
		const xs = new Set(zones[0].points?.map((point) => point.x));
		const ys = new Set(zones[0].points?.map((point) => point.y));
		expect(xs.size).toBe(4);
		expect(ys.size).toBe(4);
	});

	it("still describes an upright zone by the same box as before", async () => {
		// The promise to every existing installation: a map without a turned zone keeps exactly the
		// picture it has today. For an upright zone the polygon and the box are the same rectangle.
		const { renderer, zones } = createRecordingRenderer();
		await drawMapV1(
			{
				IMAGE: {
					position: { left: 0, top: 0 },
					dimensions: { width: 100, height: 100 },
					pixels: { floor: [0], obstacle: [], segments: [] }
				},
				FORBIDDEN_ZONES: [uprightZone(1000, 1000, 2000, 2000)]
			} as V1MapDataForDrawing,
			renderer
		);

		const zone = zones[0];
		const xs = zone.points?.map((point) => point.x) ?? [];
		const ys = zone.points?.map((point) => point.y) ?? [];
		expect(new Set(xs).size).toBe(2);
		expect(new Set(ys).size).toBe(2);
		// And the polygon spans exactly the box the older half of the interface reports.
		expect(Math.min(...xs)).toBeCloseTo(Math.min(zone.x, zone.x + zone.w), 6);
		expect(Math.max(...xs)).toBeCloseTo(Math.max(zone.x, zone.x + zone.w), 6);
		expect(Math.min(...ys)).toBeCloseTo(Math.min(zone.y, zone.y + zone.h), 6);
		expect(Math.max(...ys)).toBeCloseTo(Math.max(zone.y, zone.y + zone.h), 6);
	});

	it("gives the corners to every zone kind that has them, not only to no-go zones", async () => {
		const { renderer, zones } = createRecordingRenderer();
		await drawMapV1(
			{
				IMAGE: {
					position: { left: 0, top: 0 },
					dimensions: { width: 100, height: 100 },
					pixels: { floor: [0], obstacle: [], segments: [] }
				},
				FORBIDDEN_ZONES: [TURNED],
				NO_MOP_ZONE: [TURNED],
				CURTAIN: [TURNED],
				MISS_ZONE: [TURNED]
			} as V1MapDataForDrawing,
			renderer
		);

		expect(zones).toHaveLength(4);
		expect(zones.every((zone) => zone.points?.length === 4)).toBe(true);
	});
});

describe("drawMapV1 and the editable overlays", () => {
	it("draws all of them by default, which is what the adapter's own PNG needs", async () => {
		const { renderer, zones, walls } = createRecordingRenderer();
		await drawMapV1(createMapFixture(), renderer);

		// No-go, no-mop and the curtain.
		expect(zones).toHaveLength(3);
		expect(walls).toHaveLength(1);
	});

	it("leaves the three editable ones to the caller when asked", async () => {
		const { renderer, zones, walls } = createRecordingRenderer();
		await drawMapV1(createMapFixture(), renderer, { editableZonesDrawnElsewhere: true });

		// Only the curtain is left: it is not editable from the tab, so nothing else draws it.
		expect(zones).toHaveLength(1);
		expect(walls).toHaveLength(0);
	});

	it("keeps drawing them when the option is explicitly false", async () => {
		const { renderer, zones, walls } = createRecordingRenderer();
		await drawMapV1(createMapFixture(), renderer, { editableZonesDrawnElsewhere: false });

		expect(zones).toHaveLength(3);
		expect(walls).toHaveLength(1);
	});
});
