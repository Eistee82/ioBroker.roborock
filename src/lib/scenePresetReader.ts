/**
 * Reads a Roborock scene into the shape `programs.list` publishes, and reads the robot's own
 * verdict on whether it still knows that scene.
 *
 * The whole proof chain is in `_appanalysis/32-presets.md`; what matters here is the shape.
 *
 * ## Three levels of JSON, and both ends of the second one
 *
 * A scene arrives from `GET user/scene/home/<homeId>` looking like this - the two inner `param`
 * fields are **strings**, not objects:
 *
 * ```jsonc
 * {
 *   "id": 7085747,
 *   "name": "Küche",                       // the name, and the only reliable place it appears
 *   "enabled": true,
 *   "param": "{\"triggers\":[],\"action\":{\"type\":\"S\",\"items\":[{
 *       \"id\":1, \"type\":\"CMD\",
 *       \"name\":\"Küche\",                // NOT reliable: empty for a zone scene
 *       \"entityId\":\"67KzM8yb…\",        // duid of the robot the step runs on
 *       \"param\":\"{\\\"method\\\":\\\"do_scenes_segments\\\",\\\"params\\\":{…}}\"
 *   }]}}"
 * }
 * ```
 *
 * `main.ts` already walks that for **executing** a scene (`buildSceneQueueCommands`). This module
 * walks it for **describing** one, which is the half that was missing: the target, the suction and
 * the water level were parsed straight into commands and never written anywhere a reader can see.
 *
 * ## The two traps, both measured
 *
 * 1. **`action.items[].name` is empty when the scene aims at a zone.** On the measured account
 *    "Kamin" and "Terrassentür" carry `""` there while "Küche" and "Flur" carry the name. Only the
 *    outer `name` is always right, so only the outer one is read.
 * 2. **A scene can name more than one device.** The measured account has one whose two steps both
 *    run on a second robot. `processScenes` used to take `items[0].entityId` for the whole scene;
 *    this module reports the duid **per step**, and the caller groups by it.
 *
 * ## Three payload shapes, read by structure rather than by method name
 *
 * The `params` of a step is not shaped the same for all three RPCs, measured in
 * `_appanalysis/szenen-roh.json`:
 *
 * | RPC | `params` |
 * | --- | --- |
 * | `do_scenes_segments` | `{"data":[{tid, segs:[{sid}], map_flag, fan_power, …}], "source":101}` |
 * | `do_scenes_zones` | `{"data":[{tid, zones:[{zid, repeat}], map_flag, fan_power, …}], "source":101}` |
 * | `do_scenes_app_start` | `[{fan_power, water_box_mode, mop_mode, repeat, …, source:101}]` - a bare array |
 *
 * {@link payloadRecords} therefore unwraps by looking at what is there, not at which method it is:
 * an array is the list, a `data` array is the list, a plain object is a list of one. A fourth shape
 * this build has never seen then still yields whatever it can rather than nothing.
 */

import type { Scene } from "./httpApi";
import type { ScenePresetEntry, ScenePresetStep } from "../common/scenePresets";
import { sceneCleaningMode, sceneStepTarget } from "../common/scenePresets";

/**
 * The robot's own list of scene targets it still knows.
 *
 * Read-only, and the wrapper `getScenes` sits at A65:228948-228957. Measured twice on the test
 * device, both runs identical:
 * `[{"tid":"1745006530591","map_flag":0,"zones":[{"zid":0}]}, …]`.
 *
 * The name collides with the cloud call in spirit and not in fact: this one returns **no names**,
 * only geometry. It is worth asking anyway, because a scene whose `tid` has dropped off this list -
 * after the map was rebuilt, say - is still shown by the cloud and can no longer be run.
 */
export const GET_SCENES_VALID_TIDS = "get_scenes_valid_tids";

/** Reads a non-empty string, or null. */
function textOrNull(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** Reads a finite number, or null. */
function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** True for a plain object, which is what every payload level here is except the lists. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a value that may already be parsed.
 *
 * The scene payload nests JSON strings, but the same fields arrive as objects when a caller hands
 * over an already-decoded scene. Both are accepted so that a test does not have to re-encode the
 * measurement to feed it in.
 *
 * @param value A JSON string, or the value it would decode to.
 * @returns The decoded value, or undefined when it is neither.
 */
function decode(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The per-target records inside one step's `params`, whatever shape they arrived in.
 *
 * @param params The `params` of the step's command payload.
 * @returns The records, or an empty list when there are none to read.
 */
function payloadRecords(params: unknown): Record<string, unknown>[] {
	if (Array.isArray(params)) return params.filter(isRecord);
	if (!isRecord(params)) return [];
	if (Array.isArray(params.data)) return params.data.filter(isRecord);
	return [params];
}

/** Reads the integer ids out of `segs:[{sid}]` or `zones:[{zid}]`. */
function targetIdsOf(record: Record<string, unknown>): number[] {
	const ids: number[] = [];
	for (const [listKey, idKey] of [["segs", "sid"], ["zones", "zid"]] as const) {
		const list = record[listKey];
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!isRecord(item)) continue;
			const id = finiteNumber(item[idKey]);
			if (id !== null && Number.isInteger(id)) ids.push(id);
		}
	}
	return ids;
}

/** One command of a scene, together with the robot it was addressed to. */
export interface SceneStepWithDevice {
	/** The duid of `action.items[].entityId`, or null when the item named none. */
	duid: string | null;
	step: ScenePresetStep;
}

