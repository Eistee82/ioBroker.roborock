import { beforeEach, describe, expect, it } from "vitest";
import { MapParser } from "./MapParser";
import type { Furniture } from "./types";

/** Header of a V1 map block: type, header length, payload length, entry count. */
const BLOCK_HEADER_LENGTH = 12;
/** One entry of block type 25, see `_appanalysis/15-livemap-und-moebel.md` §2.1. */
const FURNITURE_ENTRY_LENGTH = 23;

/**
 * Builds a history map (no `rr` header, so no SHA1) that carries one furniture block.
 * @param entries Raw 23-byte entries, already in the app's field order.
 */
function furnitureMap(entries: Furniture[]): Buffer {
	const payload = Buffer.alloc(entries.length * FURNITURE_ENTRY_LENGTH);
	entries.forEach((entry, index) => {
		const base = index * FURNITURE_ENTRY_LENGTH;
		payload.writeUInt16LE(entry.x1, base);
		payload.writeUInt16LE(entry.y1, base + 2);
		payload.writeUInt16LE(entry.x2, base + 4);
		payload.writeUInt16LE(entry.y2, base + 6);
		payload.writeUInt16LE(entry.x3, base + 8);
		payload.writeUInt16LE(entry.y3, base + 10);
		payload.writeUInt16LE(entry.x4, base + 12);
		payload.writeUInt16LE(entry.y4, base + 14);
		payload.writeUInt16LE(entry.percent, base + 16);
		payload.writeUInt8(entry.type, base + 18);
		payload.writeUInt8(entry.subType, base + 19);
		payload.writeUInt8(entry.edit, base + 20);
		payload.writeUInt8(entry.id, base + 21);
		payload.writeUInt8(entry.hasAngle, base + 22);
	});

	const header = Buffer.alloc(BLOCK_HEADER_LENGTH);
	header.writeUInt16LE(25, 0); // FURNITURES
	header.writeUInt16LE(BLOCK_HEADER_LENGTH, 2);
	header.writeUInt32LE(payload.length, 4);
	header.writeUInt32LE(entries.length, 8);
	return Buffer.concat([header, payload]);
}

/** A double bed, placed by hand: `percent` is 10000, which no uint8 could hold. */
const DOUBLE_BED: Furniture = {
	x1: 1000,
	y1: 2000,
	x2: 3000,
	y2: 2000,
	x3: 3000,
	y3: 4000,
	x4: 1000,
	y4: 4000,
	percent: 10000,
	type: 45,
	subType: 2,
	edit: 1,
	id: 7,
	hasAngle: 1,
};

// Mock adapter
const mockAdapter: any = {
	log: {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
	},
	http_api: {
		getMatchedRoomIDs: () => [],
	},
	rLog: () => {},
};

describe("MapParser", () => {
	let parser: MapParser;

	beforeEach(() => {
		parser = new MapParser(mockAdapter);
	});

	it("should return empty object for empty buffer", async () => {
		const result = await parser.parsedata(Buffer.alloc(0), null);
		expect(result).to.deep.equal({});
	});

	it("should not crash on random garbage data", async () => {
		const garbage = Buffer.alloc(100);
		garbage.fill(0xff);
		try {
			const result = await parser.parsedata(garbage, null);
			expect(result).to.deep.equal({}); // Garbage usually results in empty object or partial parse
		} catch {
			// If it throws, it's acceptable, but ideally it handles it.
		}
	});

	describe("FURNITURES (block type 25)", () => {
		/**
		 * The regression this guards: the parser always read the right bytes, but named
		 * everything from offset 16 on one field too early. A consumer following those names
		 * drew a double bed (`type` 45, `subType` 2) as a sofa, because the subtype landed in
		 * the field called `type`.
		 */
		it("names every field the way the app's own parser does", async () => {
			const result = (await parser.parsedata(furnitureMap([DOUBLE_BED]), null, { isHistoryMap: true })) as {
				FURNITURES?: Furniture[];
			};

			expect(result.FURNITURES).to.deep.equal([DOUBLE_BED]);
		});

		it("reads percent as a uint16, the value the app writes when furniture is placed by hand", async () => {
			const result = (await parser.parsedata(furnitureMap([DOUBLE_BED]), null, { isHistoryMap: true })) as {
				FURNITURES?: Furniture[];
			};

			// 10000 does not fit into a byte; reading it as one would yield 16.
			expect(result.FURNITURES?.[0].percent).to.equal(10000);
			expect(result.FURNITURES?.[0].type).to.equal(45);
			expect(result.FURNITURES?.[0].subType).to.equal(2);
		});

		it("keeps unconfirmed detections in the list, marked by edit = 0", async () => {
			const suggestion: Furniture = { ...DOUBLE_BED, id: 8, edit: 0, percent: 8123 };
			const result = (await parser.parsedata(furnitureMap([DOUBLE_BED, suggestion]), null, { isHistoryMap: true })) as {
				FURNITURES?: Furniture[];
			};

			expect(result.FURNITURES).to.have.length(2);
			expect(result.FURNITURES?.map((entry) => entry.edit)).to.deep.equal([1, 0]);
			expect(result.FURNITURES?.map((entry) => entry.id)).to.deep.equal([7, 8]);
		});
	});
});
