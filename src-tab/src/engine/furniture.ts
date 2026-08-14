/**
 * Furniture of block type 25: which graphic belongs to a type, and how four corner points become
 * a rectangle with a rotation.
 *
 * ## Where the numbers come from
 *
 * Everything here is read out of the decompiled Roborock control plugin
 * (`roborock.vacuum.a65_control_v5208`) and the app's own map parser
 * (`projects_comroborocktanos_parser_workermapparser.jx`); the findings are written up in
 * `_appanalysis/15-livemap-und-moebel.md` §2.3 – §2.7. Nothing is guessed: a type that has no
 * proven graphic gets no graphic, and the renderer draws a neutral outline for it instead of
 * pointing at a file that would either not exist or show the wrong piece of furniture.
 *
 * ## Where the images come from
 *
 * The same place the mode icons come from - the per-user download of the control plugin that
 * `AppPluginManager` unpacks into `roborock/assets/<model>/drawable-mdpi/`. Nothing is shipped
 * with the adapter, so every consumer has to survive a missing file; `SVGMapRenderer` does that
 * by probing the URL and keeping the neutral outline when the probe fails.
 */

/** Every asset of the control plugin starts with the project the app builds it from. */
const ASSET_PREFIX = "projects_comroborocktanos_resources_furniture";

/** One drawable piece: the asset stem of its map graphic and the name the app shows for it. */
export interface FurnitureGraphic {
	/**
	 * Stem of the `image` asset - the one the app draws on the map, as opposed to `imageEdit`,
	 * `bubble_image` or `ai_image`.
	 */
	image: string;
	/** English name from the app's `map_edit_furniture_*` strings. */
	title: string;
}

/**
 * One entry of `FurnitureType`.
 *
 * `_getFurnitureImage` picks `res[subType].image` when the type declares subtypes and the entry
 * carries one, and `res.image` otherwise. FT_BED, FT_SOFA and FT_TEATABLE only ever have subtype
 * entries - a bed whose subtype is 0 therefore has no graphic at all, in the app as much as here.
 */
export interface FurnitureTypeEntry {
	/** Graphic of a type that has no subtypes. */
	graphic?: FurnitureGraphic;
	/** Graphic per subtype; checked before {@link graphic}. */
	subTypes?: Record<number, FurnitureGraphic>;
}

/**
 * The proven type table (`FurnitureType`, A65 342666) together with the resource assignment
 * (`FurnitureResource`, A65 342685–343392).
 *
 * Type 0 (`FT_UNKNOWN`) is deliberately absent - it has no resource entry. So are the subtype
 * values 0 of bed, sofa and tea table, for the same reason.
 */
export const FURNITURE_TYPES: Record<number, FurnitureTypeEntry> = {
	// FT_TVCABINET
	43: { graphic: { image: "tv_cabinet", title: "TV Stand" } },
	// FT_TOILET - the only type with an `image` but no editing artwork at all.
	44: { graphic: { image: "icon_toilet", title: "Toilet" } },
	// FT_BED; both subtypes carry the same name in the app.
	45: {
		subTypes: {
			1: { image: "bed_single", title: "Bed" },
			2: { image: "bed_double", title: "Bed" },
		},
	},
	// FT_SOFA
	46: {
		subTypes: {
			1: { image: "sofa_single", title: "Single sofa" },
			2: { image: "sofa_double", title: "Double sofa" },
			3: { image: "sofa_three", title: "Multi-seat sofa" },
			4: { image: "sofa_sectional", title: "Modular sofa" },
			5: { image: "sofa_sectional_left", title: "Modular sofa" },
		},
	},
	// FT_DINNERTABLE
	47: { graphic: { image: "dinner_table", title: "Dining Set" } },
	// FT_TEATABLE
	48: {
		subTypes: {
			1: { image: "table_circle", title: "Coffee table" },
			2: { image: "table_rect", title: "Square table" },
		},
	},
	// FT_SHOECABINET
	49: { graphic: { image: "shoe_cabinet", title: "Shoe rack" } },
	// FT_NIGHTSTAND
	50: { graphic: { image: "night_stand", title: "Night Stand" } },
	// FT_WARDROBE
	51: { graphic: { image: "wardrobe", title: "Wardrobe" } },
	// FT_OPENCATTOILET
	52: { graphic: { image: "open_cattoilet", title: "Cat Litter Box" } },
	// FT_CATTOILET
	53: { graphic: { image: "cat_toilet", title: "Enclosed litter box" } },
	// FT_PETCAGE
	54: { graphic: { image: "pet_cage", title: "Pet cage" } },
	// FT_PETWATERLOO
	55: { graphic: { image: "pet_waterloo", title: "Pet bed" } },
	// FT_PETBOWL
	56: { graphic: { image: "pet_bowl", title: "Pet bowls" } },
	// FT_FLOORMIRROR
	57: { graphic: { image: "floor_mirror", title: "Floor Mirror" } },
	// FT_CATTREE
	58: { graphic: { image: "cat_tree", title: "Cat Tower" } },
};

