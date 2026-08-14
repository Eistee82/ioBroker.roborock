import { describe, expect, it } from "vitest";

import {
	BLOCK_HEADER_SIZE,
	DYNAMIC_CHANNELS,
	DYNAMIC_DATA_BUNDLE_ID,
	buildDynamicDataParams,
	decodeDynamicBlocks,
	hasDynamicChannelChanged,
	parseDynamicChannels,
	parseDynamicDataResponse,
	parseDynamicSnapshot
} from "../../src/lib/map/dynamicData";

/**
 * A real answer of the test device, shortened.
 *
 * Taken from `_appanalysis/dynamic-data.log`, the answer to
 * `{nonce, start: 0, len: 620, data_id: 3}`. The position block is byte-for-byte the original; the
 * path and mop blocks keep their original headers and their first 8 elements, with the two length
 * fields adjusted to the shortened count so the stream stays consistent. Nothing here identifies a
 * device - the payload is coordinates only.
 *
 * ```
 * 08 00 08 00 0c 00 00 00                          type 8, header 8, data 12
 * 9a 7d 00 00  fb 55 00 00  a5 ff ff ff            x = 32154, y = 22011, angle = -91
 * 03 00 14 00 20 00 00 00 08 00 00 00 ...          type 3, header 20, data 32, 8 points
 * 48 60 62 6f ...                                  x = 24648, y = 28514, ...
 * 12 00 08 00 08 00 00 00                          type 18, header 8, data 8
 * 0c 0c 0c 0c 0c 0c 0c 0e                          12, 12, 12, 12, 12, 12, 12, 14
 * ```
 */
const REAL_SNAPSHOT_HEX =
	"080008000c0000009a7d0000fb550000a5ffffff" +
	"03001400200000000800000004000000000000004860626f4060ff6e3a609d6e33603a6e2d60d86d27608f6d24608b6d22608a6d" +
	"12000800080000000c0c0c0c0c0c0c0e";

/** The eight path points of {@link REAL_SNAPSHOT_HEX}, read off the capture. */
const REAL_POINTS = [
	{ x: 24648, y: 28514 },
	{ x: 24640, y: 28415 },
	{ x: 24634, y: 28317 },
	{ x: 24627, y: 28218 },
	{ x: 24621, y: 28120 },
	{ x: 24615, y: 28047 },
	{ x: 24612, y: 28043 },
	{ x: 24610, y: 28042 }
];

/**
 * Builds one block the way the robot lays it out.
 * @param type Block type.
 * @param data Payload.
 * @param headerLength Header length; defaults to the minimum of 8.
 * @param headerExtra Bytes filling the header behind the first 8, e.g. the path block's count.
 * @returns The finished block.
 */
function block(type: number, data: Buffer, headerLength = BLOCK_HEADER_SIZE, headerExtra?: Buffer): Buffer {
	const header = Buffer.alloc(headerLength);
	header.writeUInt16LE(type, 0);
	header.writeUInt16LE(headerLength, 2);
	header.writeUInt32LE(data.length, 4);
	if (headerExtra) headerExtra.copy(header, BLOCK_HEADER_SIZE);
	return Buffer.concat([header, data]);
}

/**
 * Builds a position block.
 * @param x X in millimetres.
 * @param y Y in millimetres.
 * @param angle Heading in degrees.
 * @returns Block type 8.
 */
function positionBlock(x: number, y: number, angle: number): Buffer {
	const data = Buffer.alloc(12);
	data.writeInt32LE(x, 0);
	data.writeInt32LE(y, 4);
	data.writeInt32LE(angle, 8);
	return block(8, data);
}

/**
 * Builds a path block, header included, the way the robot sends it.
 * @param points The points.
 * @returns Block type 3 with its 20 byte header.
 */
function pathBlock(points: { x: number; y: number }[]): Buffer {
	const data = Buffer.alloc(points.length * 4);
	points.forEach((point, index) => {
		data.writeUInt16LE(point.x, index * 4);
		data.writeUInt16LE(point.y, index * 4 + 2);
	});
	const extra = Buffer.alloc(12);
	extra.writeUInt32LE(points.length, 0);
	return block(3, data, 20, extra);
}

/**
 * Builds a mop path block.
 * @param flags One value per path point.
 * @returns Block type 18.
 */
function mopBlock(flags: number[]): Buffer {
	return block(18, Buffer.from(flags));
}

