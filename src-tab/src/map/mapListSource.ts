/**
 * The robot's stored maps, and renaming one of them.
 *
 * ## Why this exists beside the floor selector
 *
 * The selector in the top bar is built from the `common.states` of the command object
 * `commands.load_multi_map` (`MapEngine.populateFloors`). That is the right source for *switching*
 * and the wrong one for *managing*, for two reasons that only show up on real robots:
 *
 * 1. The adapter creates that object **only when `max_multi_map > 1`** (`V1MapService.ts:465`), and
 *    the selector hides itself below two entries. A robot with exactly one map therefore has no
 *    control at all - and it still has a map with a name.
 * 2. `populateFloors` runs when the device is switched. A name changed afterwards keeps the old
 *    label for as long as the tab stays open.
 *
 * So the list is read from `mapInventory.maps`, the state the adapter re-writes every time it reads
 * `get_multi_maps_list` - including the read that judges a rename. A new name therefore arrives
 * here by itself, through the subscription, with no reload and no second request.
 *
 * ## What it deliberately does not do
 *
 * **It does not switch maps.** That is the selector's job, and one action wants one control; a
 * second switch in a panel would let the tab and the top bar disagree about what is being looked
 * at. The panel marks which map the robot is on and leaves the switching where it was.
 *
 * **It offers no backup, restore or delete.** Not an oversight: all three are established and
 * deliberately absent, with the payloads written down in `src/lib/features/vacuum/v1MapInventory.ts`
 * - `manual_bak_map` replaces the single backup the robot keeps, `del_map` is irreversible, and
 * `recover_multi_map` overwrites the loaded map. The backup column here reports what exists; it
 * promises nothing.
 */

import { parseMapList } from "@adapter/common/mapList";
import type { MapListEntry } from "@adapter/common/mapList";
import { MAX_MAP_NAME_LENGTH, isMapNameAcceptable, mapNameLength } from "@adapter/common/mapNameLength";
import type { EngineConnection } from "../engine/types";

/** State the adapter publishes the map list in, relative to the device. */
export const MAP_LIST_STATE = "mapInventory.maps";

/** Command the rename is written to, relative to the device. */
export const MAP_RENAME_COMMAND = "name_multi_map";

/** Folder that command lives in. */
export const MAP_RENAME_FOLDER = "commands";

/** What the panel draws. */
export interface MapListModel {
	/** The slots the robot listed, in its own order. */
	maps: MapListEntry[];
	/**
	 * Whether this robot is offered a rename at all.
	 *
	 * Read from the presence of the command object rather than assumed from the list: the adapter
	 * registers `commands.name_multi_map` only for a robot that answered `get_multi_maps_list`, and
	 * an older adapter version publishes neither. False makes the rename **disappear** - the panel
	 * still lists the maps, which is worth having on its own.
	 */
	renameSupported: boolean;
}

/** Nothing read yet, and nothing to offer. */
export const EMPTY_MAP_LIST: MapListModel = { maps: [], renameSupported: false };

/**
 * Why a name cannot be sent, or `null` when it can.
 *
 * `unavailable` is the one the panel never shows, because it never offers the control in that case.
 * It exists so that a rename reaching the source anyway is refused with a reason instead of being
 * dropped quietly - a control that swallows a click looks exactly like one that worked.
 */
export type MapRenameRefusal = "empty" | "too_long" | "duplicate" | "unchanged" | "unavailable";

/**
 * Whether a typed name may be sent, and if not, why.
 *
 * Every refusal here is one the adapter makes as well (`v1MapRename.ts`), on purpose: the adapter is
 * the boundary that has to hold, and this only spares the user a round trip that would come back as
 * a red message. The wording is the panel's; the rules are not invented here.
 *
 * `unchanged` is this side's own and is not an error - re-sending the name a map already has would
 * be accepted by both the app and the adapter. It is refused because the whole point of the button
 * is to change something, and a rename that changes nothing still rewrites the robot's stored name.
 *
 * @param name    What was typed, untrimmed.
 * @param mapFlag The slot being renamed.
 * @param maps    The list as it reads now.
 * @returns The refusal, or null.
 */
export function checkMapRename(name: string, mapFlag: number, maps: readonly MapListEntry[]): MapRenameRefusal | null {
	const trimmed = name.trim();
	if (trimmed === "") return "empty";

	// **Bytes, not characters, and strictly below the limit.** `isMapNameAcceptable` is the adapter's
	// own counter, shared rather than reimplemented - fifteen umlauts are fifteen characters and
	// thirty of these bytes, so a length check on `trimmed.length` would let through the one name the
	// robot stops at. The room-name rule next door counts characters and allows exactly 30; the two
	// numbers are the same and the rules are not.
	if (!isMapNameAcceptable(trimmed)) return "too_long";

	if (maps.some((entry) => entry.mapFlag === mapFlag && entry.name === trimmed)) return "unchanged";
	if (maps.some((entry) => entry.mapFlag !== mapFlag && entry.name === trimmed)) return "duplicate";

	return null;
}

