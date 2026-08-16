/**
 * Incremental map updates: the decision logic behind `get_dynamic_map_diff`.
 *
 * The Roborock app does not receive maps by push. It polls, but it polls a *difference* in a
 * short cycle and only fetches the whole map once the difference says something relevant
 * changed. Everything in this file mirrors that decision, and nothing else: the transport, the
 * cadence and the timers live in {@link ./LiveMapPoller}.
 *
 * All values are read out of the decompiled control plugin (report section 15, §1.1-§1.4):
 *
 * | App                                   | Here                              |
 * | ------------------------------------- | --------------------------------- |
 * | `getMapDiffDynamic({nonce, round})`    | {@link buildMapDiffParams}        |
 * | `checkMapDiff` response handling       | {@link evaluateMapDiff}           |
 * | `_checkMapDiff` block thresholds       | {@link MAP_DIFF_THRESHOLDS}       |
 * | `isSupportIncrementalMap`              | {@link INCREMENTAL_MAP_FEATURE_BIT} |
 *
 * The one deliberate deviation is documented at {@link REDRAW_BLOCK_TYPES}.
 */

import { hasFeatureStrBit } from "../featureStr";

/**
 * Bit 22 of `new_feature_info_str` — the flag the app's `isSupportIncrementalMap()` reads before
 * it chooses the differential timer branch over the "fetch the whole map" branch.
 *
 * The app takes the lowest 32 bits of the hex string (`parseInt('0x' + str.slice(-8))`) and masks
 * with `4194304` (= 1 << 22). Because the bit sits inside those low 32 bits, testing bit 22 of the
 * full value is equivalent. The Mi variant of the app uses bit 13 instead; that branch is not
 * reproduced here because the adapter always speaks to the Roborock firmware.
 */
export const INCREMENTAL_MAP_FEATURE_BIT = 22n;

/**
 * Tests whether a robot announced the incremental map feature.
 *
 * Mirrors `isSupportIncrementalMap()`: take the hex string the robot reports as
 * `new_feature_info_str` and test {@link INCREMENTAL_MAP_FEATURE_BIT}.
 *
 * The arithmetic used to be repeated here because the only other copy lived in `MapEditService`,
 * and importing that would have closed a cycle — `services/V1MapService` already imports
 * `map/MapManager`. It now lives in `lib/featureStr`, which imports nothing at all, so there is
 * no cycle left to avoid.
 *
 * @param raw Value of `Devices.<duid>.deviceStatus.new_feature_info_str`.
 * @returns True only when the bit is provably set. A missing or unreadable value counts as "no",
 *          which routes the device to the conservative full-map branch.
 */
export function supportsIncrementalMap(raw: unknown): boolean {
	return hasFeatureStrBit(raw, INCREMENTAL_MAP_FEATURE_BIT);
}

/**
 * Entry type inside the `NONCEDATA` block (block type 34) that carries the map nonce.
 *
 * `_parseMapNonceData` walks the block's `(type, value)` pairs and stores the value of the entry
 * with type 35 as `mapNonce`; every other entry is a per-block nonce the app uses for its
 * incremental patching, which the adapter does not do.
 */
export const MAP_NONCE_ENTRY_TYPE = 35;

/**
 * `MC.mapDiffCount`, the shared threshold for the two "large area" blocks.
 *
 * Initialised to 20 in the map manager's constructor.
 */
export const MAP_DIFF_COUNT = 20;

/**
 * Per-block change thresholds from `_checkMapDiff`.
 *
 * The keys are block type numbers as strings, exactly as they arrive in the `diff` object; the
 * values are the counts that must be **exceeded** (strictly greater) before the app fetches the
 * whole map. The table is the literal one built in `_checkMapDiff`:
 * `[['1',1], ['2',mapDiffCount], ['5',1], ['17',mapDiffCount], ['21',1], ['26',1]]`.
 *
 * Block names follow `TYPES` in `./v1/MapParser.ts`:
 * 1 charger location, 2 image, 5 predicted go-to path, 17 carpet map, 21 smart zone, 26 dock type.
 */
