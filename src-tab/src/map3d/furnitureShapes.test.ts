import { describe, expect, it } from "vitest";
import { FURNITURE_SHAPES, modelNameFor, shapeFor } from "./furnitureShapes";
import { FURNITURE_HEIGHTS_MM } from "./furniture3d";

/**
 * Two kinds of assertion here, and they are worth telling apart.
 *
 * The **model choice** is read out of the app and can be wrong in the ordinary sense - a sofa
 * variant put on the wrong `subType` draws the wrong sofa. Those tests name the source.
 *
 * The **shapes** are this project's own, so there is no outside truth to check them against. What
 * can still be checked is that none of them makes a body that floats, sinks or spills out of the
 * footprint the robot measured - the three ways an invented shape stops being a floor plan.
 */
describe("the model the app would use", () => {
	it("follows the app's own table for the pairs it lists", () => {
		// com/facebook/imagepipeline/common/OooO00o.java:69, case 7 - reproduced, not guessed.
		expect(modelNameFor(43, 0)).toBe("tvCabinet");
		expect(modelNameFor(45, 1)).toBe("bed1");
		expect(modelNameFor(45, 2)).toBe("bed2");
		expect(modelNameFor(46, 1)).toBe("sofa1");
		expect(modelNameFor(46, 4)).toBe("sofaLR");
		expect(modelNameFor(46, 5)).toBe("sofaLL");
		expect(modelNameFor(48, 1)).toBe("chaji");
		expect(modelNameFor(48, 2)).toBe("chajiRect");
		expect(modelNameFor(57, 0)).toBe("tall_mirror");
	});

	it("falls back to the type's own default for a subType the table does not list", () => {
		// The app's table ends its sofa list with `0 -> sofa3`, and a bed that is neither 1 nor 2
		// gets bed2 there as well. An unlisted variant is a piece the robot did report, so it gets
		// the type's ordinary shape rather than no shape at all.
		expect(modelNameFor(46, 0)).toBe("sofa3");
		expect(modelNameFor(46, 99)).toBe("sofa3");
		expect(modelNameFor(45, 0)).toBe("bed2");
	});

	it("has nothing for a type nobody has seen", () => {
		expect(modelNameFor(99, 0)).toBeNull();
		expect(shapeFor(99, 0)).toBeNull();
	});

	it("gives every type with a known height a shape", () => {
		// A type the height table knows is a type this build claims to recognise. Claiming to know
		// what something is and then drawing a featureless block is the one combination that reads
		// as a bug rather than as a limit.
		for (const type of Object.keys(FURNITURE_HEIGHTS_MM).map(Number)) {
			expect(shapeFor(type, 0), `type ${type}`).not.toBeNull();
		}
	});
});

describe("every shape", () => {
	const all = Object.entries(FURNITURE_SHAPES);

	it("stands on the floor - no part is buried and none floats without support", () => {
		for (const [name, parts] of all) {
			expect(parts.length, name).toBeGreaterThan(0);
			for (const part of parts) {
				expect(part.y0, `${name} y0`).toBeGreaterThanOrEqual(0);
				expect(part.h, `${name} h`).toBeGreaterThan(0);
			}
			// At least one part reaches the ground, or the whole piece hovers.
			expect(parts.some((p) => p.y0 === 0), `${name} touches the floor`).toBe(true);
		}
	});

	it("stays inside the footprint the robot measured", () => {
		// The footprint is the one thing here that is not invented, so nothing may spill out of it:
		// a bed whose headboard sticks through the wall behind it would misreport the room.
		for (const [name, parts] of all) {
			for (const part of parts) {
				expect(part.w, `${name} w`).toBeGreaterThan(0);
				expect(part.d, `${name} d`).toBeGreaterThan(0);
				expect(Math.abs(part.dx) + part.w / 2, `${name} across the width`).toBeLessThanOrEqual(0.5 + 1e-9);
				expect(Math.abs(part.dz) + part.d / 2, `${name} across the depth`).toBeLessThanOrEqual(0.5 + 1e-9);
			}
		}
	});

	it("keeps its height near the one the table gives, give or take a headboard", () => {
		// `y0 + h` may exceed 1 - a headboard is taller than the mattress, a cistern taller than the
		// bowl. What it may not do is exceed it so far that the piece stops matching the height the
		// table names, which is what the view is scaled around.
		for (const [name, parts] of all) {
			for (const part of parts) {
				expect(part.y0 + part.h, `${name} total height`).toBeLessThanOrEqual(2.2);
			}
		}
	});
});
