import { describe, expect, it } from "vitest";
import {
	boxCorners,
	countZonesOfKind,
	MAP_ZONE_LIMIT,
	MAP_ZONE_MAX_MM,
	mapZoneKey,
	pointsFitTheMap,
	readMapZones,
	zoneAddPayload,
	zoneBox,
	zoneRemovalPayload,
	type MapZonePoint,
} from "./mapZones";

/**
 * The zones that live on the robot's map.
 *
 * What is worth testing here is not "does it read an array" but the three properties that decide
 * whether a user keeps the boundaries they set up by hand:
 *
 *  1. **The index is the adapter's index.** `remove_map_zone` names a zone by its position within
 *     its own kind, so a reader that renumbered, skipped or reordered anything would delete the
 *     wrong zone.
 *  2. **A refusal is reported, not worked around.** The adapter refuses to edit a map it cannot
 *     rebuild completely; the tab has to reach the same verdict, or it offers a button that only
 *     fails in the adapter log.
 *  3. **The corner order survives a round trip.** The payload order is what ends up in the map, and
 *     a rotated zone has no second chance to describe itself.
 */

/** A map that parses, with no zones on it. */
function emptyMap(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { IMAGE: { dimensions: { width: 10, height: 10 } }, ...extra };
}

/** `[x0,y0, x1,y1, x2,y2, x3,y3]` of an upright zone, in the order the app writes. */
function uprightZone(left: number, bottom: number, right: number, top: number): number[] {
	return [left, top, right, top, right, bottom, left, bottom];
}

describe("readMapZones", () => {
	it("reads all three blocks with the index each zone has within its own kind", () => {
		const reading = readMapZones(
			emptyMap({
				FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100), uprightZone(200, 200, 300, 300)],
				NO_MOP_ZONE: [uprightZone(500, 500, 600, 600)],
				VIRTUAL_WALLS: [[10, 20, 30, 40]],
			}),
		);

		expect(reading.refusal).toBeNull();
		expect(reading.zones.map((zone) => `${zone.kind}#${zone.index}`)).toEqual([
			"no_go#0",
			"no_go#1",
			"no_mop#0",
			"wall#0",
		]);
	});

	it("counts the index within the kind, not across the whole reading", () => {
		// The trap this guards: a running counter over all zones would make the no-mop zone index 2,
		// and `remove_map_zone {kind:"no_mop", index:2}` then names a zone that does not exist - or,
		// with enough zones, someone else's.
		const reading = readMapZones(
			emptyMap({
				FORBIDDEN_ZONES: [uprightZone(0, 0, 1, 1), uprightZone(2, 2, 3, 3)],
				NO_MOP_ZONE: [uprightZone(4, 4, 5, 5)],
			}),
		);

		const noMop = reading.zones.find((zone) => zone.kind === "no_mop");
		expect(noMop?.index).toBe(0);
	});

	it("turns a wall into its two end points and a zone into its four corners", () => {
		const reading = readMapZones(
			emptyMap({ VIRTUAL_WALLS: [[10, 20, 30, 40]], FORBIDDEN_ZONES: [uprightZone(0, 0, 100, 100)] }),
		);

		const wall = reading.zones.find((zone) => zone.kind === "wall");
		const zone = reading.zones.find((zone) => zone.kind === "no_go");
		expect(wall?.points).toEqual([
			{ x: 10, y: 20 },
			{ x: 30, y: 40 },
		]);
		expect(zone?.points).toHaveLength(4);
	});

	it("reports a map without an IMAGE block as unparsed instead of as empty", () => {
		// The whole point of the refusal: an empty reading and an unreadable map look identical from
		// here, and treating the second as the first is what would let a save wipe the zones.
		expect(readMapZones({ FORBIDDEN_ZONES: [] }).refusal).toEqual({ reason: "unparsed" });
		expect(readMapZones(null).refusal).toEqual({ reason: "unparsed" });
		expect(readMapZones("not a map").refusal).toEqual({ reason: "unparsed" });
	});

	it("refuses a map carrying an overlay the adapter cannot rebuild", () => {
		const reading = readMapZones(
			emptyMap({ CL_FORBIDDEN_ZONES: [[1, 2, 3, 4, 5, 6, 7, 8]], FORBIDDEN_ZONES: [uprightZone(0, 0, 1, 1)] }),
		);

		expect(reading.refusal).toEqual({ reason: "unreproducible", block: "CL_FORBIDDEN_ZONES" });
		// And it hands back nothing: showing the zones as editable while every command is refused
		// is worse than showing none.
		expect(reading.zones).toEqual([]);
	});

	it("ignores an empty unreproducible block, because the adapter does too", () => {
		expect(readMapZones(emptyMap({ CLF_FORBIDDEN_ZONES: [] })).refusal).toBeNull();
	});

	it("refuses a record of the wrong length rather than reading a short list", () => {
		const reading = readMapZones(emptyMap({ FORBIDDEN_ZONES: [[0, 0, 100, 100]] }));
		expect(reading.refusal).toEqual({ reason: "malformed", block: "FORBIDDEN_ZONES" });
	});

	it("refuses a record holding something that is not a number", () => {
		const reading = readMapZones(emptyMap({ VIRTUAL_WALLS: [[10, 20, "x", 40]] }));
		expect(reading.refusal).toEqual({ reason: "malformed", block: "VIRTUAL_WALLS" });
	});

	it("accepts numeric strings, which is what a JSON round trip can leave behind", () => {
		const reading = readMapZones(emptyMap({ VIRTUAL_WALLS: [["10", "20", "30", "40"]] }));
		expect(reading.refusal).toBeNull();
		expect(reading.zones[0].points).toEqual([
			{ x: 10, y: 20 },
			{ x: 30, y: 40 },
		]);
	});

	it("treats a missing block as no zones of that kind", () => {
		expect(readMapZones(emptyMap()).zones).toEqual([]);
	});
});

