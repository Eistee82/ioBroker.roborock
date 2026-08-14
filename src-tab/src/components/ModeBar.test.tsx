import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18n } from "@iobroker/adapter-react-v5";
import { ModeBar } from "./ModeBar";
import { FLOATING_RADIUS_PX, PANEL_PADDING_PX, floatingContentInset } from "./FloatingSurface";
import type { CleaningModeTabsModel, ModeModel } from "../engine/types";

/**
 * The switch bar, pinned where it can go wrong without throwing.
 *
 * It replaced dropdowns because these settings are chosen by their picture, and the failure modes
 * are all silent: a step that cannot be reached, a highlight on the wrong one, a click that fires
 * a command the user did not ask for. The cleaning-mode tabs on top add two more of that kind - a
 * tab that sends the wrong triple, and a step offered on a mode that forbids it.
 */

const SUCTION: ModeModel = {
	command: "set_custom_mode",
	labelKey: "ui_fan_power",
	value: "102",
	options: [
		{ value: "101", label: "Quiet" },
		{ value: "102", label: "Balanced" },
		{ value: "103", label: "Turbo" },
		{ value: "104", label: "Max" },
		{ value: "108", label: "Max+" }
	]
};

const ROUTE: ModeModel = {
	command: "set_mop_mode",
	labelKey: "ui_mop_mode",
	value: "300",
	options: [
		{ value: "300", label: "Standard" },
		{ value: "301", label: "Deep" },
		{ value: "303", label: "Deep+" },
		{ value: "304", label: "Fast" }
	]
};

const WATER: ModeModel = {
	command: "set_water_box_custom_mode",
	labelKey: "ui_water_flow",
	value: "201",
	options: [
		{ value: "200", label: "Off" },
		{ value: "201", label: "Mild" },
		{ value: "202", label: "Standard" }
	]
};

/** No cleaning modes: the device offers none, and the bar behaves exactly as it did before. */
const NO_TABS: CleaningModeTabsModel = { tabs: [], current: null };

const VAC_AND_MOP_PAYLOAD = '{"fan_power":102,"mop_mode":300,"water_box_mode":201}';
const MOP_PAYLOAD = '{"fan_power":105,"mop_mode":300,"water_box_mode":201}';
const VACUUM_PAYLOAD = '{"fan_power":102,"mop_mode":300,"water_box_mode":200}';

/** The three tabs a robot with the pure modes offers, in the app's order. */
function tabsWith(current: number | null): CleaningModeTabsModel {
	return {
		current,
		tabs: [
			{ mode: 0, payload: VAC_AND_MOP_PAYLOAD, labelKey: "ui_clean_mode_vac_and_mop" },
			{ mode: 1, payload: MOP_PAYLOAD, labelKey: "ui_clean_mode_mop" },
			{ mode: 2, payload: VACUUM_PAYLOAD, labelKey: "ui_clean_mode_vacuum" }
		]
	};
}

/** Renders with no asset folder, so every option falls back to its text. */
function renderBar(
	modes: ModeModel[],
	cleaningModes: CleaningModeTabsModel = NO_TABS,
	cleanCount = 1
): {
	onChange: ReturnType<typeof vi.fn>;
	onSelectCleaningMode: ReturnType<typeof vi.fn>;
	onCleanCountChange: ReturnType<typeof vi.fn>;
	container: HTMLElement;
	unmount: () => void;
} {
	const onChange = vi.fn();
	const onSelectCleaningMode = vi.fn();
	const onCleanCountChange = vi.fn();
	const { container, unmount } = render(
		<ModeBar
			modes={modes}
			cleaningModes={cleaningModes}
			assetBase={null}
			cleanCount={cleanCount}
			onChange={onChange}
			onSelectCleaningMode={onSelectCleaningMode}
			onCleanCountChange={onCleanCountChange}
		/>
	);
	return { onChange, onSelectCleaningMode, onCleanCountChange, container, unmount };
}

/** The buttons of one labelled group, so the tabs and the steps cannot be mixed up. */
function group(name: string): HTMLElement {
	return screen.getByRole("group", { name });
}

function pressedIn(name: string): (string | null)[] {
	return within(group(name))
		.getAllByRole("button")
		.filter(button => button.getAttribute("aria-pressed") === "true")
		.map(button => button.getAttribute("aria-label"));
}

function labelsIn(name: string): (string | null)[] {
	return within(group(name))
		.getAllByRole("button")
		.map(button => button.getAttribute("aria-label"));
}

/** The switch bars in the order they are stacked, read off their group labels. */
function rowOrder(): (string | null)[] {
	return screen.getAllByRole("group").map(element => element.getAttribute("aria-label"));
}

