/**
 * The Roborock app's own icons for the suction, mop and water selectors.
 *
 * ## Where the images come from
 *
 * Nothing here is shipped with the adapter. The graphics belong to Roborock and are downloaded
 * per user from that user's own account: `AppPluginManager` pulls the device control plugin from
 * `api/v1/appplugin` and unpacks its `drawable-*` folders into the ioBroker file store under
 * `roborock/assets/<model>/`. This module only turns a reported mode value into the file name of
 * an image that may or may not already be there, which is why every consumer has to survive a
 * missing file (see `ModeIcon`).
 *
 * ## Why one family and not another
 *
 * The plugin ships several icon sets per mode: a status icon for the home screen
 * (`ic_home_mode_clean*`), a small neutral glyph (`ic_small_clean_mode*`) and the icons of the
 * app's own mode picker (`mode_setting_clean*`, `mode_setting_water*`, `clean_route_*`). The tab
 * builds a mode picker, so it uses the picker set. That set is also the only one that is both
 * themed and comes as a `normal` / `selected` pair, which is exactly what a select needs.
 *
 * ## The assignment is evidence, not guesswork
 *
 * The plugin names its images `clean0`…`clean5`, not `101`…`108`, and the two orders are not the
 * same - `clean0` is 105, not 101. Every pair below is read out of the decompiled control plugin
 * `roborock.vacuum.a65_control_v5208`, module 565, where one object literal carries a mode's
 * `strength` and its icons together; `converDisplayToMode` in the same bundle ties `cleanMode`,
 * `waterMode` and `mopMode` to `fan_power`, `water_box_mode` and `mop_mode`. Values whose icon is
 * not backed by such a finding are deliberately absent and keep rendering as plain text: an
 * unproven icon would tell the user a suction level they did not pick.
 *
 * **This file is the single place the assignment lives.** Adding a proven pair here makes it
 * appear in the UI; no component knows any asset name.
 */

/** The two variants every themed Roborock asset ships in. */
export type IconThemeType = "light" | "dark";

/** Whether the option is the one currently in effect; the app draws those two differently. */
export type IconState = "normal" | "selected";

/**
 * One image, described by the asset family it belongs to rather than by its file name.
 *
 * The families spell their names differently - `clean_route_*` carries the theme only in its
 * folder segment, the others repeat it as a suffix - so the name is derived in
 * {@link modeIconFileName} instead of being written out at every entry.
 */
export type ModeIconRef =
	/** `mode_setting_clean<index>`, the suction levels of the app's mode picker. */
	| { family: "cleanMode"; index: number }
	/** `mode_setting_water<index>`, the water levels. */
	| { family: "waterMode"; index: number }
	/** `custom_water_mode`, the user-defined water amount. */
	| { family: "waterCustom" }
	/** `clean_route_<name>`, the mop routes the app calls Standard / Deep / Deep+ / Fast. */
	| { family: "cleanRoute"; name: "daily" | "subtly" | "deep_slow" | "fast" }
	/**
	 * `icon_sc_<name>`, the three pictograms beside a saved program.
	 *
	 * `sc` is *scene*, and the whole family in the plugin is named that way - `icon_sc_deep_clean`,
	 * `icon_sc_pet_area_clean`, `icon_sc_timer` and a dozen more. These three are the ones the app
	 * puts on a preset tile.
	 *
	 * Unlike every family above, they come as **one** image per theme: no `normal` / `selected` pair,
	 * because a program tile is not an option in a picker.
	 */
	| { family: "sceneMode"; name: "clean" | "mop" | "clean_and_mop" };

/** Every asset of the control plugin starts with the project the app builds it from. */
const ASSET_PREFIX = "projects_comroborocktanos";

/**
 * Density bucket the map already reads its robot and dock graphics from, so the mode icons come
 * out of the same folder instead of introducing a second convention.
 */
export const ASSET_DENSITY_FOLDER = "drawable-mdpi";

/**
 * Models whose water levels use the vibrating-mop artwork.
 *
 * The app does not ask the robot about this. It evaluates `DM.support(MF.Mop_ShakeModule)`
 * against a model table compiled into the control plugin: module 516 lists 43 device configs,
 * each with a `shortModels` array and a `features` array; the test device sits in the `TopazSC`
 * entry (`shortModels: ['a64','a65']`, features include `Mop_ShakeModule`). The feature is
 * `mf.mop_shake_module`, described there as wiping with a vibration module - Roborock's SonicMop.
 *
 * It is therefore **not** derivable from `get_status`, `firmwareFeatures` or `new_feature_info`,
 * but it is derivable from the model string, which the adapter already publishes.
 *
 * The list is a snapshot of plugin version 5208. A model that is not in it falls back to the
 * standard artwork - newer devices may well belong here, and showing the established icons is
 * the safer error.
 */
