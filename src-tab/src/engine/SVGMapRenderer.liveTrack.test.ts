import * as d3 from "d3";
import { describe, expect, it } from "vitest";
import { SVGMapRenderer } from "./SVGMapRenderer";
import type { SVGMapRendererGroups } from "./SVGMapRenderer";
import { LIVE_ROBOT_SIZE, LIVE_TRACK_COLORS, LIVE_TRACK_WIDTH, type LiveTrackSegment } from "./liveTrack";

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

const DRIVEN_THEN_MOPPED: LiveTrackSegment[] = [
	{ mopped: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
	{ mopped: true, points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
];

describe("drawLiveTrack", () => {
	it("draws each run in its own colour", () => {
		const track = svgGroup();
		makeRenderer(track, svgGroup()).drawLiveTrack(DRIVEN_THEN_MOPPED);

		expect(track.selectAll("path.live-track-driven").size()).toBe(1);
		expect(track.selectAll("path.live-track-mopped").size()).toBe(1);
		expect(track.select("path.live-track-driven").style("stroke")).toBe(LIVE_TRACK_COLORS.driven);
		expect(track.select("path.live-track-mopped").style("stroke")).toBe(LIVE_TRACK_COLORS.mopped);
	});

	it("puts every casing under every colour, not just under its own run", () => {
		// SVG paints in document order. A casing appended after a colour would cut into it.
		const track = svgGroup();
		makeRenderer(track, svgGroup()).drawLiveTrack(DRIVEN_THEN_MOPPED);

		const classes = Array.from(track.node()!.children).map(child => child.getAttribute("class"));
		expect(classes).toEqual([
			"live-track-casing",
			"live-track-casing",
			"live-track live-track-driven",
			"live-track live-track-mopped",
		]);
	});

	it("makes the casing wider than the track", () => {
		const track = svgGroup();
		makeRenderer(track, svgGroup()).drawLiveTrack(DRIVEN_THEN_MOPPED);

		expect(track.select("path.live-track-casing").style("stroke-width")).toBe(
			`${LIVE_TRACK_WIDTH.track + LIVE_TRACK_WIDTH.casingExtra}px`,
		);
		expect(track.select("path.live-track-driven").style("stroke-width")).toBe(`${LIVE_TRACK_WIDTH.track}px`);
	});

	it("keeps the two runs sharing the point they meet at", () => {
		const track = svgGroup();
		makeRenderer(track, svgGroup()).drawLiveTrack(DRIVEN_THEN_MOPPED);

		expect(track.select("path.live-track-driven").attr("d")).toBe("M0,0L10,0");
		expect(track.select("path.live-track-mopped").attr("d")).toBe("M10,0L20,0");
	});

	it("replaces the previous drawing instead of adding to it", () => {
		// A live channel supersedes itself. Merging would grow a track the robot never reported.
		const track = svgGroup();
		const renderer = makeRenderer(track, svgGroup());

		renderer.drawLiveTrack(DRIVEN_THEN_MOPPED);
		renderer.drawLiveTrack([{ mopped: true, points: [{ x: 5, y: 5 }, { x: 6, y: 6 }] }]);

		expect(track.selectAll("path").size()).toBe(2);
		expect(track.selectAll("path.live-track-driven").size()).toBe(0);
	});

	it("clears the layer for an empty track", () => {
		const track = svgGroup();
		const renderer = makeRenderer(track, svgGroup());

		renderer.drawLiveTrack(DRIVEN_THEN_MOPPED);
		renderer.drawLiveTrack([]);

		expect(track.selectAll("path").size()).toBe(0);
	});

	it("skips a run that has no points at all rather than emitting an empty path", () => {
		const track = svgGroup();
		makeRenderer(track, svgGroup()).drawLiveTrack([{ mopped: false, points: [] }]);
		expect(track.selectAll("path").size()).toBe(0);
	});

	it("does nothing when the caller wired no live layer", () => {
		// A renderer built for the Q10 pipeline has no live groups; it must not throw.
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
		};
		const renderer = new SVGMapRenderer({
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
			obstacleAssetBaseUrl: "",
			obstacleMapping: {},
			obstacleFileName: (suffix: string) => `${suffix}.png`,
			obstacleFileNameAlt: (suffix: string) => `${suffix}_alt.png`,
			robotImageHref: "robot.png",
			chargerImageHref: "charger.png",
			goToPinImageHref: "pin.png",
		});

		expect(() => renderer.drawLiveTrack(DRIVEN_THEN_MOPPED)).not.toThrow();
		expect(() => renderer.drawLiveRobot({ x: 1, y: 2, rotation: 0 })).not.toThrow();
	});
});

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
