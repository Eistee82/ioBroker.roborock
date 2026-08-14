import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveTrackLegend } from "./LiveTrackLegend";
import { LIVE_TRACK_COLORS } from "../engine/liveTrack";

/**
 * The colour key.
 *
 * Two things have gone wrong in this tab before and both are cheap to pin here: a translation key
 * that was never added shows the user the raw key, and a colour typed a second time drifts away
 * from the map without anything complaining. The test setup loads the real `admin/i18n/en.json`,
 * so a missing key fails here instead of shipping.
 */

describe("LiveTrackLegend", () => {
	it("names both track kinds in words the user can read", () => {
		render(<LiveTrackLegend present />);

		expect(screen.getByText("Live track")).toBeTruthy();
		expect(screen.getByText("Driven")).toBeTruthy();
		expect(screen.getByText("Mopped")).toBeTruthy();
	});

	it("shows the very colours the map paints with", () => {
		const { container } = render(<LiveTrackLegend present />);
		const swatches = Array.from(container.querySelectorAll("[aria-hidden]")) as HTMLElement[];

		const colors = swatches.map(swatch => swatch.style.backgroundColor);
		expect(colors).toHaveLength(2);
		expect(colors[0]).toBe(hexToRgb(LIVE_TRACK_COLORS.driven));
		expect(colors[1]).toBe(hexToRgb(LIVE_TRACK_COLORS.mopped));
	});

	it("stays away while there is no track to explain", () => {
		const { container } = render(<LiveTrackLegend present={false} />);
		expect(container.firstChild).toBeNull();
	});
});

/**
 * The DOM reports a colour as `rgb(...)` no matter how it was written.
 * @param hex Colour as the constant spells it.
 * @returns The same colour in the notation `style.backgroundColor` returns.
 */
function hexToRgb(hex: string): string {
	const value = parseInt(hex.slice(1), 16);
	return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}
