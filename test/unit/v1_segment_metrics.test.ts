import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { MapParser } from "../../src/lib/map/v1/MapParser";
import { decodeRasterRuns, rasterCellType, rasterSegmentId } from "../../src/common/segmentRaster";

/**
 * What the image block publishes about each room, and the raster it publishes beside it.
 *
 * Three things are pinned here, all of them prerequisites for dividing a room in the admin tab
 * (`_appanalysis/28-raeume-teilen.md` §7.3):
 *
 * 1. `count` - the app refuses to divide a room below 2 m², and `count * 0.0025` is that figure.
 * 2. `bounds` - raster cells, no y flip. The report corrects an earlier one that claimed a flip
 *    here; getting it wrong puts the starting line in the wrong half of the map.
 * 3. `raster` - the grid verbatim, because `pixels.obstacle` throws the segment id of wall cells
 *    away and the dividing line snaps to exactly those cells.
 *
 * The maps are built here rather than checked in: a real one is 316 KB of the owner's floor plan.
 * The layout follows `test/unit/v1_map_specification.test.ts`.
 */

/** Cell types as they appear in the low three bits. Floor is 7 on every real map seen so far. */
const EMPTY = 0;
const WALL = 1;
const FLOOR = 7;

/** Packs a raster cell the way the robot does: segment id in the upper five bits, type in the lower three. */
function cell(segmentId: number, type: number): number {
	return (segmentId << 3) | type;
}

interface MapShape {
	top: number;
	left: number;
	width: number;
	height: number;
	/** Segment count field of the block header, i.e. `blockNum`. */
	blockNum?: number;
	cell: (x: number, y: number) => number;
}

/** Builds a map buffer holding nothing but a header and one image block. */
function buildMap(shape: MapShape): Buffer {
	const hlength = 28;
	const length = shape.width * shape.height;

	const block = Buffer.alloc(hlength + length);
	block.writeUInt16LE(2, 0); // TYPES.IMAGE
	block.writeUInt16LE(hlength, 2); // header length; also the data offset
	block.writeUInt32LE(length, 4);
	block.writeUInt32LE(shape.blockNum ?? 0, 8);
	block.writeInt32LE(shape.top, 12);
	block.writeInt32LE(shape.left, 16);
	block.writeInt32LE(shape.height, 20);
	block.writeInt32LE(shape.width, 24);
	for (let y = 0; y < shape.height; y++) {
		for (let x = 0; x < shape.width; x++) block.writeUInt8(shape.cell(x, y), hlength + y * shape.width + x);
	}

	const head = Buffer.alloc(0x14);
	head.write("rr", 0, "ascii");
	head.writeUInt16LE(0x14, 0x02);
	head.writeUInt32LE(0x14 + block.length, 0x04);

	const body = Buffer.concat([head, block]);
	const sha1 = crypto.createHash("sha1").update(body).digest();
	return Buffer.concat([body, sha1]);
}

/** The little of the adapter that `parsedata` touches. */
function stubAdapter(): any {
	return {
		rLog: () => undefined,
		http_api: {
			isSharedDevice: () => false,
			getMatchedRoomIDs: () => [],
			getSharedDeviceRooms: async () => [],
		},
	};
}