describe("zoneBox and boxCorners", () => {
	it("reads centre and extent off an upright zone", () => {
		const box = zoneBox(readMapZones(emptyMap({ FORBIDDEN_ZONES: [uprightZone(0, 0, 200, 100)] })).zones[0].points);

		expect(box).not.toBeNull();
		expect(box!.cx).toBe(100);
		expect(box!.cy).toBe(50);
		expect(box!.halfWidth).toBe(100);
		expect(box!.halfHeight).toBe(50);
		expect(box!.angle).toBe(0);
	});

	it("round-trips corners through the box without moving them", () => {
		// This is the property the whole editing path rests on: read the geometry, change one thing,
		// write it back. Anything the round trip loses is lost on the robot's map as well.
		const points = boxCorners({ cx: 4000, cy: 3000, halfWidth: 500, halfHeight: 250, angle: 0.4 });
		const box = zoneBox(points)!;

		expect(box.cx).toBeCloseTo(4000, 6);
		expect(box.cy).toBeCloseTo(3000, 6);
		expect(box.halfWidth).toBeCloseTo(500, 6);
		expect(box.halfHeight).toBeCloseTo(250, 6);
		expect(box.angle).toBeCloseTo(0.4, 6);
	});

	it("builds the corners in the order the app writes them: top left, clockwise, y upwards", () => {
		// `rectangleToCorners` in the adapter produces exactly this for an upright rectangle
		// (MapEditService.ts:595-616). A different order would still be four corners, and the robot
		// would still store it - as a different quadrilateral.
		const corners = boxCorners({ cx: 100, cy: 50, halfWidth: 100, halfHeight: 50, angle: 0 });
		expect(corners).toEqual([
			{ x: 0, y: 100 },
			{ x: 200, y: 100 },
			{ x: 200, y: 0 },
			{ x: 0, y: 0 },
		]);
	});

	it("turns counter-clockwise in the robot's frame, where y counts upwards", () => {
		// A quarter turn takes the width axis from +x to +y. The screen draws y downwards, so a
		// renderer has to negate this angle - the reason it is stated here rather than assumed.
		const corners = boxCorners({ cx: 0, cy: 0, halfWidth: 100, halfHeight: 10, angle: Math.PI / 2 });
		expect(corners[1].x).toBeCloseTo(-10, 6);
		expect(corners[1].y).toBeCloseTo(100, 6);
	});

	it("keeps a zone of zero width upright instead of letting atan2 decide", () => {
		const box = zoneBox([
			{ x: 5, y: 5 },
			{ x: 5, y: 5 },
			{ x: 5, y: 0 },
			{ x: 5, y: 0 },
		]);
		expect(box!.angle).toBe(0);
	});

	it("refuses anything that is not four corners", () => {
		expect(zoneBox([{ x: 0, y: 0 }])).toBeNull();
		expect(
			zoneBox([
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			]),
		).toBeNull();
	});
});

