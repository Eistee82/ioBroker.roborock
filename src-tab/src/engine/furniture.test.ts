import { describe, expect, it } from "vitest";
import { ASSET_BASE } from "./MapEngine";
import { ASSET_DENSITY_FOLDER } from "./modeIcons";
import { FURNITURE_TYPES, furnitureAssetFileName, furnitureGraphic, furnitureRect } from "./furniture";

/**
 * The type table and the geometry of block type 25.
 *
 * Every expectation here is a value read out of the Roborock control plugin and written up in
 * `_appanalysis/15-livemap-und-moebel.md` §2.3 – §2.6, not a value this code produced. A test
 * that only restated the implementation would let a wrong assignment pass.
 */
describe("furniture type table", () => {
	it("assigns the proven graphic of a type without subtypes", () => {
		expect(furnitureGraphic(43, 0)?.image).to.equal("tv_cabinet");
		expect(furnitureGraphic(50, 0)?.image).to.equal("night_stand");
		expect(furnitureGraphic(58, 0)?.image).to.equal("cat_tree");
	});

	it("prefers the subtype graphic where the app declares subtypes", () => {
		expect(furnitureGraphic(45, 1)?.image).to.equal("bed_single");
		expect(furnitureGraphic(45, 2)?.image).to.equal("bed_double");
		expect(furnitureGraphic(46, 3)?.image).to.equal("sofa_three");
		expect(furnitureGraphic(46, 5)?.image).to.equal("sofa_sectional_left");
		expect(furnitureGraphic(48, 1)?.image).to.equal("table_circle");
		expect(furnitureGraphic(48, 2)?.image).to.equal("table_rect");
	});

	it("ignores the subtype of a type that has none", () => {
		// A shoe cabinet stays a shoe cabinet whatever the subtype byte says.
		expect(furnitureGraphic(49, 0)?.image).to.equal("shoe_cabinet");
		expect(furnitureGraphic(49, 3)?.image).to.equal("shoe_cabinet");
	});

	it("has no graphic for a bed or sofa whose subtype is unknown", () => {
		// FT_BED and FT_SOFA carry subtype entries only - the app finds nothing here either.
		expect(furnitureGraphic(45, 0)).to.equal(null);
		expect(furnitureGraphic(46, 0)).to.equal(null);
		expect(furnitureGraphic(48, 0)).to.equal(null);
	});

	it("has no graphic for a type outside the proven table", () => {
		expect(furnitureGraphic(0, 0)).to.equal(null); // FT_UNKNOWN
		expect(furnitureGraphic(42, 0)).to.equal(null);
		expect(furnitureGraphic(59, 0)).to.equal(null);
		expect(furnitureGraphic(46, 9)).to.equal(null); // subtype beyond SofaSubType
	});

	it("covers exactly the sixteen named types of FurnitureType", () => {
		// FT_TVCABINET 43 … FT_CATTREE 58, without FT_UNKNOWN.
		expect(Object.keys(FURNITURE_TYPES).map(Number).sort((a, b) => a - b)).to.deep.equal([
			43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
		]);
	});

	it("names every piece it can draw", () => {
		for (const entry of Object.values(FURNITURE_TYPES)) {
			const graphics = entry.subTypes ? Object.values(entry.subTypes) : [entry.graphic!];
			for (const graphic of graphics) {
				expect(graphic.title.length, graphic.image).to.be.greaterThan(0);
			}
		}
	});

	it("builds a relative URL inside the model's asset folder", () => {
		const url = `${ASSET_BASE}/roborock.vacuum.a65/${ASSET_DENSITY_FOLDER}/${furnitureAssetFileName("bed_double")}`;
		const resolved = new URL(url, "http://ioBroker:8081/adapter/roborock/tab.html");

		expect(resolved.pathname).to.equal(
			"/files/roborock/assets/roborock.vacuum.a65/drawable-mdpi/projects_comroborocktanos_resources_furniture_bed_double.png",
		);
	});
});

describe("furnitureRect", () => {
	/**
	 * Corner order of the block: P0 → P1 is the width edge, P0 → P3 the height edge, and P0/P2
	 * are opposite ends of the diagonal (`decodeMachineFBZ`, A65 477227–477340).
	 */
	it("derives centre, size and a zero angle from an axis-aligned rectangle", () => {
		const rect = furnitureRect([
			{ x: 10, y: 20 },
			{ x: 50, y: 20 },
			{ x: 50, y: 40 },
			{ x: 10, y: 40 },
		]);

		expect(rect).to.not.equal(null);
		expect(rect!.width).to.equal(40);
		expect(rect!.height).to.equal(20);
		expect(rect!.centerX).to.equal(30);
		expect(rect!.centerY).to.equal(30);
		expect(rect!.x).to.equal(10);
		expect(rect!.y).to.equal(20);
		expect(rect!.angle).to.equal(0);
	});

	it("reads the rotation out of the corner points", () => {
		// The same 40 x 20 rectangle, turned by 90 degrees clockwise around (30, 30).
		const rect = furnitureRect([
			{ x: 40, y: 10 },
			{ x: 40, y: 50 },
			{ x: 20, y: 50 },
			{ x: 20, y: 10 },
		]);

		expect(rect!.width).to.equal(40);
		expect(rect!.height).to.equal(20);
		expect(rect!.centerX).to.equal(30);
		expect(rect!.centerY).to.equal(30);
		expect(rect!.angle).to.be.closeTo(90, 1e-9);
	});

	it("rejects degenerate and incomplete input", () => {
		expect(furnitureRect([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).to.equal(null);
		expect(
			furnitureRect([
				{ x: 5, y: 5 },
				{ x: 5, y: 5 },
				{ x: 5, y: 5 },
				{ x: 5, y: 5 },
			]),
		).to.equal(null);
		expect(
			furnitureRect([
				{ x: Number.NaN, y: 0 },
				{ x: 1, y: 0 },
				{ x: 1, y: 1 },
				{ x: 0, y: 1 },
			]),
		).to.equal(null);
	});
});