/**
 * How many of the robot's bytes a name uses.
 *
 * Re-exported so the panel counts with the same function the refusal above uses and the adapter
 * applies. A second counter beside this one is how the field would say 29 while the robot says 31.
 *
 * @param name The name as typed.
 * @returns The count the app would send alongside it.
 */
export function mapNameBytes(name: string): number {
	return mapNameLength(name);
}

/** The limit those bytes are measured against - the name has to stay **below** it. */
export const MAP_NAME_BYTE_LIMIT = MAX_MAP_NAME_LENGTH;

interface MapListHost {
	/** The list as it reads now. */
	onMapList: (model: MapListModel) => void;
	/** Something this page could not do; the adapter's own refusals arrive on the command state. */
	onError: (message: string) => void;
}

export class MapListSource {
	private stateId: string | null = null;
	private instanceId = "";
	private duid = "";
	private destroyed = false;
	private renameSupported = false;
	/** Last list handed to the host, so a rename can be checked against what the user sees. */
	private maps: MapListEntry[] = [];
	/** Raised on every device change, so a late answer for the previous robot is dropped. */
	private generation = 0;

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: MapListHost,
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 *
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device to read; an empty value clears the panel.
	 */
	public async setDevice(instanceId: string, duid: string): Promise<void> {
		if (this.destroyed) return;

		await this.unsubscribe();
		const generation = ++this.generation;

		this.instanceId = instanceId;
		this.duid = duid;
		this.maps = [];
		this.renameSupported = false;
		this.publish();
		if (!instanceId || !duid) return;

		const stateId = `${instanceId}.Devices.${duid}.${MAP_LIST_STATE}`;

		// Asked before the list is read, so the first thing the panel draws already knows whether it
		// may offer a rename. Otherwise the buttons would appear a moment after the rows, which reads
		// as the page changing its mind.
		this.renameSupported = await this.hasRenameCommand(instanceId, duid);
		if (this.destroyed || generation !== this.generation) return;

		try {
			const states = await this.connection.getStates([stateId]);
			if (this.destroyed || generation !== this.generation) return;
			this.maps = parseMapList(states?.[stateId]?.val);
		} catch {
			// A robot without the state answers with nothing. That is "no list", not a failure worth
			// putting in front of the user - the same rule the active-floor marker follows.
			this.maps = [];
		}
		this.publish();

		try {
			await this.connection.subscribeState(stateId, this.onState);
			if (this.destroyed || generation !== this.generation) {
				this.connection.unsubscribeState(stateId, this.onState);
				return;
			}
			this.stateId = stateId;
		} catch {
			// Without the subscription the list simply stops following a rename made elsewhere.
		}
	}

	/** Drops the subscription and clears the panel. */
	public destroy(): void {
		this.destroyed = true;
		void this.unsubscribe();
	}

	/**
	 * Sends one rename.
	 *
	 * The payload is the object the adapter's command state documents, `{"mapFlag": 0, "name": "..."}`;
	 * the wire shape - an array holding `{multi_map, name, length}` - is built by the adapter, which
	 * is where the byte count belongs. Nothing here waits for a verdict: `name_multi_map` has no reply
	 * of its own, the adapter judges it by re-reading the map list, and that re-read arrives at this
	 * source as a fresh state.
	 *
	 * @param mapFlag Slot to rename.
	 * @param name The new name, untrimmed.
	 * @returns The refusal that stopped it, or null when it was sent.
	 */
	public async rename(mapFlag: number, name: string): Promise<MapRenameRefusal | null> {
		if (!this.renameSupported || !this.instanceId || !this.duid) return "unavailable";

		const refusal = checkMapRename(name, mapFlag, this.maps);
		if (refusal) return refusal;

		try {
			await this.connection.sendTo(this.instanceId, "set_state", {
				duid: this.duid,
				folder: MAP_RENAME_FOLDER,
				command: MAP_RENAME_COMMAND,
				value: JSON.stringify({ mapFlag, name: name.trim() }),
			});
		} catch (e: unknown) {
			this.host.onError(e instanceof Error ? e.message : String(e));
		}
		return null;
	}

	/** Whether the adapter published the rename command for this device. */
	private async hasRenameCommand(instanceId: string, duid: string): Promise<boolean> {
		try {
			const object = await this.connection.getObject(`${instanceId}.Devices.${duid}.${MAP_RENAME_FOLDER}.${MAP_RENAME_COMMAND}`);
			return !!object;
		} catch {
			// An object that cannot be read is treated as absent, which hides the rename rather than
			// offering one that would fail at the boundary.
			return false;
		}
	}

	private readonly onState = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.maps = parseMapList(state?.val);
		this.publish();
	};

	private publish(): void {
		this.host.onMapList({ maps: this.maps, renameSupported: this.renameSupported });
	}

	private async unsubscribe(): Promise<void> {
		if (!this.stateId) return;
		const stateId = this.stateId;
		this.stateId = null;
		try {
			this.connection.unsubscribeState(stateId, this.onState);
		} catch {
			// Unsubscribing from a state that is already gone is not a failure worth reporting.
		}
	}
}
