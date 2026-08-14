import { describe, expect, it } from "vitest";
import { isDarkColour, themeFromName, themeFromQuery } from "./adminTheme";

/**
 * Resolving the admin's theme, pinned at the point where it went wrong three times.
 *
 * The failure was never in the evaluation but in the source: measured on a real installation,
 * admin 7.0.25 with dark mode switched on stored `App.themeName` as `light`, and that key is the
 * one `GenericApp` resolves the theme from. So the order of the sources is the thing worth
 * testing, and the background colour is the one that cannot be stale.
 */

describe("themeFromQuery", () => {
	it("reads the parameter the admin actually writes", () => {
		// Verbatim from AdminUtils.getHref in the admin's own source: the query it builds for a
		// tab is `?newReact=true&<instance>&react=<themeType>`. The name is `react`, and looking
		// for `theme` instead is why three attempts at this found nothing.
		expect(themeFromQuery("?newReact=true&0&react=dark")).toBe("dark");
		expect(themeFromQuery("?newReact=true&0&react=light")).toBe("light");
	});

	it("prefers the admin's own name over the other spellings", () => {
		expect(themeFromQuery("?react=dark&theme=light")).toBe("dark");
	});

	it("accepts the other spellings too, in case the name changes", () => {
		expect(themeFromQuery("?theme=dark")).toBe("dark");
		expect(themeFromQuery("?themeName=dark")).toBe("dark");
		expect(themeFromQuery("?themeType=dark")).toBe("dark");
	});

	it("treats blue as a dark theme, because it is one", () => {
		expect(themeFromQuery("?theme=blue")).toBe("dark");
	});

	it.each([[""], ["?instance=0"], ["?theme=auto"], ["?theme="]])("answers null for %s", search => {
		expect(themeFromQuery(search)).toBeNull();
	});
});

describe("themeFromName", () => {
	it("maps the admin's names onto the two modes", () => {
		expect(themeFromName("dark")).toBe("dark");
		expect(themeFromName("blue")).toBe("dark");
		expect(themeFromName("light")).toBe("light");
		expect(themeFromName("colored")).toBe("light");
	});

	it.each([[null], [undefined], [""], ["auto"]])("answers null for %s", name => {
		expect(themeFromName(name as string)).toBeNull();
	});
});

describe("isDarkColour", () => {
	it("calls the admin's dark background dark", () => {
		expect(isDarkColour("rgb(18, 18, 18)")).toBe(true);
		expect(isDarkColour("rgb(48, 48, 48)")).toBe(true);
	});

	it("calls a light background light", () => {
		expect(isDarkColour("rgb(255, 255, 255)")).toBe(false);
		expect(isDarkColour("rgb(250, 250, 250)")).toBe(false);
	});

	it("weighs the channels by eye sensitivity, not by their sum", () => {
		// A saturated blue reads dark although its channel sum is not small; a saturated green
		// reads light. Averaging the three would get both wrong.
		expect(isDarkColour("rgb(0, 0, 200)")).toBe(true);
		expect(isDarkColour("rgb(0, 220, 0)")).toBe(false);
	});

	it("reads rgba and ignores the alpha unless it is zero", () => {
		expect(isDarkColour("rgba(20, 20, 20, 0.9)")).toBe(true);
		// Fully transparent says nothing about the page behind it.
		expect(isDarkColour("rgba(0, 0, 0, 0)")).toBeNull();
	});

	it.each([[null], [undefined], [""], ["transparent"], ["nonsense"], ["rgb(1, 2)"]])(
		"answers null for the unusable value %s",
		value => {
			expect(isDarkColour(value as string)).toBeNull();
		}
	);
});
