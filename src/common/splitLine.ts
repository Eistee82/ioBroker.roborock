/**
 * Where a dividing line may run, and where its ends belong.
 *
 * This is the Roborock app's own algorithm, rebuilt from `_appanalysis/28-raeume-teilen.md` §2.
 * The user does not draw the line - the app puts one across the room and the user moves it. After
 * every move the two ends are pulled back onto the room's boundary, and it is that snapped line,
 * not the dragged one, that `split_segment` is given.
 *
 * ## Everything here is in raster cells
 *
 * Columns and rows of the image block, `x` to the right and `y` **downwards through the array** -
 * which is also the direction the robot's y axis grows in. There is no flip anywhere in this file,
 * and the one place a rebuild would be tempted to add one is answered in §4.2 of the report: the
 * `top + height - y` in the app's own code undoes a conversion into screen space that it made two
 * steps earlier. Working in raster cells throughout, that conversion never happens, so nothing has
 * to be undone. {@link splitPayload} is the only place millimetres appear.
 *
 * ## One line where the app has two
 *
 * The app builds the same line twice - once in screen space to interpolate the free coordinate of
 * an end point, once in raster space to walk the grid (§2.2). It needs both because its handles
 * live in screen space. The two spaces differ by an axis-aligned affine map, under which a line
 * stays a line and a point on it stays on it, so a rebuild that never leaves raster space needs
 * one. Same result, half the arithmetic.
 */

import { RASTER_TYPE_EMPTY, RASTER_TYPE_WALL, rasterCellAt, rasterCellType, rasterSegmentId } from "./segmentRaster";

/** A position on the grid. Whole numbers are cell centres; the scan produces fractional values. */
export interface RasterPoint {
	x: number;
	y: number;
}

/** The grid plus the two numbers needed to read it. */
export interface RasterView {
	cells: Uint8Array;
	width: number;
	height: number;
}

/**
 * Outcome of pulling a dragged line back onto the room's boundary.
 *
 * The three cases are the app's three, and each one has a message of its own (§3.1):
 *
 * * `ok` - a line the robot can be given.
 * * `adjust` - an end sits *inside* the room, so there is no boundary to snap it to on that side.
 *   `map_edit_split_restriction_point_adjust`, "adjust the line until a solid one appears".
 * * `outside` - the line never touches the room. `map_edit_split_restriction_point_illegal`.
 */
export type SplitLineResult =
	| { status: "ok"; left: RasterPoint; right: RasterPoint }
	| { status: "adjust" }
	| { status: "outside" };

/** Which coordinate the scan steps through; the other one is read off the line. */
type ScanAxis = "x" | "y";

/** A straight line through the grid, as the coordinate that is stepped and the one derived from it. */
interface ScanLine {
	axis: ScanAxis;
	/** Derived coordinate at `t` along {@link axis}. */
	at: (t: number) => number;
}

/**
 * Builds the line through two points, stepping whichever axis it advances along faster.
 *
 * The app decides the same thing by testing `Math.abs(A) === 1` on its own line encoding, which
 * comes out as "step x while the slope is under 1, step y otherwise" - ties, i.e. a line at exactly
 * 45°, go to the y branch (§2.2). Stepping the faster axis is what keeps the scan from skipping
 * cells: along the slower one it would jump over whole rows.
 */
function scanLineThrough(a: RasterPoint, b: RasterPoint): ScanLine {
	const dx = b.x - a.x;
	const dy = b.y - a.y;

	if (Math.abs(dy) < Math.abs(dx)) {
		const slope = dy / dx;
		return { axis: "x", at: (t) => a.y + slope * (t - a.x) };
	}
	if (dy === 0) {
		// Both deltas zero: the two ends coincide. `splitLineEndpointValid` rejects that anyway, and
		// a constant line keeps the scan from producing NaN before it gets there.
		return { axis: "y", at: () => a.x };
	}
	const inverseSlope = dx / dy;
	return { axis: "y", at: (t) => a.x + inverseSlope * (t - a.y) };
}

/** Reads the cell the line passes through at `t`. */
function cellOnLine(view: RasterView, line: ScanLine, t: number): number {
	const derived = Math.floor(line.at(t));
	return line.axis === "x" ? rasterCellAt(view.cells, view.width, view.height, t, derived) : rasterCellAt(view.cells, view.width, view.height, derived, t);
}

/** The point the line passes through at `t`, with the stepped coordinate whole and the other exact. */
function pointOnLine(line: ScanLine, t: number): RasterPoint {
	return line.axis === "x" ? { x: t, y: line.at(t) } : { x: line.at(t), y: t };
}

