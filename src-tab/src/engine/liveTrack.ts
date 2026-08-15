/**
 * The live overlay: where the robot stands, where it drove, and where it mopped.
 *
 * The point of this layer is not a faster map. It is the one thing the map itself cannot show:
 * the work that has just been done. The robot answers `get_dynamic_data` locally in about 55 ms
 * with its position, its driven track and one mop byte per track point, and the adapter publishes
 * that bundle as JSON in a single state. Everything below turns that JSON into something the SVG
 * map can draw, and nothing in here touches d3 or the DOM - which is why it can be tested without
 * a browser.
 *
 * Two decisions are worth reading before changing anything here.
 *
 * **The snapshot type is mirrored, not imported.** The authoritative declaration is
 * `DynamicSnapshot` in `src/lib/map/dynamicData.ts`, and this file's {@link LiveSnapshot} is
 * field-for-field the same. It is repeated rather than imported because that module decodes the
 * binary blocks with node's `Buffer`, and the tab compiles against the DOM lib without node types:
 * a type-only import would still pull the file into `tsc`, and `typecheck:tab` would fail on a
 * dependency the tab never runs. {@link LIVE_SNAPSHOT_FIELDS} pins the field names so a rename on
 * the adapter side shows up as a failing test rather than as an overlay that silently stays empty.
 *
 * **Coordinates are handed in, never computed here.** The path and the position are in the robot's
 * own millimetres, and turning those into map units is the one place this project has already lost
 * hours to. `MapEngine.robotToSvg()` does it for the charger, the robot, the room labels and the
 * furniture; the live overlay goes through the very same function, injected as `toSvg`. If that
 * conversion were ever wrong, the overlay would at least be wrong in exactly the same way as the
 * map under it, and the two would still line up.
 */

/** A point in the robot's own millimetres, as it comes out of `get_dynamic_data`. */
export interface RobotPoint {
	x: number;
	y: number;
}

/** A point in SVG user units of the map's `mainGroup`, as {@link LiveTrackToSvg} returns it. */
export interface SvgPoint {
	x: number;
	y: number;
}

/** Converts robot millimetres into the map's SVG user units. */
export type LiveTrackToSvg = (point: RobotPoint) => SvgPoint;

/**
 * One `get_dynamic_data` answer, as the adapter publishes it.
 *
 * Mirror of `DynamicSnapshot` in `src/lib/map/dynamicData.ts`; see the file comment for why it is
 * repeated instead of imported.
 */
export interface LiveSnapshot {
	/** Position and heading, or null while the robot reports none. Millimetres, angle in degrees. */
	position: { x: number; y: number; angle: number } | null;
	/** The driven track in millimetres, oldest point first. */
	path: RobotPoint[];
	/** One value per path point, same length as `path`. Empty when the robot sends none. */
	mopFlags: number[];
}

/**
 * The field names of the published JSON.
 *
 * The contract is agreed and fixed, so this is not a guess - it is a tripwire. A rename on the
 * adapter side cannot be caught by the compiler across the process boundary, and the symptom would
 * be an overlay that draws nothing at all while every test still passes.
 */
export const LIVE_SNAPSHOT_FIELDS = Object.freeze(["position", "path", "mopFlags"] as const);

/**
 * State the live snapshot is read from, relative to `Devices.<duid>.`.
 *
 * The adapter side is being built in parallel and names this state; **this constant is the only
 * place the tab needs to follow that decision.** Nothing else in the tab spells the id out.
 */
export const LIVE_TRACK_STATE = "map.liveTrack";

/**
 * Colours of the two track kinds, and the casing drawn under both.
 *
 * The surface under the track is the map bitmap, and the tab has no say in how that is painted:
 * it is rendered in the adapter, where a light and a dark set exist side by side
 * (`LEGACY_COLORS` / `DARK_MAP_COLORS` in `src/common/mapDrawing/constants.ts`) and the adapter
 * option `map_color_scheme` decides which one is used. Theming these two track colours from the
 * browser would therefore not adapt them to their background - the background follows a setting
 * this page does not read.
 *
 * What does the theme-proofing is the casing: a dark, semi-transparent line drawn wider and
 * underneath. It separates both tracks from a light surface as well as from a dark one, so the
 * overlay stays readable no matter what the bitmap or a future theme puts behind it. Amber against
 * light blue also survives the common forms of colour blindness, which two similar hues would not.
 */
