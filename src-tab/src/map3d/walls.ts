/**
 * Turns occupied cells into wall segments, the way the app does it.
 *
 * ## Why this exists
 *
 * The first version of the 3D view extruded **one box per occupied cell** - 3 468 of them on the
 * test device. It is geometrically correct and looks wrong: the map fills with gravel, and the
 * rooms disappear behind speckle that the 2D view renders as a thin grey line.
 *
 * The app does something else, and it is readable. `getCleanUpedWalls`
 * (`_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js:565322-565920`, the
 * function whose result lands in `Map.cleanedWalls`, A65:557407-557502) runs three passes over the
 * same occupancy the adapter already publishes:
 *
 * 1. **Group** the occupied cells into 4-connected chains - a flood fill, A65:565565-565700.
 * 2. **Drop** every chain that never touches unknown space. A chain is kept only if one of its
 *    cells has a neighbour that is outside the map rectangle or has cell type 0
 *    (A65:565748-565991). That is what removes the speckle in the middle of a room and leaves the
 *    outlines - of the rooms, and of the holes inside them.
 * 3. **Merge** each surviving chain into maximal straight runs, horizontal or vertical, whichever
 *    is longer at each seed cell (A65:564834-565039). One run becomes one wall.
 *
 * Measured on the test device's own raw map
 * (`_appanalysis/backups/backup-20260814-185206/karte-0-roh.bin`, 232 x 231 cells after the app's
 * own trim): **3 468 cells -> 116 chains -> 27 kept -> 541 wall segments.** The 89 discarded chains
 * account for 336 cells.
 *
 * ## The one branch that is deliberately not reproduced
 *
 * The app's cell test is not only `type === 1`. It also consults a second plane,
 * `getMapProps(carpetMap, index) = (carpetMap.data[index] >> 3) & 3` (A65:545037-545078, second
 * argument bound at A65:556607): a cell counts as wall when that value is 1, and a neighbour counts
 * as open when it is 2.
 *
 * On the test device that branch can never fire: the whole `CARPET_MAP` block is bytes 0 and 1, so
 * `(byte >> 3) & 3` is 0 everywhere and both tests fall through to the image byte. Measured, not
 * assumed - the same script reports `groesster Wert 1`. A device whose carpet plane uses the upper
 * bits would draw slightly different walls in the app than here; that is a known and named gap, not
 * an oversight.
 */

