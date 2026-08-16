/**
 * What the 3D view needs, pulled out of the states the 2D view already reads.
 *
 * ## No new road to the adapter
 *
 * Nothing is requested for the 3D view, and switching to it costs the robot nothing at all. The
 * grid comes from `map.mapData`, which `MapEngine` subscribes to anyway; the picture comes from
 * `map.mapBase64Surface` where the adapter publishes one and from `map.mapBase64Clean` otherwise.
 * Which of the two, and why there are two, is decided in `map3dSource.ts`.
 *
 * ## A correction to `_appanalysis/21-3d-kartenansicht.md` §8.3
 *
 * That report concluded the cell occupancy "hat sie, veröffentlicht sie aber nicht", and therefore
 * that a new `sendTo` handler would be needed before any wall could be drawn. **That is wrong, and
 * the walls in this view are the proof.** `MapParser.parseImageBlock` publishes the whole grid as
 * `IMAGE.raster`, one byte per cell, run-length coded, and `MapManager` writes the parse result
 * into the state unchanged - `JSON.stringify(res.mapData)` at `src/lib/map/MapManager.ts:638`, with
 * nothing in between that strips the field. `imagePixels` turns it back into cell lists. Checked
 * against the test device's own map: 3 468 obstacle cells and 30 490 floor cells come out of it
 * (`_appanalysis/backups/backup-20260814-185206`).
 *
 * So the walls are built from real occupancy, not from re-reading the rendered PNG - which the same
 * report rightly advised against, because the obstacle pixels there carry the theme colour and
 * anti-aliasing smears the edges.
 *
 * ## The geometry follows the app, where the app was readable
 *
 * The wall height is the app's own constant: `10` world units at one unit per cell, and a cell is
 * 50 mm, so 500 mm (`21-3d-kartenansicht.md` §3.1, from
 * `com/roborock/smart/react/mapv2/view/C4192OooO0oo.java:170-186`).
 *
 * The cells are **not** extruded one by one. The app groups them, throws away the groups that sit
 * enclosed inside a room, and merges the rest into straight runs before extruding - which is why
 * its 3D view shows outlines and this one first showed gravel. That algorithm lives in
 * {@link extractWalls}, together with its measurement: 3 468 cells become 541 wall segments.
 */

import { robotToPixel } from "@adapter/common/coordTransformation";
import { imagePixels } from "@adapter/common/segmentRaster";
import type { SegmentRaster } from "@adapter/common/segmentRaster";
import { clearedCells, extractWalls } from "./walls";
import type { WallSegment } from "./walls";
import { buildFurnitureBoxes } from "./furniture3d";
import type { FurnitureBox } from "./furniture3d";
import { buildZones3D } from "./zones3d";
import type { VirtualWall3D, Zone3D } from "./zones3d";

// Imported for use here **and** re-exported, because every existing caller reaches for these two
// through this module. A bare `export … from` would not bring them into this file's own scope.
import { MM_PER_CELL } from "./units";

export { MM_PER_CELL, WALL_HEIGHT_CELLS } from "./units";

/** A point in cell coordinates, the unit the whole 3D scene works in. */
export interface CellPoint {
	x: number;
	y: number;
}

/** Something with a place and a heading on the floor. */
export interface Placed extends CellPoint {
	/** Heading in degrees, as the robot reports it. */
	angle: number;
}

/** Everything the 3D scene is built from. */
export interface Map3DModel {
	/** Grid width in cells. */
	width: number;
	/** Grid height in cells. */
	height: number;
	/** Grid offset in cells, `IMAGE.position.left`. Kept so the live channel can convert too. */
	left: number;
	/** Grid offset in cells, `IMAGE.position.top`. */
	top: number;
	/** Straight wall runs, merged out of the occupied cells the way the app does it. */
	walls: WallSegment[];
	/** How many occupied cells went into those runs. Kept so the view can report the reduction. */
	wallCellCount: number;
	/** Furniture as plain bodies; empty when the map carries none. */
	furniture: FurnitureBox[];
	/** No-go and no-mop zones, to look at - the editing lives in the 2D view. */
	zones: Zone3D[];
	/** Virtual walls. */
	virtualWalls: VirtualWall3D[];
	/** The finished map picture, ready to use as a texture. */
	imageSrc: string;
	robot: Placed | null;
	charger: Placed | null;
	/**
	 * Which of the robot's stored maps this is, or null where the adapter cannot say.
	 *
	 * `MapManager` writes it into the published `mapData` as `mapFlag` (`src/lib/map/MapManager.ts`,
	 * "Expose the map flag so consumers … can key rooms correctly"), but only for V1 maps and only
	 * once the active slot is known. B01 and Q10 maps carry none.
	 *
	 * The view uses it for one decision and nothing else: whether an incoming map is a **different**
	 * map, in which case starting the camera over is right, or the same one seen again, in which case
	 * the user's viewing angle has to survive. Null on either side means "not provably different",
	 * and the camera is kept - a camera left where the user put it is a small mistake, throwing it
	 * away is the one that was reported.
	 */
	mapFlag: number | null;
}