export const LIVE_TRACK_COLORS = Object.freeze({
	/** Driven, not mopped. */
	driven: "#ffb300",
	/** Mopped - see {@link isMopped} for what that claim rests on. */
	mopped: "#29b6f6",
	/** Drawn under both, wider, so the colour never has to carry the contrast on its own. */
	casing: "rgba(0, 0, 0, 0.55)"
});

/** Colours of the live position marker; same reasoning as {@link LIVE_TRACK_COLORS}. */
export const LIVE_ROBOT_COLORS = Object.freeze({
	body: "#ffffff",
	/** The heading wedge, deliberately the loudest colour on the map. */
	heading: "#ff3d00",
	outline: "rgba(0, 0, 0, 0.65)"
});

/**
 * Stroke widths of the overlay in SVG user units, i.e. in map units and not in screen pixels.
 *
 * Everything the overlay draws sits inside `mainGroup`, which carries the d3 zoom transform, so
 * these widths grow and shrink with the map exactly like the historic paths do
 * (`rescaler.pathMainWidth()` is a constant for the same reason). Nothing here needs a
 * counter-scale, and adding one would make the live track behave unlike every other line on the
 * map.
 *
 * The live track is drawn wider than the historic white one on purpose: it is the answer to "what
 * did it just clean", so it has to win over the trace of previous runs underneath it.
 */
export const LIVE_TRACK_WIDTH = Object.freeze({
	track: 3.2,
	/** Added to {@link LIVE_TRACK_WIDTH.track} on each side, so the casing peeks out. */
	casingExtra: 2.2
});

/**
 * Radius and heading wedge of the live position marker, in SVG user units.
 *
 * The marker replaces the map's own robot while a live position exists, so the two have to be the
 * same size - otherwise the robot would visibly shrink the moment the live channel starts
 * reporting. That size is the app's: `robotDiameter: 8.8` map cells, in the decompiled control
 * plugin `roborock.vacuum.a65_control_v5208` at bundle line 342603. A cell is `VISUAL_BLOCK_SIZE`
 * = 3 user units here, which puts the diameter at 26.4 and the radius at **13.2**.
 *
 * It used to be 6, a radius of 12 units against the map robot's 21 - so the robot did shrink, and
 * the live marker was the smaller of the two the user was actually looking at.
 *
 * The wedge keeps its proportions to the body (11/6 and 4/6 of the radius), because those were
 * chosen against the body and not against the map.
 */
export const LIVE_ROBOT_SIZE = Object.freeze({
	radius: 13.2,
	/** Distance from the centre to the tip of the heading wedge. */
	headingLength: 24.2,
	/** Half-width of the wedge at its base. */
	headingHalfWidth: 8.8
});

/** One run of the track that is entirely mopped or entirely not. */
export interface LiveTrackSegment {
	/** True when this run was mopped, see {@link isMopped}. */
	mopped: boolean;
	/** The run in SVG user units, at least one point. */
	points: SvgPoint[];
}

/** The live position marker, ready to draw. */
export interface LiveRobotPose {
	/** Centre in SVG user units. */
	x: number;
	y: number;
	/** Rotation to apply to a marker drawn pointing up, in degrees clockwise. */
	rotation: number;
}

/**
 * The bit that separates a mopping point from a merely driven one.
 *
 * See {@link isMopped} for the two measurements this rests on.
 */
export const MOP_ACTIVE_BIT = 0x02;

/**
 * Whether a path point counts as mopped.
 *
 * **This is the only place in the tab that interprets a mop value.** The reading rests on two
 * measured runs of the test device (S7 Max Ultra), not on the app's source:
 *
 * | Run | Values seen |
 * |---|---|
 * | `app_goto_target`, driving only, no cleaning | `12` for all 71 points |
 * | `app_segment_clean` of the kitchen, mopping | `10` (1166x), `12` (120x), `2` (96x), `14` (33x), `8` (24x), `1`, `0` |
 *
 * So `12` is what the robot sends while it merely drives, and it is emphatically **not** a mop
 * marker - the earlier "anything non-zero is mopped" would have painted the whole approach to the
 * kitchen as mopped. Read as bits, the two runs separate cleanly on `0x02`: the values carrying it
 * (`2`, `10`, `14`) dominate the mopping run, those without it (`8`, `12`) are what the transit run
 * consisted of.
 *
 * **`0x02` as "mopping here" is therefore inferred from two runs, not proven from the app.** The
 * app does classify the points - `_parsePath` receives `mopPath.data` and splits the track into
 * `path`, `pureCleanPath` and `backWashPath`, drawn in `pureMopColor`, `mopPathColor` and
 * `backWashPathColor` - but the predicate itself sits one indirection deeper in the bytecode and is
 * not read yet. Beware of one false lead: the literal `12` in `_parsePath` is a distance threshold
 * for breaking the line, unrelated to these values. Meanings of individual bits beyond `0x02` stay
 * uninvented; a guessed table would be read as fact by whoever comes next.
 *
 * @param flag The value the robot sent for this path point, if any.
 * @returns True when the point should be drawn as mopped.
 */
