import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { sceneCleaningMode } from "@adapter/common/scenePresets";
import type { ScenePresetEntry, ScenePresetStep } from "@adapter/common/scenePresets";
import { PresetsPanel } from "./PresetsPanel";
import type { ScenePresetModel } from "../scenes/presetSource";
import type { ModeModel, RoomListModel } from "../engine/types";

/**
 * The saved programs, as the user sees them.
 *
 * Four things are worth a render test rather than a comment, and each is a way the panel could
 * mislead:
 *
 *  - **It stays away when there is nothing** - the rule every panel in this column follows.
 *  - **Except in one case**: a cloud-free instance gets the panel *in order to say why* it is empty.
 *    An empty list there would read as "you have no programs", which is false.
 *  - **Only `valid === false` warns.** Null is "not asked", and marking that would put a warning on
 *    every program of every device whose firmware lacks the getter.
 *  - **A program switched off in the app is still listed and still startable**, because
 *    `do_scenes_*` does not consult the flag - hiding it would make it vanish without explanation.
 */

/** One step with the two cleaning values that decide the mode. */
function step(partial: Partial<ScenePresetStep>): ScenePresetStep {
	const fanPower = partial.fanPower ?? null;
	const waterBoxMode = partial.waterBoxMode ?? null;
	return {
		method: partial.method ?? "do_scenes_segments",
		tid: partial.tid ?? null,
		target: partial.target ?? "segment",
		targetIds: partial.targetIds ?? [],
		mapFlag: partial.mapFlag ?? 0,
		fanPower,
		waterBoxMode,
		mopMode: partial.mopMode ?? 300,
		repeat: partial.repeat ?? 1,
		mode: sceneCleaningMode(fanPower, waterBoxMode),
	};
}

/** The measured programs, reduced to what this panel reads. */
const KAMIN: ScenePresetEntry = {
	id: "12101885", name: "Kamin", enabled: true, valid: true,
	steps: [step({ method: "do_scenes_zones", target: "zone", targetIds: [1], tid: "1767377550650", fanPower: 108, waterBoxMode: 200 })],
};

const KUECHE: ScenePresetEntry = {
	id: "7085747", name: "Küche", enabled: true, valid: true,
	steps: [step({ target: "segment", targetIds: [18], tid: "1745006632377", fanPower: 104, waterBoxMode: 203 })],
};

const ROOMS: RoomListModel = {
	rooms: [
		{ segmentId: 18, name: "Küche", selected: false },
		{ segmentId: 19, name: "Flur", selected: false },
	] as RoomListModel["rooms"],
	maxNameLength: 30,
	cleanOrder: [],
};

const MODES: ModeModel[] = [{
	command: "set_custom_mode",
	labelKey: "fan_power",
	value: "104",
	options: [{ value: "104", label: "Max" }, { value: "108", label: "Max+" }],
}];

function model(overrides: Partial<ScenePresetModel> = {}): ScenePresetModel {
	return { presets: [KAMIN, KUECHE], cloudRequired: false, published: true, ...overrides };
}

function renderPanel(presets: ScenePresetModel) {
	const onStart = vi.fn();
	const view = render(
		<PresetsPanel
			presets={presets}
			rooms={ROOMS}
			modes={MODES}
			// Null on purpose in most tests: the graphics are downloaded per account, so the panel has
			// to be readable without a single icon.
			assetBase={null}
			themeType="light"
			onStart={onStart}
		/>,
	);
	const header = screen.queryByText(I18n.t("ui_presets"));
	if (header) fireEvent.click(header);
	return { onStart, view };
}

describe("PresetsPanel", () => {
	it("stays away when nothing has been published", () => {
		const { view } = renderPanel(model({ presets: [], published: false }));
		expect(view.container.innerHTML).toBe("");
	});

	it("stays away when the account has no program for this robot", () => {
		const { view } = renderPanel(model({ presets: [], published: true }));
		expect(view.container.innerHTML).toBe("");
	});

	it("appears with nothing but the reason on a cloud-free instance", () => {
		// The one exception to the rule above, and the whole point of it: the name of a program lives
		// in the account, so there can never be one here. Saying that is different from showing none.
		renderPanel(model({ presets: [], published: false, cloudRequired: true }));
		expect(screen.getByText(I18n.t("ui_presets_cloud_required"))).toBeTruthy();
	});

	it("lists the programs with the rooms they clean", () => {
		renderPanel(model());
		expect(screen.getByText("Kamin")).toBeTruthy();
		// "Küche" is both the program's name and the room it cleans, so it is on the row twice.
		expect(screen.getAllByText("Küche")).toHaveLength(2);
		// The zone program names its zone by number, because a zone has no name anywhere.
		expect(screen.getByText(I18n.t("ui_preset_target_zone").replace("%s", "1"))).toBeTruthy();
	});

	it("names the suction level in the robot's own wording", () => {
		renderPanel(model({ presets: [KAMIN] }));
		expect(screen.getByText(/Max\+/)).toBeTruthy();
	});

	it("says the mode in words even without an icon", () => {
		// `assetBase` is null here, so `ModeIcon` renders nothing at all. The row must still say what
		// the program does.
		renderPanel(model({ presets: [KAMIN] }));
		expect(screen.getByText(new RegExp(I18n.t("ui_clean_mode_vacuum")))).toBeTruthy();
	});

	it("warns only about a program the robot has forgotten", () => {
		const stale = { ...KUECHE, valid: false };
		const unchecked = { ...KAMIN, valid: null };
		renderPanel(model({ presets: [stale, unchecked] }));

		// One warning, on the one row that earned it.
		expect(screen.getAllByLabelText(I18n.t("ui_preset_stale_hint"))).toHaveLength(1);
	});

	it("lists a program switched off in the app, and says so", () => {
		renderPanel(model({ presets: [{ ...KUECHE, enabled: false }] }));
		// "Küche" is on the row twice - as the program's name and as the room it cleans - so the row
		// is identified by its start button, which carries the name once.
		expect(screen.getByLabelText(`${I18n.t("ui_preset_start")}: Küche`)).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_preset_disabled"))).toBeTruthy();
	});

	it("starts the program the button belongs to", () => {
		const { onStart } = renderPanel(model());
		fireEvent.click(screen.getByLabelText(`${I18n.t("ui_preset_start")}: Küche`));
		expect(onStart).toHaveBeenCalledWith("7085747");
		expect(onStart).toHaveBeenCalledTimes(1);
	});

	it("labels an unnamed program by its id rather than showing a blank row", () => {
		renderPanel(model({ presets: [{ ...KAMIN, name: null }] }));
		expect(screen.getByText(I18n.t("ui_preset_unnamed").replace("%s", "12101885"))).toBeTruthy();
	});

	it("says once that it never creates or edits a program", () => {
		renderPanel(model());
		expect(screen.getByText(I18n.t("ui_presets_hint"))).toBeTruthy();
	});
});
