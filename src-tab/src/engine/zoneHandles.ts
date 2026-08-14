import * as d3 from "d3";

/**
 * The operating handles a cleaning zone carries on its frame: delete, resize, move.
 *
 * ## Where the geometry comes from
 *
 * The Roborock app draws every rectangle on the map - cleaning zone, no-go zone, carpet,
 * invisible wall, furniture - with one shared component, and hangs the same set of handles on
 * it. `_appanalysis/17-raumauswahl.md` §B.1-B.3 traces that component in the control plugin of
 * the a65 (`roborock.vacuum.a65_control_v5208`); every number below has its finding there:
 *
 *  - A **cleaning zone gets exactly three** handles: delete, scale, move (§B.4, A65:509880/
 *    509886/509893). Rotating is offered only for no-go zones, carpets and furniture
 *    (A65:521757, 527094, 528128) - `app_zoned_clean` takes axis-parallel rectangles, so a
 *    rotate handle would promise something the RPC cannot carry.
 *  - `rectOperateBoarderDis` = **16 px** (A65:342576-342596) is how far the dashed focus frame
 *    reaches past the rectangle, and by the same amount the handles move outwards from its
 *    corners: delete on the top left, scale on the bottom right (§B.3).
 *  - Move does **not** sit on a corner. It hangs below left on a diagonal line, 30 px further
 *    out in each axis (§B.3, "Der Verschieben-Griff hängt an einer Diagonale", A65:511331-511366).
 *  - The **hit area is 1.5× the glyph**: 24 px picture, 36 px target (§B.3, A65:512721-512731).
 *    On a map that is dragged with the same finger, that ratio is the difference between
 *    operable and annoying.
 *
 * Two deliberate deviations from the original, both noted in the report itself:
 *
 *  1. The app centres the hit area with `1.5 · rectBtn.size / 2` = 22.5 although it is
 *     `1.5 · 24` = 36 wide, which leaves every handle 4.5 px off its corner. §B.3 calls that an
 *     inaccuracy and explicitly not worth copying - we centre exactly.
 *  2. The app's move handle sits a few pixels off the end of its own leash. We put it on the
 *     end of the line, which is what the line is drawing towards.
 *
 * The **artwork is not reproducible**: the six images live in the app theme and are resolved
 * through resource indices that the downloaded plugin does not contain (§B.5.2). Only size and
 * position are provable. The glyphs are therefore Material Design icons, pinned as path data in
 * {@link ZONE_HANDLE_GLYPHS} and checked against `@mui/icons-material` by
 * `zoneHandles.icons.test.tsx`, so the rest of the tab and the map speak the same visual language.
 *
 * ## Why the handles are drawn in world coordinates but sized in screen pixels
 *
 * A zone is a rectangle on the map and has to scale with it - a zone that kept its size while
 * the map zoomed would cover a different area than it cleans. A handle is a control and must
 * not: it stays 24 px whatever the zoom, exactly like `zoneStrokeWidth()` keeps the zone edge
 * at a constant weight by dividing by the zoom.
 *
 * Every handle group therefore carries `translate(centre) scale(1 / zoom)`. Inside that group
 * one unit is one screen pixel, so the glyph is a plain 24 × 24 Material path and the hit
 * circle a plain `r = 18` - no rescaling arithmetic anywhere below the group transform. Only
 * the centres, the leash and the focus frame are computed in world units, and those are what
 * {@link zoneHandleLayout} returns.
 */

/** The three handles of a cleaning zone, in drawing order. */
export const ZONE_HANDLE_KINDS = ["delete", "scale", "move"] as const;

export type ZoneHandleKind = (typeof ZONE_HANDLE_KINDS)[number];

/** The part of a zone rectangle the handles are laid out around. Sizes are world units. */
export interface ZoneHandleRect {
	id: number;
	width: number;
	height: number;
}

/** Edge length of a handle glyph on screen, whatever the zoom (§B.3: `rectBtn.size − 6`). */
export const ZONE_HANDLE_ICON_PX = 24;

/**
 * Diameter of the disc behind a glyph.
 *
 * A touch larger than the glyph box so the strokes of the picture do not sit on the rim. The
 * app draws opaque images instead; a bare white glyph over a map that is itself white-on-blue
 * would disappear wherever it crosses a wall.
 */
