/**
 * Keeps the map current while the robot works.
 *
 * The Roborock app updates its map by polling — there is no push (report section 15, §1.1). What
 * makes it look live is not a shorter interval but a cheaper question: it asks
 * `get_dynamic_map_diff` every 1.2 s and only pulls the whole map once the answer says something
 * relevant changed. This class does the same for the adapter.
 *
 * The map side owns **no timer of its own**: {@link tick} is called from the one-second ticker the
 * `DeviceManager` runs. The position side does own timers — see below — and {@link dispose} clears
 * every one of them.
 *
 * Two branches exist for the map, exactly as in the app:
 *
 *  - **Incremental** — the robot announced the feature bit and its map carries a nonce. The diff
 *    is asked for at the configured cadence, the full map follows only on a real change.
 *  - **Full map** — anything else. The app pulls a complete map every second in that case; the
 *    adapter refuses to and slows the cadence to {@link LIVE_MAP_POLICY.fullMapFloorSeconds},
 *    which leaves the behaviour where it was before this feature existed.
 *
 * ## The position does not run on a clock at all
 *
 * {@link startDynamicCycle} drives a second, independent cycle for the dynamic channel — robot
 * position, driven track, mop markers. It used to hang off the map cycle, which made the cheapest
 * question the adapter can ask inherit the pace of the most expensive one: `refreshDynamicTrack`
 * was reachable from exactly one place inside the incremental map cycle, so the position updated at
 * the map cadence (3 s working, 6 s idle), never at all on the full-map branch, and not while a
 * map transfer held `inFlight`. Measured at the device the two are not remotely comparable — two
 * local requests of 58 ms and 57 ms against a 248 ms cloud transfer of 7 KiB.
 *
 * Then it ran on a cadence of its own, and that hit the next wall: a cadence has to guess how long
 * an answer takes, and at the rates a live view needs the guess is wrong more often than not.
 * **It is now a free-running cycle** — one pass, a pause, the next pass — so it cannot overlap
 * itself, it runs as fast as the link allows, and a slow link slows it down instead of queueing
 * work behind it. The pause comes from `LIVE_TRACK_POLICY` and is a floor, not a target.
 *
 * Two things keep that from crowding everything else out. The two requests go in at
 * {@link LIVE_TRACK_REQUEST_PRIORITY}, **below** normal, so a status poll, a map transfer or a
 * button the user pressed all overtake them; they used to go in at normal, which for a cycle this
 * busy would have been a real fault. And the cycle drops to the idle pause unless the robot is
 * actually working, and to the cloud pause unless the local socket is up.
 *
 * What the two cycles share is a single {@link DeviceState.sharedDiff} slot: when both fall due
 * within {@link DIFF_SHARE_WINDOW_MS} of each other, the second one reuses the first one's answer
 * instead of asking again. That is safe only because both send the **same** nonce — what a diff
 * reports depends on the nonce it was asked with (`PROJECT_STATE.md`, "Was der Diff meldet, hängt
 * von der übergebenen Nonce ab"), so the cache is keyed by it and a mismatch simply means each
 * cycle asks for itself.
 */

import {
	LIVE_MAP_DISABLED,
	LIVE_TRACK_DISABLED,
	LIVE_TRACK_REQUEST_PRIORITY,
	getLiveMapIntervalSeconds,
	getLiveTrackPauseMs,
	isChannelUnavailableError,
	resolveLiveMapIntervalSeconds,
	resolveLiveTrackPauseMs
} from "../requestPolicy";
import { MapManager } from "./MapManager";
import {
	DYNAMIC_DATA_BUNDLE_ID,
	DYNAMIC_DATA_METHOD,
	buildDynamicDataParams,
	parseDynamicChannels,
	parseDynamicDataResponse,
	parseDynamicSnapshot
} from "./dynamicData";
import { buildMapDiffParams, evaluateMapDiff, findOutdatedBlock, supportsIncrementalMap } from "./mapDiff";

/** RPC the app uses to ask what changed since a given map nonce. */
export const MAP_DIFF_METHOD = "get_dynamic_map_diff";

