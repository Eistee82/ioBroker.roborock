import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { SettingsPanel } from "./SettingsPanel";
import type { ChoiceSetting, RobotSettingsModel, SwitchSetting, TimeWindowSetting } from "../settings/robotSettings";

/**
 * The settings panel.
 *
 * These controls send commands to the robot, so the tests care most about what leaves the panel:
 * that a switch really writes both of its positions, that switching Do Not Disturb on sends its
 * window, and that editing a time while the mode is off sends nothing. What is written is decided
 * in `settings/robotSettings.ts` and pinned there; here it is the wiring.
 */

function switchSetting(over: Partial<SwitchSetting> = {}): SwitchSetting {
	return {
		kind: "switch",
		command: "set_child_lock_status",
		folder: "settings",
		label: "Child Lock",
		description: "",
		value: false,
		...over,
	};
}

function windowSetting(over: Partial<TimeWindowSetting> = {}): TimeWindowSetting {
	return {
		kind: "timeWindow",
		command: "set_dnd_timer",
		offCommand: "close_dnd_timer",
		folder: "settings",
		label: "Do Not Disturb Mode",
		description: "",
		enabled: true,
		start: "22:00",
		end: "07:00",
		...over,
	};
}

function choiceSetting(over: Partial<ChoiceSetting> = {}): ChoiceSetting {
	return {
		kind: "choice",
		command: "set_dust_collection_mode",
		folder: "settings",
		label: "Empty Mode",
		description: "",
		value: 2,
		options: [
			{ value: 0, label: "Smart" },
			{ value: 1, label: "Light" },
			{ value: 2, label: "Balanced" },
			{ value: 4, label: "Max" },
		],
		...over,
	};
}

function renderPanel(model: RobotSettingsModel | null) {
	const onWrite = vi.fn();
	render(
		<SettingsPanel
			settings={model}
			onWrite={onWrite}
		/>,
	);
	return { onWrite };
}

function expand(): void {
	fireEvent.click(screen.getByText(I18n.t("ui_settings")));
}

describe("SettingsPanel", () => {
	it("stays away for a robot that has none of these settings", () => {
		renderPanel(null);
		expect(screen.queryByText(I18n.t("ui_settings"))).toBeNull();

		renderPanel({ entries: [] });
		expect(screen.queryByText(I18n.t("ui_settings"))).toBeNull();
	});

	it("labels each control with the name the adapter published", () => {
		renderPanel({ entries: [windowSetting(), switchSetting()] });
		expand();
		expect(screen.getByText("Do Not Disturb Mode")).toBeTruthy();
		expect(screen.getByText("Child Lock")).toBeTruthy();
	});

	it("writes both positions of a switch", () => {
		const { onWrite } = renderPanel({ entries: [switchSetting({ value: false })] });
		expand();

		fireEvent.click(screen.getByRole("checkbox", { name: "Child Lock" }));
		expect(onWrite).toHaveBeenCalledWith({ folder: "settings", command: "set_child_lock_status", value: true });
	});

	it("switches the child lock off again, which is the whole point of it being a switch", () => {
		const { onWrite } = renderPanel({ entries: [switchSetting({ value: true })] });
		expand();

		fireEvent.click(screen.getByRole("checkbox", { name: "Child Lock" }));
		expect(onWrite).toHaveBeenCalledWith({ folder: "settings", command: "set_child_lock_status", value: false });
	});

	it("shows the window the robot reports", () => {
		renderPanel({ entries: [windowSetting()] });
		expand();

		expect(screen.getByLabelText(I18n.t("ui_settings_from"))).toHaveProperty("value", "22:00");
		expect(screen.getByLabelText(I18n.t("ui_settings_to"))).toHaveProperty("value", "07:00");
	});

	it("sends the window when the mode is switched on", () => {
		const { onWrite } = renderPanel({ entries: [windowSetting({ enabled: false })] });
		expand();

		fireEvent.click(screen.getByRole("checkbox", { name: "Do Not Disturb Mode" }));
		expect(onWrite).toHaveBeenCalledWith({ folder: "settings", command: "set_dnd_timer", value: "22:00-07:00" });
	});

	it("presses the off command when the mode is switched off", () => {
		const { onWrite } = renderPanel({ entries: [windowSetting({ enabled: true })] });
		expand();

		fireEvent.click(screen.getByRole("checkbox", { name: "Do Not Disturb Mode" }));
		expect(onWrite).toHaveBeenCalledWith({ folder: "settings", command: "close_dnd_timer", value: true });
	});

	it("rewrites the window when a time is changed while the mode is on", () => {
		const { onWrite } = renderPanel({ entries: [windowSetting({ enabled: true })] });
		expand();

		const from = screen.getByLabelText(I18n.t("ui_settings_from"));
		fireEvent.change(from, { target: { value: "23:15" } });
		fireEvent.blur(from);

		expect(onWrite).toHaveBeenCalledWith({ folder: "settings", command: "set_dnd_timer", value: "23:15-07:00" });
	});

	it("sends nothing when a time is changed while the mode is off", () => {
		// Writing the window is what switches the mode on, so an edit must not do it by itself.
		const { onWrite } = renderPanel({ entries: [windowSetting({ enabled: false })] });
		expand();

		const from = screen.getByLabelText(I18n.t("ui_settings_from"));
		fireEvent.change(from, { target: { value: "23:15" } });
		fireEvent.blur(from);

		expect(onWrite).not.toHaveBeenCalled();
	});

	it("says that a time edited while the mode is off is kept for later", () => {
		renderPanel({ entries: [windowSetting({ enabled: false })] });
		expand();
		expect(screen.getByText(I18n.t("ui_settings_dnd_off_hint"))).toBeTruthy();
	});

	it("cannot be switched on without a window to send", () => {
		renderPanel({ entries: [windowSetting({ enabled: false, start: null, end: null })] });
		expand();
		expect(screen.getByRole("checkbox", { name: "Do Not Disturb Mode" })).toHaveProperty("disabled", true);
	});

	it("sends nothing at all while typing, only when the field is left", () => {
		const { onWrite } = renderPanel({ entries: [windowSetting({ enabled: true })] });
		expand();

		fireEvent.change(screen.getByLabelText(I18n.t("ui_settings_from")), { target: { value: "23:15" } });
		expect(onWrite).not.toHaveBeenCalled();
	});

	it("shows a choice with the positions the adapter published", () => {
		renderPanel({ entries: [choiceSetting()] });
		expand();
		expect(screen.getByText("Balanced")).toBeTruthy();
	});

	it("leaves a choice empty while the robot has not reported its position", () => {
		renderPanel({ entries: [choiceSetting({ value: null })] });
		expand();
		// Nothing invented: no position is displayed, rather than the first one.
		expect(screen.queryByText("Smart")).toBeNull();
		expect(screen.queryByText("Balanced")).toBeNull();
	});

	it("writes the position that was picked", () => {
		const { onWrite } = renderPanel({ entries: [choiceSetting()] });
		expand();

		fireEvent.mouseDown(screen.getByRole("combobox", { name: "Empty Mode" }));
		fireEvent.click(screen.getByRole("option", { name: "Max" }));

		expect(onWrite).toHaveBeenCalledWith({ folder: "settings", command: "set_dust_collection_mode", value: 4 });
	});
});
