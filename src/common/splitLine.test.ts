import { describe, expect, it } from "vitest";
import type { RasterPoint, RasterView } from "./splitLine";
import { nudgeSplitPoint, previewSplitHalves, snapSplitLine, splitPayload, splitPreconditions, startingSplitLine } from "./splitLine";
import { robotCoordsToLocalCoords } from "./coordTransformation";

/**
 * The dividing line, tested against maps drawn as text.
 *
 * A picture is the point here. The scan has four outcomes that differ by one cell - the outer wall,
 * the inner wall, the floor behind it, and "the handle is already inside the room" - and a fixture
 * written as numbers would hide exactly the distinction under test. Every map below can be checked
 * against the expectation by eye.
 *
 * ```
 * .  nothing mapped        #  wall of room 16        o  floor of room 16
 *                          X  wall of room 17        +  floor of room 17
 * ```
 */

const ROOM = 16;
const OTHER = 17;

const EMPTY = 0;
const WALL = 1;
const FLOOR = 7;

const LEGEND: Record<string, number> = {
	".": EMPTY,
	"#": (ROOM << 3) | WALL,
	o: (ROOM << 3) | FLOOR,
	X: (OTHER << 3) | WALL,
	"+": (OTHER << 3) | FLOOR,
};

/** Turns a drawn map into the grid and the two numbers needed to read it. */
function view(drawing: string): RasterView {
	const rows = drawing.trim().split("\n").map((row) => row.trim());
	const width = rows[0].length;
	const height = rows.length;
	const cells = new Uint8Array(width * height);

	rows.forEach((row, y) => {
		expect(row.length, `row ${y} is a different width`).toBe(width);
		[...row].forEach((char, x) => {
			const cell = LEGEND[char];
			expect(cell, `unknown character '${char}'`).toBeDefined();
			cells[y * width + x] = cell;
		});
	});

	return { cells, width, height };
}

/** Shorthand for a point. */
function at(x: number, y: number): RasterPoint {
	return { x, y };
}