/** A straight, axis-aligned run of wall cells. Both ends are inclusive. */
export interface WallSegment {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** What {@link extractWalls} was given and what it made of it. */
export interface WallExtraction {
	segments: WallSegment[];
	/** Occupied cells that went in. Reported so the caller can say how much was saved. */
	cellCount: number;
	/** Chains found before the filter. */
	chainCount: number;
	/** Chains that survived the filter. */
	keptCount: number;
}

/** Cell type of an unmapped cell, the app's `(byte & 7) === 0`. */
const TYPE_VOID = 0;
const TYPE_WALL = 1;
/**
 * A cell that was cleared before the grouping started.
 *
 * The app overwrites those cells with the value 7 (A65:565344-565550), which is neither its wall
 * test (`& 7 === 1`) nor its open test (`& 7 === 0`). So a cleared cell is not a wall, and it does
 * not count as the unmapped space that lets a neighbouring chain be drawn either. Both halves
 * matter, and a naive "just remove it from the obstacle list" would get the second one wrong.
 */
const TYPE_CLEARED = 3;

/**
 * Extracts wall segments from the published cell lists.
 *
 * Both lists are cell indices into a `width * height` grid, exactly as
 * `MapParser.parseImageBlock` publishes them (`src/lib/map/v1/MapParser.ts:517-547`): `obstacle`
 * for cell type 1, `floor` for everything that is neither 0 nor 1. Whatever is in neither list is
 * unmapped - that is the app's type 0, and the thing a wall has to touch to be drawn.
 *
 * @param width Grid width in cells.
 * @param height Grid height in cells.
 * @param obstacles Indices of occupied cells.
 * @param floor Indices of mapped, walkable cells.
 * @param cleared Cells to blank out first - furniture, dock and detected objects. See
 *   {@link TYPE_CLEARED}.
 * @returns The segments, plus the counts the caller may want to report.
 */
export function extractWalls(
	width: number,
	height: number,
	obstacles: readonly number[],
	floor: readonly number[],
	cleared: readonly number[] = []
): WallExtraction {
	const size = width * height;
	if (size <= 0) return { segments: [], cellCount: 0, chainCount: 0, keptCount: 0 };

	// One byte per cell: 0 unmapped, 1 wall, 2 floor, 3 cleared. Mirrors what the app reads out of
	// the image block, without needing the raw bytes here.
	const type = new Uint8Array(size);
	for (const index of floor) if (index >= 0 && index < size) type[index] = 2;
	for (const index of obstacles) if (index >= 0 && index < size) type[index] = TYPE_WALL;
	// Last, so it wins over both - the app stamps its 7 over whatever the image byte said.
	for (const index of cleared) if (index >= 0 && index < size) type[index] = TYPE_CLEARED;

	let cellCount = 0;
	for (let i = 0; i < size; i++) if (type[i] === TYPE_WALL) cellCount++;
	if (cellCount === 0) return { segments: [], cellCount: 0, chainCount: 0, keptCount: 0 };

	// --- Pass 1: 4-connected chains ---------------------------------------------------------------
	//
	// The queue is an array with a read cursor rather than `shift()`. On the test map that is 3 468
	// cells; `shift()` would copy the rest of the array each time.
	// Rows are scanned from the bottom up, as the app does (A65:565565, `for y = height-1 … 0`).
	// The set of chains does not depend on the order, but the seed cell of each straight run does,
	// and with it how a corner is split. Following the app costs nothing and removes a difference
	// that would otherwise have to be explained every time the two pictures are compared.
	const seen = new Uint8Array(size);
	const chains: number[][] = [];
	for (let cell = 0; cell < size; cell++) {
		const start = (height - 1 - Math.floor(cell / width)) * width + (cell % width);
		if (type[start] !== TYPE_WALL || seen[start]) continue;
		seen[start] = 1;
		const chain: number[] = [start];
		for (let cursor = 0; cursor < chain.length; cursor++) {
			const index = chain[cursor];
			const x = index % width;
			const y = (index - x) / width;
			// Left, right, down, up - the app's order (A65:565043-565060). Only the seeds of the
			// straight runs depend on it, but there is no reason to differ.
			const neighbours = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y < height - 1 ? index + width : -1, y > 0 ? index - width : -1];
			for (const next of neighbours) {
				if (next < 0 || type[next] !== TYPE_WALL || seen[next]) continue;
				seen[next] = 1;
				chain.push(next);
			}
		}
		chains.push(chain);
	}

	// --- Pass 2: keep only chains that touch unmapped space ---------------------------------------
	const kept = chains.filter((chain) => chain.length > 1 && touchesVoid(chain, width, height, type));

	// --- Pass 3: straight runs --------------------------------------------------------------------
	//
	// `member` marks the cells of the chain being worked on and is cleared again afterwards, so the
	// two full-grid arrays are allocated once instead of once per chain.
	const member = new Uint8Array(size);
	const used = new Uint8Array(size);
	const segments: WallSegment[] = [];
	for (const chain of kept) {
		for (const index of chain) member[index] = 1;
		collectRuns(chain, width, member, used, segments);
		for (const index of chain) {
			member[index] = 0;
			used[index] = 0;
		}
	}

	return { segments, cellCount, chainCount: chains.length, keptCount: kept.length };
}

/**
 * The cells the app blanks out before it looks for walls - the "cleanUped" in the function's name.
 *
 * Three sources, all read at A65:565344-565550, and all of them things the app draws as their own
 * object instead of as a wall:
 *
 * | What | Extent | Fundstelle |
 * | --- | --- | --- |
 * | Furniture | bounding rectangle **+ 1 cell** on every side | `getFurnitureIndexs(map, furnitures, 1)`, A65:565344-565350; the margin is the third argument, applied at A65:546484-546491 |
 * | The dock | **± 4 cells** around its position | A65:565340-565348 |
 * | Detected objects | **± 1 cell** around each | A65:565420-565550, position taken as `floor(mm / 50)` |
 *
 * Without this step the middle of a room fills with short stubs where the sofa, the shoes and the
 * cable stand - which is what the first look at the finished view showed, and precisely what the
 * app avoids here.
 *
 * All inputs are robot coordinates in millimetres, the unit the parse result carries
 * (`src/lib/map/v1/types.ts:21`). The conversion is `floor(mm / 50)` minus the grid offset, in the
 * grid's own row order - **not** through `robotMmToCell`, which additionally flips Y for the
 * drawing coordinate system and would blank out a mirror image of the furniture.
 *
 * @param width Grid width in cells.
 * @param height Grid height in cells.
 * @param left Grid offset in cells, `IMAGE.position.left`.
 * @param top Grid offset in cells, `IMAGE.position.top`.
 * @param sources What to blank out.
 * @returns Cell indices, possibly with repeats.
 */
