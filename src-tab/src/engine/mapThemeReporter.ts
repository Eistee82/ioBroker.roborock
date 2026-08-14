/** Theme names the adapter accepts for the map bitmap. */
export type MapThemeName = "light" | "dark";

/**
 * Keeps the adapter informed about the theme this browser shows - and only that.
 *
 * The map is a PNG the adapter paints, so a dark admin cannot recolour it from here; the browser
 * has to say what it sees. `App` recomputes its theme on every render, which would mean a message
 * per render, so the reporting is funnelled through this gate.
 *
 * Reporting **only on change** is not just economy. There is one rendered image per robot, so two
 * browsers in different themes cannot both be served: whoever reports last decides. Because each
 * of them falls silent after its own change, that settles instead of turning into a picture that
 * flips back and forth for as long as both tabs are open.
 * @param send Delivers the theme to the adapter.
 * @returns A function to call with the current mode; true when it actually sent something.
 */
export function createMapThemeReporter(send: (theme: MapThemeName) => void): (mode: MapThemeName) => boolean {
	let reported: MapThemeName | null = null;

	return (mode: MapThemeName): boolean => {
		if (mode === reported) {
			return false;
		}
		reported = mode;
		send(mode);
		return true;
	};
}
