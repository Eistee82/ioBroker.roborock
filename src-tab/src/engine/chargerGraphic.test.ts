import { describe, expect, it } from "vitest";
import {
	chargerAssetFileName,
	chargerGraphicFor,
	chargerLayout,
	snapChargerAngle,
} from "./chargerGraphic";

/**
 * The dock artwork the app picks, sized and turned the way it sizes and turns it.
 *
 * Every number checked here is quoted from the decompiled control plugin in `chargerGraphic.ts`;
 * these tests exist so a later "tidy-up" of one of the odder ones - the 0.5 anchor of a graphic
 * whose aspect is 0.86, the nudge that only ever moves vertically - fails loudly instead of
 * silently moving every dock on every map.
 */

describe("chargerGraphicFor", () => {
	it("gives the plain charging dock its own graphic and no overlay", () => {
		const graphic = chargerGraphicFor(0);
		expect(graphic?.kind).to.equal("normal");
		// Not an arrow: this is the whole dock. Reading the name as an overlay loses the dock.
		expect(graphic?.body).to.equal("charger_direction");
		expect(graphic?.top).to.equal(null);
	});

	it("gives every station above a charger the two-layer graphic", () => {
		// 6 is what the test device reports; the app only asks whether the type is non-zero.
		for (const dockType of [1, 2, 6, 10, 18]) {
			const graphic = chargerGraphicFor(dockType);
			expect(graphic?.kind, `dock type ${dockType}`).to.equal("special");
			expect(graphic?.body).to.equal("charger_special");
			expect(graphic?.top).to.equal("charger_special_top");
		}
	});

	it("refuses to pick a station for a device that reported no dock type", () => {
		// The caller keeps the built-in symbol for these; guessing would show a base station to
		// someone who owns a plain charger.
		expect(chargerGraphicFor(null)).to.equal(null);
		expect(chargerGraphicFor(undefined)).to.equal(null);
		expect(chargerGraphicFor(Number.NaN)).to.equal(null);
		expect(chargerGraphicFor(-1)).to.equal(null);
	});

	it("keeps both graphics at the aspect their own image files have", () => {
		const normal = chargerGraphicFor(0)!;
		const special = chargerGraphicFor(6)!;
		// charger_direction.png is 453 x 587, charger_special.png is 1250 x 1080.
		expect(normal.widthCells / normal.heightCells).to.be.closeTo(453 / 587, 0.005);
		expect(special.heightCells / special.widthCells).to.be.closeTo(1080 / 1250, 0.005);
	});

	it("draws both docks to scale, in map cells of 50 mm", () => {
		// Config.size.chargerRadius = 10.4 and chargerNormal = 4.8, module 1507 of the plugin.
		expect(chargerGraphicFor(6)!.widthCells).to.equal(10.4);
		expect(chargerGraphicFor(0)!.heightCells).to.equal(4.8);
	});
});

describe("chargerAssetFileName", () => {
	it("builds the plugin's own file name", () => {
		expect(chargerAssetFileName("charger_special")).to.equal(
			"projects_comroborocktanos_resources_charger_special.png"
		);
	});

	it("uses the unthemed prefix, because the plugin ships no dark dock", () => {
		// The mode icons carry `_theme_light_` / `_theme_dark_`; the dock graphics do not exist in
		// those folders at all, so a theme segment here would point at a file that is never there.
		expect(chargerAssetFileName("charger_direction")).to.not.match(/theme_(light|dark)/);
	});
});

