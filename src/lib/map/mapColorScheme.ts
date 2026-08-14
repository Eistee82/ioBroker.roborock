/**
 * Which colour set the rendered map bitmap uses, and how that decision is made.
 *
 * The picture is a PNG the **adapter** paints, while light or dark is a choice the **admin makes
 * in a browser**. Those two are on opposite sides of the socket, so the browser has to say what
 * it sees before the adapter can act on it. This module holds the rule; the transport is a state
 * (`mapTheme`) that the admin tab keeps up to date.
 *
 * ## Why the state, and what it costs
 *
 * One rendered PNG per device is all there is - it lives in `Devices.<duid>.map.mapBase64` and
 * every consumer (tab, vis, a script) reads that same string. So the adapter cannot serve two
 * viewers two different pictures, and "follow the admin theme" can only ever mean "follow *a*
 * viewer". With two browsers open in different themes, the last one to report wins.
 *
 * That is bounded rather than unstable, and deliberately so: the tab reports **only when its own
 * theme changes** (and once when it opens), never on a timer. Two browsers therefore exchange at
 * most one write each while opening and then fall silent - the map does not flap. A user who
 * cannot live with that picks `light` or `dark` explicitly, which ignores the state entirely.
 *
 * The alternative - rendering both variants on every map update and letting each viewer choose -
 * was rejected: it doubles the canvas work on every poll for a case that is rare, and the canvas
 * pass is already the part the adapter warns about when it exceeds a second.
 */

/** What the user configured. `auto` defers to whatever the admin tab last reported. */
export type MapColorSchemeSetting = "light" | "dark" | "auto";

/** The default. Chosen so an installation that never touches the option keeps its picture. */
export const DEFAULT_MAP_COLOR_SCHEME: MapColorSchemeSetting = "light";

/**
 * Turns the configured setting plus the theme last reported by a browser into the set to paint
 * with.
 *
 * Everything unknown falls back to `light`, on purpose: a typo in the config, a missing state or
 * a browser that never reported must not silently repaint a working installation.
 * @param setting Value of the adapter option `map_color_scheme`.
 * @param reportedTheme Value of the `mapTheme` state, i.e. what a browser last reported.
 * @returns `"light"` or `"dark"`.
 */
export function resolveMapColorScheme(
	setting: string | undefined | null,
	reportedTheme: string | undefined | null
): "light" | "dark" {
	if (setting === "dark") return "dark";
	if (setting === "auto") return reportedTheme === "dark" ? "dark" : "light";
	return "light";
}

/**
 * Whether a value is a theme name a browser may report.
 *
 * Used as the boundary of the `set_map_theme` message: the tab is untrusted input like any other
 * socket client, and this state ends up steering what the adapter renders.
 * @param value Candidate value.
 * @returns True for exactly `"light"` or `"dark"`.
 */
export function isReportableMapTheme(value: unknown): value is "light" | "dark" {
	return value === "light" || value === "dark";
}
