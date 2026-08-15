#!/usr/bin/env node

/**
 * Extracts the value lists and named enums a Roborock AppPlugin uses for its own pickers.
 *
 * ## What this is for
 *
 * Every mode a robot understands - suction, water, mop, dust collection, wash - is a number, and
 * the adapter has to know which numbers a device is actually offered and what each one is called.
 * Until now that came from reading the decompiled control plugin by hand, one table per analysis
 * round. The tables are regular enough to lift out mechanically; this script does that.
 *
 * ## The rule that makes the difference: extract the list, not the enum
 *
 * There are three places in the plugin that look like they answer "which values exist", and two of
 * them are wrong. Dust collection is the worked example (control plugin `a65_control_v5208`):
 *
 * | Source | Says | Verdict |
 * | --- | --- | --- |
 * | `KeyTranslation[541]`/`ValueTranslation[541]`, A65:379765 | 0,1,2,3 | **wrong** - that is the debug/telemetry view, not a picker |
 * | `DustCollectionModeSettingMap`, A65:238392 | 0,1,2,3,4 | the manufacturer's *value stock*, not the offer |
 * | the built list, A65:853673-853693 | 0,1,2,**4** | what the app really offers |
 *
 * Index 3 exists in the built list, but its label is `localization_strings_Common_Protocol_2` - a
 * generic filler string, not a dust collection mode. So `Strong` is a hole. Whoever reads the
 * telemetry table sends 3 for "strongest"; whoever reads the enum offers a level the app does not.
 *
 * This script therefore extracts the **built list** (§`parseValueListTables`) and marks entries
 * whose label falls outside the table's own naming family as holes rather than values
 * (§`classifyValueList`). The named enums are extracted too, but into a separate section, labelled
 * as what they are.
 *
 * ## What it refuses to do
 *
 * - It does not decide which value a device supports. That hangs on feature bits and the model
 *   table, neither of which is in these tables.
 * - It does not invent an RPC. A list is linked to a setter only when the name stems match
 *   exactly and that setter really occurs in the bundle; otherwise `rpc` stays `null`.
 * - It does not drop what it cannot read. Anything unparsed lands in `unresolved` with a reason.
 *   A table with silent gaps is more dangerous than one with visible ones.
 *
 * Usage:
 *   node scripts/extract_appplugin_value_lists.js --bundle <decompiled.js> [...]
 *   node scripts/extract_appplugin_value_lists.js --root .AppPlugins
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { discoverPluginInstances } = require("./extract_appplugin_translations.js");

const REPO_ROOT = path.join(__dirname, "..");
const DEFAULT_APPPLUGINS_ROOT = path.join(REPO_ROOT, ".AppPlugins");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "lib", "protocols", "roborock_value_lists.json");
const DEFAULT_TRANSLATIONS = path.join(REPO_ROOT, "lib", "protocols", "roborock_strings.json");
const DEFAULT_LANGUAGES = ["en", "de"];

/** A table needs this many surviving values before it is worth publishing. */
const MIN_TABLE_ENTRIES = 3;

/** A naming family has to cover this share of a table before outliers count as holes. */
const DOMINANT_FAMILY_SHARE = 2 / 3;

/**
 * Words that say what a table *is* rather than what it is *about*. Dropped before an RPC is
 * matched, so `DustCollectionModeSettingMap` and `set_dust_collection_mode` reduce to the same
 * two tokens.
 */
const GENERIC_NAME_TOKENS = new Set([
	"map", "mode", "modes", "setting", "settings", "title", "titles", "name", "names",
	"index", "code", "codes", "type", "types", "status", "state", "level", "levels",
	"enum", "list", "value", "values", "pag", "icon", "icons", "desc", "text", "label",
]);

// --- Line patterns of the Hermes decompilate ---------------------------------------------------

