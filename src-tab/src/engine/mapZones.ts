/**
 * The no-go zones, no-mop zones and invisible walls that are **on the robot's map**, as the tab
 * reads, edits and sends them.
 *
 * ## Why this is a module of its own
 *
 * The map carries two completely different kinds of rectangle, and confusing them would be
 * expensive:
 *
 *  - A **cleaning zone** (`MapEngine.rects`) is a scratch pad. It exists in the browser, it is sent
 *    as `app_zoned_clean` and it is gone afterwards. Getting one wrong costs one cleaning run.
 *  - A **map zone** - what this module is about - is stored in the robot's own map and survives
 *    everything. Getting one wrong costs the user a boundary they set up by hand, and `save_map`
 *    deletes every zone it is not sent (`_appanalysis/14-editor-methoden.md` section 2.1).
 *
 * The adapter guards the dangerous half: `MapEditService` reads the robot's own map, lays the
 * change over it and writes the complete set back (`src/lib/features/vacuum/services/
 * MapEditService.ts:1188-1204`). This module is the other end of the same wire - it reads what the
 * adapter published, keeps the geometry, and produces exactly the payloads those commands accept.
 * It sends nothing itself and it knows no socket; that is `MapEngine`'s job.
 *
 * ## Where the numbers come from
 *
 * Everything here is in the **robot's own millimetres**, the unit the map blocks are stored in and
 * the unit the `add_*` commands expect (`MapEditService.ts:556-558`). No pixel ever enters this
 * file, so nothing here depends on zoom, map size or which pipeline drew the picture.
 *
 * | Kind | Map block | Numbers per record | Meaning |
 * | --- | --- | --- | --- |
 * | `no_go` | `FORBIDDEN_ZONES` | 8 | four corners |
 * | `no_mop` | `NO_MOP_ZONE` | 8 | four corners |
 * | `wall` | `VIRTUAL_WALLS` | 4 | two end points |
 *
 * Proved on both sides: the parser fills the blocks at `src/lib/map/v1/MapParser.ts:302-323`
 * (`VIRTUAL_WALLS` as four `uint16`, the two zone blocks as sixteen bytes = eight `uint16` each),
 * and `MapEditService` reads the very same three block names back out of the very same parse
 * result (`ZONE_BLOCKS`, `MapEditService.ts:465-469`, lengths at `:435`).
 *
 * The tab gets the parse result unchanged: `MapManager.processMap` returns it
 * (`src/lib/map/MapManager.ts:206-210`) and `saveGeneratedMap` writes `JSON.stringify` of it into
 * `Devices.<duid>.map.mapData` (`:635-639`). Drawing does not touch it - `canvasMap` only reads
 * (`src/lib/map/v1/MapBuilder.ts:177-250`).
 *
 * ## Why an index is enough to name a zone, and where that stops being true
 *
 * `save_map` has no zone ids at all (report section 2.1), so `remove_map_zone` names a zone by its
 * **position within its own kind** (`MapEditService.ts:1242-1251`). That index is well defined for
 * the tab as well, because both sides count into the same list: the adapter re-reads the map
 * through the same `MapParser` and keeps the block order (`readZoneBlock`, `:511-529`).
 *
 * What the index cannot survive is the map changing underneath it - the phone app adding a zone
 * between the tab's snapshot and the command arriving. {@link zoneRemovalPayload} therefore carries
 * the coordinates the user actually pointed at alongside the index, so a mismatch can be refused
 * instead of deleting the neighbour.
 */

import {
	MAP_ZONE_MAX_MM,
	MAX_COUNT_WALL_OR_FBZ,
	parseZoneInput,
	UNREPRODUCIBLE_BLOCKS,
	ZONE_ADD_COMMANDS,
	ZONE_BLOCKS,
	ZONE_LENGTHS,
	ZONE_REMOVE_COMMAND,
	ZONE_UPDATE_COMMAND,
} from "@adapter/common/mapZoneKinds";
import type { MapZoneKind } from "@adapter/common/mapZoneKinds";

export { MAP_ZONE_MAX_MM, parseZoneInput, ZONE_BLOCKS, ZONE_LENGTHS };
export type { MapZoneKind };

/** Ten per kind, not ten in total; the adapter refuses beyond it (`MapEditService.ts:1215-1217`). */
export const MAP_ZONE_LIMIT = MAX_COUNT_WALL_OR_FBZ;

/** The command that removes one, or clears them all. */
export const MAP_ZONE_REMOVE_COMMAND = ZONE_REMOVE_COMMAND;

/** The command that changes one in place, in a single read-change-write cycle. */
export const MAP_ZONE_UPDATE_COMMAND = ZONE_UPDATE_COMMAND;

