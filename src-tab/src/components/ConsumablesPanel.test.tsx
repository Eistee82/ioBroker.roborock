import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { ConsumablesPanel } from "./ConsumablesPanel";
import type { ConsumableGroup, ConsumablePartModel } from "../engine/types";

/**
 * How the consumables are laid out: robot parts first, station parts after them, each under its
 * own heading - the split the Roborock app makes on its supplies page.
 *
 * The panel starts collapsed, so every test opens it before looking for the rows. What the tests
 * pin is the arrangement, not the classification: which part belongs to which unit is decided in
 * `engine/consumables.ts` and pinned in `engine/consumables.test.ts`.
 */

/** One part as the engine publishes it; the counter text is what the row shows verbatim. */
function part(
	name: string,
	group: ConsumableGroup,
	options: { percent?: number | null; text?: string; reset?: string | null } = {},
): ConsumablePartModel {
	return {
		part: name,
		name,
		group,
		metrics: [{ name: "remaining time", text: options.text ?? "120 h" }],
		percent: options.percent ?? 80,
		due: false,
		resetCommand: options.reset === undefined ? `reset_${name}` : options.reset,
	};
}

/** A dock model: four robot parts and three station parts, in the order the engine delivers them. */
const ROBOT_PARTS = [part("Main brush", "robot"), part("Side brush", "robot"), part("Dust filter", "robot"), part("Sensors", "robot")];
const STATION_PARTS = [part("Cleaning brush", "station"), part("Water filter", "station"), part("Dust bag", "station")];

/** Renders the panel and expands it, since everything under test lives in the collapsed part. */
function renderPanel(parts: ConsumablePartModel[]) {
	const onReset = vi.fn();
	render(
		<ConsumablesPanel
			parts={parts}
			onReset={onReset}
		/>,
	);
	fireEvent.click(screen.getByText(I18n.t("ui_consumables")));
	return { onReset };
}

/** The panel's text in reading order, so a test can assert what stands above what. */
function readingOrder(): string[] {
	const surface = screen.getByText(I18n.t("ui_consumables")).closest("div")?.parentElement as HTMLElement;
	return Array.from(surface.querySelectorAll("p, span"))
		.map(element => element.textContent?.trim() ?? "")
		.filter(text => text.length > 0);
}

/** Index of a text in reading order, or -1. Used to compare positions, not just presence. */
function positionOf(text: string): number {
	return readingOrder().findIndex(entry => entry === text);
}

describe("ConsumablesPanel grouping", () => {
	it("puts every robot part above every station part, whatever order they arrive in", () => {
		// The engine hands the parts over in object-id order, which interleaves the two units:
		// `cleaning_brush` sorts before `main_brush`. Grouping has to survive that.
		renderPanel([STATION_PARTS[0], ROBOT_PARTS[0], STATION_PARTS[1], ROBOT_PARTS[2]]);

		const robotHeading = positionOf(I18n.t("ui_consumables_group_robot"));
		const stationHeading = positionOf(I18n.t("ui_consumables_group_station"));
		expect(robotHeading).toBeGreaterThanOrEqual(0);
		expect(stationHeading).toBeGreaterThan(robotHeading);

		expect(positionOf("Main brush")).toBeGreaterThan(robotHeading);
		expect(positionOf("Main brush")).toBeLessThan(stationHeading);
		expect(positionOf("Dust filter")).toBeLessThan(stationHeading);
		expect(positionOf("Cleaning brush")).toBeGreaterThan(stationHeading);
		expect(positionOf("Water filter")).toBeGreaterThan(stationHeading);
	});

	it("keeps the order inside a group as delivered", () => {
		renderPanel([...ROBOT_PARTS, ...STATION_PARTS]);
		expect(positionOf("Main brush")).toBeLessThan(positionOf("Side brush"));
		expect(positionOf("Side brush")).toBeLessThan(positionOf("Sensors"));
		expect(positionOf("Cleaning brush")).toBeLessThan(positionOf("Dust bag"));
	});

	it("shows no heading at all when the device reports only robot parts", () => {
		// Every model without a dock. A lone "Robot" caption over the whole panel says nothing, so
		// these devices keep the plain list they had before grouping existed.
		renderPanel(ROBOT_PARTS);
		expect(screen.queryByText(I18n.t("ui_consumables_group_robot"))).toBeNull();
		expect(screen.queryByText(I18n.t("ui_consumables_group_station"))).toBeNull();
		for (const entry of ROBOT_PARTS) {
			expect(screen.getByText(entry.name)).toBeTruthy();
		}
	});

	it("shows no empty group when the device reports only station parts", () => {
		renderPanel(STATION_PARTS);
		expect(screen.queryByText(I18n.t("ui_consumables_group_robot"))).toBeNull();
		expect(screen.queryByText(I18n.t("ui_consumables_group_station"))).toBeNull();
		expect(screen.getByText("Water filter")).toBeTruthy();
	});

	it("renders nothing when there is no consumable at all", () => {
		const { container } = render(
			<ConsumablesPanel
				parts={[]}
				onReset={vi.fn()}
			/>,
		);
		expect(container.innerHTML).toBe("");
	});
});

describe("ConsumablesPanel rows", () => {
	it("shows a part whose counter reads zero", () => {
		// `filter_element_work_time` comes back as 0 on a fresh robot. Zero is a value, not an
		// absent part - only a part the robot never reports may disappear.
		renderPanel([...ROBOT_PARTS, part("Water tank filter", "robot", { percent: 0, text: "0 h" })]);
		expect(screen.getByText("Water tank filter")).toBeTruthy();
		expect(screen.getByText("remaining time: 0 h")).toBeTruthy();
	});

	it("keeps the meter, the reset icon and its inline confirmation", () => {
		const { onReset } = renderPanel([...ROBOT_PARTS, ...STATION_PARTS]);

		expect(document.querySelectorAll(".MuiLinearProgress-root").length).toBe(ROBOT_PARTS.length + STATION_PARTS.length);

		const label = `${I18n.t("ui_consumable_reset")}: Water filter`;
		fireEvent.click(screen.getByRole("button", { name: label }));
		expect(screen.getByText(I18n.t("ui_consumable_reset_confirm").replace("%s", "Water filter"))).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_consumable_reset_yes") }));
		expect(onReset).toHaveBeenCalledWith("reset_Water filter");
	});

	it("asks only once, even across the group boundary", () => {
		// The open question is panel state, not group state: opening a station part's question has
		// to close the robot part's, or two counters look armed at the same time.
		renderPanel([...ROBOT_PARTS, ...STATION_PARTS]);
		fireEvent.click(screen.getByRole("button", { name: `${I18n.t("ui_consumable_reset")}: Main brush` }));
		fireEvent.click(screen.getByRole("button", { name: `${I18n.t("ui_consumable_reset")}: Water filter` }));
		expect(screen.getAllByRole("button", { name: I18n.t("ui_consumable_reset_yes") })).toHaveLength(1);
	});

	it("leaves out the reset for a part the device offers none for", () => {
		renderPanel([part("Dust bag", "station", { reset: null }), ...ROBOT_PARTS]);
		expect(screen.queryByRole("button", { name: `${I18n.t("ui_consumable_reset")}: Dust bag` })).toBeNull();
	});
});
