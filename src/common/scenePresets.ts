/**
 * The shape of `programs.list`, and how to read it back.
 *
 * Here rather than beside the cloud reader in `src/lib/features/vacuum/v1Scenes.ts` for the same
 * reason `mapList.ts` is here: the admin tab draws this list and cannot import a feature module -
 * that one reaches the adapter. Only the contract between the two sides lives in this file, so a
 * change to it cannot be made on one side alone.
 *
 * ## What a "preset" is, and why the name is not on the robot
 *
 * The tiles the Roborock app shows above the map - "Kamin", "Küche", "Terrassentür", "Flur" on the
 * test account - are **scenes**, and that is established from both ends
 * (`_appanalysis/32-presets.md` §1): the cloud call `GET user/scene/home/<id>` returns those four
 * names with their full payload, and the robot's own `get_scenes_valid_tids` returns exactly the
 * four matching `tid`s with the same targets. The two other candidates are ruled out **on the test
 * device**: `get_mop_template_params_summary` answers `unknown_method` and `get_customize_clean_mode`
 * answers `[]`.
 *
 * The consequence runs through everything below: **the name exists only in the cloud.** The robot
 * knows a `tid` and a target and nothing else - no name, no suction level, no water level. So in
 * "local only" operation there are no presets at all, and that is a property of the thing rather
 * than a gap in this build. Whoever renders the list has to say so instead of showing an empty one.
 *
 * ## Why the list is one JSON state
 *
 * The same reason `mapInventory.maps` is: the entries come and go with what the user does in the
 * app, and a reader needs them **at once** to draw a list. The per-scene folders under
 * `programs.<id>.*` are written from the same parse in the same pass, for ioBroker scripts; the two
 * therefore cannot disagree.
 *
 * The state is a JSON string, so it reaches the browser as text nobody validated on the way.
 * {@link parseScenePresetList} is written to survive anything - an empty state before the first
 * read, an older adapter that never wrote it, a value edited by hand - and to drop what it cannot
 * read rather than to throw.
 */

/** Folder the saved programs of a device live in. Unchanged; `processScenes` has always used it. */
export const PROGRAMS_FOLDER = "programs";

/** State the whole list is published in, relative to the device. */
export const SCENE_PRESET_LIST_STATE = `${PROGRAMS_FOLDER}.list`;

/**
 * What one step of a scene aims at.
 *
 * `all` is `do_scenes_app_start`, which carries no target at all - the robot cleans everything. It
 * is a third case rather than an empty `segment`, because "no rooms named" and "the whole flat" are
 * different instructions.
 */
export type ScenePresetTarget = "segment" | "zone" | "all";

/**
 * Which of the app's three mode icons a step belongs to.
 *
 * See {@link sceneCleaningMode} for how it is derived and what is proven about that derivation.
 */
export type ScenePresetMode = "vacuum" | "mop" | "vacmop";

/**
 * One command of a scene.
 *
 * A scene is a list of these, not a single command: the measured account has one whose two steps
 * vacuum the flat and then mop it (`_appanalysis/szenen-roh.json`, scene 4841021). Publishing one
 * flattened command would have silently dropped the second half.
 */
export interface ScenePresetStep {
	/** The RPC the cloud payload names, e.g. `do_scenes_segments`. Passed through verbatim. */
	method: string;
	/**
	 * Identifier the robot gave this scene target, or null when the step carries none.
	 *
	 * It is a string in the payload and stays one. The measured values are 13-digit millisecond
	 * stamps, which is beyond what a double holds exactly, and it is compared against
	 * `get_scenes_valid_tids` - a comparison that must not depend on how a number was rounded.
	 */
	tid: string | null;
	/** What the step aims at, or null when the method is not one of the three known ones. */
	target: ScenePresetTarget | null;
	/** Segment ids for `segment`, zone ids for `zone`, empty for `all`. */
	targetIds: number[];
	/** Which stored map the step belongs to, or null when it names none. */
	mapFlag: number | null;
	/** `fan_power` of the step, or null. */
	fanPower: number | null;
	/** `water_box_mode` of the step, or null. */
	waterBoxMode: number | null;
	/** `mop_mode` of the step, or null. */
	mopMode: number | null;
	/** How often the step repeats, or null. */
	repeat: number | null;
	/** The derived mode, or null when the two values do not decide it. */
	mode: ScenePresetMode | null;
}

