import * as d3 from "d3";
import {
	layoutZoneHandles,
	renderZoneHandles,
	ZONE_HANDLE_KINDS,
	ZONE_HANDLE_KINDS_ROTATABLE,
	type ZoneHandleKind,
} from "./zoneHandles";
import type { MapZoneKind } from "./mapZones";

/**
 * Draws the walls and zones that live on the robot's own map, and makes them operable.
 *
 * ## Why this is not the cleaning-zone layer
 *
 * `MapEngine.drawZones()` draws rectangles the user is about to clean. They are upright, they are
 * described by a corner and a size, and they never leave the browser except as `app_zoned_clean`.
 * A map zone is none of that:
 *
 *  - it can be **turned**, because it is stored as four corners and the app gives it a rotate
 *    handle (`_appanalysis/17-raumauswahl.md` §B.4, A65:521762);
 *  - it is **on the robot**, so drawing it wrong is a boundary the user loses.
 *
 * The two therefore share their handles - the same component, the same positions, exactly as the
 * app shares one rectangle component across all its object types (§B.1) - and nothing else.
 *
 * ## The local frame is what makes a turned rectangle simple
 *
 * Every zone group carries `translate(centre) rotate(angle) translate(-w/2, -h/2)`. Inside that
 * frame the zone is a plain rectangle from `(0,0)` to `(w,h)`, which is precisely what
 * `zoneHandles.ts` lays its handles out around - so the handles turn with the zone without a line
 * of extra arithmetic, and the delete badge stays on the corner it belongs to. The app does the
 * same thing: it applies `slopeAngle` to the container, not to the individual pictures
 * (A65:509907-509912).
 *
 * ## Which handles which kind gets
 *
 * Straight from §B.4, and deliberately not "whatever we can implement":
 *
 * | Kind | delete | rotate | scale | move | Fundstelle |
 * | --- | --- | --- | --- | --- | --- |
 * | no-go, no-mop | yes | **yes** | yes | yes | A65:521728/521762/521734/521774 |
 * | invisible wall | yes | no | yes | yes | A65:523201/523224/523247 |
 *
 * ## Handles appear on the selected zone only
 *
 * The app shows them on the focused rectangle alone (§B.1). The cleaning-zone layer shows them on
 * all five, which is fine for five. A map holds up to ten of each kind (`MAX_COUNT_WALL_OR_FBZ`),
 * and four handles on thirty rectangles would be a field of badges in which no delete button can be
 * attributed to anything by eye. So here the app's rule is followed rather than the tab's own.
 */

/** Where a zone sits and how big it is, in the map's own SVG pixels. */
export interface MapZoneShape {
	/** `kind:index` of the zone, or the draft's key; the data join runs on this. */
	key: string;
	kind: MapZoneKind;
	/**
	 * Position in the current list.
	 *
	 * Only there because the handle layer keys on a number; the key above is what actually
	 * identifies a zone, and nothing outside one render may rely on this.
	 */
	id: number;
	/** Centre in SVG pixels. */
	cx: number;
	cy: number;
	/**
	 * Extent in SVG pixels, along the zone's own axes.
	 *
	 * A wall has `height` 0 - it is a line, and pretending otherwise would draw a band where the
	 * map holds two end points.
	 */
	width: number;
	height: number;
	/** Rotation in degrees, in SVG's own sense (clockwise, y downwards). */
	angleDeg: number;
	/** True for the zone the user is placing and has not saved yet. */
	draft: boolean;
}

/** Which handles each kind offers; the table in the module comment. */
export function handleKindsFor(kind: MapZoneKind): readonly ZoneHandleKind[] {
	return kind === "wall" ? ZONE_HANDLE_KINDS : ZONE_HANDLE_KINDS_ROTATABLE;
}

/**
 * The group transform that puts a zone into its own upright frame.
 *
 * Inside it the zone runs from `(0,0)` to `(width, height)`, which is the frame the handles are
 * laid out in - so they turn with the zone for free.
 * @param shape The zone as drawn.
 * @returns The `transform` attribute of the zone group.
 */
export function zoneTransform(shape: MapZoneShape): string {
	return `translate(${shape.cx}, ${shape.cy}) rotate(${shape.angleDeg}) translate(${-shape.width / 2}, ${-shape.height / 2})`;
}

