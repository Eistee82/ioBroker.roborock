import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "extract_appplugin_value_lists.js");
const shippedPath = path.join(repoRoot, "lib", "protocols", "roborock_value_lists.json");

interface RawEntry {
	value: number;
	key: string;
	line: number;
}

interface RawTable {
	register: string;
	startLine: number;
	endLine: number;
	entries: RawEntry[];
	overrides: RawEntry[];
}

const extractor = require(scriptPath) as {
	parseValueListTables: (lines: string[]) => RawTable[];
	classifyValueList: (table: RawTable) => {
		dominantFamily: string | null;
		values: RawEntry[];
		holes: (RawEntry & { reason: string })[];
	};
	parseNamedEnums: (lines: string[]) => { name: string; line: number; members: { name: string; value: number }[]; contiguous: boolean }[];
	matchRpcForName: (listName: string, rpcNames: Set<string>) => string | null;
	nameTokens: (name: string) => string[];
	labelFamily: (key: string) => string;
	collectRpcNames: (bundleText: string) => Set<string>;
	readLiteralItem: (buf: Buffer, base: number, offset: number, strings: string[]) => { kind: number; values: unknown[]; byteLength: number } | null;
	readLiteralRun: (buf: Buffer, base: number, offset: number, count: number, strings: string[]) => unknown[] | null;
	verifyEnumAgainstBytecode: (
		entry: { members: { name: string; value: number }[] },
		paired: { keys: string[]; values: unknown[]; keyOffset: number; valueOffset: number }[]
	) => {
		agrees: boolean;
		differences: { name: string; fromDecompilate: number; fromBytecode: number }[];
		signFixes: { name: string; renderedUnsigned: number; actual: number }[];
		members: { name: string; value: unknown }[];
	} | null;
};

/**
 * Builds the three-line idiom the Hermes decompiler emits for `map[value] = strings.key`.
 * @param register Target register of the map being built.
 * @param value The number the label is filed under.
 * @param key The i18n key.
 * @param via Register the catalogue and the label travel through.
 * @returns The three lines.
 */
function entryLines(register: string, value: number, key: string, via = "r10"): string[] {
	return [`        ${via} = ${via}.strings;`, `        ${via} = ${via}.${key};`, `        ${register}[${value}] = ${via};`];
}

/**
 * The dust collection picker as it stands in the a65 control plugin at A65:853673-853693,
 * including the filler at index 3 and the register reset that ends it.
 * @returns The bundle lines.
 */
function dustCollectionSnippet(): string[] {
	return [
		"        r8 = {};",
		...entryLines("r8", 0, "dust_collection_title_1"),
		...entryLines("r8", 1, "dust_collection_title_2"),
		...entryLines("r8", 2, "dust_collection_title_3"),
		...entryLines("r8", 3, "localization_strings_Common_Protocol_2"),
		...entryLines("r8", 4, "dust_collection_title_5"),
		"        var _closure1_slot16 = r8;",
		"        r8 = {};",
		...entryLines("r8", 7200, "dock_kit_setting2"),
		...entryLines("r8", 7201, "dock_kit_setting3"),
		...entryLines("r8", 7202, "dock_kit_setting4"),
	];
}

