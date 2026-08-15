import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { ActionDock, startIntent } from "./ActionDock";
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
		onStart: vi.fn(),
		onResume: vi.fn(),
		onPause: vi.fn(),
		onStop: vi.fn(),
		onDock: vi.fn(),
		onToggleGoTo: vi.fn(),
		onAddZone: vi.fn(),
		onCleanRooms: vi.fn(),
		onClearRooms: vi.fn(),
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

	it("sends Resume on its own callback, not on the one that starts a run", () => {
		// These were the same callback until the app's own dispatch was read: continuing a paused
		// zone or segment run needs `resume_zoned_clean` / `resume_segment_clean`, and only a paused
		// whole-flat run is continued with `app_start` (A65:421454-421600). Which one it is depends
		// on the robot's `in_cleaning`, which the dock does not know - so the engine decides, and
		// the dock has to hand it a separate press to decide about.
		const { props } = renderDock("paused");
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_resume") }));
		expect(props.onResume).toHaveBeenCalledTimes(1);
		expect(props.onStart).not.toHaveBeenCalled();
	});
});

/**
 * The run button names its job.
 *
 * This is the one place in the tab where a wrong label sends the robot somewhere else than the
 * user read: "Start" used to mean "everything" while a separate button cleaned the selected rooms,
 * and the engine quietly turned Start into a zoned run as soon as a rectangle was on the map. Now
 * the label and the callback are decided together, so a test that pins the label also pins the
 * command.
 */
describe("ActionDock start button", () => {
	it("says plain Start while nothing is picked and nothing is drawn", () => {
		const { props } = renderDock("idle", { rooms: { selected: 0, available: 3 }, zones: { count: 0, max: 5, atLimit: false } });
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_start") }));
		expect(props.onStart).toHaveBeenCalledTimes(1);
		expect(props.onCleanRooms).not.toHaveBeenCalled();
	});

	it("names the room run and starts the segment clean once rooms are picked", () => {
		const { props } = renderDock("idle", { rooms: { selected: 2, available: 4 } });
		expect(screen.queryByRole("button", { name: I18n.t("ui_start") })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_start_rooms") }));
		expect(props.onCleanRooms).toHaveBeenCalledTimes(1);
		expect(props.onStart).not.toHaveBeenCalled();
	});

	it("names the zone run and starts it through the engine once a zone is drawn", () => {
		// `MapEngine.start` picks `app_zoned_clean` by itself whenever a zone exists.
		const { props } = renderDock("idle", { zones: { count: 1, max: 5, atLimit: false } });
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_start_zones") }));
		expect(props.onStart).toHaveBeenCalledTimes(1);
		expect(props.onCleanRooms).not.toHaveBeenCalled();
	});

	it("follows the engine and cleans the zones when rooms are picked as well", () => {
		// Documented in `startIntent`: there is one RPC per run, and the engine already decides for
		// the zones. A label promising a room run while the engine cleans zones would be a lie.
		const { props } = renderDock("idle", {
			rooms: { selected: 3, available: 4 },
			zones: { count: 2, max: 5, atLimit: false },
		});
		expect(screen.queryByRole("button", { name: I18n.t("ui_start_rooms") })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_start_zones") }));
		expect(props.onStart).toHaveBeenCalledTimes(1);
		expect(props.onCleanRooms).not.toHaveBeenCalled();
	});

	it("keeps calling the resumed run Resume, whatever is picked or drawn", () => {
		// Resume continues the run the robot is already in; it was started with what was drawn then.
		const { props } = renderDock("paused", {
			rooms: { selected: 1, available: 4 },
			zones: { count: 1, max: 5, atLimit: false },
		});
		expect(screen.queryByRole("button", { name: I18n.t("ui_start_zones") })).toBeNull();
		expect(screen.queryByRole("button", { name: I18n.t("ui_start_rooms") })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_resume") }));
		expect(props.onResume).toHaveBeenCalledTimes(1);
		expect(props.onStart).not.toHaveBeenCalled();
		expect(props.onCleanRooms).not.toHaveBeenCalled();
	});

	it("offers exactly one run button in every phase and selection", () => {
		const labels = [I18n.t("ui_start"), I18n.t("ui_start_rooms"), I18n.t("ui_start_zones"), I18n.t("ui_resume")];
		const selections = [
			{ rooms: { selected: 0, available: 0 }, zones: { count: 0, max: 5, atLimit: false } },
			{ rooms: { selected: 2, available: 4 }, zones: { count: 0, max: 5, atLimit: false } },
			{ rooms: { selected: 0, available: 4 }, zones: { count: 1, max: 5, atLimit: false } },
			{ rooms: { selected: 2, available: 4 }, zones: { count: 1, max: 5, atLimit: false } },
		];
		for (const phase of ALL_PHASES) {
			for (const selection of selections) {
				const { unmount } = renderDock(phase, selection);
				const present = labels.filter(label => screen.queryByRole("button", { name: label }) !== null);
				// "cleaning" and "returning" offer none of them - that is the phase table, not this rule.
				expect(present.length, `phase ${phase} / ${JSON.stringify(selection)}`).toBeLessThanOrEqual(1);
				unmount();
			}
		}
	});

	it("decides label and command from the same rule", () => {
		expect(startIntent({ selected: 0, available: 0 }, { count: 0, max: 5, atLimit: false })).toEqual({
			labelKey: "ui_start",
			target: "all",
		});
		expect(startIntent({ selected: 1, available: 3 }, { count: 0, max: 5, atLimit: false })).toEqual({
			labelKey: "ui_start_rooms",
			target: "rooms",
		});
		expect(startIntent({ selected: 0, available: 3 }, { count: 1, max: 5, atLimit: false })).toEqual({
			labelKey: "ui_start_zones",
			target: "zones",
		});
		expect(startIntent({ selected: 4, available: 4 }, { count: 5, max: 5, atLimit: true })).toEqual({
			labelKey: "ui_start_zones",
			target: "zones",
		});
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
			});
			for (const name of buttonNames()) {
				expect(name.trim().length, `phase ${phase}`).toBeGreaterThan(0);
				expect(name, `phase ${phase}`).not.toMatch(/^ui_[a-z_]+$/);
			}
			unmount();
		}
	});

	it("translates the two run labels in every language the adapter ships", () => {
		// A key that exists only in English reaches a German admin as "ui_start_rooms".
		for (const language of ["en", "de"]) {
			I18n.setLanguage(language);
			try {
				expect(I18n.t("ui_start_rooms"), language).not.toMatch(/^ui_/);
				expect(I18n.t("ui_start_zones"), language).not.toMatch(/^ui_/);
			} finally {
				I18n.setLanguage("en");
			}
		}
		I18n.setLanguage("de");
		try {
			expect(I18n.t("ui_start_rooms")).toBe("Start Raumreinigung");
			expect(I18n.t("ui_start_zones")).toBe("Start Zonenreinigung");
		} finally {
			I18n.setLanguage("en");
		}
	});

	it("carries no explanatory line any more", () => {
		// The hint under the controls is gone; the map itself shows what is selected. What is left
		// must not fall back to a stale translation key either.
		const { unmount } = renderDock("idle", { rooms: { selected: 0, available: 3 } });
		expect(document.body.textContent).not.toMatch(/ui_[a-z_]+/);
		expect(document.body.textContent).not.toContain("Click a room name");
		unmount();

		renderDock("idle", { rooms: { selected: 2, available: 3 } });
		expect(document.body.textContent).not.toMatch(/Selected:/);
	});
});

