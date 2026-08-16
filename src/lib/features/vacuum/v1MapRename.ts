import { MAX_MAP_NAME_LENGTH, mapNameLength } from "../../../common/mapNameLength";
import type { FeatureDependencies } from "../baseDeviceFeatures";
import type { MapInventory, MapSlot } from "./v1MapInventory";

/**
 * Renaming a stored map: `name_multi_map`.
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`.
 *
 * ## The payload, and the trap in it
 *
 * The wrapper hands its argument straight to the transport and therefore proves nothing about the
 * shape:
 *
 * ```js
 * // A65:229457-229472
 * r2 = Methods.NameMultiMap;   // -> "name_multi_map"
 * r1 = a0;                     // the argument, unchanged
 * ```
 *
 * The caller is the evidence, and it builds a **list**:
 *
 * ```js
 * // A65:461846-461858, 'editMapName'
 * editMapName(multi_map, name, length) {
 *   nameMultiMap([{ multi_map, name, length }]);
 * }
 * ```
 *
 * So the payload is **an array holding one object**, not the bare object. A flat
 * `{multi_map, name, length}` looks right against the wrapper alone and is wrong; the nesting only
 * appears one level up.
 *
 * ## `length` is not the number of characters
 *
 * The screen that drives the rename measures the name before it sends it:
 *
 * ```js
 * // A65:920010-920038, 'onTapRoomNameConfirm'
 * const encoded = specEncode(rawName);
 * if (encoded === "") return;                       // silently does nothing
 * const len = FloorMapPageUtils.getRealLength(encoded);
 * if (len < 30) requestEditingMapName(editingNameMap.id, encoded, len);
 * else showToast(strings.floor_map_name_too_long);
 * ```
 *
 * `getRealLength` (A65:418603-418660) is a byte count, and `mapNameLength` in
 * `src/common/mapNameLength.ts` is a literal port of it. The robot agrees: `get_multi_maps_list` on
 * the test device answers `{"name":"Erdgeschoss","length":11}` and `{"name":"Keller","length":6}`,
 * which is what that function computes for both. Write path and read path therefore speak about the
 * same number.
 *
 * **The limit is `< 30`, strictly, and counted in those bytes.** It is not the same rule as
 * `MAX_ROOM_NAME_LENGTH = 30` in `mapZoneKinds.ts`, which counts **characters** and allows exactly
 * 30 of them. Two limits, the same number, different meanings - and the difference never shows up
 * when testing with ASCII, which is why they are two constants rather than one.
 *
 * Both live under `src/common/` because the admin tab has to refuse at exactly the place this does,
 * and it cannot import a feature service.
 *
 * ## The name is written raw, and that is now proven rather than assumed
 *
 * `specEncode(s)` is `isSpecSupported() ? global.escape(s) : s`, so on a host where that predicate
 * holds the app stores map names percent-escaped. It does not hold in the Roborock app:
 *
 * ```js
 * // A65:182830-182848, all of module 438 (lines 176421-185678)
 * isSpecSupported() = _closure1_slot21 && (isA14orA15() || isA19())
 * // A65:185232-185234 and A65:185247-185249
 * _closure1_slot16 = NativeModules.RRPluginSDK
 * _closure1_slot21 = !_closure1_slot16          // exported as `isMiApp`
 * ```
 *
 * The model half is two fixed lists (A65:178869-178886): `a14`, `a14v2`-`a14v5`, `a15`,
 * `a15v2`-`a15v5` and `a19`, `a19v2`-`a19v5`. The half in front of it is the **absence** of
 * Roborock's own native bridge, which is what the plugin calls running inside Mi Home. In the
 * Roborock app that bridge is present - the same module dereferences it for
 * `isSmartSceneSupported` and requires it for `isSupport3DMap`, and a Roborock app without 3D maps
 * is not the app this plugin was read out of - so `isSpecSupported()` is falsy there for **every**
 * model, escaping included.
 *
 * Therefore the adapter sends the name exactly as it was given, and reads it back exactly as the
 * robot returns it. The one honest limit: the inference above is that `RRPluginSDK` exists in the
 * Roborock app, read from how the module uses it rather than from an assignment. A user who renames
 * a map from **Mi Home** on one of those 18 models would store an escaped name, and this adapter
 * would show it escaped - see task #72. Guessing at that here would be worse: `escape()` leaves
 * ASCII untouched, so a wrong guess is invisible until the first umlaut.
 */