/** `r10 = r10.strings;` - the label catalogue is picked up. */
const RE_STRINGS = /^\s*(r\d+) = (r\d+)\.strings;$/;
/** `r10 = r10.dust_collection_title_1;` - one label is picked out of it. */
const RE_KEY_PICK = /^\s*(r\d+) = (r\d+)\.([A-Za-z_][\w]*);$/;
/** `r8[0] = r10;` - the label is filed under its number. */
const RE_INDEX_ASSIGN = /^\s*(r\d+)\[(\d+)\] = (r\d+);$/;
/** `r8 = {};` - the register is reused, which ends the table. */
const RE_REGISTER_RESET = /^\s*(r\d+) = \{\};$/;
/** `r3 = {'DustCollectionModeSmart': 0, …};` */
const RE_ENUM_LITERAL = /^\s*r\d+ = \{((?:'[A-Za-z_][\w]*': -?\d+(?:, )?)+)\};$/;
/** `r2['DustCollectionModeSettingMap'] = r3;` */
const RE_ENUM_NAME = /^\s*r\d+\['([A-Za-z_][\w]*)'\] = r\d+;$/;
/** Device-facing enum names end in one of these. Without the filter it is 1449 style objects. */
const RE_DEVICE_ENUM_NAME = /(Map|Mode|Type|Status|State|Code|Level|Index|Enum|Bit)$/;
/**
 * A name ending in one of these describes what the robot *reports*, not what it can be told.
 * Excluded from setter matching - see {@link matchRpcForName}.
 */
const RE_REPORTED_ENUM_NAME = /(Status|State|Code)$/;
/**
 * Member names that give a layout object away. `iconOverMap` passes the name filter with
 * `{width, height, marginLeft}` and is the one false positive among the 40 the filter keeps.
 */
const LAYOUT_MEMBER_NAMES = new Set([
	"width", "height", "top", "left", "right", "bottom", "size", "radius", "opacity",
	"flex", "zindex", "fontsize", "lineheight", "margin", "padding", "gap", "borderwidth",
]);
/** RPC names as string literals, same alphabet as `_appanalysis/tools/index-bundle.js`. */
const RE_RPC_LITERAL = /'((?:get|set|app|load|save|start|stop|del|reset|change|switch|upd)_[a-z0-9_]{2,})'/g;

/** More than this many lines without an entry ends a table. */
const MAX_ENTRY_GAP = 12;

/**
 * Parses the command line.
 * @param {string[]} argv Arguments without node and script path.
 * @returns {object} Parsed options.
 */
function parseArgs(argv) {
	const options = {
		root: DEFAULT_APPPLUGINS_ROOT,
		bundles: [],
		plugin: undefined,
		out: DEFAULT_OUTPUT,
		translations: DEFAULT_TRANSLATIONS,
		languages: DEFAULT_LANGUAGES.slice(),
		quiet: false,
		noWrite: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--root" && argv[index + 1]) options.root = path.resolve(argv[++index]);
		else if (arg === "--bundle" && argv[index + 1]) options.bundles.push(path.resolve(argv[++index]));
		else if (arg === "--plugin" && argv[index + 1]) options.plugin = argv[++index];
		else if (arg === "--out" && argv[index + 1]) options.out = path.resolve(argv[++index]);
		else if (arg === "--translations" && argv[index + 1]) options.translations = path.resolve(argv[++index]);
		else if (arg === "--languages" && argv[index + 1]) options.languages = argv[++index].split(",").map((l) => l.trim()).filter(Boolean);
		else if (arg === "--quiet") options.quiet = true;
		else if (arg === "--no-write") options.noWrite = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else throw new Error(`Unknown or incomplete argument: ${arg}`);
	}

	return options;
}

