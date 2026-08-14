import { describe, expect, it, vi } from "vitest";
import { createMapThemeReporter } from "./mapThemeReporter";

describe("createMapThemeReporter", () => {
	it("reports the first theme it sees", () => {
		const send = vi.fn();
		const report = createMapThemeReporter(send);

		expect(report("dark")).toBe(true);
		expect(send).toHaveBeenCalledWith("dark");
	});

	it("stays quiet while the theme does not change", () => {
		const send = vi.fn();
		const report = createMapThemeReporter(send);

		report("light");
		// `App` recomputes its theme on every render, so this is the common case by far.
		for (let i = 0; i < 20; i++) {
			expect(report("light")).toBe(false);
		}
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("reports again on every real switch", () => {
		const send = vi.fn();
		const report = createMapThemeReporter(send);

		report("light");
		report("dark");
		report("dark");
		report("light");

		expect(send.mock.calls.map((c) => c[0])).toEqual(["light", "dark", "light"]);
	});

	it("gives two tabs in different themes a bounded exchange, not a loop", () => {
		// Each tab has its own reporter. Two browsers open in opposite themes therefore write once
		// each while opening and then fall silent - the map settles on the later one instead of
		// flipping for as long as both stay open.
		const sent: string[] = [];
		const tabA = createMapThemeReporter((t) => sent.push(`A:${t}`));
		const tabB = createMapThemeReporter((t) => sent.push(`B:${t}`));

		tabA("dark");
		tabB("light");
		// Both keep rendering; neither says anything more.
		for (let i = 0; i < 10; i++) {
			tabA("dark");
			tabB("light");
		}

		expect(sent).toEqual(["A:dark", "B:light"]);
	});
});
