/**
 * The dock as the Roborock app draws it: which of its graphics belongs on the map, how big it is
 * and which way it is turned.
 *
 * ## Where the images come from
 *
 * The same place the mode icons and the furniture do - the per-user download of the control plugin
 * that `AppPluginManager` unpacks into `roborock/assets/<model>/drawable-mdpi/`. Nothing here is
 * shipped with the adapter, so an installation that never talked to the cloud has none of these
 * files and has to keep the built-in symbol. `SVGMapRenderer.drawCharger` therefore draws the
 * built-in one first and only swaps it once a probe has confirmed the plugin file really is there.
 *
 * ## Which graphic, and why it is not the one the name suggests
 *
 * There are two dock graphics and the app picks between them by dock type, not by model:
 *
 * | `dock_type` | `DockType`      | body graphic       | overlay              |
 * | ----------- | --------------- | ------------------ | -------------------- |
 * | `0`         | `Normal`        | `charger_direction`| none                 |
 * | `> 0`       | `Other`         | `charger_special`  | `charger_special_top`|
 *
 * `charger_direction` is **not** a direction arrow drawn on top of something else - it is the whole
 * graphic of the plain charging dock, a rounded pad with a charging bolt on the side the robot
 * drives in from. Reading the name as "arrow" would put an arrow on the map and leave the dock out.
 *
 * Proof, all in the decompiled control plugin `roborock.vacuum.a65_control_v5208`:
 *
 * - `DockType = {Other: 4294967295, Normal: 0}` and the resource table `DockTypeRes` are built in
 *   module 1507 at lines 343774-343815 of the decompiled bundle. `DockTypeRes[Normal].chargerIcon`
 *   is dependency 140 of that module, `DockTypeRes[Other].chargerIcon` is dependency 142. Module
 *   1507's dependency array (bundle line 344264) resolves those to modules 1661 and 1663, whose
 *   asset registrations at bundle lines 365840 and 365880 name them `charger_direction` (453x587)
 *   and `charger_special` (1250x1080).
 * - The `chargerResources` getter (module 1858, bundle lines 488482-488569) picks `DockTypeRes[Other]`
 *   when `state.dockType !== 0` and `DockTypeRes[Normal]` when it is 0.
 * - `getCharger` (bundle lines 489667-489801) draws `chargerResources.chargerIcon`;
 *   `getSpecialChargerTopView` (bundle lines 489803-489928) draws module 1858's dependency 26 -
 *   module 1860, asset `charger_special_top` (1262x1104, bundle line 501357) - on top of it, and
 *   only when the type is not `Normal`.
 *
 * The two `charger_bubble_*` images are deliberately absent from this module: `getChargerBubbleView`
 * (bundle lines 489930-490008) uses them as the round icon inside the dock's **name bubble**, the
 * label the app pops up when the dock is tapped. They are not map artwork.
 *
 * ## There is no dark set
 *
 * Unlike the mode icons, the dock graphics are filed under `…_resources_…` rather than
 * `…_theme_light_resources_…` / `…_theme_dark_resources_…`. The plugin ships exactly one variant of
 * each, so the map's colour scheme does not enter into it.
 */

/** Every asset of the control plugin starts with the project the app builds it from. */
const ASSET_PREFIX = "projects_comroborocktanos_resources";

/** The two dock families the app knows; `special` is every dock that is more than a charger. */
export type ChargerDockKind = "normal" | "special";

/** One dock graphic: what to draw, how large, and where its anchor sits. */
export interface ChargerGraphic {
	kind: ChargerDockKind;
	/** Asset stem of the body image. */
	body: string;
	/** Asset stem of the overlay drawn on top of the body, or null when the family has none. */
	top: string | null;
	/**
	 * Width in map cells. A cell is 50 mm, so these are the app's own real-world dimensions:
	 * 10.4 cells is 52 cm of base station.
	 */
	widthCells: number;
	/** Height in map cells. */
	heightCells: number;
	/**
	 * The `1 - ratio` factor of the app's vertical nudge; see {@link chargerLayout}.
	 *
	 * It is the same literal the app uses to derive the graphic's aspect, which is why it equals
	 * 0.77 for the plain dock but 0.5 for the base station, whose aspect is 0.86.
	 */
	anchorRatio: number;
}

/**
 * The plain charging dock.
 *
 * `chargerRect` (bundle lines 489596-489618) sizes it as
 * `pixelOfElement(Config.size.chargerNormal * 0.77, Config.size.chargerNormal)` with
 * `chargerNormal = 4.8` (module 1507, bundle line 342603). 0.77 is the graphic's own aspect:
 * 453/587 = 0.7717.
 */
const NORMAL_DOCK: ChargerGraphic = {
	kind: "normal",
	body: "charger_direction",
	top: null,
	widthCells: 4.8 * 0.77,
	heightCells: 4.8,
	anchorRatio: 0.77,
};

