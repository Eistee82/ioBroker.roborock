import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@i18n/en.json";
import {
	CLEANING_ZONE_DRAWN_KEY,
	GO_TO_ARMED_KEY,
	MAP_GESTURE_CALLS,
	ROOM_SPLIT_ACTIVE_KEY,
	switchMapView,
	VIEW_AGNOSTIC_CALLS,
	ZONE_EDITING_VIEW,
	ZONE_UNSAVED_KEY,
} from "./zoneEditingView";
import type { PendingPlacement } from "./zoneEditingView";

/** Nothing placed - the state every case below varies exactly one field of. */
const nothing: PendingPlacement = { mapZone: false, cleaningZone: false, roomSplit: false, goTo: false };

/**
 * Finds a file of the tab project from wherever vitest was started.
 *
 * Not `import.meta.url`: under vitest's jsdom environment that is an http URL, not a file one.
 * `npm run test:tab` starts vitest with `--prefix src-tab`, so the working directory is the tab
 * project; the second candidate covers a run started from the repository root.
 *
 * @param relative Path inside `src-tab/`.
 */
function tabFile(relative: string): string {
	const candidates = [relative, join("src-tab", relative)];
	const found = candidates.map((candidate) => resolve(process.cwd(), candidate)).find(existsSync);
	// A test that cannot find the file must fail rather than quietly assert nothing.
	expect(found, `${relative} not found from ${process.cwd()}`).toBeDefined();
	return found as string;
}

/** Every `.ts`/`.tsx` file under a directory that is not a test. */
function sourceFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full));
		else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

/**
 * The rule that keeps a gesture on the 2D map and the 3D view from being active at once.
 *
 * Both halves of the reported fault are in here, for all four kinds: a gesture that started while 3D
 * was up worked on a hidden map, and a switch to 3D while one was in progress hid it.
 */
describe("switching views while something is placed on the map", () => {
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

	it("refuses 3D while a room is being divided", () => {
		// The one with the most at stake: `RoomsPanel` enables its divide button as soon as the line
		// snaps, and that button writes a division of the robot's stored map. Without this, a room
		// could be cut along a line the user never saw.
		const result = switchMapView("3d", { ...nothing, roomSplit: true });
		expect(result.show).toBe("2d");
		expect(result.refusedBecause).toBe(ROOM_SPLIT_ACTIVE_KEY);
	});

	it("refuses 3D while the go-to gesture is armed", () => {
		// Nothing is lost here - what is guarded against is afterwards: the arming survives a view
		// change, so a user who came back to 2D would find their next click sending the robot off.
		const result = switchMapView("3d", { ...nothing, goTo: true });
		expect(result.show).toBe("2d");
		expect(result.refusedBecause).toBe(GO_TO_ARMED_KEY);
	});

	it("names the firmest-held control when several apply", () => {
		// Not arbitrary: the map zone is the one holding a Save/Cancel panel open, so pointing at
		// anything looser would send the user looking for a control that is not the one waiting.
		const all: PendingPlacement = { mapZone: true, cleaningZone: true, roomSplit: true, goTo: true };
		expect(switchMapView("3d", all).refusedBecause).toBe(ZONE_UNSAVED_KEY);
		expect(switchMapView("3d", { ...all, mapZone: false }).refusedBecause).toBe(CLEANING_ZONE_DRAWN_KEY);
		expect(switchMapView("3d", { ...nothing, roomSplit: true, goTo: true }).refusedBecause).toBe(ROOM_SPLIT_ACTIVE_KEY);
	});

	it("allows 3D once nothing is placed", () => {
		expect(switchMapView("3d", nothing)).toEqual({ show: "3d", refusedBecause: null });
	});

	it("always allows the way back to 2D, and especially while something is placed", () => {
		// Not an oversight that this is not symmetric: 2D is where the gesture is, so returning to it
		// is the remedy rather than a case to guard against.
		const all: PendingPlacement = { mapZone: true, cleaningZone: true, roomSplit: true, goTo: true };
		expect(switchMapView("2d", all)).toEqual({ show: "2d", refusedBecause: null });
		expect(switchMapView("2d", nothing)).toEqual({ show: "2d", refusedBecause: null });
	});

	it("places every gesture in the 2D view", () => {
		// The 3D view is built from `map.mapData`, and none of a map zone draft, a cleaning rectangle,
		// a dividing line or a go-to pin is in it - so there is no version of this answered with "3d".
		expect(ZONE_EDITING_VIEW).toBe("2d");
	});

	it("ships a text for every key it can refuse with", () => {
		// A key without a text would surface as the key itself in front of the user.
		const english = en as Record<string, string>;
		for (const key of [ZONE_UNSAVED_KEY, CLEANING_ZONE_DRAWN_KEY, ROOM_SPLIT_ACTIVE_KEY, GO_TO_ARMED_KEY]) {
			expect(typeof english[key], key).toBe("string");
			expect(english[key].length, key).toBeGreaterThan(0);
		}
	});
});