const SHAKE_MOP_MODELS: ReadonlySet<string> = new Set([
	"roborock.vacuum.a14",
	"roborock.vacuum.a15",
	"roborock.vacuum.a26",
	"roborock.vacuum.a27",
	"roborock.vacuum.a29",
	"roborock.vacuum.a30",
	"roborock.vacuum.a46",
	"roborock.vacuum.a47",
	"roborock.vacuum.a50",
	"roborock.vacuum.a51",
	"roborock.vacuum.a52",
	"roborock.vacuum.a62",
	"roborock.vacuum.a64",
	"roborock.vacuum.a65",
	"roborock.vacuum.a66",
	"roborock.vacuum.a76",
	"roborock.vacuum.a96",
	"roborock.vacuum.a97",
]);

/**
 * Whether this model draws its water levels from the vibrating-mop artwork.
 *
 * @param model Model string as the adapter publishes it, e.g. `roborock.vacuum.a65`.
 * @returns True when the shaking-mop family applies.
 */
export function usesShakeMopIcons(model: string | null | undefined): boolean {
	return !!model && SHAKE_MOP_MODELS.has(model.trim().toLowerCase());
}

/**
 * Builds the file name of one icon.
 *
 * @param ref Which image is wanted.
 * @param themeType Light or dark, as decided by the admin theme.
 * @param state Whether this option is the current one.
 * @returns The plain file name inside the density folder.
 */
export function modeIconFileName(
	ref: ModeIconRef,
	themeType: IconThemeType,
	state: IconState,
	shakeMop = false,
): string {
	const themed = `${ASSET_PREFIX}_theme_${themeType}_resources`;
	switch (ref.family) {
		case "cleanMode":
			return `${themed}_mode_setting_clean${ref.index}_${state}_${themeType}.png`;
		case "waterMode":
			// Two families exist side by side; the app picks by device, not by value.
			return shakeMop
				? `${themed}_mode_setting_shaked_water${ref.index}_${state}_${themeType}.png`
				: `${themed}_mode_setting_water${ref.index}_${state}_${themeType}.png`;
		case "waterCustom":
			return `${themed}_custom_water_mode_${state}_${themeType}.png`;
		case "cleanRoute":
			// This family alone repeats the theme only in the folder segment, not as a suffix.
			return `${themed}_clean_route_${ref.name}_${state}.png`;
		case "sceneMode":
			// No state and no theme suffix: the plugin ships exactly one file per theme here. Checked
			// against the unpacked `roborock.vacuum.a65_control_v5208` - all six exist in
			// `drawable-mdpi/`, 4.0 to 8.7 KiB each.
			return `${themed}_icon_sc_${ref.name}.png`;
	}
}

/**
 * The scene pictogram for one cleaning mode.
 *
 * ## How far this is proven, said plainly
 *
 * **Proven:** the six files exist under the names below, and their content matches those names. The
 * light versions were looked at: `icon_sc_clean` is the app's four-lobed suction swirl,
 * `icon_sc_mop` is two water drops, and `icon_sc_clean_and_mop` is the swirl marked **1** beside the
 * drop marked **2** - literally the other two, composed in that order.
 *
 * **Proven:** the three predicates that turn `fan_power` and `water_box_mode` into one of the three
 * modes. They are quoted in `sceneCleaningMode` (`src/common/scenePresets.ts`), with their addresses
 * in the control plugin.
 *
 * **Not proven, and named as such:** that the app binds *this* mode to *that* file. No module in the
 * control plugin pulls one of the three - their only consumer is module 741, the catch-all loader
 * that registers all 381 assets (`_appanalysis/32-presets.md` §4.3). The preset tiles belong to the
 * app's home screen, which is not in this plugin; the binding would have to be read out of the main
 * APK bundle, and that was not done.
 *
 * So the assignment rests on the file names, the pictures, and the three predicates agreeing - which
 * is stronger than a guess and weaker than the rest of this file. It is recorded here rather than
 * left implicit because this file's own rule is that every assignment says what backs it.
 *
 * @param mode The mode as `src/common/scenePresets.ts` derives it.
 * @returns The icon reference.
 */
export function sceneModeIcon(mode: "vacuum" | "mop" | "vacmop"): ModeIconRef {
	if (mode === "vacuum") return { family: "sceneMode", name: "clean" };
	if (mode === "mop") return { family: "sceneMode", name: "mop" };
	return { family: "sceneMode", name: "clean_and_mop" };
}

