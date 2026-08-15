import { describe, expect, it } from "vitest";
import {
	DARK_MAP_OVERLAY_COLORS,
	LIGHT_MAP_OVERLAY_COLORS,
	MAP_COLOR_SCHEME_STATE,
	MAP_OVERLAY_CSS_VARIABLES,
	getMapOverlayColors,
	isMapColorScheme,
	mapOverlayCssVariables,
} from "./mapOverlayColors";
import type { MapOverlayColors } from "./mapOverlayColors";

/**
 * The colours the tab paints over the map bitmap with.
 *
 * Two things are worth a test here and nothing else is. First, the four values the Roborock
 * control plugin proves - a typo in one of them cannot be seen in a diff and would put a white
 * zone on a white map. Second, the fallback: everything that is not exactly `"dark"` has to land
 * on the light set, because that is what the adapter paints when it cannot decide either, and
 * overlays on the wrong set are invisible rather than merely off-colour.
 */

/**
 * Proven in `roborock.vacuum.a65_control_v5208`, A65:303524 (light) / A65:313366 (dark) - the two
 * theme blocks are single lines holding all of these keys, so all four values below come from the
 * same pair of finds.
 */
const PROVEN = {
	light: {
		zoneFill: "#007AFF33",
		zoneStroke: "#007AFF",
		focusView: "rgba(0, 0, 0, 0.2)",
		/** `allFBZBorderColor`, the app's no-go-zone edge - its one warning colour on the map. */
		deleteBacking: "#FF5E4A",
	},
	dark: {
		zoneFill: "#FFFFFF4D",
		zoneStroke: "#ffffff",
		focusView: "rgba(255, 255, 255, 0.2)",
		deleteBacking: "#E4432E",
	},
};

/**
 * Values the two sets share on purpose.
 *
 * Only one, and it needs its reason on record: the X sits on the app's error red in both sets,
 * which is dark enough for white either way. Everything else must differ - a value forgotten in
 * one of the two sets is exactly the bug this module was written to remove.
 */
const SHARED_BY_DESIGN: (keyof MapOverlayColors)[] = ["deleteInk"];

describe("the two overlay colour sets", () => {
	it("carries the app's own cleanRect, focusView and no-go-zone colours", () => {
		expect(LIGHT_MAP_OVERLAY_COLORS).toMatchObject(PROVEN.light);
		expect(DARK_MAP_OVERLAY_COLORS).toMatchObject(PROVEN.dark);
	});

	it("keeps the two sets apart in every value that is not shared on purpose", () => {
		for (const key of Object.keys(LIGHT_MAP_OVERLAY_COLORS) as (keyof MapOverlayColors)[]) {
			if (SHARED_BY_DESIGN.includes(key)) continue;
			expect(LIGHT_MAP_OVERLAY_COLORS[key], key).not.toBe(DARK_MAP_OVERLAY_COLORS[key]);
		}
	});

	it("shares exactly the values listed as shared, and no others", () => {
		// The exemption above must not quietly grow into a licence for a one-set palette.
		const shared = (Object.keys(LIGHT_MAP_OVERLAY_COLORS) as (keyof MapOverlayColors)[]).filter(
			(key) => LIGHT_MAP_OVERLAY_COLORS[key] === DARK_MAP_OVERLAY_COLORS[key],
		);
		expect(shared).toEqual(SHARED_BY_DESIGN);
	});

	it("puts white on the red disc in both sets, so the X reads on it", () => {
		expect(LIGHT_MAP_OVERLAY_COLORS.deleteInk).toBe("#ffffff");
		expect(DARK_MAP_OVERLAY_COLORS.deleteInk).toBe("#ffffff");
		// And not the neutral handle ink, which is the app's blue on a light map.
		expect(LIGHT_MAP_OVERLAY_COLORS.deleteInk).not.toBe(LIGHT_MAP_OVERLAY_COLORS.handleInk);
	});
});

describe("getMapOverlayColors", () => {
	it("hands out the dark set only for the exact string 'dark'", () => {
		expect(getMapOverlayColors("dark")).toBe(DARK_MAP_OVERLAY_COLORS);
		expect(getMapOverlayColors("light")).toBe(LIGHT_MAP_OVERLAY_COLORS);
	});

	it("falls back to light for anything else, exactly as the adapter's map does", () => {
		for (const value of [undefined, null, "", "auto", "Dark", "DARK", "true"]) {
			expect(getMapOverlayColors(value), String(value)).toBe(LIGHT_MAP_OVERLAY_COLORS);
		}
	});
});

describe("the custom properties the stylesheet reads", () => {
	it("publishes every colour of the set, and only those", () => {
		const variables = mapOverlayCssVariables("dark");
		const names = Object.values(MAP_OVERLAY_CSS_VARIABLES);

		expect(Object.keys(variables).sort()).toEqual([...names].sort());
		expect(names).toHaveLength(Object.keys(DARK_MAP_OVERLAY_COLORS).length);
		for (const name of names) {
			expect(name.startsWith("--rr-"), name).toBe(true);
		}
	});

	it("carries the values of the requested scheme", () => {
		expect(mapOverlayCssVariables("dark")["--rr-zone-fill"]).toBe(PROVEN.dark.zoneFill);
		expect(mapOverlayCssVariables("light")["--rr-zone-fill"]).toBe(PROVEN.light.zoneFill);
		expect(mapOverlayCssVariables("dark")["--rr-zone-delete-backing"]).toBe(PROVEN.dark.deleteBacking);
		expect(mapOverlayCssVariables("light")["--rr-zone-delete-backing"]).toBe(PROVEN.light.deleteBacking);
		expect(mapOverlayCssVariables("nonsense")["--rr-zone-focus"]).toBe(PROVEN.light.focusView);
	});
});

describe("isMapColorScheme", () => {
	it("accepts the two scheme names and nothing else", () => {
		expect(isMapColorScheme("light")).toBe(true);
		expect(isMapColorScheme("dark")).toBe(true);
		for (const value of ["auto", "", "Dark", 1, true, null, undefined, {}]) {
			expect(isMapColorScheme(value), String(value)).toBe(false);
		}
	});

	it("names the state the adapter publishes the resolved scheme in", () => {
		// The adapter writes this id; a rename on either side breaks the tab silently, because a
		// state that never arrives looks exactly like a light map.
		expect(MAP_COLOR_SCHEME_STATE).toBe("mapColorScheme");
	});
});
