import { describe, expect, it } from "vitest";
import {
	ASSET_DENSITY_FOLDER,
	MODE_ICONS,
	modeIconFileName,
	modeIconUrl,
	usesShakeMopIcons,
	type ModeIconRef,
} from "./modeIcons";

/**
 * The mode icons are the one place in the tab where a wrong string produces a silently wrong
 * picture: `ModeIcon` probes the URL and renders nothing when it 404s, so a broken name looks
 * exactly like "this device has no artwork". Nothing shouts, so the assignment is pinned here.
 *
 * Two shipped defects live in this file's history and each has a test below:
 *
 *  - the water icons picked the standard family for devices with a vibrating mop module
 *    (`shaked_water` vs `water`),
 *  - the asset path was built absolute and pointed nowhere once the UI moved into the admin tab.
 */

/** A model that is in the vibrating-mop table, and one that deliberately is not. */
const SHAKE_MOP_MODEL = "roborock.vacuum.a65";
const PLAIN_MOP_MODEL = "roborock.vacuum.a147";

describe("usesShakeMopIcons", () => {
	it("recognises a model from the plugin's vibrating-mop table", () => {
		expect(usesShakeMopIcons(SHAKE_MOP_MODEL)).toBe(true);
		expect(usesShakeMopIcons("roborock.vacuum.a14")).toBe(true);
		expect(usesShakeMopIcons("roborock.vacuum.a97")).toBe(true);
	});

	it("falls back to the standard artwork for a model the table does not list", () => {
		// Newer devices may well belong in the table; showing the established icons is the safer
		// error, so an unknown model must answer false rather than throw or guess.
		expect(usesShakeMopIcons(PLAIN_MOP_MODEL)).toBe(false);
		expect(usesShakeMopIcons("roborock.vacuum.s5")).toBe(false);
		expect(usesShakeMopIcons("roborock.vacuum.a99999")).toBe(false);
	});

	it("treats a missing model as standard rather than crashing", () => {
		expect(usesShakeMopIcons(null)).toBe(false);
		expect(usesShakeMopIcons(undefined)).toBe(false);
		expect(usesShakeMopIcons("")).toBe(false);
	});

	it("normalises casing and stray whitespace", () => {
		expect(usesShakeMopIcons("  Roborock.Vacuum.A65 ")).toBe(true);
	});
});

describe("modeIconFileName", () => {
	it("names the suction icons of the app's mode picker", () => {
		expect(modeIconFileName({ family: "cleanMode", index: 3 }, "light", "normal")).toBe(
			"projects_comroborocktanos_theme_light_resources_mode_setting_clean3_normal_light.png",
		);
		expect(modeIconFileName({ family: "cleanMode", index: 3 }, "dark", "selected")).toBe(
			"projects_comroborocktanos_theme_dark_resources_mode_setting_clean3_selected_dark.png",
		);
	});

	it("picks the vibrating-mop water family only when the device has that module", () => {
		// This is the shipped bug: both families exist side by side and the app chooses by device.
		const ref: ModeIconRef = { family: "waterMode", index: 2 };
		expect(modeIconFileName(ref, "light", "normal", false)).toBe(
			"projects_comroborocktanos_theme_light_resources_mode_setting_water2_normal_light.png",
		);
		expect(modeIconFileName(ref, "light", "normal", true)).toBe(
			"projects_comroborocktanos_theme_light_resources_mode_setting_shaked_water2_normal_light.png",
		);
	});

	it("defaults to the standard water family when no device information is passed", () => {
		expect(modeIconFileName({ family: "waterMode", index: 1 }, "dark", "selected")).toBe(
			"projects_comroborocktanos_theme_dark_resources_mode_setting_water1_selected_dark.png",
		);
	});

	it("names the custom water amount", () => {
		expect(modeIconFileName({ family: "waterCustom" }, "light", "selected")).toBe(
			"projects_comroborocktanos_theme_light_resources_custom_water_mode_selected_light.png",
		);
	});

	it("leaves the theme suffix off the mop routes, which carry it in the folder segment only", () => {
		expect(modeIconFileName({ family: "cleanRoute", name: "deep_slow" }, "dark", "normal")).toBe(
			"projects_comroborocktanos_theme_dark_resources_clean_route_deep_slow_normal.png",
		);
		// The theme still selects the folder-level prefix, so the two themes differ.
		expect(modeIconFileName({ family: "cleanRoute", name: "daily" }, "light", "normal")).not.toBe(
			modeIconFileName({ family: "cleanRoute", name: "daily" }, "dark", "normal"),
		);
	});

	it("gives every family a distinct name per theme and state", () => {
		const refs: ModeIconRef[] = [
			{ family: "cleanMode", index: 0 },
			{ family: "waterMode", index: 0 },
			{ family: "waterCustom" },
			{ family: "cleanRoute", name: "fast" },
		];
		const names = new Set<string>();
		for (const ref of refs) {
			for (const theme of ["light", "dark"] as const) {
				for (const state of ["normal", "selected"] as const) {
					const name = modeIconFileName(ref, theme, state);
					expect(name.endsWith(".png")).toBe(true);
					names.add(name);
				}
			}
		}
		expect(names.size).toBe(refs.length * 4);
	});
});

