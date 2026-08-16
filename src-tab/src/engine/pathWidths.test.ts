import { describe, expect, it } from "vitest";
import { PATH_WIDTH_FACTORS, VISUAL_BLOCK_SIZE } from "@adapter/common/mapDrawing/constants";
import { UI_CONSTANTS } from "./MapEngine";

/**
 * The tab's half of one agreement: it draws the four path layers at the same widths the adapter's
 * bitmap does.
 *
 * They disagreed, on exactly one layer, and it cost the 3D view its driven path. The bitmap drew
 * the line at `VISUAL_BLOCK_SIZE / 2` while this view drew it at `0.8` of a cell - and the 3D floor
 * is textured with the bitmap. Three of the four layers agreed all along, which is what made the
 * fourth so easy to miss. `test/unit/map_path_widths.test.ts` holds the adapter's half and the
 * measurement; `PATH_WIDTH_FACTORS` holds the table both now read.
 *
 * This asserts the **wiring**, not the values: that the constants this view hands to the SVG
 * renderer are the shared ones rather than a second copy that can drift again.
 */
describe("the tab draws the paths at the adapter's widths", () => {
	it("takes all three width bases from the shared table", () => {
		expect(UI_CONSTANTS.PATH_MOP_WIDTH_BASE).toBe(PATH_WIDTH_FACTORS.mop);
		expect(UI_CONSTANTS.PATH_MAIN_WIDTH_RATIO_BASE).toBe(PATH_WIDTH_FACTORS.main);
		expect(UI_CONSTANTS.PATH_BACKWASH_WIDTH_BASE).toBe(PATH_WIDTH_FACTORS.backwash);
	});

	it("uses the same cell size the bitmap does, so equal factors mean equal pixels", () => {
		// The factors only agree about anything if both sides multiply them by the same number.
		expect(VISUAL_BLOCK_SIZE).toBe(3);
	});

	/** The regression, stated in the unit the user sees. */
	it("draws the driven path 2.4 units wide, not 1.5", () => {
		expect(VISUAL_BLOCK_SIZE * UI_CONSTANTS.PATH_MAIN_WIDTH_RATIO_BASE).toBeCloseTo(2.4, 10);
	});
});