/** What {@link renderMapZoneLayer} needs to build and place the layer. */
export interface MapZoneLayerOptions {
	/** Current map zoom, so handles and edges keep their size on screen. */
	zoom: number;
	/** Key of the zone whose handles are shown, or null while none is selected. */
	selectedKey: string | null;
	/** Translator for the tooltips; the engine's own. */
	t: (key: string, fallback: string) => string;
	/** A zone was clicked. Called with null when the click missed every zone. */
	onSelect: (key: string | null) => void;
	/** The delete handle of this zone was pressed. */
	onDelete: (key: string) => void;
	/** Gesture for the move handle and the body, or undefined when this layer is read-only. */
	moveDrag?: d3.DragBehavior<SVGGElement, MapZoneShape, unknown>;
	/** Gesture for the scale handle. */
	scaleDrag?: d3.DragBehavior<SVGGElement, MapZoneShape, unknown>;
	/** Gesture for the rotate handle. */
	rotateDrag?: d3.DragBehavior<SVGGElement, MapZoneShape, unknown>;
}

/**
 * Draws every zone of the layer and hangs the handles on the selected one.
 *
 * Safe to call on every redraw: the data join keys on {@link MapZoneShape.key}, and the handles are
 * built once per zone group.
 * @param group The layer's own `g`, which must sit above the map picture.
 * @param shapes Every wall and zone to draw, already converted to SVG pixels.
 * @param options Zoom, selection, translator and the gestures.
 */
export function renderMapZoneLayer(
	group: d3.Selection<SVGGElement, unknown, any, any>,
	shapes: MapZoneShape[],
	options: MapZoneLayerOptions,
): void {
	const selection = group
		.selectAll<SVGGElement, MapZoneShape>("g.map-zone")
		.data(shapes, (shape: MapZoneShape) => shape.key);

	selection.exit().remove();

	const entered = selection.enter().append("g").attr("class", "map-zone");
	// The drawn shape. A wall is a line and a zone a rectangle, so both are built and the one that
	// does not apply is left empty - swapping the element would mean rebuilding the group, and with
	// it the handles and their listeners.
	entered.append("rect").attr("class", "map-zone-rect").attr("x", 0).attr("y", 0);
	entered.append("line").attr("class", "map-zone-line");
	// Only a wall needs one: a zone is a filled rectangle and already takes the click everywhere.
	entered.append("line").attr("class", "map-zone-hit");

	const merged = entered.merge(selection);

	merged
		.attr("class", (shape) => `map-zone map-zone-${shape.kind}${shape.draft ? " map-zone-draft" : ""}`)
		.attr("transform", (shape) => zoneTransform(shape))
		.classed("map-zone-selected", (shape) => shape.key === options.selectedKey);

	merged.each(function (shape) {
		const zone = d3.select<SVGGElement, MapZoneShape>(this);
		const isWall = shape.kind === "wall";

		zone
			.select("rect.map-zone-rect")
			.style("display", isWall ? "none" : "")
			.attr("width", shape.width)
			.attr("height", shape.height)
			.style("stroke-width", strokeWidth(options.zoom))
			// Dashes are world lengths, so they are divided by the zoom exactly as the weight is;
			// otherwise the pattern would coarsen as the map is zoomed in.
			.style("stroke-dasharray", shape.draft ? dashPattern(options.zoom) : "");

		// The wall runs along the top edge of its own frame, because that frame has no height: the
		// map stores two end points and the line is exactly those.
		for (const cls of ["line.map-zone-line", "line.map-zone-hit"]) {
			zone
				.select(cls)
				.style("display", isWall ? "" : "none")
				.attr("x1", 0)
				.attr("y1", 0)
				.attr("x2", shape.width)
				.attr("y2", 0);
		}
		zone
			.select("line.map-zone-line")
			.style("stroke-width", wallStrokeWidth(options.zoom))
			.style("stroke-dasharray", shape.draft ? dashPattern(options.zoom) : "");
		zone.select("line.map-zone-hit").style("stroke-width", hitStrokeWidth(options.zoom));
	});

	// A click selects. The press is not stopped here: the map's pan gesture has to keep working
	// over a zone, exactly as it does over a room label.
	merged.on("click", (event: Event, shape: MapZoneShape) => {
		event.stopPropagation();
		options.onSelect(shape.key === options.selectedKey ? null : shape.key);
	});

	// Handles are built on the selected zone only, and removed again when it loses the selection -
	// which is what keeps a map with thirty zones readable (§B.1).
	merged
		.filter((shape) => shape.key !== options.selectedKey)
		.each(function () {
			d3.select(this).select("g.zone-handles").remove();
		});

	const selectedShape = shapes.find((shape) => shape.key === options.selectedKey);
	if (!selectedShape) return;

	const selected = merged.filter((shape) => shape.key === options.selectedKey);
	// Raised so the handles of the selected zone are on top of every other zone of this layer.
	selected.raise();

	renderZoneHandles<MapZoneShape>(selected, {
		zoom: options.zoom,
		// Exactly one zone carries handles, so the reason the cleaning-zone layer hides them on
		// small rectangles - clusters of badges no one can attribute by eye - does not apply. What
		// does apply is that a zone drawn too small is precisely the one a user needs to correct,
		// so it keeps its handles at any size.
		activeZoneId: selectedShape.id,
		kinds: (shape: MapZoneShape) => handleKindsFor(shape.kind),
		t: options.t,
		onDelete: () => options.onDelete(selectedShape.key),
		scaleDrag: options.scaleDrag,
		rotateDrag: options.rotateDrag,
	});

	if (options.moveDrag) {
		selected.call(options.moveDrag);
	}
}

