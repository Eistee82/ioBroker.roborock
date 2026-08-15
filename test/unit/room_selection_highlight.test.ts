import { createCanvas, loadImage } from "@napi-rs/canvas";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

import { DARK_MAP_COLORS, LEGACY_COLORS } from "../../src/common/mapDrawing/constants";
import {
	SELECTION_FADE_DARK,
	SELECTION_FADE_LIGHT,
	fadeHexTowards,
	fadeSurfaceColors,
	getSelectionFadeFactor
} from "../../src/common/mapDrawing/roomSelectionFade";
import {
	PALETTE_DARK_HIGHLIGHT,
	PALETTE_DARK_NORMAL,
	PALETTE_LIGHT_HIGHLIGHT,
	PALETTE_LIGHT_NORMAL
} from "../../src/lib/roomColoring";
import { MapBuilder } from "../../src/lib/map/v1/MapBuilder";

/**
 * The Roborock app does not highlight a selection, it takes everything else away: while rooms are
 * selected it drops the opacity of the base bitmap to 0.3 (light) or 0.7 (dark), so the unselected
 * rooms fade against the ground while the selected ones keep their colour
 * (`_appanalysis/17-raumauswahl.md`, A65:494737-494743 and A65:494792-494798).
 *
 * These tests pin the three things that can go wrong when a stack of layers is rebuilt on a single
 * canvas:
 *
 * 1. the fade uses the app's factor for the active scheme,
 * 2. only the base bitmap fades - path, robot and zones stay exactly as they are, and
 * 3. a map with nothing selected is byte for byte the map the adapter drew before.
 */

// --- fixture geometry -------------------------------------------------------------------------
//
// A 24 x 24 grid, drawn at 3 px per cell, so the canvas is 72 x 72. Grid index 0 is the *bottom*
// left cell (`getPixelFromScaledDimensions`), which is why the rows below carry the higher indices
// the further up they sit.
//
//   rows 16-23  ->  y  0-23   two rooms next to each other
//   row  15     ->  y 24-26   a wall
//   rows  8-14  ->            empty
//   rows  0-7   ->  y 48-71   plain floor, and everything that is drawn on top of the bitmap:
//                             cleaning path, mop band, active zone, robot

const GRID = 24;
const CELL = 3;
const CANVAS = GRID * CELL;
const ROOM_A = 1;
const ROOM_B = 2;

/** Grid index of a cell, addressed as (row from the bottom, column). */
function cell(row: number, column: number): number {
	return row * GRID + column;
}

/** Top left pixel of a cell. */
function cellPixel(row: number, column: number): { x: number; y: number } {
	return { x: column * CELL, y: CANVAS - row * CELL - CELL };
}

function cells(rowFrom: number, rowTo: number, columnFrom: number, columnTo: number): number[] {
	const out: number[] = [];
	for (let row = rowFrom; row <= rowTo; row++) {
		for (let column = columnFrom; column <= columnTo; column++) out.push(cell(row, column));
	}
	return out;
}

/** Segment pixels carry their segment id in the upper bits (`px >>> 21`). */
function segmentCells(segmentId: number, indices: number[]): number[] {
	return indices.map((index) => (segmentId << 21) | index);
}

const ROOM_A_CELLS = cells(16, 23, 0, 11);
const ROOM_B_CELLS = cells(20, 23, 12, 23);

/** A sample cell well inside a room, plus the wall and a patch of untouched floor. */
const SAMPLE = {
	roomA: cellPixel(22, 3),
	roomB: cellPixel(22, 15),
	wall: cellPixel(15, 5),
	floor: cellPixel(0, 22)
};

/** Everything below this line is drawn *after* the segments and must never fade. */
const OVERLAY_TOP_Y = 48;

function createMapData(): Record<string, unknown> {
	return {
		mapFlag: 0,
		IMAGE: {
			position: { left: 0, top: 0 },
			dimensions: { width: GRID, height: GRID },
			pixels: {
				floor: cells(0, 7, 0, 23),
				obstacle: cells(15, 15, 0, 23),
				segments: [...segmentCells(ROOM_A, ROOM_A_CELLS), ...segmentCells(ROOM_B, ROOM_B_CELLS)]
			}
		},
		// Robot coordinates are millimetres; these land in the lower quarter of the canvas.
		PATH: { points: [[100, 175], [600, 175]] },
		CURRENTLY_CLEANED_ZONES: [[200, 100, 900, 300]],
		ROBOT_POSITION: { position: [575, 175], angle: 0 }
	};
}