/**
 * Resolves the URL of a scene pictogram.
 *
 * Its own entry point rather than a value in {@link MODE_ICONS}, because that table is keyed by the
 * adapter command a selector writes to and a saved program is not written through a command.
 *
 * @param assetBaseUrl Model asset folder published by the engine, or null while unknown.
 * @param mode The cleaning mode of the program, or one of its steps.
 * @param themeType Light or dark.
 * @returns A URL, or null when no asset folder is known yet.
 */
export function sceneModeIconUrl(
	assetBaseUrl: string | null,
	mode: "vacuum" | "mop" | "vacmop",
	themeType: IconThemeType
): string | null {
	if (!assetBaseUrl) {
		return null;
	}
	return `${assetBaseUrl}/${ASSET_DENSITY_FOLDER}/${modeIconFileName(sceneModeIcon(mode), themeType, "normal")}`;
}

/**
 * The proven value assignments, keyed by the adapter command the selector writes to and then by
 * the value as it appears in the object's `common.states`.
 *
 * Gaps are not an oversight - see the file comment. A value missing here renders as text, which
 * is the correct answer for as long as its icon is unproven.
 */
export const MODE_ICONS: Record<string, Record<string, ModeIconRef>> = {
	/**
	 * Suction power (`fan_power`). Note that the index is not the strength order: the app lists
	 * Gentle first, so 105 is `clean0` and only 101…104 then run upwards.
	 *
	 * Left out on purpose: 106 (Custom) and 110 (Smart) have no entry in the plugin's mode list
	 * and therefore no icon, and the legacy values 38/60/75/77/90 do not appear in it at all.
	 */
	set_custom_mode: {
		"105": { family: "cleanMode", index: 0 }, // Gentle
		"101": { family: "cleanMode", index: 1 }, // Quiet
		"102": { family: "cleanMode", index: 2 }, // Balanced
		"103": { family: "cleanMode", index: 3 }, // Turbo
		"104": { family: "cleanMode", index: 4 }, // Max
		"108": { family: "cleanMode", index: 5 } // Max+
	},

	/**
	 * Mop route (`mop_mode`). The app's own key suffixes are shuffled against this order, which is
	 * why the route is addressed by name here and never by an index.
	 *
	 * Left out on purpose: 302 (Custom) carries a label but no icon in the plugin.
	 */
	set_mop_mode: {
		"300": { family: "cleanRoute", name: "daily" }, // Standard
		"301": { family: "cleanRoute", name: "subtly" }, // Deep
		"303": { family: "cleanRoute", name: "deep_slow" }, // Deep+
		"304": { family: "cleanRoute", name: "fast" }, // Fast
		"305": { family: "cleanRoute", name: "deep_slow" } // Deep+ variant of some builds
	},

	/**
	 * Water flow (`water_box_mode`).
	 *
	 * Left out on purpose: 204 is only a "no list entry" sentinel in the plugin - the custom water
	 * amount is 207 - and 208 (Extreme) reuses another value's artwork, which would put the same
	 * icon on two different levels.
	 */
	set_water_box_custom_mode: {
		"200": { family: "waterMode", index: 0 }, // Off
		"201": { family: "waterMode", index: 1 }, // Low
		"202": { family: "waterMode", index: 2 }, // Medium
		"203": { family: "waterMode", index: 3 }, // High
		"207": { family: "waterCustom" } // Custom
	}
};

/**
 * Resolves the URL of the icon for one option of one selector.
 *
 * @param assetBaseUrl Model asset folder published by the engine, or null while unknown.
 * @param command Adapter command the selector writes, e.g. `set_custom_mode`.
 * @param value The option's value, as a string.
 * @param themeType Light or dark.
 * @param state Whether this option is the one currently in effect.
 * @returns A URL, or null when no assignment is proven or no asset folder is known yet.
 */
export function modeIconUrl(
	assetBaseUrl: string | null,
	command: string,
	value: string,
	themeType: IconThemeType,
	state: IconState = "normal"
): string | null {
	if (!assetBaseUrl) {
		return null;
	}
	const ref = MODE_ICONS[command]?.[value];
	if (!ref) {
		return null;
	}
	// The base url ends in the model folder the AppPluginManager unpacked into, so the model is
	// already here - no extra plumbing needed to decide the water artwork.
	const model = assetBaseUrl.split("/").pop() ?? null;
	const fileName = modeIconFileName(ref, themeType, state, usesShakeMopIcons(model));
	return `${assetBaseUrl}/${ASSET_DENSITY_FOLDER}/${fileName}`;
}
