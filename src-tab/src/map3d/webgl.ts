/**
 * Whether this browser can draw the 3D view at all.
 *
 * The admin is opened from tablets, from kiosk browsers and from Chromium in containers without GPU
 * access. In those, WebGL is missing or falls back to a software rasteriser, and a canvas that
 * cannot get a context renders as a black rectangle - which looks exactly like a broken adapter.
 * `_appanalysis/21-3d-kartenansicht.md` §8.2 names this as the one real caveat of the whole idea.
 *
 * So the toggle asks first and simply stays in 2D when the answer is no.
 */

/** Remembered answer; creating a context is not free and the answer cannot change mid-session. */
let cached: boolean | null = null;

/**
 * Asks the browser for a WebGL context and gives it straight back.
 *
 * Deliberately tries `webgl2` **and** `webgl`: three.js needs WebGL2 for its current renderer, but
 * a browser that offers only WebGL1 still says something useful - it says the machine is not
 * hopeless, and the honest failure then happens later, in the renderer, where it is caught too.
 * Erring towards "yes" here would be wrong; erring towards "no" only costs a view nobody could
 * have used.
 *
 * @returns Whether a context could be created.
 */
export function isWebGLAvailable(): boolean {
	if (cached !== null) return cached;

	try {
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
		if (!context) {
			cached = false;
			return cached;
		}

		// Hand the context back at once. A browser allows only a handful of live contexts, and this
		// one exists purely to answer a question.
		const lose = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context");
		lose?.loseContext();

		cached = true;
	} catch {
		// A browser that throws while being asked for a canvas context cannot draw the view either.
		cached = false;
	}

	return cached;
}

/** Forgets the cached answer. Tests only; nothing in the running tab needs it. */
export function resetWebGLCache(): void {
	cached = null;
}