describe("dynamic data: block decoding", () => {
	it("reads the 8 byte header and takes the payload offset from it, not from a fixed 8", () => {
		// The trap this whole module exists for: with a 4 byte header assumed, the position decodes
		// to nonsense. The path block proves the point - its header is 20 bytes, not 8.
		const { blocks, problem } = decodeDynamicBlocks(Buffer.from(REAL_SNAPSHOT_HEX, "hex"));

		expect(problem).toBeNull();
		expect(blocks.map((entry) => entry.type)).toEqual([8, 3, 18]);
		expect(blocks[0].headerLength).toBe(8);
		expect(blocks[1].headerLength).toBe(20);
		expect(blocks[1].dataLength).toBe(32);
		expect(blocks[2].headerLength).toBe(8);
	});

	it("reports the offset of every block so a defect can be located", () => {
		const { blocks } = decodeDynamicBlocks(Buffer.from(REAL_SNAPSHOT_HEX, "hex"));

		expect(blocks[0].offset).toBe(0);
		expect(blocks[1].offset).toBe(20);
		expect(blocks[2].offset).toBe(72);
	});

	it("returns an empty result for an empty answer, and calls it no defect", () => {
		const result = decodeDynamicBlocks(Buffer.alloc(0));

		expect(result.blocks).toEqual([]);
		expect(result.bytesConsumed).toBe(0);
		expect(result.problem).toBeNull();
	});

	it("keeps the blocks it already has when the stream is cut off mid-block", () => {
		const full = Buffer.concat([positionBlock(32154, 22011, -91), pathBlock(REAL_POINTS)]);
		const cut = full.subarray(0, full.length - 10);

		const { blocks, problem } = decodeDynamicBlocks(cut);

		expect(blocks.map((entry) => entry.type)).toEqual([8]);
		expect(problem).toMatch(/block 3 at offset 20 needs 52 bytes but only 42 are left/);
	});

	it("reports a trailing fragment that is too short for another header", () => {
		const stream = Buffer.concat([positionBlock(1, 2, 3), Buffer.from([0x03, 0x00, 0x14])]);

		const { blocks, bytesConsumed, problem } = decodeDynamicBlocks(stream);

		expect(blocks).toHaveLength(1);
		expect(bytesConsumed).toBe(20);
		expect(problem).toMatch(/3 trailing byte\(s\)/);
	});

	it("stops on a header length below 8 instead of looping forever", () => {
		// headerLength 0 would leave the read position where it is - the classic infinite loop.
		const broken = Buffer.from([0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 1, 2, 3, 4]);

		const { blocks, problem } = decodeDynamicBlocks(broken);

		expect(blocks).toEqual([]);
		expect(problem).toMatch(/claims a 0 byte header/);
	});

	it("never throws, whatever it is handed", () => {
		expect(() => decodeDynamicBlocks(undefined as unknown as Buffer)).not.toThrow();
		expect(decodeDynamicBlocks(undefined as unknown as Buffer).problem).toBe("no buffer to decode");
		expect(decodeDynamicBlocks("nonsense" as unknown as Buffer).blocks).toEqual([]);
	});
});