/** RPC that renames a stored map. */
export const NAME_MULTI_MAP = "name_multi_map";

/** One rename, as it was asked for. */
export interface MapRenameRequest {
	/** Slot to rename, the `mapFlag` of `get_multi_maps_list`. */
	mapFlag: number;
	/** New name, already trimmed. */
	name: string;
}

/** One entry of the `name_multi_map` payload. */
export interface NameMultiMapEntry {
	multi_map: number;
	name: string;
	length: number;
}

/**
 * Reads what was written into the command state.
 *
 * Accepts `{"mapFlag": 0, "name": "Cellar"}` and the wire spelling `multi_map` for the slot, so
 * that somebody copying the payload out of the analysis is not caught out. A one element array is
 * unwrapped as well, because that is the shape the method itself sends.
 *
 * Nothing is defaulted. A rename without a slot could only mean "the active one", and guessing that
 * would rename the wrong floor on a robot that has just switched maps.
 *
 * @param params Raw value of the command state, a JSON string or the parsed value.
 * @returns The request.
 * @throws When the value is not a rename this adapter is willing to send.
 */
export function parseMapRenameRequest(params: unknown): MapRenameRequest {
	let value: unknown = params;
	if (typeof value === "string") {
		const text = value.trim();
		if (text === "") throw new Error(`${NAME_MULTI_MAP} needs a payload such as {"mapFlag": 0, "name": "Cellar"}.`);
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error(`${NAME_MULTI_MAP} could not read '${text}' as JSON; it expects {"mapFlag": 0, "name": "Cellar"}.`);
		}
	}

	while (Array.isArray(value) && value.length === 1) value = value[0];

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${NAME_MULTI_MAP} expects an object such as {"mapFlag": 0, "name": "Cellar"}.`);
	}
	const record = value as Record<string, unknown>;

	const rawFlag = record.mapFlag ?? record.multi_map ?? record.map_flag;
	if (rawFlag === undefined || rawFlag === null || rawFlag === "") {
		throw new Error(`${NAME_MULTI_MAP} needs a 'mapFlag' - the slot to rename, as listed under mapInventory and floors.`);
	}
	const mapFlag = Number(rawFlag);
	if (!Number.isInteger(mapFlag) || mapFlag < 0) {
		throw new Error(`${NAME_MULTI_MAP}: '${String(rawFlag)}' is not a map slot; it has to be a whole number of 0 or more.`);
	}

	if (typeof record.name !== "string") {
		throw new Error(`${NAME_MULTI_MAP} needs a 'name' as text.`);
	}
	const name = record.name.trim();
	if (name === "") {
		// The app's own behaviour is to do nothing at all here (A65:920014-920020). Saying so is
		// better than silence: a command state that swallows a write looks exactly like one that
		// worked.
		throw new Error(`${NAME_MULTI_MAP}: the name is empty. The robot keeps the current one; there is nothing to send.`);
	}

	const length = mapNameLength(name);
	if (length >= MAX_MAP_NAME_LENGTH) {
		throw new Error(
			`${NAME_MULTI_MAP}: '${name}' is ${length} bytes long and the robot takes less than ${MAX_MAP_NAME_LENGTH}. `
			+ "The count is the app's own: one per character up to U+0080, two below U+0800, three above, four for the first half of an emoji."
		);
	}

	return { mapFlag, name };
}

/**
 * Builds the payload, in the nesting the caller in the app uses.
 * @param request The rename.
 * @returns `[{multi_map, name, length}]`.
 */
export function buildNameMultiMapPayload(request: MapRenameRequest): NameMultiMapEntry[] {
	return [{ multi_map: request.mapFlag, name: request.name, length: mapNameLength(request.name) }];
}

/**
 * Checks a rename against the map list the robot last sent.
 *
 * Both refusals are the app's own, in the order it applies them (A65:919952-920008): a slot it does
 * not know, and a name another map already carries. The second deliberately ignores the map being
 * renamed, so re-sending a name a map already has is allowed - the app allows it too, and refusing
 * it would turn a harmless repeat into an error.
 *
 * @param request The rename.
 * @param slots What `get_multi_maps_list` last reported.
 * @returns A refusal, or null when the rename may go out.
 */
export function checkAgainstMapList(request: MapRenameRequest, slots: readonly MapSlot[]): string | null {
	if (slots.length === 0) {
		return `${NAME_MULTI_MAP}: the robot has not listed any maps yet. Press queries.get_multi_maps_list and try again.`;
	}

	if (!slots.some((slot) => slot.mapFlag === request.mapFlag)) {
		const known = slots.map((slot) => slot.mapFlag).join(", ");
		return `${NAME_MULTI_MAP}: this robot has no map ${request.mapFlag}. It lists ${known}.`;
	}

	const clash = slots.find((slot) => slot.mapFlag !== request.mapFlag && slot.name === request.name);
	if (clash) {
		return `${NAME_MULTI_MAP}: map ${clash.mapFlag} is already called '${request.name}'. The app refuses a duplicate name as well.`;
	}

	return null;
}

/**
 * What the robot's map list says about a rename that was sent.
 *
 * | | meaning |
 * | --- | --- |
 * | `confirmed` | the slot now carries the requested name |
 * | `ineffective` | the slot is still there and carries something else |
 * | `no_answer` | the list could not be read, or no longer holds the slot |
 */
export type RenameVerdict =
	| { kind: "confirmed" }
	| { kind: "ineffective"; reported: string }
	| { kind: "no_answer"; reason: string };

/**
 * Judges a rename by the list, never by the answer to the rename itself.
 *
 * `name_multi_map` has no documented reply, and `classifyRobotAnswer` only tests `set_*` methods -
 * so whatever the robot says here is read as "accepted", which is true and says nothing about the
 * name. The same reasoning as when the schedules were deleted: only the freshly read list counts.
 *
 * @param request   What was asked for.
 * @param inventory The list as it reads now, or null when it could not be read.
 * @returns The verdict.
 */
export function judgeRename(request: MapRenameRequest, inventory: MapInventory | null): RenameVerdict {
	if (!inventory) {
		return { kind: "no_answer", reason: "the map list could not be read back" };
	}

	const slot = inventory.maps.find((entry) => entry.mapFlag === request.mapFlag);
	if (!slot) {
		return { kind: "no_answer", reason: `map ${request.mapFlag} is no longer in the list` };
	}

	if (slot.name === request.name) return { kind: "confirmed" };
	return { kind: "ineffective", reported: slot.name === null ? "no name" : `'${slot.name}'` };
}

/** What the service needs from the inventory it shares a list with. */
export interface MapListSource {
	/** The list as it was last read, or null before the first read. */
	lastInventory(): MapInventory | null;
	/** Asks the robot again and publishes what it says; returns the fresh list, or null. */
	rereadMapList(): Promise<MapInventory | null>;
}

/**
 * Renames a stored map, and lets the robot's own list say whether it worked.
 *
 * Holds no timer and no subscription, so there is nothing for `onUnload` to clean up. Its one
 * command is registered from `initMapInventory`, which runs only for a robot that answered
 * `get_multi_maps_list` - see the feature class for why that is the right gate.
 */
export class V1MapRenameService {
	/**
	 * The rename still waiting for the list to be read back, or null.
	 *
	 * One slot rather than a queue, because there is one command state and every verdict lands on
	 * it: a second rename sent before the first was judged would overwrite the first one's mark
	 * anyway. Keeping only the newest says that plainly instead of writing two verdicts in a row and
	 * letting the later one win by accident. A rename whose request never came back leaves an entry
	 * here that the next one replaces - it is never judged, and `requestsHandler` has already marked
	 * the failure on the same state.
	 */
	private pending: MapRenameRequest | null = null;

	constructor(
		private readonly deps: FeatureDependencies,
		private readonly duid: string,
		private readonly maps: MapListSource
	) {}

	/** Shorthand for a Roborock wording with an English fallback. */
	private text(key: string, fallback: string): string {
		return this.deps.adapter.translationManager.get(key, fallback);
	}

	/** Whether this service owns the method. */
	public handles(method: string): boolean {
		return method === NAME_MULTI_MAP;
	}

	/**
	 * Registers the rename command.
	 *
	 * A single JSON command rather than a writable name per floor, for the reason `name_segment`
	 * is one: the rename needs the slot **and** the name together, and a per-floor text state would
	 * fire on every keystroke that an editor writes through.
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		// `type: "json"` is this adapter's own spelling for "a string holding JSON"; `processCommand`
		// turns it into `string` with `role: "json"`, exactly as `name_segment` is declared.
		addCommand(NAME_MULTI_MAP, {
			type: "json",
			role: "json",
			def: "",
			name: `${this.text("set_map_name", "Name Map")} ({"mapFlag": 0, "name": "Cellar"})`,
			desc: this.renameHint()
		});
	}

	/**
	 * What the command state says about itself.
	 *
	 * The adapter's own sentence, so it lives in `admin/i18n/<lang>.json` like every other one; the
	 * command's *title* comes from Roborock's catalogue instead, because they have a word for it.
	 * `%s` is the limit, kept out of the translations so that changing the constant cannot leave
	 * eleven files claiming the old number.
	 * @returns The description for the state.
	 */
	private renameHint(): string {
		const text = this.deps.adapter.translations["map_rename_hint"] || V1MapRenameService.RENAME_HINT_EN;
		return text.replace("%s", String(MAX_MAP_NAME_LENGTH));
	}

	/** English wording of {@link V1MapRenameService.renameHint}; see `map_rename_hint`. */
	private static readonly RENAME_HINT_EN =
		"Renames one of the robot's stored maps: {\"mapFlag\": 0, \"name\": \"Cellar\"}. The name has to be shorter "
		+ "than %s bytes as the app counts them - a plain letter counts one, an umlaut two, most other characters "
		+ "three - and no other map may already carry it; both are refused before anything is sent. The call has no "
		+ "reply of its own, so the map list is read back afterwards and only that decides whether the rename took.";

	/**
	 * Builds the request, refusing everything the app refuses.
	 *
	 * This is where the length limit bites. It has to be here rather than at the robot: a name the
	 * firmware silently truncates or drops would leave the adapter showing a rename that never
	 * happened, and the failure would arrive as a missing change rather than as a message.
	 *
	 * @param method Method as registered.
	 * @param params Raw value of the command state.
	 * @returns Method and payload for `requestsHandler`.
	 * @throws When the rename is refused; the message reaches the user through the command state.
	 */
	public buildCommandParams(method: string, params: unknown): { method: string; params: unknown } {
		const request = parseMapRenameRequest(params);

		const inventory = this.maps.lastInventory();
		const refusal = checkAgainstMapList(request, inventory ? inventory.maps : []);
		if (refusal) throw new Error(refusal);

		this.pending = request;
		this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
			`Renaming map ${request.mapFlag} to '${request.name}' (${mapNameLength(request.name)} bytes of ${MAX_MAP_NAME_LENGTH}).`, "info");

		return { method, params: buildNameMultiMapPayload(request) };
	}

	/**
	 * Reads the map list back and writes the verdict onto the command state.
	 *
	 * Called once the robot has answered the rename. There is no waiting period: the answer has
	 * already arrived, and a timer would be one more thing for `onUnload` to hold. If the robot
	 * needs longer than that to publish the new name, the verdict says `ineffective` - which is
	 * wrong in that one case, and the next read of the list corrects the state it is written on.
	 */
	public async confirmPendingRenames(): Promise<void> {
		const request = this.pending;
		if (!request) return;
		this.pending = null;

		const verdict = judgeRename(request, await this.maps.rereadMapList());

		if (verdict.kind === "confirmed") {
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
				`Map ${request.mapFlag} is now called '${request.name}'.`, "info");
			await this.mark("confirmed");
			return;
		}

		if (verdict.kind === "ineffective") {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Renaming map ${request.mapFlag} to '${request.name}' did not take: the robot still reports ${verdict.reported}.`, "warn");
			await this.mark("ineffective", ["immediately afterwards", verdict.reported]);
			return;
		}

		this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
			`Renaming map ${request.mapFlag} to '${request.name}': ${verdict.reason}, so whether it took is unknown.`, "warn");
		await this.mark("no_answer");
	}

	/**
	 * Writes one verdict onto the command state.
	 * @param outcome   The outcome, as `commandFeedback.ts` names them.
	 * @param extraArgs Further arguments of its wording.
	 */
	private async mark(outcome: "confirmed" | "ineffective" | "no_answer", extraArgs?: string[]): Promise<void> {
		try {
			await this.deps.adapter.markCommandOutcome?.(this.duid, {
				command: NAME_MULTI_MAP,
				outcome,
				folder: "commands",
				extraArgs
			});
		} catch {
			// Whatever this was about is already in the log above; a command must not fail twice.
		}
	}
}
