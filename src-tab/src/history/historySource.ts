/**
 * Reads the cleaning history of one device off the ioBroker socket and keeps it current.
 *
 * ## Why the images are not read with everything else
 *
 * A device keeps up to twenty runs, and every one of them may carry a rendered map as a base64
 * data URL of a few hundred kilobytes. Reading them all would move several megabytes into the
 * browser to show a list of twenty lines. So the bulk read skips the `map` sub-folder entirely and
 * {@link CleaningHistorySource.loadMap} fetches the single image of the run the user opened.
 *
 * ## Why the reload trigger is three states and not four hundred
 *
 * The same twenty runs are around four hundred states. Subscribing to each of them would put four
 * hundred subscriptions on the socket to learn something that changes once per cleaning run. The
 * adapter writes the whole branch in one go at the end of a run - `deviceManager.ts:530-541` calls
 * `updateCleanSummary()` when the robot parks - and each pipeline finishes that pass by writing a
 * summary state. Those are subscribed instead, and any of them changing re-reads the branch.
 */

import type { EngineConnection } from "../engine/types";
import type { CleaningHistoryModel, HistoryStateDefinition, HistoryStateValue } from "./historyTypes";
import { RECORDS_FOLDER, buildCleaningHistory, historyRoot } from "./cleaningHistory";
import { MAP_COLOR_SCHEME_STATE } from "../engine/mapOverlayColors";
import type { MapColorScheme } from "../engine/mapOverlayColors";

/**
 * States whose change means the branch was rewritten, relative to the history folder.
 *
 * `JSON` is written last by both the V1 (`v1VacuumFeatures.ts:928-942`) and the B01
 * (`B01MapService.ts:284`) pass, `record_count` is the Q10 path's own counter
 * (`Q10CleanRecordService.ts:384`) and `clean_count` is the lifetime total every pipeline updates.
 * Subscribing to all three costs nothing and means no pipeline is left without a trigger.
 */
const RELOAD_TRIGGERS = ["JSON", "record_count", "clean_count"];

/**
 * Time the source waits before re-reading after a trigger fired.
 *
 * The adapter writes several of the trigger states within the same pass, and a run that just
 * finished also moves every record folder. Collecting those into one read keeps the panel from
 * rebuilding three times in a row over a single cleaning run.
 */
const RELOAD_DEBOUNCE_MS = 400;

interface CleaningHistorySourceHost {
	/** The model, or null while no device is selected. */
	onHistory: (model: CleaningHistoryModel | null) => void;
	/** The scheme the adapter painted the stored maps in. */
	onMapColorScheme?: (scheme: MapColorScheme) => void;
}

export class CleaningHistorySource {
	private root: string | null = null;
	private language = "en";
	private destroyed = false;
	/** Raised on every device change and every reload, so a late answer of an old read is dropped. */
	private generation = 0;
	private reloadTimer: ReturnType<typeof setTimeout> | null = null;
	private subscriptions: string[] = [];
	private schemeStateId: string | null = null;

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: CleaningHistorySourceHost,
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device the history belongs to; an empty value clears the panel.
	 * @param language Admin language, used to resolve per-language object names.
	 */
	public setDevice(instanceId: string, duid: string, language: string): void {
		if (this.destroyed) return;

		this.language = language || "en";
		this.dropSubscriptions();
		this.generation++;

		if (!duid) {
			this.root = null;
			this.host.onHistory(null);
			return;
		}

		this.root = historyRoot(instanceId, duid);
		this.host.onHistory(null);

		for (const key of RELOAD_TRIGGERS) {
			const id = `${this.root}.${key}`;
			this.subscriptions.push(id);
			void this.connection.subscribeState(id, this.triggerHandler);
		}

		this.watchMapColorScheme(instanceId);
		void this.reload();
	}

