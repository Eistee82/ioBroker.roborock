import { describe, expect, it } from "vitest";
import { VIRTUAL_WALL_THICKNESS, ZONE_HEIGHT, buildZones3D } from "./zones3d";
import { MM_PER_CELL, WALL_HEIGHT_CELLS } from "./map3dModel";

/**
 * Zones and virtual walls.
 *
 * The shapes are read out of the native renderer and written up in `zones3d.ts`; what these tests
 * hold is the part that would be wrong without being visible: the frame, the rotation and the two
 * lengths the app adds a cell to.
 */

const LEFT = 10;
const TOP = 20;
const GRID_HEIGHT = 30;

/** Millimetres of a grid corner, so the fixtures read as cells. */
function mm(cellX: number, cellY: number): [number, number] {
	return [(cellX + LEFT) * MM_PER_CELL, (cellY + TOP) * MM_PER_CELL];
}

/** An axis-aligned zone over raw cells (x0,y0)…(x1,y1), corners in the app's winding order. */
function zone(x0: number, y0: number, x1: number, y1: number): number[] {
	return [...mm(x0, y0), ...mm(x1, y0), ...mm(x1, y1), ...mm(x0, y1)];
}

describe("no-go and no-mop zones", () => {
	it("places a zone in the picture frame and keeps its size", () => {
		// Raw rows 2…6 become picture rows 24…28, so the centre is at 26 - not at 4. A zone computed
		// in the raw frame would close off the mirror image of the room it belongs to.
		const built = buildZones3D([zone(3, 2, 9, 6)], null, null, LEFT, TOP, GRID_HEIGHT);

		expect(built.zones).toHaveLength(1);
		expect(built.zones[0].kind).toBe("forbidden");
		expect(built.zones[0].x).toBeCloseTo(6);
		expect(built.zones[0].z).toBeCloseTo(26);
		expect(built.zones[0].width).toBeCloseTo(6);
		expect(built.zones[0].depth).toBeCloseTo(4);
		expect(built.zones[0].angle).toBeCloseTo(0);
	});

	it("tells the two layers apart and keeps them in one list", () => {
		const built = buildZones3D([zone(1, 1, 3, 3)], [zone(5, 5, 7, 7)], null, LEFT, TOP, GRID_HEIGHT);

		expect(built.zones.map((z) => z.kind)).toEqual(["forbidden", "noMop"]);
	});

	it("keeps a turned zone turned", () => {
		// This project has already fixed one renderer that reduced a turned zone to its bounding box
		// (`bd8d41a8`). A rotated zone lies over a different piece of floor than its bounding box.
		const a = mm(4, 2);
		const b = mm(4, 8);
		const c = mm(7, 8);
		const d = mm(7, 2);
		const built = buildZones3D([[...a, ...b, ...c, ...d]], null, null, LEFT, TOP, GRID_HEIGHT);

		expect(built.zones[0].width).toBeCloseTo(6);
		expect(built.zones[0].depth).toBeCloseTo(3);
		expect(Math.abs(built.zones[0].angle)).toBeCloseTo(90);
	});

	it("stands as tall as the map walls", () => {
		// Not decoration: a zone shorter than the walls reads as a rug, and a zone is a barrier.
		expect(ZONE_HEIGHT).toBe(WALL_HEIGHT_CELLS);
	});
});

describe("virtual walls", () => {
	it("is a slab along the segment, one cell longer than the segment itself", () => {
		// The `+ 1` is the app's own (`C4192OooO0oo.java:158`): it makes two walls that share an end
		// meet instead of leaving a hairline gap.
		const built = buildZones3D(null, null, [[...mm(2, 4), ...mm(10, 4)]], LEFT, TOP, GRID_HEIGHT);

		expect(built.virtualWalls).toHaveLength(1);
		expect(built.virtualWalls[0].length).toBeCloseTo(9);
		expect(built.virtualWalls[0].x).toBeCloseTo(6);
		expect(built.virtualWalls[0].z).toBeCloseTo(26);
		expect(built.virtualWalls[0].angle).toBeCloseTo(0);
		expect(VIRTUAL_WALL_THICKNESS).toBe(1);
	});

	it("turns with the segment", () => {
		const built = buildZones3D(null, null, [[...mm(5, 2), ...mm(5, 8)]], LEFT, TOP, GRID_HEIGHT);

		// Down the raw grid is up the picture, so a segment drawn downwards comes out at -90°.
		expect(Math.abs(built.virtualWalls[0].angle)).toBeCloseTo(90);
		expect(built.virtualWalls[0].length).toBeCloseTo(7);
	});

	it("skips a wall of zero length", () => {
		expect(buildZones3D(null, null, [[...mm(5, 5), ...mm(5, 5)]], LEFT, TOP, GRID_HEIGHT).virtualWalls).toEqual([]);
	});
});

describe("entries that cannot be read", () => {
	it("skips them rather than placing something somewhere", () => {
		const built = buildZones3D(
			[null, "x", [], [1, 2, 3], [...mm(1, 1), ...mm(2, 1), ...mm(2, 2), "nope", 5]],
			null,
			[null, [1, 2], ["a", "b", "c", "d"]],
			LEFT,
			TOP,
			GRID_HEIGHT
		);
		expect(built).toEqual({ zones: [], virtualWalls: [] });
	});

	it("says nothing when the map carries no zones at all", () => {
		expect(buildZones3D(undefined, undefined, undefined, LEFT, TOP, GRID_HEIGHT)).toEqual({ zones: [], virtualWalls: [] });
	});
});
