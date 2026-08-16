/**
 * Which of the two map views a rectangle can be placed in, and what follows for the switch.
 *
 * ## The rule, and why there is one
 *
 * The map carries **two** completely different kinds of rectangle, and both are placed on the
 * **2D** map and nowhere else:
 *
 * | | What it is | Where the draft lives | How it leaves the browser |
 * | --- | --- | --- | --- |
 * | **Map zone** | no-go, no-mop, virtual wall - stored on the robot's own map | `MapEngine.startMapZone`, `MapEngine.ts:4399-4431` | `save_map`, behind the panel's Save |
 * | **Cleaning zone** | the rectangle a run is aimed at, gone afterwards | `MapEngine.addZone`, `MapEngine.ts:4341-4362` | `app_zoned_clean`, on Start |
 *
 * Both put their rectangle into the 2D map's **SVG layer**, centred on that map's viewport: the map
 * zone as `mapZoneDraft`, the cleaning zone as an entry in `MapEngine.rects` drawn by `drawZones`.
 * Neither is in `map.mapData`, and the 3D view is built from `map.mapData` alone
 * (`map3dSource.ts:206-215`) - the model it builds knows two zone kinds, `"forbidden"` and
 * `"noMop"`, and no third one (`zones3d.ts:54`). So the 3D view cannot show either draft, and while
 * 3D is up the 2D map they *were* drawn on is `visibility: hidden` (`MapView.tsx:593`).
 *
 * Left alone, that produced the reported fault from both sides, for each kind:
 *
 * - Pressing "add a zone" in the 3D view drew the rectangle onto a hidden map. For a map zone the
 *   panel switched to its Save/Cancel state, for a cleaning zone the run button relabelled itself to
 *   "Start zone cleaning" (`ActionDock.startIntent`) - and either way the user was looking at a zone
 *   that appeared in neither view: "no zones are shown in the 3D view, so you cannot place them".
 * - Switching to 3D **while** a rectangle was drawn hid it just the same. For a cleaning zone that
 *   is the worse half of the two: nothing asks for confirmation afterwards, so Start would send the
 *   robot into a rectangle the user can no longer see.
 *
 * ## Why the answer is not a second set of handles
 *
 * For a map zone, because `save_map` replaces the entire stored set: what is not sent is deleted,
 * with no operation code and no zone id (`_appanalysis/14-editor-methoden.md` section 2.1). What
 * makes that safe here is the adapter reading the robot's own map first and writing everything back,
 * behind the 2D editor's confirmation path.
 *
 * For a cleaning zone that argument does **not** apply - it is never stored, so nothing can be
 * deleted by getting it wrong. What applies instead is the gesture: the rectangle is dragged and
 * resized flat on the map, and in 3D the user would be grabbing a corner seen in perspective. And
 * `MapEngine.updateRobotZones` (`:4071-4089`) turns exactly those SVG rectangles into the
 * `app_zoned_clean` payload, so a second placement path would be a second geometry to keep in step
 * with it, for nothing the user asked for: what was asked for is to place a zone, and with this rule
 * they can, whichever view they start from.
 *
 * Every direction reads the rule from here rather than repeating the condition, because the halves
 * drifting apart is exactly how one of them would come back - which is what happened: the first fix
 * covered the map zone and left the cleaning zone behind.
 */

/** The two views the map is shown in. */
export type MapViewKind = "2d" | "3d";

/** What a request to switch views comes to. */
export interface ViewSwitch {
	/** The view to show. Equals the request unless it was refused. */
	show: MapViewKind;
	/**
	 * Translation key naming why the request was not granted, or null when it was.
	 *
	 * A key rather than a sentence: the caller is what has the translator, and a module that
	 * formats its own text ends up being the second place UI strings live.
	 */
	refusedBecause: string | null;
}

/** Named here so the caller cannot pass a key this module does not actually ship a text for. */
export const ZONE_UNSAVED_KEY = "ui_map3d_finish_zone";

/**
 * Why 3D is refused while a cleaning rectangle is drawn.
 *
 * A text of its own rather than reusing {@link ZONE_UNSAVED_KEY}: the way out is a different one.
 * A map zone is finished with the panel's Save or Cancel; a cleaning zone is finished by starting
 * the run or by removing the rectangle with its own delete handle, and there is no Save button
 * anywhere to look for.
 */
export const CLEANING_ZONE_DRAWN_KEY = "ui_map3d_finish_cleaning_zone";

/** What is drawn on the 2D map right now and would be hidden by a switch to 3D. */
export interface PendingPlacement {
	/**
	 * True while a wall or map zone is unsaved - `MapZonesModel.drafting`, which covers both a new
	 * one being placed and a change to one the robot already holds.
	 */
	mapZone: boolean;
	/**
	 * True while at least one cleaning rectangle is drawn - `ZoneModel.count > 0`.
	 *
	 * Not "being dragged": a finished rectangle is just as invisible in 3D as one under the mouse,
	 * and it is the finished one that Start would send the robot into.
	 */
	cleaningZone: boolean;
}

/**
 * Answers a request to switch views.
 *
 * @param next The view the user asked for.
 * @param pending What is drawn on the 2D map and would vanish with the switch.
 * @returns Which view to show, and why if that is not the one asked for.
 */
export function switchMapView(next: MapViewKind, pending: PendingPlacement): ViewSwitch {
	// Only the way *into* 3D is refused. Coming back to 2D is not just allowed, it is the whole
	// remedy - it puts the user back in front of the rectangle they drew.
	if (next !== "3d") return { show: next, refusedBecause: null };

	// The map zone first when both apply: it is the one holding a modal-ish panel open, and naming
	// the cleaning zone while a Save button is waiting would send the user to the wrong control.
	if (pending.mapZone) return { show: "2d", refusedBecause: ZONE_UNSAVED_KEY };
	if (pending.cleaningZone) return { show: "2d", refusedBecause: CLEANING_ZONE_DRAWN_KEY };
	return { show: "3d", refusedBecause: null };
}

/**
 * The view a placement has to start in - for both kinds of rectangle.
 *
 * A constant rather than a branch: there is one place a rectangle can be drawn, and hard-coding
 * "2d" at each call site is how the second call site quietly acquired a half-working one.
 */
export const ZONE_EDITING_VIEW: MapViewKind = "2d";