export const MAP_DIFF_THRESHOLDS: Readonly<Record<string, number>> = Object.freeze({
	"1": 1,
	"2": MAP_DIFF_COUNT,
	"5": 1,
	"17": MAP_DIFF_COUNT,
	"21": 1,
	"26": 1
});

/**
 * Blocks that force a full fetch on any change at all — the deliberate deviation from the app.
 *
 * The app patches these two blocks in place (`_checkMapObjDiff` -> `get_dynamic_data`) and keeps
 * its rendered map, so a growing path never costs it a full map. The adapter has no incremental
 * renderer: it draws one PNG out of one complete `get_map_v1` answer. Ignoring these blocks the
 * way `_checkMapDiff` does would mean the robot's position and its cleaned track stand still
 * between two image changes — precisely the "the map does not update live" the whole feature is
 * meant to fix.
 *
 * So any reported change here fetches a new map. The cadence, not a threshold, is what bounds the
 * cost: at most one full map per tick, and none at all while the robot changes nothing.
 *
 * 3 = path, 25 = furniture (both confirmed as the blocks `_checkMapObjDiff` inspects).
 */
export const REDRAW_BLOCK_TYPES: readonly string[] = Object.freeze(["3", "25"]);

/**
 * Result code of a `get_dynamic_map_diff` answer, as branched on in `checkMapDiff`.
 */
export const MapDiffResult = Object.freeze({
	/** The diff is valid and belongs to the nonce we asked for. */
	OK: 0,
	/** The robot moved on to a different map; our nonce is stale. */
	NONCE_STALE: 1,
	/** The robot cannot express the change as a diff and wants us to take the whole map. */
	FULL_REQUIRED: 2
});

/** A single block entry inside the `diff` object. */
export type MapDiffEntry = {
	/** Number of changed elements in this block. */
	count?: number;
	[key: string]: unknown;
};

/** Payload of a `get_dynamic_map_diff` answer, after the transport unwrapped the envelope. */
export type MapDiffResponse = {
	/** {@link MapDiffResult}. */
	result?: number;
	/** Nonce the answer belongs to. */
	nonce?: number;
	/** Changed blocks, keyed by block type. */
	diff?: Record<string, MapDiffEntry>;
};

/** What the caller should do with a diff answer. */
export type MapDiffDecision = {
	/** Fetch the complete map now. */
	fetchFullMap: boolean;
	/** The cached nonce is stale and must be replaced from the next full map. */
	nonceStale: boolean;
	/** Short, loggable justification. */
	reason: string;
};

/**
 * Reads the map nonce out of a parsed V1 map.
 *
 * @param mapData Parse result of `MapParser.parsedata`, or anything at all — the function is
 *                deliberately total so a surprising shape degrades to "no nonce" instead of
 *                throwing inside the poll loop.
 * @returns The nonce, or `null` when the map carries no `NONCEDATA` entry of type 35. A robot
 *          whose maps have no nonce cannot be asked for a diff at all.
 */
export function extractMapNonce(mapData: unknown): number | null {
	if (!mapData || typeof mapData !== "object") return null;

	const blocks = (mapData as { NONCEDATA?: unknown }).NONCEDATA;
	if (!Array.isArray(blocks)) return null;

	for (const entry of blocks) {
		if (!entry || typeof entry !== "object") continue;
		const { type, unixTime } = entry as { type?: unknown; unixTime?: unknown };
		if (type !== MAP_NONCE_ENTRY_TYPE) continue;
		if (typeof unixTime !== "number" || !Number.isFinite(unixTime)) continue;
		// A zero is the robot saying it has no nonce for this map yet, not a nonce of zero. Passing
		// it on froze the map for good: measured at the device, a diff carrying nonce 0 comes back
		// with `count: 0` for every block even when the whole map has been replaced in the
		// meantime, so the poller concluded "nothing changed" on every single cycle and never
		// fetched another map. Treating it as "no nonce" puts the device on the full-map branch,
		// which is slower but correct.
		if (unixTime <= 0) continue;
		return unixTime;
	}

	return null;
}

