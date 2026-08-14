/**
 * `get_dynamic_data`: the robot's position, its driven track and its mopped track.
 *
 * This is the cheap live channel. One call over the local TCP link answers in about 55 ms with
 * roughly 300-500 bytes and carries three things at once, where a complete `get_map_v1` costs
 * 248 ms and 7 KiB compressed (306 KiB expanded):
 *
 * ```
 * get_dynamic_data  {nonce, start, len, data_id}
 *   -> {nonce, data_id, max_len, start, len, data: "<base64>", result}
 * ```
 *
 * Everything below is measured at a real robot (`roborock.vacuum.a65`, firmware V02.26.80) and
 * cross-checked against a raw map dump of the same device; the sources are named per statement.
 * This module is pure decoding: it opens no socket and knows no adapter. The transport belongs to
 * the caller, which sends the parameters from {@link buildDynamicDataParams} through
 * `requestsHandler.sendRequest`.
 *
 * Three findings are worth stating up front, because each of them has already cost a debugging
 * session:
 *
 *  1. **The block header is 8 bytes, not 4.** `type(2) headerLength(2) dataLength(4)`, with the
 *     payload starting at `headerLength` from the block start - which is *not* always 8: the path
 *     block carries a 20 byte header holding its point count. Read with a 4 byte header, the
 *     position decodes to nonsense such as `x = 12`.
 *  2. **`data_id` is not a block selector.** Only the bundle id 3 is accepted; 1, 2, 8 and 18 are
 *     rejected with `{"code":-10007,"message":"invalid params data_id"}`. Bundle 3 returns the
 *     position, the path and the mop path together.
 *  3. **`count` in the diff answer is not a change signal.** See {@link hasDynamicChannelChanged}.
 */

/** RPC method that returns a dynamic data bundle. */
export const DYNAMIC_DATA_METHOD = "get_dynamic_data";

/**
 * The only `data_id` the robot accepts.
 *
 * Measured against the real device: 1, 2, 8 and 18 - the block type numbers one would expect from
 * the map format - are all answered with `{"code":-10007,"message":"invalid params data_id"}`. The
 * 3 is therefore not "the path block" but the identifier of the whole dynamic bundle, which
 * happens to contain block 3 among others.
 */
export const DYNAMIC_DATA_BUNDLE_ID = 3;

/** Size of the block header: `type(2) headerLength(2) dataLength(4)`. */
export const BLOCK_HEADER_SIZE = 8;

/**
 * Block types this module interprets. The numbering is the V1 map format's, see `TYPES` in
 * `./v1/MapParser.ts`.
 */
export const DYNAMIC_BLOCK_TYPES = Object.freeze({
	/** Position and heading of the robot, 12 bytes: `x`, `y`, `angle`, all `int32` LE. */
	ROBOT_POSITION: 8,
	/** Driven track, 4 bytes per point: `x`, `y`, both `uint16` LE. */
	PATH: 3,
	/** Mop track, one byte per point of {@link DYNAMIC_BLOCK_TYPES.PATH}. */
	MOP_PATH: 18
});

/**
 * The channels a `get_dynamic_map_diff` answer can report, by block type.
 *
 * Names are taken verbatim from `MapDyTypeMap` in the decompiled control plugin of the test
 * device: `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`, table built
 * at lines 344087-344231 and assigned at line 344238. It holds exactly these 21 entries.
 *
 * The device under test reported 12 of them (3, 6, 11, 15, 16, 21, 24, 25, 29, 30, 31, 36); the
 * remaining nine belong to features it does not have. Which channels appear is therefore a
 * property of the robot, not of this table - unknown numbers must stay usable, so this map is for
 * labelling only and never a filter.
 */
