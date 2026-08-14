/**
 * Keeps the map current while the robot works.
 *
 * The Roborock app updates its map by polling — there is no push (report section 15, §1.1). What
 * makes it look live is not a shorter interval but a cheaper question: it asks
 * `get_dynamic_map_diff` every 1.2 s and only pulls the whole map once the answer says something
 * relevant changed. This class does the same for the adapter.
 *
 * It deliberately owns **no timer of its own**. {@link tick} is called from the one-second ticker
 * the `DeviceManager` already runs, so there is nothing extra to clear on unload; {@link dispose}
 * only drops the bookkeeping.
 *
 * Two branches exist, exactly as in the app:
 *
 *  - **Incremental** — the robot announced the feature bit and its map carries a nonce. The diff
 *    is asked for at the configured cadence, the full map follows only on a real change.
 *  - **Full map** — anything else. The app pulls a complete map every second in that case; the
 *    adapter refuses to and slows the cadence to {@link LIVE_MAP_POLICY.fullMapFloorSeconds},
 *    which leaves the behaviour where it was before this feature existed.
 */

import {
	LIVE_MAP_DISABLED,
	getLiveMapIntervalSeconds,
	isChannelUnavailableError,
	resolveLiveMapIntervalSeconds
} from "../requestPolicy";
import { MapManager } from "./MapManager";
import { buildMapDiffParams, evaluateMapDiff, supportsIncrementalMap } from "./mapDiff";

/** RPC the app uses to ask what changed since a given map nonce. */
export const MAP_DIFF_METHOD = "get_dynamic_map_diff";

/**
 * Consecutive diff failures after which a device is moved to the full-map branch for good.
 *
 * A robot that does not know the method answers with an error rather than a capability flag, so
 * this is the only way to notice. Three keeps a short network hiccup from disabling the feature.
 */
const MAX_DIFF_FAILURES = 3;

/** The part of the adapter this poller needs. Kept structural so tests can supply a stub. */
export type LiveMapAdapter = {
	config: { liveMapInterval?: number };
	requestsHandler: {
		sendRequest(duid: string, method: string, params: unknown, options?: { priority?: number; timeout?: number }): Promise<unknown>;
	};
	getStateAsync(id: string): Promise<{ val?: unknown } | null | undefined>;
	rLog(...args: any[]): void;
	errorMessage(error: unknown): string;
};

/** The part of a device feature handler this poller needs. */
export type LiveMapHandler = {
	updateMap(): Promise<void>;
};

/** Per-device bookkeeping. */
type DeviceState = {
	/** Earliest epoch ms at which this device may be checked again. */
	nextDueAt: number;
	/** A check is running; a second one must not start. */
	inFlight: boolean;
	/** Consecutive `get_dynamic_map_diff` failures. */
	diffFailures: number;
	/** The diff was given up on for this device; only full maps from here. */
	diffGaveUp: boolean;
	/** The poller completed a cycle for this device, so the status poll need not fetch the map. */
	owned: boolean;
	/** Whether the last cycle used the diff, for logging the branch only once. */
	loggedBranch: "incremental" | "full" | null;
};

export class LiveMapPoller {
	private readonly adapter: LiveMapAdapter;
	private readonly states = new Map<string, DeviceState>();
	private stopped = false;

	/**
	 * @param adapter The adapter, or a stub carrying {@link LiveMapAdapter}.
	 */
	constructor(adapter: LiveMapAdapter) {
		this.adapter = adapter;
	}

	/**
	 * Whether the live map update is switched on at all.
	 * @returns False when `liveMapInterval` is 0.
	 */
	public isEnabled(): boolean {
		return resolveLiveMapIntervalSeconds(this.adapter.config.liveMapInterval) !== LIVE_MAP_DISABLED;
	}

	/**
	 * Whether this poller is keeping the map of a device current.
	 *
	 * The status poll asks before it fetches a map of its own: two independent sources would
	 * double the transfers. The answer only becomes true after one successful cycle, so a device
	 * whose checks keep failing falls back to the status poll instead of losing map updates.
	 *
	 * @param duid Device Unique ID.
	 * @returns True when the status poll should leave the map to this poller.
	 */
	public handlesMapFor(duid: string): boolean {
		if (!this.isEnabled()) return false;
		return this.states.get(duid)?.owned === true;
	}