describe("snapping a dragged line onto the room boundary", () => {
	const oneRoom = view(`
		.........
		..#####..
		..#ooo#..
		..#####..
		.........
	`);

	it("pulls both ends in to the room's own wall", () => {
		// Dragged clear across the map on row 2; the ends belong on the wall at columns 2 and 6.
		const result = snapSplitLine(oneRoom, ROOM, at(0, 2), at(8, 2));

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.left).toEqual({ x: 6, y: 2 });
		expect(result.right).toEqual({ x: 2, y: 2 });
	});

	it("steps through a thick wall instead of stopping in it", () => {
		// Two cells of wall on each side. Stopping at the first would leave the line's end buried in
		// the wall; the app walks on while the next cell inward is wall of the same room.
		const thickWalls = view(`
			...........
			..#######..
			..##ooo##..
			..#######..
			...........
		`);

		const result = snapSplitLine(thickWalls, ROOM, at(0, 2), at(10, 2));

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.left).toEqual({ x: 7, y: 2 });
		expect(result.right).toEqual({ x: 3, y: 2 });
	});

	it("stops at a wall of the neighbouring room rather than walking through it", () => {
		// The wall to the right belongs to room 17, so it is not this room's boundary to step over.
		const shared = view(`
			.........
			..#####..
			..#ooXX+.
			..#####..
			.........
		`);

		const result = snapSplitLine(shared, ROOM, at(0, 2), at(8, 2));

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		// Walking in from the right, the first cell of room 16 is the floor at column 4.
		expect(result.left).toEqual({ x: 4, y: 2 });
		expect(result.right).toEqual({ x: 2, y: 2 });
	});

	it("asks for an adjustment when a handle sits inside the room", () => {
		// Left handle dropped on floor at column 4, with more room to its left: there is no boundary
		// on that side to snap to, and the app says so rather than inventing one.
		expect(snapSplitLine(oneRoom, ROOM, at(4, 2), at(8, 2)).status).toBe("adjust");
	});

	it("asks for an adjustment when a handle sits on a wall ringed by the room", () => {
		// A pillar inside the room: a wall cell whose four neighbours are all this room's floor.
		const pillar = view(`
			.........
			..#####..
			..#ooo#..
			..#o#o#..
			..#ooo#..
			..#####..
			.........
		`);

		expect(snapSplitLine(pillar, ROOM, at(4, 3), at(8, 3)).status).toBe("adjust");
	});

	it("accepts a handle dropped exactly on the room's outermost cell", () => {
		// A room with no wall of its own, so the boundary cell is floor and the decision falls to the
		// probe one step *outward*. Dropping a handle right on the edge is the good case and must not
		// be read as "inside the room" - which is what probing inward instead would say, since the
		// next cell inward is of course also the room.
		const unwalled = view(`
			.........
			.........
			..ooooo..
			.........
		`);

		const fromLeft = snapSplitLine(unwalled, ROOM, at(2, 2), at(8, 2));
		expect(fromLeft.status).toBe("ok");
		if (fromLeft.status !== "ok") return;
		expect(fromLeft.right).toEqual({ x: 2, y: 2 });

		// The mirror image, so that a sign error on one side alone is caught too.
		const fromRight = snapSplitLine(unwalled, ROOM, at(0, 2), at(6, 2));
		expect(fromRight.status).toBe("ok");
		if (fromRight.status !== "ok") return;
		expect(fromRight.left).toEqual({ x: 6, y: 2 });
	});

	it("still asks for an adjustment when the other end found nothing at all", () => {
		// One end inside the room, the other off the map. "Pull this handle out" is the useful half.
		const halfOff = view(`
			.........
			..#####..
			..#ooo#..
			..#####..
			.........
		`);

		expect(snapSplitLine(halfOff, ROOM, at(4, 2), at(4, 0)).status).toBe("adjust");
	});

	it("refuses a line that never touches the room", () => {
		expect(snapSplitLine(oneRoom, ROOM, at(0, 0), at(8, 0)).status).toBe("outside");
	});

	it("refuses a line drawn through a different room", () => {
		const twoRooms = view(`
			..........
			..###XXX..
			..#o#+++..
			..###XXX..
			..........
		`);

		expect(snapSplitLine(twoRooms, ROOM, at(9, 2), at(6, 2)).status).toBe("outside");
	});

	it("refuses a line whose ends land on the same cell", () => {
		// A one-cell room: both scans stop on the same cell, which is not a line.
		const speck = view(`
			.....
			..o..
			.....
		`);

		expect(snapSplitLine(speck, ROOM, at(0, 1), at(4, 1)).status).toBe("outside");
	});

	it("works the same way down a column", () => {
		const tall = view(`
			.....
			.###.
			.#o#.
			.#o#.
			.#o#.
			.###.
			.....
		`);

		const result = snapSplitLine(tall, ROOM, at(2, 0), at(2, 6));

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.left).toEqual({ x: 2, y: 5 });
		expect(result.right).toEqual({ x: 2, y: 1 });
	});

	it("follows a diagonal, stepping whichever axis moves faster", () => {
		const box = view(`
			..........
			..######..
			..#oooo#..
			..#oooo#..
			..#oooo#..
			..######..
			..........
		`);

		// Shallow: 9 across, 4 down - stepped along x.
		const shallow = snapSplitLine(box, ROOM, at(0, 1), at(9, 5));
		expect(shallow.status).toBe("ok");

		// Steep: 4 across, 6 down - stepped along y. Same box, so both must find the boundary.
		const steep = snapSplitLine(box, ROOM, at(1, 0), at(5, 6));
		expect(steep.status).toBe("ok");
		if (steep.status !== "ok") return;
		for (const end of [steep.left, steep.right]) {
			const cell = box.cells[Math.floor(end.y) * box.width + Math.floor(end.x)];
			expect(cell >>> 3, "an end landed outside the room").toBe(ROOM);
		}
	});

	it("does not read past the end of a row into the next one", () => {
		// The room reaches the right edge on row 1, and row 2 starts with more of it. An unchecked
		// read at column `width` would find row 2's first cell, decide the handle is inside the room
		// and ask for an adjustment - on a handle that is correctly at the edge.
		const atEdge = view(`
			.....
			..ooo
			ooo..
			.....
		`);

		const result = snapSplitLine(atEdge, ROOM, at(0, 1), at(4, 1));

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.left).toEqual({ x: 4, y: 1 });
		expect(result.right).toEqual({ x: 2, y: 1 });
	});

	it("refuses a grid whose size does not match its cells", () => {
		expect(snapSplitLine({ cells: new Uint8Array(4), width: 3, height: 3 }, ROOM, at(0, 0), at(2, 2)).status).toBe("outside");
		expect(snapSplitLine({ cells: new Uint8Array(0), width: 0, height: 0 }, ROOM, at(0, 0), at(2, 2)).status).toBe("outside");
	});
});

