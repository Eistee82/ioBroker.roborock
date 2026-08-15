import * as d3 from "d3";
import { beforeEach, describe, expect, it } from "vitest";
import { SVGMapRenderer } from "./SVGMapRenderer";
import type { SVGMapRendererGroups } from "./SVGMapRenderer";
import type { DrawFurnitureInput } from "./SVGMapRenderer";
import type { DrawObstacleInput, DrawRoomLabelInput } from "@adapter/common/mapDrawing/types";

/**
 * Redrawing a layer must not rebuild the elements that were already right.
 *
 * The user's report was "the furniture keeps flickering while the web UI is open". The cause is
 * mechanical, not cosmetic: a layer that is thrown away and rebuilt loses its `<image>` elements,
 * and those come back only through an `Image()` probe whose `onload` fires a tick later **even for
 * a cached file**. Between the two there is a frame in which only the grey placeholder rectangle
 * exists. At one redraw every few seconds that frame is the flicker.
 *
 * These tests therefore assert on **node identity**, not on the picture: draw twice with the same
 * data and the very same DOM nodes have to still be there. Node identity is the only thing that
 * proves no reload happened, because a rebuilt layer looks identical the moment it has settled.
 *
 * All three were checked against the previous implementation, where 10 of these 15 fail:
 *   - furniture: `g.selectAll("g.furniture").remove()` at the top of every call, then a plain loop,
 *   - obstacles and room labels: a `remove()` one line above a `.data()` join that was therefore
 *     always joining against nothing, so every element entered every time and `exit()` and
 *     `merge()` never had anything to do.
 *
 * The five that pass on both sides are the ones that do not rest on identity - clearing the layer,
 * the tooltip, dropping a picture that really did change. They are here so the rewrite cannot buy
 * stability by breaking those.
 */

function svgGroup(): d3.Selection<SVGGElement, unknown, HTMLElement, unknown> {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	document.body.appendChild(svg);
	const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
	svg.appendChild(g);
	return d3.select(g) as unknown as d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
}

function makeRenderer(groups: Partial<SVGMapRendererGroups>): SVGMapRenderer {
	const full: SVGMapRendererGroups = {
		carpetGroup: svgGroup(),
		pathGroup: svgGroup(),
		mopPathGroup: svgGroup(),
		backwashPathGroup: svgGroup(),
		pureCleanPathGroup: svgGroup(),
		chargerGroup: svgGroup(),
		robotGroup: svgGroup(),
		pinGroup: svgGroup(),
		obstacleGroup: svgGroup(),
		roomNameGroup: svgGroup(),
		zonesOverlayGroup: svgGroup(),
		furnitureGroup: svgGroup(),
		liveTrackGroup: svgGroup(),
		liveRobotGroup: svgGroup(),
		...groups,
	};
	return new SVGMapRenderer({
		groups: full,
		obstacleAssetBaseUrl: "assets/",
		obstacleFileName: (suffix: string) => `ob_${suffix}.png`,
		obstacleFileNameAlt: (suffix: string) => `alt_${suffix}.png`,
		obstacleMapping: {},
	} as unknown as ConstructorParameters<typeof SVGMapRenderer>[0]);
}

function furniture(id: number, overrides: Partial<DrawFurnitureInput> = {}): DrawFurnitureInput {
	return {
		id,
		x: 10,
		y: 20,
		width: 30,
		height: 40,
		centerX: 25,
		centerY: 40,
		angle: 0,
		imageHref: `assets/furniture_${id}.png`,
		title: `piece ${id}`,
		...overrides,
	};
}

