import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderDialog(model: CleaningRunModel | null, loaded: string | null = IMAGE, canDelete = false) {
	const loadMap = vi.fn().mockResolvedValue(loaded);
	const onDelete = vi.fn();
	render(
		<HistoryDialog
			run={model}
			language="en"
			mapColorScheme="light"
			loadMap={loadMap}
			canDelete={canDelete}
			onDelete={onDelete}
			onClose={vi.fn()}
		/>,
	);
	return { loadMap, onDelete };
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

	/**
	 * Deleting a run.
	 *
	 * A deleted run is gone from the robot for good - the adapter cannot write one back - so the
	 * button asks first. The three tests below are all about *not* deleting: hidden where the robot
	 * has no such command, nothing sent on the first press, nothing sent when the question is
	 * answered with no.
	 */
	describe("the delete button", () => {
		it("is absent on a robot that published no delete command", () => {
			renderDialog(run(), IMAGE, false);
			expect(screen.queryByText(I18n.t("ui_history_delete"))).toBeNull();
		});

		it("asks before it deletes, and sends nothing on the first press", async () => {
			const { onDelete } = renderDialog(run(), IMAGE, true);

			fireEvent.click(screen.getByText(I18n.t("ui_history_delete")));

			expect(screen.getByText(I18n.t("ui_history_delete_confirm"))).toBeTruthy();
			expect(onDelete).not.toHaveBeenCalled();
		});

		it("sends the run's own start timestamp on the second press", () => {
			const { onDelete } = renderDialog(run({ startedAt: 1764939602 }), IMAGE, true);

			fireEvent.click(screen.getByText(I18n.t("ui_history_delete")));
			fireEvent.click(screen.getByText(I18n.t("ui_history_delete_yes")));

			// `del_clean_record` names the run by when it began and by nothing else.
			expect(onDelete).toHaveBeenCalledWith(1764939602);
		});

		it("sends nothing when the question is answered with no", () => {
			const { onDelete } = renderDialog(run(), IMAGE, true);

			fireEvent.click(screen.getByText(I18n.t("ui_history_delete")));
			fireEvent.click(screen.getByText(I18n.t("ui_cancel")));

			expect(onDelete).not.toHaveBeenCalled();
			expect(screen.queryByText(I18n.t("ui_history_delete_confirm"))).toBeNull();
		});

		it("is absent for a run with no start timestamp, because that is the argument", () => {
			renderDialog(run({ startedAt: null }), IMAGE, true);
			expect(screen.queryByText(I18n.t("ui_history_delete"))).toBeNull();
		});
	});
});