// --- adapter stub -----------------------------------------------------------------------------

interface StubOptions {
	scheme: "light" | "dark";
	/** Room switches that are on, as `mapFlag -> room ids`. */
	selection?: Record<number, number[]>;
	/** Let the state read fail, to prove a map is still drawn. */
	failStateRead?: boolean;
}

function createAdapterStub(options: StubOptions): Record<string, unknown> {
	const namespace = "roborock.0";
	const duid = "duid1";
	const states: Record<string, { val: unknown }> = {};
	for (const [mapFlag, rooms] of Object.entries(options.selection ?? {})) {
		states[`${namespace}.Devices.${duid}.floors.${mapFlag}.name`] = { val: "Ground floor" };
		for (const roomId of rooms) {
			states[`${namespace}.Devices.${duid}.floors.${mapFlag}.${roomId}`] = { val: true };
		}
	}

	return {
		namespace,
		name: "roborock",
		config: { map_theme: options.scheme, map_color_scheme: options.scheme },
		getMapColorScheme: () => options.scheme,
		getStatesAsync: async (pattern: string) => {
			if (options.failStateRead) throw new Error("state read failed");
			const prefix = pattern.replace(/\*$/, "");
			return Object.fromEntries(Object.entries(states).filter(([id]) => id.startsWith(prefix)));
		},
		errorMessage: (e: unknown) => String(e),
		rLog: vi.fn(),
		fileExistsAsync: async () => false
	};
}

// --- rendering --------------------------------------------------------------------------------

/** The full, uncropped map as raw pixels. */
async function render(options: StubOptions, mapData: Record<string, unknown> = createMapData()): Promise<Uint8ClampedArray> {
	const builder = new MapBuilder(createAdapterStub(options) as never);
	const [, fullMap] = await builder.canvasMap(mapData, { duid: "duid1" });

	const image = await loadImage(fullMap);
	const canvas = createCanvas(CANVAS, CANVAS);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(image, 0, 0);
	return ctx.getImageData(0, 0, CANVAS, CANVAS).data;
}