describe("dynamic data: snapshot", () => {
	it("reads position, path and mop path out of a real answer", () => {
		const snapshot = parseDynamicSnapshot(Buffer.from(REAL_SNAPSHOT_HEX, "hex"));

		expect(snapshot.position).toEqual({ x: 32154, y: 22011, angle: -91 });
		expect(snapshot.path).toEqual(REAL_POINTS);
		expect(snapshot.mopFlags).toEqual([12, 12, 12, 12, 12, 12, 12, 14]);
	});

	it("keeps one mop value per path point", () => {
		const snapshot = parseDynamicSnapshot(Buffer.from(REAL_SNAPSHOT_HEX, "hex"));

		expect(snapshot.mopFlags).toHaveLength(snapshot.path.length);
	});

	it("pads a short mop block instead of shifting every later point onto the wrong value", () => {
		const stream = Buffer.concat([pathBlock(REAL_POINTS), mopBlock([12, 12, 14])]);

		const snapshot = parseDynamicSnapshot(stream);

		expect(snapshot.path).toHaveLength(8);
		expect(snapshot.mopFlags).toEqual([12, 12, 14, 0, 0, 0, 0, 0]);
	});

	it("drops surplus mop values rather than claiming path points that do not exist", () => {
		const stream = Buffer.concat([pathBlock(REAL_POINTS.slice(0, 2)), mopBlock([1, 2, 3, 4, 5])]);

		const snapshot = parseDynamicSnapshot(stream);

		expect(snapshot.path).toHaveLength(2);
		expect(snapshot.mopFlags).toEqual([1, 2]);
	});

	it("leaves mopFlags empty when the robot sends no mop path", () => {
		const snapshot = parseDynamicSnapshot(Buffer.concat([positionBlock(1, 2, 3), pathBlock(REAL_POINTS)]));

		expect(snapshot.path).toHaveLength(8);
		expect(snapshot.mopFlags).toEqual([]);
	});

	it("reads path coordinates unsigned - the real map holds x = 34602", () => {
		// readInt16LE would turn 34602 into -30934 and put the robot outside its own map.
		const snapshot = parseDynamicSnapshot(pathBlock([{ x: 34602, y: 21207 }]));

		expect(snapshot.path).toEqual([{ x: 34602, y: 21207 }]);
	});

	it("reads a negative heading, which is signed", () => {
		const snapshot = parseDynamicSnapshot(positionBlock(32587, 22591, -137));

		expect(snapshot.position).toEqual({ x: 32587, y: 22591, angle: -137 });
	});

	it("ignores unknown block types and still returns what it understood", () => {
		const stream = Buffer.concat([
			block(99, Buffer.from([1, 2, 3, 4])),
			positionBlock(100, 200, 45),
			block(51, Buffer.alloc(6)),
			pathBlock(REAL_POINTS.slice(0, 3)),
			mopBlock([6, 6, 6])
		]);

		const snapshot = parseDynamicSnapshot(stream);

		expect(snapshot.position).toEqual({ x: 100, y: 200, angle: 45 });
		expect(snapshot.path).toHaveLength(3);
		expect(snapshot.mopFlags).toEqual([6, 6, 6]);
	});

	it("returns an empty snapshot for an empty answer", () => {
		expect(parseDynamicSnapshot(Buffer.alloc(0))).toEqual({ position: null, path: [], mopFlags: [] });
	});

	it("keeps the blocks before a defect when the answer is truncated", () => {
		const full = Buffer.concat([positionBlock(32154, 22011, -91), pathBlock(REAL_POINTS), mopBlock([12, 12, 12, 12, 12, 12, 12, 14])]);
		const cut = full.subarray(0, 20 + 52 + 4);

		const snapshot = parseDynamicSnapshot(cut);

		expect(snapshot.position).toEqual({ x: 32154, y: 22011, angle: -91 });
		expect(snapshot.path).toHaveLength(8);
		expect(snapshot.mopFlags).toEqual([]);
	});

	it("ignores a position block that is too short to hold three int32", () => {
		const snapshot = parseDynamicSnapshot(block(8, Buffer.alloc(8)));

		expect(snapshot.position).toBeNull();
	});

	it("appends a path that arrives as two blocks and keeps the mop values aligned", () => {
		const stream = Buffer.concat([
			pathBlock(REAL_POINTS.slice(0, 4)),
			mopBlock([12, 12, 12, 12]),
			pathBlock(REAL_POINTS.slice(4)),
			mopBlock([14, 6, 6, 6])
		]);

		const snapshot = parseDynamicSnapshot(stream);

		expect(snapshot.path).toEqual(REAL_POINTS);
		expect(snapshot.mopFlags).toEqual([12, 12, 12, 12, 14, 6, 6, 6]);
	});
});

describe("dynamic data: request parameters", () => {
	it("builds the parameters the robot answers", () => {
		expect(buildDynamicDataParams(1786711273, DYNAMIC_DATA_BUNDLE_ID, 0, 620)).toEqual({
			nonce: 1786711273,
			start: 0,
			len: 620,
			data_id: 3
		});
	});

	it("clamps a negative range instead of letting the robot reject it", () => {
		expect(buildDynamicDataParams(1, 3, -5, -1)).toEqual({ nonce: 1, start: 0, len: 0, data_id: 3 });
	});

	it("falls back to the only accepted bundle id when none is given", () => {
		expect(buildDynamicDataParams(1, Number.NaN, 0, 1).data_id).toBe(DYNAMIC_DATA_BUNDLE_ID);
	});
});