/**
 * The guard, and why it is shaped the way it is.
 *
 * Three times running, a control was wired straight to the engine and went on working a map nobody
 * could see - the map zone, the cleaning zone the first fix left behind, then the dock's go-to and
 * the panel's divide button. The obvious guard is a list of the names that went wrong, and that is
 * exactly the guard that would have passed on the day each next one was added: it can only ever know
 * about the cases somebody already found.
 *
 * So this one is built the other way round. The class is "an overlay control that reaches the 2D
 * map", and the two lists in `zoneEditingView.ts` are asserted to be **total** over the calls the
 * shell makes: every call is either a gesture with a named remedy or explicitly declared harmless.
 * A fifth case cannot be added without landing in one list or the other, whatever it is called - an
 * unclassified call is a failure with the author's own new name in the message.
 *
 * What it cannot see, said plainly rather than implied: a control that reaches the 2D map *without*
 * going through the engine. The last test below closes the one route that would be - a second holder
 * of a `MapEngine` somewhere other than the shell.
 */
describe("no overlay control may work the 2D map while 3D is showing", () => {
	const shell = readFileSync(tabFile("src/components/MapView.tsx"), "utf8");

	/**
	 * Every engine method the shell calls, in either form.
	 *
	 * The lookbehind keeps `MapEngine.beginSplit` in a comment from counting as a call; only a bare
	 * `engine.` and the shell's own `engineRef.current?.` do.
	 */
	const called = new Set(
		[...shell.matchAll(/(?<![\w$.])(?:engineRef\.current\??|engine)\.([A-Za-z_$][\w$]*)\(/g)].map((match) => match[1])
	);

	it("finds the shell's calls at all", () => {
		// Guards the regex itself: a rename that made it match nothing would otherwise turn every
		// assertion below into a vacuous pass.
		expect(called.size).toBeGreaterThan(20);
	});

	it("classifies every call the shell makes", () => {
		const classified = new Set([...Object.keys(MAP_GESTURE_CALLS), ...VIEW_AGNOSTIC_CALLS]);
		const unknown = [...called].filter((name) => !classified.has(name));
		expect(
			unknown,
			`${unknown.join(", ")}: new engine call(s) in MapView.tsx. Say in map3d/zoneEditingView.ts whether they ` +
				"reach the 2D map (MAP_GESTURE_CALLS, with a remedy) or work the same in either view " +
				"(VIEW_AGNOSTIC_CALLS). An unclassified call is how the go-to and the room division stayed broken."
		).toEqual([]);
	});

	it("keeps the lists free of names the shell no longer calls", () => {
		// The other direction, so a removed call cannot leave a claim behind that reads as checked.
		for (const name of [...Object.keys(MAP_GESTURE_CALLS), ...VIEW_AGNOSTIC_CALLS]) {
			expect(called.has(name), `${name} is listed but MapView.tsx does not call it`).toBe(true);
		}
	});

	it("puts no name in both lists", () => {
		const both = Object.keys(MAP_GESTURE_CALLS).filter((name) => VIEW_AGNOSTIC_CALLS.includes(name));
		expect(both, `${both.join(", ")}: listed as both a 2D gesture and view-agnostic`).toEqual([]);
	});

	it("never lets a 2D gesture be called straight off the ref", () => {
		// This is the actual regression, in one assertion: `engineRef.current?.addZone()` and
		// `engineRef.current?.toggleGoTo()` were exactly that, and nothing in the type system objects.
		for (const name of Object.keys(MAP_GESTURE_CALLS)) {
			const direct = new RegExp(String.raw`engineRef\.current\??\.${name}\(`);
			expect(direct.test(shell), `${name} is called straight off the ref instead of through the view rule`).toBe(false);
		}
	});

	it("routes each gesture through the remedy its entry names", () => {
		for (const [name, remedy] of Object.entries(MAP_GESTURE_CALLS)) {
			const helper = remedy === "switch-to-2d" ? "inMapEditingView" : "whenMapEditable";
			const routed = new RegExp(String.raw`${helper}\(\s*engine\s*=>\s*engine\.${name}\(`);
			expect(routed.test(shell), `${name} is declared "${remedy}" but does not go through ${helper}`).toBe(true);
		}
	});

	it("asks the view rule with every field it has", () => {
		// The refusal half. A field added to `PendingPlacement` and then not passed would leave the
		// rule answering on a default, which is how the switch would go on hiding the new gesture.
		const call = /switchMapView\(next,\s*\{([^}]*)\}/.exec(shell);
		expect(call, "MapView.tsx no longer asks switchMapView the way this test can read").not.toBeNull();
		for (const field of ["mapZone", "cleaningZone", "roomSplit", "goTo"]) {
			expect((call as RegExpExecArray)[1], `${field} is not passed to switchMapView`).toContain(`${field}:`);
		}
	});

	it("keeps the shell the only holder of a map engine", () => {
		// What makes the inventory above total. A second component building its own engine would have
		// its own call sites, and none of them would be seen by any assertion here.
		const root = tabFile("src");
		const holders = sourceFiles(root)
			.filter((file) => /new\s+MapEngine\s*\(/.test(readFileSync(file, "utf8")))
			.map((file) => file.slice(root.length + 1).replace(/\\/g, "/"));
		expect(holders, "a second place builds a MapEngine; the guard above only reads MapView.tsx").toEqual([
			"components/MapView.tsx",
		]);
	});
});
