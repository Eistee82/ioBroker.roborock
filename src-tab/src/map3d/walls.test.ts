import { describe, expect, it } from "vitest";
import { extractWalls } from "./walls";
import type { WallSegment } from "./walls";

/**
 * The three passes of the app's `getCleanUpedWalls`, each checked on a grid small enough to draw.
 *
 * The reason this module exists at all is a complaint that cannot be expressed as a unit test - the
 * first version drew one box per occupied cell and the result looked like gravel. What *can* be
 * pinned down is the rule that replaces it, and that is what these tests do: grouping, the filter,
 * and the merge into runs.
 */

/** Builds a grid from rows of characters: `#` wall, `.` floor, ` ` unmapped. */
function grid(rows: string[]): { width: number; height: number; obstacles: number[]; floor: number[] } {
	const width = Math.max(...rows.map((row) => row.length));
	const height = rows.length;
	const obstacles: number[] = [];
	const floor: number[] = [];
	rows.forEach((row, y) => {
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			if (row[x] === "#") obstacles.push(index);
			else if (row[x] === ".") floor.push(index);
		}
	});
	return { width, height, obstacles, floor };
}

function run(rows: string[]): ReturnType<typeof extractWalls> {
	const g = grid(rows);
	return extractWalls(g.width, g.height, g.obstacles, g.floor);
}

/** Order-insensitive comparison, because the pass order is an implementation detail. */
function sorted(segments: WallSegment[]): WallSegment[] {
	return [...segments].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.y1 - b.y1 || a.x1 - b.x1);
}

describe("merging cells into runs", () => {
	it("turns a straight wall into one segment instead of one box per cell", () => {
		// Six cells, one wall. This single case is the whole reduction from 3 468 to 541.
		const result = run([
			"      ",
			" #### ",
			" .... ",
			"      "
		]);

		expect(result.cellCount).toBe(4);
		expect(sorted(result.segments)).toEqual([{ x0: 1, y0: 1, x1: 4, y1: 1 }]);
	});

	it("splits an L into a horizontal and a vertical run", () => {
		const result = run([
			"     ",
			" ### ",
			" #.. ",
			" #.. ",
			"     "
		]);

		// Rows are scanned bottom-up, so the seed is the foot of the L. From there the reach is one
		// cell sideways and three upwards, and the upright is taken whole; the arm is what is left.
		expect(sorted(result.segments)).toEqual([
			{ x0: 1, y0: 1, x1: 1, y1: 3 },
			{ x0: 2, y0: 1, x1: 3, y1: 1 }
		]);
	});

	it("prefers the longer direction at each seed", () => {
		const result = run([
			"    ",
			" #  ",
			" #. ",
			" #. ",
			" #. ",
			"    "
		]);

		expect(sorted(result.segments)).toEqual([{ x0: 1, y0: 1, x1: 1, y1: 4 }]);
	});
});

describe("the filter that removes the gravel", () => {
	it("drops a blob that is enclosed by floor", () => {
		// A lump in the middle of a cleaned room. The app does not draw it, and that is exactly the
		// "viel zu viele Wände" the first version showed.
		const result = run([
			".....",
			".....",
			"..##.",
			"..##.",
			"....."
		]);

		expect(result.cellCount).toBe(4);
		expect(result.chainCount).toBe(1);
		expect(result.keptCount).toBe(0);
		expect(result.segments).toEqual([]);
	});

	it("keeps a blob that borders unmapped space - the hole in the middle of a room", () => {
		// Same lump, but now with nothing behind it. The user named this case himself: walls appear
		// "wenn komplett leere bereiche mitten im raum sind".
		const result = run([
			".....",
			".....",
			"..## ",
			"..## ",
			"....."
		]);

		expect(result.keptCount).toBe(1);
		expect(result.segments.length).toBeGreaterThan(0);
	});

	it("keeps the outline of a room, because its far side faces the unmapped outside", () => {
		const result = run([
			"     ",
			" ### ",
			" #.# ",
			" ### ",
			"     "
		]);

		expect(result.chainCount).toBe(1);
		expect(result.keptCount).toBe(1);
		// The bottom row is taken first - three cells across, and the tie between three across and
		// three up goes to horizontal (A65:564983). The two sides are then upright runs of two, and
		// the last cell of the top row is what remains.
		expect(sorted(result.segments)).toEqual([
			{ x0: 1, y0: 1, x1: 1, y1: 2 },
			{ x0: 2, y0: 1, x1: 2, y1: 1 },
			{ x0: 3, y0: 1, x1: 3, y1: 2 },
			{ x0: 1, y0: 3, x1: 3, y1: 3 }
		]);
	});

	it("drops a lone cell even when it borders nothing", () => {
		// The app requires more than one cell in a chain (A65:565... `chain.length > 1`). A single
		// speck of sensor noise is not a wall.
		const result = run([
			"     ",
			" #   ",
			"  .. ",
			"     "
		]);

		expect(result.chainCount).toBe(1);
		expect(result.segments).toEqual([]);
	});
});

describe("things that must not happen", () => {
	it("never lets a run wrap from one row into the next", () => {
		// Index arithmetic on a flat array makes this the easy mistake, and it produces a wall
		// straight across the flat that nobody can explain.
		const result = run([
			"   ",
			"###",
			"###",
			"..."
		]);

		for (const segment of result.segments) {
			expect(segment.y0).toBe(segment.y1);
			expect(segment.x0).toBeLessThanOrEqual(segment.x1);
			expect(segment.x1).toBeLessThan(3);
		}
	});

	it("covers every cell of a kept chain exactly once", () => {
		const result = run([
			"      ",
			" #### ",
			" #..# ",
			" #### ",
			"      "
		]);

		const covered = new Set<string>();
		for (const s of result.segments) {
			for (let y = s.y0; y <= s.y1; y++) {
				for (let x = s.x0; x <= s.x1; x++) {
					const key = `${x},${y}`;
					expect(covered.has(key)).toBe(false);
					covered.add(key);
				}
			}
		}
		expect(covered.size).toBe(result.cellCount);
	});

	it("says nothing rather than guessing on an empty or impossible grid", () => {
		expect(extractWalls(0, 0, [], [])).toEqual({ segments: [], cellCount: 0, chainCount: 0, keptCount: 0 });
		expect(extractWalls(4, 3, [], [1, 2])).toEqual({ segments: [], cellCount: 0, chainCount: 0, keptCount: 0 });
		// Out-of-range indices are ignored rather than throwing or wrapping.
		expect(extractWalls(4, 3, [99, -1, 0, 1], []).cellCount).toBe(2);
	});

	it("counts a repeated cell index once", () => {
		expect(extractWalls(4, 3, [0, 0, 1], []).cellCount).toBe(2);
	});
});