/**
 * Consecutive diff failures after which a device is moved to the full-map branch for good.
 *
 * A robot that does not know the method answers with an error rather than a capability flag, so
 * this is the only way to notice. Three keeps a short network hiccup from disabling the feature.
 */
const MAX_DIFF_FAILURES = 3;

/**
 * How long a `get_dynamic_map_diff` answer may serve the other cycle as well.
 *
 * The map cycle and the track cycle ride two different tickers, so "at the same moment" is not an
 * exact term. This is the tolerance that makes it one. It is short enough that the reused answer
 * still describes the present — the robot appends about one path point per second — and long
 * enough to catch the case the sharing exists for: both slots falling due within the same
 * {@link LIVE_TRACK_POLICY.tickMs} window.
 */
const DIFF_SHARE_WINDOW_MS = 250;

/**
 * Nonce the track cycle sends while no map with a nonce has been parsed yet.
 *
 * Measured at the device: a diff sent as `{nonce: 1, round: <epoch ms>}` is not rejected, it
 * answers with the currently valid nonce of every channel — `"3":{"max_len":71,"nonce":…}` — which
 * is exactly and only what the track cycle needs (`PROJECT_STATE.md`, "Die Nonce war aktuell").
 * The real map nonce is preferred whenever there is one, because then the answer is also usable
 * for the map cycle and one request serves both.
 */
const TRACK_DIFF_FALLBACK_NONCE = 1;

/** The part of the adapter this poller needs. Kept structural so tests can supply a stub. */
export type LiveMapAdapter = {
	config: { liveMapInterval?: number; liveTrackInterval?: number };
	requestsHandler: {
		sendRequest(duid: string, method: string, params: unknown, options?: { priority?: number; timeout?: number }): Promise<unknown>;
	};
	getStateAsync(id: string): Promise<{ val?: unknown } | null | undefined>;
	ensureState(id: string, common: Record<string, unknown>): Promise<unknown>;
	setStateChangedAsync(id: string, value: { val: unknown; ack: boolean }): Promise<unknown>;
	/**
	 * The adapter's own timer, not the global one.
	 *
	 * js-controller tracks these and complains about any that outlive the instance, which is exactly
	 * the safety net a self-rescheduling loop needs: every pause the cycle takes is a timer it owns
	 * and {@link LiveMapPoller.dispose} clears.
	 */
	setTimeout(callback: () => void, ms: number): ioBroker.Timeout | undefined;
	clearTimeout(timer: ioBroker.Timeout): void;
	rLog(...args: any[]): void;
	errorMessage(error: unknown): string;
};

/**
 * What the cycle has to ask again on every pass.
 *
 * Passed as two functions rather than two booleans because a cycle outlives the moment it was
 * started: a robot that was idle when the loop began is the normal case, and reading a snapshot
 * taken back then would keep it at the idle pace for the whole cleaning run.
 */
export type DynamicCycleContext = {
	/** Whether the robot is cleaning, returning, washing, mapping, ... */
	isActive(): boolean;
	/** Whether the local TCP session to this device is up; false means everything goes via cloud. */
	isLocal(): boolean;
};

/** State that carries the driven track, its mop markers and the robot position for the UI. */
export const LIVE_TRACK_STATE = "map.liveTrack";

/** The part of a device feature handler this poller needs. */
export type LiveMapHandler = {
	updateMap(): Promise<void>;
};

/** A `get_dynamic_map_diff` answer kept for the other cycle; see {@link DIFF_SHARE_WINDOW_MS}. */
type SharedDiff = {
	/** Nonce the answer was asked with. Reuse is only sound for the very same nonce. */
	nonce: number;
	/** The untouched answer. */
	raw: unknown;
	/** When it arrived, epoch ms. */
	at: number;
};

