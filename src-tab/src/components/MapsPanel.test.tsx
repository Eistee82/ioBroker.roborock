import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { MapsPanel } from "./MapsPanel";
import type { MapListModel } from "../map/mapListSource";

/**
 * The map list, as the user sees it.
 *
 * Three things are worth a render test rather than a comment, and each of them is a way the panel
 * could lie:
 *
 *  - **A robot with one map still gets a rename.** That is the whole reason this panel exists
 *    instead of a button on the floor selector, which hides itself below two entries.
 *  - **The rename disappears** when the adapter did not publish the command - it must not be shown
 *    greyed out, and it must not be shown at all.
 *  - **The length rule bites in bytes.** A field that accepted fifteen umlauts would send a name
 *    the adapter refuses, and the user would learn about it from a red message afterwards.
 */

function model(overrides: Partial<MapListModel> = {}): MapListModel {
	return {
		maps: [
			{ mapFlag: 0, name: "Erdgeschoss", addTime: 1786788440, backupCount: 1, lastBackupTime: 1786781087 },
			{ mapFlag: 1, name: "Keller", addTime: 1733229641, backupCount: 0, lastBackupTime: null },
		],
		renameSupported: true,
		...overrides,
	};
}

function renderPanel(maps: MapListModel, activeMapFlag: number | null = null) {
	const onRename = vi.fn();
	const view = render(
		<MapsPanel
			maps={maps}
			activeMapFlag={activeMapFlag}
			language="en"
			onRename={onRename}
		/>,
	);
	// The panel opens collapsed, like every other one in the column.
	const header = screen.queryByText(I18n.t("ui_maps"));
	if (header) fireEvent.click(header);
	return { onRename, view };
}

/** Opens the rename field of one map and returns it. */
function startRename(name: string): HTMLInputElement {
	fireEvent.click(screen.getByLabelText(`${I18n.t("ui_map_rename")}: ${name}`));
	return screen.getByLabelText(I18n.t("ui_map_rename")) as HTMLInputElement;
}

describe("MapsPanel", () => {
	it("stays away entirely when the robot listed no maps", () => {
		const { view } = renderPanel(model({ maps: [] }));
		expect(view.container.innerHTML).toBe("");
	});

	it("lists every map the robot has", () => {
		renderPanel(model());

		expect(screen.getByText("Erdgeschoss")).toBeTruthy();
		expect(screen.getByText("Keller")).toBeTruthy();
	});

	it("offers a rename on a robot with a single map", () => {
		// The case the floor selector cannot serve: it is filled from `commands.load_multi_map`, which
		// the adapter only creates when `max_multi_map > 1`, and it hides itself below two entries.
		renderPanel(model({ maps: [{ mapFlag: 0, name: "Erdgeschoss", addTime: null, backupCount: 0, lastBackupTime: null }] }));

		expect(screen.getByLabelText(`${I18n.t("ui_map_rename")}: Erdgeschoss`)).toBeTruthy();
	});

	it("names a slot the robot never named without pretending it has a name", () => {
		renderPanel(model({ maps: [{ mapFlag: 2, name: null, addTime: null, backupCount: 0, lastBackupTime: null }] }));

		expect(screen.getByText("Map 2")).toBeTruthy();
		// The field opens empty rather than pre-filled with the placeholder, which would offer to
		// store "Map 2" as a real name at the touch of one key.
		expect(startRename("Map 2").value).toBe("");
	});

	it("marks the map the robot is on, in the selector's own wording", () => {
		renderPanel(model(), 1);
		expect(screen.getByText(`Keller ● ${I18n.t("ui_floor_active")}`)).toBeTruthy();
	});

	it("hides the rename completely when the adapter published no command", () => {
		renderPanel(model({ renameSupported: false }));

		expect(screen.getByText("Erdgeschoss")).toBeTruthy();
		expect(screen.queryByLabelText(`${I18n.t("ui_map_rename")}: Erdgeschoss`)).toBeNull();
	});

	it("sends the trimmed name on Enter", () => {
		const { onRename } = renderPanel(model());
		const field = startRename("Keller");

		fireEvent.change(field, { target: { value: "  Untergeschoss  " } });
		fireEvent.keyDown(field, { key: "Enter" });

		expect(onRename).toHaveBeenCalledWith(1, "Untergeschoss");
	});

	it("throws the draft away on Escape", () => {
		const { onRename } = renderPanel(model());
		const field = startRename("Keller");

		fireEvent.change(field, { target: { value: "Untergeschoss" } });
		fireEvent.keyDown(field, { key: "Escape" });

		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByText("Keller")).toBeTruthy();
	});

	it("refuses fifteen umlauts, which are fifteen characters and thirty bytes", () => {
		// The rule that no ASCII test can check. A room name of this length would be allowed; a map
		// name is not, and the two limits are both spelled 30.
		const { onRename } = renderPanel(model());
		const field = startRename("Keller");

		fireEvent.change(field, { target: { value: "ü".repeat(15) } });
		fireEvent.keyDown(field, { key: "Enter" });

		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByText(I18n.t("ui_map_name_too_long").replace("%s", "30"))).toBeTruthy();
	});

	it("refuses a name another map already carries", () => {
		const { onRename } = renderPanel(model());
		const field = startRename("Keller");

		fireEvent.change(field, { target: { value: "Erdgeschoss" } });
		fireEvent.keyDown(field, { key: "Enter" });

		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByText(I18n.t("ui_map_name_duplicate"))).toBeTruthy();
	});

	it("shows the byte count while the name is fine", () => {
		renderPanel(model());
		const field = startRename("Keller");

		fireEvent.change(field, { target: { value: "Büro" } });
		// Four characters, five of the app's bytes - which is the number the robot goes by.
		expect(screen.getByText(I18n.t("ui_map_name_bytes").replace("%s", "5").replace("%s", "30"))).toBeTruthy();
	});

	it("reports a backup without offering to do anything with it", () => {
		renderPanel(model());

		// One map has a backup, the other has none, and neither row carries a button.
		expect(screen.getByText(new RegExp(I18n.t("ui_map_backup_count").replace("%s", "1")))).toBeTruthy();
		for (const button of screen.getAllByRole("button")) {
			expect(button.textContent ?? "").not.toContain("Backup");
		}
	});
});