export const DYNAMIC_CHANNELS: Readonly<Record<number, string>> = Object.freeze({
	3: "path",
	6: "zones",
	11: "blocks",
	15: "obstacles",
	16: "ignoredObstacles",
	21: "smartZones",
	24: "floorMap",
	25: "furnitures",
	27: "enemies",
	29: "stuckpts",
	30: "clffbz",
	31: "smartds",
	36: "extZones",
	38: "petPatrol",
	42: "dirtyRect",
	44: "brushPt",
	45: "dirtyNew",
	46: "mopErrPt",
	50: "steeringPt",
	51: "sensorInfo",
	52: "lowSpaces"
});

/** One block of the decoded binary stream. */
export type DynamicBlock = {
	/** Block type, see {@link DYNAMIC_BLOCK_TYPES} and `TYPES` in `./v1/MapParser.ts`. */
	type: number;
	/** Bytes from the block start to its payload; at least {@link BLOCK_HEADER_SIZE}. */
	headerLength: number;
	/** Length of the payload in bytes, as the block claims it. */
	dataLength: number;
	/** Offset of the block inside the stream, useful for logging a defect. */
	offset: number;
	/** The payload, a view into the input buffer - not a copy. */
	data: Buffer;
};

/** Result of {@link decodeDynamicBlocks}. */
export type DecodedDynamicBlocks = {
	/** Every block that decoded completely, in stream order. */
	blocks: DynamicBlock[];
	/** Bytes consumed by those blocks; the rest of the buffer was not usable. */
	bytesConsumed: number;
	/** Why decoding stopped early, or `null` when the buffer was consumed cleanly. */
	problem: string | null;
};

/**
 * Position, driven track and mop track of one answer.
 *
 * This is the contract other parts of the adapter build on; it must stay as it is.
 */
export type DynamicSnapshot = {
	position: { x: number; y: number; angle: number } | null;
	path: { x: number; y: number }[];
	/** One value per path point, same length as `path`. Empty when the robot sends none. */
	mopFlags: number[];
};

/** Parameters of a `get_dynamic_data` call, in the field order the robot is known to accept. */
export type DynamicDataParams = {
	nonce: number;
	start: number;
	len: number;
	data_id: number;
};

/** The envelope of a `get_dynamic_data` answer, with `data` already base64-decoded. */
export type DynamicDataResponse = {
	/** Nonce the answer belongs to, or `null` when the robot did not name one. */
	nonce: number | null;
	/** Bundle id the answer belongs to, or `null` when the robot did not name one. */
	dataId: number | null;
	/** First element contained in this answer. */
	start: number;
	/** Number of elements contained in this answer. */
	len: number;
	/** Number of elements the robot currently holds; grows while it drives. */
	maxLen: number;
	/** The robot's own result code, or `null` when it did not send one. `0` is success. */
	result: number | null;
	/** The decoded payload; empty when the answer carried none. */
	data: Buffer;
};

/** State of one channel in a `get_dynamic_map_diff` answer. */
export type DynamicChannelState = {
	/** Number of elements the robot holds for this channel. */
	maxLen: number;
	/** Nonce of this channel; a different value means the data was replaced. */
	nonce: number;
	/**
	 * What the robot counts as changed.
	 *
	 * Kept because it is part of the answer, but see {@link hasDynamicChannelChanged} before using
	 * it for anything.
	 */
	count: number;
};

/**
 * Unwraps the single-element arrays the V1 transport wraps answers in.
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
 * Reads a field as a finite number.
 * @param source Object the field belongs to.
 * @param key Field name.
 * @returns The number, or `null` when the field is missing or not a finite number.
 */
