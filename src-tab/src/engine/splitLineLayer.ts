import * as d3 from "d3";

/**
 * Draws the dividing line and its three grips.
 *
 * The shapes are the app's, because their difference carries the whole feedback (report
 * `_appanalysis/28-raeume-teilen.md` §1.6):
 *
 * * **dashed, thin** - the line as dragged. Not yet usable.
 * * **solid, thick** - the same line after both ends were pulled onto the room's boundary. This is
 *   what would be sent, and its appearing is the signal that the line is now valid. Roborock's own
 *   message for the other case says exactly that: "adjust the dividing line until a solid line
 *   appears".
 *
 * Three grips rather than the app's two-plus-body: an end each, and the middle for sliding the
 * whole line. On a phone the body of the line is the third grip because a finger covers it anyway;
 * with a mouse a narrow band along the line is enough, and it gets a cursor of its own so the two
 * gestures are told apart before the button goes down.
 */

/** A point in the map's own SVG pixels. */
export interface SplitLinePoint {
	x: number;
	y: number;
}

export interface SplitLineLayerInput {
	/** Where to draw. Emptied and rebuilt on every call. */
	group: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	/** The line as dragged, or null when there is no split in progress. */
	dragged: { a: SplitLinePoint; b: SplitLinePoint } | null;
	/** The line after snapping, or null while the ends have not found the room. */
	snapped: { a: SplitLinePoint; b: SplitLinePoint } | null;
	/** Current map zoom, so strokes and grips keep their size on screen. */
	scale: number;
	/** Stroke colour; the same one the zone outlines use, so the map keeps one visual language. */
	colour: string;
	/** Gesture for an end grip. Receives `"a"` or `"b"` as its datum. */
	endDrag?: d3.DragBehavior<SVGGElement, "a" | "b", unknown>;
	/** Gesture for the band along the line. */
	lineDrag?: d3.DragBehavior<SVGGElement, unknown, unknown>;
	/**
	 * A key was pressed on a focused grip.
	 *
	 * Arrow keys are what make the line placeable in a doorway - one or two cells wide, which is
	 * fiddly to hit by dragging and impossible to repeat. Making the grips focusable for that also
	 * makes the whole control reachable without a pointing device.
	 */
	onEndKey?: (end: "a" | "b", event: KeyboardEvent) => void;
	/** Accessible name for each grip, already translated. */
	endLabels?: { a: string; b: string };
}

/** Radius of an end grip in screen pixels, before the zoom is divided out. */
const GRIP_RADIUS_PX = 7;

/** Half-width of the invisible band that catches a drag of the whole line. */
const BAND_HALF_WIDTH_PX = 9;

/**
 * Redraws the layer from scratch.
 *
 * Rebuilt rather than joined: there are at most five elements, they change on every pointer move,
 * and a data join over five nodes costs more to read than it saves.
 */
export function drawSplitLine(input: SplitLineLayerInput): void {
	const { group, dragged, snapped, scale, colour } = input;
	group.selectAll("*").remove();
	if (!dragged) return;

	const thin = 2 / scale;
	const thick = 4 / scale;
	const gripRadius = GRIP_RADIUS_PX / scale;

	group
		.append("line")
		.attr("class", "split-line-dragged")
		.attr("x1", dragged.a.x)
		.attr("y1", dragged.a.y)
		.attr("x2", dragged.b.x)
		.attr("y2", dragged.b.y)
		.attr("stroke", colour)
		.attr("stroke-width", thin)
		.attr("stroke-dasharray", `${3 / scale} ${3 / scale}`)
		.attr("pointer-events", "none");

	if (snapped) {
		group
			.append("line")
			.attr("class", "split-line-snapped")
			.attr("x1", snapped.a.x)
			.attr("y1", snapped.a.y)
			.attr("x2", snapped.b.x)
			.attr("y2", snapped.b.y)
			.attr("stroke", colour)
			.attr("stroke-width", thick)
			.attr("pointer-events", "none");
	}

	// The band sits under the grips so that grabbing an end never slides the whole line instead.
	const band = group
		.append("g")
		.attr("class", "split-line-band")
		.style("cursor", "move");
	band
		.append("line")
		.attr("x1", dragged.a.x)
		.attr("y1", dragged.a.y)
		.attr("x2", dragged.b.x)
		.attr("y2", dragged.b.y)
		.attr("stroke", "transparent")
		.attr("stroke-width", (BAND_HALF_WIDTH_PX * 2) / scale)
		.attr("stroke-linecap", "butt");
	if (input.lineDrag) band.call(input.lineDrag as any);

	for (const end of ["a", "b"] as const) {
		const point = dragged[end];
		const grip = group
			.append("g")
			.attr("class", "split-line-grip")
			.attr("data-end", end)
			// Focusable, so the arrow keys have somewhere to arrive - and so the control can be
			// reached at all without a pointing device. A bare `<g>` is not in the tab order.
			.attr("tabindex", 0)
			.attr("role", "button")
			.attr("aria-label", input.endLabels?.[end] ?? `split-line-${end}`)
			.datum(end)
			.style("cursor", "grab");
		if (input.onEndKey) {
			grip.on("keydown", function (event: KeyboardEvent, datum: "a" | "b") {
				input.onEndKey?.(datum, event);
			});
		}
		grip
			.append("circle")
			.attr("cx", point.x)
			.attr("cy", point.y)
			.attr("r", gripRadius)
			.attr("fill", colour)
			.attr("stroke", "white")
			.attr("stroke-width", 1.5 / scale);
		if (input.endDrag) grip.call(input.endDrag as any);
	}
}
