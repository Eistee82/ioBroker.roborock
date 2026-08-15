/**
 * The segment raster of a V1 map: one byte per grid cell, and the run-length coding that carries
 * it from the adapter to the admin tab.
 *
 * ## Why this exists
 *
 * `MapParser` already publishes three derived views of the image block - `pixels.floor`,
 * `pixels.obstacle` and `pixels.segments`. None of them is enough to divide a room, because
 * `pixels.obstacle` drops the segment id: it stores a bare cell index, while the raster byte holds
 * the id in its upper five bits for wall cells too. On the reference device that is not a corner
 * case - of 3468 wall cells, 3467 belong to a segment (measured on
 * `_appanalysis/backups/backup-20260814-185206/karte-0-roh.bin`), and the app's dividing-line
 * search walks exactly those cells to find the room boundary
 * (`_appanalysis/28-raeume-teilen.md` §2.3).
 *
 * So the raster is published as it comes off the wire, and every reader derives what it needs.
 *
 * ## Why run-length and not gzip
 *
 * Measured on the map above (427 x 365 = 155 855 cells, 3851 runs):
 *
 * | representation                           | size     |
 * |------------------------------------------|----------|
 * | `pixels.*` as published today            | 472 KiB  |
 * | raster, run-length coded as below        |  23 KiB  |
 * | raster, gzip + base64                    |   4 KiB  |
 *
 * gzip is smaller, but it buys 19 KiB on a payload that is already 472 KiB - a 4 % cut of the
 * wrong number - and costs an asynchronous `DecompressionStream` in the browser or a new
 * dependency in the tab. Run-length coding is a dozen lines that run unchanged on both sides,
 * synchronously, and can be read by a human looking at the state. The cut worth taking is a
 * different one: publishing *only* the raster and deriving `pixels.*` from it in the four places
 * that read them would turn 472 KiB into about 5 KiB. That touches working drawing code and is
 * deliberately not done here.
 */

/**
 * Edge length of one grid cell in millimetres.
 *
 * The constant the whole V1 map format is built on: `x_mm = 50 * (left + column)` and
 * `y_mm = 50 * (top + row)`, with no flip between raster row and robot y
 * (`_appanalysis/28-raeume-teilen.md` §4.2).
 */
export const CELL_EDGE_MM = 50;

/** Area of one grid cell in square metres - `(50 / 1000)²`. */
export const SQUARE_METRES_PER_CELL = (CELL_EDGE_MM / 1000) * (CELL_EDGE_MM / 1000);

/** Mask selecting the cell type from a raster byte. */
export const RASTER_TYPE_MASK = 0x07;

/** Cell type of a cell outside the mapped area. Carries no segment. */
export const RASTER_TYPE_EMPTY = 0;

/** Cell type of a wall or other obstacle. Carries a segment id like a floor cell does. */
export const RASTER_TYPE_WALL = 1;

/**
 * How many cells a raster may hold.
 *
 * A raster larger than this would not be a floor plan. The limit only exists so that a malformed
 * state cannot make the decoder allocate without bound.
 */
const MAX_RASTER_CELLS = 8_000_000;

/**
 * Ceiling on the coded size, in numbers, above which the raster is not published at all.
 *
 * A floor plan codes to very little - the reference device's 155 855 cells become 3851 runs, so
 * 7702 numbers, about 23 KiB of the map state. The ceiling is four times that: high enough that no
 * real map can reach it, low enough that a grid with no run structure at all - which would code to
 * two numbers per cell, megabytes of it - is dropped instead of written into an ioBroker state.
 *
 * Dropping costs the admin tab its dividing tool on that one map. Every other reader works off the
 * `pixels` lists and does not notice.
 */
export const MAX_RASTER_RUN_VALUES = 32_768;

/**
 * The segment raster of one map, run-length coded.
 *
 * Published under `IMAGE.raster`. Optional throughout: B01/Q10 maps have no such block, and a
 * `mapData` state written by an older adapter version does not carry the field either.
 */
export interface SegmentRaster {
	/**
	 * Coding of {@link runs}. Only `"rle"` exists today; the field is here so that a later change
	 * of coding is something a reader can detect rather than misread.
	 */
	encoding: "rle";
	/** Cells per row - the same number as `IMAGE.dimensions.width`, repeated so the raster stands on its own. */
	width: number;
	/** Rows - the same number as `IMAGE.dimensions.height`. */
	height: number;
	/**
	 * Alternating cell value and run length: `[value, count, value, count, ...]`.
	 * The run lengths add up to `width * height`.
	 */
	runs: number[];
}

/** The segment id a raster byte carries, in its upper five bits. 0 means "no segment". */
export function rasterSegmentId(cell: number): number {
	return cell >>> 3;
}

/** The cell type a raster byte carries, in its lower three bits. See `RASTER_TYPE_*`. */
export function rasterCellType(cell: number): number {
	return cell & RASTER_TYPE_MASK;
}

/**
 * Run-length codes a raster.
 * @param cells One byte per grid cell, row-major, starting at the top-left of the image block.
 * @returns Alternating value and run length.
 */
export function encodeRasterRuns(cells: Uint8Array): number[] {
	const runs: number[] = [];
	let i = 0;
	while (i < cells.length) {
		const value = cells[i];
		let run = 1;
		while (i + run < cells.length && cells[i + run] === value) run++;
		runs.push(value, run);
		i += run;
	}
	return runs;
}

/**
 * Rebuilds a raster from its run-length coding.
 *
 * Deliberately strict: the input is an ioBroker state, so it can be anything at all, and a raster
 * that is silently half right would place a dividing line in the wrong room. Every way of being
 * wrong returns `null` instead.
 * @param raster The published raster, or anything claiming to be one.
 * @param expectedCells How many cells the caller expects, i.e. `width * height` of the image block.
 * @returns One byte per cell, or `null` if the input does not describe exactly that many cells.
 */
export function decodeRasterRuns(raster: SegmentRaster | undefined | null, expectedCells: number): Uint8Array | null {
	if (!raster || raster.encoding !== "rle" || !Array.isArray(raster.runs)) return null;
	if (!Number.isInteger(expectedCells) || expectedCells <= 0 || expectedCells > MAX_RASTER_CELLS) return null;
	if (raster.runs.length % 2 !== 0) return null;

	const cells = new Uint8Array(expectedCells);
	let written = 0;

	for (let i = 0; i < raster.runs.length; i += 2) {
		const value = raster.runs[i];
		const run = raster.runs[i + 1];
		if (!Number.isInteger(value) || value < 0 || value > 255) return null;
		if (!Number.isInteger(run) || run <= 0) return null;
		if (written + run > expectedCells) return null;
		if (value !== 0) cells.fill(value, written, written + run);
		written += run;
	}

	return written === expectedCells ? cells : null;
}

/**
 * Reads one cell, with the bounds check the app's own scan does without.
 *
 * The app indexes its raster unchecked (`_appanalysis/28-raeume-teilen.md` §2.1) and gets away with
 * it because JavaScript answers `undefined` for a read past the end. A typed array does not - it
 * would answer the first cell of the next row for `x === width`, and the dividing line would snap
 * to a wall on the opposite side of the map.
 * @returns The raster byte, or 0 (empty) for any position outside the grid.
 */
export function rasterCellAt(cells: Uint8Array, width: number, height: number, x: number, y: number): number {
	const col = Math.floor(x);
	const row = Math.floor(y);
	if (col < 0 || col >= width || row < 0 || row >= height) return RASTER_TYPE_EMPTY;
	return cells[row * width + col];
}
