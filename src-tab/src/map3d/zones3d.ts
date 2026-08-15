/**
 * No-go zones, no-mop zones and virtual walls as the app builds them in 3D.
 *
 * ## The geometry is read, not chosen
 *
 * All three exist in the native renderer, and each has its own shape. The dispatch that decides
 * which is which is `mapv2/view/OooO0O0.java:607-660`; the two geometry builders are in
 * `mapv2/view/C4192OooO0oo.java`.
 *
 * | Layer | Parser | Shape |
 * | --- | --- | --- |
 * | No-go (`fbzs`) | `C4193OooOO0o.java:161-174` | floor patch at **y = 0.1** plus four side walls from **0 to 10** — `OooO0oo`, `C4192OooO0oo.java:125-152` |
 * | No-mop (`mfbzs`) | `C4193OooOO0o.java:198-211` | the same |
 * | Virtual wall | `C4193OooOO0o.java:292-305`, drawn at `OooO0O0.java:1093` | a slab `(length + 1) × 10 × 1`, centred at **y = 5**, turned onto the segment — `OooO`, `C4192OooO0oo.java:152-171` |
 *
 * Two things worth keeping in mind, because both were guesses that turned out right and one that
 * turned out wrong:
 *
 * - **The zone box has no lid.** The app draws the floor and the four sides, each side twice so it
 *   is visible from within as well, and never a top face. A closed box would double the alpha along
 *   the upper edge and read as a solid block.
 * - **The wall height is the same 10 as the map walls**, for zones and virtual walls alike. So a
 *   zone is exactly as tall as the room it stands in, which is what makes it look like a barrier
 *   rather than a carpet.
 * - **A zone can be turned.** It arrives as four corner points, not as a rectangle, and this project
 *   has already fixed one renderer that reduced a turned zone to its bounding box (`bd8d41a8`).
 *   `furnitureRect` decodes it, which is the app's own `decodeMachineFBZ` and the same decoder it
 *   uses for furniture, no-go zones, carpet zones and thresholds alike.
 *
 * ## The colours are the tab's, not the renderer's
 *
 * The native renderer carries its own set — no-go `#FB080B` at alpha `0x66`/`0x20` by theme
 * (`C4193OooOO0o.java:169`), no-mop `#65ACFA` at alpha `0x88`/`0x33` (`:206`). The tab already has
 * a proven table for the same two layers, taken from the app's `theme.displayZones`
 * (`engine/mapOverlayColors.ts:127-133`), and the 2D view draws with it. Two tables for one pair of
 * zones is how the two views end up disagreeing about which red means "do not go here", so this one
 * follows the tab.
 */

import { furnitureRect } from "../engine/furniture";
import type { FurniturePoint } from "../engine/furniture";
import { MM_PER_CELL, WALL_HEIGHT_CELLS } from "./units";

/** Height of the floor patch inside a zone. The app puts its quad at 0.1 (`C4192OooO0oo.java:141`). */
export const ZONE_FLOOR_HEIGHT = 0.2;

/** Thickness of a zone's side wall, in cells. Chosen: the app draws a face, which has no thickness. */
export const ZONE_WALL_THICKNESS = 0.4;

/** Thickness of a virtual wall, in cells - the app's own `1.0` (`OooO0O0.java:1093`). */
export const VIRTUAL_WALL_THICKNESS = 1;

/** Which layer a zone came from; decides its colour and nothing else. */
export type ZoneKind = "forbidden" | "noMop";

/** One zone, in picture cell coordinates. */
export interface Zone3D {
	kind: ZoneKind;
	/** Centre. */
	x: number;
	z: number;
	/** Footprint before the rotation. */
	width: number;
	depth: number;
	/** Rotation in degrees, clockwise in the picture frame. */
	angle: number;
}

/** One virtual wall, in picture cell coordinates. */
export interface VirtualWall3D {
	/** Centre of the segment. */
	x: number;
	z: number;
	/** Length along the segment, the app's `distance + 1`. */
	length: number;
	/** Rotation in degrees, clockwise in the picture frame. */
	angle: number;
}