describe("parseValueListTables", () => {
	it("reads the dust collection picker as one table of five slots", () => {
		const tables = extractor.parseValueListTables(dustCollectionSnippet());

		expect(tables).toHaveLength(2);
		expect(tables[0].entries.map((entry) => entry.value)).toEqual([0, 1, 2, 3, 4]);
		expect(tables[1].entries.map((entry) => entry.value)).toEqual([7200, 7201, 7202]);
	});

	it("ends a table at the register reset, not at the next index", () => {
		// Without the `r8 = {};` rule the dock table at 7200 would be swallowed by the picker,
		// because 7200 is still an increasing index.
		const tables = extractor.parseValueListTables(dustCollectionSnippet());

		expect(tables[0].entries.some((entry) => entry.value === 7200)).toBe(false);
	});

	it("rejects three lines that only look like an entry", () => {
		// The label has to be picked out of the register the catalogue went into, and the value
		// filed has to be the register the label went into. Otherwise any coincidental sequence
		// in a million lines becomes a table entry.
		const wrongChain = [
			"        r10 = r10.strings;",
			"        r11 = r9.dust_collection_title_1;",
			"        r8[0] = r11;",
			...entryLines("r8", 1, "dust_collection_title_2"),
			...entryLines("r8", 2, "dust_collection_title_3"),
		];

		const tables = extractor.parseValueListTables(wrongChain);
		expect(tables).toHaveLength(1);
		expect(tables[0].entries.map((entry) => entry.value)).toEqual([1, 2]);
	});

	it("treats a repeated index as an override, and a restart from the bottom as a new table", () => {
		// The obstacle table at A65:379055 writes index 34 twice and is then followed by the
		// description table starting at 0. One of those is a continuation, the other is not.
		const lines = [
			...entryLines("r0", 0, "map_object_name_xian"),
			...entryLines("r0", 34, "map_object_name_zhiwu"),
			...entryLines("r0", 70, "map_object_name_paperbag"),
			...entryLines("r0", 34, "map_object_name_sock"),
			...entryLines("r0", 0, "map_object_desc_xian"),
			...entryLines("r0", 34, "map_object_desc_zhiwu"),
		];

		const tables = extractor.parseValueListTables(lines);

		expect(tables).toHaveLength(2);
		expect(tables[0].entries.find((entry) => entry.value === 34)?.key).toBe("map_object_name_sock");
		expect(tables[0].overrides.map((entry) => entry.key)).toEqual(["map_object_name_zhiwu"]);
		expect(tables[1].entries.map((entry) => entry.key)).toEqual(["map_object_desc_xian", "map_object_desc_zhiwu"]);
	});
});

describe("classifyValueList - the rule that keeps a wrong number away from the robot", () => {
	it("offers 0/1/2/4 for dust collection and calls 3 a hole", () => {
		// The whole point of this extractor. Three sources in the plugin claim to answer "which
		// dust collection values exist":
		//   the debug table at A65:379765          -> 0,1,2,3    (telemetry, not a picker)
		//   DustCollectionModeSettingMap A65:238392 -> 0,1,2,3,4 (value stock, not the offer)
		//   the built list at A65:853673            -> 0,1,2,4   (what the app offers)
		// Index 3 carries a generic filler string. Reading either of the first two sends the
		// wrong number for "strongest".
		const table = extractor.parseValueListTables(dustCollectionSnippet())[0];
		const classified = extractor.classifyValueList(table);

		expect(classified.dominantFamily).toBe("dust_collection_title");
		expect(classified.values.map((entry) => entry.value)).toEqual([0, 1, 2, 4]);
		expect(classified.holes).toHaveLength(1);
		expect(classified.holes[0].value).toBe(3);
		expect(classified.holes[0].key).toBe("localization_strings_Common_Protocol_2");
		expect(classified.holes[0].reason).toContain("filler");
	});

	it("does not invent a hole when two entries share a key by coincidence", () => {
		// The dock error map at A65:430495 files the same key under codes 1 and 38. A plain
		// majority rule made that key the family and threw the third entry away as a hole - the
		// table then fell under the minimum and vanished. A family needs a numbered series.
		const lines = [
			...entryLines("r7", 1, "dock_info_clear_water_box_exception1"),
			...entryLines("r7", 38, "dock_info_clear_water_box_exception1"),
			...entryLines("r7", 48, "error_up_water_title"),
		];

		const classified = extractor.classifyValueList(extractor.parseValueListTables(lines)[0]);

		expect(classified.dominantFamily).toBeNull();
		expect(classified.holes).toHaveLength(0);
		expect(classified.values).toHaveLength(3);
	});

	it("keeps every entry of a table that is heterogeneous on purpose", () => {
		// The 40 finish reasons at A65:379302 mix six families. Filtering there would delete
		// most of the table.
		const lines = [
			...entryLines("r0", 21, "finsh_reason_by_manual_interrupt"),
			...entryLines("r0", 45, "finsh_reason_by_locate_fail"),
			...entryLines("r0", 67, "cleanout_the_error"),
			...entryLines("r0", 68, "back_to_the_wash_failure"),
			...entryLines("r0", 114, "video_patrol_record_video_patrol_success"),
		];

		const classified = extractor.classifyValueList(extractor.parseValueListTables(lines)[0]);

		expect(classified.dominantFamily).toBeNull();
		expect(classified.values).toHaveLength(5);
		expect(classified.holes).toHaveLength(0);
	});

	it("strips only a trailing number when forming a family", () => {
		expect(extractor.labelFamily("dust_collection_title_5")).toBe("dust_collection_title");
		// No underscore before the digits - not a numbered series member.
		expect(extractor.labelFamily("dock_info_clear_water_box_exception1")).toBe("dock_info_clear_water_box_exception1");
		expect(extractor.labelFamily("map_object_name_cat")).toBe("map_object_name_cat");
	});
});

