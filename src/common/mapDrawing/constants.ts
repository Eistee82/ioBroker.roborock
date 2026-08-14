/** Shared map drawing constants. Single source for V1 map scale and colors. */
export const VISUAL_BLOCK_SIZE = 3;

export const ROBOROCK_PALETTE = [
	"#DFDFDFff", "#50A4FF", "#FF744D", "#008FA8", "#F5AF10", "#E9E9E9ff"
];

/** Which of the two colour sets the map bitmap is painted with. */
export type MapColorScheme = "light" | "dark";

/**
 * The three colours that make up the map surface: everything the robot has explored but that
 * carries no room colour, the walls around it, and the line it drove.
 *
 * Room fills are not part of this - they come from the palettes in `src/lib/roomColoring.ts`,
 * which have their own light/dark split (adapter option `map_theme`).
 */
export interface MapSurfaceColors {
	/** Explored ground without a segment of its own. */
	floor: string;
	/** Walls and obstacles. */
	obstacle: string;
	/** The line the robot drove. */
	path: string;
}

/**
 * The light set - byte for byte the picture the adapter has always produced.
 *
 * `floor` and `obstacle` used to read `#23465e` / `#2b2e30` here, but nothing drew with them:
 * since the drawing was unified in `drawMapV1` the two values were written as literals into that
 * file and this object was only read for `path`. The literals are what every existing user sees,
 * so they are what the light set has to contain; the two stale values are gone rather than kept
 * as a second, wrong answer to the same question.
 *
 * `obstacle` is additionally the exact colour the Roborock app uses for walls in its light theme:
 * palette entry 42 of the indexed PNG the app builds (`#6B7174`).
 */
export const LEGACY_COLORS: MapSurfaceColors = {
	floor: "#E9E9E9",
	obstacle: "#6B7174",
	path: "#FFFFFF",
};

/**
 * The dark set, taken from the Roborock control plugin `roborock.vacuum.a65_control_v5208`
 * (decompiled Hermes bundle, `_appanalysis/plugins/a65_control_v5208/`).
 *
 * The app builds its map as an indexed PNG with a fixed 53-entry palette and picks *indices* per
 * theme, so both sets come from the same table:
 *
 * - Z. 556661-556692 chooses the indices: `obstacles` = 42 light / 43 dark, `space` = 4 light /
 *   25 dark. The theme flag steering that choice is the second parameter of the parse function
 *   (Z. 556599); that it means "dark" is proven a few lines further down, where the same flag
 *   swaps `colorIndexMap` for `colorIndexMapDark` (Z. 556767-556779).
 * - Z. 547945-548498 writes the palette itself byte by byte (PLTE chunk, 53 x 3 bytes): index 25
 *   is `#6D6D6D`, index 43 is `#6D7476`.
 * - `path` is the app's own `pathColor` of the dark theme block, Z. 313188 (`#FFFFFF99`); the
 *   light block at Z. 303345 carries `#FFFFFFff`, which is the value above.
 *
 * The floor is the one colour that differs from the app in the light set (`#E9E9E9` here against
 * the app's `#BBBBBB`): changing it would repaint every existing installation, which this feature
 * must not do.
 */
export const DARK_MAP_COLORS: MapSurfaceColors = {
	floor: "#6D6D6D",
	obstacle: "#6D7476",
	path: "#FFFFFF99",
};

/**
 * The surface colours for a scheme.
 * @param scheme Which set to use; anything but `"dark"` yields the light set, so an unknown or
 * missing value can never repaint an existing installation.
 */
export function getMapSurfaceColors(scheme: MapColorScheme | string | undefined | null): MapSurfaceColors {
	return scheme === "dark" ? DARK_MAP_COLORS : LEGACY_COLORS;
}

export function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return [r, g, b, alpha];
}

/** For ctx.fillStyle / SVG fill (0–255 alpha). */
export function hexToRgbaString(hex: string, alpha = 255): string {
	const [r, g, b, a] = hexToRgba(hex, alpha);
	return `rgba(${r},${g},${b},${a / 255})`;
}
