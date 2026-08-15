/**
 * Letting everything that is *not* selected step back, the way the Roborock app does it.
 *
 * The app does not highlight the selection - it takes the rest away. Its map is a stack: one base
 * bitmap with every room in a muted colour set, and on top of it one otherwise fully transparent
 * PNG per room in a vivid set. While something is selected, the app lowers the opacity of the
 * **base bitmap only**, so the unselected rooms fade against the ground while the selected ones
 * keep their full colour (`_appanalysis/17-raumauswahl.md`, sections 0-2).
 *
 * Two numbers carry that, and they are not symmetric:
 *
 * | mode  | opacity of the base bitmap | effect on the unselected rooms |
 * |-------|----------------------------|--------------------------------|
 * | light | 0.3                        | they get **lighter**           |
 * | dark  | 0.7                        | they get **darker**            |
 *
 * Proven at A65:494737-494743 (the factor, chosen by the theme flag) and A65:494792-494798 (it is
 * applied to `imageStyle`, i.e. the background image, not to the container). Without a selection
 * the value stays the `1` set at A65:494457 - which is why no selection has to mean *exactly*
 * today's picture here as well.
 *
 * ## Why this is a colour operation and not a veil over the finished PNG
 *
 * The adapter draws one canvas instead of a stack, so it has no layer to dim. A veil over the
 * finished image would dim the selection with everything else, and it would dim the cleaning path,
 * the robot and the zones too - in the app those are separate children of the map view and stay
 * fully opaque (A65:494826-494851). Mixing the colours *before* they are drawn keeps that
 * separation without a second canvas: only what belongs to the base bitmap - room fills and the
 * walls around them - is mixed, and everything drawn afterwards is untouched by construction.
 *
 * ## What the colours are mixed with
 *
 * With the map's own ground (`MapSurfaceColors.floor` of the active scheme), never with the page
 * behind the image. The app fades against its page background, but which colour that is could not
 * be proven (section 8.1 of the report), and the adapter hands its PNG to consumers whose
 * background it cannot know - the admin tab, vis, a script. The map ground is the one colour that
 * is certainly behind the rooms, and mixing towards it produces exactly the intended reading: the
 * unselected rooms sink into the floor of the map.
 */

import type { MapSurfaceColors } from "./constants";

/** Opacity the app gives its base bitmap while a selection is active, light theme (A65:494740). */
export const SELECTION_FADE_LIGHT = 0.3;

/** The same for the dark theme (A65:494743). Milder on purpose: against a dark ground a small drop already eats the drawing. */
export const SELECTION_FADE_DARK = 0.7;

/**
 * How much of a colour survives the fade in this scheme.
 * @param scheme The colour set the map is painted with.
 * @returns 0.3 for light, 0.7 for dark - the app's two factors.
 */
export function getSelectionFadeFactor(scheme: string | undefined | null): number {
	return scheme === "dark" ? SELECTION_FADE_DARK : SELECTION_FADE_LIGHT;
}

/**
 * Parses `#RGB`-style hex into its three channels.
 *
 * Accepts the eight digit form as well because several palette entries carry a trailing alpha
 * (`#DFDFDFff`); the alpha is dropped, as it is everywhere else in the drawing code.
 * @param hex Colour in `#RRGGBB` or `#RRGGBBAA` form.
 * @returns The three channels, or `null` when the string is not a hex colour.
 */
function parseHexChannels(hex: string): [number, number, number] | null {
	if (typeof hex !== "string" || hex.length < 7 || hex[0] !== "#") return null;
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
	return [r, g, b];
}

/** Two hex digits for one channel. */
function toHexByte(value: number): string {
	return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();
}

/**
 * Mixes a colour towards a target, the way a partly transparent layer would look over it.
 *
 * `keep` is the app's opacity value: `keep = 1` returns the colour unchanged, `keep = 0` returns
 * the target. Anything the function cannot read as a hex colour is returned untouched - a broken
 * palette entry must not turn a room black.
 * @param hex Colour to fade, `#RRGGBB` or `#RRGGBBAA`.
 * @param target Colour to fade towards, same forms.
 * @param keep Share of the original colour that survives, 0..1.
 * @returns The mixed colour as `#RRGGBB`, or `hex` unchanged when either input is unusable.
 */
export function fadeHexTowards(hex: string, target: string, keep: number): string {
	if (!Number.isFinite(keep) || keep >= 1) return hex;
	const source = parseHexChannels(hex);
	const ground = parseHexChannels(target);
	if (!source || !ground) return hex;

	const share = Math.max(0, keep);
	const mix = (index: number): string => toHexByte(source[index] * share + ground[index] * (1 - share));
	return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/**
 * The surface colours of a map that has a selection on it.
 *
 * Ground and walls belong to the base bitmap and fade with it; the path does not. In the app the
 * cleaning path is a sibling of the map image (`cleanPath`, A65:494826-494851) and keeps full
 * opacity - and it is the one thing on the map a user is watching while a run is in progress, so
 * fading it would remove exactly the information the picture is for.
 *
 * Fading the ground towards itself is a no-op by definition; it is written out rather than special
 * cased so that a future change of the mixing target keeps working without a second edit here.
 * @param colors Surface colours of the active scheme.
 * @param keep Share of the original colour that survives, 0..1 (see {@link getSelectionFadeFactor}).
 * @returns A new colour set; the input is not modified.
 */
export function fadeSurfaceColors(colors: MapSurfaceColors, keep: number): MapSurfaceColors {
	return {
		floor: fadeHexTowards(colors.floor, colors.floor, keep),
		obstacle: fadeHexTowards(colors.obstacle, colors.floor, keep),
		path: colors.path,
	};
}
