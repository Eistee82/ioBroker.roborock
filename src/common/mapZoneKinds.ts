/**
 * The walls and zones a V1 map stores, named once for both sides of the adapter.
 *
 * The adapter rewrites them through `save_map` (`src/lib/features/vacuum/services/
 * MapEditService.ts`) and the admin tab draws and edits them (`src-tab/src/engine/mapZones.ts`).
 * Both have to agree on which map block each kind lives in, how many numbers a record carries and
 * how many of a kind a map may hold - and they have to keep agreeing.
 *
 * ## Why this file exists rather than a copy on each side
 *
 * The tab cannot import `MapEditService`: that module pulls the map decryptor and the parser in
 * with it, and through them the adapter's own type environment, none of which belongs in a browser
 * bundle. The obvious way out is to restate the four constants in the tab and pin them with a test
 * - but a restatement is exactly what drifts, and this one drifts **silently**: rename a block on
 * the adapter side and the tab reads a key that is no longer there, which looks precisely like
 * "this map has no zones". A zone list that reads as empty is the one mistake that must not happen
 * here, because `save_map` keeps only what it is sent (`_appanalysis/14-editor-methoden.md`
 * section 2.1).
 *
 * So the constants live here, in `src/common/` next to the other code both sides share
 * (`coordTransformation.ts`, `mapDrawing/`), and this file imports nothing at all. That is what
 * makes it safe for the browser bundle.
 *
 * Every value below is taken from Roborock's own control plugin for the a65; the report sections
 * are named at each one.
 */

/**
 * Record type codes of the `save_map` payload (report section 1.6).
 *
 * The payload is `walls.concat(fbz)`, so walls come first; the order is kept because it is the
 * order the app sends and nothing tells us the firmware ignores it.
 */
export const MAP_RECORD_TYPES = { wall: 1, no_go: 0, no_mop: 2 } as const;

/** The kinds of overlay this adapter can read back off the map and therefore rewrite safely. */
export type MapZoneKind = keyof typeof MAP_RECORD_TYPES;

/** `[100, mapFlag]` names the map slot; the app appends it only in multi-map operation. */
export const MAP_RECORD_MAP_SLOT = 100;

/** `MAX_COUNT_WALL_OR_FBZ` (module 1507, report section 1.6): ten per kind, not ten in total. */
export const MAX_COUNT_WALL_OR_FBZ = 10;

/** How many numbers a record of each kind carries after the type code. */
export const ZONE_LENGTHS: Readonly<Record<MapZoneKind, number>> = { wall: 4, no_go: 8, no_mop: 8 };

/** What the user sees these called; matches the app's own labels (report section 1.6). */
export const ZONE_LABELS: Readonly<Record<MapZoneKind, string>> = {
	wall: "invisible wall",
	no_go: "no-go zone",
	no_mop: "no-mop zone",
};

/**
 * Which parsed map block each overlay kind is read from.
 *
 * The parser fills these three at `src/lib/map/v1/MapParser.ts:302-323`, and the adapter reads them
 * straight back out of the same parse result. The tab reads the identical blocks out of the
 * `map.mapData` state, which carries that parse result unchanged
 * (`src/lib/map/MapManager.ts:206-210` and `:635-639`).
 */
export const ZONE_BLOCKS: Readonly<Record<MapZoneKind, string>> = {
	wall: "VIRTUAL_WALLS",
	no_go: "FORBIDDEN_ZONES",
	no_mop: "NO_MOP_ZONE",
};

/**
 * Map blocks that `save_map` would carry but this adapter cannot rebuild.
 *
 * Record type 3 (`FBZ_TYPE_CLEANING`, the Garnet generation's cleaning-free zone) is in the app's
 * payload, but the report marks its device semantics as inferred rather than proven and never says
 * which map block it comes back in. Rather than guess, a map that has one of these blocks is left
 * alone entirely - writing without them would delete them.
 */
export const UNREPRODUCIBLE_BLOCKS: readonly string[] = ["CL_FORBIDDEN_ZONES", "CLF_FORBIDDEN_ZONES"];

/** The command state that adds one wall or zone, and which kind each of them adds. */
export const ZONE_ADD_COMMANDS: Readonly<Record<string, MapZoneKind>> = {
	add_virtual_wall: "wall",
	add_no_go_zone: "no_go",
	add_no_mop_zone: "no_mop",
};

/** Command that removes one wall or zone, or clears them all. */
export const ZONE_REMOVE_COMMAND = "remove_map_zone";