describe("segment metrics published for the image block", () => {
	let parser: MapParser;

	beforeEach(() => {
		parser = new MapParser(stubAdapter());
	});

	it("counts the floor cells of each room, so the 2 m² floor can be applied", async () => {
		// Room 16: a 4x3 block of floor. Room 17: a single floor cell.
		const map = buildMap({
			top: 0,
			left: 0,
			width: 10,
			height: 6,
			cell: (x, y) => {
				if (x < 4 && y < 3) return cell(16, FLOOR);
				if (x === 9 && y === 5) return cell(17, FLOOR);
				return EMPTY;
			},
		});

		const parsed: any = await parser.parsedata(map, null);
		const rooms = parsed.IMAGE.segments.list;

		expect(rooms.find((r: any) => r.id === 16).count).toBe(12);
		expect(rooms.find((r: any) => r.id === 17).count).toBe(1);

		// 12 cells of 50 x 50 mm is 0.03 m² - far under the 2 m² the app insists on.
		expect(rooms.find((r: any) => r.id === 16).count * 0.0025).toBeCloseTo(0.03, 10);
	});

	it("counts floor cells only, and says so by disagreeing with the walls", async () => {
		// A room of 3x3, ringed by its own wall cells. The wall carries the same segment id, so a
		// walls-included count would be 25 rather than 9. `center` has always been derived from the
		// floor cells, and moving it would move every room label.
		const map = buildMap({
			top: 0,
			left: 0,
			width: 7,
			height: 7,
			cell: (x, y) => {
				const inRing = x >= 1 && x <= 5 && y >= 1 && y <= 5;
				if (!inRing) return EMPTY;
				const onRing = x === 1 || x === 5 || y === 1 || y === 5;
				return onRing ? cell(16, WALL) : cell(16, FLOOR);
			},
		});

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.IMAGE.segments.list.find((r: any) => r.id === 16).count).toBe(9);
	});

	it("reports the bounding box in raster cells, with no flip of the y axis", async () => {
		// One floor cell at column 6, row 1. Nothing else. If the parser flipped y, `minY` would
		// come out as height - 1 - 1 = 4 instead of 1.
		const map = buildMap({
			top: 200,
			left: 100,
			width: 10,
			height: 6,
			cell: (x, y) => (x === 6 && y === 1 ? cell(19, FLOOR) : EMPTY),
		});

		const parsed: any = await parser.parsedata(map, null);
		const room = parsed.IMAGE.segments.list.find((r: any) => r.id === 19);

		expect(room.bounds).toEqual({ minX: 6, maxX: 6, minY: 1, maxY: 1 });

		// And the cell converts to robot millimetres by the formula the whole map uses:
		// x_mm = 50 * (left + column), y_mm = 50 * (top + row). The centre of a one-cell room is
		// that cell, so `center` is the cross-check that `bounds` is in the same space.
		expect(room.center).toEqual([50 * (100 + 6), 50 * (200 + 1)]);
	});

	it("spans the bounding box over every floor cell of the room", async () => {
		const map = buildMap({
			top: 0,
			left: 0,
			width: 12,
			height: 8,
			cell: (x, y) => {
				const corners = (x === 2 && y === 3) || (x === 9 && y === 6) || (x === 5 && y === 1);
				return corners ? cell(18, FLOOR) : EMPTY;
			},
		});

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.IMAGE.segments.list.find((r: any) => r.id === 18).bounds).toEqual({ minX: 2, maxX: 9, minY: 1, maxY: 6 });
	});

	it("leaves segment 0 out of the list, as it always has", async () => {
		const map = buildMap({
			top: 0,
			left: 0,
			width: 4,
			height: 4,
			cell: (x) => (x < 2 ? cell(0, FLOOR) : cell(16, FLOOR)),
		});

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.IMAGE.segments.list.map((r: any) => r.id)).toEqual([16]);
	});
});