export function clearedCells(
	width: number,
	height: number,
	left: number,
	top: number,
	sources: {
		/** Corner points in millimetres, four per piece. */
		furniture?: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>;
		/** Dock position in millimetres. */
		dock?: { x: number; y: number } | null;
		/** Detected objects, positions in millimetres. */
		objects?: ReadonlyArray<{ x: number; y: number }>;
	}
): number[] {
	const out: number[] = [];
	const cellX = (mm: number): number => Math.floor(mm / 50) - left;
	const cellY = (mm: number): number => Math.floor(mm / 50) - top;

	const rect = (x0: number, y0: number, x1: number, y1: number, margin: number): void => {
		const minX = Math.max(0, Math.min(x0, x1) - margin);
		const maxX = Math.min(width - 1, Math.max(x0, x1) + margin);
		const minY = Math.max(0, Math.min(y0, y1) - margin);
		const maxY = Math.min(height - 1, Math.max(y0, y1) + margin);
		for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) out.push(y * width + x);
	};

	for (const corners of sources.furniture ?? []) {
		if (corners.length === 0) continue;
		const xs = corners.map((corner) => cellX(corner.x));
		const ys = corners.map((corner) => cellY(corner.y));
		if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) continue;
		rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 1);
	}

	if (sources.dock && Number.isFinite(sources.dock.x) && Number.isFinite(sources.dock.y)) {
		const x = cellX(sources.dock.x);
		const y = cellY(sources.dock.y);
		rect(x, y, x, y, 4);
	}

	for (const object of sources.objects ?? []) {
		if (!Number.isFinite(object.x) || !Number.isFinite(object.y)) continue;
		const x = cellX(object.x);
		const y = cellY(object.y);
		rect(x, y, x, y, 1);
	}

	return out;
}

/** True when any cell of the chain borders the map edge or an unmapped cell. */
function touchesVoid(chain: readonly number[], width: number, height: number, type: Uint8Array): boolean {
	for (const index of chain) {
		const x = index % width;
		const y = (index - x) / width;
		if (x === 0 || x === width - 1 || y === 0 || y === height - 1) return true;
		if (type[index - 1] === TYPE_VOID) return true;
		if (type[index + 1] === TYPE_VOID) return true;
		if (type[index - width] === TYPE_VOID) return true;
		if (type[index + width] === TYPE_VOID) return true;
	}
	return false;
}

/**
 * Cuts one chain into straight runs.
 *
 * For each cell not yet consumed, this measures how far the chain continues left/right and up/down
 * without crossing a consumed cell, takes the longer of the two, marks that run consumed and emits
 * it. Same rule as A65:564983-564999, including the tie: equal lengths go to the horizontal run.
 */
function collectRuns(chain: readonly number[], width: number, member: Uint8Array, used: Uint8Array, out: WallSegment[]): void {
	const height = member.length / width;
	const free = (index: number): boolean => member[index] === 1 && used[index] === 0;

	for (const seed of chain) {
		if (used[seed]) continue;
		const x = seed % width;
		const y = (seed - x) / width;

		// The row bounds are checked explicitly: without them `index + 1` at the right edge would
		// walk into the first cell of the next row and produce a wall that wraps around the map.
		let left = x;
		while (left > 0 && free(y * width + left - 1)) left--;
		let right = x;
		while (right < width - 1 && free(y * width + right + 1)) right++;
		let up = y;
		while (up > 0 && free((up - 1) * width + x)) up--;
		let down = y;
		while (down < height - 1 && free((down + 1) * width + x)) down++;

		if (right - left >= down - up) {
			for (let i = left; i <= right; i++) used[y * width + i] = 1;
			out.push({ x0: left, y0: y, x1: right, y1: y });
		} else {
			for (let i = up; i <= down; i++) used[i * width + x] = 1;
			out.push({ x0: x, y0: up, x1: x, y1: down });
		}
	}
}
