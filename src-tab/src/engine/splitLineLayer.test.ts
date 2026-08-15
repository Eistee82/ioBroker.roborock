import * as d3 from "d3";
import { describe, expect, it, vi } from "vitest";
import { drawSplitLine } from "./splitLineLayer";

/**
 * The layer that draws the dividing line.
 *
 * What is worth testing here is not how it looks but the two things a user would notice as broken:
 * that the dashed and the solid line are told apart at all - their difference carries Roborock's
 * whole "adjust until a solid line appears" - and that the grips can be reached and typed on. The
 * geometry itself is tested in `src/common/splitLine.test.ts`, without a DOM.
 */

/** A detached `<g>` to draw into. */
function group(): d3.Selection<SVGGElement, unknown, HTMLElement, any> {
	const svg = d3.select(document.body).append("svg");
	return svg.append("g") as unknown as d3.Selection<SVGGElement, unknown, HTMLElement, any>;
}

const LINE = { a: { x: 10, y: 10 }, b: { x: 90, y: 50 } };

describe("drawing the dividing line", () => {
	it("draws nothing at all while no line is being dragged", () => {
		const g = group();
		drawSplitLine({ group: g, dragged: null, snapped: null, scale: 1, colour: "#123456" });
		expect(g.node()!.childElementCount).toBe(0);
	});

	it("draws the dragged line dashed and thin", () => {
		const g = group();
		drawSplitLine({ group: g, dragged: LINE, snapped: null, scale: 1, colour: "#123456" });

		const dragged = g.select("line.split-line-dragged");
		expect(dragged.empty()).toBe(false);
		expect(dragged.attr("stroke-dasharray")).toBe("3 3");
		expect(dragged.attr("stroke")).toBe("#123456");
		// No solid line while the ends have not found the room: that absence is the message.
		expect(g.select("line.split-line-snapped").empty()).toBe(true);
	});

	it("adds the solid line once there is one, and keeps the dashed one", () => {
		const g = group();
		drawSplitLine({ group: g, dragged: LINE, snapped: { a: { x: 20, y: 15 }, b: { x: 80, y: 45 } }, scale: 1, colour: "#123456" });

		const snapped = g.select("line.split-line-snapped");
		expect(snapped.empty()).toBe(false);
		expect(snapped.attr("stroke-dasharray")).toBeNull();
		expect(Number(snapped.attr("stroke-width"))).toBeGreaterThan(Number(g.select("line.split-line-dragged").attr("stroke-width")));
	});

	it("keeps strokes and grips the same size on screen as the map is zoomed", () => {
		// Everything is drawn in map units, so a zoom of 4 has to divide the widths by 4 or the line
		// would grow into a band.
		const one = group();
		const four = group();
		drawSplitLine({ group: one, dragged: LINE, snapped: null, scale: 1, colour: "#000" });
		drawSplitLine({ group: four, dragged: LINE, snapped: null, scale: 4, colour: "#000" });

		const widthAt = (g: ReturnType<typeof group>): number => Number(g.select("line.split-line-dragged").attr("stroke-width"));
		expect(widthAt(one)).toBeCloseTo(widthAt(four) * 4, 10);

		const radiusAt = (g: ReturnType<typeof group>): number => Number(g.select("g.split-line-grip circle").attr("r"));
		expect(radiusAt(one)).toBeCloseTo(radiusAt(four) * 4, 10);
	});
});

describe("reaching the grips without a mouse", () => {
	it("puts both grips in the tab order and names them", () => {
		const g = group();
		drawSplitLine({
			group: g,
			dragged: LINE,
			snapped: null,
			scale: 1,
			colour: "#000",
			endLabels: { a: "one end", b: "other end" },
		});

		const grips = g.selectAll("g.split-line-grip").nodes() as SVGGElement[];
		expect(grips).toHaveLength(2);
		for (const grip of grips) {
			expect(grip.getAttribute("tabindex")).toBe("0");
			expect(grip.getAttribute("role")).toBe("button");
		}
		expect(grips[0].getAttribute("aria-label")).toBe("one end");
		expect(grips[1].getAttribute("aria-label")).toBe("other end");
	});

	it("reports which grip a key was pressed on", () => {
		// The end has to travel with the event: both grips look alike, and moving the wrong one is
		// not something the user would read as a keyboard problem.
		const onEndKey = vi.fn();
		const g = group();
		drawSplitLine({ group: g, dragged: LINE, snapped: null, scale: 1, colour: "#000", onEndKey });

		const grips = g.selectAll("g.split-line-grip").nodes() as SVGGElement[];
		grips[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

		expect(onEndKey).toHaveBeenCalledTimes(1);
		expect(onEndKey.mock.calls[0][0]).toBe("b");
		expect((onEndKey.mock.calls[0][1] as KeyboardEvent).key).toBe("ArrowUp");
	});

	it("leaves the grips alone when nobody is listening", () => {
		const g = group();
		drawSplitLine({ group: g, dragged: LINE, snapped: null, scale: 1, colour: "#000" });
		const grip = g.select<SVGGElement>("g.split-line-grip").node()!;
		expect(() => grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }))).not.toThrow();
	});
});