/** One saved program, as `programs.list` publishes it. */
export interface ScenePresetEntry {
	/** Scene id in the Roborock account; also the folder under `programs`. */
	id: string;
	/**
	 * The name the user gave it, or null.
	 *
	 * The **outer** `name` of the scene, never `action.items[].name`: the inner one is empty for a
	 * zone scene. Measured - "Kamin" and "Terrassentür" have `""` there while "Küche" and "Flur"
	 * carry the name (`_appanalysis/32-presets.md` §2).
	 */
	name: string | null;
	/** Whether the scene is switched on in the account. */
	enabled: boolean;
	/** Its commands, in the order the cloud lists them. */
	steps: ScenePresetStep[];
	/**
	 * Whether the robot still knows this scene's targets - true, false, or **null for "not asked"**.
	 *
	 * Three answers rather than two, and the third is the important one. The check compares the
	 * step's `tid` against `get_scenes_valid_tids`; a robot that does not answer that call has not
	 * said the scene is invalid, it has said nothing. Turning silence into `false` would put a
	 * warning on every preset of every device whose firmware lacks the getter.
	 */
	valid: boolean | null;
}

/** Reads a finite number, or null. States carry whatever was written, including strings. */
function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Reads a non-empty string, or null. */
function textOrNull(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** `water_box_mode` the app reads as "no water at all". */
export const WATER_BOX_MODE_OFF = 200;

/** `fan_power` the app reads as "no suction", which is what its mop-only mode sets. */
export const FAN_POWER_MOP_ONLY = 105;

/**
 * Which of the three mode icons a step belongs to.
 *
 * ## Where the rule comes from
 *
 * The app has no field for it - it computes the mode from `fan_power` and `water_box_mode`. The
 * three predicates are in module 585 of the a65 control plugin and are quoted in
 * `_appanalysis/16-reinigungsmodi.md` §3.1 and `_appanalysis/32-presets.md` §4.1:
 *
 * | Predicate | Fundstelle | Rule |
 * | --- | --- | --- |
 * | `isPureCleanMode(waterMode)` | A65:244587-244608 | `pureCleanMop && waterMode === 200` |
 * | `isPureMopMode(cleanMode)` | A65:244610-244631 | `pureCleanMop && cleanMode === 105` |
 * | `isCleanMopMode(clean, water)` | A65:244633-244666 | `pureCleanMop && clean !== 105 && water !== 200` |
 *
 * They are tested in that order here, which is the order they are declared in - it matters for the
 * one input that satisfies the first two at once (`fan 105`, `water 200`), where the app's own
 * evaluation reaches `isPureCleanMode` first.
 *
 * ## Two things this deliberately does not do
 *
 * **It does not evaluate `pureCleanMop`.** That is a device capability the app reads off its own
 * model table, and it gates all three predicates equally - so it decides whether the app shows any
 * of these modes, not which one. Leaving it out can therefore name a mode for a device whose app
 * would show none; it cannot name the wrong one of the three.
 *
 * **The step from a mode to a *file name* is not proven.** The three images exist and are named
 * `icon_sc_clean`, `icon_sc_mop` and `icon_sc_clean_and_mop`, and their content matches those names
 * (the combined one is literally the other two, numbered 1 and 2). But no module in the control
 * plugin pulls one of them: their only consumer is the bundle's catch-all asset loader
 * (`_appanalysis/32-presets.md` §4.3). The binding lives in the app's main bundle, which was not
 * searched. That chain is open, and it is named as open in `modeIcons.ts` as well.
 *
 * @param fanPower `fan_power` of the step, or null when it carries none.
 * @param waterBoxMode `water_box_mode` of the step, or null.
 * @returns The mode, or **null when the two values do not decide it** - which includes every case
 *   where one of them is missing and the other one alone is not conclusive.
 */
export function sceneCleaningMode(fanPower: number | null, waterBoxMode: number | null): ScenePresetMode | null {
	// First, and on the water value alone: this is the one predicate that does not read `fan_power`,
	// so it answers even for a step that names no suction level.
	if (waterBoxMode === WATER_BOX_MODE_OFF) return "vacuum";

	// Second, and it needs both: `isPureMopMode` reads only `cleanMode`, but it is reached only when
	// the predicate above did not match - and "did not match" is not established while the water
	// value is unknown.
	if (waterBoxMode === null || fanPower === null) return null;

	if (fanPower === FAN_POWER_MOP_ONLY) return "mop";
	return "vacmop";
}

/** The three RPCs a scene step was measured to use. Anything else is passed through unclassified. */
const STEP_TARGETS: Record<string, ScenePresetTarget> = {
	do_scenes_segments: "segment",
	do_scenes_zones: "zone",
	do_scenes_app_start: "all"
};

/**
 * What a scene step aims at, from the RPC name.
 *
 * @param method The method the cloud payload names.
 * @returns The target kind, or null for a method this build has not seen.
 */
export function sceneStepTarget(method: string): ScenePresetTarget | null {
	return STEP_TARGETS[method] ?? null;
}

/**
 * Reads the value of `programs.list`.
 *
 * @param raw The state value: the JSON string the adapter writes, or the parsed array.
 * @returns The presets it could read, in the published order; an empty list for anything else.
 */
export function parseScenePresetList(raw: unknown): ScenePresetEntry[] {
	let value: unknown = raw;
	if (typeof value === "string") {
		const text = value.trim();
		if (text === "") return [];
		try {
			value = JSON.parse(text);
		} catch {
			// An unparsable state is "no list", not an error to put in front of the user: the panel
			// stays away, exactly as it does for an adapter that never wrote the state.
			return [];
		}
	}

	if (!Array.isArray(value)) return [];

	const entries: ScenePresetEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;

		// A row without an id is dropped rather than given an invented one: the id is what a start is
		// addressed to, and a wrong one would run somebody else's scene.
		const id = textOrNull(record.id);
		if (id === null) continue;

		entries.push({
			id,
			name: textOrNull(record.name),
			enabled: record.enabled === true,
			steps: parseSteps(record.steps),
			valid: typeof record.valid === "boolean" ? record.valid : null
		});
	}
	return entries;
}

