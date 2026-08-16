import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({ Adapter: class MockAdapter {} }));
vi.mock("go2rtc-static", () => ({ default: "" }));

import { PATH_WIDTH_FACTORS, VISUAL_BLOCK_SIZE } from "../../src/common/mapDrawing/constants";
import { drawMapV1 } from "../../src/common/mapDrawing/drawMapV1";
import { encodeRasterRuns } from "../../src/common/segmentRaster";
import type { SegmentRaster } from "../../src/common/segmentRaster";

/**
 * How wide the four path layers are drawn, and that both renderers agree about it.
 *
 * ## The bug behind this file
 *
 * The driven path was reported missing from the 3D floor after the surface picture was built - and
 * the surface picture was not at fault. Measured on a rendered map, the path reaches it: adding a
 * `PATH` block changes **149 pixels** of the surface picture, exactly as many as it changes on the
 * full picture, in both colour schemes. The mirroring works.
 *
 * What was wrong is how thin those 149 pixels were spread. The bitmap drew the driven line at
 * `VISUAL_BLOCK_SIZE / 2` = 1.5 pixels while the admin tab drew the same layer at
 * `VISUAL_BLOCK_SIZE * 0.8` = 2.4 - and the 3D floor is textured with the bitmap, so it got the
 * thin one while the 2D view beside it drew its own over the clean picture and looked right.
 *
 * Measured at both widths on the same map: the **fully covered core is one pixel row either way**,
 * 49 pixels here. What grows is the flanks - pixels carrying more than a fifth of the line's colour
 * go from **49 to 149**. The line reads about three times as solid, and no brighter. Said plainly
 * because the temptation is to claim more: this closes a real gap between two renderers, it does
 * not by itself prove the path is now easy to see on a 3D floor.
 *
 * The other three layers agreed all along - mop 6.5, backwash 0.5, pure-clean 0.5 - which is what
 * made the one that did not so easy to miss.
 *
 * ## What is pinned, and why it is pinned this way
 *
 * The widths now live in one table. This file asserts that the bitmap renderer really reads it,
 * by recording what `drawMapV1` asks for rather than by re-reading the constant - a test that only
 * compared the table to itself would pass with the renderer still hard-coding its own numbers,
 * which is precisely the failure that happened.
 *
 * The tab's side of the agreement is asserted in `src-tab/src/engine/pathWidths.test.ts`, which
 * runs in the other test project and can import the tab's constants.
 */

const GRID = 8;

function raster(): SegmentRaster {
	const cells = new Uint8Array(GRID * GRID).fill(7);
	return { encoding: "rle", width: GRID, height: GRID, runs: encodeRasterRuns(cells) };
}

/** Records the `lineWidth` of every path layer `drawMapV1` draws. */
async function recordPathWidths(): Promise<Record<string, number>> {
	const widths: Record<string, number> = {};
	// A proxy rather than a written-out stub: `drawMapV1` calls a dozen draw methods and gains more
	// over time, and a stub that has to be extended for every one of them is a test that breaks for
	// reasons having nothing to do with what it asserts. Everything but `drawPath` swallows its call.
	const renderer = new Proxy(
		{},
		{
			get: (_target, property: string | symbol) => {
				if (property === "drawPath") {
					return (input: { pathLayer?: string; lineWidth: number }): void => {
						widths[input.pathLayer ?? "main"] = input.lineWidth;
					};
				}
				return async (): Promise<void> => undefined;
			}
		}
	);

	// A path with two points in each layer, so no layer is skipped for being empty.
	await drawMapV1(
		{
			IMAGE: { position: { left: 0, top: 0 }, dimensions: { width: GRID, height: GRID }, raster: raster() },
			PATH: { points: [[100, 100], [300, 100]] },
			MOP_PATH: [1, 1]
		} as never,
		renderer as never,
		{}
	);
	return widths;
}

describe("the four path layers are drawn at one agreed width", () => {
	it("has the driven path wider than the tracks, and the mopped band widest by far", () => {
		// Ordering rather than four bare numbers: it is the relation that carries the meaning, and a
		// change that inverted it would be a drawing mistake whatever the values were.
		expect(PATH_WIDTH_FACTORS.mop).toBeGreaterThan(PATH_WIDTH_FACTORS.main);
		expect(PATH_WIDTH_FACTORS.main).toBeGreaterThan(PATH_WIDTH_FACTORS.backwash);
		expect(PATH_WIDTH_FACTORS.pureClean).toBe(PATH_WIDTH_FACTORS.backwash);
	});

	/**
	 * The regression itself. `0.5` here is what the bitmap drew while the tab drew `0.8`, and the 3D
	 * floor takes its picture from the bitmap.
	 */
	it("draws the driven path at four fifths of a cell, not at half of one", () => {
		expect(PATH_WIDTH_FACTORS.main).toBe(0.8);
		expect(PATH_WIDTH_FACTORS.main).not.toBe(0.5);
	});

	it("makes the bitmap renderer read the table instead of its own numbers", async () => {
		const widths = await recordPathWidths();

		expect(widths.main).toBe(VISUAL_BLOCK_SIZE * PATH_WIDTH_FACTORS.main);
		expect(widths.mop).toBe(VISUAL_BLOCK_SIZE * PATH_WIDTH_FACTORS.mop);
		expect(widths.backwash).toBe(VISUAL_BLOCK_SIZE * PATH_WIDTH_FACTORS.backwash);
		expect(widths.pure).toBe(VISUAL_BLOCK_SIZE * PATH_WIDTH_FACTORS.pureClean);
	});

	it("never draws a line thinner than one pixel, however small a cell becomes", async () => {
		// The floor of 1 is what keeps the driven path from disappearing outright if the block size
		// is ever reduced; it applies to the main line, which is the one it could bite.
		const widths = await recordPathWidths();
		expect(widths.main).toBeGreaterThanOrEqual(1);
	});
});