describe("furniture survives a redraw", () => {
	let group: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	let renderer: SVGMapRenderer;

	beforeEach(() => {
		document.body.replaceChildren();
		group = svgGroup();
		renderer = makeRenderer({ furnitureGroup: group });
	});

	it("keeps the very same group nodes when nothing changed", () => {
		renderer.drawFurniture([furniture(1), furniture(2)]);
		const before = group.selectAll<SVGGElement, unknown>("g.furniture").nodes();
		expect(before).toHaveLength(2);

		renderer.drawFurniture([furniture(1), furniture(2)]);
		const after = group.selectAll<SVGGElement, unknown>("g.furniture").nodes();

		expect(after).toHaveLength(2);
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]);
	});

	it("keeps an already loaded image instead of reloading it", () => {
		// This is the flicker itself. The image only ever appears through an asynchronous probe, so
		// an element that is thrown away is replaced by the grey placeholder until the next tick -
		// however warm the browser cache is.
		renderer.drawFurniture([furniture(7)]);
		const piece = group.select<SVGGElement>("g.furniture");
		// Stand in for the probe having succeeded, which is what the browser does asynchronously.
		piece.select("rect.furniture-shape").style("display", "none");
		const image = piece.append("image").attr("class", "furniture-icon").attr("href", "assets/furniture_7.png").node();

		renderer.drawFurniture([furniture(7)]);

		expect(group.select<SVGImageElement>("image.furniture-icon").node()).toBe(image);
		expect(group.select("rect.furniture-shape").style("display")).toBe("none");
	});

	it("moves a piece that moved instead of replacing it", () => {
		renderer.drawFurniture([furniture(3)]);
		const node = group.select<SVGGElement>("g.furniture").node();

		renderer.drawFurniture([furniture(3, { centerX: 99, centerY: 88, angle: 45 })]);

		const after = group.select<SVGGElement>("g.furniture");
		expect(after.node()).toBe(node);
		expect(after.attr("transform")).toContain("translate(99, 88)");
		expect(after.attr("transform")).toContain("rotate(45)");
	});

	it("adds only what is new and removes only what is gone", () => {
		renderer.drawFurniture([furniture(1), furniture(2)]);
		const first = group.select<SVGGElement>('g.furniture[data-furniture-id="1"]').node();

		renderer.drawFurniture([furniture(1), furniture(5)]);

		expect(group.select<SVGGElement>('g.furniture[data-furniture-id="1"]').node()).toBe(first);
		expect(group.select('g.furniture[data-furniture-id="2"]').empty()).toBe(true);
		expect(group.select('g.furniture[data-furniture-id="5"]').empty()).toBe(false);
	});

	it("drops the stale picture when the graphic behind a piece changed", () => {
		// The one case where the image really has to go: a different file is meant now, and leaving
		// the old one up would show the wrong furniture indefinitely.
		renderer.drawFurniture([furniture(4)]);
		const piece = group.select<SVGGElement>("g.furniture");
		piece.select("rect.furniture-shape").style("display", "none");
		piece.append("image").attr("class", "furniture-icon").attr("href", "assets/furniture_4.png");

		renderer.drawFurniture([furniture(4, { imageHref: "assets/other.png" })]);

		expect(group.select("image.furniture-icon").empty()).toBe(true);
		expect(group.select("rect.furniture-shape").style("display")).not.toBe("none");
	});

	it("clears the layer when there is no furniture left", () => {
		renderer.drawFurniture([furniture(1)]);
		renderer.drawFurniture([]);
		expect(group.selectAll("g.furniture").size()).toBe(0);
	});

	it("keeps the tooltip in step with the name", () => {
		renderer.drawFurniture([furniture(6, { title: "sofa" })]);
		expect(group.select("g.furniture title").text()).toBe("sofa");

		renderer.drawFurniture([furniture(6, { title: "couch" })]);
		expect(group.select("g.furniture title").text()).toBe("couch");
		expect(group.selectAll("g.furniture title").size()).toBe(1);
	});
});