describe("the line the app offers before the user moves anything", () => {
	it("lays a horizontal line across a room that is taller than it is wide", () => {
		const tall = view(`
			.....
			.ooo.
			.ooo.
			.ooo.
			.ooo.
			.ooo.
			.....
		`);

		// Five rows against three columns at the clicked point, so the room is cut across its width.
		expect(startingSplitLine(tall, ROOM, at(2, 3))).toEqual({ left: { x: 1, y: 3 }, right: { x: 3, y: 3 } });
	});

	it("lays a vertical line across a room that is wider than it is tall", () => {
		const wide = view(`
			.......
			.ooooo.
			.ooooo.
			.......
		`);

		expect(startingSplitLine(wide, ROOM, at(3, 2))).toEqual({ left: { x: 3, y: 1 }, right: { x: 3, y: 2 } });
	});

	it("measures at the clicked point, not over the whole room", () => {
		// An L-shape. Clicked in the narrow leg, the line crosses the leg rather than the bounding box.
		const bent = view(`
			........
			.oo.....
			.oo.....
			.oooooo.
			.oooooo.
			........
		`);

		expect(startingSplitLine(bent, ROOM, at(1, 1))).toEqual({ left: { x: 1, y: 1 }, right: { x: 2, y: 1 } });
	});

	it("answers nothing when the room is not on that row or column", () => {
		const room = view(`
			.....
			.ooo.
			.....
		`);

		expect(startingSplitLine(room, ROOM, at(0, 0))).toBeNull();
		expect(startingSplitLine(room, ROOM, at(-1, 1))).toBeNull();
		expect(startingSplitLine(room, ROOM, at(5, 1))).toBeNull();
	});

	it("counts wall cells as part of the room, the way the app's probes do", () => {
		const ringed = view(`
			.....
			.###.
			.#o#.
			.###.
			.....
		`);

		// Both probes span columns/rows 1..3 including the ring, so extents tie and the tie goes
		// vertical - the same branch the app takes when neither direction is longer.
		expect(startingSplitLine(ringed, ROOM, at(2, 2))).toEqual({ left: { x: 2, y: 1 }, right: { x: 2, y: 3 } });
	});
});

