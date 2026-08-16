/**
 * Turning a saved program into the two lines a tile shows.
 *
 * Separate from the panel because both of these are rules rather than layout, and both have a
 * failure mode that is worth a test: a target that names a room the current map no longer has, and a
 * suction level whose number the robot never offered as an option.
 */

import { scenePresetModes } from "@adapter/common/scenePresets";
import type { ScenePresetEntry, ScenePresetMode, ScenePresetStep } from "@adapter/common/scenePresets";
import type { ModeModel } from "../engine/types";

/** Lookup a translation and substitute the single placeholder these keys use. */
type Translate = (key: string) => string;

/** Fills the one `%s` of a phrase. */
function fill(text: string, value: string): string {
	return text.replace("%s", value);
}

/**
 * What one step of a program aims at, in words.
 *
 * The room names come from the map that is loaded, so a program made on another floor names ids this
 * map does not have. Those keep their number - `Raum 18` - rather than being dropped: a program that
 * cleans somewhere unnamed is still a program, and hiding its target would make two programs on
 * different floors look identical.
 *
 * @param step One step.
 * @param roomNames Segment id to room name, for the map currently loaded.
 * @param t Translation lookup.
 * @returns The target, or the empty string when the step names none that can be described.
 */
export function presetStepTarget(step: ScenePresetStep, roomNames: ReadonlyMap<number, string>, t: Translate): string {
	if (step.target === "all") return t("ui_preset_target_all");

	if (step.target === "segment") {
		const names = step.targetIds.map(id => roomNames.get(id) ?? fill(t("ui_preset_target_segment"), String(id)));
		return names.join(", ");
	}

	if (step.target === "zone") {
		return step.targetIds.map(id => fill(t("ui_preset_target_zone"), String(id))).join(", ");
	}

	// A method this build has not seen. Its own name is the one thing that cannot be wrong about it,
	// and it is more use to whoever reports it than an invented "unknown target".
	return step.method;
}

/**
 * What a whole program aims at, in words.
 *
 * Steps are joined with an arrow rather than a comma, because they run one after the other - the
 * measured two-step program vacuums the flat and then mops it, and "Wohnung, Wohnung" would hide
 * that entirely.
 *
 * @param entry The program.
 * @param roomNames Segment id to room name, for the map currently loaded.
 * @param t Translation lookup.
 * @returns The line, or the empty string for a program with no readable step.
 */
export function presetTarget(entry: ScenePresetEntry, roomNames: ReadonlyMap<number, string>, t: Translate): string {
	const parts: string[] = [];
	for (const step of entry.steps) {
		const text = presetStepTarget(step, roomNames, t);
		// Repeats collapse: a program whose two steps both clean the whole flat says so once. They are
		// still two steps, and the two mode icons beside the line are what shows that.
		if (text !== "" && parts[parts.length - 1] !== text) parts.push(text);
	}
	return parts.join(" → ");
}

/**
 * The label the robot itself gives a suction or water value.
 *
 * Read out of the `common.states` of the command object, which is where every other control on this
 * page takes its wording from - so "Max+" reads the same in the mode bar and on a program tile, in
 * whatever language the adapter resolved it to.
 *
 * @param modes The mode selectors as the engine published them.
 * @param command Command object to look in, e.g. `set_custom_mode`.
 * @param value The value, or null.
 * @returns The label, the bare number when the robot lists no such option, or null when there is no
 *   value at all. **Never an invented name** - an unlisted level is a level this build knows nothing
 *   about, and printing the number says exactly that much.
 */
export function presetLevelLabel(modes: readonly ModeModel[], command: string, value: number | null): string | null {
	if (value === null) return null;
	const option = modes.find(mode => mode.command === command)?.options.find(entry => entry.value === String(value));
	return option?.label ?? String(value);
}

/**
 * Translation keys of the three mode captions.
 *
 * Deliberately the **existing** keys of the cleaning-mode tab bar rather than three new ones. It is
 * the same three modes, derived from the same two values by the same predicates - a second set of
 * words for them is how the tab bar ends up saying "Wischen" while a program tile says "Moppen".
 */
const MODE_LABEL_KEYS: Record<ScenePresetMode, string> = {
	vacuum: "ui_clean_mode_vacuum",
	mop: "ui_clean_mode_mop",
	vacmop: "ui_clean_mode_vac_and_mop"
};

/**
 * The modes of a program with their captions, in step order.
 *
 * The caption travels with the icon rather than replacing it: the icon may be missing - the graphics
 * are downloaded per account and a purely local installation has none - and a tile that then shows
 * nothing at all about the mode would be worse than one showing the word.
 *
 * @param entry The program.
 * @param t Translation lookup.
 * @returns One entry per distinct mode, in the order the steps use them.
 */
export function presetModeLabels(entry: ScenePresetEntry, t: Translate): Array<{ mode: ScenePresetMode; label: string }> {
	return scenePresetModes(entry).map(mode => ({ mode, label: t(MODE_LABEL_KEYS[mode]) }));
}
