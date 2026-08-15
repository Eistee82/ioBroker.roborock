import { describe, expect, it } from "vitest";
import { MM_PER_CELL, WALL_HEIGHT_CELLS, buildMap3DModel, cellOf, robotMmToCell } from "./map3dModel";

/**
 * What the 3D view is built from.
 *
 * The point worth guarding is that this reads the **published** cell occupancy rather than
 * re-deriving anything: `_appanalysis/21-3d-kartenansicht.md` §8.3 concluded the adapter does not
 * publish it and that a new request would be needed. It does publish it, in
 * `map.mapData` → `IMAGE.pixels.obstacle`, and these tests are the standing proof of that shape.
 */

/** A miniature of the real answer: a 4 × 3 grid with three occupied cells. */
const MAP_DATA = {
	IMAGE: {
		position: { left: 10, top: 20 },
		dimensions: { width: 4, height: 3 },
		pixels: { obstacle: [0, 5, 11], floor: [1, 2, 3], segments: [] }
	},
	ROBOT_POSITION: { position: [600, 1100], angle: 90 },
	CHARGER_LOCATION: { position: [550, 1050], angle: 0 }
};

const IMAGE = "data:image/png;base64,AAAA";

describe("building the model", () => {
	it("reads the grid, the picture and the occupied cells", () => {
		const model = buildMap3DModel(MAP_DATA, IMAGE);

		expect(model).not.toBeNull();
		expect([model?.width, model?.height]).toEqual([4, 3]);
		expect(model?.obstacles).toEqual([0, 5, 11]);
		expect(model?.imageSrc).toBe(IMAGE);
	});

	it("takes the map data as a string, which is how the state carries it", () => {
		expect(buildMap3DModel(JSON.stringify(MAP_DATA), IMAGE)?.obstacles).toEqual([0, 5, 11]);
	});

	it("draws a mapped room with nothing solid in it", () => {
		// An empty obstacle list is a legitimate picture - the floor alone is still the map.
		const empty = { ...MAP_DATA, IMAGE: { ...MAP_DATA.IMAGE, pixels: { obstacle: [] } } };
		expect(buildMap3DModel(empty, IMAGE)?.obstacles).toEqual([]);
	});

	it("drops a cell index that cannot name a cell of this grid", () => {
		// Out of range it would stand in mid-air, which reads as a wall rather than as bad data.
		const strange = { ...MAP_DATA, IMAGE: { ...MAP_DATA.IMAGE, pixels: { obstacle: [0, 12, -1, 99, 2.5, "x"] } } };
		expect(buildMap3DModel(strange, IMAGE)?.obstacles).toEqual([0]);
	});

	it("refuses to build without a picture or without a grid", () => {
		// Half a model is worse than staying in 2D: a floor with no texture, or walls over nothing.
		expect(buildMap3DModel(MAP_DATA, null)).toBeNull();
		expect(buildMap3DModel(MAP_DATA, "not-a-data-uri")).toBeNull();
		expect(buildMap3DModel(null, IMAGE)).toBeNull();
		expect(buildMap3DModel("{ broken", IMAGE)).toBeNull();
		expect(buildMap3DModel({ IMAGE: { dimensions: { width: 0, height: 3 } } }, IMAGE)).toBeNull();
	});

	it("says nothing about a robot the map does not place", () => {
		const without = { IMAGE: MAP_DATA.IMAGE };
		const model = buildMap3DModel(without, IMAGE);
		expect(model?.robot).toBeNull();
		expect(model?.charger).toBeNull();
	});
});

describe("where things stand", () => {
	it("turns a cell index into its place in the grid", () => {
		expect(cellOf(0, 4)).toEqual({ x: 0, y: 0 });
		expect(cellOf(5, 4)).toEqual({ x: 1, y: 1 });
		expect(cellOf(11, 4)).toEqual({ x: 3, y: 2 });
	});

	it("converts millimetres the way the 2D view does", () => {
		// Same function, same offsets, only `scale: 1` instead of 3. If the two ever disagree, the
		// robot stands in a different place in each view - which is why the transform is imported
		// from the adapter rather than written again here.
		//
		// x: (600 - 10·50)/50 + 0.5 = 2.5 · y: 3 - ((1100 - 20·50)/50) - 0.5 = 0.5
		expect(robotMmToCell({ x: 600, y: 1100 }, 10, 20, 3)).toEqual({ x: 2.5, y: 0.5 });
	});

	it("places the robot and the dock through that same conversion", () => {
		const model = buildMap3DModel(MAP_DATA, IMAGE);
		expect(model?.robot).toEqual({ x: 2.5, y: 0.5, angle: 90 });
		expect(model?.charger).toEqual({ x: 1.5, y: 1.5, angle: 0 });
	});
});

describe("the two constants the geometry rests on", () => {
	it("keeps the app's wall height and cell size", () => {
		// 10 cells at 50 mm is the 500 mm the app extrudes (A65 `C4192OooO0oo.java:174`). A change
		// here silently rescales every wall in the view.
		expect(WALL_HEIGHT_CELLS).toBe(10);
		expect(MM_PER_CELL).toBe(50);
	});
});