describe("obstacles survive a redraw", () => {
	let group: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	let renderer: SVGMapRenderer;

	function obstacle(x: number, y: number, type: number | string = 5): DrawObstacleInput {
		return { x, y, typeOrSuffix: type, imageHref: `assets/ob_${type}.png` };
	}

	beforeEach(() => {
		document.body.replaceChildren();
		group = svgGroup();
		renderer = makeRenderer({ obstacleGroup: group });
	});

	it("keeps the very same group nodes when nothing changed", () => {
		// The data join was already written here - and defeated by a `remove()` one line above it,
		// so every element was always an entering one.
		renderer.drawObstacles([obstacle(1, 1), obstacle(2, 2)]);
		const before = group.selectAll<SVGGElement, unknown>(".obstacle-group").nodes();
		expect(before).toHaveLength(2);

		renderer.drawObstacles([obstacle(1, 1), obstacle(2, 2)]);
		const after = group.selectAll<SVGGElement, unknown>(".obstacle-group").nodes();

		expect(after).toHaveLength(2);
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]);
	});

	it("keeps the icon element, which is what the probe would otherwise reload", () => {
		renderer.drawObstacles([obstacle(3, 4)]);
		const icon = group.select<SVGImageElement>("image.obstacle-icon").node();

		renderer.drawObstacles([obstacle(3, 4)]);

		expect(group.select<SVGImageElement>("image.obstacle-icon").node()).toBe(icon);
	});

	it("adds only what is new and removes only what is gone", () => {
		renderer.drawObstacles([obstacle(1, 1), obstacle(2, 2)]);
		const kept = group.selectAll<SVGGElement, unknown>(".obstacle-group").nodes()[0];

		renderer.drawObstacles([obstacle(1, 1), obstacle(9, 9)]);

		const after = group.selectAll<SVGGElement, unknown>(".obstacle-group").nodes();
		expect(after).toHaveLength(2);
		// Identity of the surviving element, compared one by one: `toContain` would have to print a
		// DOM node on failure, and that is what turns a plain mismatch into an unreadable error.
		expect(after.some((node) => node === kept)).toBe(true);
		expect(after.map((node) => node.getAttribute("transform"))).to.deep.equal([
			"translate(1, 1)",
			"translate(9, 9)",
		]);
	});

	it("clears the layer when there are no obstacles left", () => {
		renderer.drawObstacles([obstacle(1, 1)]);
		renderer.drawObstacles([]);
		expect(group.selectAll(".obstacle-group").size()).toBe(0);
	});
});

describe("room labels survive a redraw", () => {
	let group: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	let renderer: SVGMapRenderer;

	function label(segmentId: number, overrides: Partial<DrawRoomLabelInput> = {}): DrawRoomLabelInput {
		return { segmentId, x: segmentId * 10, y: 5, text: `room ${segmentId}`, iconHref: "assets/icon.png", ...overrides };
	}

	beforeEach(() => {
		document.body.replaceChildren();
		group = svgGroup();
		renderer = makeRenderer({ roomNameGroup: group });
	});

	it("keeps the very same nodes, icon included", () => {
		// The icon is bound straight from `iconHref` rather than through a probe, so the gap is
		// shorter than the furniture's - but a brand new `<image>` still shows nothing until the
		// file is decoded, and the whole group was being rebuilt on every redraw.
		renderer.drawRoomLabels([label(1), label(2)]);
		const before = group.selectAll<SVGGElement, unknown>("g.room-label").nodes();
		const icon = group.select<SVGImageElement>("image.room-label-icon").node();

		renderer.drawRoomLabels([label(1), label(2)]);

		const after = group.selectAll<SVGGElement, unknown>("g.room-label").nodes();
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]);
		expect(group.select<SVGImageElement>("image.room-label-icon").node()).toBe(icon);
	});

	it("follows a renamed or moved room on the element it already has", () => {
		renderer.drawRoomLabels([label(4)]);
		const node = group.select<SVGGElement>("g.room-label").node();

		renderer.drawRoomLabels([label(4, { text: "kitchen", x: 77 })]);

		const after = group.select<SVGGElement>("g.room-label");
		expect(after.node()).toBe(node);
		expect(after.select("text.room-name").text()).toBe("kitchen");
		expect(after.attr("transform")).toBe("translate(77, 5)");
	});

	it("adds only what is new and removes only what is gone", () => {
		renderer.drawRoomLabels([label(1), label(2)]);
		const kept = group.select<SVGGElement>('g.room-label[data-segment-id="1"]').node();

		renderer.drawRoomLabels([label(1), label(3)]);

		expect(group.select<SVGGElement>('g.room-label[data-segment-id="1"]').node()).toBe(kept);
		expect(group.select('g.room-label[data-segment-id="2"]').empty()).toBe(true);
		expect(group.select('g.room-label[data-segment-id="3"]').empty()).toBe(false);
	});

	it("clears the layer when there are no labels left", () => {
		renderer.drawRoomLabels([label(1)]);
		renderer.drawRoomLabels([]);
		expect(group.selectAll("g.room-label").size()).toBe(0);
	});
});