/**
 * Reads the per-block nonces out of a parsed V1 map.
 *
 * Besides the map nonce (entry type 35) the `NONCEDATA` block carries one entry per data channel,
 * and its `type` is the channel number the diff answers under. Verified against the device: a map
 * holding `{type: 3, unixTime: 1786721586}` gets a diff answer of `"3": {nonce: 1786721586, …}`,
 * likewise for 11 and 15.
 *
 * This is the reliable way to notice that a map is out of date. The `count` fields cannot do it -
 * measured while driving, they stay at 0 even when a channel grows, and a diff sent with a nonce
 * the robot does not know comes back with zeros for everything rather than an error.
 *
 * ## An all-zero `NONCEDATA` is not the hole it looks like
 *
 * Entries with `unixTime <= 0` are skipped below, so such a map yields an empty result and
 * {@link findOutdatedBlock} then reports nothing outdated. Read on its own that looks like a map
 * whose channels can grow unwatched - and it was filed as exactly that once.
 *
 * **It cannot happen, because the same zero disables the branch that would need the guard.** The
 * map nonce is entry type 35 of this very block, {@link extractMapNonce} rejects a zero there for
 * its own measured reason, and `LiveMapPoller.runCycle` only goes incremental while that nonce is
 * non-null. A map with a zeroed `NONCEDATA` is therefore fetched **in full on every cycle**; the
 * incremental path, where a missing channel nonce would matter, is never taken.
 *
 * Measured on two maps of the same device on the same day, raw bytes of the block itself:
 *
 * | Map | Entries | of those zero | type 35 | type 3 |
 * | --- | --- | --- | --- | --- |
 * | `backup-20260814-135636` | 13 | **13** | 0 | 0 |
 * | `backup-20260814-185206` | 13 | 0 | 1786726275 | 1786721586 |
 *
 * So the block is zeroed **as a whole** or filled as a whole; the two nonces move together. The
 * zeros are the device's own - `getNonceData` reads five bytes per entry from offset 12 and returns
 * exactly what stands there, and it reads the second map's timestamps correctly from the same code.
 *
 * What is **not** ruled out, for want of a sample: a map carrying a usable type 35 while some other
 * channel is zero. Neither map shows that mix. Should it ever appear, that channel alone would go
 * unguarded, and `evaluateMapDiff` would still be watching. Forcing a full map whenever a channel
 * lacks a timestamp is the obvious answer and the wrong one: measured, a full map is 22 564 bytes
 * gzipped for the zeroed map above, which at the shipped `liveMapInterval: 3` would be spent every
 * three seconds on precisely the maps that are already being fetched in full anyway.
 * @param mapData Parse result of `MapParser.parsedata`, or anything at all.
 * @returns Channel number to nonce; empty when the map carries none.
 */
export function extractBlockNonces(mapData: unknown): Map<number, number> {
	const result = new Map<number, number>();
	if (!mapData || typeof mapData !== "object") return result;

	const blocks = (mapData as { NONCEDATA?: unknown }).NONCEDATA;
	if (!Array.isArray(blocks)) return result;

	for (const entry of blocks) {
		if (!entry || typeof entry !== "object") continue;
		const { type, unixTime } = entry as { type?: unknown; unixTime?: unknown };
		if (typeof type !== "number" || !Number.isInteger(type)) continue;
		if (type === MAP_NONCE_ENTRY_TYPE) continue;
		if (typeof unixTime !== "number" || !Number.isFinite(unixTime) || unixTime <= 0) continue;
		result.set(type, unixTime);
	}

	return result;
}

/**
 * Finds a channel whose nonce in the diff answer differs from the one in the map we hold.
 *
 * @param answerNonces Channel nonces the robot just reported.
 * @param mapNonces Channel nonces of the map currently shown, from {@link extractBlockNonces}.
 * @returns A loggable reason, or `null` when every shared channel still matches.
 */
export function findOutdatedBlock(answerNonces: Map<number, number>, mapNonces: Map<number, number>): string | null {
	if (!mapNonces.size) return null;

	for (const [channel, nonce] of answerNonces) {
		const known = mapNonces.get(channel);
		// A channel the map does not mention says nothing: the robot lists channels it supports,
		// the map only those it carries data for.
		if (known === undefined) continue;
		if (known !== nonce) return `channel ${channel} moved from ${known} to ${nonce}`;
	}

	return null;
}