describe("dynamic data: answer envelope", () => {
	it("decodes the base64 payload of a real answer", () => {
		const raw = {
			nonce: 1786711273,
			data_id: 3,
			max_len: 620,
			start: 0,
			len: 500,
			result: 0,
			data: Buffer.from(REAL_SNAPSHOT_HEX, "hex").toString("base64")
		};

		const response = parseDynamicDataResponse([raw]);

		expect(response.nonce).toBe(1786711273);
		expect(response.dataId).toBe(3);
		expect(response.maxLen).toBe(620);
		expect(response.len).toBe(500);
		expect(response.result).toBe(0);
		expect(parseDynamicSnapshot(response.data).position).toEqual({ x: 32154, y: 22011, angle: -91 });
	});

	it("survives an answer without a payload", () => {
		const response = parseDynamicDataResponse({ nonce: 5, data_id: 3, max_len: 0, start: 0, len: 0, result: 0 });

		expect(response.data).toHaveLength(0);
		expect(parseDynamicSnapshot(response.data)).toEqual({ position: null, path: [], mopFlags: [] });
	});

	it("returns empty counters for anything that is not an answer", () => {
		for (const raw of [null, undefined, "error", 42, []]) {
			const response = parseDynamicDataResponse(raw);
			expect(response.data).toHaveLength(0);
			expect(response.result).toBeNull();
		}
	});
});

describe("dynamic data: channels", () => {
	/** The shape of a `get_dynamic_map_diff` answer, as measured on the test device. */
	const DIFF_ANSWER = {
		result: 0,
		nonce: 1,
		diff: {
			"3": { max_len: 71, nonce: 1786715430, count: 0 },
			"6": { max_len: 0, nonce: 1786711273, count: 0 },
			"36": { max_len: 0, nonce: 1786711273, count: 0 }
		}
	};

	it("reads the channels of a diff answer", () => {
		const channels = parseDynamicChannels([DIFF_ANSWER]);

		expect(channels.get(3)).toEqual({ maxLen: 71, nonce: 1786715430, count: 0 });
		expect(channels.get(36)).toEqual({ maxLen: 0, nonce: 1786711273, count: 0 });
		expect(channels.size).toBe(3);
	});

	it("skips entries that are not readable rather than guessing them", () => {
		const channels = parseDynamicChannels({ diff: { "3": { max_len: 71, nonce: 1, count: 0 }, "path": { max_len: 5 }, "11": null } });

		expect([...channels.keys()]).toEqual([3]);
	});

	it("returns an empty map for an unusable answer", () => {
		expect(parseDynamicChannels(null).size).toBe(0);
		expect(parseDynamicChannels("boom").size).toBe(0);
		expect(parseDynamicChannels({ result: 0, nonce: 1 }).size).toBe(0);
	});

	it("names the 21 channels of the control plugin", () => {
		expect(Object.keys(DYNAMIC_CHANNELS)).toHaveLength(21);
		expect(DYNAMIC_CHANNELS[3]).toBe("path");
		expect(DYNAMIC_CHANNELS[25]).toBe("furnitures");
		expect(DYNAMIC_CHANNELS[52]).toBe("lowSpaces");
		// The 12 channels the test device reported must all have a name.
		for (const type of [3, 6, 11, 15, 16, 21, 24, 25, 29, 30, 31, 36]) {
			expect(DYNAMIC_CHANNELS[type]).toBeTruthy();
		}
	});

	it("detects a change from the nonce and max_len, never from count", () => {
		// The measurement this rule comes from: block 3 grew from 47 to 71 while count stayed 0.
		const previous = { maxLen: 47, nonce: 1786715430, count: 0 };

		expect(hasDynamicChannelChanged(previous, { maxLen: 71, nonce: 1786715430, count: 0 })).toBe(true);
		expect(hasDynamicChannelChanged(previous, { maxLen: 47, nonce: 1786799999, count: 0 })).toBe(true);
		expect(hasDynamicChannelChanged(previous, { maxLen: 47, nonce: 1786715430, count: 0 })).toBe(false);
		// A rising count alone is not a change - it moves without the data moving.
		expect(hasDynamicChannelChanged(previous, { maxLen: 47, nonce: 1786715430, count: 123 })).toBe(false);
	});

	it("treats a shrinking channel as a change, because the robot started over", () => {
		expect(hasDynamicChannelChanged({ maxLen: 71, nonce: 1, count: 0 }, { maxLen: 4, nonce: 1, count: 0 })).toBe(true);
	});

	it("treats the first reading as a change and a missing reading as none", () => {
		expect(hasDynamicChannelChanged(null, { maxLen: 0, nonce: 1, count: 0 })).toBe(true);
		expect(hasDynamicChannelChanged({ maxLen: 0, nonce: 1, count: 0 }, null)).toBe(false);
	});
});