/**
 * Reads one scene into its steps.
 *
 * Nothing is invented: a field the payload does not carry becomes null, and a step whose command
 * payload cannot be decoded is skipped rather than published as an empty command. A skipped step is
 * not silent - the caller sees fewer steps than the scene has items and may say so.
 *
 * @param scene One entry of the `getScenes` result.
 * @returns Its steps in payload order, each with the device it addresses.
 */
export function readSceneSteps(scene: Pick<Scene, "param">): SceneStepWithDevice[] {
	const outer = decode(scene.param);
	if (!isRecord(outer)) return [];

	const action = outer.action;
	const items = isRecord(action) ? action.items : undefined;
	if (!Array.isArray(items)) return [];

	const steps: SceneStepWithDevice[] = [];
	for (const item of items) {
		if (!isRecord(item) || item.type !== "CMD") continue;

		const command = decode(item.param);
		if (!isRecord(command)) continue;

		const method = textOrNull(command.method);
		if (method === null) continue;

		const duid = textOrNull(item.entityId);
		const target = sceneStepTarget(method);

		// One published step per target record. On every measured scene that is one record per item,
		// but `data` is an array in the payload and reading only its first entry is the same mistake
		// the map blocks were repaired from.
		const records = payloadRecords(command.params);
		if (records.length === 0) {
			steps.push({
				duid,
				step: { method, tid: null, target, targetIds: [], mapFlag: null, fanPower: null, waterBoxMode: null, mopMode: null, repeat: null, mode: null }
			});
			continue;
		}

		for (const record of records) {
			const fanPower = finiteNumber(record.fan_power);
			const waterBoxMode = finiteNumber(record.water_box_mode);
			steps.push({
				duid,
				step: {
					method,
					tid: textOrNull(record.tid),
					target,
					targetIds: targetIdsOf(record),
					mapFlag: finiteNumber(record.map_flag),
					fanPower,
					waterBoxMode,
					mopMode: finiteNumber(record.mop_mode),
					repeat: finiteNumber(record.repeat),
					mode: sceneCleaningMode(fanPower, waterBoxMode)
				}
			});
		}
	}
	return steps;
}

/**
 * Reads one scene into one published row per device it addresses.
 *
 * Usually that is one row. A scene whose steps run on two robots yields two, each carrying only the
 * steps that robot is asked to perform - which is what a per-device panel has to show. Starting it
 * still starts the whole scene; that is the scene's own doing and is said in the state description.
 *
 * @param scene One entry of the `getScenes` result.
 * @param fallbackDuid Device to attribute steps that name none.
 * @returns One entry per device, keyed by duid.
 */
export function readScenePreset(scene: Scene, fallbackDuid: string | null = null): Map<string, ScenePresetEntry> {
	const byDevice = new Map<string, ScenePresetEntry>();
	const id = scene.id === null || scene.id === undefined ? null : String(scene.id);
	if (id === null || id.trim() === "") return byDevice;

	for (const entry of readSceneSteps(scene)) {
		const duid = entry.duid ?? fallbackDuid;
		if (duid === null) continue;

		let row = byDevice.get(duid);
		if (!row) {
			row = {
				id,
				name: textOrNull(scene.name),
				enabled: scene.enabled === true,
				steps: [],
				// Filled in by {@link applySceneValidity} once the robot has been asked. Null until
				// then, and null for good on a robot that does not answer the getter.
				valid: null
			};
			byDevice.set(duid, row);
		}
		row.steps.push(entry.step);
	}
	return byDevice;
}

/**
 * Reads the answer of `get_scenes_valid_tids`.
 *
 * @param response Raw robot answer.
 * @returns The `tid`s the robot listed, **or null when it did not answer with a list at all** -
 *   which is what `unknown_method` and every error string look like here. Null and the empty array
 *   are different facts: the first means "not asked or not answered", the second means "the robot
 *   knows no scene targets", and only the second may mark a preset invalid.
 */
export function parseSceneValidTids(response: unknown): string[] | null {
	let payload: unknown = response;
	if (isRecord(payload) && "data" in payload) payload = payload.data;
	// The request layer unwraps single-element arrays inconsistently across the transports, so an
	// answer nested one level deeper is accepted - but only when the inner value is itself a list.
	if (Array.isArray(payload) && payload.length === 1 && Array.isArray(payload[0])) payload = payload[0];

	if (!Array.isArray(payload)) return null;

	const tids: string[] = [];
	for (const item of payload) {
		if (!isRecord(item)) continue;
		const tid = item.tid === null || item.tid === undefined ? null : String(item.tid).trim();
		if (tid !== null && tid !== "") tids.push(tid);
	}
	return tids;
}

/**
 * Marks the presets the robot still knows.
 *
 * A preset counts as valid when **every** `tid` its steps name is in the robot's list. Every, not
 * any: a two-step scene whose second target is gone runs half way and stops, and calling that
 * "valid" would put a green row on a scene that cannot finish.
 *
 * A step that names no `tid` at all - `do_scenes_app_start` names none - cannot be checked and does
 * not count against the preset. A preset made only of such steps stays `null`, because nothing about
 * it was verified.
 *
 * @param entries Rows to mark, modified in place.
 * @param validTids The robot's list, or null when it did not answer; null leaves every row untouched.
 */
export function applySceneValidity(entries: ScenePresetEntry[], validTids: string[] | null): void {
	if (validTids === null) return;
	const known = new Set(validTids);

	for (const entry of entries) {
		const checkable = entry.steps.filter((step) => step.tid !== null);
		entry.valid = checkable.length === 0 ? null : checkable.every((step) => known.has(step.tid as string));
	}
}
