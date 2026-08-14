import { describe, expect, it, vi } from "vitest";

import {
	DARK_MAP_COLORS,
	getMapSurfaceColors,
	LEGACY_COLORS,
	hexToRgbaString
} from "../../src/common/mapDrawing/constants";
import { drawMapV1 } from "../../src/common/mapDrawing/drawMapV1";
import type { V1MapDataForDrawing } from "../../src/common/mapDrawing/drawMapV1";
import type { DrawRect, IMapRenderer } from "../../src/common/mapDrawing/types";
import {
	DEFAULT_MAP_COLOR_SCHEME,
	isReportableMapTheme,
	resolveMapColorScheme
} from "../../src/lib/map/mapColorScheme";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * The map bitmap is painted by the adapter, so a dark admin cannot change it from the browser.
 * These tests pin the two things that decide the picture: which colours each scheme uses, and how
 * the configured option plus the theme a browser reported turn into one of them.
 *
 * The single hardest requirement is that an installation which changes nothing keeps exactly the
 * image it has today - hence the literal expectations on the light set below.
 */

/** Colours that produced the map before the dark scheme existed. Never to be changed silently. */
const PICTURE_OF_TODAY = {
	floor: "#E9E9E9",
	obstacle: "#6B7174",
	path: "#FFFFFF"
};

/** Records every rect and stroke a drawing pass produced. */
function createRecordingRenderer(): { renderer: IMapRenderer; fills: string[]; strokes: string[] } {
	const fills: string[] = [];
	const strokes: string[] = [];
	const renderer: IMapRenderer = {
		drawFloor: (rects: DrawRect[]) => rects.forEach((r) => fills.push(r.fill)),
		drawSegmentRects: (rects: DrawRect[]) => rects.forEach((r) => fills.push(r.fill)),
		drawCarpet: () => undefined,
		drawPath: (input) => strokes.push(input.stroke),
		drawRobot: () => undefined,
		drawCharger: () => undefined,
		drawGoToPin: () => undefined,
		drawObstacles: () => undefined,
		drawRoomLabels: () => undefined,
		drawActiveZones: () => undefined,
		drawRestrictedZones: () => undefined,
		drawPredictedPath: () => undefined
	};
	return { renderer, fills, strokes };
}

/** Two floor pixels, one obstacle pixel and a two-point path - enough to exercise every colour. */
function createMapFixture(): V1MapDataForDrawing {
	return {
		IMAGE: {
			position: { left: 0, top: 0 },
			dimensions: { width: 4, height: 4 },
			pixels: { floor: [0, 1], obstacle: [5], segments: [] }
		},
		PATH: { points: [[100, 100], [200, 200]] }
	};
}

describe("map surface colours", () => {
	it("keeps the light set at the values that produced today's picture", () => {
		// Not a tautology: these three literals used to sit inside drawMapV1 and are what every
		// existing installation shows. If someone "tidies" them, this test is the alarm.
		expect(LEGACY_COLORS).toEqual(PICTURE_OF_TODAY);
	});

	it("uses the colours proven in the Roborock control plugin for the dark set", () => {
		// _appanalysis/plugins/a65_control_v5208: PLTE index 25 (`space`, dark) and 43
		// (`obstacles`, dark); `pathColor` of the dark theme block at line 313188.
		expect(DARK_MAP_COLORS).toEqual({
			floor: "#6D6D6D",
			obstacle: "#6D7476",
			path: "#FFFFFF99"
		});
	});

	it("hands out the dark set only for the exact string 'dark'", () => {
		expect(getMapSurfaceColors("dark")).toBe(DARK_MAP_COLORS);
		expect(getMapSurfaceColors("light")).toBe(LEGACY_COLORS);
		// Anything unexpected must not repaint a working installation.
		for (const value of [undefined, null, "", "auto", "Dark", "DARK", "true"]) {
			expect(getMapSurfaceColors(value), String(value)).toBe(LEGACY_COLORS);
		}
	});
});

describe("resolveMapColorScheme", () => {
	it("defaults to light so nothing changes without a decision", () => {
		expect(DEFAULT_MAP_COLOR_SCHEME).toBe("light");
		expect(resolveMapColorScheme(undefined, undefined)).toBe("light");
		expect(resolveMapColorScheme(undefined, "dark")).toBe("light");
	});

	it("ignores the reported theme while a fixed scheme is configured", () => {
		expect(resolveMapColorScheme("light", "dark")).toBe("light");
		expect(resolveMapColorScheme("dark", "light")).toBe("dark");
	});

	it("follows the reported theme in auto mode", () => {
		expect(resolveMapColorScheme("auto", "dark")).toBe("dark");
		expect(resolveMapColorScheme("auto", "light")).toBe("light");
	});

	it("stays light in auto mode until a browser has reported", () => {
		expect(resolveMapColorScheme("auto", null)).toBe("light");
		expect(resolveMapColorScheme("auto", undefined)).toBe("light");
		expect(resolveMapColorScheme("auto", "blue")).toBe("light");
	});

	it("accepts only the two theme names a browser may report", () => {
		expect(isReportableMapTheme("light")).toBe(true);
		expect(isReportableMapTheme("dark")).toBe(true);
		for (const value of ["auto", "", "Dark", 1, true, null, undefined, {}]) {
			expect(isReportableMapTheme(value), String(value)).toBe(false);
		}
	});
});