describe("the raster published beside the derived pixel lists", () => {
	let parser: MapParser;

	beforeEach(() => {
		parser = new MapParser(stubAdapter());
	});

	it("carries the segment id of wall cells, which pixels.obstacle drops", async () => {
		// This is the whole reason the raster exists. Wall cells of room 16 are indistinguishable
		// from wall cells of room 17 in `pixels.obstacle`; in the raster they are not.
		const map = buildMap({
			top: 0,
			left: 0,
			width: 6,
			height: 2,
			cell: (x, y) => {
				if (y !== 0) return EMPTY;
				if (x === 0) return cell(16, WALL);
				if (x === 1) return cell(16, FLOOR);
				if (x === 2) return cell(17, WALL);
				return EMPTY;
			},
		});

		const parsed: any = await parser.parsedata(map, null);
		const image = parsed.IMAGE;

		// What the old fields say: two obstacles, at cell 0 and cell 2, and nothing about whose.
		expect(image.pixels.obstacle).toEqual([0, 2]);

		const cells = decodeRasterRuns(image.raster, image.dimensions.width * image.dimensions.height);
		expect(cells).not.toBeNull();
		expect(rasterSegmentId(cells![0])).toBe(16);
		expect(rasterCellType(cells![0])).toBe(WALL);
		expect(rasterSegmentId(cells![2])).toBe(17);
		expect(rasterCellType(cells![2])).toBe(WALL);
	});

	it("decodes back to the grid the robot sent, cell for cell", async () => {
		const width = 23;
		const height = 17;
		const shape = (x: number, y: number): number => {
			if (x < 2 || y < 2 || x > 20 || y > 14) return EMPTY;
			const onWall = x === 2 || x === 20 || y === 2 || y === 14;
			const room = x < 11 ? 16 : 17;
			return onWall ? cell(room, WALL) : cell(room, FLOOR);
		};

		const parsed: any = await parser.parsedata(buildMap({ top: 3, left: 4, width, height, cell: shape }), null);
		const cells = decodeRasterRuns(parsed.IMAGE.raster, width * height);

		expect(cells).not.toBeNull();
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) expect(cells![y * width + x], `cell ${x},${y}`).toBe(shape(x, y));
		}
	});

	it("repeats the grid size, so a reader need not trust dimensions to match", async () => {
		const parsed: any = await parser.parsedata(buildMap({ top: 0, left: 0, width: 9, height: 4, cell: () => EMPTY }), null);
		expect(parsed.IMAGE.raster).toMatchObject({ encoding: "rle", width: 9, height: 4 });
		expect(parsed.IMAGE.dimensions).toEqual({ width: 9, height: 4 });
	});

	it("is left out when the coding would exceed the ceiling, and the map still parses", async () => {
		// Every second cell differs from its neighbour, so no run is longer than one: 200 x 200
		// cells become 80 000 numbers, well past MAX_RASTER_RUN_VALUES. No floor plan looks like
		// this; the case exists so that a state this adapter writes has a known upper bound.
		const map = buildMap({
			top: 0,
			left: 0,
			width: 200,
			height: 200,
			cell: (x, y) => ((x + y) % 2 === 0 ? cell(16, FLOOR) : cell(17, WALL)),
		});

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.IMAGE.raster).toBeUndefined();
		// Everything else is unaffected - dropping the raster costs the dividing tool, nothing more.
		expect(parsed.IMAGE.pixels.segments.length).toBeGreaterThan(0);
		expect(parsed.IMAGE.segments.list.length).toBeGreaterThan(0);
	});

	it("stays under the ceiling on a grid the size of a real one", async () => {
		// 427 x 365 is the reference device's grid. A plan of that size codes to a few thousand
		// numbers; if a change ever made the coding worse, this is where it would show.
		const map = buildMap({
			top: 318,
			left: 372,
			width: 427,
			height: 365,
			cell: (x, y) => {
				if (x < 20 || y < 20 || x > 400 || y > 340) return EMPTY;
				const onWall = x === 20 || x === 400 || y === 20 || y === 340 || x === 210;
				return onWall ? cell(16, WALL) : cell(x < 210 ? 16 : 17, FLOOR);
			},
		});

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.IMAGE.raster).toBeDefined();
		expect(parsed.IMAGE.raster.runs.length).toBeLessThan(8_000);
	});

	it("publishes a raster even for a map with nothing on it", async () => {
		// No special case: an empty grid codes to one run. There is nothing to divide, but the tab
		// finds that out from an empty room list, not from a missing field.
		const parsed: any = await parser.parsedata(buildMap({ top: 0, left: 0, width: 8, height: 8, cell: () => EMPTY }), null);
		expect(parsed.IMAGE.raster.runs).toEqual([EMPTY, 64]);
		expect(parsed.IMAGE.segments.list).toEqual([]);
	});
});
