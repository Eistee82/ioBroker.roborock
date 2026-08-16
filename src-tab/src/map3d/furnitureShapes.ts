/**
 * Shapes for the furniture bodies: a few boxes and cylinders per type instead of one plain block.
 *
 * ## Where the line runs between proven and invented
 *
 * **Proven** is *which* model a piece gets. The app picks it from a `Triple[]` table keyed by
 * `(type, subType)` - `com/roborock/smart/react/mapv2/model/data/o000OOo.java:31-57`, table at
 * `com/facebook/imagepipeline/common/OooO00o.java:69` - and that mapping is reproduced in
 * {@link modelNameFor} unchanged, down to the two sofa corner variants and the two coffee tables.
 * `FT_CATTREE` has no entry there and gets none here either.
 *
 * **Invented** is what each model looks like here. Every part list below is an ordinary piece of
 * furniture drawn from scratch: a bed is a mattress with a headboard and two pillows because beds
 * are, not because a file said so.
 *
 * These shapes are the **fallback**. Roborock's own models are converted alongside them
 * (`roborockModels.ts`, `scripts/convert_g3db_models.js`) and are drawn whenever they have loaded;
 * that geometry belongs to Roborock and is not covered by this adapter's licence. What is below
 * takes over when the models cannot be fetched, and it is also all there is for a type Roborock
 * has no model for.
 *
 * That is a weaker claim than the footprint, which the map carries, and than the model choice,
 * which is read out of the app. It is a stronger one than the single block it replaces, because a
 * table with legs reads as a table from any angle while a block reads as a block.
 *
 * ## The coordinate frame
 *
 * Every part is given in fractions of the piece's own footprint, so one part list serves every
 * size the robot reports:
 *
 * - `dx`, `dz` - centre offset, `-0.5` to `+0.5` of width and depth. `0,0` is the middle.
 * - `w`, `d` - size as a fraction of width and depth.
 * - `y0`, `h` - bottom edge and height as a fraction of the piece's height.
 *
 * `y0 + h` may exceed 1: a headboard is taller than the mattress it belongs to, and the height in
 * {@link FURNITURE_HEIGHTS_MM} names the *usable surface* rather than the tallest point.
 *
 * `round` makes a part a cylinder standing on its base - for a round coffee table, a toilet bowl,
 * a pet bowl. Everything else is a box.
 */

/** One part of a piece of furniture. All values are fractions - see the module comment. */
export interface ShapePart {
	/** Centre offset along the width, -0.5 … +0.5. */
	dx: number;
	/** Centre offset along the depth, -0.5 … +0.5. */
	dz: number;
	/** Width as a fraction of the piece's width. */
	w: number;
	/** Depth as a fraction of the piece's depth. */
	d: number;
	/** Bottom edge as a fraction of the piece's height. */
	y0: number;
	/** Height as a fraction of the piece's height; `y0 + h` may exceed 1. */
	h: number;
	/** A cylinder rather than a box. */
	round?: boolean;
}

/**
 * A leg at each corner, inset by `inset`, reaching from the floor to `top`.
 *
 * The inset is measured to the leg's **centre**, so a leg thinner than twice the inset would stick
 * out of the footprint by the difference - which is how the pet cage first came to be 0.5 % too
 * wide. The offset is therefore clamped here rather than at each call: a caller asking for a leg
 * flush with the edge gets one flush with the edge, not one hanging over it.
 */
function legs(inset: number, top: number, thickness: number): ShapePart[] {
	const off = Math.max(0, 0.5 - Math.max(inset, thickness / 2));
	return [
		{ dx: -off, dz: -off, w: thickness, d: thickness, y0: 0, h: top },
		{ dx: off, dz: -off, w: thickness, d: thickness, y0: 0, h: top },
		{ dx: -off, dz: off, w: thickness, d: thickness, y0: 0, h: top },
		{ dx: off, dz: off, w: thickness, d: thickness, y0: 0, h: top }
	];
}