/**
 * In drawing order: walls last, so a wall stays clickable where it crosses a zone.
 *
 * Derived from the adapter's own record-type table rather than written out again, so a kind that
 * appears there appears here.
 */
export const MAP_ZONE_KINDS: readonly MapZoneKind[] = ["no_go", "no_mop", "wall"];

/** Which command state adds one of each kind, keyed by kind rather than by command name. */
export const MAP_ZONE_ADD_COMMANDS: Readonly<Record<MapZoneKind, string>> = (() => {
	const byKind = {} as Record<MapZoneKind, string>;
	for (const [command, kind] of Object.entries(ZONE_ADD_COMMANDS)) {
		byKind[kind] = command;
	}
	return byKind;
})();

/** The command folder every one of them lives in. */
export const MAP_ZONE_COMMAND_FOLDER = "commands";

/** A point in the robot's own millimetres. */
export interface MapZonePoint {
	x: number;
	y: number;
}

/** One wall or zone as it stands on the robot's map right now. */
export interface MapZone {
	kind: MapZoneKind;
	/**
	 * Position within its own kind - the number `remove_map_zone` counts
	 * (`MapEditService.ts:1242-1251`). Unique only together with {@link MapZone.kind}.
	 */
	index: number;
	/** Four corners of a zone, or the two end points of a wall, in millimetres. */
	points: MapZonePoint[];
}

/** Why the adapter would refuse to edit the zones of this map. */
export type MapZoneRefusal =
	/** No `IMAGE` block: an unreadable map would otherwise look like a map without zones. */
	| { reason: "unparsed" }
	/** An overlay the adapter cannot rebuild, so writing would delete it. */
	| { reason: "unreproducible"; block: string }
	/** A record of the wrong shape; the adapter refuses rather than write a short list. */
	| { reason: "malformed"; block: string };

/** What {@link readMapZones} found. */
export interface MapZoneReading {
	/** Every wall and zone on the map, in the order the adapter indexes them. */
	zones: MapZone[];
	/** Null when the zones may be edited, otherwise the reason the adapter would give. */
	refusal: MapZoneRefusal | null;
}

/**
 * Reads every wall and zone out of a parsed V1 map.
 *
 * Deliberately as strict as the adapter is: it reports the same refusals `readOverlaysFromMap`
 * throws (`MapEditService.ts:482-529`), because a tab that offered an edit the adapter will refuse
 * would put the explanation in the log and leave the user with a button that does nothing.
 * @param mapData The parsed map from `map.mapData`, or anything that is not one.
 * @returns The zones, and why they may not be edited if that is the case.
 */
export function readMapZones(mapData: unknown): MapZoneReading {
	if (!mapData || typeof mapData !== "object" || Array.isArray(mapData)) {
		return { zones: [], refusal: { reason: "unparsed" } };
	}

	const map = mapData as Record<string, unknown>;
	if (map.IMAGE === undefined) {
		return { zones: [], refusal: { reason: "unparsed" } };
	}

	for (const block of UNREPRODUCIBLE_BLOCKS) {
		const value = map[block];
		if (Array.isArray(value) && value.length > 0) {
			return { zones: [], refusal: { reason: "unreproducible", block } };
		}
	}

	const zones: MapZone[] = [];
	for (const kind of MAP_ZONE_KINDS) {
		const block = ZONE_BLOCKS[kind];
		const raw = map[block];
		if (raw === undefined || raw === null) continue;
		if (!Array.isArray(raw)) {
			return { zones: [], refusal: { reason: "malformed", block } };
		}

		for (let index = 0; index < raw.length; index++) {
			const points = readRecord(raw[index], ZONE_LENGTHS[kind]);
			if (!points) {
				return { zones: [], refusal: { reason: "malformed", block } };
			}
			zones.push({ kind, index, points });
		}
	}

	return { zones, refusal: null };
}

/**
 * Turns one raw record into its points, or rejects it.
 * @param entry One entry of a map block.
 * @param length How many numbers a record of this kind carries.
 * @returns The points, or null when the record has the wrong shape.
 */
function readRecord(entry: unknown, length: number): MapZonePoint[] | null {
	if (!Array.isArray(entry) || entry.length !== length) return null;

	const points: MapZonePoint[] = [];
	for (let i = 0; i < length; i += 2) {
		const x = toFiniteNumber(entry[i]);
		const y = toFiniteNumber(entry[i + 1]);
		if (x === null || y === null) return null;
		points.push({ x, y });
	}
	return points;
}

/**
 * Accepts the number, and the numeric string a JSON round trip may have left behind.
 * @param value One coordinate as it came out of the state.
 * @returns The number, or null when it is not one.
 */
