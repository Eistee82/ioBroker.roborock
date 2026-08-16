import { describe, expect, it } from "vitest";
import { MM_PER_CELL, WALL_HEIGHT_CELLS, buildMap3DModel, cellOf, provablyDifferentMap, robotMmToCell, sceneGeometryKey } from "./map3dModel";
import type { Map3DModel } from "./map3dModel";

/**
 * What the 3D view is built from.
 *
 * Two things are worth guarding here.
 *
 * That this reads the **published** cell occupancy rather than re-deriving anything:
 * `_appanalysis/21-3d-kartenansicht.md` §8.3 concluded the adapter does not publish it and that a
 * new request would be needed. It does publish it, in `map.mapData` → `IMAGE.raster`, and these
 * tests are the standing proof of that shape - in both forms, because a `mapData` state written
 * before the raster replaced the cell lists carries `IMAGE.pixels` instead and is read back
 * unchanged.
 *
 * And the row order, which is the kind of mistake that looks fine until someone compares the 3D
 * view with the 2D one on an asymmetric flat.
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

/**
 * A 4 × 3 grid whose top row is a wall, so there is something to merge.
 *
 * No dock: the dock is blanked out with a radius of four cells, which on a grid this small would
 * clear the whole map. That is correct behaviour and has its own test below.
 */
const WITH_WALL = {
	IMAGE: { ...MAP_DATA.IMAGE, pixels: { obstacle: [0, 1, 2, 3], floor: [4, 5, 6, 7], segments: [] } }
};

describe("building the model", () => {
	it("reads the grid, the picture and the merged walls", () => {
		const model = buildMap3DModel(WITH_WALL, IMAGE);

		expect(model).not.toBeNull();
		expect([model?.width, model?.height]).toEqual([4, 3]);
		expect(model?.walls).toEqual([{ x0: 0, y0: 2, x1: 3, y1: 2 }]);
		expect(model?.wallCellCount).toBe(4);
		expect(model?.imageSrc).toBe(IMAGE);
	});

	it("takes the map data as a string, which is how the state carries it", () => {
		expect(buildMap3DModel(JSON.stringify(WITH_WALL), IMAGE)?.walls).toEqual([{ x0: 0, y0: 2, x1: 3, y1: 2 }]);
	});

	it("draws a mapped room with nothing solid in it", () => {
		// An empty obstacle list is a legitimate picture - the floor alone is still the map.
		const empty = { IMAGE: { ...MAP_DATA.IMAGE, pixels: { obstacle: [] } } };
		expect(buildMap3DModel(empty, IMAGE)?.walls).toEqual([]);
	});

	it("drops a cell index that cannot name a cell of this grid", () => {
		// Out of range it would stand in mid-air, which reads as a wall rather than as bad data.
		const strange = { IMAGE: { ...MAP_DATA.IMAGE, pixels: { obstacle: [0, 1, 12, -1, 99, 2.5, "x"] } } };
		const model = buildMap3DModel(strange, IMAGE);
		expect(model?.wallCellCount).toBe(2);
		expect(model?.walls).toEqual([{ x0: 0, y0: 2, x1: 1, y1: 2 }]);
	});

	it("builds the same walls from the raster as from the cell lists it replaced", () => {
		// Same 4 × 3 grid as WITH_WALL: top row wall (segment 1), row below it floor, rest empty.
		// Cell types live in the low three bits, the segment id above them.
		const wall = (1 << 3) | 1;
		const floor = (1 << 3) | 7;
		const raster = {
			encoding: "rle" as const,
			width: 4,
			height: 3,
			runs: [wall, 4, floor, 4, 0, 4]
		};
		const fromRaster = buildMap3DModel({ IMAGE: { ...MAP_DATA.IMAGE, pixels: undefined, raster } }, IMAGE);

		expect(fromRaster?.walls).toEqual(buildMap3DModel(WITH_WALL, IMAGE)?.walls);
		expect(fromRaster?.wallCellCount).toBe(4);
	});

	it("draws no walls at all when the block carries neither form", () => {
		// A B01/Q10 map, or an image block that could not be parsed. The floor and the picture are
		// still there, so the view stays usable rather than falling back to 2D.
		const model = buildMap3DModel({ IMAGE: { ...MAP_DATA.IMAGE, pixels: undefined } }, IMAGE);
		expect(model).not.toBeNull();
		expect(model?.walls).toEqual([]);
		expect(model?.wallCellCount).toBe(0);
	});

	it("puts the walls in the row order of the picture, not of the cell list", () => {
		// The adapter draws cell `i` at `y = height - row - 1`
		// (`src/common/mapDrawing/coordHelpers.ts:31-36`) and flips the robot the same way, so the map
		// PNG is upside down with respect to the cell indices. A wall taken straight from the index
		// would stand mirrored front to back over its own floor.
		//
		// The wall here is the grid's **top** row, so it has to come out as the picture's **bottom**
		// row - `y = 2` on a grid three cells high.
		const model = buildMap3DModel(WITH_WALL, IMAGE);
		expect(model?.walls).toEqual([{ x0: 0, y0: 2, x1: 3, y1: 2 }]);
	});

	it("carries the furniture through, in the same flipped frame as the walls", () => {
		// One cell, raw column 0 and raw row 1, on a grid three cells high. Its corners are grid
		// lines, so raw row 1 spans 1…2 and comes out as picture 2…1 - centre 1.5, the centre of
		// picture row 1. That is the same flip the walls get; if the two ever disagree, the sofa
		// stands in the wrong room.
		const furnished = {
			IMAGE: WITH_WALL.IMAGE,
			FURNITURES: [{ x1: 500, y1: 1050, x2: 550, y2: 1050, x3: 550, y3: 1100, x4: 500, y4: 1100, type: 46, subType: 2 }]
		};
		const model = buildMap3DModel(furnished, IMAGE);

		expect(model?.furniture).toHaveLength(1);
		expect(model?.furniture[0].known).toBe(true);
		expect(model?.furniture[0].x).toBeCloseTo(0.5);
		expect(model?.furniture[0].z).toBeCloseTo(1.5);
	});

	it("says the furniture list is empty rather than leaving it undefined", () => {
		// The scene iterates it unconditionally; `undefined` would take the whole view down.
		expect(buildMap3DModel(WITH_WALL, IMAGE)?.furniture).toEqual([]);
	});

	it("does not extrude cells that never form a run", () => {
		// Three cells, none of them touching another. The app requires a chain of more than one cell,
		// so nothing is drawn - part of what made the view stop looking like gravel.
		const model = buildMap3DModel({ IMAGE: MAP_DATA.IMAGE }, IMAGE);
		expect(model?.wallCellCount).toBe(3);
		expect(model?.walls).toEqual([]);
	});
});