/** Whether a cell belongs to the room and is not empty - floor or wall, either counts. */
function belongsToRoom(cell: number, blockId: number): boolean {
	return rasterSegmentId(cell) === blockId && rasterCellType(cell) !== RASTER_TYPE_EMPTY;
}

/** Whether a cell is a wall **of this room**. A wall of the neighbouring room ends the scan. */
function isWallOfRoom(cell: number, blockId: number): boolean {
	return rasterSegmentId(cell) === blockId && rasterCellType(cell) === RASTER_TYPE_WALL;
}

/**
 * Whether every orthogonal neighbour is floor of the same room, i.e. the cell is deep inside it.
 *
 * The app's `a()` (§2.1). **One deliberate difference:** the app answers "yes" when the cell has no
 * in-bounds neighbours at all, because it compares a count against the length of an empty list. On
 * a real map that cannot happen - a raster small enough for it holds no room - but "no neighbours"
 * reading as "surrounded by room" is the wrong answer to have written down.
 */
function surroundedByRoom(view: RasterView, blockId: number, x: number, y: number): boolean {
	const neighbours = [
		[x - 1, y],
		[x, y - 1],
		[x + 1, y],
		[x, y + 1],
	].filter(([nx, ny]) => nx >= 0 && nx < view.width && ny >= 0 && ny < view.height);

	if (neighbours.length === 0) return false;
	return neighbours.every(([nx, ny]) => {
		const cell = rasterCellAt(view.cells, view.width, view.height, nx, ny);
		return rasterSegmentId(cell) === blockId && rasterCellType(cell) > RASTER_TYPE_WALL;
	});
}

/** What one end of the scan produced. */
type EndResult = { kind: "found"; point: RasterPoint } | { kind: "adjust" } | { kind: "missing" };

/**
 * Walks inward from one end of the dragged line until it reaches the room's boundary.
 *
 * The app's inner loop (§2.3). Starting at the outer end and stepping towards the middle:
 *
 * 1. Cells that are not this room's are passed over.
 * 2. The very first cell tested is special. If it already belongs to the room, the end sits inside
 *    the room rather than outside it, and there is nothing to snap to - the user has to pull that
 *    handle out. Which of the two tests decides that depends on what the cell is: for a wall,
 *    whether it is ringed by this room's floor; for a floor cell, whether the room continues one
 *    step further out.
 * 3. Otherwise the first cell of the room ends the walk - except that a wall of this room is
 *    stepped over as long as the next cell inward is also one, so that a thick wall does not leave
 *    the end buried in it.
 * @param view The grid.
 * @param blockId Room being divided.
 * @param line The dragged line.
 * @param from Where to start, in the stepped coordinate - the outer end.
 * @param to Where to stop, exclusive - the far end.
 * @param step `-1` when walking down from the larger end, `+1` when walking up from the smaller.
 */
function scanToBoundary(view: RasterView, blockId: number, line: ScanLine, from: number, to: number, step: -1 | 1): EndResult {
	const limit = line.axis === "x" ? view.width : view.height;

	for (let i = 0; i < limit; i++) {
		const t = from + i * step;
		if (step === -1 ? t <= to : t >= to) break;

		const cell = cellOnLine(view, line, t);
		if (!belongsToRoom(cell, blockId)) continue;

		if (i === 0) {
			const point = pointOnLine(line, t);
			const inside = rasterCellType(cell) === RASTER_TYPE_WALL
				? surroundedByRoom(view, blockId, Math.floor(point.x), Math.floor(point.y))
				: belongsToRoom(cellOnLine(view, line, from - step), blockId);
			if (inside) return { kind: "adjust" };
		}

		if (rasterCellType(cell) === RASTER_TYPE_WALL && isWallOfRoom(cellOnLine(view, line, t + step), blockId)) continue;

		return { kind: "found", point: pointOnLine(line, t) };
	}

	return { kind: "missing" };
}

/**
 * Pulls both ends of a dragged line back onto the boundary of the room being divided.
 * @param view The grid.
 * @param blockId Room being divided.
 * @param a One end of the dragged line, in raster cells.
 * @param b The other end.
 * @returns The snapped line, or which of the app's two refusals applies.
 */
