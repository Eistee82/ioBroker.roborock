import { describe, expect, it } from "vitest";
import type { SegmentRaster } from "./segmentRaster";
import {
	decodeRasterRuns,
	encodeRasterRuns,
	rasterCellAt,
	rasterCellType,
	rasterSegmentId,
	RASTER_TYPE_EMPTY,
	RASTER_TYPE_WALL,
} from "./segmentRaster";

/**
 * The raster is the one piece of map data the dividing tool cannot get wrong quietly: a decoder
 * that disagrees with the encoder by a single cell shifts every following row, and the dividing
 * line lands in the wrong room while still looking plausible on screen. So the round trip is
 * tested exhaustively rather than by example, and every malformed input is required to be refused
 * rather than half-read.
 */

/** Builds a raster of `width * height` cells from a generator, as the parser would hand it over. */
function raster(width: number, height: number, cell: (x: number, y: number) => number): Uint8Array {
	const cells = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells[y * width + x] = cell(x, y);
	return cells;
}

/** Wraps coded runs the way `MapParser` publishes them. */
function coded(runs: number[], width: number, height: number): SegmentRaster {
	return { encoding: "rle", width, height, runs };
}

describe("segment raster cell layout", () => {
	it("splits a cell into the segment id and the cell type the robot packs into it", () => {
		// Segment 16, floor: 16 << 3 | 7. Taken from a real a65 map, where floor cells are type 7.
		const floorOfRoom16 = (16 << 3) | 7;
		expect(rasterSegmentId(floorOfRoom16)).toBe(16);
		expect(rasterCellType(floorOfRoom16)).toBe(7);

		// A wall carries a segment id too - that is the whole reason the raster is published.
		const wallOfRoom16 = (16 << 3) | RASTER_TYPE_WALL;
		expect(rasterSegmentId(wallOfRoom16)).toBe(16);
		expect(rasterCellType(wallOfRoom16)).toBe(RASTER_TYPE_WALL);

		expect(rasterCellType(0)).toBe(RASTER_TYPE_EMPTY);
		expect(rasterSegmentId(0)).toBe(0);

		// The highest id the five bits can hold. `MAX_BLOCK_NO` in the app is 32, so this is the
		// ceiling the wire format itself imposes.
		expect(rasterSegmentId(31 << 3)).toBe(31);
	});
});

describe("run-length coding", () => {
	it("survives a round trip for every raster in a systematic sweep", () => {
		const shapes: Array<[number, number]> = [[1, 1], [1, 7], [7, 1], [3, 5], [16, 9], [64, 32]];
		const patterns: Array<(x: number, y: number) => number> = [
			() => 0, // nothing mapped at all
			() => (16 << 3) | 7, // one room, no walls
			(x) => (x % 2 === 0 ? 0 : (17 << 3) | 1), // alternating, the worst case for the coding
			(x, y) => ((((x * 7 + y * 13) % 32) << 3) | ((x + y) % 8)), // no structure whatsoever
			(x, y) => (x < 3 || y < 3 ? 0 : (18 << 3) | 7), // a room in a corner
		];

		for (const [width, height] of shapes) {
			for (const pattern of patterns) {
				const cells = raster(width, height, pattern);
				const back = decodeRasterRuns(coded(encodeRasterRuns(cells), width, height), width * height);
				expect(back, `${width}x${height}`).not.toBeNull();
				expect(Array.from(back!), `${width}x${height}`).toEqual(Array.from(cells));
			}
		}
	});

	it("codes a run of equal cells as a single pair", () => {
		expect(encodeRasterRuns(new Uint8Array([5, 5, 5, 5]))).toEqual([5, 4]);
		expect(encodeRasterRuns(new Uint8Array([5, 5, 7, 5]))).toEqual([5, 2, 7, 1, 5, 1]);
		expect(encodeRasterRuns(new Uint8Array(0))).toEqual([]);
	});

	it("compresses a floor plan by two orders of magnitude", () => {
		// A room with walls, of the proportions the reference device produces. The point of the
		// coding is that a floor plan is made of long runs; if that ever stopped holding, the size
		// guard in `MapParser.buildSegmentRaster` would start dropping the raster instead.
		const width = 200;
		const height = 150;
		const cells = raster(width, height, (x, y) => {
			const inside = x > 10 && x < 190 && y > 10 && y < 140;
			const onWall = inside && (x === 11 || x === 189 || y === 11 || y === 139);
			if (!inside) return 0;
			return onWall ? (16 << 3) | RASTER_TYPE_WALL : (16 << 3) | 7;
		});
		const runs = encodeRasterRuns(cells);
		expect(runs.length / 2).toBeLessThan(cells.length / 50);
	});
});

