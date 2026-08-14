import { describe, expect, it } from "vitest";
import { ASSET_BASE, OBSTACLE_MAPPING, obstacleAssetFileName, obstacleAssetFileNameAlt } from "./MapEngine";
import { ASSET_DENSITY_FOLDER, modeIconUrl } from "./modeIcons";

/**
 * Where the device artwork is fetched from.
 *
 * The obstacle icons shipped once with a prefix that resolved to nothing after the UI moved out
 * of the web adapter into the admin tab, and every user saw "image cannot be loaded". Nothing in
 * the type system or the build catches that: the prefix is a string, a wrong string is still a
 * string, and the failure only appears in a browser that has the files.
 *
 * So the two properties that actually broke are pinned here:
 *
 *  1. the prefix is **relative** - an absolute `/files/…` breaks an admin behind a reverse proxy
 *     that mounts it under a sub path,
 *  2. it climbs from `…/adapter/roborock/tab.html` to `…/files/roborock/…`, which is exactly two
 *     levels.
 */

describe("ASSET_BASE", () => {
	it("is relative, never absolute and never a full origin", () => {
		expect(ASSET_BASE.startsWith("/")).toBe(false);
		expect(ASSET_BASE).not.toMatch(/^[a-z]+:\/\//i);
		expect(ASSET_BASE.startsWith("../")).toBe(true);
	});

	it("climbs exactly two levels, from the tab's folder to the adapter's file store", () => {
		// The tab is served at `…/adapter/roborock/tab.html`; the files live at `…/files/roborock/…`.
		const segments = ASSET_BASE.split("/");
		expect(segments.filter(segment => segment === "..")).toHaveLength(2);
		expect(segments.slice(0, 2)).toEqual(["..", ".."]);
		expect(segments.slice(2)).toEqual(["files", "roborock", "assets"]);
	});

	it("resolves against the tab's URL to the adapter's file store", () => {
		// The property the browser actually applies, checked with the browser's own resolver
		// instead of by reading the string.
		const resolved = new URL(`${ASSET_BASE}/roborock.vacuum.a65/`, "http://ioBroker:8081/adapter/roborock/tab.html");
		expect(resolved.pathname).toBe("/files/roborock/assets/roborock.vacuum.a65/");
	});

	it("keeps resolving correctly when the admin sits behind a reverse proxy sub path", () => {
		// This is what an absolute `/files/…` would have got wrong.
		const resolved = new URL(`${ASSET_BASE}/roborock.vacuum.a65/`, "https://home.example/iobroker/adapter/roborock/tab.html");
		expect(resolved.pathname).toBe("/iobroker/files/roborock/assets/roborock.vacuum.a65/");
	});
});

describe("mode icon URLs built on the real asset base", () => {
	const base = `${ASSET_BASE}/roborock.vacuum.a65`;

	it("stays relative all the way to the file name", () => {
		const url = modeIconUrl(base, "set_custom_mode", "102", "light");
		expect(url).not.toBeNull();
		expect(url?.startsWith("/")).toBe(false);
		expect(url).not.toMatch(/^[a-z]+:\/\//i);
	});

	it("lands on the density folder the map already reads its own graphics from", () => {
		const url = modeIconUrl(base, "set_custom_mode", "102", "light");
		const resolved = new URL(url as string, "http://ioBroker:8081/adapter/roborock/tab.html");
		expect(resolved.pathname).toBe(
			"/files/roborock/assets/roborock.vacuum.a65/drawable-mdpi/" +
				"projects_comroborocktanos_theme_light_resources_mode_setting_clean2_normal_light.png",
		);
		expect(ASSET_DENSITY_FOLDER).toBe("drawable-mdpi");
	});
});

describe("obstacle asset names", () => {
	it("produces a bare file name, so the caller decides the folder", () => {
		// A name that carried its own path would defeat the relative prefix above.
		for (const name of [obstacleAssetFileName("7"), obstacleAssetFileNameAlt("7")]) {
			expect(name).not.toContain("/");
			expect(name.endsWith(".png")).toBe(true);
		}
	});

	it("uses the two families the control plugin ships", () => {
		expect(obstacleAssetFileName("42")).toBe("projects_comroborocktanos_resources_obstacle_new_p42.png");
		expect(obstacleAssetFileNameAlt("42")).toBe("projects_comroborocktanos_resources_map_object_top_42.png");
		expect(obstacleAssetFileName("42")).not.toBe(obstacleAssetFileNameAlt("42"));
	});

	it("resolves to the file store when joined to the base the engine uses", () => {
		const url = `${ASSET_BASE}/roborock.vacuum.a65/${ASSET_DENSITY_FOLDER}/${obstacleAssetFileName("9")}`;
		const resolved = new URL(url, "http://ioBroker:8081/adapter/roborock/tab.html");
		expect(resolved.pathname).toBe(
			"/files/roborock/assets/roborock.vacuum.a65/drawable-mdpi/projects_comroborocktanos_resources_obstacle_new_p9.png",
		);
	});

	it("maps robot obstacle types to suffixes, including the one that is deliberately off by one", () => {
		// Type 50 renders the p49 artwork; p50 is the wrong picture for it.
		expect(OBSTACLE_MAPPING[50]).toBe("49");
		expect(OBSTACLE_MAPPING[-99]).toBe("99");
		expect(OBSTACLE_MAPPING[0]).toBe("0");
	});

	it("keeps every suffix a bare asset token, so no name can smuggle in a path", () => {
		// A number, optionally with a region tag - type 5 is `5_cn`. Nothing that could contain a
		// slash, a `..` or a scheme and thereby escape the file store folder.
		for (const [type, suffix] of Object.entries(OBSTACLE_MAPPING)) {
			expect(suffix, `type ${type}`).toMatch(/^\d+(_[a-z]+)?$/);
		}
	});
});