export function snapSplitLine(view: RasterView, blockId: number, a: RasterPoint, b: RasterPoint): SplitLineResult {
	if (view.cells.length !== view.width * view.height || view.cells.length === 0) return { status: "outside" };

	const line = scanLineThrough(a, b);
	const from = line.axis === "x" ? a.x : a.y;
	const to = line.axis === "x" ? b.x : b.y;
	const high = Math.max(from, to);
	const low = Math.min(from, to);

	const fromHigh = scanToBoundary(view, blockId, line, high, low, -1);
	const fromLow = scanToBoundary(view, blockId, line, low, high, 1);

	// An end inside the room is reported as such even when the other end never found the room at
	// all: "pull this handle out" is the more useful of the two messages, and it is the one the app
	// shows too - its validity check tests the adjust flags before anything else.
	if (fromHigh.kind === "adjust" || fromLow.kind === "adjust") return { status: "adjust" };
	if (fromHigh.kind !== "found" || fromLow.kind !== "found") return { status: "outside" };

	// The app's last condition: two ends that landed on the same cell are not a line.
	if (fromHigh.point.x === fromLow.point.x && fromHigh.point.y === fromLow.point.y) return { status: "outside" };

	return { status: "ok", left: fromHigh.point, right: fromLow.point };
}

/**
 * Puts a line across the room, the way the app does when a room is first selected.
 *
 * `getTouchEdge` (§1.4): probe the column and the row through the given point, and lay the line
 * across whichever direction the room is *shorter* in - a tall room gets a horizontal line, a wide
 * one a vertical line. That is a starting offer, not a decision; the user moves it.
 *
 * **One deliberate difference from the app:** its column probe masks the cell type with `& 7` and
 * its row probe with `& 255` (A65:525260 against A65:525313). The second is a slip - it lets a cell
 * of type 0 count as long as its byte is not zero - and reproducing it would only make the starting
 * line's direction depend on a rounding of Roborock's. Both probes mask with `& 7` here.
 * @param view The grid.
 * @param blockId Room being divided.
 * @param through A point inside the room - where the user clicked, or the centre of the room.
 * @returns The two ends of the starting line, or `null` when the room is not on that row or column.
 */
export function startingSplitLine(view: RasterView, blockId: number, through: RasterPoint): { left: RasterPoint; right: RasterPoint } | null {
	const column = Math.floor(through.x);
	const row = Math.floor(through.y);
	if (column < 0 || column >= view.width || row < 0 || row >= view.height) return null;

	let minRow = Number.POSITIVE_INFINITY;
	let maxRow = Number.NEGATIVE_INFINITY;
	for (let y = 0; y < view.height; y++) {
		if (belongsToRoom(rasterCellAt(view.cells, view.width, view.height, column, y), blockId)) {
			minRow = Math.min(minRow, y);
			maxRow = Math.max(maxRow, y);
		}
	}

	let minColumn = Number.POSITIVE_INFINITY;
	let maxColumn = Number.NEGATIVE_INFINITY;
	for (let x = 0; x < view.width; x++) {
		if (belongsToRoom(rasterCellAt(view.cells, view.width, view.height, x, row), blockId)) {
			minColumn = Math.min(minColumn, x);
			maxColumn = Math.max(maxColumn, x);
		}
	}

	const verticalExtent = maxRow - minRow;
	const horizontalExtent = maxColumn - minColumn;
	if (!Number.isFinite(verticalExtent) && !Number.isFinite(horizontalExtent)) return null;

	if (verticalExtent > horizontalExtent) {
		return { left: { x: minColumn, y: row }, right: { x: maxColumn, y: row } };
	}
	return { left: { x: column, y: minRow }, right: { x: column, y: maxRow } };
}

/**
 * Turns a snapped line into the five numbers `split_segment` takes.
 *
 * `x_mm = 50 * (left + column)`, `y_mm = 50 * (top + row)`, both rounded to whole cells - the
 * formula the whole map uses, derived for this call in §4.1 and cross-checked against `MapParser`.
 *
 * **Off by up to one cell from the app on the y axis, on purpose.** The app reaches the same
 * millimetres through screen space and back, and its rounding lands half a cell out in y (§4.3);
 * reproducing that would mean asserting an artefact whose size depends on a value the bundle does
 * not prove is whole. Both ends get the same treatment either way, so the line's direction is
 * untouched and only its extent moves by 50 mm - well inside the wall it was snapped to.
 * @param blockId Room being divided.
 * @param left One end, in raster cells.
 * @param right The other end.
 * @param position `IMAGE.position` of the map the raster came from.
 * @returns `[segmentId, x1, y1, x2, y2]`, millimetres.
 */
export function splitPayload(blockId: number, left: RasterPoint, right: RasterPoint, position: { left: number; top: number }): number[] {
	const CELL_MM = 50;
	return [
		blockId,
		CELL_MM * Math.round(position.left + left.x),
		CELL_MM * Math.round(position.top + left.y),
		CELL_MM * Math.round(position.left + right.x),
		CELL_MM * Math.round(position.top + right.y),
	];
}