/**
 * Builds the parameters of a `get_dynamic_map_diff` call.
 *
 * @param nonce Nonce of the map currently held, from {@link extractMapNonce}.
 * @param now Millisecond timestamp; injectable so tests stay deterministic.
 * @returns The parameter object the app sends: `{ nonce, round }`, where `round` is the current
 *          time in milliseconds.
 */
export function buildMapDiffParams(nonce: number, now: number = Date.now()): { nonce: number; round: number } {
	return { nonce, round: now };
}

/**
 * Unwraps the single-element arrays the V1 transport likes to wrap answers in.
 * @param raw Whatever `sendRequest` returned.
 * @returns The innermost value.
 */
function unwrap(raw: unknown): unknown {
	let value = raw;
	while (Array.isArray(value) && value.length === 1) {
		value = value[0];
	}
	return value;
}

/**
 * Decides what a `get_dynamic_map_diff` answer means for us.
 *
 * The branches follow `checkMapDiff` (report section 15, §1.4):
 *
 *  - `result === 1` with a nonce that differs -> the robot switched maps; take the whole map and
 *    forget the cached nonce.
 *  - `result === 2` -> the robot asks for a full transfer outright.
 *  - `result === 0` with a matching nonce -> the `diff` object decides, via
 *    {@link MAP_DIFF_THRESHOLDS} and {@link REDRAW_BLOCK_TYPES}.
 *
 * Everything the branches do not cover — a missing result code, a shape that is not an object, an
 * answer for a nonce we did not ask about — resolves to "fetch the full map". That direction is
 * deliberate: an unnecessary transfer costs bandwidth, whereas a swallowed change leaves a stale
 * map on screen with nothing to correct it until the next state transition.
 *
 * @param raw The answer as it came back from `sendRequest`.
 * @param expectedNonce The nonce the request was made with.
 * @returns The decision; see {@link MapDiffDecision}.
 */
export function evaluateMapDiff(raw: unknown, expectedNonce: number): MapDiffDecision {
	const response = unwrap(raw) as MapDiffResponse | null | undefined;

	if (!response || typeof response !== "object") {
		return { fetchFullMap: true, nonceStale: false, reason: "diff answer was not an object" };
	}

	const { result, nonce, diff } = response;

	if (result === MapDiffResult.NONCE_STALE && typeof nonce === "number" && nonce !== expectedNonce) {
		return { fetchFullMap: true, nonceStale: true, reason: `robot reports a different map (nonce ${nonce})` };
	}

	if (result === MapDiffResult.FULL_REQUIRED) {
		return { fetchFullMap: true, nonceStale: false, reason: "robot asked for a full map (result 2)" };
	}

	if (result !== MapDiffResult.OK) {
		return { fetchFullMap: true, nonceStale: false, reason: `unexpected diff result ${String(result)}` };
	}

	if (typeof nonce === "number" && nonce !== expectedNonce) {
		return { fetchFullMap: true, nonceStale: true, reason: `diff belongs to nonce ${nonce}, not ${expectedNonce}` };
	}

	if (!diff || typeof diff !== "object") {
		// result 0 without a diff object is the robot's way of saying "nothing changed".
		return { fetchFullMap: false, nonceStale: false, reason: "no changes" };
	}

	const changed = findRelevantChange(diff);
	if (changed) {
		return { fetchFullMap: true, nonceStale: false, reason: changed };
	}

	return { fetchFullMap: false, nonceStale: false, reason: "no relevant change" };
}

/**
 * Finds the first block in a diff whose change is big enough to justify a full map.
 *
 * @param diff The `diff` object of the answer.
 * @returns A loggable reason, or `null` when no block crosses its threshold.
 */
function findRelevantChange(diff: Record<string, MapDiffEntry>): string | null {
	for (const [blockType, entry] of Object.entries(diff)) {
		if (!entry || typeof entry !== "object") continue;

		const count = typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : 0;
		if (count <= 0) continue;

		if (REDRAW_BLOCK_TYPES.includes(blockType)) {
			return `block ${blockType} changed (${count})`;
		}

		const threshold = MAP_DIFF_THRESHOLDS[blockType];
		if (threshold === undefined) continue;

		if (count > threshold) {
			return `block ${blockType} changed (${count} > ${threshold})`;
		}
	}

	return null;
}