describe("ActionDock secondary controls", () => {
	it("no longer offers a separate button for the selected rooms", () => {
		// The run button took that over; two buttons for one intent was one too many.
		renderDock("idle", { rooms: { selected: 2, available: 3 } });
		expect(screen.queryByRole("button", { name: /Clean selected rooms/ })).toBeNull();
	});

	it("disables clearing the selection while nothing is selected", () => {
		const { unmount } = renderDock("idle", { rooms: { selected: 0, available: 3 } });
		expect(screen.getByRole("button", { name: I18n.t("ui_clear_selection") }).hasAttribute("disabled")).toBe(true);
		unmount();

		renderDock("idle", { rooms: { selected: 1, available: 3 } });
		expect(screen.getByRole("button", { name: I18n.t("ui_clear_selection") }).hasAttribute("disabled")).toBe(false);
	});

	it("blocks adding a zone once the limit is reached", () => {
		renderDock("idle", { zones: { count: 5, max: 5, atLimit: true } });
		expect(screen.getByRole("button", { name: I18n.t("ui_add_zone") }).hasAttribute("disabled")).toBe(true);
	});

	it("offers no remove button at all - the zone carries its own delete handle", () => {
		// The dock's button always removed the zone added last, which cannot say which zone it
		// means. The handle on the rectangle can, so the ambiguous one is gone.
		renderDock("idle", { zones: { count: 3, max: 5, atLimit: false } });
		expect(screen.queryByRole("button", { name: I18n.t("ui_remove_zone") })).toBeNull();
	});

	it("switches the go-to control between starting and cancelling", () => {
		const { unmount } = renderDock("idle", { goToActive: true });
		expect(screen.getByRole("button", { name: I18n.t("ui_cancel") })).toBeTruthy();
		expect(screen.queryByRole("button", { name: I18n.t("ui_goto") })).toBeNull();
		unmount();

		renderDock("idle", { goToActive: false });
		expect(screen.getByRole("button", { name: I18n.t("ui_goto") })).toBeTruthy();
	});

	it("has handed the view reset over to the status strip", () => {
		// It changes what is shown, not what the robot does; see `StatusStrip`.
		for (const phase of ALL_PHASES) {
			const { unmount } = renderDock(phase);
			expect(screen.queryByRole("button", { name: I18n.t("ui_reset_view") }), `phase ${phase}`).toBeNull();
			unmount();
		}
	});
});