describe("moving an end with the keyboard", () => {
	const start = at(10, 20);

	it("moves one cell per press, ten with Shift", () => {
		expect(nudgeSplitPoint(start, "ArrowRight", false)).toEqual({ x: 11, y: 20 });
		expect(nudgeSplitPoint(start, "ArrowRight", true)).toEqual({ x: 20, y: 20 });
		expect(nudgeSplitPoint(start, "ArrowLeft", false)).toEqual({ x: 9, y: 20 });
		expect(nudgeSplitPoint(start, "ArrowLeft", true)).toEqual({ x: 0, y: 20 });
	});

	it("sends the line up the screen when the up arrow is pressed", () => {
		// The one direction that is not obvious, and the one a rebuild gets backwards. The map is
		// drawn with `py = height - row`, so a *larger* row sits *higher* on screen: up must add.
		// Checked against the conversion itself below rather than asserted from memory.
		const up = nudgeSplitPoint(start, "ArrowUp", false);
		const down = nudgeSplitPoint(start, "ArrowDown", false);

		expect(up).toEqual({ x: 10, y: 21 });
		expect(down).toEqual({ x: 10, y: 19 });

		// The property that makes it right: converted to millimetres and then to the screen, the
		// point moved by "up" must sit above the one moved by "down".
		const params = { scaleFactor: 3, left: 0, topMap: 0, imageHeight: 300 * 3 };
		const toScreen = (point: { x: number; y: number }): { x: number; y: number } =>
			robotCoordsToLocalCoords({ x: point.x * 50, y: point.y * 50 }, params);
		expect(toScreen(up!).y).toBeLessThan(toScreen(down!).y);
	});

	it("keeps the other coordinate untouched", () => {
		expect(nudgeSplitPoint(start, "ArrowUp", false)!.x).toBe(start.x);
		expect(nudgeSplitPoint(start, "ArrowLeft", false)!.y).toBe(start.y);
	});

	it("answers nothing for a key that is not an arrow", () => {
		for (const key of ["Enter", " ", "Escape", "a", "Tab", "PageUp"]) {
			expect(nudgeSplitPoint(start, key, false), key).toBeNull();
		}
	});
});

describe("the checks the app makes before it will divide anything", () => {
	// 800 cells is exactly 2 m²; the app refuses below that, so 800 passes and 799 does not.
	const BIG = 4000;

	it("refuses a room under two square metres", () => {
		expect(splitPreconditions({ cells: 799, rooms: 4, maxZoneOpened: true })).toMatchObject({ reason: "tooSmall", cells: 799 });
		expect(splitPreconditions({ cells: 800, rooms: 4, maxZoneOpened: true })).toBeNull();
	});

	it("stops at 32 rooms on a robot that announces MaxZoneOpened", () => {
		expect(splitPreconditions({ cells: BIG, rooms: 31, maxZoneOpened: true })).toBeNull();
		expect(splitPreconditions({ cells: BIG, rooms: 32, maxZoneOpened: true })).toMatchObject({ reason: "tooManyRooms", limit: 32, limitedByFeature: false });
	});

	it("stops at 16 rooms on a robot that says it has not got it", () => {
		expect(splitPreconditions({ cells: BIG, rooms: 15, maxZoneOpened: false })).toBeNull();
		expect(splitPreconditions({ cells: BIG, rooms: 16, maxZoneOpened: false })).toMatchObject({ reason: "tooManyRooms", limit: 16, limitedByFeature: true });
	});

	it("uses the permissive limit while the robot has not said either way", () => {
		// Silence is not a cleared bit. Halving the limit here would take the function away from a
		// robot whose feature string simply has not been read yet.
		expect(splitPreconditions({ cells: BIG, rooms: 20, maxZoneOpened: null })).toBeNull();
		expect(splitPreconditions({ cells: BIG, rooms: 32, maxZoneOpened: null })).toMatchObject({ reason: "tooManyRooms", limit: 32 });
	});

	it("skips whichever figure the map cannot supply", () => {
		expect(splitPreconditions({ rooms: 4, maxZoneOpened: true })).toBeNull();
		expect(splitPreconditions({ cells: BIG, maxZoneOpened: true })).toBeNull();
		expect(splitPreconditions({ maxZoneOpened: null })).toBeNull();
		// A room too small is still refused when the room count is missing.
		expect(splitPreconditions({ cells: 10, maxZoneOpened: null })).toMatchObject({ reason: "tooSmall" });
	});

	it("reports the area before the room count, the order the app checks them in", () => {
		expect(splitPreconditions({ cells: 10, rooms: 99, maxZoneOpened: false })).toMatchObject({ reason: "tooSmall" });
	});
});