describe("decoding a raster that came out of a state", () => {
	const width = 4;
	const height = 2;
	const cells = width * height;

	it("refuses runs that do not add up to the expected cell count", () => {
		expect(decodeRasterRuns(coded([7, 7], width, height), cells)).toBeNull(); // one short
		expect(decodeRasterRuns(coded([7, 9], width, height), cells)).toBeNull(); // one too many
		expect(decodeRasterRuns(coded([], width, height), cells)).toBeNull();
	});

	it("refuses a malformed run list rather than reading half of it", () => {
		expect(decodeRasterRuns(coded([7, 4, 3], width, height), cells)).toBeNull(); // odd length
		expect(decodeRasterRuns(coded([7, 0, 3, 8], width, height), cells)).toBeNull(); // empty run
		expect(decodeRasterRuns(coded([7, -8], width, height), cells)).toBeNull(); // negative run
		expect(decodeRasterRuns(coded([7, 4.5, 3, 3.5], width, height), cells)).toBeNull(); // fractional
		expect(decodeRasterRuns(coded([256, 8], width, height), cells)).toBeNull(); // not a byte
		expect(decodeRasterRuns(coded([-1, 8], width, height), cells)).toBeNull(); // not a byte
	});

	it("refuses anything that is not a raster of the coding it claims", () => {
		expect(decodeRasterRuns(undefined, cells)).toBeNull();
		expect(decodeRasterRuns(null, cells)).toBeNull();
		expect(decodeRasterRuns({ encoding: "gzip", width, height, runs: [7, 8] } as unknown as SegmentRaster, cells)).toBeNull();
		expect(decodeRasterRuns({ encoding: "rle", width, height } as unknown as SegmentRaster, cells)).toBeNull();
		expect(decodeRasterRuns({ encoding: "rle", width, height, runs: "7,8" } as unknown as SegmentRaster, cells)).toBeNull();
	});

	it("refuses a cell count that would have it allocate without bound", () => {
		expect(decodeRasterRuns(coded([7, 8], width, height), 0)).toBeNull();
		expect(decodeRasterRuns(coded([7, 8], width, height), -1)).toBeNull();
		expect(decodeRasterRuns(coded([7, 8], width, height), 9_000_000)).toBeNull();
	});
});

describe("reading a single cell", () => {
	const width = 3;
	const height = 2;
	// 0 1 2
	// 3 4 5
	const cells = new Uint8Array([0, 1, 2, 3, 4, 5]);

	it("reads row-major, the way the image block is laid out", () => {
		expect(rasterCellAt(cells, width, height, 0, 0)).toBe(0);
		expect(rasterCellAt(cells, width, height, 2, 0)).toBe(2);
		expect(rasterCellAt(cells, width, height, 0, 1)).toBe(3);
		expect(rasterCellAt(cells, width, height, 2, 1)).toBe(5);
	});

	it("floors a fractional position instead of rounding it", () => {
		expect(rasterCellAt(cells, width, height, 2.9, 1.9)).toBe(5);
	});

	it("answers empty past the edge instead of wrapping into the next row", () => {
		// The failure this prevents: `x === width` on row 0 would otherwise read cell 3, the first
		// cell of row 1, and a dividing line would snap to a wall on the far side of the map.
		expect(rasterCellAt(cells, width, height, 3, 0)).toBe(RASTER_TYPE_EMPTY);
		expect(rasterCellAt(cells, width, height, -1, 0)).toBe(RASTER_TYPE_EMPTY);
		expect(rasterCellAt(cells, width, height, 0, 2)).toBe(RASTER_TYPE_EMPTY);
		expect(rasterCellAt(cells, width, height, 0, -1)).toBe(RASTER_TYPE_EMPTY);
	});
});
