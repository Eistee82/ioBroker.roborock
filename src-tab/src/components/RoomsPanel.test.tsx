import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { RoomsPanel } from "./RoomsPanel";
import type { SplitPanelState } from "./RoomsPanel";
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
		cleanOrder: [],
		...overrides,
	};
}

function renderPanel(rooms: RoomListModel, split: Partial<SplitProps> = {}) {
	const onRename = vi.fn();
	const onMergeRequest = vi.fn();
	const onSetCleanOrder = vi.fn();
	const onClearCleanOrder = vi.fn();
	const onSplitStart = vi.fn();
	const onSplitRequest = vi.fn();
	const onSplitCancel = vi.fn();
	const view = render(
		<RoomsPanel
			rooms={rooms}
			onRename={onRename}
			onMergeRequest={onMergeRequest}
			onSetCleanOrder={onSetCleanOrder}
			onClearCleanOrder={onClearCleanOrder}
			canSplit={split.canSplit ?? false}
			splitRefusal={split.splitRefusal ?? null}
			onSplitStart={onSplitStart}
			split={split.split ?? null}
			onSplitRequest={onSplitRequest}
			onSplitCancel={onSplitCancel}
		/>,
	);
	const header = screen.queryByText(I18n.t("ui_rooms"));
	if (header) fireEvent.click(header);
	return { onRename, onMergeRequest, onSetCleanOrder, onClearCleanOrder, onSplitStart, onSplitRequest, onSplitCancel, view };
}

/** The dividing props a test cares about; the rest of the panel does not change with them. */
interface SplitProps {
	canSplit: boolean;
	splitRefusal: string | null;
	split: SplitPanelState | null;
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
				onSetCleanOrder={vi.fn()}
				onClearCleanOrder={vi.fn()}
				canSplit={false}
				splitRefusal={null}
				onSplitStart={vi.fn()}
				split={null}
				onSplitRequest={vi.fn()}
				onSplitCancel={vi.fn()}
			/>,
		);
		expect(screen.getByText("1")).toBeTruthy();
	});

	describe("dividing a room", () => {
		/** A model with exactly one room picked - the only selection a division applies to. */
		const onePicked = (): RoomListModel => model();

		it("offers nothing at all on a map that publishes no grid", () => {
			// B01/Q10 devices, and any map whose grid did not compress. A permanently dead button
			// explains nothing, so the whole control stays away.
			renderPanel(onePicked(), { canSplit: false });
			expect(screen.queryByText(I18n.t("ui_map_room_split"))).toBeNull();
		});

		it("offers the button once the map can be divided", () => {
			renderPanel(onePicked(), { canSplit: true });
			expect(screen.getByText(I18n.t("ui_map_room_split"))).toBeTruthy();
		});

		it("greys the button out with the adapter's own reason", () => {
			const refusal = "This room is only 1.5 m².";
			renderPanel(onePicked(), { canSplit: true, splitRefusal: refusal });

			const button = screen.getByText(I18n.t("ui_map_room_split")).closest("button");
			expect(button?.disabled).toBe(true);
			expect(screen.getByLabelText(refusal)).toBeTruthy();
		});

		it("starts a division rather than sending one", () => {
			// The panel never sends: the shell puts the warning dialog in between.
			const { onSplitStart, onSplitRequest } = renderPanel(onePicked(), { canSplit: true });
			fireEvent.click(screen.getByText(I18n.t("ui_map_room_split")));
			expect(onSplitStart).toHaveBeenCalledTimes(1);
			expect(onSplitRequest).not.toHaveBeenCalled();
		});

		it("shows Roborock's own hint while the line cannot be sent, and keeps the button dead", () => {
			const hint = I18n.t("ui_split_adjust");
			renderPanel(onePicked(), { canSplit: true, split: { valid: false, hint, halves: null } });

			expect(screen.getByText(hint)).toBeTruthy();
			const confirm = screen.getAllByText(I18n.t("ui_map_room_split")).map(node => node.closest("button"));
			expect(confirm.some(button => button?.disabled)).toBe(true);
		});

		it("shows the two areas the line would leave behind", () => {
			renderPanel(onePicked(), { canSplit: true, split: { valid: true, hint: null, halves: { a: 12.34, b: 5.6 } } });
			expect(screen.getByText(I18n.t("ui_split_halves").replace("%s", "12.3").replace("%s", "5.6"))).toBeTruthy();
		});

		it("asks before it divides, and cancels without asking", () => {
			const { onSplitRequest, onSplitCancel } = renderPanel(onePicked(), {
				canSplit: true,
				split: { valid: true, hint: null, halves: null },
			});

			fireEvent.click(screen.getByText(I18n.t("ui_map_room_split")));
			expect(onSplitRequest).toHaveBeenCalledTimes(1);

			fireEvent.click(screen.getByText(I18n.t("ui_cancel")));
			expect(onSplitCancel).toHaveBeenCalledTimes(1);
		});

		it("hides the starting button while a division is running", () => {
			// Otherwise the panel would offer to start a second one on top of the first.
			const { onSplitStart } = renderPanel(onePicked(), {
				canSplit: true,
				split: { valid: true, hint: null, halves: null },
			});

			fireEvent.click(screen.getByText(I18n.t("ui_map_room_split")));
			expect(onSplitStart).not.toHaveBeenCalled();
		});
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