/** Prints the usage text. */
function printHelp() {
	console.log(`Usage: node scripts/extract_appplugin_value_lists.js [options]

Options:
  --bundle <file>        A decompiled Hermes bundle to read. May be repeated.
                         Without it the script looks for bundles under --root.
  --root <dir>           Root holding .AppPlugins (default: ${DEFAULT_APPPLUGINS_ROOT})
  --plugin <name>        Only process a matching AppPlugin path or model name
  --out <file>           Output file (default: lib/protocols/roborock_value_lists.json)
  --translations <file>  Label catalogue (default: lib/protocols/roborock_strings.json)
  --languages <a,b>      Languages to resolve labels into (default: ${DEFAULT_LANGUAGES.join(",")})
  --no-write             Analyse only, write nothing
  --quiet                Reduce console output
  --help                 Show this text
`);
}

/**
 * Reads a text file, tolerating both line endings.
 * @param {string} filePath Path to read.
 * @returns {string[]} The lines, without their terminator.
 */
function readLines(filePath) {
	return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
}

// --- Value lists ------------------------------------------------------------------------------

/**
 * Finds every `<number> -> <label key>` table the plugin builds.
 *
 * The shape it recognises is the three-line idiom the decompiler produces for
 * `map[n] = strings.someKey`:
 *
 * ```
 * r10 = r10.strings;                       <- RE_STRINGS
 * r10 = r10.dust_collection_title_1;       <- RE_KEY_PICK
 * r8[0] = r10;                             <- RE_INDEX_ASSIGN
 * ```
 *
 * The register chain is checked, not just the shape: the key must be picked out of the register
 * the catalogue was loaded into, and the value filed must be the register the key went to. Without
 * that check any three unrelated lines in the right order would produce an entry.
 *
 * A table ends at whichever comes first:
 *
 * - `r8 = {};` for the same register - the builder starting the next map. This is what separates
 *   the dust collection list from the dock table that follows it at A65:853695.
 * - a different target register.
 * - an index at or below the table's lowest so far, which is a second table restarting rather
 *   than a continuation. A higher index that was already used is an **override**, not a break -
 *   the obstacle table at A65:379055 writes 34 twice - and it is recorded as one.
 * - more than {@link MAX_ENTRY_GAP} lines without an entry.
 * @param {string[]} lines The decompiled bundle, line by line.
 * @returns {object[]} One entry per table, in file order.
 */
function parseValueListTables(lines) {
	const tables = [];
	let open = null;

	const close = () => {
		if (open && open.entries.length > 0) tables.push(open);
		open = null;
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];

		const reset = RE_REGISTER_RESET.exec(line);
		if (reset && open && reset[1] === open.register) {
			close();
			continue;
		}

		const assign = RE_INDEX_ASSIGN.exec(line);
		if (!assign) {
			if (open && index - open.lastLineIndex > MAX_ENTRY_GAP) close();
			continue;
		}

		const keyPick = RE_KEY_PICK.exec(lines[index - 1] || "");
		const strings = RE_STRINGS.exec(lines[index - 2] || "");
		if (!keyPick || !strings) {
			if (open && index - open.lastLineIndex > MAX_ENTRY_GAP) close();
			continue;
		}
		// The registers have to line up, or these three lines only look like a table entry.
		if (keyPick[1] !== assign[3] || strings[1] !== keyPick[2]) {
			if (open && index - open.lastLineIndex > MAX_ENTRY_GAP) close();
			continue;
		}

		const register = assign[1];
		const value = Number(assign[2]);
		const key = keyPick[3];

		if (open && register !== open.register) close();
		if (open && open.entries.length >= 2 && value <= open.minValue) close();

		if (!open) {
			open = { register, startLine: index + 1, entries: [], overrides: [], minValue: value, lastLineIndex: index };
		}

		const existing = open.entries.findIndex((entry) => entry.value === value);
		if (existing >= 0) {
			// A later write wins at runtime; keep the earlier one visible instead of losing it.
			open.overrides.push(open.entries[existing]);
			open.entries.splice(existing, 1);
		}

		open.entries.push({ value, key, line: index + 1 });
		open.minValue = Math.min(open.minValue, value);
		open.endLine = index + 1;
		open.lastLineIndex = index;
	}

	close();
	return tables;
}