/** A carcass with a gap down the middle, so a cabinet reads as having two doors. */
function twoDoors(): ShapePart[] {
	return [
		{ dx: -0.255, dz: 0, w: 0.49, d: 1, y0: 0, h: 1 },
		{ dx: 0.255, dz: 0, w: 0.49, d: 1, y0: 0, h: 1 }
	];
}

/** A shallow tray: floor plus four low walls. Used for open litter trays and pet beds. */
function tray(wallHeight: number): ShapePart[] {
	return [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0, h: 0.3 },
		{ dx: -0.45, dz: 0, w: 0.1, d: 1, y0: 0, h: wallHeight },
		{ dx: 0.45, dz: 0, w: 0.1, d: 1, y0: 0, h: wallHeight },
		{ dx: 0, dz: -0.45, w: 1, d: 0.1, y0: 0, h: wallHeight },
		{ dx: 0, dz: 0.45, w: 1, d: 0.1, y0: 0, h: wallHeight }
	];
}

/**
 * A sofa: seat, backrest along one long side, an armrest at each end.
 *
 * @param corner `null` for a straight sofa, or the side that carries the return of an L.
 * @returns The part list.
 */
function sofa(corner: "left" | "right" | null): ShapePart[] {
	const parts: ShapePart[] = [
		// Seat.
		{ dx: 0, dz: 0.1, w: 1, d: 0.8, y0: 0, h: 0.55 },
		// Backrest along the far side.
		{ dx: 0, dz: -0.4, w: 1, d: 0.2, y0: 0, h: 1 },
		// Armrests.
		{ dx: -0.45, dz: 0.1, w: 0.1, d: 0.8, y0: 0, h: 0.8 },
		{ dx: 0.45, dz: 0.1, w: 0.1, d: 0.8, y0: 0, h: 0.8 }
	];
	if (corner) {
		// The return of the L: a second seat along one end, with its own low back.
		//
		// `dz + d/2` is exactly 0.5 - the return reaches the front edge of the footprint and stops
		// there. It was 0.6 first, which put the corner of every L-sofa through whatever the sofa
		// stands against; the footprint is measured by the robot and is the one thing in this file
		// that may not be exceeded.
		const side = corner === "left" ? -1 : 1;
		parts.push({ dx: side * 0.35, dz: 0.25, w: 0.3, d: 0.5, y0: 0, h: 0.55 });
		parts.push({ dx: side * 0.47, dz: 0.25, w: 0.06, d: 0.5, y0: 0, h: 0.85 });
	}
	return parts;
}

/**
 * Part lists by model name. The names are the app's own, see {@link modelNameFor}.
 *
 * A name that is missing here falls back to a single block, which is what every piece looked like
 * before - a missing shape costs detail, never the body itself.
 */
