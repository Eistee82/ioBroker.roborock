/**
 * The colours of everything the tab draws **on top of** the map bitmap: the cleaning zones with
 * their frame and handles, and the marker on a picked room.
 *
 * ## Why these follow the map and not the tab
 *
 * The map is a PNG the **adapter** paints, and it has its own light/dark decision: the option
 * `map_color_scheme` (`light` / `dark` / `auto`), resolved against the theme a browser reported
 * (`src/lib/map/mapColorScheme.ts`). The admin tab has a second, independent one - the admin's
 * own theme. The two run apart on purpose: an admin in dark mode with the option pinned to
 * `light` shows a light map inside a dark page.
 *
 * A zone lies **on the map**, so it has to read against the map. Anything that followed the tab
 * theme instead would be white-on-white in exactly that configuration. The adapter therefore
 * publishes the resolved scheme in the state `mapColorScheme`, and `MapEngine` subscribes to it;
 * see {@link MAP_COLOR_SCHEME_STATE}.
 *
 * ## Where the values come from
 *
 * The Roborock app keeps two sets and picks by the ground it draws on. Proven in the control
 * plugin of the a65 (`roborock.vacuum.a65_control_v5208`, decompiled Hermes bundle;
 * `_appanalysis/17-raumauswahl.md`), light block at A65:303524, dark block at A65:313366:
 *
 *     light   cleanRectColor #007AFF33   cleanRectBorderColor #007AFF   focusViewColor rgba(0,0,0,0.2)
 *     dark    cleanRectColor #FFFFFF4D   cleanRectBorderColor #ffffff   focusViewColor rgba(255,255,255,0.2)
 *
 * `focusViewColor` is the dashed frame around a rectangle under editing and the line its move
 * handle hangs on - §B.3 of the report proves that positively (A65:511145, A65:511344-511366),
 * against an earlier suspicion that it had to do with the room highlight.
 *
 * Two things the app gives us **no** value for, so they are ours and marked as such below:
 *
 *  - the **discs behind the handle glyphs**: the app draws six ready-made images out of
 *    `theme.displayZones`, and those files are not in the downloaded plugin package (§B.5.2);
 *  - the **room marker**: the app does not have one. It highlights a picked room by laying a
 *    separate transparent PNG of that room over the map (§7), which needs the room geometry the
 *    tab does not have. Our marker is a pill behind the room name instead.
 *
 * Both are derived from the proven pair by one rule, stated once so it is not re-invented per
 * element: **a surface takes the ground's own direction, and whatever sits on it takes the
 * opposite.** On the light map that means a near-white backing carrying the app's blue; on the
 * dark map a near-black backing carrying the app's white. The room marker is the one place where
 * the marker itself is the accent - it means "picked" and has to say so - so there the pill is
 * the app's colour and the name on it takes the contrast.
 */

/** Which of the two colour sets the map bitmap is painted with; mirrors the adapter's type. */
export type MapColorScheme = "light" | "dark";

/**
 * State the adapter publishes the resolved scheme in, relative to the instance.
 *
 * Deliberately not `mapTheme`: that one carries what a *browser reported* and is only one of the
 * two inputs. What the overlays need is the answer, which is `resolveMapColorScheme(option,
 * reported)` - and with the option pinned to `light` or `dark` the reported theme does not
 * survive into it at all.
 */
export const MAP_COLOR_SCHEME_STATE = "mapColorScheme";

/** Every colour the tab paints over the map bitmap with. */
export interface MapOverlayColors {
	/** Body of a cleaning zone (`cleanRectColor`). */
	zoneFill: string;
	/** Edge of a cleaning zone (`cleanRectBorderColor`). */
	zoneStroke: string;
	/** Dashed focus frame and the leash of the move handle (`focusViewColor`). */
	focusView: string;
	/** Disc behind a handle glyph - ours, the app ships artwork instead. */
	handleBacking: string;
	/** Glyph and rim on that disc. */
	handleInk: string;
	/**
	 * Disc behind the delete glyph, which the app draws red rather than in the neutral tone.
	 *
	 * The value is the app's own error red, taken from the same two theme blocks as everything
	 * else here: `allFBZBorderColor`, the edge it draws a no-go zone with (A65:303524 light,
	 * A65:313366 dark). Borrowed rather than invented so the one warning colour on the map is one
	 * colour, and so it follows the map scheme like the rest.
	 */
	deleteBacking: string;
	/** Glyph and rim on the red disc; white in both sets, see {@link LIGHT_MAP_OVERLAY_COLORS}. */
	deleteInk: string;
	/** Body of the pill behind a picked room's name - ours, see the module comment. */
	roomSelectionFill: string;
	/** Rim of that pill and the name on it; the contrast to {@link roomSelectionFill}. */
	roomSelectionInk: string;
}