/**
 * The naming family of a label key: the key without a trailing `_<number>`.
 *
 * Roborock numbers the labels of a picker (`dust_collection_title_1` … `_5`) and names the labels
 * of a code table individually (`map_object_name_cat`). Only the first kind can have a hole, and
 * only for the first kind does the family say anything.
 * @param {string} key The i18n key.
 * @returns {string} The family name.
 */
function labelFamily(key) {
	return key.replace(/_\d+$/, "");
}

/**
 * Splits a raw table into the values it really offers and the holes in between.
 *
 * ## What a hole is
 *
 * A picker numbers its labels: `dust_collection_title_1` … `_5`. When one index carries a label
 * from outside that series, it is not a mode - it is a slot the app fills with something generic
 * so the array stays dense. Dust collection index 3 is exactly that
 * (`localization_strings_Common_Protocol_2`), and taking it for a mode is how the wrong number
 * goes to the robot.
 *
 * ## Why the filter needs a numbered series, not just a majority
 *
 * The first version fired on any family that covered two thirds of a table, and that was wrong
 * twice over. The dock error map at A65:430495 files the **same** key under error codes 1 and 38,
 * so that key held a two-thirds majority and the third entry - a genuine error text - was declared
 * a hole; the table then fell under the minimum and disappeared. Two entries sharing a key by
 * coincidence is not a series.
 *
 * A family therefore only counts when at least two **distinct** keys reduce to it *and* at least
 * one of them really lost a `_<number>` in the process. That is the signature of a numbered
 * picker, and it is the only shape in which a hole can occur.
 *
 * Everything else - the 40 finish reasons at A65:379302, the obstacle names at A65:379055, the
 * dock error map - keeps every entry and is reported as a code table.
 * @param {object} table A table from {@link parseValueListTables}.
 * @returns {object} `{ dominantFamily, values, holes }`.
 */
function classifyValueList(table) {
	const distinctKeysPerFamily = new Map();
	for (const entry of table.entries) {
		const family = labelFamily(entry.key);
		if (!distinctKeysPerFamily.has(family)) distinctKeysPerFamily.set(family, new Set());
		distinctKeysPerFamily.get(family).add(entry.key);
	}

	let dominantFamily = null;
	let best = 0;
	for (const [family, keys] of distinctKeysPerFamily) {
		// A numbered series: several different keys, and the numbering really was stripped.
		const isSeries = keys.size >= 2 && [...keys].some((key) => key !== family);
		if (!isSeries) continue;

		const covered = table.entries.filter((entry) => labelFamily(entry.key) === family).length;
		if (covered > best) {
			best = covered;
			dominantFamily = family;
		}
	}

	if (dominantFamily === null || best < table.entries.length * DOMINANT_FAMILY_SHARE) {
		return { dominantFamily: null, values: table.entries.slice(), holes: [] };
	}

	const values = [];
	const holes = [];
	for (const entry of table.entries) {
		if (labelFamily(entry.key) === dominantFamily) values.push(entry);
		else holes.push({ ...entry, reason: `label is not part of the table's numbered series "${dominantFamily}" - a filler, not a value` });
	}

	return { dominantFamily, values, holes };
}

// --- Named enums ------------------------------------------------------------------------------

/**
 * Finds the manufacturer's named value stocks, e.g. `WashTowelModeMap`.
 *
 * These are published next to the lists, never merged into them: an enum says which numbers exist,
 * a list says which ones a user is offered, and the two differ (see the file header).
 *
 * The name filter is not cosmetic. Without it the same literal shape matches 1449 objects in the
 * a65 bundle, nearly all of them style and layout constants; with it, 40, of which 39 are genuine
 * device enums.
 * @param {string[]} lines The decompiled bundle, line by line.
 * @returns {object[]} One entry per named enum.
 */
