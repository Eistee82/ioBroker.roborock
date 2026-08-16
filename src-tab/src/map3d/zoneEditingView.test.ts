import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@i18n/en.json";
import { CLEANING_ZONE_DRAWN_KEY, switchMapView, ZONE_EDITING_VIEW, ZONE_UNSAVED_KEY } from "./zoneEditingView";
import type { PendingPlacement } from "./zoneEditingView";

/** Nothing drawn - the state every case below varies exactly one field of. */
const nothing: PendingPlacement = { mapZone: false, cleaningZone: false };

/**
 * The rule that keeps either kind of rectangle and the 3D view from being active at once.
 *
 * Both halves of the reported fault are in here, and for both kinds: a placement that started while
 * 3D was up drew onto a hidden map, and a switch to 3D while something was drawn hid it.
 */
describe("switching views while a rectangle is drawn", () => {
	it("refuses 3D while a wall or map zone is unsaved, and names why", () => {
		const result = switchMapView("3d", { ...nothing, mapZone: true });
		expect(result.show).toBe("2d");
		expect(result.refusedBecause).toBe(ZONE_UNSAVED_KEY);
	});

	it("refuses 3D while a cleaning zone is drawn, and names its own way out", () => {
		// The second reported fault, and the one the first fix left behind: a cleaning rectangle is
		// just as invisible in 3D, and nothing asks for confirmation before Start sends the robot in.
		const result = switchMapView("3d", { ...nothing, cleaningZone: true });
		expect(result.show).toBe("2d");
		expect(result.refusedBecause).toBe(CLEANING_ZONE_DRAWN_KEY);
	});

	it("names the map zone first when both are drawn", () => {
		// Not arbitrary: the map zone is the one holding a Save/Cancel panel open, so pointing at the
		// cleaning zone would send the user looking for a control that is not the one waiting.
		expect(switchMapView("3d", { mapZone: true, cleaningZone: true }).refusedBecause).toBe(ZONE_UNSAVED_KEY);
	});

	it("allows 3D once nothing is drawn", () => {
		expect(switchMapView("3d", nothing)).toEqual({ show: "3d", refusedBecause: null });
	});

	it("always allows the way back to 2D, and especially while something is drawn", () => {
		// Not an oversight that this is not symmetric: 2D is where the rectangle is, so returning to it
		// is the remedy rather than a case to guard against.
		expect(switchMapView("2d", { mapZone: true, cleaningZone: true })).toEqual({ show: "2d", refusedBecause: null });
		expect(switchMapView("2d", nothing)).toEqual({ show: "2d", refusedBecause: null });
	});

	it("places both kinds of rectangle in the 2D view", () => {
		// The 3D view is built from `map.mapData`, and neither a map zone draft nor a cleaning
		// rectangle is in it - so there is no version of this that can be answered with "3d".
		expect(ZONE_EDITING_VIEW).toBe("2d");
	});

	it("routes every placement in the shell through the rule", () => {
		// The regression this file exists for happened **at the call site**, not in the rule: the map
		// zone button was routed through `ZONE_EDITING_VIEW` and the dock's + button kept calling
		// `addZone()` straight, so it went on drawing onto a hidden map. Nothing in the type system
		// catches a call that simply does not ask, hence this.
		// Not `import.meta.url`: under vitest's jsdom environment that is an http URL, not a file
		// one. `npm run test:tab` starts vitest with `--prefix src-tab`, so the working directory is
		// the tab project; the second candidate covers a run started from the repository root.
		const candidates = ["src/components/MapView.tsx", "src-tab/src/components/MapView.tsx"];
		const shellPath = candidates.map((candidate) => resolve(process.cwd(), candidate)).find(existsSync);
		// A test that cannot find the file must fail rather than quietly assert nothing.
		expect(shellPath, `MapView.tsx not found from ${process.cwd()}`).toBeDefined();
		const shell = readFileSync(shellPath as string, "utf8");
		const placements = [...shell.matchAll(/engineRef\.current\?\.(addZone|startMapZone)\(/g)];
		expect(placements.length).toBeGreaterThanOrEqual(2);

		for (const placement of placements) {
			// The rule is read immediately before the call, in the same callback - a lead of a few
			// lines is generous enough to survive reformatting and far too short to span two handlers.
			const lead = shell.slice(Math.max(0, placement.index - 200), placement.index);
			expect(lead, `${placement[1]} places without asking which view can place`).toContain("ZONE_EDITING_VIEW");
		}
	});

	it("ships a text for every key it can refuse with", () => {
		// A key without a text would surface as the key itself in front of the user.
		const english = en as Record<string, string>;
		for (const key of [ZONE_UNSAVED_KEY, CLEANING_ZONE_DRAWN_KEY]) {
			expect(typeof english[key], key).toBe("string");
			expect(english[key].length, key).toBeGreaterThan(0);
		}
	});
});