/** Everything this module produces. */
export interface Zones3D {
	zones: Zone3D[];
	virtualWalls: VirtualWall3D[];
}

/** Height a zone wall and a virtual wall are extruded to - the same as the map walls. */
export const ZONE_HEIGHT = WALL_HEIGHT_CELLS;

/** Reads a finite number, or null. */
function finite(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Millimetres to picture cell coordinates.
 *
 * The same flip the walls, the floor texture, the furniture and the robot go through
 * (`src/common/mapDrawing/coordHelpers.ts:31-36`). A zone computed in the raw grid frame would sit
 * mirrored against the room it is supposed to close off - which is the exact fault this view
 * already had once.
 */
function toPictureCell(mmX: number, mmY: number, left: number, top: number, gridHeight: number): FurniturePoint {
	return { x: mmX / MM_PER_CELL - left, y: gridHeight - (mmY / MM_PER_CELL - top) };
}

/**
 * Builds the zone bodies out of the published map layers.
 *
 * @param forbidden Value of `mapData.FORBIDDEN_ZONES`; four corner points in millimetres per entry.
 * @param noMop Value of `mapData.NO_MOP_ZONE`; same shape.
 * @param walls Value of `mapData.VIRTUAL_WALLS`; two points in millimetres per entry.
 * @param left Grid offset in cells, `IMAGE.position.left`.
 * @param top Grid offset in cells, `IMAGE.position.top`.
 * @param gridHeight Grid height in cells.
 * @returns The bodies; entries that cannot be read are skipped rather than guessed at.
 */
export function buildZones3D(
	forbidden: unknown,
	noMop: unknown,
	walls: unknown,
	left: number,
	top: number,
	gridHeight: number
): Zones3D {
	return {
		zones: [...readZones(forbidden, "forbidden", left, top, gridHeight), ...readZones(noMop, "noMop", left, top, gridHeight)],
		virtualWalls: readWalls(walls, left, top, gridHeight)
	};
}

/** Four corner points per entry, straight into the app's own rectangle decoder. */
function readZones(value: unknown, kind: ZoneKind, left: number, top: number, gridHeight: number): Zone3D[] {
	if (!Array.isArray(value)) return [];

	const out: Zone3D[] = [];
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length < 8) continue;

		const corners: FurniturePoint[] = [];
		for (let i = 0; i < 8; i += 2) {
			const mmX = finite(entry[i]);
			const mmY = finite(entry[i + 1]);
			if (mmX === null || mmY === null) break;
			corners.push(toPictureCell(mmX, mmY, left, top, gridHeight));
		}
		if (corners.length !== 4) continue;

		const rect = furnitureRect(corners);
		if (!rect) continue;

		out.push({ kind, x: rect.centerX, z: rect.centerY, width: rect.width, depth: rect.height, angle: rect.angle });
	}
	return out;
}

/** Two points per entry; the app adds one cell to the length so butted walls meet. */
function readWalls(value: unknown, left: number, top: number, gridHeight: number): VirtualWall3D[] {
	if (!Array.isArray(value)) return [];

	const out: VirtualWall3D[] = [];
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length < 4) continue;

		const x0 = finite(entry[0]);
		const y0 = finite(entry[1]);
		const x1 = finite(entry[2]);
		const y1 = finite(entry[3]);
		if (x0 === null || y0 === null || x1 === null || y1 === null) continue;

		const a = toPictureCell(x0, y0, left, top, gridHeight);
		const b = toPictureCell(x1, y1, left, top, gridHeight);
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (!(length > 0)) continue;

		out.push({
			x: (a.x + b.x) / 2,
			z: (a.y + b.y) / 2,
			// `+ 1` is the app's, not a rounding: it makes two walls that share an end meet instead of
			// leaving a hairline gap (`OooO`, `C4192OooO0oo.java:158`).
			length: length + 1,
			angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
		});
	}
	return out;
}