/**
 * Resolves the graphic of one piece of furniture.
 *
 * @param type Value of the `type` field of the block entry.
 * @param subType Value of its `subType` field.
 * @returns The proven graphic, or null when this pair has none.
 */
export function furnitureGraphic(type: number, subType: number): FurnitureGraphic | null {
	const entry = FURNITURE_TYPES[type];
	if (!entry) return null;
	if (entry.subTypes) return entry.subTypes[subType] ?? null;
	return entry.graphic ?? null;
}

/**
 * Builds the file name of a furniture graphic inside the density folder.
 *
 * @param image Asset stem from {@link FurnitureGraphic}.
 * @returns The plain file name, e.g. `…_furniture_bed_double.png`.
 */
export function furnitureAssetFileName(image: string): string {
	return `${ASSET_PREFIX}_${image}.png`;
}

/** A point in the space the map is drawn in: pixels, y growing downwards. */
export interface FurniturePoint {
	x: number;
	y: number;
}

/** Axis-aligned rectangle plus the rotation that turns it back onto the four corner points. */
export interface FurnitureRect {
	/** Left edge before the rotation is applied. */
	x: number;
	/** Top edge before the rotation is applied. */
	y: number;
	width: number;
	height: number;
	/** Centre the rotation turns around. */
	centerX: number;
	centerY: number;
	/** Rotation in degrees, clockwise - the direction an SVG `rotate()` turns. */
	angle: number;
}

/**
 * Turns the four corner points of a furniture entry into a rectangle and a rotation.
 *
 * This is `decodeMachineFBZ` (A65 477227–477340), the decoder the app runs over furniture,
 * no-go zones, carpet zones and thresholds alike: the edge lengths give width and height, the
 * diagonal gives the centre and the midpoint of the second edge gives the angle. The app works in
 * the same y-down pixel space the map is drawn in here, so the formula is used unchanged.
 *
 * Deliberately not implemented: the extra 180° turn the app applies above 225° (A65 527121–527127).
 * The angle normalisation it works on is not documented in the analysis, and a flip applied to the
 * wrong range would put half the furniture on its head.
 *
 * @param corners The four corner points, already converted into map pixels.
 * @returns The rectangle, or null when the points do not span an area.
 */
export function furnitureRect(corners: readonly FurniturePoint[]): FurnitureRect | null {
	if (corners.length !== 4) return null;
	const [p0, p1, p2, p3] = corners;
	for (const p of corners) {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
	}

	const distance = (a: FurniturePoint, b: FurniturePoint): number => Math.hypot(a.x - b.x, a.y - b.y);
	const height = distance(p0, p3);
	const width = distance(p0, p1);
	if (!(width > 0) || !(height > 0)) return null;

	const centerX = (p0.x + p2.x) / 2;
	const centerY = (p0.y + p2.y) / 2;
	const angle = (Math.atan2((p1.y + p2.y) / 2 - centerY, (p1.x + p2.x) / 2 - centerX) * 180) / Math.PI;

	return {
		x: centerX - width / 2,
		y: centerY - height / 2,
		width,
		height,
		centerX,
		centerY,
		angle,
	};
}