export const ZONE_HANDLE_DISC_PX = 26;

/** Edge length of the hit area on screen: 1.5 × the glyph (§B.3, A65:512721-512731). */
export const ZONE_HANDLE_HIT_PX = 36;

/**
 * How far a handle sits outside its corner, in screen pixels.
 *
 * This is `rectOperateBoarderDis` = 16 (§B.3) and does double duty: it is also how far the
 * dashed focus frame reaches past the rectangle, which is why the handles land on the corners
 * of that frame.
 */
export const ZONE_HANDLE_OUTSET_PX = 16;

/** Length of the move handle's leash, per axis, in screen pixels (§B.3: the 30 × 30 diagonal). */
export const ZONE_HANDLE_LEASH_PX = 30;

/**
 * Below this on-screen edge length a zone shows no handles.
 *
 * The handles never cover the zone - they sit outside it, and the circular hit area keeps a
 * clearance of `16·√2 − 18` ≈ 4.6 px from the corner at every zoom and every zone size, so a
 * click inside the rectangle always belongs to the rectangle. What a very small zone does run
 * into is the opposite problem: with several zones on the map, clusters of 36 px controls
 * around 10 px rectangles overlap each other, and a delete button can no longer be attributed
 * by eye to the zone it belongs to. Deleting the wrong zone is the one mistake here that
 * cannot be taken back with the same gesture.
 *
 * The app never meets this: it shows handles on the *focused* rectangle only (§B.1). We show
 * them on all five, so the threshold takes that role - a zone smaller on screen than a single
 * one of its own glyphs keeps only its rectangle, and zooming in brings the handles back. The
 * zone stays draggable throughout, and the dock's remove button is unaffected.
 */
export const ZONE_HANDLE_MIN_ZONE_PX = ZONE_HANDLE_ICON_PX;

/** Weight of the focus frame and of the leash, in screen pixels (§B.3: `borderWidth`/`strokeWidth` 2). */
export const ZONE_FRAME_STROKE_PX = 2;

/**
 * Dash pattern of the focus frame, in screen pixels.
 *
 * `dashed` is proved (§B.3), the pattern behind it is React Native's own default and not in the
 * report - this is a plain dashed line, not a reconstructed one.
 */
export const ZONE_FRAME_DASH_PX: readonly [number, number] = [6, 4];

/**
 * Material Design path data of the three glyphs, in the 24 × 24 box Material draws in.
 *
 * Kept as data rather than as MUI components because this layer is d3, not React: the handles
 * are appended into the map's own SVG, where a React component cannot go. The strings are
 * therefore the one thing here that could silently drift from the rest of the tab's icons -
 * `zoneHandles.icons.test.tsx` renders the MUI components and compares, so a package update
 * that redraws an icon fails a test instead of leaving the map behind.
 */
export const ZONE_HANDLE_GLYPHS: Record<ZoneHandleKind, string> = {
	/** `Delete` - the waste basket. */
	delete: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z",
	/** `OpenInFull` - the diagonal corner arrows, drawn along the bottom-right corner it sits on. */
	scale: "M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z",
	/** `OpenWith` - the four-direction arrow the user described as "ein kreuz mit pfeilen". */
	move: "M10 9h4V6h3l-5-5-5 5h3zm-1 1H6V7l-5 5 5 5v-3h3zm14 2-5-5v3h-3v4h3v3zm-9 3h-4v3H7l5 5 5-5h-3z",
};

/** Translation key of each handle's tooltip. */
export const ZONE_HANDLE_LABEL_KEYS: Record<ZoneHandleKind, string> = {
	delete: "ui_zone_handle_delete",
	scale: "ui_zone_handle_resize",
	move: "ui_zone_handle_move",
};

/** English fallback, used when the admin has no translation loaded for a key. */
export const ZONE_HANDLE_LABEL_FALLBACKS: Record<ZoneHandleKind, string> = {
	delete: "Delete this zone",
	scale: "Resize zone",
	move: "Move zone",
};

/** Centre of one handle, in the coordinates of its zone group (0,0 is the zone's top left). */
export interface ZoneHandlePlacement {
	kind: ZoneHandleKind;
	cx: number;
	cy: number;
}