describe("parseNamedEnums", () => {
	it("reads a named enum and notices when its values have gaps", () => {
		const lines = [
			"            r3 = {'WashTowelModeQuick': 0, 'WashTowelModeDaily': 1, 'WashTowelModeDeep': 2, 'WashTowelModeSuperDeep': 8, 'WashTowelModeSmart': 10};",
			"            r2['WashTowelModeMap'] = r3;",
		];

		const [found] = extractor.parseNamedEnums(lines);

		expect(found.name).toBe("WashTowelModeMap");
		expect(found.members).toHaveLength(5);
		// 2 -> 8 -> 10. Anyone inferring "five entries, so 0..4" gets four of them wrong.
		expect(found.contiguous).toBe(false);
	});

	it("ignores an object that only looks like an enum", () => {
		// `iconOverMap` passes the name filter with width/height/marginLeft and was the single
		// false positive among the 40 the filter keeps.
		const lines = [
			"            r0 = {'width': 16, 'height': 16, 'marginLeft': 8};",
			"            r1['iconOverMap'] = r0;",
		];

		expect(extractor.parseNamedEnums(lines)).toHaveLength(0);
	});

	it("ignores an object with no device-facing name", () => {
		const lines = [
			"            r0 = {'alpha': 1, 'beta': 2, 'gamma': 3};",
			"            r1['someInternalThing'] = r0;",
		];

		expect(extractor.parseNamedEnums(lines)).toHaveLength(0);
	});
});

describe("matchRpcForName - proposes a setter, never invents one", () => {
	const rpcNames = new Set([
		"set_dust_collection_mode",
		"set_wash_towel_mode",
		"set_custom_mode",
		"app_set_robot_setting",
		"get_dust_collection_mode",
	]);

	it("links a list to the setter whose name stem is identical", () => {
		expect(extractor.matchRpcForName("dust_collection_title", rpcNames)).toBe("set_dust_collection_mode");
		expect(extractor.matchRpcForName("WashTowelModeMap", rpcNames)).toBe("set_wash_towel_mode");
	});

	it("stays silent where the names simply do not line up", () => {
		// Suction is `CleanSettingMode` in the plugin and `set_custom_mode` on the wire. No name
		// matching can bridge that, and guessing it would be a wrong number on a real robot.
		expect(extractor.matchRpcForName("CleanSettingMode", rpcNames)).toBeNull();
	});

	it("never links a reported vocabulary to a setter", () => {
		// `RobotStateCode` reduced to {robot} and was offered `app_set_robot_setting`. That was the
		// only false link the matcher produced over the whole a65 bundle.
		expect(extractor.matchRpcForName("RobotStateCode", rpcNames)).toBeNull();
		expect(extractor.matchRpcForName("PanStatus", rpcNames)).toBeNull();
	});

	it("drops the container words but keeps the subject", () => {
		expect(extractor.nameTokens("DustCollectionModeSettingMap")).toEqual(["collection", "dust"]);
		expect(extractor.nameTokens("dust_collection_title")).toEqual(["collection", "dust"]);
	});

	it("finds the RPC names it matches against in the bundle text", () => {
		const names = extractor.collectRpcNames("r1 = 'set_dust_collection_mode'; r2 = 'get_status';");
		expect(names.has("set_dust_collection_mode")).toBe(true);
		expect(names.has("get_status")).toBe(true);
	});
});

