import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { ActionDock } from "./ActionDock";
import type { RobotPhase } from "../engine/types";

/**
 * The action bar, checked for what it *offers*, not for how it looks.
 *
 * Two things have gone wrong here before and neither was a pixel problem:
 *
 *  - a control silently disappeared for a phase nobody had thought about, leaving the user with
 *    no way to reach the robot,
 *  - a label came out empty or truncated, so a button said nothing.
 *
 * Both are visible in the rendered accessibility tree, so that is what these tests read.
 */

type ActionDockProps = Parameters<typeof ActionDock>[0];

/** Every prop is required, so each test only states the part it is actually about. */
function renderDock(phase: RobotPhase, overrides: Partial<ActionDockProps> = {}) {
	const props: ActionDockProps = {
		phase,
		goToActive: false,
		rooms: { selected: 0, available: 3 },
		zones: { count: 0, max: 5, atLimit: false },
		cleanCount: 1,
		onStart: vi.fn(),
		onPause: vi.fn(),
		onStop: vi.fn(),
		onDock: vi.fn(),
		onToggleGoTo: vi.fn(),
		onAddZone: vi.fn(),
		onRemoveZone: vi.fn(),
		onCleanCountChange: vi.fn(),
		onCleanRooms: vi.fn(),
		onClearRooms: vi.fn(),
		onResetZoom: vi.fn(),
		...overrides,
	};
	const { unmount } = render(<ActionDock {...props} />);
	return { props, unmount };
}

/** Accessible names of every button currently on screen. */
function buttonNames(): string[] {
	return screen.getAllByRole("button").map(button => button.textContent || button.getAttribute("aria-label") || "");
}

const ALL_PHASES: RobotPhase[] = ["cleaning", "paused", "returning", "docked", "idle", "unknown"];

describe("ActionDock run controls", () => {
	it("offers Pause and Stop while the robot is cleaning, and still lets the user send it home", () => {
		renderDock("cleaning");
		expect(screen.getByRole("button", { name: I18n.t("ui_pause") })).toBeTruthy();
		expect(screen.getByRole("button", { name: I18n.t("ui_stop") })).toBeTruthy();
		expect(screen.getByRole("button", { name: I18n.t("ui_dock") })).toBeTruthy();
		expect(screen.queryByRole("button", { name: I18n.t("ui_start") })).toBeNull();
	});

	it("offers Resume instead of Start while the robot is paused", () => {
		renderDock("paused");
		expect(screen.getByRole("button", { name: I18n.t("ui_resume") })).toBeTruthy();
		expect(screen.getByRole("button", { name: I18n.t("ui_stop") })).toBeTruthy();
		expect(screen.getByRole("button", { name: I18n.t("ui_dock") })).toBeTruthy();
		expect(screen.queryByRole("button", { name: I18n.t("ui_start") })).toBeNull();
		expect(screen.queryByRole("button", { name: I18n.t("ui_pause") })).toBeNull();
	});

	it("offers only Stop while the robot drives back to the station", () => {
		renderDock("returning");
		expect(screen.getByRole("button", { name: I18n.t("ui_stop") })).toBeTruthy();
		// Start would fight the drive home, and Dock is already happening.
		expect(screen.queryByRole("button", { name: I18n.t("ui_start") })).toBeNull();
		expect(screen.queryByRole("button", { name: I18n.t("ui_dock") })).toBeNull();
	});

	it("offers only Start while the robot sits in its station", () => {
		renderDock("docked");
		expect(screen.getByRole("button", { name: I18n.t("ui_start") })).toBeTruthy();
		// There is nothing to stop and nowhere to send it.
		expect(screen.queryByRole("button", { name: I18n.t("ui_stop") })).toBeNull();
		expect(screen.queryByRole("button", { name: I18n.t("ui_dock") })).toBeNull();
	});

	it("offers Start and Dock while the robot stands somewhere in the flat", () => {
		renderDock("idle");
		expect(screen.getByRole("button", { name: I18n.t("ui_start") })).toBeTruthy();
		expect(screen.getByRole("button", { name: I18n.t("ui_dock") })).toBeTruthy();
		expect(screen.queryByRole("button", { name: I18n.t("ui_stop") })).toBeNull();
	});

	it("answers an unknown phase with Start and Dock rather than with an empty bar", () => {
		// The deliberate fallback: a guess must never take a working control away.
		renderDock("unknown");
		expect(screen.getByRole("button", { name: I18n.t("ui_start") })).toBeTruthy();
		expect(screen.getByRole("button", { name: I18n.t("ui_dock") })).toBeTruthy();
	});

	it("always leaves the user at least one way to command the robot", () => {
		const run = [I18n.t("ui_start"), I18n.t("ui_resume"), I18n.t("ui_pause"), I18n.t("ui_stop")];
		for (const phase of ALL_PHASES) {
			const { unmount } = renderDock(phase, { rooms: { selected: 0, available: 0 } });
			const present = buttonNames();
			expect(
				run.some(label => present.includes(label)),
				`phase ${phase} offered ${JSON.stringify(present)}`,
			).toBe(true);
			unmount();
		}
	});

	it("wires each run control to its own callback", () => {
		const { props } = renderDock("cleaning");
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_pause") }));
		expect(props.onPause).toHaveBeenCalledTimes(1);
		expect(props.onStart).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_stop") }));
		expect(props.onStop).toHaveBeenCalledTimes(1);
	});

	it("sends Resume through the same start command the adapter expects", () => {
		const { props } = renderDock("paused");
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_resume") }));
		expect(props.onStart).toHaveBeenCalledTimes(1);
	});
});

