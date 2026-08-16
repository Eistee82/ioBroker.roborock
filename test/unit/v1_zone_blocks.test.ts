import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { MapParser } from "../../src/lib/map/v1/MapParser";
import { readOverlaysFromMap } from "../../src/lib/features/vacuum/services/MapEditService";

/**
 * The zone blocks, and the record count that decides how many zones come out of one.
 *
 * Four block types - `CUSTOM_CARPET` (22), `CL_FORBIDDEN_ZONES` (23), `SMART_DS` (31) and
 * `EXT_ZONES` (36) - were read with a single unguarded 16-byte read and no count at all. Two
 * separate faults came out of that, and the second is the one with teeth:
 *
 * 1. A block with several records yielded only its first.
 * 2. **A block with no records yielded one that does not exist**, read from the bytes behind it -
 *    which is the header of the next block, because an empty block has `length = 0`.
 *
 * The second one reaches the user through `readOverlaysFromMap`: `CL_FORBIDDEN_ZONES` is an
 * `UNREPRODUCIBLE_BLOCK`, so a map that carries one has its zone editing refused outright, since
 * `save_map` would delete the overlay. A phantom record makes that refusal fire on a map whose
 * block is empty - and then no no-go zone, no-mop zone or virtual wall can be added, moved or
 * deleted on that map at all.
 *
 * Every test here builds the block *followed by another block*, because an empty block at the end
 * of the buffer could not show the fault.
 */

/** Block type ids, as `MapParser.TYPES` has them. */
const TYPE = {
	IMAGE: 2,
	FORBIDDEN_ZONES: 9,
	VIRTUAL_WALLS: 10,
	CUSTOM_CARPET: 22,
	CL_FORBIDDEN_ZONES: 23,
	SMART_DS: 31,
	EXT_ZONES: 36,
};

interface BlockSpec {
	type: number;
	/** Block header length; 12 for the zone blocks, which carry a count at 0x08. */
	hlength: number;
	/** Value written into the count field. Defaults to the number of records. */
	count?: number;
	/** Records, each a list of uint16 values. */
	records?: number[][];
	/** Raw payload instead of records. */
	raw?: Buffer;
}

function buildBlock(spec: BlockSpec): Buffer {
	const payload = spec.raw ?? Buffer.concat((spec.records ?? []).map((record) => {
		const b = Buffer.alloc(record.length * 2);
		record.forEach((value, i) => b.writeUInt16LE(value, i * 2));
		return b;
	}));
	const block = Buffer.alloc(spec.hlength + payload.length);
	block.writeUInt16LE(spec.type, 0);
	block.writeUInt16LE(spec.hlength, 2);
	block.writeUInt32LE(payload.length, 4);
	if (spec.hlength > 8) block.writeUInt32LE(spec.count ?? (spec.records?.length ?? 0), 8);
	payload.copy(block, spec.hlength);
	return block;
}

/** A minimal 2x2 image block, so the result counts as a parsed map. */
function imageBlock(): Buffer {
	const hlength = 28;
	const block = Buffer.alloc(hlength + 4);
	block.writeUInt16LE(TYPE.IMAGE, 0);
	block.writeUInt16LE(hlength, 2);
	block.writeUInt32LE(4, 4);
	block.writeUInt32LE(0, 8);
	block.writeInt32LE(0, 12); // top
	block.writeInt32LE(0, 16); // left
	block.writeInt32LE(2, 20); // height
	block.writeInt32LE(2, 24); // width
	return block;
}

function buildMap(blocks: Buffer[]): Buffer {
	const body = Buffer.concat(blocks);
	const head = Buffer.alloc(0x14);
	head.write("rr", 0, "ascii");
	head.writeUInt16LE(0x14, 0x02);
	head.writeUInt32LE(0x14 + body.length, 0x04);
	const full = Buffer.concat([head, body]);
	return Buffer.concat([full, crypto.createHash("sha1").update(full).digest()]);
}

function stubAdapter(): any {
	return {
		rLog: () => undefined,
		http_api: { isSharedDevice: () => false, getMatchedRoomIDs: () => [], getSharedDeviceRooms: async () => [] },
	};
}

/** A record of four corners, as the 16-byte zone blocks carry it. */
const ZONE_A = [1000, 1100, 1200, 1100, 1200, 1300, 1000, 1300];
const ZONE_B = [2000, 2100, 2200, 2100, 2200, 2300, 2000, 2300];
const ZONE_C = [3000, 3100, 3200, 3100, 3200, 3300, 3000, 3300];

