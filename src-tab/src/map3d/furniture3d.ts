/**
 * Furniture as plain bodies: one box per piece, sized from the map, standing at the piece's angle.
 *
 * ## Why boxes and not models
 *
 * The app draws 35 `.g3db` models, and they live in `assets/models_g3db/` **inside the APK and
 * nowhere else** - checked twice, most recently against the downloaded control plugin, which
 * carries only drawables and the JS bundle. So there is nothing to fetch the way `chargerGraphic`
 * fetches the dock artwork from the user's own plugin package, and shipping the APK's models is
 * the line this project has already drawn once. A box in the right place, at the right size and
 * angle, says everything a floor plan needs to say.
 *
 * ## What is proven and what is not
 *
 * Proven, and taken from existing code rather than restated:
 *
 * - **Which types exist** and what they are called - `FURNITURE_TYPES` in `engine/furniture.ts`,
 *   read out of `FurnitureType` (A65 342666) and `FurnitureResource` (A65 342685-343392).
 * - **Where a piece stands, how large it is and how it is turned** - `furnitureRect`, which is the
 *   app's own `decodeMachineFBZ` (A65 477227-477340) applied to the four corner points the map
 *   block carries.
 *
 * Not proven, and deliberately so:
 *
 * - **How tall a piece is.** See {@link FURNITURE_HEIGHTS_MM}.
 */

import { FURNITURE_TYPES, furnitureRect } from "../engine/furniture";
import type { FurniturePoint } from "../engine/furniture";
import { MM_PER_CELL } from "./units";
import type { CellPoint } from "./map3dModel";
import { modelNameFor, shapeFor } from "./furnitureShapes";
import type { ShapePart } from "./furnitureShapes";

/**
 * Height of each furniture type in millimetres - **chosen, not measured. Nothing in the protocol
 * carries a height.**
 *
 * The robot is a floor-level LiDAR and reports outlines, never elevations; the app's furniture
 * looks three-dimensional only because its `.g3db` models bring their own proportions along. So
 * every number below is an ordinary piece of furniture's usual height, picked to make the view
 * readable, and it is the one part of this module that would change if someone simply preferred
 * different numbers.
 *
 * That makes them a weaker claim than the wall height of 500 mm, which is at least the app's own
 * constant (`C4192OooO0oo.java:174`) rather than an invention.
 *
 * The keys are the `type` field of block 25, the same numbering `FURNITURE_TYPES` uses.
 */
export const FURNITURE_HEIGHTS_MM: Readonly<Record<number, number>> = {
	43: 500, // FT_TVCABINET - TV stand
	44: 750, // FT_TOILET
	45: 500, // FT_BED - mattress top, not the headboard
	46: 800, // FT_SOFA - backrest
	47: 750, // FT_DINNERTABLE - table top
	48: 400, // FT_TEATABLE - coffee table
	49: 900, // FT_SHOECABINET
	50: 550, // FT_NIGHTSTAND
	51: 2000, // FT_WARDROBE
	52: 200, // FT_OPENCATTOILET - open tray
	53: 400, // FT_CATTOILET - enclosed
	54: 600, // FT_PETCAGE
	55: 150, // FT_PETWATERLOO - pet bed
	56: 80, // FT_PETBOWL
	57: 1600, // FT_FLOORMIRROR
	58: 1200 // FT_CATTREE
};

/**
 * Height for a type this table does not know, in millimetres.
 *
 * A piece the robot reports but this build has never heard of still exists, and the user can still
 * trip over it. It gets a body of its own - waist-high, so it reads as "something is here" without
 * pretending to be a wardrobe or a pet bowl - and {@link FurnitureBox.known} says it is a stand-in
 * so the scene can draw it differently.
 */
export const UNKNOWN_FURNITURE_HEIGHT_MM = 400;