/** The slice of `mapData` this module reads. */
interface RawMapData {
	IMAGE?: {
		position?: { left?: unknown; top?: unknown };
		dimensions?: { width?: unknown; height?: unknown };
		/** Only on `mapData` written before the raster replaced these lists. */
		pixels?: { obstacle?: unknown; floor?: unknown };
		/** The grid the cell lists are derived from; the form every current map carries. */
		raster?: SegmentRaster;
	};
	ROBOT_POSITION?: { position?: unknown; angle?: unknown };
	CHARGER_LOCATION?: { position?: unknown; angle?: unknown };
	FORBIDDEN_ZONES?: unknown;
	NO_MOP_ZONE?: unknown;
	VIRTUAL_WALLS?: unknown;
	FURNITURES?: unknown;
	OBSTACLES?: unknown;
	OBSTACLES2?: unknown;
	/** Which stored map this is; written by `MapManager` for V1 maps, absent otherwise. */
	mapFlag?: unknown;
}

/** Reads a positive integer, or null. */
function positiveInt(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Reads a finite number, or null. */
function finite(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turns a robot position in millimetres into cell coordinates.
 *
 * Uses the adapter's own `robotToPixel` with `scale: 1` rather than repeating its arithmetic. The
 * 2D view goes through the same function with `scale: 3`; a second implementation here would be
 * the thing that eventually puts the robot in a different place in the two views.
 *
 * @param mm Robot coordinates in millimetres.
 * @param left Map offset in cells, `IMAGE.position.left`.
 * @param top Map offset in cells, `IMAGE.position.top`.
 * @param height Grid height in cells.
 * @returns The point in cell coordinates.
 */
export function robotMmToCell(mm: CellPoint, left: number, top: number, height: number): CellPoint {
	return robotToPixel({
		x: mm.x,
		y: mm.y,
		minX: left * MM_PER_CELL,
		minY: top * MM_PER_CELL,
		sizeY: height,
		resolution: MM_PER_CELL,
		scale: 1
	});
}

/** Reads one of the two placed things out of the parse result. */
function readPlaced(block: { position?: unknown; angle?: unknown } | undefined, left: number, top: number, height: number): Placed | null {
	const position = block?.position;
	if (!Array.isArray(position) || position.length < 2) return null;

	const x = finite(position[0]);
	const y = finite(position[1]);
	if (x === null || y === null) return null;

	const cell = robotMmToCell({ x, y }, left, top, height);
	return { x: cell.x, y: cell.y, angle: finite(block?.angle) ?? 0 };
}

/**
 * Builds the model, or reports that there is nothing to draw.
 *
 * Returns null rather than a half model whenever the picture or the grid is missing: a 3D view with
 * a floor and no texture, or with walls floating over nothing, is worse than staying in 2D. The
 * caller shows the 2D view in that case.
 *
 * An **empty** obstacle list is not a reason to refuse - a robot that has mapped a room without
 * anything solid in it is a legitimate, if unlikely, picture, and the floor alone is still the map.
 *
 * @param rawMapData Value of `map.mapData`, string or already parsed.
 * @param imageSrc The map picture as a complete data URI - `map.mapBase64Surface`, or
 * `map.mapBase64Clean` where there is none. Picked by `Map3DSource.textureSource`.
 * @returns The model, or null when the two states do not carry a drawable map.
 */
export function buildMap3DModel(rawMapData: unknown, imageSrc: unknown): Map3DModel | null {
	if (typeof imageSrc !== "string" || !imageSrc.startsWith("data:")) return null;

	let parsed: RawMapData | null = null;
	if (typeof rawMapData === "string") {
		try {
			parsed = JSON.parse(rawMapData) as RawMapData;
		} catch {
			return null;
		}
	} else if (rawMapData && typeof rawMapData === "object") {
		parsed = rawMapData as RawMapData;
	}
	if (!parsed?.IMAGE) return null;

	const width = positiveInt(parsed.IMAGE.dimensions?.width);
	const height = positiveInt(parsed.IMAGE.dimensions?.height);
	if (width === null || height === null) return null;

	const left = finite(parsed.IMAGE.position?.left) ?? 0;
	const top = finite(parsed.IMAGE.position?.top) ?? 0;

	// Only indices that can name a cell of this grid. A stray value would place a box outside the
	// floor, where it would look like a wall in mid-air rather than like the bad datum it is. Kept
	// even though `imagePixels` derives its own lists from the raster: the other branch of that
	// function hands back whatever an older `mapData` state happens to contain.
	const lists = imagePixels(parsed.IMAGE);
	const obstacles = cellIndices(lists.obstacle, width * height);
	const floor = cellIndices(lists.floor, width * height);
	const cleared = clearedCells(width, height, left, top, {
		furniture: readFurnitureCorners(parsed.FURNITURES),
		dock: readPointMm(parsed.CHARGER_LOCATION?.position),
		objects: [...readObjectPositions(parsed.OBSTACLES), ...readObjectPositions(parsed.OBSTACLES2)]
	});
	const extracted = extractWalls(width, height, obstacles, floor, cleared);
	const zones = buildZones3D(parsed.FORBIDDEN_ZONES, parsed.NO_MOP_ZONE, parsed.VIRTUAL_WALLS, left, top, height);

	return {
		width,
		height,
		left,
		top,
		walls: extracted.segments.map(flipRow.bind(null, height)),
		wallCellCount: extracted.cellCount,
		furniture: buildFurnitureBoxes(parsed.FURNITURES, left, top, height),
		zones: zones.zones,
		virtualWalls: zones.virtualWalls,
		imageSrc,
		robot: readPlaced(parsed.ROBOT_POSITION, left, top, height),
		charger: readPlaced(parsed.CHARGER_LOCATION, left, top, height),
		mapFlag: Number.isInteger(Number(parsed.mapFlag)) ? Number(parsed.mapFlag) : null
	};
}

/**
 * A key for everything the scene's **bodies** are built from, and nothing else.
 *
 * ## Why this exists
 *
 * `Map3DSource` hands down a new `Map3DModel` object on every map cycle, and `io-package.json`
 * ships `liveMapInterval: 3` - so while the robot works, that is every three seconds. The view used
 * to list the model itself among the dependencies of its start-up effect, which meant a full
 * teardown and rebuild at that rate: floor, walls, furniture, zones, a new `PerspectiveCamera` and
 * new `OrbitControls`. Measured in `Map3DView.test.tsx`: six renders, six builds, four separate
 * cameras. The user's rotation lived in a camera that was thrown away a moment later, which is the
 * "3D view keeps resetting" report.
 *
 * Most of those cycles change nothing this key covers. What they do change is the **picture** - the
 * path and the mopped band are painted into `map.mapBase64Surface` - and the robot's place. Both are
 * applied to the standing scene instead, so the geometry is only rebuilt when the geometry actually
 * differs.
 *
 * ## What is deliberately not in it
 *
 * `imageSrc` (swapped as a texture), `robot` and `charger` (moved), and `mapFlag` (a different map
 * with identical bodies still needs no rebuild - it is only allowed to reset the camera).
 *
 * @param model The model to describe.
 * @returns A string that differs whenever a rebuild is needed.
 */
export function sceneGeometryKey(model: Map3DModel): string {
	const parts: Array<string | number> = [model.width, model.height, model.left, model.top, model.wallCellCount];
	// The runs are compared in full rather than by count: a wall that moved without the count
	// changing would otherwise leave the old geometry standing, and nothing would ever correct it.
	for (const wall of model.walls) parts.push(wall.x0, wall.y0, wall.x1, wall.y1);
	parts.push("|");
	for (const piece of model.furniture) {
		parts.push(piece.x, piece.z, piece.width, piece.depth, piece.height, piece.angle, piece.type, piece.subType, piece.model ?? "");
	}
	parts.push("|");
	for (const zone of model.zones) parts.push(zone.kind, zone.x, zone.z, zone.width, zone.depth, zone.angle);
	parts.push("|");
	for (const wall of model.virtualWalls) parts.push(wall.x, wall.z, wall.length, wall.angle);
	return parts.join(",");
}

/**
 * Whether two map flags prove that the map itself changed - another floor, another stored map.
 *
 * Only a pair of known and unequal flags counts. An absent flag is not evidence of a change, and
 * treating it as one is what would reset the camera on every cycle of a robot that publishes none.
 *
 * @param before Map flag the scene was built for.
 * @param after Map flag of the map now being built.
 * @returns True only when both are known and differ.
 */
export function provablyDifferentMap(before: number | null, after: number | null): boolean {
	return typeof before === "number" && typeof after === "number" && before !== after;
}

/**
 * Turns a wall run from grid rows into the row order of the rendered picture.
 *
 * **The map PNG is upside down with respect to the cell indices.** The adapter draws cell `i` at
 * `y = height - row(i) - 1` (`src/common/mapDrawing/coordHelpers.ts:31-36`), and `robotToPixel`
 * flips the robot the same way, so the two agree in the 2D view. The cell lists, however, are in
 * plain row order.
 *
 * The 3D view uses that PNG as its floor texture and places the robot through `robotToPixel`, so
 * anything derived straight from a cell index has to be flipped to match. Without this the walls
 * stand mirrored front to back over their own floor - which the first version of this view did,
 * unnoticed, because 3 468 boxes of gravel covered the whole floor anyway and this flat's outline
 * is roughly symmetric.
 *
 * @param height Grid height in cells.
 * @param segment A run in grid rows.
 * @returns The same run in picture rows.
 */
function flipRow(height: number, segment: WallSegment): WallSegment {
	return { x0: segment.x0, x1: segment.x1, y0: height - 1 - segment.y1, y1: height - 1 - segment.y0 };
}

/** Reads `[x, y]` in millimetres out of a published position, or null. */
function readPointMm(value: unknown): CellPoint | null {
	if (!Array.isArray(value) || value.length < 2) return null;
	const x = finite(value[0]);
	const y = finite(value[1]);
	return x === null || y === null ? null : { x, y };
}

/**
 * The four corners of every piece of furniture, in millimetres.
 *
 * `MapParser.getFurnitures` publishes them as `{x1, y1, … x4, y4, type, subType, …}` with the
 * corners in robot coordinates (`src/lib/map/v1/types.ts:20-27`). Only the corners are needed here:
 * the piece is blanked out by its bounding rectangle, so its rotation does not matter.
 */
function readFurnitureCorners(value: unknown): CellPoint[][] {
	if (!Array.isArray(value)) return [];
	const out: CellPoint[][] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const piece = raw as Record<string, unknown>;
		const corners: CellPoint[] = [];
		for (const n of [1, 2, 3, 4]) {
			const x = finite(piece[`x${n}`]);
			const y = finite(piece[`y${n}`]);
			if (x !== null && y !== null) corners.push({ x, y });
		}
		if (corners.length > 0) out.push(corners);
	}
	return out;
}

/**
 * Positions of the detected objects, in millimetres.
 *
 * `MapParser.extractObstacles` publishes each one as an array whose first two entries are the
 * coordinates (`src/lib/map/v1/MapParser.ts:608-620`). Both `OBSTACLES` and `OBSTACLES2` are read:
 * the app takes its list from block 13, the test device sends its objects in block 15, and the two
 * have the same shape.
 */
function readObjectPositions(value: unknown): CellPoint[] {
	if (!Array.isArray(value)) return [];
	const out: CellPoint[] = [];
	for (const raw of value) {
		const point = readPointMm(raw);
		if (point) out.push(point);
	}
	return out;
}

/** Keeps the entries of a published cell list that can actually name a cell of the grid. */
function cellIndices(value: unknown, limit: number): number[] {
	if (!Array.isArray(value)) return [];
	const out: number[] = [];
	for (const raw of value) {
		const index = Number(raw);
		if (Number.isInteger(index) && index >= 0 && index < limit) out.push(index);
	}
	return out;
}

/** Turns a cell index into its coordinates in the grid. */
export function cellOf(index: number, width: number): CellPoint {
	return { x: index % width, y: Math.floor(index / width) };
}