function parseNamedEnums(lines) {
	const enums = [];

	for (let index = 0; index < lines.length; index++) {
		const literal = RE_ENUM_LITERAL.exec(lines[index]);
		if (!literal) continue;

		const named = RE_ENUM_NAME.exec(lines[index + 1] || "");
		if (!named || !RE_DEVICE_ENUM_NAME.test(named[1])) continue;

		const members = [...literal[1].matchAll(/'([A-Za-z_][\w]*)': (-?\d+)/g)].map((match) => ({
			name: match[1],
			value: Number(match[2]),
		}));
		if (members.length < MIN_TABLE_ENTRIES) continue;

		const layoutMembers = members.filter((member) => {
			const lowered = member.name.toLowerCase();
			return LAYOUT_MEMBER_NAMES.has(lowered) || lowered.startsWith("margin") || lowered.startsWith("padding");
		}).length;
		if (layoutMembers >= 2) continue;

		const sorted = members.map((member) => member.value).sort((a, b) => a - b);
		enums.push({
			name: named[1],
			line: index + 1,
			members,
			// Worth carrying: WashTowelModeMap jumps 2 -> 8 -> 10, LogLevel 2 -> 4. Anyone who
			// infers a range from the member count gets it wrong more often than right.
			contiguous: sorted[sorted.length - 1] - sorted[0] + 1 === sorted.length,
		});
	}

	return enums;
}

// --- Linking a list to an RPC -----------------------------------------------------------------

/**
 * Collects every RPC name that occurs as a string literal in the bundle.
 * @param {string} bundleText The whole decompilate.
 * @returns {Set<string>} The names found.
 */
function collectRpcNames(bundleText) {
	const names = new Set();
	for (const match of bundleText.matchAll(RE_RPC_LITERAL)) names.add(match[1]);
	return names;
}

/**
 * The identifying words of a name, with the ones that describe a container removed.
 * @param {string} name A camelCase or snake_case name.
 * @returns {string[]} Sorted, de-duplicated tokens.
 */
function nameTokens(name) {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.filter((word) => !GENERIC_NAME_TOKENS.has(word));
	return [...new Set(words)].sort();
}

/**
 * Proposes the setter a value list belongs to.
 *
 * Name matching is a heuristic, so it is deliberately strict and deliberately labelled: the token
 * sets have to be identical, and the setter has to occur in the bundle. Anything less would invent
 * a link, and a wrong link here means a wrong number sent to a robot.
 *
 * It stays silent where it should. The suction list `CleanSettingMode` reduces to `{clean}`, and
 * the setter is `set_custom_mode` - no name matching can bridge that, so the result is `null`
 * rather than a plausible guess.
 *
 * Names ending in `Status`, `State` or `Code` are excluded outright. They are inbound
 * vocabularies, and stripping those words as generic leaves a stem that matches the wrong setter:
 * `RobotStateCode` reduced to `{robot}` and was offered `app_set_robot_setting`, which has nothing
 * to do with it. That was the only false link the matcher produced over the a65 bundle, and this
 * rule is what removes it without costing a correct one.
 * @param {string} listName The table's family or enum name.
 * @param {Set<string>} rpcNames Names present in the bundle.
 * @returns {string|null} The matching setter, or `null`.
 */
function matchRpcForName(listName, rpcNames) {
	if (RE_REPORTED_ENUM_NAME.test(listName)) return null;

	const wanted = nameTokens(listName).join("|");
	if (!wanted) return null;

	const hits = [];
	for (const rpc of rpcNames) {
		if (!rpc.startsWith("set_") && !rpc.startsWith("app_set_")) continue;
		if (nameTokens(rpc.replace(/^app_set_|^set_/, "")).join("|") === wanted) hits.push(rpc);
	}

	// Two candidates are as good as none - a coin flip is not a source.
	return hits.length === 1 ? hits[0] : null;
}

