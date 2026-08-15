import * as d3 from "d3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SVGMapRenderer } from "./SVGMapRenderer";
import type { ChargerArt, SVGMapRendererGroups } from "./SVGMapRenderer";
import { chargerGraphicFor } from "./chargerGraphic";

/**
 * Drawing the dock, with the case that decides whether this change is safe in the middle of it:
 * the app's dock artwork is downloaded per user account, so an installation that never talked to
 * the cloud has none of it. Nobody may end up with an empty spot where the dock used to be.
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

const BASE = "assets/roborock.vacuum.a65/drawable-mdpi/";

function art(dockType: number): ChargerArt {
	const graphic = chargerGraphicFor(dockType)!;
	return {
		graphic,
		bodyHref: `${BASE}projects_comroborocktanos_resources_${graphic.body}.png`,
		topHref: graphic.top ? `${BASE}projects_comroborocktanos_resources_${graphic.top}.png` : null,
		cellSize: 3,
	};
}

function makeRenderer(
	chargerGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>,
	chargerArt: ChargerArt | null
): SVGMapRenderer {
	const groups: SVGMapRendererGroups = {
		carpetGroup: svgGroup(),
		pathGroup: svgGroup(),
		mopPathGroup: svgGroup(),
		backwashPathGroup: svgGroup(),
		pureCleanPathGroup: svgGroup(),
		chargerGroup,
		robotGroup: svgGroup(),
		pinGroup: svgGroup(),
		obstacleGroup: svgGroup(),
		roomNameGroup: svgGroup(),
	};
	return new SVGMapRenderer({
		groups,
		pathMainWidth: 1,
		pathMopWidth: 1,
		pathBackwashWidth: 1,
		robotSize: 5,
		chargerSize: 25.5,
		pinWidth: 29,
		pinHeight: 24,
		pinYOffset: 5,
		obstacleRadius: 3,
		obstacleImageSize: 5,
		obstacleAssetBaseUrl: BASE,
		obstacleMapping: {},
		obstacleFileName: (suffix: string) => `${suffix}.png`,
		obstacleFileNameAlt: (suffix: string) => `${suffix}_alt.png`,
		robotImageHref: "robot.png",
		chargerImageHref: "builtin-charger.png",
		goToPinImageHref: "pin.png",
		chargerArt,
	});
}

describe("SVGMapRenderer.drawCharger", () => {
	let group: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;

	beforeEach(() => {
		probes = [];
		originalImage = window.Image;
		(window as unknown as { Image: unknown }).Image = ProbeImage;
		group = svgGroup();
	});

	afterEach(() => {
		(window as unknown as { Image: unknown }).Image = originalImage;
		document.body.replaceChildren();
	});

	it("draws the built-in symbol when no artwork is offered at all", () => {
		makeRenderer(group, null).drawCharger({ x: 100, y: 200, angle: -93 });

		const image = group.select("image.charger");
		expect(image.empty()).to.equal(false);
		expect(image.attr("href")).to.equal("builtin-charger.png");
		expect(probes).to.have.length(0);
	});

	it("shows the built-in symbol first and probes the plugin file before touching it", () => {
		makeRenderer(group, art(6)).drawCharger({ x: 100, y: 200, angle: -93 });

		expect(group.select("image.charger").empty()).to.equal(false);
		expect(group.selectAll("g.charger-art").size()).to.equal(0);
		expect(probes).to.have.length(1);
		expect(probes[0].src).to.equal(art(6).bodyHref);
	});

	it("keeps the built-in symbol when the plugin file is not downloaded", () => {
		makeRenderer(group, art(6)).drawCharger({ x: 100, y: 200, angle: -93 });
		probes[0].onerror?.();

		const image = group.select("image.charger");
		expect(image.empty()).to.equal(false);
		expect(image.attr("href")).to.equal("builtin-charger.png");
		expect(group.selectAll("g.charger-art").size()).to.equal(0);
	});

	it("replaces the symbol with the app's own dock once the file is confirmed", () => {
		makeRenderer(group, art(6)).drawCharger({ x: 100, y: 200, angle: -93 });
		probes[0].onload?.();

		expect(group.select("image.charger").empty()).to.equal(true);
		const piece = group.select("g.charger-art");
		expect(piece.empty()).to.equal(false);
		expect(piece.attr("data-dock-kind")).to.equal("special");
		expect(piece.select("image.charger-body").attr("href")).to.equal(art(6).bodyHref);
	});

	it("draws the station to the app's size and turns it against the snapped angle", () => {
		makeRenderer(group, art(6)).drawCharger({ x: 100, y: 200, angle: -93 });
		probes[0].onload?.();

		const piece = group.select("g.charger-art");
		const width = 10.4 * 3;
		const height = 10.4 * 0.86 * 3;
		const body = piece.select("image.charger-body");
		expect(Number(body.attr("width"))).to.be.closeTo(width, 1e-9);
		expect(Number(body.attr("height"))).to.be.closeTo(height, 1e-9);

		const transform = piece.attr("transform");
		// -(-90) after snapping -93 onto the right angle it is three degrees away from.
		expect(transform).to.match(/rotate\(90\)/);
		expect(transform).to.match(new RegExp(`translate\\(${-width / 2}, ${-height / 2}\\)`));
	});

	it("puts the overlay on top of the body, in the same rotated group", () => {
		makeRenderer(group, art(6)).drawCharger({ x: 100, y: 200, angle: -93 });
		probes[0].onload?.();
		expect(probes).to.have.length(2);
		expect(probes[1].src).to.equal(art(6).topHref);
		probes[1].onload?.();

		const children = group.select("g.charger-art").selectAll("image").nodes();
		expect(children).to.have.length(2);
		expect((children[0] as Element).getAttribute("class")).to.equal("charger-body");
		expect((children[1] as Element).getAttribute("class")).to.equal("charger-top");
	});

	it("keeps the body when only the overlay is missing", () => {
		makeRenderer(group, art(6)).drawCharger({ x: 100, y: 200, angle: -93 });
		probes[0].onload?.();
		probes[1].onerror?.();

		expect(group.select("image.charger-body").empty()).to.equal(false);
		expect(group.select("image.charger-top").empty()).to.equal(true);
	});

	it("draws the plain dock as one layer and probes nothing else", () => {
		makeRenderer(group, art(0)).drawCharger({ x: 100, y: 200, angle: 0 });
		probes[0].onload?.();

		expect(group.select("image.charger-body").attr("href")).to.equal(art(0).bodyHref);
		expect(probes).to.have.length(1);
	});

	it("does not resurrect a dock that was cleared while its file was loading", () => {
		const renderer = makeRenderer(group, art(6));
		renderer.drawCharger({ x: 100, y: 200, angle: -93 });
		// A second map arrives and wipes the layer before the first probe answers.
		renderer.drawCharger({ x: 300, y: 400, angle: 0 });
		probes[0].onload?.();

		expect(group.selectAll("g.charger-art").size()).to.equal(0);
		expect(group.selectAll("image.charger").size()).to.equal(1);
	});
});