	/**
	 * One pass for one device. Cheap and returns immediately unless the device is due.
	 *
	 * Never throws: it runs inside the poll ticker, where an unhandled rejection would take the
	 * whole cycle down.
	 *
	 * @param duid Device Unique ID.
	 * @param handler The device's feature handler, used to fetch and store a full map.
	 * @param isActive Whether the robot is currently cleaning, returning, washing, ...
	 */
	public async tick(duid: string, handler: LiveMapHandler, isActive: boolean): Promise<void> {
		if (this.stopped) return;

		const state = this.getState(duid);
		if (state.inFlight) return;

		const now = Date.now();
		if (now < state.nextDueAt) return;

		try {
			await this.runCycle(duid, handler, isActive, state);
		} catch (error: unknown) {
			state.owned = false;
			this.adapter.rLog("MapManager", duid, "Warn", "1.0", undefined, `Live map update failed: ${this.adapter.errorMessage(error)}`, "debug");
		}
	}

	/**
	 * Decides the branch, runs it and schedules the next pass.
	 * @param duid Device Unique ID.
	 * @param handler The device's feature handler.
	 * @param isActive Whether the robot is working.
	 * @param state Bookkeeping for this device.
	 */
	private async runCycle(duid: string, handler: LiveMapHandler, isActive: boolean, state: DeviceState): Promise<void> {
		const nonce = MapManager.getMapNonce(duid);
		const incremental = !state.diffGaveUp && nonce !== null && (await this.robotAnnouncesIncrementalMap(duid));

		const intervalSeconds = getLiveMapIntervalSeconds({
			configuredSeconds: this.adapter.config.liveMapInterval,
			isActive,
			supportsIncrementalMap: incremental
		});

		if (intervalSeconds === LIVE_MAP_DISABLED) {
			state.owned = false;
			// Re-check on the normal cadence rather than on every single tick: the branch depends
			// on the robot's state, which cannot change faster than the status poll notices.
			state.nextDueAt = Date.now() + resolveLiveMapIntervalSeconds(this.adapter.config.liveMapInterval) * 1000;
			return;
		}

		// Reserve the slot before any awaiting work, so a slow answer cannot pile up ticks.
		state.nextDueAt = Date.now() + intervalSeconds * 1000;

		// While the robot re-locates itself, its map is in flux and the app stops asking as well
		// (report section 15, §1.2). Fetching here would store a map that is about to be replaced.
		if (await this.isLocating(duid)) {
			return;
		}

		this.logBranchOnce(duid, state, incremental ? "incremental" : "full", intervalSeconds);

		state.inFlight = true;
		try {
			if (!incremental) {
				await handler.updateMap();
				state.owned = true;
				return;
			}

			await this.runIncrementalCycle(duid, handler, state, nonce as number);
		} finally {
			state.inFlight = false;
			// Recompute from the end of the work, not from its start: a transfer that took longer
			// than the cadence must not make the next one due immediately.
			state.nextDueAt = Date.now() + intervalSeconds * 1000;
		}
	}