describe("what gets blanked out before the walls are looked for", () => {
	it("clears four cells around the dock, so it does not become a wall stub", () => {
		// `MAP_DATA` places the dock at (550, 1050) mm = cell (1, 1) of this grid. A radius of four
		// swallows the whole 4 × 3 map, which is exactly why the fixture above leaves the dock out.
		const model = buildMap3DModel(MAP_DATA, IMAGE);
		expect(model?.wallCellCount).toBe(0);
		expect(model?.walls).toEqual([]);
	});

	it("clears a piece of furniture together with a one-cell margin", () => {
		// One piece covering cell (1,1) only. With the margin it reaches (0,0)…(2,2), so the wall row
		// along the top loses its middle and only the far right cell is left - too short for a run.
		const furnished = {
			IMAGE: WITH_WALL.IMAGE,
			FURNITURES: [{ x1: 550, y1: 1050, x2: 550, y2: 1050, x3: 550, y3: 1050, x4: 550, y4: 1050, type: 45, subType: 1 }]
		};
		const model = buildMap3DModel(furnished, IMAGE);
		expect(model?.wallCellCount).toBe(1);
		expect(model?.walls).toEqual([]);
	});

	it("clears one cell around each detected object, from either obstacle block", () => {
		// The app reads block 13; the test device sends its objects in block 15. Both are honoured,
		// because a wall stub around a shoe looks the same whichever block it arrived in.
		const withObject = { IMAGE: WITH_WALL.IMAGE, OBSTACLES2: [[550, 1050, 2, 0, 0, 0, "shoe"]] };
		expect(buildMap3DModel(withObject, IMAGE)?.wallCellCount).toBe(1);

		const otherBlock = { IMAGE: WITH_WALL.IMAGE, OBSTACLES: [[550, 1050, 2, 0, 0, 0, "shoe"]] };
		expect(buildMap3DModel(otherBlock, IMAGE)?.wallCellCount).toBe(1);
	});

	it("ignores furniture and objects it cannot read", () => {
		const rubbish = {
			IMAGE: WITH_WALL.IMAGE,
			FURNITURES: [null, {}, "x", { x1: "a", y1: 1, x2: 2, y2: 2, x3: 3, y3: 3, x4: 4, y4: 4 }],
			OBSTACLES2: [null, [], ["a", "b"], 7]
		};
		expect(buildMap3DModel(rubbish, IMAGE)?.walls).toEqual([{ x0: 0, y0: 2, x1: 3, y1: 2 }]);
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

describe("which map this is", () => {
	it("reads the map flag the adapter publishes", () => {
		// `MapManager` writes it beside the blocks: "Expose the map flag so consumers … can key
		// rooms correctly". The 3D view uses it to tell a new floor from the same one seen again.
		expect(buildMap3DModel({ ...WITH_WALL, mapFlag: 2 }, IMAGE)?.mapFlag).toBe(2);
	});

	it("reports no flag where the map carries none", () => {
		// B01 and Q10 maps, and any V1 map read before the active slot is known.
		expect(buildMap3DModel(WITH_WALL, IMAGE)?.mapFlag).toBeNull();
	});

	it("calls a map change only what two known flags prove", () => {
		expect(provablyDifferentMap(0, 1)).toBe(true);
		expect(provablyDifferentMap(1, 1)).toBe(false);
		// An unknown flag is not evidence. Treating it as one would reset the camera on every
		// cycle of a robot that publishes none, which is the bug this whole distinction exists for.
		expect(provablyDifferentMap(null, 1)).toBe(false);
		expect(provablyDifferentMap(0, null)).toBe(false);
		expect(provablyDifferentMap(null, null)).toBe(false);
	});
});

describe("the key that decides whether the scene is rebuilt", () => {
	function model(over: Partial<Map3DModel> = {}): Map3DModel {
		return {
			width: 4,
			height: 3,
			left: 10,
			top: 20,
			walls: [{ x0: 0, y0: 0, x1: 3, y1: 0 }],
			wallCellCount: 4,
			furniture: [],
			zones: [],
			virtualWalls: [],
			imageSrc: "data:image/png;base64,AAAA",
			robot: { x: 2.5, y: 0.5, angle: 90 },
			charger: { x: 1.5, y: 1.5, angle: 0 },
			mapFlag: 0,
			...over
		};
	}

	/*
	 * The three fields a map cycle changes while the flat stays the flat it was. Each of them used
	 * to cost a full rebuild - new floor, new walls, new furniture, new camera - three seconds
	 * after the last one, which is what threw the user's viewing angle away.
	 */
	it("ignores the map picture, the robot and the dock", () => {
		const base = sceneGeometryKey(model());
		expect(sceneGeometryKey(model({ imageSrc: "data:image/png;base64,WITHPATH" }))).toBe(base);
		expect(sceneGeometryKey(model({ robot: { x: 99, y: 99, angle: 12 } }))).toBe(base);
		expect(sceneGeometryKey(model({ charger: { x: 88, y: 88, angle: 0 } }))).toBe(base);
		expect(sceneGeometryKey(model({ robot: null, charger: null }))).toBe(base);
	});

	it("ignores the map flag, which decides the camera and not the bodies", () => {
		expect(sceneGeometryKey(model({ mapFlag: 7 }))).toBe(sceneGeometryKey(model()));
	});

	it("changes for every part the scene is actually built from", () => {
		const base = sceneGeometryKey(model());
		expect(sceneGeometryKey(model({ width: 5 }))).not.toBe(base);
		expect(sceneGeometryKey(model({ height: 4 }))).not.toBe(base);
		expect(sceneGeometryKey(model({ left: 11 }))).not.toBe(base);
		expect(sceneGeometryKey(model({ top: 21 }))).not.toBe(base);
		expect(sceneGeometryKey(model({ wallCellCount: 5 }))).not.toBe(base);
		expect(sceneGeometryKey(model({ walls: [] }))).not.toBe(base);
		expect(sceneGeometryKey(model({ zones: [{ kind: "forbidden", x: 1, z: 1, width: 2, depth: 2, angle: 0 }] }))).not.toBe(base);
		expect(sceneGeometryKey(model({ virtualWalls: [{ x: 1, z: 1, length: 3, angle: 0 }] }))).not.toBe(base);
	});

	/**
	 * A wall that moved without the count changing. Comparing counts alone would leave the old
	 * geometry standing for good, because no later cycle would ever notice the difference either.
	 */
	it("notices a wall that moved while the count stayed the same", () => {
		const moved = model({ walls: [{ x0: 1, y0: 0, x1: 3, y1: 0 }] });
		expect(sceneGeometryKey(moved)).not.toBe(sceneGeometryKey(model()));
	});

	it("notices furniture that was moved, turned or swapped for another model", () => {
		const piece = {
			x: 5,
			z: 6,
			width: 2,
			depth: 3,
			height: 400,
			angle: 0,
			type: 1,
			subType: 0,
			known: true,
			parts: null,
			model: "sofa"
		};
		const base = sceneGeometryKey(model({ furniture: [piece] }));
		expect(sceneGeometryKey(model({ furniture: [{ ...piece, x: 6 }] }))).not.toBe(base);
		expect(sceneGeometryKey(model({ furniture: [{ ...piece, angle: 90 }] }))).not.toBe(base);
		expect(sceneGeometryKey(model({ furniture: [{ ...piece, model: "bed" }] }))).not.toBe(base);
		expect(sceneGeometryKey(model({ furniture: [{ ...piece, model: null }] }))).not.toBe(base);
		expect(sceneGeometryKey(model({ furniture: [] }))).not.toBe(base);
	});

	/**
	 * The lists are separated in the key, so moving an entry from one of them to another cannot
	 * produce the same string by accident.
	 */
	it("keeps the lists apart", () => {
		const asZone = model({ zones: [{ kind: "noMop", x: 1, z: 2, width: 3, depth: 4, angle: 0 }] });
		const asWall = model({ virtualWalls: [{ x: 1, z: 2, length: 3, angle: 4 }] });
		expect(sceneGeometryKey(asZone)).not.toBe(sceneGeometryKey(asWall));
	});
});