/** Per-device bookkeeping. */
type DeviceState = {
	/** Earliest epoch ms at which the map of this device may be checked again. */
	nextDueAt: number;
	/** A map check is running; a second one must not start. */
	inFlight: boolean;
	/** Consecutive `get_dynamic_map_diff` failures on the map cycle. */
	diffFailures: number;
	/** The diff was given up on for this device; only full maps from here. */
	diffGaveUp: boolean;
	/** The poller completed a cycle for this device, so the status poll need not fetch the map. */
	owned: boolean;
	/** Whether the last cycle used the diff, for logging the branch only once. */
	loggedBranch: "incremental" | "full" | null;
	/**
	 * A position read is running.
	 *
	 * Separate from {@link inFlight} on purpose: a full map takes seconds, and it used to hold the
	 * one shared flag for all of them, which is why the position stood still exactly while the
	 * robot was busy enough to be worth watching. The free-running cycle cannot overlap itself, so
	 * this is no longer a gate - it is what tells the outside whether a pass is in the air.
	 */
	dynamicInFlight: boolean;
	/** Consecutive `get_dynamic_map_diff` failures on the track cycle. */
	trackDiffFailures: number;
	/** The diff was given up on for the track cycle; the position is no longer read. */
	trackDiffGaveUp: boolean;
	/** The robot answered `get_dynamic_data` with an error; do not ask it again. */
	dynamicUnsupported: boolean;
	/** Last diff answer, offered to whichever cycle falls due next. */
	sharedDiff: SharedDiff | null;
};

