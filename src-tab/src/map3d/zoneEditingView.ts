/**
 * Which of the two map views a wall or zone can be placed in, and what follows for the switch.
 *
 * ## The rule, and why there is one
 *
 * Placing a wall or a zone happens on the **2D** map and nowhere else. `MapEngine.startMapZone`
 * puts a draft into that map's SVG layer, centred on that map's viewport, and the draft is dragged,
 * resized and turned there until the user confirms it. Nothing is sent to the robot in between.
 *
 * The 3D view is built from `map.mapData` alone, so it cannot show a draft: a draft is not in
 * `mapData`, by design - that is the whole point of confirming before saving. And while 3D is up,
 * the 2D map the draft *was* drawn on is `visibility: hidden`.
 *
 * Left alone, that produced the reported fault from both sides:
 *
 * - Pressing "add a no-go zone" in the 3D view drew the draft onto a hidden map. The panel switched
 *   to its Save/Cancel state, and the user was looking at a zone that appeared in neither view -
 *   "no zones are shown in the 3D view, so you cannot place them".
 * - Switching to 3D **while** a draft was being dragged hid it just the same, with the panel still
 *   offering to save something the user could no longer see.
 *
 * ## Why the answer is not a second set of handles
 *
 * `save_map` replaces the entire stored set: what is not sent is deleted, with no operation code and
 * no zone id (`_appanalysis/14-editor-methoden.md` section 2.1). What makes that safe here is the
 * adapter reading the robot's own map first and writing everything back, behind the 2D editor's
 * confirmation path. A second editor would be a second chance to get that wrong, for nothing the
 * user asked for: what was asked for is to place a zone, and with this rule they can, whichever view
 * they start from.
 *
 * Both directions read the rule from here rather than repeating the condition, because the two
 * halves drifting apart is exactly how one of them would come back.
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
 * Answers a request to switch views.
 *
 * @param next The view the user asked for.
 * @param drafting True while a wall or zone is unsaved - `MapZonesModel.drafting`, which covers both
 * a new one being placed and a change to one the robot already holds.
 * @returns Which view to show, and why if that is not the one asked for.
 */
export function switchMapView(next: MapViewKind, drafting: boolean): ViewSwitch {
	// Only the way *into* 3D is refused. Coming back to 2D while drafting is not just allowed, it is
	// the whole remedy - it puts the user back in front of the draft they were dragging.
	if (next === "3d" && drafting) return { show: "2d", refusedBecause: ZONE_UNSAVED_KEY };
	return { show: next, refusedBecause: null };
}

/**
 * The view a placement has to start in.
 *
 * A constant rather than a branch: there is one editor, and hard-coding "2d" at the call site is how
 * a later second view would quietly acquire a half-working one.
 */
export const ZONE_EDITING_VIEW: MapViewKind = "2d";