function toFiniteNumber(value: unknown): number | null {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? Math.round(number) : null;
}

/**
 * A four-corner zone described the way a handle has to think about it.
 *
 * The map stores four corners, which is what a rotated zone needs, but no gesture works on four
 * independent points: moving means shifting all four, resizing means changing the extent along the
 * zone's **own** axes rather than along the screen's, and rotating means turning all four about the
 * middle. Centre, half extents and angle say the same thing in the form those three need.
 */
export interface ZoneBox {
	/** Centre in millimetres. */
	cx: number;
	cy: number;
	/** Half the extent along the zone's own width axis. */
	halfWidth: number;
	/** Half the extent along the zone's own height axis. */
	halfHeight: number;
	/**
	 * Rotation in radians, counter-clockwise, in the robot's own frame where y counts **upwards**.
	 *
	 * Not the screen angle: the map draws with y downwards, so a renderer has to negate it. Keeping
	 * the robot's sense here is what makes {@link boxCorners} produce a payload directly.
	 */
	angle: number;
}

/**
 * Reads centre, extent and rotation off the four corners of a zone.
 *
 * The corner order is the one the app writes and the adapter reproduces: from the top left
 * clockwise with y counting upwards (`rectangleToCorners`, `MapEditService.ts:595-616`, report
 * section 1.6). So `p0 -> p1` runs along the width and `p1 -> p2` along the height, which is all
 * that is needed - no guessing which edge is which.
 * @param points The four corners, in millimetres.
 * @returns The box, or null when the record is not four corners.
 */
export function zoneBox(points: MapZonePoint[]): ZoneBox | null {
	if (points.length !== 4) return null;

	const [p0, p1, p2] = points;
	const width = Math.hypot(p1.x - p0.x, p1.y - p0.y);
	const height = Math.hypot(p2.x - p1.x, p2.y - p1.y);

	return {
		cx: (points[0].x + points[1].x + points[2].x + points[3].x) / 4,
		cy: (points[0].y + points[1].y + points[2].y + points[3].y) / 4,
		halfWidth: width / 2,
		halfHeight: height / 2,
		// A zone of zero width has no direction to read; 0 keeps it upright instead of letting
		// `atan2(0, 0)` decide.
		angle: width === 0 ? 0 : Math.atan2(p1.y - p0.y, p1.x - p0.x),
	};
}

/**
 * Builds the four corners of a box, in the order the robot and the adapter expect.
 *
 * The inverse of {@link zoneBox}, and the order matters: `parseZoneInput` passes an eight-number
 * payload straight through (`MapEditService.ts:589`), so this order is what ends up in the map.
 * @param box Centre, extent and rotation in millimetres.
 * @returns The four corners, from the top left clockwise with y counting upwards.
 */
export function boxCorners(box: ZoneBox): MapZonePoint[] {
	const cos = Math.cos(box.angle);
	const sin = Math.sin(box.angle);
	// The zone's own axes: `u` along its width, `v` along its height.
	const ux = cos * box.halfWidth;
	const uy = sin * box.halfWidth;
	const vx = -sin * box.halfHeight;
	const vy = cos * box.halfHeight;

	return [
		{ x: box.cx - ux + vx, y: box.cy - uy + vy },
		{ x: box.cx + ux + vx, y: box.cy + uy + vy },
		{ x: box.cx + ux - vx, y: box.cy + uy - vy },
		{ x: box.cx - ux - vx, y: box.cy - uy - vy },
	];
}

/**
 * The two end points of a wall described as a box.
 *
 * A wall is a line, so it has no height - but the same centre, half length and angle describe it
 * completely, which lets the move, resize and turn gestures work on a wall exactly as they do on a
 * zone instead of needing a second set of arithmetic.
 * @param box Centre, half length in `halfWidth`, and direction.
 * @returns Start and end point in millimetres.
 */
export function wallEndpoints(box: ZoneBox): MapZonePoint[] {
	const ux = Math.cos(box.angle) * box.halfWidth;
	const uy = Math.sin(box.angle) * box.halfWidth;
	return [
		{ x: box.cx - ux, y: box.cy - uy },
		{ x: box.cx + ux, y: box.cy + uy },
	];
}

/**
 * The points a record of the given kind is made of, from its box.
 * @param kind Which overlay.
 * @param box Centre, extent and rotation in millimetres.
 * @returns Four corners for a zone, two end points for a wall.
 */
export function boxPoints(kind: MapZoneKind, box: ZoneBox): MapZonePoint[] {
	return kind === "wall" ? wallEndpoints(box) : boxCorners(box);
}

/**
 * Reads a box back off the points of a record of either kind.
 * @param kind Which overlay.
 * @param points Four corners, or two end points.
 * @returns The box, or null when the points do not match the kind.
 */