export function isMopped(flag: number | null | undefined): boolean {
	return typeof flag === "number" && Number.isFinite(flag) && (flag & MOP_ACTIVE_BIT) !== 0;
}

/**
 * Rotation for a marker that is drawn pointing up, given a robot heading.
 *
 * Two flips stack here, and getting either wrong puts the robot's nose in the wrong room:
 *
 *  - The robot counts its angle counter-clockwise from +x, the SVG y axis points **down**, so a
 *    heading of `a` becomes a screen direction of `-a`.
 *  - A marker authored pointing up already faces -90 degrees in screen terms, so it has to be
 *    turned back by another +90.
 *
 * The result, `-a + 90`, is character for character the expression `SVGMapRenderer.drawRobot()`
 * applies to the map's own robot image. That is the point: the live marker and the map's robot
 * must never disagree about which way "forward" is.
 *
 * @param angle Heading in degrees as the robot reports it; a non-finite value is read as 0.
 * @returns Degrees clockwise, for an SVG `rotate()`.
 */
export function svgRotationFromRobotAngle(angle: number | null | undefined): number {
	const usable = typeof angle === "number" && Number.isFinite(angle) ? angle : 0;
	return -usable + 90;
}

/**
 * Reads a coordinate pair out of whatever arrived over the socket.
 * @param value One entry of the published `path` array.
 * @returns The point, or a non-finite pair when the entry is unusable - never null, because
 *          dropping an entry would shift every later mop value onto the wrong point.
 */
function readPoint(value: unknown): RobotPoint {
	if (!value || typeof value !== "object") return { x: NaN, y: NaN };
	const record = value as Record<string, unknown>;
	const x = typeof record.x === "number" ? record.x : NaN;
	const y = typeof record.y === "number" ? record.y : NaN;
	return { x, y };
}

/**
 * Turns the published state value into a snapshot.
 *
 * The value comes off a socket, so every shape has to be survivable: the state may be missing, may
 * hold a JSON string or an already-parsed object, may be truncated, and may come from an adapter
 * version that publishes a field this tab does not know. None of that may throw - the tab draws
 * the rest of the map either way.
 *
 * Unusable path entries are kept as non-finite points rather than dropped, so that `path[i]` and
 * `mopFlags[i]` keep referring to the same point; {@link buildLiveTrackSegments} then breaks the
 * line at that spot instead of drawing a stroke to nowhere.
 *
 * @param raw The state value, as `state.val` delivered it.
 * @returns The snapshot, or null when the value is not a snapshot at all.
 */
export function parseLiveSnapshot(raw: unknown): LiveSnapshot | null {
	if (raw === null || raw === undefined) return null;

	let value: unknown = raw;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		try {
			value = JSON.parse(trimmed);
		} catch {
			return null;
		}
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;

	let position: LiveSnapshot["position"] = null;
	const rawPosition = record.position;
	if (rawPosition && typeof rawPosition === "object" && !Array.isArray(rawPosition)) {
		const point = readPoint(rawPosition);
		if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
			const rawAngle = (rawPosition as Record<string, unknown>).angle;
			// A missing heading is not a reason to hide the robot; it only means the wedge points
			// the way the marker was authored.
			position = { x: point.x, y: point.y, angle: typeof rawAngle === "number" && Number.isFinite(rawAngle) ? rawAngle : 0 };
		}
	}

	const path = Array.isArray(record.path) ? record.path.map(readPoint) : [];

	const rawFlags = Array.isArray(record.mopFlags) ? record.mopFlags : [];
	const mopFlags: number[] = new Array(path.length);
	for (let index = 0; index < path.length; index++) {
		const flag = rawFlags[index];
		mopFlags[index] = typeof flag === "number" && Number.isFinite(flag) ? flag : 0;
	}

	return { position, path, mopFlags };
}