function numberField(source: Record<string, unknown>, key: string): number | null {
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * Coerces a value into a non-negative integer.
 * @param value Raw value.
 * @returns The truncated value, or 0 for anything that is not a usable number.
 */
function toCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

/**
 * Splits the binary stream of a `get_dynamic_data` answer into its blocks.
 *
 * The layout, verified twice - against a raw map dump of the test device
 * (`_appanalysis/backups/backup-20260814-135734/karte-0-roh.bin`) and against a live answer
 * (`_appanalysis/dynamic-data.log`):
 *
 * ```
 * type       = readUInt16LE(p)      block type
 * headerLen  = readUInt16LE(p + 2)  distance from p to the payload, >= 8
 * dataLen    = readUInt32LE(p + 4)  payload length
 * payload    = [p + headerLen, p + headerLen + dataLen)
 * next block = p + headerLen + dataLen
 * ```
 *
 * `headerLength` differs per block type - 8 for position and mop path, 20 for the path block,
 * whose header carries the point count - which is exactly why it has to be read rather than
 * assumed.
 *
 * This function never throws. It is fed by the network, where a short read, a truncated transfer
 * or a firmware this adapter has never seen are all normal; the caller gets whatever decoded plus
 * a description of where it stopped, and can still show the position when only the tail is broken.
 *
 * @param bin The decoded contents of the answer's `data` field.
 * @returns The blocks, how far the decode got, and why it stopped early if it did.
 */
export function decodeDynamicBlocks(bin: Buffer): DecodedDynamicBlocks {
	const blocks: DynamicBlock[] = [];

	if (!Buffer.isBuffer(bin)) {
		return { blocks, bytesConsumed: 0, problem: "no buffer to decode" };
	}
	if (bin.length === 0) {
		// An empty answer is the normal reply of a robot that has nothing to report yet.
		return { blocks, bytesConsumed: 0, problem: null };
	}

	let position = 0;
	let problem: string | null = null;

	try {
		while (position + BLOCK_HEADER_SIZE <= bin.length) {
			const type = bin.readUInt16LE(position);
			const headerLength = bin.readUInt16LE(position + 2);
			const dataLength = bin.readUInt32LE(position + 4);

			if (headerLength < BLOCK_HEADER_SIZE) {
				problem = `block ${type} at offset ${position} claims a ${headerLength} byte header, which cannot hold the ${BLOCK_HEADER_SIZE} byte header itself`;
				break;
			}

			const end = position + headerLength + dataLength;
			if (end > bin.length) {
				problem = `block ${type} at offset ${position} needs ${headerLength + dataLength} bytes but only ${bin.length - position} are left`;
				break;
			}

			blocks.push({
				type,
				headerLength,
				dataLength,
				offset: position,
				data: bin.subarray(position + headerLength, end)
			});

			// `headerLength >= BLOCK_HEADER_SIZE` was checked above, so the position always advances
			// and the loop always terminates.
			position = end;
		}
	} catch (error: unknown) {
		problem = `decoding stopped at offset ${position}: ${error instanceof Error ? error.message : String(error)}`;
	}

	if (problem === null && position < bin.length) {
		problem = `${bin.length - position} trailing byte(s) after the last block, too few for another header`;
	}

	return { blocks, bytesConsumed: position, problem };
}

/**
 * Aligns the mop path with the driven path.
 *
 * The robot sends one byte per path point - 500 path points and 500 mop bytes in the reference
 * capture - so the two are indexed together. This keeps that invariant even when a partial
 * transfer breaks it, because a consumer that pairs `path[i]` with `mopFlags[i]` would otherwise
 * silently draw the wrong stretch as mopped.
 *
 * @param bytes The mop path block's payload, or `null` when the answer carried none.
 * @param pathLength Number of decoded path points.
 * @returns One value per path point, or an empty array when nothing can be aligned.
 */
function alignMopFlags(bytes: Buffer | null, pathLength: number): number[] {
	if (!bytes || bytes.length === 0 || pathLength === 0) return [];

	const flags: number[] = new Array(pathLength);
	for (let index = 0; index < pathLength; index++) {
		// Missing values become 0 rather than shifting every later point onto the wrong position.
		flags[index] = index < bytes.length ? bytes[index] : 0;
	}
	return flags;
}

/**
 * Reads position, driven track and mop track out of a decoded `get_dynamic_data` payload.
 *
 * Field layouts, each proven at the device:
 *
 *  - **Block 8, robot position** - `x = readInt32LE(0)`, `y = readInt32LE(4)`,
 *    `angle = readInt32LE(8)`, all in the robot's own millimetres. Confirmed against a known
 *    location: the answer read `x=32587 y=22591`, 55 mm from the spot the user reported.
 *  - **Block 3, path** - 4 bytes per point, `x = readUInt16LE(0)`, `y = readUInt16LE(2)`.
 *    **Unsigned**, deliberately: the raw map of the test device contains path coordinates up to
 *    34602 mm, which `readInt16LE` would turn into -30934. `MapParser.getPointInPath` reads the
 *    very same block the very same way.
 *  - **Block 18, mop path** - one byte per path point. The values are not a plain counter: the
 *    reference capture holds 12, 14 and 6, the raw map holds 0, 1, 2, 4, 8, 9, 10, 12 and 14. What
 *    they mean is unproven, so they are passed through untouched instead of being interpreted.
 *
 * Blocks of a type that appears twice are appended, which is what a chunked answer produces; for
 * the position the last one wins, since that is the newer of the two.
 *
 * @param bin The decoded contents of the answer's `data` field.
 * @returns The snapshot. Unknown block types are ignored, and a broken tail costs only the blocks
 *          behind the defect - never the whole answer.
 */
export function parseDynamicSnapshot(bin: Buffer): DynamicSnapshot {
	const { blocks } = decodeDynamicBlocks(bin);

	let position: DynamicSnapshot["position"] = null;
	const path: { x: number; y: number }[] = [];
	let mopBytes: Buffer | null = null;

	for (const block of blocks) {
		switch (block.type) {
			case DYNAMIC_BLOCK_TYPES.ROBOT_POSITION: {
				if (block.data.length < 12) break;
				position = {
					x: block.data.readInt32LE(0),
					y: block.data.readInt32LE(4),
					angle: block.data.readInt32LE(8)
				};
				break;
			}
			case DYNAMIC_BLOCK_TYPES.PATH: {
				for (let offset = 0; offset + 4 <= block.data.length; offset += 4) {
					path.push({ x: block.data.readUInt16LE(offset), y: block.data.readUInt16LE(offset + 2) });
				}
				break;
			}
			case DYNAMIC_BLOCK_TYPES.MOP_PATH: {
				mopBytes = mopBytes === null ? block.data : Buffer.concat([mopBytes, block.data]);
				break;
			}
			default:
				break;
		}
	}

	return { position, path, mopFlags: alignMopFlags(mopBytes, path.length) };
}

/**
 * Builds the parameters of a `get_dynamic_data` call.
 *
 * `start` and `len` address elements of the bundle, not bytes, and let the caller fetch only the
 * growth: ten incremental calls measured 57 ms at 309 bytes each. The nonce must be the one the
 * robot currently reports for the channel, see {@link parseDynamicChannels}.
 *
 * @param nonce Current nonce of the channel.
 * @param dataId Bundle id; the robot only accepts {@link DYNAMIC_DATA_BUNDLE_ID}.
 * @param start First element to fetch, counted from 0.
 * @param len Number of elements to fetch.
 * @returns The parameter object, with out-of-range values clamped instead of passed on - a
 *          negative length is a caller's bug, and the robot answers it with an error that says
 *          nothing about where it came from.
 */
export function buildDynamicDataParams(nonce: number, dataId: number, start: number, len: number): DynamicDataParams {
	return {
		nonce: typeof nonce === "number" && Number.isFinite(nonce) ? Math.trunc(nonce) : 0,
		start: toCount(start),
		len: toCount(len),
		data_id: typeof dataId === "number" && Number.isFinite(dataId) ? Math.trunc(dataId) : DYNAMIC_DATA_BUNDLE_ID
	};
}

/**
 * Reads the envelope of a `get_dynamic_data` answer and decodes its base64 payload.
 *
 * @param raw The answer as `sendRequest` returned it, array wrappers and all.
 * @returns The envelope with `data` decoded. An answer that is not an object yields all-zero
 *          counters, a `null` result and an empty buffer, which
 *          {@link parseDynamicSnapshot} turns into an empty snapshot.
 */
export function parseDynamicDataResponse(raw: unknown): DynamicDataResponse {
	const empty: DynamicDataResponse = { nonce: null, dataId: null, start: 0, len: 0, maxLen: 0, result: null, data: Buffer.alloc(0) };

	const response = unwrap(raw);
	if (!response || typeof response !== "object" || Array.isArray(response)) return empty;

	const record = response as Record<string, unknown>;
	const encoded = record.data;

	let data = Buffer.alloc(0);
	if (typeof encoded === "string" && encoded.length > 0) {
		try {
			data = Buffer.from(encoded, "base64");
		} catch {
			// Buffer.from does not throw on malformed base64, it drops what it cannot read; the
			// catch only guards against an exotic input type slipping past the typeof check.
			data = Buffer.alloc(0);
		}
	} else if (Buffer.isBuffer(encoded)) {
		// Copied rather than referenced: a caller that already decoded the field keeps ownership of
		// its buffer, and this one must not change underneath the snapshot.
		data = Buffer.from(encoded);
	}

	return {
		nonce: numberField(record, "nonce"),
		dataId: numberField(record, "data_id"),
		start: toCount(numberField(record, "start")),
		len: toCount(numberField(record, "len")),
		maxLen: toCount(numberField(record, "max_len")),
		result: numberField(record, "result"),
		data
	};
}

/**
 * Reads the per-channel state out of a `get_dynamic_map_diff` answer.
 *
 * The answer looks like `{result, nonce, diff: {"3": {max_len, nonce, count}, ...}}`. The nonce
 * that is sent along does not have to be a valid one: a made-up `{nonce: 1, round: <epoch ms>}`
 * still returns the currently valid nonce of every channel, which is the cheapest way to refresh
 * them.
 *
 * @param raw The answer as `sendRequest` returned it.
 * @returns The channels by block type. Entries that are not readable are skipped rather than
 *          guessed; an unusable answer yields an empty map.
 */
export function parseDynamicChannels(raw: unknown): Map<number, DynamicChannelState> {
	const channels = new Map<number, DynamicChannelState>();

	const response = unwrap(raw);
	if (!response || typeof response !== "object" || Array.isArray(response)) return channels;

	const record = response as Record<string, unknown>;
	// `diff` is where the robot puts them; falling back to the answer itself keeps a caller working
	// that already unwrapped it.
	const source = record.diff && typeof record.diff === "object" && !Array.isArray(record.diff)
		? (record.diff as Record<string, unknown>)
		: record;

	for (const [key, value] of Object.entries(source)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;

		const blockType = Number(key);
		if (!Number.isInteger(blockType) || blockType < 0) continue;

		const entry = value as Record<string, unknown>;
		channels.set(blockType, {
			maxLen: toCount(numberField(entry, "max_len")),
			nonce: numberField(entry, "nonce") ?? 0,
			count: toCount(numberField(entry, "count"))
		});
	}

	return channels;
}

/**
 * Whether a channel holds anything new compared to what was seen last.
 *
 * **`count` is deliberately not part of the decision.** During a whole cleaning run of the test
 * device, block 3 grew from `max_len` 47 to 71 while `count` stayed 0 the entire time; three
 * measurement runs were lost to waiting for it. What does move is the nonce - a different one
 * means the robot replaced the data - and `max_len`, which grows by about one path point per
 * second while the robot drives.
 *
 * A shrinking `max_len` also counts as a change: the robot started over, and the track held so far
 * is no longer a prefix of the new one.
 *
 * @param previous The state seen last, or `null`/`undefined` when there is none yet.
 * @param current The state just read.
 * @returns True when there is something to fetch.
 */
export function hasDynamicChannelChanged(previous: DynamicChannelState | null | undefined, current: DynamicChannelState | null | undefined): boolean {
	if (!current) return false;
	if (!previous) return true;
	return current.nonce !== previous.nonce || current.maxLen !== previous.maxLen;
}
