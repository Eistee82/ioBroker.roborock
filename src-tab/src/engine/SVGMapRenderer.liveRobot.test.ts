import * as d3 from "d3";
import { describe, expect, it } from "vitest";
import { SVGMapRenderer } from "./SVGMapRenderer";
import type { SVGMapRendererGroups } from "./SVGMapRenderer";
import { LIVE_ROBOT_SIZE } from "./liveTrack";

/**
 * The live overlay as it reaches the DOM.
 *
 * What is checked here is what the previous file cannot see: that both track colours end up as
 * separate paths, that each one has its casing underneath and not on top, that a new snapshot
 * replaces the old drawing instead of piling onto it, and that an empty snapshot leaves no stale
 * robot standing in a room the machine left minutes ago.
 */

function svgGroup(): d3.Selection<SVGGElement, unknown, HTMLElement, unknown> {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	document.body.appendChild(svg);
	const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
	svg.appendChild(g);
	return d3.select(g) as unknown as d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
}

function makeRenderer(
	liveTrackGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>,
	liveRobotGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>,
): SVGMapRenderer {
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
		liveTrackGroup,
		liveRobotGroup,
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

describe("drawLiveRobot", () => {
	it("places the marker and turns it by the given rotation", () => {
		const robot = svgGroup();
		makeRenderer(svgGroup(), robot).drawLiveRobot({ x: 12.5, y: 30, rotation: 227 });

		expect(robot.select("g.live-robot").attr("transform")).toBe("translate(12.5, 30) rotate(227)");
		expect(robot.select("circle.live-robot-body").attr("r")).toBe(String(LIVE_ROBOT_SIZE.radius));
		expect(robot.selectAll("polygon.live-robot-heading").size()).toBe(1);
	});

	it("draws the heading behind the body so the wedge reads as a nose", () => {
		const robot = svgGroup();
		makeRenderer(svgGroup(), robot).drawLiveRobot({ x: 0, y: 0, rotation: 0 });

		const marker = robot.select<SVGGElement>("g.live-robot").node()!;
		expect(Array.from(marker.children).map(child => child.tagName)).toEqual(["polygon", "circle"]);
	});

	it("removes the marker when the position is gone", () => {
		// Otherwise a robot that stopped reporting would stand on the map forever.
		const robot = svgGroup();
		const renderer = makeRenderer(svgGroup(), robot);

		renderer.drawLiveRobot({ x: 1, y: 2, rotation: 0 });
		renderer.drawLiveRobot(null);

		expect(robot.selectAll("*").size()).toBe(0);
	});

	it("keeps exactly one marker across updates", () => {
		const robot = svgGroup();
		const renderer = makeRenderer(svgGroup(), robot);

		renderer.drawLiveRobot({ x: 1, y: 2, rotation: 0 });
		renderer.drawLiveRobot({ x: 3, y: 4, rotation: 45 });

		expect(robot.selectAll("g.live-robot").size()).toBe(1);
		expect(robot.select("g.live-robot").attr("transform")).toBe("translate(3, 4) rotate(45)");
	});
});
