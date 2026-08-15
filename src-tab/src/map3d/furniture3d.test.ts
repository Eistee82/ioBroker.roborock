import { describe, expect, it } from "vitest";
import { FURNITURE_HEIGHTS_MM, UNKNOWN_FURNITURE_HEIGHT_MM, buildFurnitureBoxes, furnitureTitle } from "./furniture3d";
import { MM_PER_CELL } from "./map3dModel";

/**
 * Furniture as bodies.
 *
 * Three things are worth pinning down, and only one of them is about geometry:
 *
 * - **The frame.** A piece computed in the raw grid rows would sit mirrored against the walls, the
 *   floor texture and the robot, all of which go through the picture flip. That mistake has been
 *   made once in this view already.
 * - **The unknown type.** A piece the robot reports and this build does not recognise has to keep
 *   a body. Dropping it is the one outcome that is worse than a wrong-looking box.
 * - **The heights are a setting.** The test states the values so a change to them is a visible
 *   change and not a quiet one.
 */

/** Grid 40 × 30 cells, offset (10, 20). Cell (cx, cy) is therefore at ((cx+10)·50, (cy+20)·50) mm. */
const LEFT = 10;
const TOP = 20;
const GRID_HEIGHT = 30;

/** Millimetres of a grid cell corner, so the fixtures read as cells. */
function mm(cellX: number, cellY: number): { x: number; y: number } {
	return { x: (cellX + LEFT) * MM_PER_CELL, y: (cellY + TOP) * MM_PER_CELL };
}

/** An axis-aligned piece spanning raw cells (x0,y0)…(x1,y1), corners in the app's winding order. */
function piece(type: number, x0: number, y0: number, x1: number, y1: number, subType = 0): Record<string, number> {
	const a = mm(x0, y0);
	const b = mm(x1, y0);
	const c = mm(x1, y1);
	const d = mm(x0, y1);
	return {
		x1: a.x, y1: a.y, x2: b.x, y2: b.y, x3: c.x, y3: c.y, x4: d.x, y4: d.y,
		type, subType, percent: 10000, edit: 1, id: 1, hasAngle: 1
	};
}

describe("placing a piece", () => {
	it("puts it in the picture frame, not in the raw grid frame", () => {
		// Raw rows 2…6 of a 30-cell grid become picture rows 24…28, so the centre lands at 26 and
		// not at 4. Getting this wrong mirrors every piece against the walls it stands between.
		const boxes = buildFurnitureBoxes([piece(46, 3, 2, 9, 6)], LEFT, TOP, GRID_HEIGHT);

		expect(boxes).toHaveLength(1);
		expect(boxes[0].x).toBeCloseTo(6);
		expect(boxes[0].z).toBeCloseTo(26);
	});

	it("takes width, depth and angle from the map", () => {
		const boxes = buildFurnitureBoxes([piece(46, 3, 2, 9, 6)], LEFT, TOP, GRID_HEIGHT);

		expect(boxes[0].width).toBeCloseTo(6);
		expect(boxes[0].depth).toBeCloseTo(4);
		// Axis-aligned: the second edge points along +x, so there is nothing to turn.
		expect(boxes[0].angle).toBeCloseTo(0);
	});

	it("keeps a turned piece turned", () => {
		// The same rectangle rotated 90°: corners walked so that the first edge runs along y.
		const a = mm(4, 2);
		const b = mm(4, 8);
		const c = mm(7, 8);
		const d = mm(7, 2);
		const turned = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, x3: c.x, y3: c.y, x4: d.x, y4: d.y, type: 45, subType: 1 };

		const boxes = buildFurnitureBoxes([turned], LEFT, TOP, GRID_HEIGHT);
		expect(boxes[0].width).toBeCloseTo(6);
		expect(boxes[0].depth).toBeCloseTo(3);
		expect(Math.abs(boxes[0].angle)).toBeCloseTo(90);
	});
});

