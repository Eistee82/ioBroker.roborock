import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { HistoryPanel } from "./HistoryPanel";
import type { CleaningHistoryModel, CleaningRunModel } from "../history/historyTypes";

/**
 * What the history panel shows and what it stays quiet about.
 *
 * The panel is a reader; nothing in here sends the robot anything. The two behaviours worth
 * pinning are that it disappears entirely for a device without a history - an empty box reads as a
 * failure - and that only the runs that were cut short carry a mark, because a tick on all twenty
 * normal rows says nothing.
 */

function run(over: Partial<CleaningRunModel> = {}): CleaningRunModel {
	return {
		index: 0,
		startedAt: 1765198801,
		duration: { value: 76, unit: "min" },
		area: { value: 51, unit: "m²" },
		cleanType: 1,
		finished: true,
		finishReason: 52,
		washCount: 5,
		mapStateId: "roborock.0.Devices.duid1.cleaningInfo.records.0.map.mapBase64",
		extras: [],
		...over,
	};
}

const HISTORY: CleaningHistoryModel = {
	summary: [
		{ key: "clean_area", name: "clean_area", value: 6047, unit: "m²" },
		{ key: "clean_time", name: "clean_time", value: 123, unit: "h" },
		{ key: "clean_count", name: "clean_count", value: 190, unit: "" },
	],
	runs: [run(), run({ index: 1, startedAt: 1764939602, finished: false, finishReason: 60 })],
	canDelete: false,
};

function renderPanel(history: CleaningHistoryModel | null) {
	const onSelectRun = vi.fn();
	render(
		<HistoryPanel
			history={history}
			language="en"
			onSelectRun={onSelectRun}
		/>,
	);
	return { onSelectRun };
}

function expand(): void {
	fireEvent.click(screen.getByText(I18n.t("ui_history")));
}

describe("HistoryPanel", () => {
	it("stays away for a device that published no history", () => {
		renderPanel(null);
		expect(screen.queryByText(I18n.t("ui_history"))).toBeNull();

		renderPanel({ summary: [], runs: [], canDelete: false });
		expect(screen.queryByText(I18n.t("ui_history"))).toBeNull();
	});

	it("names the lifetime totals with the app's own wording", () => {
		renderPanel(HISTORY);
		expand();

		expect(screen.getByText(I18n.t("ui_history_total_area"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_history_total_time"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_history_total_runs"))).toBeTruthy();
		expect(screen.getByText("6,047 m²")).toBeTruthy();
	});

	it("shows the number of runs on the collapsed line", () => {
		renderPanel(HISTORY);
		expect(screen.getByText("2")).toBeTruthy();
	});

	it("marks only the run that was cut short", () => {
		renderPanel(HISTORY);
		expand();
		expect(screen.getAllByText(I18n.t("ui_history_interrupted_short"))).toHaveLength(1);
	});

	it("names the type of run in the app's words", () => {
		renderPanel(HISTORY);
		expand();
		expect(screen.getAllByText(I18n.t("ui_history_type_full"))).toHaveLength(2);
	});

	it("shows the bare code for a type Roborock's table does not list", () => {
		renderPanel({ summary: [], runs: [run({ cleanType: 42 })], canDelete: false });
		expand();
		expect(screen.getByText("42")).toBeTruthy();
	});

	it("hands the whole run to the caller when a row is clicked", () => {
		const { onSelectRun } = renderPanel(HISTORY);
		expand();

		fireEvent.click(screen.getAllByRole("button")[1]);
		expect(onSelectRun).toHaveBeenCalledTimes(1);
		expect(onSelectRun.mock.calls[0][0].index).toBe(0);
	});

	it("says so when the device reports totals but no single run", () => {
		renderPanel({ summary: HISTORY.summary, runs: [], canDelete: false });
		expand();
		expect(screen.getByText(I18n.t("ui_history_empty"))).toBeTruthy();
	});

	it("shows a bare number for a total the adapter declared no unit for", () => {
		renderPanel({ summary: [{ key: "clean_count", name: "clean_count", value: 190, unit: "" }], runs: [], canDelete: false });
		expand();
		expect(screen.getByText("190")).toBeTruthy();
	});
});