describe("readLiteralItem - the offset is the item header, not the first value", () => {
	/**
	 * Builds one serialized literal item: tag byte, then the values.
	 * @param tag SLP tag (0x70 integer, 0x50 short string).
	 * @param values The values to encode.
	 * @returns The encoded item.
	 */
	function item(tag: number, values: number[]): Buffer {
		const width = tag === 0x70 ? 4 : 2;
		const buf = Buffer.alloc(1 + values.length * width);
		buf.writeUInt8(tag | values.length, 0);
		values.forEach((value, index) => {
			if (tag === 0x70) buf.writeInt32LE(value, 1 + index * 4);
			else buf.writeUInt16LE(value, 1 + index * 2);
		});
		return buf;
	}

	it("reads an integer run", () => {
		const buf = Buffer.concat([Buffer.alloc(4), item(0x70, [0, 1, 2, 3, 4])]);
		expect(extractor.readLiteralItem(buf, 4, 0, [])?.values).toEqual([0, 1, 2, 3, 4]);
	});

	it("reads negative integers as negative", () => {
		// The whole point of preferring the bytecode: -10000 stays -10000 here, while the
		// decompilate renders it 4294957296.
		const buf = item(0x70, [-1, -10000]);
		expect(extractor.readLiteralItem(buf, 0, 0, [])?.values).toEqual([-1, -10000]);
	});

	it("reads a short-string run through the string table", () => {
		const buf = item(0x50, [2, 0]);
		expect(extractor.readLiteralItem(buf, 0, 0, ["Smart", "Quick", "Daily"])?.values).toEqual(["Daily", "Smart"]);
	});

	it("returns nothing rather than nonsense when the offset points past the end", () => {
		expect(extractor.readLiteralItem(Buffer.alloc(4), 0, 999, [])).toBeNull();
	});

	it("misreads the item when the offset is off by one - which is why it must be the header", () => {
		// The mistake this cost once: a byte scan found the keys at 29836, the item begins at
		// 29835, and searching for an instruction carrying 29836 therefore found nothing.
		const buf = item(0x70, [0, 1, 2, 3, 4]);
		expect(extractor.readLiteralItem(buf, 0, 0, [])?.values).toEqual([0, 1, 2, 3, 4]);
		expect(extractor.readLiteralItem(buf, 0, 1, [])?.values).not.toEqual([0, 1, 2, 3, 4]);
	});

	it("reports how many bytes it consumed, so a run can continue after it", () => {
		expect(extractor.readLiteralItem(item(0x70, [1, 2]), 0, 0, [])?.byteLength).toBe(1 + 2 * 4);
		expect(extractor.readLiteralItem(item(0x50, [1]), 0, 0, ["a", "b"])?.byteLength).toBe(1 + 2);
	});
});