describe("the height table", () => {
	it("converts millimetres into cells", () => {
		const boxes = buildFurnitureBoxes([piece(51, 1, 1, 3, 3)], LEFT, TOP, GRID_HEIGHT);
		// Wardrobe, 2000 mm at 50 mm per cell.
		expect(boxes[0].height).toBe(FURNITURE_HEIGHTS_MM[51] / MM_PER_CELL);
		expect(boxes[0].height).toBe(40);
	});

	it("holds the values it holds, and they are a setting rather than a measurement", () => {
		// Nothing in the protocol carries a height; these numbers are chosen. Stated here so that
		// changing one is a deliberate act with a failing test attached, not a silent edit.
		expect(FURNITURE_HEIGHTS_MM[45]).toBe(500); // bed
		expect(FURNITURE_HEIGHTS_MM[46]).toBe(800); // sofa
		expect(FURNITURE_HEIGHTS_MM[47]).toBe(750); // dining table
		expect(FURNITURE_HEIGHTS_MM[51]).toBe(2000); // wardrobe
		expect(FURNITURE_HEIGHTS_MM[56]).toBe(80); // pet bowl
		expect(UNKNOWN_FURNITURE_HEIGHT_MM).toBe(400);
	});

	it("covers exactly the types the map table knows", () => {
		// A type with a name but no height would silently become a stand-in; the two tables have to
		// stay in step.
		expect(Object.keys(FURNITURE_HEIGHTS_MM).sort()).toEqual(
			["43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58"]
		);
	});
});

describe("a type nobody here knows", () => {
	it("still gets a body, marked as a stand-in", () => {
		// A piece the robot reports is a piece the user can trip over. Leaving it out is the one
		// outcome that is worse than a box of the wrong height.
		const boxes = buildFurnitureBoxes([piece(99, 2, 2, 5, 4)], LEFT, TOP, GRID_HEIGHT);

		expect(boxes).toHaveLength(1);
		expect(boxes[0].known).toBe(false);
		expect(boxes[0].height).toBe(UNKNOWN_FURNITURE_HEIGHT_MM / MM_PER_CELL);
		expect(boxes[0].type).toBe(99);
	});

	it("does not borrow another type's height", () => {
		const unknown = buildFurnitureBoxes([piece(99, 2, 2, 5, 4)], LEFT, TOP, GRID_HEIGHT)[0];
		for (const height of Object.values(FURNITURE_HEIGHTS_MM)) {
			if (height !== UNKNOWN_FURNITURE_HEIGHT_MM) expect(unknown.height).not.toBe(height / MM_PER_CELL);
		}
	});

	it("is named by its number rather than by a guess", () => {
		expect(furnitureTitle(46, 2)).toBe("Double sofa");
		expect(furnitureTitle(51, 0)).toBe("Wardrobe");
		expect(furnitureTitle(99, 0)).toBe("Furniture 99");
		// A subtype the table does not list has no name either - and must not fall back to a sibling.
		expect(furnitureTitle(46, 9)).toBe("Furniture 46");
	});
});

describe("entries that cannot be read", () => {
	it("skips them instead of placing a box somewhere", () => {
		const boxes = buildFurnitureBoxes(
			[null, "x", 7, {}, { x1: 1, y1: 2 }, { ...piece(45, 1, 1, 4, 3), x3: "nope" }],
			LEFT,
			TOP,
			GRID_HEIGHT
		);
		expect(boxes).toEqual([]);
	});

	it("skips a piece with no area", () => {
		expect(buildFurnitureBoxes([piece(45, 5, 5, 5, 5)], LEFT, TOP, GRID_HEIGHT)).toEqual([]);
	});

	it("says nothing when the map carries no furniture", () => {
		expect(buildFurnitureBoxes(undefined, LEFT, TOP, GRID_HEIGHT)).toEqual([]);
		expect(buildFurnitureBoxes([], LEFT, TOP, GRID_HEIGHT)).toEqual([]);
	});
});
