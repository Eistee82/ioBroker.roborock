import * as d3 from "d3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SVGMapRenderer } from "./SVGMapRenderer";
import type { DrawFurnitureInput, SVGMapRendererGroups } from "./SVGMapRenderer";

/**
 * Drawing furniture, with the case that has bitten this project twice already in the middle of
 * it: the Roborock artwork is downloaded per user, so an installation that never talked to the
 * cloud has none of it. A renderer that binds `href` and hopes turns that into a page full of
 * broken-image icons.
 */

type Probe = { src: string; onload: (() => void) | null; onerror: (() => void) | null };

let probes: Probe[];
let originalImage: typeof Image;

/** An `Image` that never loads by itself, so the test decides when a file is there. */
class ProbeImage {
	public onload: (() => void) | null = null;
	public onerror: (() => void) | null = null;
	private value = "";

	constructor() {
		probes.push(this as unknown as Probe);
	}

	get src(): string {
		return this.value;
	}

	set src(next: string) {
		this.value = next;
	}
}

function svgGroup(): d3.Selection<SVGGElement, unknown, HTMLElement, unknown> {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	document.body.appendChild(svg);
	const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
	svg.appendChild(g);
	return d3.select(g) as unknown as d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
}

function makeRenderer(furnitureGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>): SVGMapRenderer {
	const groups: SVGMapRendererGroups = {
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
		furnitureGroup,
	};
	return new SVGMapRenderer({
		groups,
		pathMainWidth: 1,
		pathMopWidth: 1,
		pathBackwashWidth: 1,
		robotSize: 5,
		chargerSize: 3,
		pinWidth: 29,
		pinHeight: 24,
		pinYOffset: 5,
		obstacleRadius: 3,
		obstacleImageSize: 5,
		obstacleAssetBaseUrl: "assets/roborock.vacuum.a65/drawable-mdpi/",
		obstacleMapping: {},
		obstacleFileName: (suffix: string) => `${suffix}.png`,
		obstacleFileNameAlt: (suffix: string) => `${suffix}_alt.png`,
		robotImageHref: "robot.png",
		chargerImageHref: "charger.png",
		goToPinImageHref: "pin.png",
	});
}

const BED: DrawFurnitureInput = {
	id: 7,
	x: 10,
	y: 20,
	width: 40,
	height: 20,
	centerX: 30,
	centerY: 30,
	angle: 90,
	imageHref: "assets/roborock.vacuum.a65/drawable-mdpi/furniture_bed_double.png",
	title: "Bed",
};

describe("SVGMapRenderer.drawFurniture", () => {
	let group: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	let renderer: SVGMapRenderer;

	beforeEach(() => {
		probes = [];
		originalImage = window.Image;
		(window as unknown as { Image: unknown }).Image = ProbeImage;
		group = svgGroup();
		renderer = makeRenderer(group);
	});

	afterEach(() => {
		(window as unknown as { Image: unknown }).Image = originalImage;
		document.body.replaceChildren();
	});

	it("draws a neutral outline and no image at all until the graphic is confirmed", () => {
		renderer.drawFurniture([BED]);

		expect(group.selectAll("g.furniture").size()).to.equal(1);
		expect(group.selectAll("rect.furniture-shape").size()).to.equal(1);
		// Nothing may reference the file before the probe answered - that is the broken image.
		expect(group.selectAll("image").size()).to.equal(0);
		expect(probes).to.have.length(1);
		expect(probes[0].src).to.equal(BED.imageHref);
	});

	it("keeps the outline and stays image-free when the graphic is not downloaded", () => {
		renderer.drawFurniture([BED]);
		probes[0].onerror?.();

		expect(group.selectAll("image").size()).to.equal(0);
		expect(group.select("rect.furniture-shape").style("display")).to.not.equal("none");
	});

	it("replaces the outline with the graphic once the file is confirmed", () => {
		renderer.drawFurniture([BED]);
		probes[0].onload?.();

		const image = group.select("image.furniture-icon");
		expect(image.empty()).to.equal(false);
		expect(image.attr("href")).to.equal(BED.imageHref);
		expect(image.attr("width")).to.equal("40");
		expect(image.attr("height")).to.equal("20");
		expect(image.attr("preserveAspectRatio")).to.equal("none");
		expect(group.select("rect.furniture-shape").style("display")).to.equal("none");
	});

	it("never probes for a type that has no proven graphic", () => {
		renderer.drawFurniture([{ ...BED, imageHref: null, title: null }]);

		expect(probes).to.have.length(0);
		expect(group.selectAll("rect.furniture-shape").size()).to.equal(1);
		expect(group.selectAll("image").size()).to.equal(0);
		expect(group.selectAll("title").size()).to.equal(0);
	});

	it("rotates around the centre and shows the name as a tooltip", () => {
		renderer.drawFurniture([BED]);

		expect(group.select("g.furniture").attr("transform")).to.equal(
			"translate(30, 30) rotate(90) translate(-20, -10)",
		);
		expect(group.select("g.furniture title").text()).to.equal("Bed");
		expect(group.select("g.furniture").attr("data-furniture-id")).to.equal("7");
	});

	it("drops the pieces of the previous map before drawing the new ones", () => {
		renderer.drawFurniture([BED, { ...BED, id: 8 }]);
		expect(group.selectAll("g.furniture").size()).to.equal(2);

		renderer.drawFurniture([]);
		expect(group.selectAll("g.furniture").size()).to.equal(0);
	});

	it("ignores a graphic that arrives after the map was redrawn", () => {
		renderer.drawFurniture([BED]);
		const stale = probes[0];
		renderer.drawFurniture([]);
		stale.onload?.();

		expect(group.selectAll("image").size()).to.equal(0);
	});
});