export class LiveMapPoller {
	private readonly adapter: LiveMapAdapter;
	private readonly states = new Map<string, DeviceState>();
	private stopped = false;
	/** Pending pause of each running cycle, so `dispose` leaves no timer behind. */
	private readonly dynamicTimers = new Map<string, ioBroker.Timeout>();
	/**
	 * Devices whose cycle is meant to be running.
	 *
	 * Separate from {@link dynamicTimers} because between an answer and the next pause there is no
	 * timer, and a `stopDynamicCycle` landing in that window has to be noticed anyway - otherwise
	 * the loop would schedule one more pass after unload.
	 */
	private readonly dynamicLoops = new Set<string>();

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
	 * Whether the live position channel is switched on at all.
	 *
	 * Answered independently of {@link isEnabled}: switching the map refresh off is a statement
	 * about a 7 KiB cloud transfer and says nothing about a 300 byte local read.
	 * @returns False when `liveTrackInterval` is 0.
	 */
	public isTrackEnabled(): boolean {
		return resolveLiveTrackPauseMs(this.adapter.config.liveTrackInterval) !== LIVE_TRACK_DISABLED;
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
	 * Starts the live position cycle for one device, if it is not already running.
	 *
	 * The cycle drives itself: one pass, then a pause, then the next pass. It is **not** a fixed
	 * cadence, and the difference is the whole point. A fixed cadence has to guess how long an
	 * answer takes; at the rates this channel is asked to run at, that guess is wrong often enough
	 * to matter - a 100 ms cadence against a 55 ms median answer overlaps itself on every answer
	 * above the median. Asking again only after the previous answer has arrived cannot overlap, uses
	 * whatever speed the link actually offers, and slows down on a slow link without being told.
	 *
	 * Calling this again for a device that is already running is a no-op, so it is safe to call from
	 * anywhere that notices a device might need it.
	 *
	 * @param duid Device Unique ID.
	 * @param context Read fresh on every pass, because both answers change while the cycle runs.
	 */
	public startDynamicCycle(duid: string, context: DynamicCycleContext): void {
		if (this.stopped) return;
		if (this.dynamicTimers.has(duid) || this.dynamicLoops.has(duid)) return;

		this.dynamicLoops.add(duid);
		void this.runDynamicPass(duid, context);
	}

	/**
	 * Stops the cycle of one device and clears its pending pause.
	 * @param duid Device Unique ID.
	 */
	public stopDynamicCycle(duid: string): void {
		this.dynamicLoops.delete(duid);
		const timer = this.dynamicTimers.get(duid);
		if (timer !== undefined) {
			this.adapter.clearTimeout(timer);
			this.dynamicTimers.delete(duid);
		}
	}

	/** Stops every running cycle; called from {@link dispose}. */
	private stopAllDynamicCycles(): void {
		for (const duid of Array.from(this.dynamicTimers.keys())) this.stopDynamicCycle(duid);
		this.dynamicLoops.clear();
	}

	/**
	 * One pass of the cycle, followed by scheduling the next one.
	 *
	 * Never throws: a failed pass must pause and try again rather than tear the loop down, because
	 * the usual cause is a robot that was briefly unreachable. The cases that really are permanent -
	 * a robot that does not know the method at all - set their own flag and end the loop below.
	 *
	 * @param duid Device Unique ID.
	 * @param context The device's live answers about state and channel.
	 */
	private async runDynamicPass(duid: string, context: DynamicCycleContext): Promise<void> {
		if (this.stopped || !this.dynamicLoops.has(duid)) return;

		const pauseMs = getLiveTrackPauseMs({
			configuredPause: this.adapter.config.liveTrackInterval,
			isActive: context.isActive(),
			isLocal: context.isLocal()
		});

		const state = this.getState(duid);
		if (pauseMs === LIVE_TRACK_DISABLED || state.dynamicUnsupported || state.trackDiffGaveUp) {
			// Switched off, or this robot has proven it cannot answer. Either way the loop ends; it
			// is started again from the outside when the configuration or the device changes.
			this.stopDynamicCycle(duid);
			return;
		}

		state.dynamicInFlight = true;
		try {
			await this.runDynamicCycle(duid, state);
		} catch (error: unknown) {
			this.adapter.rLog("MapManager", duid, "Warn", "1.0", undefined, `Live position update failed: ${this.adapter.errorMessage(error)}`, "debug");
		} finally {
			state.dynamicInFlight = false;
		}

		if (this.stopped || !this.dynamicLoops.has(duid)) return;

		// Always through a timer, even at a pause of 0: `setTimeout(0)` yields to the event loop, a
		// direct recursive call would not, and a channel that answered instantly would starve
		// everything else in the process.
		const timer = this.adapter.setTimeout(() => {
			this.dynamicTimers.delete(duid);
			void this.runDynamicPass(duid, context);
		}, pauseMs);
		if (timer !== undefined) this.dynamicTimers.set(duid, timer);
		else this.stopDynamicCycle(duid);
	}

	/**
	 * Asks what the dynamic channel currently holds and fetches it when it moved.
	 *
	 * The two requests are the ones the app uses as well: `get_dynamic_map_diff` names the nonce
	 * and the length of the channel, `get_dynamic_data` returns position, path and mop markers in
	 * one answer. The diff cannot be skipped — the nonce it reports is a parameter of the second
	 * call — but it can be shared with the map cycle, see {@link readSharedDiff}.
	 *
	 * @param duid Device Unique ID.
	 * @param state Bookkeeping for this device.
	 */
	private async runDynamicCycle(duid: string, state: DeviceState): Promise<void> {
		// The same reason the map cycle skips here: while the robot re-locates itself the map it is
		// drawn on is about to be replaced, so a position in the old frame would point at the wrong
		// room rather than at nothing.
		if (await this.isLocating(duid)) return;

		// The map nonce whenever there is one, so the answer is usable for the map cycle too.
		const nonce = MapManager.getMapNonce(duid) ?? TRACK_DIFF_FALLBACK_NONCE;

		let raw: unknown;
		const shared = this.readSharedDiff(state, nonce);
		if (shared) {
			raw = shared.raw;
		} else {
			try {
				raw = await this.adapter.requestsHandler.sendRequest(duid, MAP_DIFF_METHOD, buildMapDiffParams(nonce), { priority: LIVE_TRACK_REQUEST_PRIORITY });
			} catch (error: unknown) {
				this.noteTrackDiffFailure(duid, state, error);
				return;
			}
			this.storeSharedDiff(state, nonce, raw);
		}

		state.trackDiffFailures = 0;
		await this.refreshDynamicTrack(duid, raw, state);
	}

	/**
	 * Offers the other cycle's diff answer when it is recent enough and was asked with the same
	 * nonce.
	 *
	 * The nonce equality is not a nicety: a diff describes what changed **since that nonce**, and
	 * the test device answered the same moment with different block sets depending on which nonce
	 * it was given. Reusing an answer across nonces would hand the map cycle a decision about a
	 * question it never asked.
	 *
	 * @param state Bookkeeping for this device.
	 * @param nonce The nonce this cycle would send.
	 * @returns The reusable answer, or null when there is none.
	 */
	private readSharedDiff(state: DeviceState, nonce: number): { raw: unknown } | null {
		const cached = state.sharedDiff;
		if (!cached || cached.nonce !== nonce) return null;
		if (Date.now() - cached.at > DIFF_SHARE_WINDOW_MS) return null;
		return { raw: cached.raw };
	}

	/**
	 * Keeps a diff answer for the other cycle.
	 * @param state Bookkeeping for this device.
	 * @param nonce The nonce it was asked with.
	 * @param raw The untouched answer.
	 */
	private storeSharedDiff(state: DeviceState, nonce: number, raw: unknown): void {
		state.sharedDiff = { nonce, raw, at: Date.now() };
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
		const shared = this.readSharedDiff(state, nonce);
		if (shared) {
			raw = shared.raw;
		} else {
			try {
				raw = await this.adapter.requestsHandler.sendRequest(duid, MAP_DIFF_METHOD, buildMapDiffParams(nonce), { priority: 0 });
			} catch (error: unknown) {
				this.noteDiffFailure(duid, state, error);
				return;
			}
			this.storeSharedDiff(state, nonce, raw);
		}

		state.diffFailures = 0;
		state.owned = true;

		// The track used to be fetched here, which is what tied the position to the map cadence.
		// It has its own cycle now ({@link tickDynamic}); this one is only about the raster.

		const decision = evaluateMapDiff(raw, nonce);

		// Second opinion, and the one that actually catches a frozen map. `evaluateMapDiff` believes
		// the robot's `count` fields; measured at the device those stay 0 even after the entire map
		// has been replaced, and a diff carrying a nonce the robot no longer knows is answered with
		// zeros rather than an error. The per-channel nonces do not lie: if one of them moved, the
		// map on screen is out of date no matter what the counts claim.
		let outdated: string | null = null;
		if (!decision.fetchFullMap) {
			outdated = findOutdatedBlock(this.channelNonces(raw), MapManager.getBlockNonces(duid));
		}

		if (decision.nonceStale) {
			MapManager.forgetMapNonce(duid);
		}

		if (outdated) {
			this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `Live map: ${outdated}, fetching the full map although the diff reported no change.`, "debug");
			await handler.updateMap();
			return;
		}

		if (!decision.fetchFullMap) {
			this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `Live map: ${decision.reason}, keeping the map we have.`, "debug");
			return;
		}

