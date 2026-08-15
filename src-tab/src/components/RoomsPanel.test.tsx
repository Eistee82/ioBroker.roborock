import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { RoomsPanel } from "./RoomsPanel";
import type { RoomListModel } from "../engine/types";

/**
 * The rooms panel, and the one thing it must never do: send a rename the user did not finish.
 *
 * Every `name_segment` call makes the adapter rebuild the **entire** room assignment, because a
 * partial list drops the names of every room it leaves out. So a rename per keystroke would be a
 * full rewrite per keystroke. The field therefore commits on Enter or on the button, and Escape
 * throws the draft away.
 */

function model(overrides: Partial<RoomListModel> = {}): RoomListModel {
	return {
		rooms: [
			{ segmentId: 16, name: "Kitchen", selected: false },
			{ segmentId: 17, name: "Living room", selected: true },
		],
		maxNameLength: 30,
		...overrides,
	};
}

function renderPanel(rooms: RoomListModel) {
	const onRename = vi.fn();
	const onMergeRequest = vi.fn();
	const view = render(
		<RoomsPanel
			rooms={rooms}
			onRename={onRename}
			onMergeRequest={onMergeRequest}
		/>,
	);
	const header = screen.queryByText(I18n.t("ui_rooms"));
	if (header) fireEvent.click(header);
	return { onRename, onMergeRequest, view };
}

/** Opens the field of one room and returns it. */
function editField(roomName: string): HTMLInputElement {
	fireEvent.click(screen.getByLabelText(`${I18n.t("ui_room_rename")}: ${roomName}`));
	return screen.getByLabelText(I18n.t("ui_room_rename")) as HTMLInputElement;
}

describe("RoomsPanel", () => {
	it("stays away when the map has no named rooms", () => {
		// An unnamed segment has no label on the map either; a row showing a bare number would
		// invite renaming a room the user cannot identify.
		const { view } = renderPanel(model({ rooms: [] }));
		expect(view.container.textContent).toBe("");
	});

	it("lists the rooms of the current map", () => {
		renderPanel(model());
		expect(screen.getByText("Kitchen")).toBeTruthy();
		expect(screen.getByText("Living room")).toBeTruthy();
	});

	it("counts the picked rooms on the collapsed header", () => {
		render(
			<RoomsPanel
				rooms={model()}
				onRename={vi.fn()}
				onMergeRequest={vi.fn()}
			/>,
		);
		expect(screen.getByText("1")).toBeTruthy();
	});

	it("sends nothing while the name is being typed", () => {
		const { onRename } = renderPanel(model());
		const field = editField("Kitchen");
		fireEvent.change(field, { target: { value: "Cooking" } });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("sends the new name on Enter, for the room it belongs to", () => {
		const { onRename } = renderPanel(model());
		const field = editField("Living room");
		fireEvent.change(field, { target: { value: "Lounge" } });
		fireEvent.keyDown(field, { key: "Enter" });

		expect(onRename).toHaveBeenCalledTimes(1);
		// Segment 17, not 16: the row's own id, not the first one in the list.
		expect(onRename).toHaveBeenCalledWith(17, "Lounge");
	});

	it("sends it on the save button as well", () => {
		const { onRename } = renderPanel(model());
		const field = editField("Kitchen");
		fireEvent.change(field, { target: { value: "Pantry" } });
		fireEvent.click(screen.getByText(I18n.t("ui_map_zone_save")));
		expect(onRename).toHaveBeenCalledWith(16, "Pantry");
	});

	it("throws the draft away on Escape and on cancel", () => {
		const { onRename } = renderPanel(model());
		const field = editField("Kitchen");
		fireEvent.change(field, { target: { value: "Nope" } });
		fireEvent.keyDown(field, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByText("Kitchen")).toBeTruthy();

		const again = editField("Kitchen");
		fireEvent.change(again, { target: { value: "Nope" } });
		fireEvent.click(screen.getByText(I18n.t("ui_cancel")));
		expect(onRename).not.toHaveBeenCalled();
	});

	it("refuses to send an empty name", () => {
		// The adapter refuses it too, but a disabled button says so before the round trip - and a
		// rename that failed silently would look like one that worked.
		const { onRename } = renderPanel(model());
		const field = editField("Kitchen");
		fireEvent.change(field, { target: { value: "   " } });

		const save = screen.getByText(I18n.t("ui_map_zone_save")).closest("button") as HTMLButtonElement;
		expect(save.disabled).toBe(true);

		fireEvent.keyDown(field, { key: "Enter" });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("stops the field where the app stops it", () => {
		const { onRename } = renderPanel(model({ maxNameLength: 30 }));
		expect(editField("Kitchen").maxLength).toBe(30);
		expect(onRename).not.toHaveBeenCalled();
	});

	it("only asks to combine, never sends it", () => {
		// Combining renumbers the robot's segments, so the confirmation dialog sits between this
		// button and the command. The panel must not know how to send one.
		const { onMergeRequest, onRename } = renderPanel(
			model({
				rooms: [
					{ segmentId: 16, name: "Kitchen", selected: true },
					{ segmentId: 17, name: "Living room", selected: true },
				],
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_map_room_merge") }));
		expect(onMergeRequest).toHaveBeenCalledTimes(1);
		expect(onRename).not.toHaveBeenCalled();
	});

	it("greys the combine button out below two picked rooms instead of hiding it", () => {
		// A button that only appears once the right number is picked is a button nobody finds.
		const { onMergeRequest } = renderPanel(
			model({
				rooms: [
					{ segmentId: 16, name: "Kitchen", selected: true },
					{ segmentId: 17, name: "Living room", selected: false },
				],
			}),
		);

		const button = screen.getByRole("button", { name: I18n.t("ui_map_room_merge") }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		expect(onMergeRequest).not.toHaveBeenCalled();
	});

	it("offers it as soon as two rooms are picked", () => {
		const { onMergeRequest } = renderPanel(
			model({
				rooms: [
					{ segmentId: 16, name: "Kitchen", selected: true },
					{ segmentId: 17, name: "Living room", selected: true },
				],
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_map_room_merge") }));
		expect(onMergeRequest).toHaveBeenCalledTimes(1);
	});

	it("edits one room at a time", () => {
		// Two open fields would make it easy to type in one and press the other's button.
		renderPanel(model());
		editField("Kitchen");
		expect(screen.getAllByLabelText(I18n.t("ui_room_rename"))).toHaveLength(1);
	});
});