/**
 * The set for a light map.
 *
 * The pill is the app's blue with the name in white: it marks a choice, and on a light ground a
 * white pill would be a shape without a signal.
 *
 * `deleteInk` is the one value both sets share, and deliberately: it sits on the app's error red,
 * which is dark enough for white in either variant. Giving the light map a dark X to be "the
 * opposite of its ground" would ignore what the X actually stands on.
 */
export const LIGHT_MAP_OVERLAY_COLORS: MapOverlayColors = {
	zoneFill: "#007AFF33",
	zoneStroke: "#007AFF",
	focusView: "rgba(0, 0, 0, 0.2)",
	handleBacking: "rgba(255, 255, 255, 0.92)",
	handleInk: "#007AFF",
	deleteBacking: "#FF5E4A",
	deleteInk: "#ffffff",
	roomSelectionFill: "rgba(0, 122, 255, 0.92)",
	roomSelectionInk: "#ffffff",
};

/**
 * The set for a dark map.
 *
 * This is the one the tab drew with unconditionally before the light map existed, with one
 * correction: the frame and the leash were `rgba(255, 255, 255, 0.45)` while the comment above
 * them already named the app's 20 % wash. The proven value wins.
 */
export const DARK_MAP_OVERLAY_COLORS: MapOverlayColors = {
	zoneFill: "#FFFFFF4D",
	zoneStroke: "#ffffff",
	focusView: "rgba(255, 255, 255, 0.2)",
	handleBacking: "rgba(0, 0, 0, 0.55)",
	handleInk: "#ffffff",
	deleteBacking: "#E4432E",
	deleteInk: "#ffffff",
	roomSelectionFill: "rgba(255, 255, 255, 0.95)",
	roomSelectionInk: "#111111",
};

/**
 * The overlay colours for a scheme.
 *
 * Anything but the exact string `"dark"` yields the light set - the same fallback
 * `getMapSurfaceColors()` makes on the adapter side, and for the same reason: a missing state, a
 * value that never arrived or a typo must land the overlays on the same set the bitmap under them
 * uses, and `light` is what the adapter paints when in doubt.
 * @param scheme Value of the `mapColorScheme` state.
 * @returns One of the two frozen sets above.
 */
export function getMapOverlayColors(scheme: MapColorScheme | string | undefined | null): MapOverlayColors {
	return scheme === "dark" ? DARK_MAP_OVERLAY_COLORS : LIGHT_MAP_OVERLAY_COLORS;
}

/**
 * CSS custom property each colour is published under.
 *
 * The stylesheet may not repeat a value: `styles.css` and the renderer used to hold their own
 * copies, and an inline style beats a rule, so a change in the stylesheet was silently without
 * effect. Every colour therefore lives here once and reaches the stylesheet as a variable.
 */
export const MAP_OVERLAY_CSS_VARIABLES: Record<keyof MapOverlayColors, string> = {
	zoneFill: "--rr-zone-fill",
	zoneStroke: "--rr-zone-stroke",
	focusView: "--rr-zone-focus",
	handleBacking: "--rr-zone-handle-backing",
	handleInk: "--rr-zone-handle-ink",
	deleteBacking: "--rr-zone-delete-backing",
	deleteInk: "--rr-zone-delete-ink",
	roomSelectionFill: "--rr-room-selection-fill",
	roomSelectionInk: "--rr-room-selection-ink",
};

/**
 * The custom properties to set on the map surface for a scheme.
 * @param scheme Value of the `mapColorScheme` state.
 * @returns Property name to value, ready for `element.style.setProperty`.
 */
export function mapOverlayCssVariables(scheme: MapColorScheme | string | undefined | null): Record<string, string> {
	const colors = getMapOverlayColors(scheme);
	const variables: Record<string, string> = {};
	for (const key of Object.keys(MAP_OVERLAY_CSS_VARIABLES) as (keyof MapOverlayColors)[]) {
		variables[MAP_OVERLAY_CSS_VARIABLES[key]] = colors[key];
	}
	return variables;
}

/**
 * Whether a value is one of the two scheme names.
 *
 * The state is writable from a script like any other, so what arrives is untrusted.
 * @param value Candidate value.
 * @returns True for exactly `"light"` or `"dark"`.
 */
export function isMapColorScheme(value: unknown): value is MapColorScheme {
	return value === "light" || value === "dark";
}
