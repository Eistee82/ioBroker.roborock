import { describe, expect, it } from "vitest";
import { switchMapView, ZONE_EDITING_VIEW, ZONE_UNSAVED_KEY } from "./zoneEditingView";

/**
 * The rule that keeps the zone editor and the 3D view from being active at once.
 *
 * Both halves of the reported fault are in here: a placement that started while 3D was up drew onto
 * a hidden map, and a switch to 3D during a placement hid the draft being dragged.
 */
describe("switching views while a zone is unsaved", () => {
	it("refuses 3D while a wall or zone is unsaved, and names why", () => {
		const result = switchMapView("3d", true);
		expect(result.show).toBe("2d");
		expect(result.refusedBecause).toBe(ZONE_UNSAVED_KEY);
	});

	it("allows 3D once nothing is unsaved", () => {
		expect(switchMapView("3d", false)).toEqual({ show: "3d", refusedBecause: null });
	});

	it("always allows the way back to 2D, and especially while drafting", () => {
		// Not an oversight that this is not symmetric: 2D is where the draft is, so returning to it is
		// the remedy rather than a case to guard against.
		expect(switchMapView("2d", true)).toEqual({ show: "2d", refusedBecause: null });
		expect(switchMapView("2d", false)).toEqual({ show: "2d", refusedBecause: null });
	});

	it("places walls and zones in the 2D view", () => {
		// The 3D view is built from `map.mapData`, and a draft is deliberately not in it - so there is
		// no version of this that can be answered with "3d".
		expect(ZONE_EDITING_VIEW).toBe("2d");
	});
});