	/**
	 * Subscribes to the colour scheme the adapter renders its map bitmaps in.
	 *
	 * This is **not** the tab's own light/dark mode. A stored history map is a PNG the adapter
	 * painted, and it follows the adapter's `map_color_scheme` option; the two run apart on
	 * purpose. See `engine/mapOverlayColors.ts` for the full reasoning - the panel uses it only to
	 * put the right backing behind the picture, so a dark map does not sit on a white card.
	 * @param instanceId Adapter instance the state belongs to.
	 */
	private watchMapColorScheme(instanceId: string): void {
		if (!this.host.onMapColorScheme) return;

		const id = `${instanceId}.${MAP_COLOR_SCHEME_STATE}`;
		this.schemeStateId = id;
		void this.connection.subscribeState(id, this.schemeHandler);
		void this.connection.getStates([id]).then(states => {
			if (this.destroyed) return;
			this.applyMapColorScheme(states[id]?.val);
		});
	}

	private readonly schemeHandler = (_id: string, state: { val?: unknown } | null | undefined): void => {
		this.applyMapColorScheme(state?.val);
	};

	private applyMapColorScheme(value: unknown): void {
		if (value === "light" || value === "dark") this.host.onMapColorScheme?.(value);
	}

	/** Coalesces the several writes of one adapter pass into a single re-read. */
	private readonly triggerHandler = (): void => {
		if (this.destroyed || !this.root) return;
		if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = null;
			void this.reload();
		}, RELOAD_DEBOUNCE_MS);
	};

	/** Reads the whole branch and publishes the rebuilt model. */
	public async reload(): Promise<void> {
		const root = this.root;
		if (this.destroyed || !root) return;

		const generation = ++this.generation;
		const definitions = await this.listStates(root);
		if (this.destroyed || generation !== this.generation) return;

		// The images are the expensive part and are fetched one at a time when a run is opened.
		const readable = definitions.filter(definition => !this.isMapImage(definition.id, root));
		const values = readable.length
			? ((await this.connection.getStates(readable.map(definition => definition.id))) as Record<string, HistoryStateValue | null>)
			: {};
		if (this.destroyed || generation !== this.generation) return;

		this.host.onHistory(buildCleaningHistory({ root, definitions, values, language: this.language }));
	}

	/**
	 * Fetches the rendered map of a single run.
	 * @param stateId Full id taken from `CleaningRunModel.mapStateId`.
	 * @returns The data URL, or null when the state holds nothing usable.
	 */
	public async loadMap(stateId: string): Promise<string | null> {
		const states = await this.connection.getStates([stateId]);
		if (this.destroyed) return null;
		const value = states[stateId]?.val;
		return typeof value === "string" && value.startsWith("data:image/") ? value : null;
	}

	/** True for the base64 image states, which the bulk read leaves alone. */
	private isMapImage(id: string, root: string): boolean {
		const rest = id.startsWith(`${root}.`) ? id.slice(root.length + 1) : "";
		const parts = rest.split(".");
		if (parts[0] !== RECORDS_FOLDER) return false;
		const key = parts.slice(2).join(".");
		return key === "mapBase64" || key === "map.mapBase64";
	}

	/** Lists the state objects below the history folder; an unreachable view yields an empty panel. */
	private async listStates(root: string): Promise<HistoryStateDefinition[]> {
		try {
			const prefix = `${root}.`;
			// `香` is the sentinel the map engine uses for the same purpose: a code point far
			// above anything an ioBroker id contains, so the view returns the whole sub-tree.
			const objects = await this.connection.getObjectViewSystem("state", prefix, `${prefix}香`);
			return Object.entries(objects ?? {})
				.filter(([id]) => id.startsWith(prefix) && id.length > prefix.length)
				.map(([id, value]) => ({ id: String(id), common: (value as { common?: HistoryStateDefinition["common"] })?.common ?? {} }));
		} catch {
			return [];
		}
	}

	private dropSubscriptions(): void {
		for (const id of this.subscriptions) this.connection.unsubscribeState(id, this.triggerHandler);
		this.subscriptions = [];
		if (this.schemeStateId) {
			this.connection.unsubscribeState(this.schemeStateId, this.schemeHandler);
			this.schemeStateId = null;
		}
		if (this.reloadTimer !== null) {
			clearTimeout(this.reloadTimer);
			this.reloadTimer = null;
		}
	}

	/** Drops every subscription and timer the source created. */
	public destroy(): void {
		this.destroyed = true;
		this.generation++;
		this.dropSubscriptions();
	}
}