describe("readLiteralRun - one item is not one object", () => {
	/**
	 * @param tag SLP tag.
	 * @param count Number of values.
	 * @param write Writes one value.
	 * @param width Bytes per value.
	 * @returns The encoded item.
	 */
	function raw(tag: number, count: number, write: (buf: Buffer, at: number, index: number) => void, width: number): Buffer {
		const buf = Buffer.alloc(1 + count * width);
		buf.writeUInt8(tag | count, 0);
		for (let index = 0; index < count; index++) write(buf, 1 + index * width, index);
		return buf;
	}

	it("collects values across several items until the count is reached", () => {
		// Hermes packs the buffers by kind: a run of nulls, then a run of integers. An object with
		// three values can therefore span two items, and reading only the first returns two.
		const nulls = Buffer.from([0x00 | 2]);
		const ints = raw(0x70, 1, (b, at) => b.writeInt32LE(7, at), 4);
		const buf = Buffer.concat([nulls, ints]);

		expect(extractor.readLiteralItem(buf, 0, 0, [])?.values).toEqual([null, null]);
		expect(extractor.readLiteralRun(buf, 0, 0, 3, [])).toEqual([null, null, 7]);
	});

	it("refuses rather than guessing when the values do not add up", () => {
		const buf = raw(0x70, 2, (b, at, index) => b.writeInt32LE(index, at), 4);
		expect(extractor.readLiteralRun(buf, 0, 0, 5, [])).toBeNull();
	});

	it("returns exactly the requested count, not the whole item", () => {
		const buf = raw(0x70, 5, (b, at, index) => b.writeInt32LE(index, at), 4);
		expect(extractor.readLiteralRun(buf, 0, 0, 5, [])).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("verifyEnumAgainstBytecode", () => {
	const dust = {
		keys: ["DustCollectionModeSmart", "DustCollectionModeQuick", "DustCollectionModeDaily", "DustCollectionModeStrong", "DustCollectionModeMax"],
		values: [0, 1, 2, 3, 4],
		keyOffset: 29835,
		valueOffset: 93028,
	};

	it("matches by key set, not by name - the bytecode does not know the name", () => {
		const check = extractor.verifyEnumAgainstBytecode(
			{ members: dust.keys.map((name, index) => ({ name, value: index })) },
			[dust]
		);
		expect(check?.agrees).toBe(true);
		expect(check?.differences).toHaveLength(0);
	});

	it("calls an unsigned rendering a correction, not a conflict", () => {
		// Same 32 bits, different lens. `mapOpErrorCode` is the real case: the decompilate says
		// 4294957296, the bytecode says -10000, and a robot answers with -10000.
		const check = extractor.verifyEnumAgainstBytecode(
			{ members: [{ name: "VENDOR_ERROR_CODE", value: 4294957296 }] },
			[{ keys: ["VENDOR_ERROR_CODE"], values: [-10000], keyOffset: 1, valueOffset: 2 }]
		);
		expect(check?.agrees).toBe(true);
		expect(check?.differences).toHaveLength(0);
		expect(check?.signFixes).toEqual([{ name: "VENDOR_ERROR_CODE", renderedUnsigned: 4294957296, actual: -10000 }]);
	});

	it("reports a real disagreement as one", () => {
		const check = extractor.verifyEnumAgainstBytecode(
			{ members: [{ name: "Mode", value: 3 }] },
			[{ keys: ["Mode"], values: [7], keyOffset: 1, valueOffset: 2 }]
		);
		expect(check?.agrees).toBe(false);
		expect(check?.differences).toEqual([{ name: "Mode", fromDecompilate: 3, fromBytecode: 7 }]);
	});

	it("says nothing when the bytecode has no object with that key set", () => {
		expect(extractor.verifyEnumAgainstBytecode({ members: [{ name: "Unknown", value: 1 }] }, [dust])).toBeNull();
	});
});

describe("the shipped lib/protocols/roborock_value_lists.json", () => {
	const shipped = JSON.parse(fs.readFileSync(shippedPath, "utf8"));

	it("carries the dust collection picker with 0/1/2/4 and the hole at 3", () => {
		const list = shipped.valueLists.find((entry: any) => entry.id === "dust_collection_title");

		expect(list).toBeDefined();
		expect(list.kind).toBe("picker");
		expect(list.values.map((value: any) => value.value)).toEqual([0, 1, 2, 4]);
		expect(list.holes.map((hole: any) => hole.value)).toEqual([3]);
		expect(list.rpc).toBe("set_dust_collection_mode");
		expect(list.values.at(-1).labels.en).toBe("Max");
	});

	it("carries the full NewFeatureStrBit table, which the adapter reads five bits of by hand", () => {
		const bits = shipped.enums.find((entry: any) => entry.name === "NewFeatureStrBit");

		expect(bits.members).toHaveLength(46);
		expect(bits.members.find((member: any) => member.name === "MopShakeWaterMax").value).toBe(45);
		expect(bits.members.find((member: any) => member.name === "Matter").value).toBe(67);
	});

	it("says where every single value came from", () => {
		for (const list of shipped.valueLists) {
			expect(list.source, `${list.id} without a source`).toMatch(/:\d+-\d+$/);
			for (const value of list.values) {
				expect(value.source, `${list.id}/${value.value} without a source`).toMatch(/:\d+$/);
			}
			for (const hole of list.holes) {
				expect(hole.source).toMatch(/:\d+$/);
				expect(hole.reason.length).toBeGreaterThan(0);
			}
		}
		for (const entry of shipped.enums) {
			expect(entry.source, `${entry.name} without a source`).toMatch(/:\d+$/);
		}
	});

	it("shows what it could not resolve instead of leaving a gap", () => {
		expect(shipped.unresolved.length).toBeGreaterThan(0);
		for (const entry of shipped.unresolved) {
			expect(entry.reason.length).toBeGreaterThan(0);
			expect(Array.isArray(entry.sources)).toBe(true);
			expect(entry.sources.length).toBeGreaterThan(0);
		}
	});

	it("leaks no local path and pins the bundle it was built from", () => {
		const serialized = JSON.stringify(shipped);
		expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
		expect(serialized).not.toContain("_appanalysis");
		for (const source of shipped._meta.sources) {
			expect(source.sha256).toMatch(/^[0-9a-f]{16}$/);
		}
	});

	it("says for every enum whether the bytecode confirmed it", () => {
		for (const entry of shipped.enums) {
			expect(entry.verifiedAgainstBytecode, `${entry.name} without a verdict`).toBeTruthy();
		}
		// With the pure-JS scan every enum is reachable: 37 confirmed, 2 corrected for signedness.
		// Nothing is left on "not run" or unmatched, which is what the run reader bought.
		const unverified = shipped.enums.filter((e: any) => !String(e.verifiedAgainstBytecode).match(/confirmed|corrected/));
		expect(unverified.map((e: any) => e.name)).toEqual([]);
	});

	it("carries no unresolved conflict between decompilate and bytecode", () => {
		// A conflict is allowed to exist - it may not be hidden. If one ever appears it belongs in
		// `unresolved` too, and this test is the reminder to look at it rather than ship it.
		const conflicts = shipped.enums.filter((e: any) => e.verifiedAgainstBytecode === "CONFLICT");
		for (const entry of conflicts) {
			expect(entry.conflict, `${entry.name} marked CONFLICT without detail`).toBeTruthy();
			expect(shipped.unresolved.some((u: any) => String(u.detail).startsWith(entry.name))).toBe(true);
		}
	});

	it("publishes the error codes as the negative numbers a robot actually sends", () => {
		// The single most useful thing the bytecode check produced: the decompilate rendered these
		// unsigned, and 4294957296 would never have matched a real -10000.
		const codes = shipped.enums.find((entry: any) => entry.name === "mapOpErrorCode");
		expect(codes.verifiedAgainstBytecode).toContain("corrected");
		expect(codes.members.find((m: any) => m.name === "VENDOR_ERROR_CODE").value).toBe(-10000);
		// The superseded reading stays visible next to it.
		expect(codes.membersFromDecompilate.find((m: any) => m.name === "VENDOR_ERROR_CODE").value).toBe(4294957296);
	});

	it("names the bytecode offsets it verified against", () => {
		for (const entry of shipped.enums) {
			if (!String(entry.verifiedAgainstBytecode).match(/confirmed|corrected/)) continue;
			expect(entry.bytecodeSource, `${entry.name} without bytecode offsets`).toMatch(/^objKeyBuffer@\d+ objValueBuffer@\d+$/);
		}
	});

	it("labels every list as picker, code table or generic strings", () => {
		for (const list of shipped.valueLists) {
			expect(["picker", "code-table", "generic-strings"]).toContain(list.kind);
			// Only a numbered picker can have a hole - anything else keeps all its entries.
			if (list.kind !== "picker") expect(list.holes).toHaveLength(0);
			// And only a picker is ever linked to a setter.
			if (list.kind !== "picker") expect(list.rpc).toBeNull();
		}
	});
});
