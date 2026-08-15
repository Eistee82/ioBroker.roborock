import { describe, expect, it } from "vitest";
import { MAP_RECORD_TYPES, parseZoneInput } from "@adapter/common/mapZoneKinds";
import {
	MAP_ZONE_ADD_COMMANDS,
	MAP_ZONE_KINDS,
	MAP_ZONE_LIMIT,
	MAP_ZONE_REMOVE_COMMAND,
	zoneAddPayload,
	ZONE_LENGTHS,
} from "./mapZones";

/**
 * The seam between the tab and the adapter.
 *
 * The block names, record lengths, command names and the ten-per-kind limit are not restated here
 * at all - both sides import them from `src/common/mapZoneKinds.ts`, so there is nothing left to
 * drift. What still has to be checked is the part the tab computes for itself: the numbers it puts
 * into an `add_*` command.
 *
 * That check matters because a rejected payload is invisible from the tab. `set_state` answers
 * `{result:"ok"}` as soon as the value is written, before the robot has been asked at all
 * (`src/lib/socketHandler.ts:436-443`); everything `parseZoneInput` throws afterwards goes to the
 * adapter log. So the tab's own output is put through the adapter's own parser here.
 */

describe("the payloads the tab builds", () => {
	const corners = [
		{ x: 0, y: 100 },
		{ x: 200, y: 100 },
		{ x: 200, y: 0 },
		{ x: 0, y: 0 },
	];

	it("are accepted by the adapter's parser and come back unchanged", () => {
		for (const kind of ["no_go", "no_mop"] as const) {
			const payload = zoneAddPayload(kind, corners);
			expect(payload).toHaveLength(ZONE_LENGTHS[kind]);
			// The eight-number form is passed straight through, so what the tab draws is what the
			// map stores - no expansion and no reordering in between.
			expect(parseZoneInput(kind, payload)).toEqual(payload);
		}
	});

	it("produce a wall the adapter accepts", () => {
		const payload = zoneAddPayload("wall", [
			{ x: 10, y: 20 },
			{ x: 30, y: 40 },
		]);
		expect(payload).toHaveLength(ZONE_LENGTHS.wall);
		expect(parseZoneInput("wall", payload)).toEqual(payload);
	});

	it("produce a turned zone the adapter accepts as four corners", () => {
		// The point of the four-corner form: a turned no-go zone cannot be written as two opposite
		// corners, and the app gives exactly this kind a rotate handle
		// (`_appanalysis/17-raumauswahl.md` §B.4, A65:521762).
		const turned = zoneAddPayload("no_go", [
			{ x: 100, y: 200 },
			{ x: 300, y: 260 },
			{ x: 320, y: 160 },
			{ x: 120, y: 100 },
		]);
		expect(parseZoneInput("no_go", turned)).toEqual(turned);
	});
});

describe("the kinds and commands the tab offers", () => {
	it("cover every kind the adapter can rewrite, and no more", () => {
		// `MAP_RECORD_TYPES` is the adapter's own definition of "kinds this adapter can read back
		// off the map and therefore rewrite safely". A kind the tab offered beyond that would be a
		// zone it lets the user draw and the adapter cannot put back.
		expect([...MAP_ZONE_KINDS].sort()).toEqual(Object.keys(MAP_RECORD_TYPES).sort());
	});

	it("name one add command per kind", () => {
		for (const kind of MAP_ZONE_KINDS) {
			expect(MAP_ZONE_ADD_COMMANDS[kind]).toBeTruthy();
		}
		expect(new Set(Object.values(MAP_ZONE_ADD_COMMANDS)).size).toBe(MAP_ZONE_KINDS.length);
	});

	it("keep the removal command and the limit the adapter enforces", () => {
		expect(MAP_ZONE_REMOVE_COMMAND).toBe("remove_map_zone");
		expect(MAP_ZONE_LIMIT).toBe(10);
	});
});