describe("snapChargerAngle", () => {
	it("pulls a reading close to a right angle onto it", () => {
		// -93 is what the test device reports for a dock standing against a wall.
		expect(snapChargerAngle(-93)).to.equal(-90);
		expect(snapChargerAngle(12)).to.equal(0);
		expect(snapChargerAngle(178)).to.equal(180);
		expect(snapChargerAngle(-176)).to.equal(-180);
	});

	it("leaves a reading that is not close to one alone", () => {
		expect(snapChargerAngle(45)).to.equal(45);
		expect(snapChargerAngle(-30)).to.equal(-30);
	});

	it("snaps at exactly 15 degrees but not beyond", () => {
		expect(snapChargerAngle(15)).to.equal(0);
		expect(snapChargerAngle(15.1)).to.equal(15.1);
	});

	it("answers 0 for a missing or unusable reading", () => {
		expect(snapChargerAngle(null)).to.equal(0);
		expect(snapChargerAngle(undefined)).to.equal(0);
		expect(snapChargerAngle(Number.NaN)).to.equal(0);
	});
});

describe("chargerLayout", () => {
	const special = chargerGraphicFor(6)!;
	const normal = chargerGraphicFor(0)!;

	it("turns the graphic against the reported angle", () => {
		// The robot counts counter-clockwise in a y-up frame, the map is drawn y-down.
		const layout = chargerLayout({ x: 100, y: 200, angle: -90, graphic: special, cellSize: 3 });
		expect(layout.rotation).to.equal(90);
	});

	it("rotates by the snapped angle, not the raw one", () => {
		const raw = chargerLayout({ x: 0, y: 0, angle: -93, graphic: special, cellSize: 3 });
		expect(raw.rotation).to.equal(90);
	});

	it("scales width and height by the size of one map cell", () => {
		const layout = chargerLayout({ x: 0, y: 0, angle: 0, graphic: special, cellSize: 3 });
		expect(layout.width).to.be.closeTo(10.4 * 3, 1e-9);
		expect(layout.height).to.be.closeTo(10.4 * 0.86 * 3, 1e-9);
	});

	it("leaves a dock facing left or right exactly on its reported position", () => {
		// sin(0) is 0, so the app's nudge does nothing here - and it has no horizontal term at all.
		for (const angle of [0, 180, -180]) {
			const layout = chargerLayout({ x: 100, y: 200, angle, graphic: special, cellSize: 3 });
			expect(layout.centerX, `angle ${angle}`).to.equal(100);
			expect(layout.centerY, `angle ${angle}`).to.be.closeTo(200, 1e-9);
		}
	});

	it("pushes a dock facing up or down off its reported position, vertically only", () => {
		const layout = chargerLayout({ x: 100, y: 200, angle: -90, graphic: special, cellSize: 3 });
		// (height / 2) * (1 - 0.5) * sin(90 deg)
		const expected = 200 + ((10.4 * 0.86 * 3) / 2) * 0.5;
		expect(layout.centerX).to.equal(100);
		expect(layout.centerY).to.be.closeTo(expected, 1e-9);
	});

	it("uses the raw angle for the nudge, so a snapped reading still shifts by its own sine", () => {
		const snapped = chargerLayout({ x: 0, y: 0, angle: -90, graphic: special, cellSize: 3 });
		const raw = chargerLayout({ x: 0, y: 0, angle: -93, graphic: special, cellSize: 3 });
		expect(raw.rotation).to.equal(snapped.rotation);
		expect(raw.centerY).to.not.equal(snapped.centerY);
		expect(raw.centerY).to.be.closeTo(snapped.centerY * Math.sin((93 * Math.PI) / 180), 1e-9);
	});

	it("nudges the plain dock far less, because its anchor ratio is 0.77", () => {
		const layout = chargerLayout({ x: 0, y: 0, angle: -90, graphic: normal, cellSize: 3 });
		expect(layout.centerY).to.be.closeTo(((4.8 * 3) / 2) * (1 - 0.77), 1e-9);
	});

	it("treats a missing angle as no rotation and no nudge", () => {
		const layout = chargerLayout({ x: 100, y: 200, angle: undefined, graphic: special, cellSize: 3 });
		expect(layout.rotation).to.equal(0);
		expect(layout.centerX).to.equal(100);
		expect(layout.centerY).to.equal(200);
	});
});