/**
 * Splits the track into runs of one colour and converts them into map units.
 *
 * Two details decide whether the result looks like a track or like a dashed mess:
 *
 *  - **A change of state repeats the previous point.** Without that, the stretch between the last
 *    driven point and the first mopped one would belong to neither run and would simply be
 *    missing, leaving a gap at every transition. The shared stretch is drawn once, in the colour of
 *    the state it leads into.
 *  - **An unusable point ends the run.** The next usable point starts a fresh one, so a hole in the
 *    data shows as a break in the line rather than as a straight stroke across the flat.
 *
 * @param snapshot The snapshot, or null/undefined when there is none.
 * @param toSvg Conversion into map units; pass `MapEngine.robotToSvg` so the overlay and the map
 *              agree by construction.
 * @returns The runs in drawing order; an empty array when there is nothing to draw.
 */
export function buildLiveTrackSegments(snapshot: LiveSnapshot | null | undefined, toSvg: LiveTrackToSvg): LiveTrackSegment[] {
	const segments: LiveTrackSegment[] = [];
	if (!snapshot || !Array.isArray(snapshot.path) || snapshot.path.length === 0) return segments;

	const flags = Array.isArray(snapshot.mopFlags) ? snapshot.mopFlags : [];
	let current: LiveTrackSegment | null = null;

	for (let index = 0; index < snapshot.path.length; index++) {
		const point = snapshot.path[index];
		if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
			current = null;
			continue;
		}

		const converted = toSvg(point);
		if (!converted || !Number.isFinite(converted.x) || !Number.isFinite(converted.y)) {
			current = null;
			continue;
		}

		const mopped = isMopped(flags[index]);

		if (!current) {
			current = { mopped, points: [converted] };
			segments.push(current);
			continue;
		}

		if (current.mopped === mopped) {
			current.points.push(converted);
			continue;
		}

		const bridge: SvgPoint = current.points[current.points.length - 1];
		current = { mopped, points: [bridge, converted] };
		segments.push(current);
	}

	return segments;
}

/**
 * Rounds to two decimals, which is 0.17 mm on the map - far below anything a screen shows.
 * @param value Coordinate in SVG user units.
 * @returns The rounded value, so the `d` attribute stays short and comparable.
 */
function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/**
 * Builds the SVG `d` attribute of one run.
 *
 * A run of a single point becomes a zero-length line rather than a bare `M`: with a round line cap
 * that renders as a dot, whereas a lone `M` renders as nothing. The very first live answer of a
 * standing robot is exactly that case.
 *
 * @param points The run in SVG user units.
 * @returns The path data, or an empty string for an empty run.
 */
export function liveTrackPathD(points: readonly SvgPoint[]): string {
	if (!points.length) return "";

	const first = points[0];
	if (points.length === 1) return `M${round(first.x)},${round(first.y)}L${round(first.x)},${round(first.y)}`;

	let d = `M${round(first.x)},${round(first.y)}`;
	for (let index = 1; index < points.length; index++) {
		d += `L${round(points[index].x)},${round(points[index].y)}`;
	}
	return d;
}

/**
 * Places the live position marker on the map.
 *
 * @param snapshot The snapshot, or null/undefined when there is none.
 * @param toSvg Conversion into map units, the same one the track uses.
 * @returns The pose, or null when there is no usable position - which is the normal state of a
 *          robot that has not reported one yet, not an error.
 */
export function buildLiveRobotPose(snapshot: LiveSnapshot | null | undefined, toSvg: LiveTrackToSvg): LiveRobotPose | null {
	const position = snapshot?.position;
	if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;

	const converted = toSvg({ x: position.x, y: position.y });
	if (!converted || !Number.isFinite(converted.x) || !Number.isFinite(converted.y)) return null;

	return { x: converted.x, y: converted.y, rotation: svgRotationFromRobotAngle(position.angle) };
}

/**
 * The heading wedge of the marker, authored pointing up so
 * {@link svgRotationFromRobotAngle} can turn it.
 * @returns The `points` attribute of an SVG polygon, centred on the marker's centre.
 */
export function liveRobotHeadingPoints(): string {
	const { headingLength, headingHalfWidth, radius } = LIVE_ROBOT_SIZE;
	// Tip ahead of the body, base inside it, so the wedge reads as a nose and not as a detached
	// arrow floating next to the robot.
	return `0,${-headingLength} ${-headingHalfWidth},${-radius * 0.4} ${headingHalfWidth},${-radius * 0.4}`;
}