export function pointsBox(kind: MapZoneKind, points: MapZonePoint[]): ZoneBox | null {
	if (kind !== "wall") return zoneBox(points);
	if (points.length !== 2) return null;

	const [start, end] = points;
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	return {
		cx: (start.x + end.x) / 2,
		cy: (start.y + end.y) / 2,
		halfWidth: Math.hypot(dx, dy) / 2,
		halfHeight: 0,
		// A wall of zero length has no direction to read; 0 keeps it horizontal rather than letting
		// `atan2(0, 0)` decide.
		angle: dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx),
	};
}

/**
 * Whether every point of a record stays inside what a `uint16` map block can hold.
 *
 * A coordinate outside the range does not fail loudly - it wraps on the way into the map and the
 * zone turns up somewhere else. Refusing beforehand is the only way a user finds out at all.
 * @param points The points of one record.
 * @returns True when all of them can be stored.
 */
export function pointsFitTheMap(points: MapZonePoint[]): boolean {
	return points.every(
		(point) =>
			point.x >= 0 && point.x <= MAP_ZONE_MAX_MM && point.y >= 0 && point.y <= MAP_ZONE_MAX_MM,
	);
}

/**
 * The payload of one `add_*` command.
 *
 * A zone always goes out as its four corners rather than as two opposite ones, even when it is
 * upright: `parseZoneInput` expands the short form itself (`MapEditService.ts:590`), so sending the
 * long form is the same value with one conversion less - and it is the only form a rotated zone
 * has.
 * @param kind Which overlay is being added.
 * @param points Four corners, or the two end points of a wall, in millimetres.
 * @returns The numbers for the command state.
 * @throws If the point count does not match the kind.
 */
export function zoneAddPayload(kind: MapZoneKind, points: MapZonePoint[]): number[] {
	const expected = ZONE_LENGTHS[kind] / 2;
	if (points.length !== expected) {
		throw new Error(`A ${kind} record has ${expected} point(s), got ${points.length}.`);
	}

	const values: number[] = [];
	for (const point of points) {
		values.push(Math.round(point.x), Math.round(point.y));
	}
	return values;
}

/**
 * The payload of `remove_map_zone` for one zone.
 *
 * `zone` is not part of what the adapter reads today - `parseZoneRemoval` takes `kind` and `index`
 * and ignores the rest (`MapEditService.ts:635-660`). It is sent anyway so that the request carries
 * what the user actually pointed at: an adapter that learns to compare it can refuse a stale index
 * instead of deleting the neighbour, and one that does not is unaffected, because an unknown key in
 * a JSON payload changes nothing.
 * @param zone The wall or zone to remove.
 * @returns The object for the command state.
 */
export function zoneRemovalPayload(zone: MapZone): { kind: MapZoneKind; index: number; zone: number[] } {
	return { kind: zone.kind, index: zone.index, zone: zoneAddPayload(zone.kind, zone.points) };
}

/**
 * The payload of `update_map_zone` for one changed wall or zone.
 *
 * `from` carries what that index held when the user started, so the adapter can refuse rather than
 * write over a zone that is no longer the one they were looking at. `zone` is where it is to be
 * afterwards.
 *
 * One command rather than a removal followed by an addition, and the difference is not cosmetic:
 * those would be two complete rewrites of the robot's set of walls and zones, with the zone absent
 * in between, and with the second rewrite reading a map that may not show the first one yet.
 * @param origin The zone as it stands on the robot.
 * @param points Where it is to be afterwards, in millimetres.
 * @returns The object for the command state.
 */
export function zoneUpdatePayload(
	origin: MapZone,
	points: MapZonePoint[],
): { kind: MapZoneKind; index: number; zone: number[]; from: number[] } {
	return {
		kind: origin.kind,
		index: origin.index,
		zone: zoneAddPayload(origin.kind, points),
		from: zoneAddPayload(origin.kind, origin.points),
	};
}

/** How many of one kind are on the map, so the tab can stop at the limit before the adapter does. */
export function countZonesOfKind(zones: MapZone[], kind: MapZoneKind): number {
	return zones.reduce((count, zone) => count + (zone.kind === kind ? 1 : 0), 0);
}

/**
 * Identifies one zone across a redraw.
 *
 * A d3 data join needs a key, and the map gives none: `index` repeats across kinds and `points`
 * change while a gesture runs. Kind and index together are what the adapter itself uses to name a
 * zone, so the tab uses the same handle rather than inventing a second identity.
 * @param zone The wall or zone.
 * @returns A key unique within one reading.
 */
export function mapZoneKey(zone: MapZone): string {
	return `${zone.kind}:${zone.index}`;
}