// --- Labels -----------------------------------------------------------------------------------

/**
 * Looks a label key up in the shipped translation catalogue.
 * @param {object} catalog `roborock_strings.json`, language on the top level.
 * @param {string[]} languages Languages to resolve.
 * @param {string} key The i18n key.
 * @returns {object|null} `{ <lang>: label }`, or `null` when no language has it.
 */
function resolveLabels(catalog, languages, key) {
	const labels = {};
	for (const language of languages) {
		const value = catalog[language] && catalog[language][key];
		if (typeof value === "string" && value.length > 0) labels[language] = value;
	}
	return Object.keys(labels).length > 0 ? labels : null;
}

// --- Driver -----------------------------------------------------------------------------------

/**
 * Runs both extractors over one bundle.
 * @param {string} bundlePath Path to the decompiled bundle.
 * @param {object} catalog The translation catalogue.
 * @param {string[]} languages Languages to resolve.
 * @returns {object} `{ source, valueLists, enums, unresolved }`.
 */
function processBundle(bundlePath, catalog, languages) {
	const bundleText = fs.readFileSync(bundlePath, "utf8");
	const lines = bundleText.split(/\r?\n/);
	const label = path.basename(path.dirname(bundlePath)) + "/" + path.basename(bundlePath);
	const rpcNames = collectRpcNames(bundleText);

	const valueLists = [];
	const unresolved = [];
	const tooShort = [];

	for (const table of parseValueListTables(lines)) {
		const { dominantFamily, values, holes } = classifyValueList(table);

		if (values.length < MIN_TABLE_ENTRIES) {
			tooShort.push({ source: `${label}:${table.startLine}-${table.endLine}`, keys: table.entries.map((entry) => entry.key) });
			continue;
		}

		// Three shapes come out of the parser and they are worth telling apart:
		//   picker          - a numbered series, the only shape that can have a hole
		//   generic-strings - a numbered series of `localization_strings_*`, i.e. the error and
		//                     constants buckets; real tables, but their family names say nothing
		//   code-table      - a number -> text map with individually named keys (obstacles,
		//                     finish reasons, dock errors)
		// Only a picker gets its family as an id; the others keep their line number, because an
		// invented name is the one thing a generated table must not contain.
		const kind = dominantFamily === null
			? "code-table"
			: (dominantFamily.startsWith("localization_strings_") ? "generic-strings" : "picker");
		const id = kind === "picker" ? dominantFamily : `table_${table.startLine}`;
		const entries = values
			.slice()
			.sort((a, b) => a.value - b.value)
			.map((entry) => {
				const labels = resolveLabels(catalog, languages, entry.key);
				if (!labels) {
					unresolved.push({
						what: "label key",
						sources: [`${label}:${entry.line}`],
						detail: entry.key,
						reason: "key is not in the translation catalogue; run appplugins:extract first",
					});
				}
				return { value: entry.value, key: entry.key, labels: labels || null, source: `${label}:${entry.line}` };
			});

		valueLists.push({
			id,
			kind,
			source: `${label}:${table.startLine}-${table.endLine}`,
			dominantFamily,
			// Lets a reader see what a code table is about without opening the bundle.
			sampleKeys: kind === "picker" ? [] : entries.slice(0, 3).map((entry) => entry.key),
			rpc: kind === "picker" ? matchRpcForName(dominantFamily, rpcNames) : null,
			rpcMatchedBy: "name stem; verify before wiring a control to it",
			values: entries,
			holes: holes.map((hole) => ({ value: hole.value, key: hole.key, reason: hole.reason, source: `${label}:${hole.line}` })),
			overriddenEarlierWrites: table.overrides.map((entry) => ({ value: entry.value, key: entry.key, source: `${label}:${entry.line}` })),
		});
	}

	// Not published, but not hidden either: a table with silent gaps is more dangerous than one
	// with visible gaps, and these line numbers are where a human would look next.
	for (const entry of tooShort) {
		unresolved.push({
			what: "value list",
			sources: [entry.source],
			detail: entry.keys.join(" "),
			reason: `fewer than ${MIN_TABLE_ENTRIES} usable values; not published`,
		});
	}

	const enums = parseNamedEnums(lines).map((entry) => ({
		name: entry.name,
		source: `${label}:${entry.line}`,
		contiguous: entry.contiguous,
		rpc: matchRpcForName(entry.name, rpcNames),
		rpcMatchedBy: "name stem; verify before wiring a control to it",
		members: entry.members,
	}));

	return {
		source: {
			bundle: label,
			lines: lines.length,
			// Short digest instead of the absolute path: the path is the developer's filesystem and
			// has no business in a shipped file, while the digest still identifies the input.
			sha256: crypto.createHash("sha256").update(bundleText).digest("hex").slice(0, 16),
		},
		valueLists,
		enums,
		unresolved,
	};
}

