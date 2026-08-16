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
 *
 * ## The two zones were instances of a class, not the whole of it
 *
 * Fixing them one at a time found a third: the dock's go-to button hangs a `click` handler on the
 * **2D** SVG and waits for a map click (`MapEngine.toggleGoTo`, `MapEngine.ts:4700`), so in 3D it
 * armed a gesture nobody could complete. And a fourth, worse than all three: `RoomsPanel`'s divide
 * button calls `MapEngine.beginSplit` (`MapEngine.ts:3125`), which lays a line into the 2D map's
 * `splitGroup` for the user to drag - and the panel then offers the send button as soon as the line
 * happens to snap, so a room could be divided along a line the user never saw.
 *
 * What all of them share is one shape, and it is the shape this module now names:
 *
 * > The controls float **above both views** (`MapView.tsx`, everything after the map host), while
 * > the 2D map is `visibility: hidden` under the 3D canvas (`MapView.tsx:611`). A control that acts
 * > on the 2D map is therefore still *pressable* in 3D and no longer *effective* - and nothing
 * > contradicts the user.
 *
 * The 2D map's **own** handlers are not in the class: `visibility: hidden` takes an element out of
 * hit testing, and the 3D canvas covers it anyway (`Map3DView.tsx:366`, `position: absolute` /
 * `inset: 0`). Tapping a room, an obstacle, a stored zone or a dividing grip is *unreachable* in 3D,
 * which is a missing feature and not a silent failure - the user is never told something happened.
 *
 * So the class is exactly: **an overlay control that reaches the 2D map**. {@link MAP_GESTURE_CALLS}
 * is the inventory of those, {@link VIEW_AGNOSTIC_CALLS} of everything else the shell asks the
 * engine for, and the two together are total over the shell's calls - which is what the guard test
 * checks, so that a fifth case cannot be added without being classified.
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

/**
 * Why 3D is refused while a room is being divided.
 *
 * The way out is a third one again - the panel's own Cancel beside the divide button - and the
 * reason to refuse is the strongest of the four: `RoomsPanel` enables the send button the moment
 * the line snaps (`RoomsPanel.tsx:240`), and `splitCurrentRoom` writes a division of the robot's
 * stored map. Left unguarded, that is a map change made along a line the user could not see.
 */
export const ROOM_SPLIT_ACTIVE_KEY = "ui_map3d_finish_split";

/**
 * Why 3D is refused while the go-to gesture is armed.
 *
 * Nothing is drawn here, so nothing would be *lost* - the reason is what happens afterwards. The
 * gesture stays armed across a view change (`toggleGoTo` only disarms on a map click or on Cancel),
 * so a user who arms it, looks at 3D and comes back finds the next click on the map sending the
 * robot somewhere, when they meant to pick a room. Refusing keeps the armed state and the view that
 * shows it together.
 */
export const GO_TO_ARMED_KEY = "ui_map3d_finish_goto";

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
	/**
	 * True while a dividing line lies on the map - `SplitState.active`, whether or not it snapped.
	 *
	 * Not only the valid ones: an unsnapped line is the state the user has to *adjust*, and adjusting
	 * it means dragging a grip that 3D does not show.
	 */
	roomSplit: boolean;
	/** True while the next map click would become a go-to target - `MapEngine.toggleGoTo` is armed. */
	goTo: boolean;
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

	// The order only decides which text is shown when several apply at once, and it goes by how
	// firmly each one holds a control open: a panel waiting on Save first, then a rectangle Start
	// would use, then the dividing line, and last the go-to arming - which holds nothing open beyond
	// its own Cancel in the dock. Naming a looser one while a Save button waits would send the user
	// to the wrong control.
	if (pending.mapZone) return { show: "2d", refusedBecause: ZONE_UNSAVED_KEY };
	if (pending.cleaningZone) return { show: "2d", refusedBecause: CLEANING_ZONE_DRAWN_KEY };
	if (pending.roomSplit) return { show: "2d", refusedBecause: ROOM_SPLIT_ACTIVE_KEY };
	if (pending.goTo) return { show: "2d", refusedBecause: GO_TO_ARMED_KEY };
	return { show: "3d", refusedBecause: null };
}

/**
 * The view a placement has to start in - for both kinds of rectangle.
 *
 * A constant rather than a branch: there is one place a rectangle can be drawn, and hard-coding
 * "2d" at each call site is how the second call site quietly acquired a half-working one.
 */