describe("pointsFitTheMap", () => {
	it("accepts what a uint16 block can hold", () => {
		expect(pointsFitTheMap([{ x: 0, y: 0 }, { x: MAP_ZONE_MAX_MM, y: MAP_ZONE_MAX_MM }])).toBe(true);
	});

	it("rejects a negative coordinate, which would wrap rather than fail", () => {
		expect(pointsFitTheMap([{ x: -1, y: 0 }])).toBe(false);
	});

	it("rejects a coordinate past the end of the range", () => {
		expect(pointsFitTheMap([{ x: MAP_ZONE_MAX_MM + 1, y: 0 }])).toBe(false);
	});
});

describe("zoneAddPayload", () => {
	it("flattens a zone into the eight numbers the command takes", () => {
		const points: MapZonePoint[] = [
			{ x: 0, y: 100 },
			{ x: 200, y: 100 },
			{ x: 200, y: 0 },
			{ x: 0, y: 0 },
		];
		expect(zoneAddPayload("no_go", points)).toEqual([0, 100, 200, 100, 200, 0, 0, 0]);
	});

	it("flattens a wall into its four numbers", () => {
		expect(
			zoneAddPayload("wall", [
				{ x: 10, y: 20 },
				{ x: 30, y: 40 },
			]),
		).toEqual([10, 20, 30, 40]);
	});

	it("rounds, because the map stores whole millimetres", () => {
		expect(
			zoneAddPayload("wall", [
				{ x: 10.4, y: 20.5 },
				{ x: 30.6, y: 40.5 },
			]),
		).toEqual([10, 21, 31, 41]);
	});

	it("refuses a point count that does not match the kind", () => {
		expect(() => zoneAddPayload("no_go", [{ x: 0, y: 0 }])).toThrow(/4 point/);
		expect(() =>
			zoneAddPayload("wall", [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
				{ x: 2, y: 2 },
				{ x: 3, y: 3 },
			]),
		).toThrow(/2 point/);
	});
});

describe("zoneRemovalPayload", () => {
	it("names the zone by kind and index and carries what the user pointed at", () => {
		const zone = readMapZones(emptyMap({ NO_MOP_ZONE: [uprightZone(0, 0, 100, 100)] })).zones[0];
		expect(zoneRemovalPayload(zone)).toEqual({
			kind: "no_mop",
			index: 0,
			zone: [0, 100, 100, 100, 100, 0, 0, 0],
		});
	});
});

describe("countZonesOfKind", () => {
	it("counts each kind against its own limit, not against a shared one", () => {
		// Ten per kind, not ten in total (MAX_COUNT_WALL_OR_FBZ). Counting them together would grey
		// out the button while the robot still has room.
		const zones = readMapZones(
			emptyMap({
				FORBIDDEN_ZONES: Array.from({ length: MAP_ZONE_LIMIT }, () => uprightZone(0, 0, 1, 1)),
				NO_MOP_ZONE: [uprightZone(0, 0, 1, 1)],
			}),
		).zones;

		expect(countZonesOfKind(zones, "no_go")).toBe(MAP_ZONE_LIMIT);
		expect(countZonesOfKind(zones, "no_mop")).toBe(1);
		expect(countZonesOfKind(zones, "wall")).toBe(0);
	});
});

describe("mapZoneKey", () => {
	it("tells zones of different kinds with the same index apart", () => {
		const zones = readMapZones(
			emptyMap({ FORBIDDEN_ZONES: [uprightZone(0, 0, 1, 1)], NO_MOP_ZONE: [uprightZone(0, 0, 1, 1)] }),
		).zones;

		expect(mapZoneKey(zones[0])).not.toBe(mapZoneKey(zones[1]));
	});
});
