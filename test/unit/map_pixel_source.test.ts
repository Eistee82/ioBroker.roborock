import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

import { encodeRasterRuns } from "../../src/common/segmentRaster";
import type { SegmentRaster } from "../../src/common/segmentRaster";
import { MapBuilder } from "../../src/lib/map/v1/MapBuilder";

/**
 * The image block is published as a raster now, not as three cell lists, and this is the test that
 * the change costs no pixel of the picture.
 *
 * The whole adapter drawing path runs here - `MapBuilder.canvasMap`, the real `@napi-rs/canvas`, the
 * room colouring, the crop - once from a map in the old form and once from the same map in the new
 * one. The comparison is on the finished PNGs, so a difference of a single cell in a single layer
 * shows up as a different data URI.
 *
 * Three shapes are covered, because all three reach `repaintStoredMap` in the field:
 *
 * 1. **`pixels` and no `raster`** - a `mapData` state written by an adapter version older than this
 *    change. It is read back on every theme switch and every room selection, and if it stopped
 *    drawing, every stored map would go blank at the first repaint after an update.
 * 2. **`raster` and no `pixels`** - what every map looks like from now on.
 * 3. **neither** - a B01/Q10 map, an image block that could not be parsed, or a raster dropped for
 *    exceeding `MAX_RASTER_RUN_VALUES` on a map whose lists were dropped with it. Nothing to draw
 *    is not an error.
 */

const GRID = 24;
const ROOM_A = 1;
const ROOM_B = 2;

/** Cell types in the low three bits, as the robot packs them. */
const EMPTY = 0;
const WALL = 1;
const FLOOR = 7;

/** The grid this test draws: two rooms, a wall across the middle, and plain floor at the bottom. */
function gridCells(): Uint8Array {
	const cells = new Uint8Array(GRID * GRID);
	for (let row = 0; row < GRID; row++) {
		for (let column = 0; column < GRID; column++) {
			const index = row * GRID + column;
			if (row >= 16) cells[index] = ((column < 12 ? ROOM_A : ROOM_B) << 3) | FLOOR;
			else if (row === 15) cells[index] = (ROOM_A << 3) | WALL;
			else if (row < 8) cells[index] = FLOOR;
			else cells[index] = EMPTY;
		}
	}
	return cells;
}

/**
 * The three lists exactly as `MapParser` built them before the raster replaced them.
 *
 * Written out here rather than imported, so the expectation does not lean on the very function
 * under test: if `imagePixels` and this loop ever disagree, the rendered pictures differ.
 */
function listsAsPublishedBefore(cells: Uint8Array): { floor: number[]; obstacle: number[]; segments: number[] } {
	const floor: number[] = [];
	const obstacle: number[] = [];
	const segments: number[] = [];
	for (let i = 0; i < cells.length; i++) {
		const type = cells[i] & 0x07;
		if (type === 1) obstacle.push(i);
		else if (type !== 0) {
			floor.push(i);
			segments.push(i | (((cells[i] & 248) >> 3) << 21));
		}
	}
	return { floor, obstacle, segments };
}

function coded(cells: Uint8Array): SegmentRaster {
	return { encoding: "rle", width: GRID, height: GRID, runs: encodeRasterRuns(cells) };
}

/** Everything outside the image block, identical in every variant. */
function mapDataAround(image: Record<string, unknown>): Record<string, unknown> {
	return {
		mapFlag: 0,
		IMAGE: { position: { left: 0, top: 0 }, dimensions: { width: GRID, height: GRID }, ...image },
		PATH: { points: [[100, 175], [600, 175]] },
		CURRENTLY_CLEANED_ZONES: [[200, 100, 900, 300]],
		ROBOT_POSITION: { position: [575, 175], angle: 0 }
	};
}

function adapterStub(): Record<string, unknown> {
	return {
		namespace: "roborock.0",
		name: "roborock",
		config: { map_theme: "light", map_color_scheme: "light" },
		getMapColorScheme: () => "light",
		getStatesAsync: async () => ({}),
		errorMessage: (e: unknown) => String(e),
		rLog: vi.fn(),
		fileExistsAsync: async () => false
	};
}

/** The three images `canvasMap` returns: clean, full, cropped. */
async function render(image: Record<string, unknown>): Promise<[string, string, string]> {
	const builder = new MapBuilder(adapterStub() as never);
	return builder.canvasMap(mapDataAround(image), { duid: "duid1" });
}

describe("the picture a map draws does not depend on which form it carries", () => {
	const cells = gridCells();
	const lists = listsAsPublishedBefore(cells);

	it("draws a raster-only map exactly as it drew the same map from the three cell lists", async () => {
		// Not a stand-in for the real map: the cell-exact check against the reference device's own
		// 427 x 365 grid was run separately, and this pins the same property in the suite.
		const [cleanOld, fullOld, croppedOld] = await render({ pixels: lists });
		const [cleanNew, fullNew, croppedNew] = await render({ raster: coded(cells) });

		expect(cleanNew).toBe(cleanOld);
		expect(fullNew).toBe(fullOld);
		expect(croppedNew).toBe(croppedOld);

		// A guard against the comparison passing because both sides drew nothing: an image block
		// with neither form has to come out different from this one.
		const [, fullEmpty] = await render({});
		expect(fullNew).not.toBe(fullEmpty);
	});

	it("still draws a stored map that predates the raster, rather than blanking it", async () => {
		// The old form on its own has to reach the floor, the walls and the room colours. Comparing
		// against an image block with nothing in it is what makes "reaches" measurable.
		const [, withLists] = await render({ pixels: lists });
		const [, withNothing] = await render({});
		expect(withLists).not.toBe(withNothing);
	});

	it("draws the rest of the map when the block carries neither form, instead of throwing", async () => {
		// Path, zone and robot are outside the image block and are still there; only floor, walls and
		// rooms are missing. `canvasMap` must come back with three usable images.
		const [clean, full, cropped] = await render({});
		for (const image of [clean, full, cropped]) expect(image.startsWith("data:image/png;base64,")).toBe(true);

		// And the same is true for the shapes an ioBroker state can degrade to.
		await expect(render({ pixels: {} })).resolves.toHaveLength(3);
		await expect(render({ raster: { encoding: "rle", width: GRID, height: GRID, runs: [FLOOR, 5] } })).resolves.toHaveLength(3);
	});
});