describe("ActionDock labels", () => {
	it("labels every button with real wording instead of a raw translation key", () => {
		// `I18n.t` returns the key when `admin/i18n/en.json` has no entry, which reaches the user
		// as a button reading "ui_start". An empty label is just as unusable.
		for (const phase of ALL_PHASES) {
			const { unmount } = renderDock(phase, {
				rooms: { selected: 2, available: 4 },
				zones: { count: 1, max: 5, atLimit: false },
				cleanCount: 2,
			});
			for (const name of buttonNames()) {
				expect(name.trim().length, `phase ${phase}`).toBeGreaterThan(0);
				expect(name, `phase ${phase}`).not.toMatch(/^ui_[a-z_]+$/);
			}
			unmount();
		}
	});

	it("gives the passes selector a visible label and both of its options", () => {
		// The label used to be cut off: the field had a fixed width and the surrounding flex row
		// shrank it further, so "2 Durchgänge" no longer fitted. A test cannot see clipping, but it
		// can insist the label exists, is translated and is not squeezed out of the markup.
		renderDock("idle");
		const label = I18n.t("ui_repeat");
		expect(label).not.toBe("ui_repeat");
		// MUI renders an outlined field's label twice: the floating `<label>` and the `<legend>`
		// that cuts the notch into the border. Both have to carry the text or the notch is wrong.
		expect(screen.getAllByText(label).length).toBeGreaterThan(0);
		expect(screen.getByRole("combobox").textContent?.trim().length).toBeGreaterThan(0);
		expect(I18n.t("ui_repeat_once").trim().length).toBeGreaterThan(0);
		expect(I18n.t("ui_repeat_twice").trim().length).toBeGreaterThan(0);
	});

	it("keeps the German passes labels translated, the case the width bug came from", () => {
		I18n.setLanguage("de");
		try {
			expect(I18n.t("ui_repeat_twice")).toBe("2 Durchgänge");
			expect(I18n.t("ui_repeat")).not.toMatch(/^ui_/);
		} finally {
			I18n.setLanguage("en");
		}
	});

	it("shows the room hint instead of a blank line when nothing is selected", () => {
		renderDock("idle", { rooms: { selected: 0, available: 3 } });
		expect(screen.getByText(I18n.t("ui_rooms_hint"))).toBeTruthy();
	});

	it("says so when the map has no rooms at all", () => {
		renderDock("idle", { rooms: { selected: 0, available: 0 } });
		expect(screen.getByText(I18n.t("ui_no_rooms"))).toBeTruthy();
	});

	it("fills the %s placeholder of the selection hint with the count", () => {
		renderDock("idle", { rooms: { selected: 2, available: 4 } });
		const hint = I18n.t("ui_selected_rooms").replace("%s", "2");
		expect(hint).not.toContain("%s");
		expect(screen.getByText(hint)).toBeTruthy();
	});
});

describe("ActionDock secondary controls", () => {
	it("disables the room actions while nothing is selected and enables them afterwards", () => {
		const cleanRooms = new RegExp(I18n.t("ui_clean_rooms"));
		const { unmount } = renderDock("idle", { rooms: { selected: 0, available: 3 } });
		expect(screen.getByRole("button", { name: cleanRooms }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("button", { name: I18n.t("ui_clear_selection") }).hasAttribute("disabled")).toBe(true);
		unmount();

		renderDock("idle", { rooms: { selected: 1, available: 3 } });
		expect(screen.getByRole("button", { name: cleanRooms }).hasAttribute("disabled")).toBe(false);
	});

	it("blocks adding a zone once the limit is reached", () => {
		renderDock("idle", { zones: { count: 5, max: 5, atLimit: true } });
		expect(screen.getByRole("button", { name: I18n.t("ui_add_zone") }).hasAttribute("disabled")).toBe(true);
	});

	it("blocks removing a zone while there is none", () => {
		renderDock("idle", { zones: { count: 0, max: 5, atLimit: false } });
		expect(screen.getByRole("button", { name: I18n.t("ui_remove_zone") }).hasAttribute("disabled")).toBe(true);
	});

	it("switches the go-to control between starting and cancelling", () => {
		const { unmount } = renderDock("idle", { goToActive: true });
		expect(screen.getByRole("button", { name: I18n.t("ui_cancel") })).toBeTruthy();
		expect(screen.queryByRole("button", { name: I18n.t("ui_goto") })).toBeNull();
		unmount();

		renderDock("idle", { goToActive: false });
		expect(screen.getByRole("button", { name: I18n.t("ui_goto") })).toBeTruthy();
	});

	it("keeps the view reset reachable in every phase", () => {
		for (const phase of ALL_PHASES) {
			const { unmount } = renderDock(phase);
			expect(screen.getByRole("button", { name: I18n.t("ui_reset_view") }), `phase ${phase}`).toBeTruthy();
			unmount();
		}
	});
});