/** Colour of one pixel as `#RRGGBB`. */
function colourAt(pixels: Uint8ClampedArray, point: { x: number; y: number }, dx = 1, dy = 1): string {
	const index = ((point.y + dy) * CANVAS + point.x + dx) * 4;
	return `#${[0, 1, 2].map((channel) => pixels[index + channel].toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

/** Independent re-derivation of the mix, so the expectation does not lean on the implementation. */
function mix(colour: string, ground: string, keep: number): string {
	const channel = (hex: string, offset: number): number => parseInt(hex.slice(1 + offset * 2, 3 + offset * 2), 16);
	const mixed = [0, 1, 2].map((offset) => Math.round(channel(colour, offset) * keep + channel(ground, offset) * (1 - keep)));
	return `#${mixed.map((value) => value.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

/** The muted colour belonging to the vivid one, i.e. the same colour bucket in the other palette. */
function normalCounterpart(highlight: string, scheme: "light" | "dark"): string {
	const [vivid, muted] = scheme === "dark"
		? [PALETTE_DARK_HIGHLIGHT, PALETTE_DARK_NORMAL]
		: [PALETTE_LIGHT_HIGHLIGHT, PALETTE_LIGHT_NORMAL];
	const bucket = vivid.findIndex((entry) => entry.slice(0, 7).toUpperCase() === highlight.toUpperCase());
	expect(bucket, `room colour ${highlight} is not part of the ${scheme} highlight palette`).toBeGreaterThan(0);
	return muted[bucket].slice(0, 7);
}

describe("the fade factors are the ones the app uses", () => {
	it("keeps 30 % of the base bitmap in light mode and 70 % in dark mode", () => {
		expect(SELECTION_FADE_LIGHT).toBe(0.3);
		expect(SELECTION_FADE_DARK).toBe(0.7);
		expect(getSelectionFadeFactor("light")).toBe(SELECTION_FADE_LIGHT);
		expect(getSelectionFadeFactor("dark")).toBe(SELECTION_FADE_DARK);
	});

	it("treats an unknown scheme as light, like every other colour decision in the adapter", () => {
		expect(getSelectionFadeFactor(undefined)).toBe(SELECTION_FADE_LIGHT);
		expect(getSelectionFadeFactor("Dark")).toBe(SELECTION_FADE_LIGHT);
	});
});

describe("fading a single colour", () => {
	it("mixes towards the target by the given share", () => {
		expect(fadeHexTowards("#FFFFFF", "#000000", 0.3)).toBe("#4D4D4D");
		expect(fadeHexTowards("#FFFFFF", "#000000", 0.7)).toBe("#B3B3B3");
		expect(fadeHexTowards("#000000", "#FFFFFF", 0)).toBe("#FFFFFF");
	});

	it("returns the colour untouched when nothing fades", () => {
		expect(fadeHexTowards("#98C9FF", "#E9E9E9", 1)).toBe("#98C9FF");
	});

	it("accepts the palette entries that carry a trailing alpha", () => {
		expect(fadeHexTowards("#DFDFDFff", "#DFDFDF", 0.3)).toBe("#DFDFDF");
	});

	it("passes anything it cannot read through instead of turning a room black", () => {
		expect(fadeHexTowards("rgba(1,2,3,1)", "#E9E9E9", 0.3)).toBe("rgba(1,2,3,1)");
		expect(fadeHexTowards("#98C9FF", "not a colour", 0.3)).toBe("#98C9FF");
	});
});

describe("fading the map surface", () => {
	it("fades the walls towards the ground and leaves the path alone", () => {
		const faded = fadeSurfaceColors(LEGACY_COLORS, SELECTION_FADE_LIGHT);

		expect(faded.obstacle).toBe(mix(LEGACY_COLORS.obstacle, LEGACY_COLORS.floor, SELECTION_FADE_LIGHT));
		expect(faded.path).toBe(LEGACY_COLORS.path);
		// The ground is what everything fades towards, so it cannot fade itself.
		expect(faded.floor.toUpperCase()).toBe(LEGACY_COLORS.floor.toUpperCase());
	});

	it("does the same on the dark set", () => {
		const faded = fadeSurfaceColors(DARK_MAP_COLORS, SELECTION_FADE_DARK);

		expect(faded.obstacle).toBe(mix(DARK_MAP_COLORS.obstacle, DARK_MAP_COLORS.floor, SELECTION_FADE_DARK));
		expect(faded.path).toBe(DARK_MAP_COLORS.path);
	});

	it("does not modify the colour set it was given", () => {
		const input = { ...LEGACY_COLORS };
		fadeSurfaceColors(input, SELECTION_FADE_LIGHT);
		expect(input).toEqual(LEGACY_COLORS);
	});
});

describe("a rendered map with a room selection", () => {
	let withoutSelection: Uint8ClampedArray;

	beforeEach(async () => {
		withoutSelection = await render({ scheme: "light" });
	});

	it("leaves the picture untouched when nothing is selected", async () => {
		// The promise of the whole feature: a user who selects nothing sees what they saw before.
		const again = await render({ scheme: "light", selection: {} });
		expect(Array.from(again)).toEqual(Array.from(withoutSelection));
	});

	it("keeps the selected room in its full colour and fades the other one into the ground", async () => {
		const selected = await render({ scheme: "light", selection: { 0: [ROOM_A] } });

		const roomAVivid = colourAt(withoutSelection, SAMPLE.roomA);
		expect(colourAt(selected, SAMPLE.roomA)).toBe(roomAVivid);

		const roomBVivid = colourAt(withoutSelection, SAMPLE.roomB);
		expect(colourAt(selected, SAMPLE.roomB)).toBe(
			mix(normalCounterpart(roomBVivid, "light"), LEGACY_COLORS.floor, SELECTION_FADE_LIGHT)
		);
	});

	it("fades the walls with the rooms, because they are part of the same bitmap", async () => {
		const selected = await render({ scheme: "light", selection: { 0: [ROOM_A] } });

		expect(colourAt(withoutSelection, SAMPLE.wall)).toBe(LEGACY_COLORS.obstacle.toUpperCase());
		expect(colourAt(selected, SAMPLE.wall)).toBe(
			mix(LEGACY_COLORS.obstacle, LEGACY_COLORS.floor, SELECTION_FADE_LIGHT)
		);
	});

	it("leaves the ground itself alone", async () => {
		const selected = await render({ scheme: "light", selection: { 0: [ROOM_A] } });

		expect(colourAt(selected, SAMPLE.floor)).toBe(colourAt(withoutSelection, SAMPLE.floor));
	});

	it("keeps path, mop band, active zone and robot fully opaque", async () => {
		// Everything drawn after the segments sits in the lower quarter of this fixture, on ground
		// that the fade cannot change. Any difference there would mean a layer faded along.
		const selected = await render({ scheme: "light", selection: { 0: [ROOM_A] } });

		const differing: string[] = [];
		for (let y = OVERLAY_TOP_Y; y < CANVAS; y++) {
			for (let x = 0; x < CANVAS; x++) {
				const index = (y * CANVAS + x) * 4;
				for (let channel = 0; channel < 4; channel++) {
					if (selected[index + channel] !== withoutSelection[index + channel]) {
						differing.push(`${x},${y}`);
						break;
					}
				}
			}
		}
		expect(differing).toEqual([]);
	});

	it("uses the milder factor in dark mode, so the map does not collapse into the ground", async () => {
		const darkPlain = await render({ scheme: "dark" });
		const darkSelected = await render({ scheme: "dark", selection: { 0: [ROOM_A] } });

		expect(colourAt(darkSelected, SAMPLE.roomA)).toBe(colourAt(darkPlain, SAMPLE.roomA));
		expect(colourAt(darkSelected, SAMPLE.roomB)).toBe(
			mix(normalCounterpart(colourAt(darkPlain, SAMPLE.roomB), "dark"), DARK_MAP_COLORS.floor, SELECTION_FADE_DARK)
		);
		expect(colourAt(darkSelected, SAMPLE.wall)).toBe(
			mix(DARK_MAP_COLORS.obstacle, DARK_MAP_COLORS.floor, SELECTION_FADE_DARK)
		);
	});

	it("ignores the room switches of a different floor", async () => {
		// Room ids repeat across the maps of one robot: floor 1 saying "room 1" says nothing about
		// the room 1 of this map.
		const otherFloor = await render({ scheme: "light", selection: { 1: [ROOM_A] } });
		expect(Array.from(otherFloor)).toEqual(Array.from(withoutSelection));
	});

	it("ignores a selection when the map does not know which floor it belongs to", async () => {
		const mapWithoutFlag = createMapData();
		delete mapWithoutFlag.mapFlag;

		const rendered = await render({ scheme: "light", selection: { 0: [ROOM_A] } }, mapWithoutFlag);
		expect(Array.from(rendered)).toEqual(Array.from(withoutSelection));
	});

	it("still draws a map when the room switches cannot be read", async () => {
		const rendered = await render({ scheme: "light", selection: { 0: [ROOM_A] }, failStateRead: true });
		expect(Array.from(rendered)).toEqual(Array.from(withoutSelection));
	});

	it("lets a running cleaning win over a leftover selection", async () => {
		const running = createMapData();
		running.CURRENTLY_CLEANED_BLOCKS = [ROOM_B];

		const rendered = await render({ scheme: "light", selection: { 0: [ROOM_A] } }, running);

		// Room B is being cleaned, so it keeps its colour and room A - merely selected - fades.
		expect(colourAt(rendered, SAMPLE.roomB)).toBe(colourAt(withoutSelection, SAMPLE.roomB));
		expect(colourAt(rendered, SAMPLE.roomA)).toBe(
			mix(normalCounterpart(colourAt(withoutSelection, SAMPLE.roomA), "light"), LEGACY_COLORS.floor, SELECTION_FADE_LIGHT)
		);
	});
});
