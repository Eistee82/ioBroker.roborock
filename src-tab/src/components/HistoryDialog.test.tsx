import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { HistoryDialog } from "./HistoryDialog";
import type { CleaningRunModel } from "../history/historyTypes";

/**
 * The detail view of one run, whose point is the map.
 *
 * The image is fetched when the dialog opens rather than with the list - twenty runs of a few
 * hundred kilobytes each would be several megabytes to show twenty lines - so the test pins that
 * the fetch happens, that it is not made when there is nothing to fetch, and that a run without a
 * stored map says so instead of showing an empty frame.
 */

const MAP_STATE = "roborock.0.Devices.duid1.cleaningInfo.records.0.map.mapBase64";
const IMAGE = "data:image/png;base64,AAAA";

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
		mapStateId: MAP_STATE,
		extras: [],
		...over,
	};
}

function renderDialog(model: CleaningRunModel | null, loaded: string | null = IMAGE) {
	const loadMap = vi.fn().mockResolvedValue(loaded);
	render(
		<HistoryDialog
			run={model}
			language="en"
			mapColorScheme="light"
			loadMap={loadMap}
			onClose={vi.fn()}
		/>,
	);
	return { loadMap };
}

describe("HistoryDialog", () => {
	it("stays closed while no run is selected, and asks for no image", () => {
		const { loadMap } = renderDialog(null);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(loadMap).not.toHaveBeenCalled();
	});

	it("fetches exactly the image of the opened run", async () => {
		const { loadMap } = renderDialog(run());
		await waitFor(() => expect(loadMap).toHaveBeenCalledWith(MAP_STATE));
		await waitFor(() => expect(document.querySelector("img")?.getAttribute("src")).toBe(IMAGE));
	});

	it("explains a run whose map was never stored", async () => {
		const { loadMap } = renderDialog(run({ mapStateId: null }));
		expect(loadMap).not.toHaveBeenCalled();
		expect(screen.getByText(I18n.t("ui_history_no_map"))).toBeTruthy();
	});

	it("says so when the state exists but holds nothing usable", async () => {
		renderDialog(run(), null);
		await waitFor(() => expect(screen.getByText(I18n.t("ui_history_no_map"))).toBeTruthy());
	});

	it("shows the measured values of the run", async () => {
		renderDialog(run());
		expect(screen.getByText("51 m²")).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_history_type_full"))).toBeTruthy();
		// 52 is a code Roborock's own table words as "finished"; the label comes from there.
		expect(screen.getAllByText(I18n.t("ui_history_result_finished")).length).toBeGreaterThan(0);
	});

	it("words an aborted run with the reason Roborock gives that code", async () => {
		renderDialog(run({ finished: false, finishReason: 60 }));
		expect(screen.getByText(I18n.t("ui_history_reason_manual"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_history_result_interrupted"))).toBeTruthy();
	});

	it("lists the fields it has no proven meaning for under their own name", async () => {
		renderDialog(run({ extras: [{ key: "avoid_count", name: "Avoid Count", value: 50, unit: "" }] }));
		expect(screen.getByText(I18n.t("ui_history_more_values"))).toBeTruthy();
		expect(screen.getByText("Avoid Count")).toBeTruthy();
		expect(screen.getByText("50")).toBeTruthy();
	});
});