describe("MODE_ICONS assignment", () => {
	it("keeps the suction indices in the app's order, where Gentle is clean0 and not 101", () => {
		const suction = MODE_ICONS.set_custom_mode;
		expect(suction["105"]).toEqual({ family: "cleanMode", index: 0 });
		expect(suction["101"]).toEqual({ family: "cleanMode", index: 1 });
		expect(suction["108"]).toEqual({ family: "cleanMode", index: 5 });
	});

	it("leaves the values whose icon is unproven without an entry", () => {
		// Every one of these is a deliberate gap documented in modeIcons.ts. An entry appearing
		// here means somebody guessed an icon, which would show a level the user did not pick.
		expect(MODE_ICONS.set_custom_mode["106"]).toBeUndefined(); // Custom
		expect(MODE_ICONS.set_custom_mode["110"]).toBeUndefined(); // Smart
		expect(MODE_ICONS.set_custom_mode["90"]).toBeUndefined(); // legacy value
		expect(MODE_ICONS.set_mop_mode["302"]).toBeUndefined(); // Custom route
		expect(MODE_ICONS.set_water_box_custom_mode["204"]).toBeUndefined(); // sentinel, not a level
		expect(MODE_ICONS.set_water_box_custom_mode["208"]).toBeUndefined(); // would reuse 203's art
	});

	it("addresses the mop routes by name, never by index", () => {
		for (const ref of Object.values(MODE_ICONS.set_mop_mode)) {
			expect(ref.family).toBe("cleanRoute");
		}
		expect(MODE_ICONS.set_mop_mode["300"]).toEqual({ family: "cleanRoute", name: "daily" });
		expect(MODE_ICONS.set_mop_mode["304"]).toEqual({ family: "cleanRoute", name: "fast" });
	});

	it("gives each suction level its own image", () => {
		const indices = Object.values(MODE_ICONS.set_custom_mode).map(ref =>
			ref.family === "cleanMode" ? ref.index : -1,
		);
		expect(new Set(indices).size).toBe(indices.length);
	});

	it("uses only string keys that parse as the numeric state values the adapter publishes", () => {
		for (const table of Object.values(MODE_ICONS)) {
			for (const value of Object.keys(table)) {
				expect(value).toMatch(/^\d+$/);
			}
		}
	});
});

describe("modeIconUrl", () => {
	/** The base the engine publishes: the adapter's file store, relative to the admin tab. */
	const base = `../../files/roborock/assets/${PLAIN_MOP_MODEL}`;
	const shakeBase = `../../files/roborock/assets/${SHAKE_MOP_MODEL}`;

	it("builds the full path from the asset base, the density folder and the file name", () => {
		expect(modeIconUrl(base, "set_custom_mode", "102", "light")).toBe(
			`${base}/${ASSET_DENSITY_FOLDER}/projects_comroborocktanos_theme_light_resources_mode_setting_clean2_normal_light.png`,
		);
	});

	it("stays relative to the admin root instead of becoming an absolute path", () => {
		// The shipped bug: an absolute `/files/...` resolved to nothing once the UI moved from the
		// web adapter into the admin tab, and it also breaks an admin behind a reverse proxy.
		const url = modeIconUrl(base, "set_custom_mode", "101", "dark");
		expect(url).not.toBeNull();
		expect(url?.startsWith("/")).toBe(false);
		expect(url?.startsWith("../../files/roborock/assets/")).toBe(true);
		expect(url).not.toMatch(/^https?:\/\//);
	});

	it("derives the water family from the model in the asset base", () => {
		// Nothing else tells the URL builder about the hardware, so this is the whole mechanism.
		expect(modeIconUrl(shakeBase, "set_water_box_custom_mode", "201", "light")).toContain(
			"mode_setting_shaked_water1_normal_light.png",
		);
		expect(modeIconUrl(base, "set_water_box_custom_mode", "201", "light")).toContain(
			"mode_setting_water1_normal_light.png",
		);
		expect(modeIconUrl(base, "set_water_box_custom_mode", "201", "light")).not.toContain("shaked_water");
	});

	it("leaves the other selectors untouched by the mop hardware", () => {
		expect(modeIconUrl(shakeBase, "set_custom_mode", "103", "light")).toBe(
			modeIconUrl(base, "set_custom_mode", "103", "light")?.replace(PLAIN_MOP_MODEL, SHAKE_MOP_MODEL),
		);
	});

	it("marks the option that is currently in effect", () => {
		expect(modeIconUrl(base, "set_custom_mode", "104", "light", "selected")).toContain("clean4_selected_light.png");
		expect(modeIconUrl(base, "set_custom_mode", "104", "light")).toContain("clean4_normal_light.png");
	});

	it("returns no image while the model is still unknown", () => {
		expect(modeIconUrl(null, "set_custom_mode", "101", "light")).toBeNull();
	});

	it("returns no image for a value whose icon is not proven", () => {
		// These must render as plain text, not as some other level's picture.
		expect(modeIconUrl(base, "set_custom_mode", "106", "light")).toBeNull();
		expect(modeIconUrl(base, "set_custom_mode", "110", "light")).toBeNull();
		expect(modeIconUrl(base, "set_water_box_custom_mode", "208", "light")).toBeNull();
		expect(modeIconUrl(base, "set_mop_mode", "302", "light")).toBeNull();
	});

	it("returns no image for a selector that has no assignment at all", () => {
		expect(modeIconUrl(base, "set_carpet_mode", "1", "light")).toBeNull();
		expect(modeIconUrl(base, "toString", "1", "light")).toBeNull();
	});

	it("produces a URL for every proven assignment and for no other value", () => {
		for (const [command, table] of Object.entries(MODE_ICONS)) {
			for (const value of Object.keys(table)) {
				const url = modeIconUrl(base, command, value, "light");
				expect(url, `${command}/${value}`).toContain(`/${ASSET_DENSITY_FOLDER}/`);
				expect(url?.endsWith(".png"), `${command}/${value}`).toBe(true);
			}
			expect(modeIconUrl(base, command, "999999", "light")).toBeNull();
		}
	});
});