export const ZONE_EDITING_VIEW: MapViewKind = "2d";

/**
 * What is done about a control that reaches the 2D map.
 *
 * - `switch-to-2d` - the control starts something the user *wants*, so the view follows the intent.
 *   Everything that places, draws or arms is this.
 * - `hidden-in-3d` - the control has no meaning in 3D at all, so it is not offered. Redirecting
 *   would be worse than the fault: nobody presses "reset the view" in order to leave the view.
 */
export type MapGestureRemedy = "switch-to-2d" | "hidden-in-3d";

/**
 * Every engine call the shell makes that reaches the **2D** map, and what is done about it.
 *
 * The evidence for each, so that a later reader can re-check rather than trust the list:
 *
 * | Call | What it touches | Fundstelle |
 * | --- | --- | --- |
 * | `startMapZone` | draft into the 2D SVG zone layer | `MapEngine.ts:4399` |
 * | `addZone` | pushes into `MapEngine.rects`, drawn by `drawZones` | `MapEngine.ts:4341` |
 * | `beginSplit` | lays a line into `splitGroup`, then dragged by its grips | `MapEngine.ts:3125`, `:3338` |
 * | `toggleGoTo` | `click.gototarget` on the 2D SVG, plus a pin in `pinGroup` | `MapEngine.ts:4700` |
 * | `resetZoom` | the 2D map's own d3 zoom transform | `MapEngine.ts:4655` |
 *
 * `resetZoom` is the one that is hidden rather than redirected, and the reason is that it is not a
 * gesture: it changes what is *shown*, and in 3D the thing shown is the 3D camera, which this does
 * not touch. Pressing it in 3D moved a viewport nobody was looking at. The 3D view has its own orbit
 * control for the same job, so nothing is missing while it is away.
 */
export const MAP_GESTURE_CALLS: Readonly<Record<string, MapGestureRemedy>> = {
	startMapZone: "switch-to-2d",
	addZone: "switch-to-2d",
	beginSplit: "switch-to-2d",
	toggleGoTo: "switch-to-2d",
	resetZoom: "hidden-in-3d",
};

/**
 * Every other engine call the shell makes - the ones that work the same in either view.
 *
 * Listing them is the point. A guard test that only knew the bad names would pass the day a sixth
 * one is added, which is how the first three fixes each left the next case behind; a list of the
 * *harmless* ones makes an unlisted call a failure, so a new call has to be classified before it can
 * ship. That is the only half of this that a test can be total about.
 *
 * Three groups, and why each is harmless:
 *
 *  - **Commands and data.** They send to the robot or read the object tree and never touch a
 *    drawing layer: the map is only where their result later appears.
 *  - **Finishers.** `saveMapZone`, `cancelMapZone`, `cancelSplit` and `splitCurrentRoom` do act on
 *    something drawn - but they are reachable only *while* that something is drawn, and
 *    {@link switchMapView} refuses 3D in exactly those states. Their guard is the rule above.
 *  - **Selection.** `cleanSelectedRooms` and `clearRooms` work off a room selection made on the 2D
 *    map. In 3D the selection can only be a leftover from 2D, and both the dock and `RoomsPanel`
 *    show its count, so pressing either produces a change the user can see without the map.
 */
export const VIEW_AGNOSTIC_CALLS: readonly string[] = [
	// Lifecycle of the engine itself.
	"init",
	"destroy",
	"setLanguage",
	// What is being looked at.
	"selectRobot",
	"selectFloor",
	"setMapNames",
	// Reading the division in progress; neither draws nor sends.
	"canSplitRooms",
	"splitRefusalFor",
	"getSplitState",
	// Finishers - see the note above.
	"cancelSplit",
	"splitCurrentRoom",
	"saveMapZone",
	"cancelMapZone",
	// Selection - see the note above.
	"cleanSelectedRooms",
	"clearRooms",
	// Commands and data.
	"mergeSelectedRooms",
	"setCleanOrderFromSelection",
	"clearCleanOrder",
	"renameRoom",
	"setMode",
	"setCleaningMode",
	"setCleanCount",
	"start",
	"resume",
	"pause",
	"stop",
	"dock",
	"resetConsumable",
	"sendDockValue",
	"deleteCleaningRun",
];