	/**
	 * Asks for the difference and fetches a full map only if the answer justifies it.
	 * @param duid Device Unique ID.
	 * @param handler The device's feature handler.
	 * @param state Bookkeeping for this device.
	 * @param nonce Nonce of the map currently held.
	 */
	private async runIncrementalCycle(duid: string, handler: LiveMapHandler, state: DeviceState, nonce: number): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.adapter.requestsHandler.sendRequest(duid, MAP_DIFF_METHOD, buildMapDiffParams(nonce), { priority: 0 });
		} catch (error: unknown) {
			this.noteDiffFailure(duid, state, error);
			return;
		}

		state.diffFailures = 0;
		state.owned = true;

		const decision = evaluateMapDiff(raw, nonce);
		if (decision.nonceStale) {
			MapManager.forgetMapNonce(duid);
		}

		if (!decision.fetchFullMap) {
			this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `Live map: ${decision.reason}, keeping the map we have.`, "debug");
			return;
		}

		this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `Live map: ${decision.reason}, fetching the full map.`, "debug");
		await handler.updateMap();
	}

	/**
	 * Records a failed diff and gives up on the method after {@link MAX_DIFF_FAILURES} in a row.
	 * @param duid Device Unique ID.
	 * @param state Bookkeeping for this device.
	 * @param error What `sendRequest` threw.
	 */
	private noteDiffFailure(duid: string, state: DeviceState, error: unknown): void {
		// A dead channel says nothing about what the robot can do; do not count it against the
		// feature, and do not claim the map either.
		if (isChannelUnavailableError(error)) {
			state.owned = false;
			return;
		}

		state.diffFailures++;
		state.owned = false;

		if (state.diffFailures < MAX_DIFF_FAILURES) {
			this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `${MAP_DIFF_METHOD} failed (${state.diffFailures}/${MAX_DIFF_FAILURES}): ${this.adapter.errorMessage(error)}`, "debug");
			return;
		}

		state.diffGaveUp = true;
		state.loggedBranch = null;
		this.adapter.rLog(
			"MapManager",
			duid,
			"Info",
			"1.0",
			undefined,
			`${MAP_DIFF_METHOD} failed ${state.diffFailures} times in a row (${this.adapter.errorMessage(error)}). This robot apparently does not support incremental maps; switching to complete map transfers at the slower cadence.`,
			"info"
		);
	}

	/**
	 * Reads the incremental map feature bit the robot reports.
	 * @param duid Device Unique ID.
	 * @returns True only when the bit is provably set.
	 */
	private async robotAnnouncesIncrementalMap(duid: string): Promise<boolean> {
		try {
			const state = await this.adapter.getStateAsync(`Devices.${duid}.deviceStatus.new_feature_info_str`);
			return supportsIncrementalMap(state?.val);
		} catch {
			return false;
		}
	}

	/**
	 * Whether the robot is currently re-locating itself.
	 *
	 * The app reads the same field: `RSM.isLocating` is `!!status.is_locating` from `get_status`,
	 * and both the diff and the map fetch are skipped while it is set.
	 *
	 * @param duid Device Unique ID.
	 * @returns True when `deviceStatus.is_locating` says so.
	 */
	private async isLocating(duid: string): Promise<boolean> {
		try {
			const state = await this.adapter.getStateAsync(`Devices.${duid}.deviceStatus.is_locating`);
			const value = state?.val;
			return value === 1 || value === true || value === "1";
		} catch {
			return false;
		}
	}

	/**
	 * Logs which branch a device ended up on, once per change.
	 * @param duid Device Unique ID.
	 * @param state Bookkeeping for this device.
	 * @param branch The branch taken.
	 * @param intervalSeconds The cadence in use.
	 */
	private logBranchOnce(duid: string, state: DeviceState, branch: "incremental" | "full", intervalSeconds: number): void {
		if (state.loggedBranch === branch) return;
		state.loggedBranch = branch;

		const message = branch === "incremental"
			? `Live map update on, checking for changes every ${intervalSeconds}s and fetching a full map only when something changed.`
			: `Live map update on, fetching a complete map every ${intervalSeconds}s: this robot does not offer the incremental map.`;
		this.adapter.rLog("MapManager", duid, "Info", "1.0", undefined, message, "info");
	}

	/**
	 * Bookkeeping for a device, created on first use.
	 * @param duid Device Unique ID.
	 * @returns The device's state record.
	 */
	private getState(duid: string): DeviceState {
		let state = this.states.get(duid);
		if (!state) {
			state = { nextDueAt: 0, inFlight: false, diffFailures: 0, diffGaveUp: false, owned: false, loggedBranch: null };
			this.states.set(duid, state);
		}
		return state;
	}

	/**
	 * Re-arms the poller after a {@link dispose}, so polling can be stopped and started again.
	 */
	public start(): void {
		this.stopped = false;
	}

	/**
	 * Stops further work and drops all bookkeeping.
	 *
	 * There is no timer to clear — the poller rides the `DeviceManager` ticker — but a cycle that
	 * is already awaiting an answer must not schedule another one after unload.
	 */
	public dispose(): void {
		this.stopped = true;
		this.states.clear();
	}
}
