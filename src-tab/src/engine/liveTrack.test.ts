import { describe, expect, it } from "vitest";
import { robotCoordsToLocalCoords } from "@adapter/common/coordTransformation";
import {
	LIVE_ROBOT_SIZE,
	LIVE_SNAPSHOT_FIELDS,
	LIVE_TRACK_COLORS,
	LIVE_TRACK_STATE,
	LIVE_TRACK_WIDTH,
	buildLiveRobotPose,
	buildLiveTrackSegments,
	isMopped,
	liveRobotHeadingPoints,
	liveTrackPathD,
	parseLiveSnapshot,
	svgRotationFromRobotAngle,
	type LiveSnapshot,
	type RobotPoint,
	type SvgPoint,
} from "./liveTrack";

/**
 * The live overlay, pinned where it can go wrong silently.
 *
 * Every failure mode this file guards against produces a picture, not an exception: a track that
 * is offset from the map it lies on, a mopped stretch drawn as merely driven, a gap at every
 * colour change, a robot facing the wrong way. None of that throws, and none of it is visible in
 * a type. So the geometry is asserted with numbers rather than described in a comment.
 */

/** A converter that hands back what it was given, so a test can look at the millimetres. */
const identity = (point: RobotPoint): SvgPoint => ({ x: point.x, y: point.y });

/** Builds a snapshot without repeating the three fields in every test. */
function snapshot(path: RobotPoint[], mopFlags: number[], position: LiveSnapshot["position"] = null): LiveSnapshot {
	return { position, path, mopFlags };
}

describe("isMopped", () => {
	it("does not call a merely driven point mopped", () => {
		expect(isMopped(0)).toBe(false);
		// Measured: a pure `app_goto_target` run with no cleaning sent 12 for all 71 of its points.
		// Reading anything non-zero as mopped painted that whole approach as mopped.
		expect(isMopped(12)).toBe(false);
		expect(isMopped(8)).toBe(false);
	});

	it("recognises the values that dominated the measured mopping run", () => {
		// `app_segment_clean` of the kitchen: 10 came 1166 times, 2 came 96, 14 came 33.
		expect(isMopped(10)).toBe(true);
		expect(isMopped(2)).toBe(true);
		expect(isMopped(14)).toBe(true);
	});

	it("splits the observed values on the mop bit and nothing finer", () => {
		// Every value seen across both runs, sorted by whether it carries 0x02. No meaning is
		// claimed for the other bits - that would be a value table nothing supports.
		const withMopBit = [2, 10, 14];
		const withoutMopBit = [0, 1, 4, 8, 12];
		expect(withMopBit.every(value => isMopped(value))).toBe(true);
		expect(withoutMopBit.some(value => isMopped(value))).toBe(false);
	});

	it("reads a missing or unusable value as not mopped", () => {
		expect(isMopped(undefined)).toBe(false);
		expect(isMopped(null)).toBe(false);
		expect(isMopped(NaN)).toBe(false);
	});
});