		this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `Live map: ${decision.reason}, fetching the full map.`, "debug");
		await handler.updateMap();
	}

	/**
	 * Pulls the per-channel nonces out of a diff answer.
	 * @param rawDiff The untouched `get_dynamic_map_diff` answer.
	 * @returns Channel number to nonce; empty when the answer carries none.
	 */
	private channelNonces(rawDiff: unknown): Map<number, number> {
		const nonces = new Map<number, number>();
		for (const [channel, state] of parseDynamicChannels(rawDiff)) {
			if (state.nonce > 0) nonces.set(channel, state.nonce);
		}
		return nonces;
	}

	/**
	 * Fetches driven track, mop markers and robot position.
	 *
	 * **It no longer asks whether the channel changed, and that is the fix for the lagging
	 * position.** It used to return early unless `hasDynamicChannelChanged` said so, and that
	 * predicate compares the nonce and `maxLen` (`dynamicData.ts:500-504`). `maxLen` is the length of
	 * the driven path, which grows about once a second - so the gate was, in effect, a one-second
	 * rate limit on the **position**, which sits in the same answer and moves continuously at up to
	 * 216 mm/s. No cadence above 1 Hz could ever have shown through it. There is nothing cheaper to
	 * ask either: the diff reports channel nonces and lengths, and neither of them says anything
	 * about the robot having moved.
	 *
	 * What the gate saved is one request of about 712 bytes per pass. That is the price of the
	 * position now being as fresh as the cycle is fast, and it is paid knowingly. Nothing extra
	 * reaches the object database: `setStateChangedAsync` writes only when the JSON differs, so a
	 * pass that fetched an unchanged track still costs no state update.
	 *
	 * Failures are deliberately quiet: this is an extra on top of the map, and a robot that does
	 * not know the method must not lose the map because of it.
	 *
	 * Called from {@link runDynamicCycle} only. It used to be called from the map cycle, which is
	 * what this class was restructured to stop.
	 * @param duid Device Unique ID.
	 * @param rawDiff The untouched `get_dynamic_map_diff` answer.
	 * @param state Bookkeeping for this device.
	 */
	private async refreshDynamicTrack(duid: string, rawDiff: unknown, state: DeviceState): Promise<void> {
		if (state.dynamicUnsupported) return;

		const channel = parseDynamicChannels(rawDiff).get(DYNAMIC_DATA_BUNDLE_ID);
		if (!channel || channel.maxLen <= 0) return;

		try {
			const params = buildDynamicDataParams(channel.nonce, DYNAMIC_DATA_BUNDLE_ID, 0, channel.maxLen);
			const answer = await this.adapter.requestsHandler.sendRequest(duid, DYNAMIC_DATA_METHOD, params, { priority: LIVE_TRACK_REQUEST_PRIORITY });
			const response = parseDynamicDataResponse(answer);
			if (response.result !== null && response.result !== 0) {
				this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `${DYNAMIC_DATA_METHOD} answered result ${response.result}; keeping the previous track.`, "debug");
				return;
			}
			if (!response.data.length) return;

			const snapshot = parseDynamicSnapshot(response.data);
			const id = `Devices.${duid}.${LIVE_TRACK_STATE}`;
			await this.adapter.ensureState(id, { name: "Live track", type: "string", role: "json", read: true, write: false, def: "" });
			await this.adapter.setStateChangedAsync(id, { val: JSON.stringify(snapshot), ack: true });
		} catch (error: unknown) {
			// An unavailable channel says nothing about the robot's abilities - keep asking later.
			if (isChannelUnavailableError(error)) return;
			state.dynamicUnsupported = true;
			this.adapter.rLog(
				"MapManager",
				duid,
				"Info",
				"1.0",
				undefined,
				`${DYNAMIC_DATA_METHOD} failed (${this.adapter.errorMessage(error)}). This robot apparently does not deliver the live track; the map itself is unaffected.`,
				"info"
			);
		}
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
	 * Records a failed diff on the track cycle and stops reading the position after
	 * {@link MAX_DIFF_FAILURES} in a row.
	 *
	 * Counted separately from {@link noteDiffFailure} although both call the same method: the two
	 * cycles must not be able to switch each other off, which is the whole point of giving them
	 * separate bookkeeping. A robot that answers neither is simply noticed twice.
	 *
	 * @param duid Device Unique ID.
	 * @param state Bookkeeping for this device.
	 * @param error What `sendRequest` threw.
	 */
	private noteTrackDiffFailure(duid: string, state: DeviceState, error: unknown): void {
		// A dead channel says nothing about what the robot can do.
		if (isChannelUnavailableError(error)) return;

		state.trackDiffFailures++;

		if (state.trackDiffFailures < MAX_DIFF_FAILURES) {
			this.adapter.rLog("MapManager", duid, "Debug", "1.0", undefined, `${MAP_DIFF_METHOD} failed on the live position channel (${state.trackDiffFailures}/${MAX_DIFF_FAILURES}): ${this.adapter.errorMessage(error)}`, "debug");
			return;
		}

		state.trackDiffGaveUp = true;
		this.adapter.rLog(
			"MapManager",
			duid,
			"Info",
			"1.0",
			undefined,
			`${MAP_DIFF_METHOD} failed ${state.trackDiffFailures} times in a row (${this.adapter.errorMessage(error)}). This robot apparently does not deliver the live position; the map itself is unaffected.`,
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
			state = {
				nextDueAt: 0,
				inFlight: false,
				diffFailures: 0,
				diffGaveUp: false,
				owned: false,
				loggedBranch: null,
				dynamicInFlight: false,
				trackDiffFailures: 0,
				trackDiffGaveUp: false,
				dynamicUnsupported: false,
				sharedDiff: null
			};
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
	 * There is no timer to clear — the poller rides the two `DeviceManager` tickers — but a cycle
	 * that is already awaiting an answer must not schedule another one after unload.
	 */
	public dispose(): void {
		this.stopped = true;
		this.stopAllDynamicCycles();
		this.states.clear();
	}
}
