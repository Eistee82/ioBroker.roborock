import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModeBar } from "./ModeBar";
import type { ModeModel } from "../engine/types";

/**
 * The switch bar, pinned where it can go wrong without throwing.
 *
 * It replaced dropdowns because these settings are chosen by their picture, and the failure modes
 * are all silent: a step that cannot be reached, a highlight on the wrong one, a click that fires
 * a command the user did not ask for.
 */

const SUCTION: ModeModel = {
	command: "set_custom_mode",
	labelKey: "ui_fan_power",
	value: "102",
	options: [
		{ value: "101", label: "Quiet" },
		{ value: "102", label: "Balanced" },
		{ value: "103", label: "Turbo" },
		{ value: "104", label: "Max" }
	]
};

/** Renders with no asset folder, so every option falls back to its text. */
function renderBar(modes: ModeModel[], onChange = vi.fn()): { onChange: ReturnType<typeof vi.fn> } {
	render(
		<ModeBar
			modes={modes}
			assetBase={null}
			onChange={onChange}
		/>
	);
	return { onChange };
}

describe("ModeBar", () => {
	it("draws nothing when the device offers no modes", () => {
		const { container } = render(
			<ModeBar
				modes={[]}
				assetBase={null}
				onChange={vi.fn()}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it("shows every step at once instead of hiding them behind a click", () => {
		renderBar([SUCTION]);

		for (const option of SUCTION.options) {
			expect(screen.getByRole("button", { name: option.label })).toBeTruthy();
		}
	});

	it("marks the step in effect, and only that one", () => {
		renderBar([SUCTION]);

		const pressed = screen.getAllByRole("button").filter(button => button.getAttribute("aria-pressed") === "true");
		expect(pressed).toHaveLength(1);
		expect(pressed[0].getAttribute("aria-label")).toBe("Balanced");
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

		const pressed = screen.getAllByRole("button").filter(button => button.getAttribute("aria-pressed") === "true");
		expect(pressed).toHaveLength(0);
	});

	it("keeps the groups apart so two settings cannot be confused", () => {
		const water: ModeModel = {
			command: "set_water_box_custom_mode",
			labelKey: "ui_water_flow",
			value: "201",
			options: [{ value: "201", label: "Low" }, { value: "202", label: "Medium" }]
		};
		const { onChange } = renderBar([SUCTION, water]);

		fireEvent.click(screen.getByRole("button", { name: "Medium" }));

		expect(onChange).toHaveBeenCalledWith("set_water_box_custom_mode", "202");
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
