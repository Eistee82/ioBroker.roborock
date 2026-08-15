import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { SegmentEditDialog } from "./SegmentEditDialog";
import type { SegmentEditKind } from "./SegmentEditDialog";

/**
 * The question asked before rooms are divided or combined.
 *
 * This dialog is the reason the two commands may be offered in the tab at all: both renumber the
 * robot's segments, and the adapter's warning about that reached only the log and the object tree -
 * never the person pressing the button. So what is worth testing is that it actually says the
 * uncomfortable parts, and that it cannot be confirmed by accident.
 */

function renderDialog(pending: SegmentEditKind | null, roomNames: string[] = []) {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	render(
		<SegmentEditDialog
			pending={pending}
			roomNames={roomNames}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>,
	);
	return { onConfirm, onCancel };
}

describe("SegmentEditDialog", () => {
	it("stays closed while nothing is pending", () => {
		renderDialog(null);
		expect(screen.queryByText(I18n.t("ui_segment_edit_warning"))).toBeNull();
	});

	it("carries Roborock's own warning rather than a rewrite of it", () => {
		// `map_edit_segment_prompt`, the sentence the user may already know from their phone.
		renderDialog("split");
		expect(screen.getByText(I18n.t("ui_segment_edit_warning"))).toBeTruthy();
	});

	it("names all three things that are affected", () => {
		// "All related settings become invalid" is true and unhelpfully vague; these say what it
		// means. The first one is the uncomfortable one - the adapter cannot restore it.
		renderDialog("merge");
		expect(screen.getByText(I18n.t("ui_segment_edit_loses_modes"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_segment_edit_loses_sequence"))).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_segment_edit_loses_switches"))).toBeTruthy();
	});

	it("says plainly that the room modes cannot be restored", () => {
		// The adapter has no `set_customize_clean_mode` at all, so it cannot even save them. Saying
		// so is the difference between a warning and a promise it cannot keep.
		renderDialog("split");
		expect(I18n.t("ui_segment_edit_loses_modes")).toMatch(/cannot restore|nicht wiederherstellen/i);
	});

	it("titles itself after the edit that is pending", () => {
		renderDialog("split");
		expect(screen.getAllByText(I18n.t("ui_map_room_split")).length).toBeGreaterThan(0);
	});

	it("uses the other title for a merge", () => {
		renderDialog("merge");
		expect(screen.getAllByText(I18n.t("ui_map_room_merge")).length).toBeGreaterThan(0);
	});

	it("names the rooms the edit touches", () => {
		renderDialog("merge", ["Kitchen", "Hallway"]);
		expect(screen.getByText("Kitchen, Hallway")).toBeTruthy();
	});

	it("confirms only on the confirming button", () => {
		const { onConfirm, onCancel } = renderDialog("split");
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_map_room_split") }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("cancels on the cancel button", () => {
		const { onConfirm, onCancel } = renderDialog("split");
		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_cancel") }));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("gives the prominent button to cancelling, not to confirming", () => {
		// Nothing here can be undone from the tab, so the safe choice is the one the hand reaches
		// for - and a stray Enter must not divide a room.
		renderDialog("split");
		const cancel = screen.getByRole("button", { name: I18n.t("ui_cancel") });
		const confirm = screen.getByRole("button", { name: I18n.t("ui_map_room_split") });
		expect(cancel.className).toMatch(/contained/i);
		expect(confirm.className).not.toMatch(/contained/i);
	});
});
