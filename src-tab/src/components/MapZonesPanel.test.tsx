import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { MapZonesPanel } from "./MapZonesPanel";
import type { MapZonesModel } from "../engine/types";

/**
 * The panel for the walls and zones stored on the robot.
 *
 * What is worth pinning is the set of situations in which it must **not** offer to write:
 *
 *  1. a map that carries none of these overlays at all - the panel stays away entirely;
 *  2. a map the adapter would refuse to rewrite - the reason is shown and the buttons are dead;
 *  3. a kind that has reached its own limit of ten.
 *
 * Each of these ends, if got wrong, in a button whose failure the user only sees in the adapter
 * log: `set_state` answers `{result:"ok"}` before the robot is asked at all.
 *
 * The fourth is the two-step placement itself. It exists because every save rewrites the complete
 * set of walls and zones on the robot, so a zone is placed in the browser first and sent once.
 */

function model(overrides: Partial<MapZonesModel> = {}): MapZonesModel {
	return {
		counts: { no_go: 0, no_mop: 0, wall: 0 },
		limit: 10,
		selectedKey: null,
		selectedKind: null,
		drafting: false,
		supported: true,
		refusalText: null,
		...overrides,
	};
}

function renderPanel(zones: MapZonesModel) {
	const onAdd = vi.fn();
	const onSave = vi.fn();
	const onCancel = vi.fn();
	const view = render(
		<MapZonesPanel
			zones={zones}
			onAdd={onAdd}
			onSave={onSave}
			onCancel={onCancel}
		/>,
	);
	const header = screen.queryByText(I18n.t("ui_map_zones"));
	if (header) fireEvent.click(header);
	return { onAdd, onSave, onCancel, view };
}

/** The add button of one kind, found through its own aria-label. */
function addButton(kindKey: string): HTMLElement {
	return screen.getByLabelText(`${I18n.t("ui_map_zone_add")}: ${I18n.t(kindKey)}`);
}

describe("MapZonesPanel", () => {
	it("stays away on a map that carries no such overlays", () => {
		// Every non-V1 pipeline. Offering the controls there would promise a write that cannot
		// happen - the blocks are not in those maps and the adapter has nothing to rewrite.
		const { view } = renderPanel(model({ supported: false }));
		expect(view.container.textContent).toBe("");
	});

	it("offers all three kinds, each with its own count against its own limit", () => {
		// Ten per kind, not ten in total: a map full of no-go zones still has room for ten walls.
		renderPanel(model({ counts: { no_go: 10, no_mop: 2, wall: 0 } }));

		expect(screen.getByText(I18n.t("ui_map_zone_no_go"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_map_zone_no_mop"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_map_zone_wall"))).toBeTruthy();
		expect(screen.getByText("10 / 10")).toBeTruthy();
		expect(screen.getByText("2 / 10")).toBeTruthy();
	});

	it("greys out only the kind that reached its limit", () => {
		renderPanel(model({ counts: { no_go: 10, no_mop: 2, wall: 0 } }));

		expect(addButton("ui_map_zone_no_go").hasAttribute("disabled")).toBe(true);
		expect(addButton("ui_map_zone_no_mop").hasAttribute("disabled")).toBe(false);
		expect(addButton("ui_map_zone_wall").hasAttribute("disabled")).toBe(false);
	});

	it("starts placing the kind whose button was pressed", () => {
		const { onAdd } = renderPanel(model());
		fireEvent.click(addButton("ui_map_zone_no_mop"));
		expect(onAdd).toHaveBeenCalledWith("no_mop");
	});

	it("shows the adapter's refusal and lets nothing be added while it stands", () => {
		// The adapter refuses a map it cannot rewrite completely rather than write a short list.
		// Saying so here is the difference between an explained state and a dead button.
		renderPanel(model({ refusalText: "This map carries a 'CL_FORBIDDEN_ZONES' overlay." }));

		expect(screen.getByText("This map carries a 'CL_FORBIDDEN_ZONES' overlay.")).toBeTruthy();
		for (const key of ["ui_map_zone_no_go", "ui_map_zone_no_mop", "ui_map_zone_wall"]) {
			expect(addButton(key).hasAttribute("disabled")).toBe(true);
		}
	});

	it("swaps the kind list for save and cancel while one is being placed", () => {
		// Nothing has reached the robot at this point, and the panel has to say so: the choice is
		// no longer "which kind" but "send this one or drop it".
		renderPanel(model({ drafting: true, selectedKind: "no_go" }));

		expect(screen.getByText(I18n.t("ui_map_zone_draft_hint"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_map_zone_save"))).toBeTruthy();
		expect(screen.queryByLabelText(`${I18n.t("ui_map_zone_add")}: ${I18n.t("ui_map_zone_no_go")}`)).toBeNull();
	});

	it("sends the one being placed only when save is pressed", () => {
		const { onSave, onCancel } = renderPanel(model({ drafting: true }));
		fireEvent.click(screen.getByText(I18n.t("ui_map_zone_save")));
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("drops it without sending when cancel is pressed", () => {
		const { onSave, onCancel } = renderPanel(model({ drafting: true }));
		fireEvent.click(screen.getByText(I18n.t("ui_cancel")));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("counts all three kinds together on the collapsed header", () => {
		render(
			<MapZonesPanel
				zones={model({ counts: { no_go: 3, no_mop: 1, wall: 2 } })}
				onAdd={vi.fn()}
				onSave={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		// Collapsed, the header is all there is - and there the total is the useful number.
		expect(screen.getByText("6")).toBeTruthy();
	});
});