describe("parseLiveSnapshot", () => {
	const complete = { position: { x: 32587, y: 22591, angle: -137 }, path: [{ x: 100, y: 200 }], mopFlags: [12] };

	it("reads the state whether it arrives as JSON text or as an object", () => {
		expect(parseLiveSnapshot(JSON.stringify(complete))).toEqual(complete);
		expect(parseLiveSnapshot(complete)).toEqual(complete);
	});

	it("carries the agreed field names", () => {
		// A rename on the adapter side cannot be caught by the compiler across the state, and the
		// symptom would be an empty overlay rather than an error.
		expect(LIVE_SNAPSHOT_FIELDS).toEqual(["position", "path", "mopFlags"]);
		const parsed = parseLiveSnapshot(complete);
		for (const field of LIVE_SNAPSHOT_FIELDS) {
			expect(parsed).toHaveProperty(field);
		}
	});

	it("answers null for everything that is not a snapshot", () => {
		expect(parseLiveSnapshot(null)).toBeNull();
		expect(parseLiveSnapshot(undefined)).toBeNull();
		expect(parseLiveSnapshot("")).toBeNull();
		expect(parseLiveSnapshot("   ")).toBeNull();
		expect(parseLiveSnapshot("{ not json")).toBeNull();
		expect(parseLiveSnapshot(42)).toBeNull();
		expect(parseLiveSnapshot([1, 2, 3])).toBeNull();
	});

	it("survives a snapshot that carries nothing yet", () => {
		// The normal answer of a robot that has not driven since it was switched on.
		expect(parseLiveSnapshot({})).toEqual({ position: null, path: [], mopFlags: [] });
		expect(parseLiveSnapshot({ position: null, path: [], mopFlags: [] })).toEqual({ position: null, path: [], mopFlags: [] });
	});

	it("keeps a position without a heading instead of dropping the robot", () => {
		expect(parseLiveSnapshot({ position: { x: 1, y: 2 } })?.position).toEqual({ x: 1, y: 2, angle: 0 });
	});

	it("drops a position that has no usable coordinates", () => {
		expect(parseLiveSnapshot({ position: { x: "left", y: 2, angle: 0 } })?.position).toBeNull();
		expect(parseLiveSnapshot({ position: {} })?.position).toBeNull();
		expect(parseLiveSnapshot({ position: [1, 2] })?.position).toBeNull();
	});

	it("pads and trims the mop values to the length of the path", () => {
		// The two arrays are indexed together. A short one must not shift every later value onto
		// the wrong point, and a long one must not outlive the path it belongs to.
		const short = parseLiveSnapshot({ path: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], mopFlags: [12] });
		expect(short?.mopFlags).toEqual([12, 0, 0]);

		const long = parseLiveSnapshot({ path: [{ x: 0, y: 0 }], mopFlags: [12, 12, 12] });
		expect(long?.mopFlags).toEqual([12]);
	});

	it("keeps an unusable path entry in place rather than deleting it", () => {
		// Deleting it would move mopFlags[2] onto path[1] and mislabel the rest of the run.
		const parsed = parseLiveSnapshot({ path: [{ x: 0, y: 0 }, "broken", { x: 2, y: 2 }], mopFlags: [0, 0, 12] });
		expect(parsed?.path).toHaveLength(3);
		expect(Number.isNaN(parsed?.path[1].x)).toBe(true);
		expect(parsed?.mopFlags).toEqual([0, 0, 12]);
	});

	it("ignores a path that is not a list at all", () => {
		expect(parseLiveSnapshot({ path: "nope", mopFlags: "nope" })).toEqual({ position: null, path: [], mopFlags: [] });
	});
});