/**
 * Every dock above a plain charger - auto-empty, wash, fill, dry.
 *
 * `chargerRect` (bundle lines 489561-489595) sizes it as
 * `pixelOfElement(Config.size.chargerRadius, Config.size.chargerRadius * 0.86)` with
 * `chargerRadius = 10.4`. 0.86 is again the graphic's aspect: 1080/1250 = 0.864.
 */
const SPECIAL_DOCK: ChargerGraphic = {
	kind: "special",
	body: "charger_special",
	top: "charger_special_top",
	widthCells: 10.4,
	heightCells: 10.4 * 0.86,
	anchorRatio: 0.5,
};

/**
 * Picks the dock graphic for a reported dock type.
 *
 * @param dockType Value of `deviceStatus.dock_type`, or null while the device has not reported one.
 * @returns The graphic, or null when the type is unknown - in which case the caller keeps the
 *   built-in symbol rather than guessing a station the user may not own.
 */
export function chargerGraphicFor(dockType: number | null | undefined): ChargerGraphic | null {
	if (typeof dockType !== "number" || !Number.isFinite(dockType) || dockType < 0) return null;
	return dockType === 0 ? NORMAL_DOCK : SPECIAL_DOCK;
}

/**
 * Builds the file name of a dock graphic inside the density folder.
 *
 * @param stem Asset stem from {@link ChargerGraphic}.
 * @returns The plain file name, e.g. `…_resources_charger_special.png`.
 */
export function chargerAssetFileName(stem: string): string {
	return `${ASSET_PREFIX}_${stem}.png`;
}

/**
 * Snaps a dock angle onto the nearest right angle when it is close enough to one.
 *
 * This is `adjustChargerAngle` (module 1684, bundle lines 374343-374381): for k from -2 to 2, the
 * first `90 * k` within 15 degrees of the angle wins, otherwise the angle is kept unchanged. A
 * dock stands against a wall, so a reading of -93 degrees means -90 with sensor noise on top;
 * without the snap the graphic sits visibly askew next to the wall it is pushed against. -93 is
 * exactly what the test device reports.
 *
 * @param angle Angle in degrees as the map's `CHARGER_LOCATION` block carries it.
 * @returns The snapped angle, or 0 for a missing or unusable reading.
 */
export function snapChargerAngle(angle: number | null | undefined): number {
	if (typeof angle !== "number" || !Number.isFinite(angle) || angle === 0) return 0;
	for (let k = -2; k <= 2; k++) {
		if (Math.abs(angle - 90 * k) <= 15) return 90 * k;
	}
	return angle;
}

/** Where and how large the dock graphic goes, in the units the caller passed in. */
export interface ChargerLayout {
	width: number;
	height: number;
	/** Centre the graphic is drawn around and rotated about. */
	centerX: number;
	centerY: number;
	/** Rotation in degrees, clockwise - the direction an SVG `rotate()` turns. */
	rotation: number;
}

/**
 * Places one dock graphic, following the app's `chargerRect` getter (bundle lines 489557-489661).
 *
 * Two details are worth spelling out, because both look like mistakes until one reads the plugin.
 *
 * **The rotation is the negated angle.** The robot reports its angles counter-clockwise in a
 * y-up frame; the map is drawn y-down, where a positive rotation turns the other way. Negating
 * converts between the two, which is the same correction `SVGMapRenderer.drawRobot` applies. The
 * app negates the **snapped** angle here, while its vertical nudge below uses the **raw** one -
 * that asymmetry is in the plugin and is reproduced rather than tidied away.
 *
 * **The nudge is vertical only.** `top` gets `(height / 2) * (1 - anchorRatio) * sin(-angle)` added
 * and `left` gets no such term at all, so a dock facing left or right is not displaced while one
 * facing up or down is. The reported charging position sits at the dock's contact point rather
 * than at the middle of its body, and this is how far the app pushes the artwork off it. It is
 * only correct along one axis, but it is what the app does, and inventing the missing horizontal
 * half would move every dock the app leaves alone.
 *
 * @param input Charging position, its reported angle, the graphic and the size of one map cell in
 *   the caller's units.
 * @returns The placement, in those same units.
 */
export function chargerLayout(input: {
	x: number;
	y: number;
	angle: number | null | undefined;
	graphic: ChargerGraphic;
	cellSize: number;
}): ChargerLayout {
	const width = input.graphic.widthCells * input.cellSize;
	const height = input.graphic.heightCells * input.cellSize;
	const raw = typeof input.angle === "number" && Number.isFinite(input.angle) ? input.angle : 0;
	const nudge = (height / 2) * (1 - input.graphic.anchorRatio) * Math.sin((-raw * Math.PI) / 180);
	return {
		width,
		height,
		centerX: input.x,
		centerY: input.y + nudge,
		rotation: -snapChargerAngle(raw),
	};
}