/** Reads the `steps` array of one published row; anything unreadable becomes an empty list. */
function parseSteps(raw: unknown): ScenePresetStep[] {
	if (!Array.isArray(raw)) return [];

	const steps: ScenePresetStep[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;

		const method = textOrNull(record.method);
		if (method === null) continue;

		const targetIds: number[] = [];
		if (Array.isArray(record.targetIds)) {
			for (const entry of record.targetIds) {
				const parsed = finiteNumber(entry);
				if (parsed !== null && Number.isInteger(parsed)) targetIds.push(parsed);
			}
		}

		const target = record.target;
		steps.push({
			method,
			tid: textOrNull(record.tid),
			target: target === "segment" || target === "zone" || target === "all" ? target : null,
			targetIds,
			mapFlag: finiteNumber(record.mapFlag),
			fanPower: finiteNumber(record.fanPower),
			waterBoxMode: finiteNumber(record.waterBoxMode),
			mopMode: finiteNumber(record.mopMode),
			repeat: finiteNumber(record.repeat),
			// Recomputed rather than trusted, so the published value and the rule cannot drift apart:
			// an older adapter wrote no `mode` at all, and a hand-edited state could carry any word.
			mode: sceneCleaningMode(finiteNumber(record.fanPower), finiteNumber(record.waterBoxMode))
		});
	}
	return steps;
}

/**
 * The modes a preset uses, in step order and without repeats.
 *
 * A one-step scene yields one, the measured two-step scene yields `vacuum` then `mop`, and a scene
 * whose steps say nothing yields none. Callers draw one icon per entry rather than picking a single
 * mode, because there is no single mode to pick for the second case.
 *
 * @param entry One preset.
 * @returns The distinct modes, in order.
 */
export function scenePresetModes(entry: ScenePresetEntry): ScenePresetMode[] {
	const modes: ScenePresetMode[] = [];
	for (const step of entry.steps) {
		if (step.mode !== null && !modes.includes(step.mode)) modes.push(step.mode);
	}
	return modes;
}