/**
 * Longest room name the app accepts (`map_edit_max_input_length_tip`, "Up to 30 characters").
 *
 * Here rather than beside the room commands for the same reason as everything else in this file:
 * the admin tab has to stop the input at the same place the adapter refuses, and it cannot import
 * `MapEditService`.
 */
export const MAX_ROOM_NAME_LENGTH = 30;

/**
 * Command that changes one wall or zone in place.
 *
 * Exists so that moving one is a **single** read-change-write cycle. "Remove, then add" would be
 * two, with the zone absent in between and with the second cycle reading a map that may not yet
 * show the first write - see `parseZoneUpdate` in `MapEditService.ts` for the full reasoning.
 */
export const ZONE_UPDATE_COMMAND = "update_map_zone";

/**
 * Highest coordinate a map record can hold.
 *
 * The blocks are read as `uint16` (`MapParser.ts:307`, `:322`), so a coordinate outside this range
 * does not fail loudly - it wraps, and the zone turns up somewhere else entirely.
 */
export const MAP_ZONE_MAX_MM = 0xffff;

/**
 * Reads a zone or wall a user wrote into one of the `add_...` command states.
 *
 * Coordinates are the robot's own millimetres, the same unit the map states report. A zone may be
 * given either as its four corners (`[x0,y0, x1,y1, x2,y2, x3,y3]`, which is what a rotated zone
 * needs) or as two opposite corners of an upright rectangle; a wall is always its two end points.
 *
 * Shared rather than private to the adapter so the tab can put its own payload through the very
 * same check before sending it. Without that the tab has no way of learning that a payload was
 * refused at all: `set_state` answers `{result:"ok"}` as soon as the value is written, long before
 * the robot is asked (`src/lib/socketHandler.ts:436-443`), and everything after that goes to the
 * adapter log.
 * @param kind Which overlay is being added.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @returns The coordinates without the leading record type.
 * @throws If the value is not a well-formed zone.
 */
export function parseZoneInput(kind: MapZoneKind, raw: unknown): number[] {
	if (!Array.isArray(raw)) {
		throw new Error(kind === "wall"
			? "add_virtual_wall expects [xStart, yStart, xEnd, yEnd] in millimetres."
			: `A ${ZONE_LABELS[kind]} is [x0,y0, x1,y1, x2,y2, x3,y3] (four corners) or [x1,y1, x2,y2] (two opposite corners of an upright rectangle), in millimetres.`);
	}

	const values = raw.map((entry, index) => {
		const value = typeof entry === "number" ? entry : Number(entry);
		if (!Number.isFinite(value)) {
			throw new Error(`Coordinate ${index} of the ${ZONE_LABELS[kind]} is not a number: ${JSON.stringify(entry)}`);
		}
		return Math.round(value);
	});

	if (kind === "wall") {
		if (values.length !== 4) {
			throw new Error(`An invisible wall is [xStart, yStart, xEnd, yEnd] - four numbers, got ${values.length}.`);
		}
		if (values[0] === values[2] && values[1] === values[3]) {
			throw new Error("An invisible wall needs two different end points; start and end are the same point.");
		}
		return values;
	}

	if (values.length === 8) return values;
	if (values.length === 4) return rectangleToCorners(values);

	throw new Error(`A ${ZONE_LABELS[kind]} is either eight numbers (four corners) or four numbers (two opposite corners), got ${values.length}.`);
}

/**
 * Expands two opposite corners into the four-corner order the app uses.
 *
 * Report section 1.6: `x0,y0 = (x, y1+h); x1,y1 = (x+w, y1+h); x2,y2 = (x+w, y1); x3,y3 = (x, y1)`,
 * so the corners run from the top left clockwise with y counting upwards, the way SLAM coordinates
 * do.
 * @param rectangle `[x1, y1, x2, y2]`, any two opposite corners.
 * @returns The eight coordinates of the four corners.
 * @throws If the rectangle has no area.
 */
function rectangleToCorners(rectangle: number[]): number[] {
	const left = Math.min(rectangle[0], rectangle[2]);
	const right = Math.max(rectangle[0], rectangle[2]);
	const bottom = Math.min(rectangle[1], rectangle[3]);
	const top = Math.max(rectangle[1], rectangle[3]);

	if (left === right || bottom === top) {
		throw new Error(`A zone needs a width and a height; [${rectangle.join(", ")}] describes a line.`);
	}

	return [left, top, right, top, right, bottom, left, bottom];
}