describe("drawMapV1 paints with the scheme it is given", () => {
	it("produces today's picture when no colours are passed", async () => {
		const { renderer, fills, strokes } = createRecordingRenderer();
		await drawMapV1(createMapFixture(), renderer);

		expect(fills).toContain(hexToRgbaString(PICTURE_OF_TODAY.floor));
		expect(fills).toContain(hexToRgbaString(PICTURE_OF_TODAY.obstacle));
		expect(strokes).toContain(PICTURE_OF_TODAY.path);
	});

	it("switches floor, walls and the driven line to the dark set", async () => {
		const { renderer, fills, strokes } = createRecordingRenderer();
		await drawMapV1(createMapFixture(), renderer, { colors: DARK_MAP_COLORS });

		expect(fills).toContain(hexToRgbaString(DARK_MAP_COLORS.floor));
		expect(fills).toContain(hexToRgbaString(DARK_MAP_COLORS.obstacle));
		expect(strokes).toContain(DARK_MAP_COLORS.path);
		expect(fills).not.toContain(hexToRgbaString(PICTURE_OF_TODAY.floor));
		expect(fills).not.toContain(hexToRgbaString(PICTURE_OF_TODAY.obstacle));
	});
});

describe("the way the theme reaches the adapter", () => {
	it("watches the mapTheme state, otherwise a hand written value would do nothing", async () => {
		const { Roborock } = await import("../../src/main");
		const adapter = Object.create(Roborock.prototype);
		expect(adapter.getSubscriptionPatterns(["commands"])).toContain("mapTheme");
	});

	it("resolves the scheme from the config and the last reported theme", async () => {
		const { Roborock } = await import("../../src/main");
		const adapter = Object.create(Roborock.prototype);

		adapter.config = { map_color_scheme: "auto" };
		adapter.reportedMapTheme = null;
		expect(adapter.getMapColorScheme()).toBe("light");

		adapter.reportedMapTheme = "dark";
		expect(adapter.getMapColorScheme()).toBe("dark");

		adapter.config = { map_color_scheme: "light" };
		expect(adapter.getMapColorScheme()).toBe("light");
	});

	it("repaints the stored maps only when the resolved scheme really changed", async () => {
		const { Roborock } = await import("../../src/main");
		const adapter = Object.create(Roborock.prototype);
		const repaint = vi.fn().mockResolvedValue(undefined);
		const written: unknown[] = [];

		adapter.config = { map_color_scheme: "auto" };
		adapter.reportedMapTheme = null;
		adapter.mapManager = { repaintStoredMaps: repaint };
		adapter.setState = async (_id: string, value: unknown) => {
			written.push(value);
		};
		adapter.rLog = () => undefined;

		await adapter.setReportedMapTheme("dark");
		expect(repaint).toHaveBeenCalledTimes(1);

		// Same theme again: nothing to store, nothing to repaint.
		await adapter.setReportedMapTheme("dark");
		expect(repaint).toHaveBeenCalledTimes(1);
		expect(written).toHaveLength(1);

		await adapter.setReportedMapTheme("light");
		expect(repaint).toHaveBeenCalledTimes(2);
	});

	it("remembers a report but does not repaint while a fixed scheme is configured", async () => {
		const { Roborock } = await import("../../src/main");
		const adapter = Object.create(Roborock.prototype);
		const repaint = vi.fn().mockResolvedValue(undefined);

		adapter.config = { map_color_scheme: "light" };
		adapter.reportedMapTheme = null;
		adapter.mapManager = { repaintStoredMaps: repaint };
		adapter.setState = async () => undefined;
		adapter.rLog = () => undefined;

		await adapter.setReportedMapTheme("dark");
		expect(repaint).not.toHaveBeenCalled();
		expect(adapter.reportedMapTheme).toBe("dark");

		// The report was kept, so switching the option to auto is enough to go dark.
		adapter.config = { map_color_scheme: "auto" };
		expect(adapter.getMapColorScheme()).toBe("dark");
	});
});