/**
 * Re-places the handles of the selected zone without touching the DOM structure.
 *
 * Called on every wheel tick: the zone scales with the map because it stands for an area on the
 * floor, its controls must not.
 * @param group The layer's own `g`.
 * @param zoom Current map zoom.
 */
export function layoutMapZoneHandles(group: d3.Selection<SVGGElement, unknown, any, any>, zoom: number): void {
	const zones = group.selectAll<SVGGElement, MapZoneShape & { id: number }>("g.map-zone.map-zone-selected");
	layoutZoneHandles(zones, {
		zoom,
		kinds: (shape: MapZoneShape) => handleKindsFor(shape.kind),
	});

	group.selectAll("rect.map-zone-rect").style("stroke-width", strokeWidth(zoom));
	group.selectAll("line.map-zone-line").style("stroke-width", wallStrokeWidth(zoom));
	group.selectAll("line.map-zone-hit").style("stroke-width", hitStrokeWidth(zoom));
	// The dashes of the zone being placed are world lengths too.
	group
		.selectAll(".map-zone-draft .map-zone-rect, .map-zone-draft .map-zone-line")
		.style("stroke-dasharray", dashPattern(zoom));
}

/** Base edge weight of a zone, in screen pixels. */
export const MAP_ZONE_STROKE_PX = 2;

/** Weight of an invisible wall, in screen pixels; thicker, because the line *is* the object. */
export const MAP_ZONE_WALL_STROKE_PX = 4;

/**
 * Width of the invisible band that takes a click on a wall, in screen pixels.
 *
 * Six times the drawn line, so a wall is as easy to hit as a zone is. The same ratio the handles
 * use between glyph and hit area would not be enough here: 1.5 × 4 px is still 6 px.
 */
export const MAP_ZONE_HIT_STROKE_PX = 24;

/**
 * Dash pattern of the zone being placed, in screen pixels.
 *
 * Dashed until it is saved, because nothing has reached the robot while it looks like this - and
 * every save rewrites the complete set, so "drawn" and "stored" must not look the same.
 */
export const MAP_ZONE_DRAFT_DASH_PX: readonly [number, number] = [6, 4];

/**
 * Edge weight in world units, so the drawn line keeps its weight on screen at any zoom.
 * @param zoom Current map zoom.
 */
function strokeWidth(zoom: number): number {
	return MAP_ZONE_STROKE_PX / usableZoom(zoom);
}

/**
 * The same for a wall.
 * @param zoom Current map zoom.
 */
function wallStrokeWidth(zoom: number): number {
	return MAP_ZONE_WALL_STROKE_PX / usableZoom(zoom);
}

/**
 * The same for the invisible band that takes the click on a wall.
 * @param zoom Current map zoom.
 */
function hitStrokeWidth(zoom: number): number {
	return MAP_ZONE_HIT_STROKE_PX / usableZoom(zoom);
}

/**
 * The dash pattern in world units, so it keeps its rhythm on screen at any zoom.
 * @param zoom Current map zoom.
 * @returns A `stroke-dasharray` value.
 */
function dashPattern(zoom: number): string {
	return MAP_ZONE_DRAFT_DASH_PX.map((dash) => dash / usableZoom(zoom)).join(" ");
}

/**
 * A zoom that can be divided by.
 *
 * The map reports its zoom from a d3 behaviour, and a fresh or reset one can be 0 before the first
 * gesture; dividing by it would place every edge at infinity.
 * @param zoom Current map zoom.
 */
function usableZoom(zoom: number): number {
	return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}