export const FURNITURE_SHAPES: Readonly<Record<string, readonly ShapePart[]>> = {
	// Bed: mattress, headboard at the far side, two pillows against it.
	bed1: [
		{ dx: 0, dz: 0.05, w: 1, d: 0.9, y0: 0.25, h: 0.75 },
		{ dx: 0, dz: -0.46, w: 1, d: 0.08, y0: 0, h: 1.8 },
		{ dx: -0.25, dz: -0.33, w: 0.4, d: 0.18, y0: 1, h: 0.35 },
		{ dx: 0.25, dz: -0.33, w: 0.4, d: 0.18, y0: 1, h: 0.35 },
		...legs(0.06, 0.25, 0.08)
	],
	// Single bed: one pillow, narrower headboard.
	bed2: [
		{ dx: 0, dz: 0.05, w: 1, d: 0.9, y0: 0.25, h: 0.75 },
		{ dx: 0, dz: -0.46, w: 1, d: 0.08, y0: 0, h: 1.7 },
		{ dx: 0, dz: -0.33, w: 0.55, d: 0.18, y0: 1, h: 0.35 },
		...legs(0.06, 0.25, 0.08)
	],

	sofa1: sofa(null),
	sofa2: sofa(null),
	sofa3: sofa(null),
	sofaLL: sofa("left"),
	sofaLR: sofa("right"),

	// Dining table: top on four legs.
	table: [{ dx: 0, dz: 0, w: 1, d: 1, y0: 0.88, h: 0.12 }, ...legs(0.08, 0.88, 0.07)],

	// Round coffee table: disc on a central column with a foot.
	chaji: [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0.8, h: 0.2, round: true },
		{ dx: 0, dz: 0, w: 0.2, d: 0.2, y0: 0.1, h: 0.7, round: true },
		{ dx: 0, dz: 0, w: 0.55, d: 0.55, y0: 0, h: 0.1, round: true }
	],
	// Rectangular coffee table: top, a shelf underneath, four short legs.
	chajiRect: [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0.82, h: 0.18 },
		{ dx: 0, dz: 0, w: 0.85, d: 0.85, y0: 0.3, h: 0.08 },
		...legs(0.07, 0.82, 0.08)
	],

	// TV stand: low carcass on a recessed plinth, with a gap between two doors.
	tvCabinet: [
		{ dx: -0.255, dz: 0, w: 0.49, d: 1, y0: 0.12, h: 0.88 },
		{ dx: 0.255, dz: 0, w: 0.49, d: 1, y0: 0.12, h: 0.88 },
		{ dx: 0, dz: 0, w: 0.9, d: 0.85, y0: 0, h: 0.12 }
	],

	// Cabinets: carcass with a door gap; the wardrobe gets a plinth as well.
	shoesCabinet: twoDoors(),
	bedCabinet: [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0.15, h: 0.85 },
		{ dx: 0, dz: 0.45, w: 0.6, d: 0.06, y0: 0.55, h: 0.06 },
		...legs(0.08, 0.15, 0.1)
	],
	clothesCabinet: [...twoDoors(), { dx: 0, dz: 0, w: 0.92, d: 0.9, y0: 0, h: 0.04 }],

	// Toilet: bowl with a cistern behind it.
	toilet: [
		{ dx: 0, dz: 0.12, w: 0.75, d: 0.7, y0: 0, h: 0.62, round: true },
		{ dx: 0, dz: -0.35, w: 0.9, d: 0.28, y0: 0, h: 1 },
		{ dx: 0, dz: 0.12, w: 0.8, d: 0.75, y0: 0.62, h: 0.08, round: true }
	],

	// Litter trays: open is a tray, closed is a hood with a doorway left out.
	open_toilet: tray(0.75),
	close_toilet: [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0, h: 0.35 },
		{ dx: -0.32, dz: 0, w: 0.36, d: 1, y0: 0.35, h: 0.65 },
		{ dx: 0.32, dz: 0, w: 0.36, d: 1, y0: 0.35, h: 0.65 },
		{ dx: 0, dz: -0.4, w: 1, d: 0.2, y0: 0.35, h: 0.65 },
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0.92, h: 0.08 }
	],

	// Pet cage: floor, roof, corner posts and a few bars, so it reads as open rather than solid.
	cat_cage: [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0, h: 0.08 },
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0.92, h: 0.08 },
		...legs(0.03, 1, 0.07),
		{ dx: -0.17, dz: -0.47, w: 0.05, d: 0.06, y0: 0.08, h: 0.84 },
		{ dx: 0.17, dz: -0.47, w: 0.05, d: 0.06, y0: 0.08, h: 0.84 },
		{ dx: -0.17, dz: 0.47, w: 0.05, d: 0.06, y0: 0.08, h: 0.84 },
		{ dx: 0.17, dz: 0.47, w: 0.05, d: 0.06, y0: 0.08, h: 0.84 }
	],

	// Pet bed: a soft tray with a thick rim.
	cat_bed: tray(1),

	// Pet bowls: two shallow dishes side by side on a mat.
	cat_plate: [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0, h: 0.18 },
		{ dx: -0.24, dz: 0, w: 0.42, d: 0.8, y0: 0.18, h: 0.82, round: true },
		{ dx: 0.24, dz: 0, w: 0.42, d: 0.8, y0: 0.18, h: 0.82, round: true }
	],

	// Floor mirror: a thin pane in a frame on a foot. Leaning is not modelled - the map reports a
	// rectangle on the floor and no tilt, and a mirror drawn leaning would put its top edge over
	// floor the robot can actually drive on.
	tall_mirror: [
		{ dx: 0, dz: 0, w: 1, d: 1, y0: 0.05, h: 0.95 },
		{ dx: 0, dz: 0, w: 0.86, d: 0.6, y0: 0.1, h: 0.85 },
		{ dx: 0, dz: 0, w: 0.9, d: 1, y0: 0, h: 0.05 }
	],

	// Cat tree: a post with two platforms. The app has no model for this type; this is the one
	// shape here that does not stand in for one, and it is drawn because the robot reports the
	// piece and a block would say less.
	cat_tree: [
		{ dx: 0, dz: 0, w: 0.8, d: 0.8, y0: 0, h: 0.06 },
		{ dx: 0, dz: 0, w: 0.22, d: 0.22, y0: 0.06, h: 0.94, round: true },
		{ dx: -0.15, dz: 0, w: 0.6, d: 0.9, y0: 0.45, h: 0.06 },
		{ dx: 0.15, dz: 0, w: 0.6, d: 0.9, y0: 0.94, h: 0.06 }
	]
};