describe("buildLiveTrackSegments", () => {
	it("draws nothing when there is nothing", () => {
		expect(buildLiveTrackSegments(null, identity)).toEqual([]);
		expect(buildLiveTrackSegments(undefined, identity)).toEqual([]);
		expect(buildLiveTrackSegments(snapshot([], []), identity)).toEqual([]);
	});

	it("makes one run out of a track of a single kind", () => {
		const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];

		const driven = buildLiveTrackSegments(snapshot(points, [0, 0, 0]), identity);
		expect(driven).toHaveLength(1);
		expect(driven[0].mopped).toBe(false);
		expect(driven[0].points).toHaveLength(3);

		const mopped = buildLiveTrackSegments(snapshot(points, [10, 10, 10]), identity);
		expect(mopped).toHaveLength(1);
		expect(mopped[0].mopped).toBe(true);
	});

	it("treats a track without mop values as driven only", () => {
		const built = buildLiveTrackSegments(snapshot([{ x: 0, y: 0 }, { x: 1, y: 1 }], []), identity);
		expect(built).toHaveLength(1);
		expect(built[0].mopped).toBe(false);
	});

	it("repeats the point at a colour change so the two runs touch", () => {
		// Without the repeat the stretch between point 1 and point 2 would belong to neither run
		// and the track would show a gap at every transition.
		const built = buildLiveTrackSegments(
			snapshot([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }], [0, 0, 10, 10]),
			identity,
		);

		expect(built).toHaveLength(2);
		expect(built[0].mopped).toBe(false);
		expect(built[0].points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

		expect(built[1].mopped).toBe(true);
		expect(built[1].points[0]).toEqual({ x: 10, y: 0 });
		expect(built[1].points).toEqual([{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }]);
	});

	it("alternates as often as the mop values do", () => {
		const built = buildLiveTrackSegments(
			snapshot([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], [10, 0, 10, 0]),
			identity,
		);
		expect(built.map(segment => segment.mopped)).toEqual([true, false, true, false]);
	});

	it("breaks the line at an unusable point instead of striding across it", () => {
		const built = buildLiveTrackSegments(
			snapshot([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 20, y: 0 }], [0, 0, 0]),
			identity,
		);
		expect(built).toHaveLength(2);
		expect(built[0].points).toEqual([{ x: 0, y: 0 }]);
		expect(built[1].points).toEqual([{ x: 20, y: 0 }]);
	});

	it("breaks the line when the conversion itself yields nothing usable", () => {
		// A map whose geometry has not arrived yet answers with NaN rather than throwing.
		const broken = (point: RobotPoint): SvgPoint => (point.x === 10 ? { x: NaN, y: NaN } : point);
		const built = buildLiveTrackSegments(snapshot([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], [0, 0, 0]), broken);
		expect(built).toHaveLength(2);
	});

	it("passes every point through the injected conversion, untouched", () => {
		const seen: RobotPoint[] = [];
		buildLiveTrackSegments(snapshot([{ x: 24628, y: 28534 }, { x: 24678, y: 28534 }], [0, 12]), point => {
			seen.push(point);
			return { x: point.x / 50, y: point.y / 50 };
		});
		expect(seen).toEqual([{ x: 24628, y: 28534 }, { x: 24678, y: 28534 }]);
	});
});

describe("coordinates agree with the map underneath", () => {
	/**
	 * The geometry of a map, in the shape `MapEngine.getMapParams()` builds it: `left`/`topMap` are
	 * the IMAGE block's grid offsets, `imageHeight` is the grid height times the visual block size.
	 */
	const params = { scaleFactor: 3, left: 100, topMap: 200, mapMaxY: 900, imageHeight: 300 * 3, imageWidth: 400 * 3 };
	const toSvg = (point: RobotPoint): SvgPoint => robotCoordsToLocalCoords(point, params);

	it("lands on the same point the map's own converter produces", () => {
		// This is the property that matters: the overlay uses the very function the charger, the
		// robot, the room labels and the furniture already go through. Should that conversion ever
		// be wrong, the overlay is wrong in exactly the same way and still lines up with the map.
		const point = { x: 50 * (100 + 7), y: 50 * (200 + 11) };
		const built = buildLiveTrackSegments(snapshot([point], [0]), toSvg);
		expect(built[0].points[0]).toEqual(robotCoordsToLocalCoords(point, params));
	});

	it("puts the grid cell where the map puts it, y counted downwards on screen", () => {
		// x_mm = 50 * (left + column), y_mm = 50 * (top + row); the cell centre offset of 0.5 and
		// the flip of the y axis are the map's, not this overlay's.
		const column = 7;
		const row = 11;
		const converted = toSvg({ x: 50 * (100 + column), y: 50 * (200 + row) });
		expect(converted.x).toBeCloseTo(3 * (column + 0.5), 10);
		expect(converted.y).toBeCloseTo(3 * (300 - row - 0.5), 10);
	});

	it("moves the track up on screen when the robot drives to a larger y", () => {
		// The single sign error that would mirror the whole overlay against the map.
		const low = toSvg({ x: 50 * 100, y: 50 * 200 });
		const high = toSvg({ x: 50 * 100, y: 50 * 260 });
		expect(high.y).toBeLessThan(low.y);
	});
});

