/**
 * Finding out which theme the surrounding ioBroker admin is showing.
 *
 * `GenericApp` resolves the mode once from `localStorage['App.themeName']` and then waits for an
 * `updateTheme` message. Measured on a real installation - admin 7.0.25 with dark mode switched
 * on - that key held `light`, so the tab drew itself light inside a dark admin and no amount of
 * fixing the *evaluation* helped: the source was wrong.
 *
 * Hence three sources, in order of how current each one is by construction:
 *
 * 1. **The query string.** The admin hands a tab its theme when it opens it. `GenericApp` parses
 *    the same query but keeps only `instance` and `newReact`, so this value is dropped - which is
 *    why the classic HTML tabs of other adapters follow the dark mode and this one did not.
 * 2. **The stored key**, in the surrounding window first: that is the admin's own document, and a
 *    tab loaded from `/adapter/<name>/tab.html` shares its origin.
 * 3. **The admin's background colour.** It cannot be out of date, because it is what the user is
 *    actually looking at. This is what catches the case above, where every stored value lies.
 *
 * Every step is guarded on its own: reading across frames throws on a foreign origin, and a tab
 * must not go blank over a colour.
 */

/** What the admin calls its themes. `blue` is a dark one despite its name. */
const DARK_THEME_NAMES = new Set(["dark", "blue"]);

/**
 * Reads a theme name out of a query string.
 *
 * @param search The query string, including or without the leading `?`.
 * @returns `"dark"`, `"light"`, or null when the query names no theme.
 */
export function themeFromQuery(search: string): "dark" | "light" | null {
	try {
		const params = new URLSearchParams(search);
		// `react` is the one the admin actually writes. From its own source, AdminUtils.getHref:
		//
		//     href += `?newReact=true&${instanceNumber}&react=${themeType}`
		//
		// `GenericApp` parses this very query but keeps only `instance` and `newReact` - the theme
		// beside them is dropped, which is why the classic HTML tabs of other adapters follow the
		// dark mode and a GenericApp tab does not. The other spellings are accepted as well
		// because nothing guarantees the name stays; the admin's own is checked first.
		const name =
			params.get("react") ?? params.get("theme") ?? params.get("themeName") ?? params.get("themeType");
		if (!name || name === "auto") return null;
		return DARK_THEME_NAMES.has(name) ? "dark" : "light";
	} catch {
		return null;
	}
}

/**
 * Turns a theme name into the mode it stands for.
 *
 * @param name Value of `App.themeName`, or anything at all.
 * @returns `"dark"`, `"light"`, or null when the name says nothing usable.
 */
export function themeFromName(name: string | null | undefined): "dark" | "light" | null {
	if (!name || name === "auto") return null;
	return DARK_THEME_NAMES.has(name) ? "dark" : "light";
}

/**
 * Decides whether a CSS colour is a dark one.
 *
 * @param colour Value as `getComputedStyle` returns it, i.e. `rgb(...)` or `rgba(...)`.
 * @returns True for dark, false for light, null when the value carries no usable colour - a fully
 *          transparent background says nothing about the page behind it.
 */
export function isDarkColour(colour: string | null | undefined): boolean | null {
	if (!colour) return null;
	const parts = colour.match(/[\d.]+/g);
	if (!parts || parts.length < 3) return null;

	const [r, g, b] = parts.slice(0, 3).map(Number);
	const alpha = parts.length > 3 ? Number(parts[3]) : 1;
	if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || alpha === 0) return null;

	// Rec. 601 luma: green weighs heaviest because the eye is most sensitive to it, so a dark blue
	// and a dark green are both recognised as dark rather than only the neutral greys.
	return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
