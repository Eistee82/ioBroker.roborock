import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { DockPanel } from "./DockPanel";
import { DOCK_COMMAND_PAIRS } from "../engine/robotStates";
import type { DockActivity, DockControlModel, DockModel, RobotPhase } from "../engine/types";

/**
 * Which half of each Start/Stop pair the dock panel offers.
 *
 * The adapter publishes `app_start_wash` and `app_stop_wash` as two independent buttons and says
 * nothing about them belonging together; only `DOCK_COMMAND_PAIRS` knows that. The panel keeps
 * one of the two, and getting it backwards would offer "Stop washing" to a station that is idle
 * and "Start washing" to one that is already running - both do nothing, and neither looks broken.
 *
 * The panel starts collapsed, so the tests open it before looking for the buttons.
 */

/** One button control, named the way the adapter publishes it. */
function button(command: string, label: string): DockControlModel {
	return { command, label, kind: "button", options: [], value: null };
}

/** Both pairs plus one command that belongs to no pair and must survive untouched. */
const CONTROLS: DockControlModel[] = [
	button("app_start_wash", "Start washing"),
	button("app_stop_wash", "Stop washing"),
	button("app_start_collect_dust", "Start dust collection"),
	button("app_stop_collect_dust", "Stop dust collection"),
	button("app_set_dryer_status", "Start drying"),
];

const DOCK: DockModel = {
	controls: CONTROLS,
	status: [{ stateId: "dock.error", name: "Dock error", text: "0" }],
	faulty: false,
};

/** Renders the panel and expands it, since everything under test lives in the collapsed part. */
function renderPanel(dockActivity: DockActivity, phase: RobotPhase = "docked", dock: DockModel = DOCK) {
	const onCommand = vi.fn();
	const { unmount } = render(
		<DockPanel
			dock={dock}
			phase={phase}
			dockActivity={dockActivity}
			onCommand={onCommand}
		/>,
	);
	fireEvent.click(screen.getByText(I18n.t("ui_dock_panel")));
	return { onCommand, unmount };
}

/** Labels of the command buttons, ignoring the panel's own expand control. */
function commandLabels(): string[] {
	return screen
		.getAllByRole("button")
		.map(element => element.textContent?.trim() ?? "")
		.filter(label => label.length > 0);
}

describe("DockPanel start/stop suppression", () => {
	it("offers both Start buttons while the station is idle", () => {
		renderPanel(null);
		const labels = commandLabels();
		expect(labels).toContain("Start washing");
		expect(labels).toContain("Start dust collection");
		expect(labels).not.toContain("Stop washing");
		expect(labels).not.toContain("Stop dust collection");
	});

	it("replaces Start with Stop for the washing cycle while it runs", () => {
		renderPanel("washing");
		const labels = commandLabels();
		expect(labels).toContain("Stop washing");
		expect(labels).not.toContain("Start washing");
		// The other pair is unaffected: dust collection is not running.
		expect(labels).toContain("Start dust collection");
		expect(labels).not.toContain("Stop dust collection");
	});

	it("replaces Start with Stop for dust collection while it runs", () => {
		renderPanel("emptying");
		const labels = commandLabels();
		expect(labels).toContain("Stop dust collection");
		expect(labels).not.toContain("Start dust collection");
		expect(labels).toContain("Start washing");
		expect(labels).not.toContain("Stop washing");
	});

	it("suppresses exactly one half of every pair, whatever the station is doing", () => {
		for (const activity of [null, "washing", "emptying"] as DockActivity[]) {
			const { unmount } = renderPanel(activity);
			const labels = commandLabels();
			for (const [job, pair] of Object.entries(DOCK_COMMAND_PAIRS)) {
				const start = CONTROLS.find(control => control.command === pair.start)?.label as string;
				const stop = CONTROLS.find(control => control.command === pair.stop)?.label as string;
				const shown = [start, stop].filter(label => labels.includes(label));
				expect(shown, `${job} while ${String(activity)}`).toHaveLength(1);
				expect(shown[0], `${job} while ${String(activity)}`).toBe(activity === job ? stop : start);
			}
			unmount();
		}
	});

	it("leaves a button that belongs to no known pair alone", () => {
		// Guessing a pairing from the command name would break the moment a model publishes
		// something new, so drying must show up under every activity.
		for (const activity of [null, "washing", "emptying"] as DockActivity[]) {
			const { unmount } = renderPanel(activity);
			expect(commandLabels(), `while ${String(activity)}`).toContain("Start drying");
			unmount();
		}
	});

	it("sends the command of the button that is actually shown", () => {
		const { onCommand } = renderPanel("washing");
		fireEvent.click(screen.getByRole("button", { name: "Stop washing" }));
		expect(onCommand).toHaveBeenCalledWith("app_stop_wash", true);
	});
});

describe("DockPanel availability", () => {
	it("disables the station buttons while the robot is not in its dock", () => {
		for (const phase of ["cleaning", "paused", "returning"] as RobotPhase[]) {
			const { unmount } = renderPanel(null, phase);
			expect(screen.getByRole("button", { name: "Start washing" }).hasAttribute("disabled"), phase).toBe(true);
			unmount();
		}
	});

	it("keeps them enabled while the robot is docked, idle or in an unknown phase", () => {
		// An unknown phase must not take a working control away; the robot rejecting a command is
		// the smaller harm than a dead panel.
		for (const phase of ["docked", "idle", "unknown"] as RobotPhase[]) {
			const { unmount } = renderPanel(null, phase);
			expect(screen.getByRole("button", { name: "Start washing" }).hasAttribute("disabled"), phase).toBe(false);
			unmount();
		}
	});

	it("renders nothing at all when the device published neither controls nor status", () => {
		const { container } = render(
			<DockPanel
				dock={{ controls: [], status: [], faulty: false }}
				phase="docked"
				dockActivity={null}
				onCommand={vi.fn()}
			/>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("flags a station fault on the collapsed summary line", () => {
		// A collapsed panel would otherwise hide it.
		render(
			<DockPanel
				dock={{ ...DOCK, faulty: true }}
				phase="docked"
				dockActivity={null}
				onCommand={vi.fn()}
			/>,
		);
		expect(screen.getByText(I18n.t("ui_error"))).toBeTruthy();
	});

	it("says so instead of showing an empty list when there is no station status", () => {
		renderPanel(null, "docked", { ...DOCK, status: [] });
		expect(screen.getByText(I18n.t("ui_dock_no_status"))).toBeTruthy();
	});
});