describe("previewing the two halves", () => {
	it("splits the room's cells along the line", () => {
		const room = view(`
			........
			.oooooo.
			.oooooo.
			.oooooo.
			........
		`);

		// A vertical cut down the middle of a 6 x 3 room: three columns each side.
		const halves = previewSplitHalves(room, ROOM, at(3.5, 0), at(3.5, 4));
		expect(halves.negative + halves.positive).toBe(18);
		expect(halves.negative).toBe(9);
		expect(halves.positive).toBe(9);
	});

	it("counts walls of the room as part of it", () => {
		const ringed = view(`
			......
			.####.
			.#oo#.
			.####.
			......
		`);

		const halves = previewSplitHalves(ringed, ROOM, at(2.5, 0), at(2.5, 4));
		expect(halves.negative + halves.positive).toBe(12);
	});

	it("ignores every other room", () => {
		const two = view(`
			........
			.oo.++..
			.oo.++..
			........
		`);

		const halves = previewSplitHalves(two, ROOM, at(1.5, 0), at(1.5, 3));
		expect(halves.negative + halves.positive).toBe(4);
	});

	it("puts an unequal cut where the line is", () => {
		const room = view(`
			........
			.oooooo.
			.oooooo.
			........
		`);

		// Six columns over two rows; the cut leaves two columns on one side and four on the other.
		const halves = previewSplitHalves(room, ROOM, at(2.5, 0), at(2.5, 3));
		expect([halves.negative, halves.positive].sort((a, b) => a - b)).toEqual([4, 8]);
	});
});

describe("turning a snapped line into the payload", () => {
	const position = { left: 372, top: 318 };

	it("converts cells to millimetres with no flip of the y axis", () => {
		// The one property the whole feature stands on. A larger row must give a larger y in
		// millimetres; the report corrects an earlier one that read the app's `top + height - y` as
		// an axis flip. `_appanalysis/28-raeume-teilen.md` §4.2.
		const low = splitPayload(ROOM, at(10, 5), at(20, 5), position);
		const high = splitPayload(ROOM, at(10, 40), at(20, 40), position);

		expect(low[2]).toBeLessThan(high[2]);
		expect(low[2]).toBe(50 * (318 + 5));
		expect(high[2]).toBe(50 * (318 + 40));
	});

	it("produces the five values in the order split_segment expects", () => {
		expect(splitPayload(ROOM, at(10, 5), at(20, 7), position)).toEqual([
			ROOM,
			50 * (372 + 10),
			50 * (318 + 5),
			50 * (372 + 20),
			50 * (318 + 7),
		]);
	});

	it("rounds a fractional end to a whole cell, so every value is a multiple of 50", () => {
		const payload = splitPayload(ROOM, at(10.4, 5.6), at(20.5, 7.5), position);
		for (const value of payload.slice(1)) expect(value % 50).toBe(0);
		expect(payload[1]).toBe(50 * (372 + 10));
		expect(payload[2]).toBe(50 * (318 + 6));
	});

	it("agrees with the formula the map parser uses for room centres", () => {
		// `MapParser.parseImageBlock` publishes `center` as `(cell + offset) * 50` on both axes, and
		// that formula is the one the room labels are placed with on a real device. A dividing line
		// computed a different way would be drawn consistently with the map and land wrongly on it.
		const column = 123;
		const row = 45;
		const payload = splitPayload(ROOM, at(column, row), at(column + 1, row), position);

		expect(payload[1]).toBe(Math.round((column + position.left) * 50));
		expect(payload[2]).toBe(Math.round((row + position.top) * 50));
	});
});