/**
 * The model the app would use for a piece.
 *
 * Reproduces the app's `(type, subType)` table unchanged
 * (`com/facebook/imagepipeline/common/OooO00o.java:69`, case 7). A pair the table does not list
 * returns `null`, and the piece keeps the plain block it had before - guessing a model would put a
 * sofa where the robot saw something else.
 *
 * `toilet` (type 44) and `cat_tree` (58) are **not** in the app's table: 44 carries no model there
 * at all, and 58 is listed in the report as deliberately absent. Both are given a shape here
 * anyway, because the robot reports the piece either way and the shape is this module's own.
 *
 * @param type `type` of the block entry.
 * @param subType `subType` of the block entry.
 * @returns Model name, or null when there is no shape for the pair.
 */
export function modelNameFor(type: number, subType: number): string | null {
	switch (type) {
		case 43:
			return "tvCabinet";
		case 44:
			return "toilet";
		case 45:
			return subType === 1 ? "bed1" : "bed2";
		case 46:
			switch (subType) {
				case 1:
					return "sofa1";
				case 2:
					return "sofa2";
				case 4:
					return "sofaLR";
				case 5:
					return "sofaLL";
				default:
					return "sofa3";
			}
		case 47:
			return "table";
		case 48:
			return subType === 2 ? "chajiRect" : "chaji";
		case 49:
			return "shoesCabinet";
		case 50:
			return "bedCabinet";
		case 51:
			return "clothesCabinet";
		case 52:
			return "open_toilet";
		case 53:
			return "close_toilet";
		case 54:
			return "cat_cage";
		case 55:
			return "cat_bed";
		case 56:
			return "cat_plate";
		case 57:
			return "tall_mirror";
		case 58:
			return "cat_tree";
		default:
			return null;
	}
}

/**
 * The parts a piece is drawn from.
 *
 * @param type `type` of the block entry.
 * @param subType `subType` of the block entry.
 * @returns The part list, or null when the piece stays a plain block.
 */
export function shapeFor(type: number, subType: number): readonly ShapePart[] | null {
	const name = modelNameFor(type, subType);
	if (name === null) return null;
	return FURNITURE_SHAPES[name] ?? null;
}
