import { afterEach, describe, expect, it, vi } from "vitest";
import { isWebGLAvailable, resetWebGLCache } from "./webgl";

/**
 * Whether the browser can draw the 3D view.
 *
 * The failure this prevents is specific: a canvas that cannot get a context renders as a black
 * rectangle, which looks exactly like a broken adapter rather than like a missing feature. So the
 * toggle asks first, and a "no" simply keeps the 2D view - see `_appanalysis/21-3d-kartenansicht.md`
 * §8.2, which names this as the one real caveat of the whole idea.
 */

afterEach(() => {
	resetWebGLCache();
	vi.restoreAllMocks();
});

describe("asking for WebGL", () => {
	it("says yes when a context comes back", () => {
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			getExtension: () => ({ loseContext: () => undefined })
		} as unknown as RenderingContext);

		expect(isWebGLAvailable()).toBe(true);
	});

	it("says no when the browser has none", () => {
		// jsdom itself answers null, which is the case this has to survive - and the case a kiosk
		// browser without GPU access presents.
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

		expect(isWebGLAvailable()).toBe(false);
	});

	it("says no rather than throwing when asking itself fails", () => {
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
			throw new Error("no GPU process");
		});

		expect(isWebGLAvailable()).toBe(false);
	});

	it("asks once and remembers", () => {
		// Contexts are a scarce resource - a browser allows only a handful - and the answer cannot
		// change while the page is open.
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			getExtension: () => null
		} as unknown as RenderingContext);

		isWebGLAvailable();
		isWebGLAvailable();
		isWebGLAvailable();

		expect(getContext).toHaveBeenCalledTimes(1);
	});

	it("hands the context straight back", () => {
		// It exists only to answer a question; holding it would use up one of the few the browser
		// grants, and the real renderer needs one right after.
		const loseContext = vi.fn();
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null)
		} as unknown as RenderingContext);

		isWebGLAvailable();
		expect(loseContext).toHaveBeenCalled();
	});
});