describe("zone blocks with a record count", () => {
	let parser: MapParser;

	beforeEach(() => {
		parser = new MapParser(stubAdapter());
	});

	/** The four that used to be read once, without their count. */
	const FORMERLY_SINGLE_READ: Array<[string, number]> = [
		["CUSTOM_CARPET", TYPE.CUSTOM_CARPET],
		["CL_FORBIDDEN_ZONES", TYPE.CL_FORBIDDEN_ZONES],
		["SMART_DS", TYPE.SMART_DS],
		["EXT_ZONES", TYPE.EXT_ZONES],
	];

	for (const [name, type] of FORMERLY_SINGLE_READ) {
		it(`reads every record of ${name}, not just the first`, async () => {
			const map = buildMap([
				imageBlock(),
				buildBlock({ type, hlength: 12, records: [ZONE_A, ZONE_B, ZONE_C] }),
				buildBlock({ type: TYPE.VIRTUAL_WALLS, hlength: 12, records: [[7, 7, 8, 8]] }),
			]);

			const parsed: any = await parser.parsedata(map, null);
			expect(parsed[name]).toEqual([ZONE_A, ZONE_B, ZONE_C]);
		});

		it(`reports ${name} as empty rather than inventing a record from the next block`, async () => {
			// The block that follows is what an empty read used to return: its header is 16 bytes of
			// perfectly readable uint16, so the fault produced a plausible-looking zone.
			const map = buildMap([
				imageBlock(),
				buildBlock({ type, hlength: 12, records: [] }),
				buildBlock({ type: TYPE.FORBIDDEN_ZONES, hlength: 12, records: [ZONE_A, ZONE_B] }),
			]);

			const parsed: any = await parser.parsedata(map, null);
			expect(parsed[name]).toEqual([]);
			// And the block behind it is untouched by the correction.
			expect(parsed.FORBIDDEN_ZONES).toEqual([ZONE_A, ZONE_B]);
		});
	}

	it("stops at the end of the block when the count claims more records than fit", async () => {
		// A count that reaches past its own payload is the only way the old read could still run off
		// the end. Trusting it would put the next block's header into a zone again.
		const map = buildMap([
			imageBlock(),
			buildBlock({ type: TYPE.CUSTOM_CARPET, hlength: 12, count: 5, records: [ZONE_A] }),
			buildBlock({ type: TYPE.FORBIDDEN_ZONES, hlength: 12, records: [ZONE_B] }),
		]);

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.CUSTOM_CARPET).toEqual([ZONE_A]);
		expect(parsed.FORBIDDEN_ZONES).toEqual([ZONE_B]);
	});

	it("leaves the blocks that always had their count alone", async () => {
		// The correction added a length guard to these too. It must not change what they return: on
		// every real map measured, count and payload agree.
		const map = buildMap([
			imageBlock(),
			buildBlock({ type: TYPE.FORBIDDEN_ZONES, hlength: 12, records: [ZONE_A, ZONE_B] }),
			buildBlock({ type: TYPE.VIRTUAL_WALLS, hlength: 12, records: [[10, 11, 12, 13], [20, 21, 22, 23]] }),
		]);

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.FORBIDDEN_ZONES).toEqual([ZONE_A, ZONE_B]);
		expect(parsed.VIRTUAL_WALLS).toEqual([[10, 11, 12, 13], [20, 21, 22, 23]]);
	});
});

describe("the zone editor is not locked out by an empty overlay block", () => {
	let parser: MapParser;

	beforeEach(() => {
		parser = new MapParser(stubAdapter());
	});

	it("edits the zones of a map whose CL_FORBIDDEN_ZONES block is present but empty", async () => {
		// The whole point of the fix. Before it, this map refused every zone edit, naming an overlay
		// it does not carry.
		const map = buildMap([
			imageBlock(),
			buildBlock({ type: TYPE.CL_FORBIDDEN_ZONES, hlength: 12, records: [] }),
			buildBlock({ type: TYPE.FORBIDDEN_ZONES, hlength: 12, records: [ZONE_A] }),
		]);

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.CL_FORBIDDEN_ZONES).toEqual([]);

		const overlays = readOverlaysFromMap(parsed);
		expect(overlays.no_go).toEqual([ZONE_A]);
	});

	it("still refuses when the block really carries a record", async () => {
		// The guard has to keep working: save_map would delete an overlay it cannot rebuild.
		const map = buildMap([
			imageBlock(),
			buildBlock({ type: TYPE.CL_FORBIDDEN_ZONES, hlength: 12, records: [ZONE_A] }),
			buildBlock({ type: TYPE.FORBIDDEN_ZONES, hlength: 12, records: [ZONE_B] }),
		]);

		const parsed: any = await parser.parsedata(map, null);
		expect(parsed.CL_FORBIDDEN_ZONES).toEqual([ZONE_A]);
		expect(() => readOverlaysFromMap(parsed)).toThrow(/CL_FORBIDDEN_ZONES/);
	});
});
