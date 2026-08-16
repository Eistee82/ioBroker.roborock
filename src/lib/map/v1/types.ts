/**
 * Shared shapes of the V1 map blocks.
 *
 * Kept apart from `MapParser.ts` for the same reason `map/b01/types.ts` is: the admin tab needs
 * these declarations, and importing them from the parser would drag the whole adapter - `main.ts`
 * and its node-only dependencies - into the browser type graph.
 */

/**
 * One room of the image block, as `MapParser` publishes it under `IMAGE.segments.list`.
 *
 * `count` and `bounds` cover the segment's **floor** cells only, which is what `center` has always
 * been derived from. Wall cells carry a segment id as well, so a walls-included figure would be
 * larger - about 13 % on the reference device - and would move every room label. Anything that
 * needs the walls has the raster (`IMAGE.raster`) and can count them itself.
 */
export interface SegmentInfo {
	/** Segment id as the robot uses it, i.e. the value `split_segment` and `name_segment` expect. */
	id: number;
	/** Room name from the cloud, or `""` when the device has no name on record for this segment. */
	name: string;
	/** Centre of the bounding box, in robot coordinates (millimetres). */
	center: [number, number];
	/**
	 * Floor cells the segment occupies. One cell is 50 x 50 mm, so the area in m² is
	 * `count * 0.0025` - the figure the Roborock app tests against its 2 m² floor before it will
	 * divide a room (`_appanalysis/28-raeume-teilen.md` §3.2).
	 *
	 * Optional because a `mapData` state written by an older adapter version does not carry it.
	 */
	count?: number;
	/**
	 * Bounding box of the floor cells, in raster cells of the image block, both ends inclusive.
	 *
	 * Column/row indices, not millimetres: `x_mm = 50 * (IMAGE.position.left + column)` and
	 * `y_mm = 50 * (IMAGE.position.top + row)`. There is **no** flip between the two - see
	 * `_appanalysis/28-raeume-teilen.md` §4.2, where a report that claimed one is corrected.
	 *
	 * Optional for the same reason as {@link count}.
	 */
	bounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

/**
 * One entry of block type 25 (`furnitures`), 23 bytes wide.
 *
 * The field order is the one the Roborock app's own map parser uses
 * (`projects_comroborocktanos_parser_workermapparser.jx`, block 25; written up in
 * `_appanalysis/15-livemap-und-moebel.md` §2.1). The adapter read the right bytes before this
 * interface existed, but named everything from index 8 on one position too early - `percent` was
 * called `x_real`, `type` was called `percent` and so on - which made every consumer draw a piece
 * of furniture with its subtype as its type. Naming the fields instead of indexing an array is
 * what keeps that from happening again.
 */
export interface Furniture {
	/** Corner points, robot coordinates in millimetres. The app divides them by 50 to get pixels. */
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	x3: number;
	y3: number;
	x4: number;
	y4: number;
	/**
	 * Confidence of the AI detection in hundredths of a percent, uint16 @16. The app writes
	 * 10000 (= 100 %) when the user places the item by hand, a value a uint8 could not hold.
	 */
	percent: number;
	/** `FurnitureType`, uint8 @18: 43 = TV cabinet, 44 = toilet, 45 = bed, … 58 = cat tree. */
	type: number;
	/** Subtype within the type, uint8 @19, e.g. 1 = single / 2 = double bed. 0 = unknown. */
	subType: number;
	/**
	 * uint8 @20. Non-zero for furniture the user placed or confirmed - the app draws only those.
	 * Zero marks an unconfirmed AI detection, which the app keeps in a separate `hide` list.
	 */
	edit: number;
	/** Furniture id, uint8 @21; `save_furnitures` addresses an entry by it. */
	id: number;
	/**
	 * uint8 @22. The app's map parser calls it `hasangle`, its editor `direction`, and sets it to
	 * 1 when creating an item. No evaluating code was found, so nothing is derived from it here.
	 */
	hasAngle: number;
}