/**
 * Collects the bundles to read - either given explicitly or discovered under `.AppPlugins`.
 * @param {object} options Parsed arguments.
 * @returns {string[]} Absolute bundle paths.
 */
function collectBundles(options) {
	if (options.bundles.length > 0) return options.bundles;
	if (!fs.existsSync(options.root)) return [];

	const found = [];
	for (const instance of discoverPluginInstances(options.root, options.plugin)) {
		for (const candidate of [instance.beautifiedBundlePath, instance.bundlePath]) {
			if (candidate && /\.js$/.test(candidate) && fs.existsSync(candidate)) {
				found.push(candidate);
				break;
			}
		}
	}
	return found;
}

/** Entry point. */
function main() {
	const options = parseArgs(process.argv.slice(2));
	const bundles = collectBundles(options);

	if (bundles.length === 0) {
		throw new Error(`No decompiled bundle found. Pass --bundle <file>, or run "npm run appplugins:convert" so that ${options.root} holds one.`);
	}

	const catalog = JSON.parse(fs.readFileSync(options.translations, "utf8"));

	// No timestamp on purpose: the same bundle has to produce the same file, otherwise every run
	// shows up as a change and nobody reads the diff any more. `sources[].sha256` says which input
	// this came from, which is the part that actually matters.
	const result = {
		_meta: {
			description: "Mode pickers and named enums lifted out of a Roborock AppPlugin. A picker is what the app offers, an enum is the manufacturer's value stock - they differ, and `holes` says where.",
			generator: "scripts/extract_appplugin_value_lists.js",
			languages: options.languages,
			sources: [],
		},
		valueLists: [],
		enums: [],
		unresolved: [],
	};

	for (const bundlePath of bundles) {
		const processed = processBundle(bundlePath, catalog, options.languages);
		result._meta.sources.push(processed.source);
		result.valueLists.push(...processed.valueLists);
		result.enums.push(...processed.enums);
		result.unresolved.push(...processed.unresolved);

		if (!options.quiet) {
			console.log(`${processed.source.bundle}: ${processed.valueLists.length} value list(s), ${processed.enums.length} enum(s), ${processed.unresolved.length} unresolved`);
		}
	}

	result.valueLists.sort((a, b) => a.id.localeCompare(b.id));
	result.enums.sort((a, b) => a.name.localeCompare(b.name));

	if (options.noWrite) {
		if (!options.quiet) console.log("--no-write: nothing written");
		return result;
	}

	fs.mkdirSync(path.dirname(options.out), { recursive: true });
	fs.writeFileSync(options.out, `${JSON.stringify(result, null, "\t")}\n`, "utf8");
	if (!options.quiet) console.log(`written: ${options.out}`);
	return result;
}

module.exports = {
	classifyValueList,
	collectRpcNames,
	labelFamily,
	matchRpcForName,
	nameTokens,
	parseNamedEnums,
	parseValueListTables,
	processBundle,
	resolveLabels,
};

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