describe("liveTrackPathD", () => {
	it("builds one move and a line per further point", () => {
		expect(liveTrackPathD([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }])).toBe("M1,2L3,4L5,6");
	});

	it("turns a single point into a zero-length line, which a round cap renders as a dot", () => {
		// A bare `M` renders nothing at all, and the first answer of a standing robot is one point.
		expect(liveTrackPathD([{ x: 7, y: 8 }])).toBe("M7,8L7,8");
	});

	it("has nothing to say about an empty run", () => {
		expect(liveTrackPathD([])).toBe("");
	});

	it("rounds to two decimals, which is well under a tenth of a millimetre on the map", () => {
		// The last coordinate also shows that a rounded-away negative does not leak as `-0`.
		expect(liveTrackPathD([{ x: 1.23456, y: 2.98765 }, { x: 0.005, y: -0.004 }])).toBe("M1.23,2.99L0.01,0");
	});
});

describe("svgRotationFromRobotAngle", () => {
	it("matches the expression the map's own robot image is rotated by", () => {
		// SVGMapRenderer.drawRobot uses `-(angle) + 90`. The two must never disagree about forward.
		for (const angle of [0, 45, 90, -93, -137, 180, 359]) {
			expect(svgRotationFromRobotAngle(angle)).toBe(-angle + 90);
		}
	});

	it("reads a missing heading as zero rather than as not-a-number", () => {
		expect(svgRotationFromRobotAngle(undefined)).toBe(90);
		expect(svgRotationFromRobotAngle(null)).toBe(90);
		expect(svgRotationFromRobotAngle(NaN)).toBe(90);
	});
});

describe("buildLiveRobotPose", () => {
	it("places the marker through the same conversion as the track", () => {
		const pose = buildLiveRobotPose(snapshot([], [], { x: 32587, y: 22591, angle: -137 }), point => ({
			x: point.x / 50,
			y: point.y / 50,
		}));
		expect(pose).toEqual({ x: 32587 / 50, y: 22591 / 50, rotation: 137 + 90 });
	});

	it("answers null when there is no position, which is a normal state and not an error", () => {
		expect(buildLiveRobotPose(null, identity)).toBeNull();
		expect(buildLiveRobotPose(undefined, identity)).toBeNull();
		expect(buildLiveRobotPose(snapshot([], [], null), identity)).toBeNull();
		expect(buildLiveRobotPose(snapshot([], [], { x: NaN, y: 0, angle: 0 }), identity)).toBeNull();
	});

	it("answers null when the map geometry cannot convert the position", () => {
		expect(buildLiveRobotPose(snapshot([], [], { x: 1, y: 2, angle: 0 }), () => ({ x: NaN, y: NaN }))).toBeNull();
	});
});

describe("appearance constants", () => {
	it("keeps the two track colours clearly apart", () => {
		expect(LIVE_TRACK_COLORS.driven).not.toBe(LIVE_TRACK_COLORS.mopped);
	});

	it("draws a casing wider than the track it sits under", () => {
		// The casing is what makes the overlay readable on a light as well as on a dark surface.
		expect(LIVE_TRACK_WIDTH.casingExtra).toBeGreaterThan(0);
		expect(LIVE_TRACK_COLORS.casing).toMatch(/^rgba\(/);
	});

	it("points the heading wedge up, so the rotation above turns it correctly", () => {
		const points = liveRobotHeadingPoints()
			.split(" ")
			.map(pair => pair.split(",").map(Number));
		const [tip] = points;
		expect(tip[0]).toBe(0);
		// Up is negative y in SVG, and the tip has to reach past the body to be visible.
		expect(tip[1]).toBeLessThan(-LIVE_ROBOT_SIZE.radius);
	});

	it("names the state in exactly one place", () => {
		expect(LIVE_TRACK_STATE).toBe("map.liveTrack");
		expect(LIVE_TRACK_STATE.startsWith(".")).toBe(false);
		expect(LIVE_TRACK_STATE.endsWith(".")).toBe(false);
	});
});