/** Everything drawn around a zone rectangle, in the zone group's own (world) coordinates. */
export interface ZoneHandleLayout {
	/** False while the zone is too small on screen to attribute its handles to it. */
	visible: boolean;
	/** World units one screen pixel is worth at this zoom; the scale factor of a handle group. */
	unit: number;
	handles: ZoneHandlePlacement[];
	/** The dashed frame the handles sit on the corners of. */
	frame: { x: number; y: number; width: number; height: number };
	/** The diagonal the move handle hangs on. */
	leash: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Places frame, leash and the three handles around a zone.
 * @param rect Size of the zone rectangle in world units.
 * @param zoom Current map zoom; one world unit is `zoom` screen pixels.
 * @param forceVisible Keeps the handles while a gesture is running on this very zone, so
 *   shrinking it with its own scale handle cannot pull that handle out from under the pointer.
 * @returns Positions in the zone group's coordinates, plus the scale factor of a handle group.
 */
export function zoneHandleLayout(
	rect: { width: number; height: number },
	zoom: number,
	forceVisible = false,
): ZoneHandleLayout {
	const usableZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
	const unit = 1 / usableZoom;

	const outset = ZONE_HANDLE_OUTSET_PX * unit;
	const reach = (ZONE_HANDLE_OUTSET_PX + ZONE_HANDLE_LEASH_PX) * unit;
	const width = Math.max(0, rect.width);
	const height = Math.max(0, rect.height);

	const smallestEdgeOnScreen = Math.min(width, height) * usableZoom;

	return {
		visible: forceVisible || smallestEdgeOnScreen >= ZONE_HANDLE_MIN_ZONE_PX,
		unit,
		handles: [
			{ kind: "delete", cx: -outset, cy: -outset },
			{ kind: "scale", cx: width + outset, cy: height + outset },
			{ kind: "move", cx: -reach, cy: height + reach },
		],
		frame: { x: -outset, y: -outset, width: width + 2 * outset, height: height + 2 * outset },
		leash: { x1: -outset, y1: height + outset, x2: -reach, y2: height + reach },
	};
}

/** What {@link layoutZoneHandles} needs to place the handles of every zone. */
export interface ZoneHandleLayoutOptions {
	/** Current map zoom, so the handles can undo it and stay the same size on screen. */
	zoom: number;
	/** Zone currently being dragged or resized; it keeps its handles however small it got. */
	activeZoneId?: number | null;
}

/**
 * What {@link renderZoneHandles} needs on top of that to build them once.
 *
 * Generic over the rectangle type because a d3 selection is invariant in its datum: the engine
 * binds its own `Rect`, which carries a position on top of {@link ZoneHandleRect}, and a
 * signature fixed to the smaller type would refuse it.
 */
export interface ZoneHandleRenderOptions<Datum extends ZoneHandleRect> extends ZoneHandleLayoutOptions {
	/** Translator of the tooltips; the same one the engine uses everywhere else. */
	t: (key: string, fallback: string) => string;
	/** Removes exactly the zone whose delete handle was pressed. */
	onDelete: (id: number) => void;
	/** The engine's resize gesture, attached to the scale handle. */
	scaleDrag: d3.DragBehavior<SVGGElement, Datum, unknown>;
}

/**
 * Builds the handles of every zone that has none yet, then lays them all out.
 *
 * Safe to call on the merged selection of the zone data join: a zone that already carries its
 * handles is left alone, so listeners are attached exactly once per zone.
 * @param zones Selection of `g.zone` groups, each bound to its rectangle.
 * @param options Zoom, translator and the two gestures the handles trigger.
 */
export function renderZoneHandles<Datum extends ZoneHandleRect>(
	zones: d3.Selection<SVGGElement, Datum, any, any>,
	options: ZoneHandleRenderOptions<Datum>,
): void {
	zones.each(function () {
		const zone = d3.select<SVGGElement, Datum>(this);
		if (!zone.select("g.zone-handles").empty()) return;

		const group = zone.append("g").attr("class", "zone-handles");
		group.append("rect").attr("class", "zone-focus-frame");
		group.append("line").attr("class", "zone-leash");

		for (const kind of ZONE_HANDLE_KINDS) {
			const handle = group.append("g").attr("class", `zone-handle zone-handle-${kind}`).attr("role", "button");
			const label = options.t(ZONE_HANDLE_LABEL_KEYS[kind], ZONE_HANDLE_LABEL_FALLBACKS[kind]);
			// A `title` child is the tooltip an SVG element gets natively; `aria-label` is what a
			// screen reader reads out. The React controls around the map carry both as well.
			handle.append("title").text(label);
			handle.attr("aria-label", label);
			handle.append("circle").attr("class", "zone-handle-hit").attr("r", ZONE_HANDLE_HIT_PX / 2);
			handle.append("circle").attr("class", "zone-handle-disc").attr("r", ZONE_HANDLE_DISC_PX / 2);
			handle
				.append("path")
				.attr("class", "zone-handle-glyph")
				.attr("d", ZONE_HANDLE_GLYPHS[kind])
				// The Material box is 24 × 24 with its origin in the corner; the handle group has
				// its origin in the centre.
				.attr("transform", `translate(${-ZONE_HANDLE_ICON_PX / 2}, ${-ZONE_HANDLE_ICON_PX / 2})`);
		}

		// Delete is a click. The pointer press has to stop here, or it would reach the zone group
		// below and start dragging the zone the user is about to remove - and the map's zoom
		// behaviour above it as well.
		group
			.select<SVGGElement>("g.zone-handle-delete")
			.on("pointerdown", (event: Event) => event.stopPropagation())
			.on("click", (event: Event, rect: Datum) => {
				event.stopPropagation();
				options.onDelete(rect.id);
			});

		// Resize gets its own gesture; it stops the press itself, exactly as the old corner
		// handle did.
		group.select<SVGGElement>("g.zone-handle-scale").call(options.scaleDrag);

		// Move needs no gesture of its own: the press travels on to `g.zone`, whose drag handler
		// moves the zone. That is what the app does too - it hands the move handle the zone's
		// general pan responder rather than one of its own (§B.2, A65:509894).
	});

	layoutZoneHandles(zones, options);
}

/**
 * Puts frame, leash and handles where the current rectangle and zoom want them.
 *
 * Called after every change that moves a zone or changes the zoom, and cheap enough to run on
 * every wheel tick: it writes attributes, it never touches the DOM structure.
 * @param zones Selection of `g.zone` groups, each bound to its rectangle.
 * @param options Current zoom and the zone under an active gesture, if any.
 */
export function layoutZoneHandles<Datum extends ZoneHandleRect>(
	zones: d3.Selection<SVGGElement, Datum, any, any>,
	options: ZoneHandleLayoutOptions,
): void {
	zones.each(function () {
		const zone = d3.select<SVGGElement, Datum>(this);
		const rect = zone.datum();
		const group = zone.select<SVGGElement>("g.zone-handles");
		if (!rect || group.empty()) return;

		const layout = zoneHandleLayout(rect, options.zoom, options.activeZoneId === rect.id);

		// The data join rebinds `g.zone` only; the handles carry their own reference so the
		// delete callback can never be handed a rectangle that has since moved on.
		group.datum(rect).style("display", layout.visible ? "" : "none");
		if (!layout.visible) return;

		group
			.select("rect.zone-focus-frame")
			.attr("x", layout.frame.x)
			.attr("y", layout.frame.y)
			.attr("width", layout.frame.width)
			.attr("height", layout.frame.height)
			// Weight and dashes live in world units, so both are divided by the zoom - the same
			// move `zoneStrokeWidth()` makes for the zone's own edge.
			.style("stroke-width", ZONE_FRAME_STROKE_PX * layout.unit)
			.style("stroke-dasharray", ZONE_FRAME_DASH_PX.map((dash) => dash * layout.unit).join(" "));

		group
			.select("line.zone-leash")
			.attr("x1", layout.leash.x1)
			.attr("y1", layout.leash.y1)
			.attr("x2", layout.leash.x2)
			.attr("y2", layout.leash.y2)
			.style("stroke-width", ZONE_FRAME_STROKE_PX * layout.unit);

		for (const placement of layout.handles) {
			group
				.select<SVGGElement>(`g.zone-handle-${placement.kind}`)
				.datum(rect)
				.attr("transform", `translate(${placement.cx}, ${placement.cy}) scale(${layout.unit})`);
		}
	});
}