describe("ModeBar", () => {
	it("keeps only the passes row on a device that publishes neither modes nor steps", () => {
		// The passes are not one of the robot's commands - they travel with the zones - so they must
		// survive a device that publishes nothing, which is exactly where zone cleaning still works.
		renderBar([]);

		expect(rowOrder()).toEqual([I18n.t("ui_repeat")]);
	});

	it("shows every step at once instead of hiding them behind a click", () => {
		renderBar([SUCTION]);

		for (const option of SUCTION.options) {
			expect(screen.getByRole("button", { name: option.label })).toBeTruthy();
		}
	});

	it("marks the step in effect, and only that one", () => {
		renderBar([SUCTION]);

		expect(pressedIn("Suction power")).toEqual(["Balanced"]);
	});

	it("sends the value of the step that was clicked", () => {
		const { onChange } = renderBar([SUCTION]);

		fireEvent.click(screen.getByRole("button", { name: "Turbo" }));

		expect(onChange).toHaveBeenCalledWith("set_custom_mode", "103");
	});

	it("stays silent when the active step is clicked again", () => {
		// The toggle group reports null in that case, and the robot has no "no suction" - firing a
		// command with an empty value would be worse than doing nothing.
		const { onChange } = renderBar([SUCTION]);

		fireEvent.click(screen.getByRole("button", { name: "Balanced" }));

		expect(onChange).not.toHaveBeenCalled();
	});

	it("highlights nothing when the robot reports a value the options do not contain", () => {
		renderBar([{ ...SUCTION, value: "999" }]);

		expect(pressedIn("Suction power")).toEqual([]);
	});

	it("keeps the groups apart so two settings cannot be confused", () => {
		const { onChange } = renderBar([SUCTION, WATER]);

		fireEvent.click(screen.getByRole("button", { name: "Standard" }));

		expect(onChange).toHaveBeenCalledWith("set_water_box_custom_mode", "202");
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("leaves every step alone on a device that has no cleaning modes", () => {
		// No tab bar means no mode whose rules could apply. Filtering anyway would take away steps
		// that worked before - MAX+ and the water level "Off" among them.
		renderBar([SUCTION, ROUTE, WATER]);

		expect(screen.queryByRole("group", { name: "Cleaning mode" })).toBeNull();
		expect(labelsIn("Suction power")).toContain("Max+");
		expect(labelsIn("Water flow")).toContain("Off");
		expect(labelsIn("Mop mode")).toEqual(["Standard", "Deep", "Deep+", "Fast"]);
	});
});

describe("ModeBar - layout", () => {
	it("stacks the rows in the app's order, passes between water and route", () => {
		// The adapter publishes suction, route, water. The app's order is suction, water, route -
		// and "the passes go between water and route" is only a position in that order.
		renderBar([SUCTION, ROUTE, WATER], tabsWith(0));

		expect(rowOrder()).toEqual(["Cleaning mode", "Suction power", "Water flow", I18n.t("ui_repeat"), "Mop mode"]);
	});

	it("keeps the passes ahead of the route even when the water picker is hidden", () => {
		// Vacuum-only has no water level; the passes must not slide behind the route because of it.
		renderBar([SUCTION, ROUTE, WATER], tabsWith(2));

		expect(rowOrder()).toEqual(["Cleaning mode", "Suction power", I18n.t("ui_repeat"), "Mop mode"]);
	});

	it("puts the passes last when the device publishes no route at all", () => {
		renderBar([SUCTION, WATER]);

		expect(rowOrder()).toEqual(["Suction power", "Water flow", I18n.t("ui_repeat")]);
	});

	it("pads the panel far enough that no caption reaches into the rounded corner", () => {
		// "Saugkraft ragt in die Rundung": the caption sat 12px from the edge while the corner arc
		// only released the edge much later. The rule is geometric, so the test states it as one
		// rather than as a screenshot.
		expect(PANEL_PADDING_PX).toBeGreaterThanOrEqual(floatingContentInset(FLOATING_RADIUS_PX));
	});

	it("gives every row a caption, whatever the longest translation is", () => {
		// The captions are the widest thing in the panel in ru/uk/pt; a row that lost its caption
		// would look like a nameless strip of icons.
		for (const language of ["en", "de"]) {
			I18n.setLanguage(language);
			try {
				const { container, unmount } = renderBar([SUCTION, ROUTE, WATER], tabsWith(0));
				for (const label of rowOrder()) {
					expect(label, language).toBeTruthy();
					expect(label, language).not.toMatch(/^ui_[a-z_]+$/);
					expect(within(container).getAllByText(label as string).length, `${language} / ${label}`).toBeGreaterThan(0);
				}
				unmount();
			} finally {
				I18n.setLanguage("en");
			}
		}
	});
});

describe("ModeBar - passes", () => {
	it("offers the two passes as a switch bar rather than as a dropdown", () => {
		renderBar([]);

		expect(screen.queryByRole("combobox")).toBeNull();
		expect(labelsIn(I18n.t("ui_repeat"))).toEqual([I18n.t("ui_repeat_once"), I18n.t("ui_repeat_twice")]);
		expect(within(group(I18n.t("ui_repeat"))).getByText("×1")).toBeTruthy();
		expect(within(group(I18n.t("ui_repeat"))).getByText("×2")).toBeTruthy();
	});

	it("marks the count in effect and names it next to the caption", () => {
		renderBar([], NO_TABS, 2);

		expect(pressedIn(I18n.t("ui_repeat"))).toEqual([I18n.t("ui_repeat_twice")]);
		expect(screen.getByText(I18n.t("ui_repeat_twice"))).toBeTruthy();
	});

	it("reports the count that was clicked as a number", () => {
		const { onCleanCountChange } = renderBar([], NO_TABS, 1);

		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_repeat_twice") }));

		expect(onCleanCountChange).toHaveBeenCalledWith(2);
	});

	it("stays silent when the active count is clicked again", () => {
		const { onCleanCountChange } = renderBar([], NO_TABS, 2);

		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_repeat_twice") }));

		expect(onCleanCountChange).not.toHaveBeenCalled();
	});

	it("keeps the German wording that once got cut off", () => {
		I18n.setLanguage("de");
		try {
			renderBar([], NO_TABS, 2);
			// The dropdown truncated "2 Durchgänge" to "2 Durch…". As a caption it has the whole row.
			expect(screen.getByText("2 Durchgänge")).toBeTruthy();
			expect(screen.getByRole("button", { name: "1 Durchgang" })).toBeTruthy();
		} finally {
			I18n.setLanguage("en");
		}
	});
});

describe("ModeBar - cleaning mode tabs", () => {
	it("offers the modes the adapter published, in the app's order", () => {
		renderBar([SUCTION], tabsWith(0));

		expect(labelsIn("Cleaning mode")).toEqual(["Vac & Mop", "Mop", "Vacuum"]);
	});

	it("marks the mode the robot is in", () => {
		renderBar([SUCTION], tabsWith(2));

		expect(pressedIn("Cleaning mode")).toEqual(["Vacuum"]);
	});

	it("highlights no tab while the robot is in a mode no tab stands for", () => {
		// Customize is reported but never offered: it means "every room carries its own setting",
		// which is not something this bar can switch into.
		renderBar([SUCTION], tabsWith(3));

		expect(pressedIn("Cleaning mode")).toEqual([]);
	});

	it("highlights no tab while the mode is still unknown", () => {
		renderBar([SUCTION], tabsWith(null));

		expect(pressedIn("Cleaning mode")).toEqual([]);
	});

	it("sends the whole triple of the tab that was clicked", () => {
		// There is no "switch mode" command: the mode is the three values together, and sending
		// them one by one would walk the robot through combinations nobody asked for.
		const { onSelectCleaningMode } = renderBar([SUCTION], tabsWith(0));

		fireEvent.click(screen.getByRole("button", { name: "Vacuum" }));

		expect(onSelectCleaningMode).toHaveBeenCalledWith(VACUUM_PAYLOAD);
	});

	it("stays silent when the active tab is clicked again", () => {
		const { onSelectCleaningMode } = renderBar([SUCTION], tabsWith(2));

		fireEvent.click(screen.getByRole("button", { name: "Vacuum" }));

		expect(onSelectCleaningMode).not.toHaveBeenCalled();
	});

	it("shows MAX+ while vacuuming", () => {
		renderBar([SUCTION], tabsWith(2));

		expect(labelsIn("Suction power")).toEqual(["Quiet", "Balanced", "Turbo", "Max", "Max+"]);
	});

	it("hides MAX+ on every other mode, which is where the app resets it to Balanced", () => {
		renderBar([SUCTION], tabsWith(0));

		expect(labelsIn("Suction power")).toEqual(["Quiet", "Balanced", "Turbo", "Max"]);
	});

	it("shows no suction picker while mopping", () => {
		renderBar([SUCTION, ROUTE, WATER], tabsWith(1));

		expect(screen.queryByRole("group", { name: "Suction power" })).toBeNull();
		expect(screen.queryByText("Suction power")).toBeNull();
	});

	it("shows no water picker while vacuuming, because that mode is the water being off", () => {
		renderBar([SUCTION, ROUTE, WATER], tabsWith(2));

		expect(screen.queryByRole("group", { name: "Water flow" })).toBeNull();
	});

	it("offers all four routes while mopping", () => {
		renderBar([ROUTE], tabsWith(1));

		expect(labelsIn("Mop mode")).toEqual(["Fast", "Standard", "Deep", "Deep+"]);
	});

	it("offers Fast and Standard on the modes that vacuum as well", () => {
		renderBar([ROUTE], tabsWith(0));

		expect(labelsIn("Mop mode")).toEqual(["Fast", "Standard"]);
	});

	it("drops the water level 'Off', because picking it would switch the mode", () => {
		renderBar([WATER], tabsWith(0));

		expect(labelsIn("Water flow")).toEqual(["Mild", "Standard"]);
	});

	it("keeps the tabs usable on a device that publishes no steps at all", () => {
		renderBar([], tabsWith(0));

		expect(labelsIn("Cleaning mode")).toEqual(["Vac & Mop", "Mop", "Vacuum"]);
	});
});