/** One piece, ready to be placed in the scene. All lengths in cells, the unit the scene works in. */
export interface FurnitureBox {
	/** Centre in picture cell coordinates - the same frame the walls and the floor texture use. */
	x: number;
	z: number;
	/** Footprint before the rotation. */
	width: number;
	depth: number;
	/** Height, from {@link FURNITURE_HEIGHTS_MM}. */
	height: number;
	/** Rotation in degrees, clockwise in the picture frame. */
	angle: number;
	/** `type` of the block entry, kept so the scene can label or filter. */
	type: number;
	/** `subType` of the block entry; decides which of a type's variants is drawn. */
	subType: number;
	/** False when the type is not in the height table; the body is a stand-in. */
	known: boolean;
	/**
	 * The parts this piece is drawn from, or null for a single block.
	 *
	 * Null happens for a type no shape is defined for - the piece still gets a body, it just has
	 * no detail. See `furnitureShapes.ts` for where the shapes come from and what is proven about
	 * them.
	 */
	parts: readonly ShapePart[] | null;
	/**
	 * Name of Roborock's own model for this piece, or null.
	 *
	 * The scene draws that model when it has been loaded and falls back to {@link parts} when it
	 * has not - so a piece is never lost to a failed download.
	 */
	model: string | null;
}

/** The fields of one furniture entry this module reads. */
interface RawFurniture {
	[key: string]: unknown;
}

/** Reads a finite number, or null. */
function finite(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turns the published furniture list into bodies.
 *
 * The corner points are converted into **picture** cell coordinates first - `x = mm/50 - left`,
 * `y = height - (mm/50 - top)` - and only then handed to `furnitureRect`. Two reasons for that
 * order:
 *
 * - The rectangle and its angle come out in the frame they are drawn in, so no angle has to be
 *   corrected afterwards. Correcting an angle after a flip is where the sign gets lost.
 * - It is the same flip the walls, the floor texture and the robot go through
 *   (`src/common/mapDrawing/coordHelpers.ts:31-36`). A piece of furniture computed in the raw grid
 *   frame would sit mirrored against everything else.
 *
 * @param value Value of `mapData.FURNITURES`.
 * @param left Grid offset in cells, `IMAGE.position.left`.
 * @param top Grid offset in cells, `IMAGE.position.top`.
 * @param gridHeight Grid height in cells.
 * @returns One box per readable piece; unreadable entries are skipped rather than guessed at.
 */
export function buildFurnitureBoxes(value: unknown, left: number, top: number, gridHeight: number): FurnitureBox[] {
	if (!Array.isArray(value)) return [];

	const boxes: FurnitureBox[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const piece = raw as RawFurniture;

		const corners: FurniturePoint[] = [];
		for (const n of [1, 2, 3, 4]) {
			const mmX = finite(piece[`x${n}`]);
			const mmY = finite(piece[`y${n}`]);
			if (mmX === null || mmY === null) break;
			corners.push(toPictureCell({ x: mmX, y: mmY }, left, top, gridHeight));
		}
		if (corners.length !== 4) continue;

		const rect = furnitureRect(corners);
		if (!rect) continue;

		const type = finite(piece.type) ?? -1;
		const subType = finite(piece.subType) ?? 0;
		const known = Object.prototype.hasOwnProperty.call(FURNITURE_HEIGHTS_MM, type);
		const heightMm = known ? FURNITURE_HEIGHTS_MM[type] : UNKNOWN_FURNITURE_HEIGHT_MM;

		boxes.push({
			x: rect.centerX,
			z: rect.centerY,
			width: rect.width,
			depth: rect.height,
			height: heightMm / MM_PER_CELL,
			angle: rect.angle,
			type,
			subType,
			// A type with no height of its own gets no shape either: the shape would claim to know
			// what the piece is, and the height table is where that knowledge is recorded.
			parts: known ? shapeFor(type, subType) : null,
			model: known ? modelNameFor(type, subType) : null,
			known
		});
	}
	return boxes;
}

/** Millimetres to picture cell coordinates - the flipped frame everything else is drawn in. */
function toPictureCell(mm: CellPoint, left: number, top: number, gridHeight: number): FurniturePoint {
	return { x: mm.x / MM_PER_CELL - left, y: gridHeight - (mm.y / MM_PER_CELL - top) };
}

/**
 * English name of a type, for a tooltip or a log line.
 *
 * Falls back to the type number rather than to a made-up name: a piece labelled "Sofa" that is a
 * cat tree is worse than one labelled "Furniture 61".
 *
 * @param type `type` of the block entry.
 * @param subType `subType` of the block entry.
 * @returns The app's own name, or a neutral stand-in.
 */
export function furnitureTitle(type: number, subType: number): string {
	const entry = FURNITURE_TYPES[type];
	const graphic = entry?.subTypes ? entry.subTypes[subType] : entry?.graphic;
	return graphic?.title ?? `Furniture ${type}`;
}
