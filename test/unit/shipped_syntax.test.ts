import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the syntax of everything the adapter ships.
 *
 * The adapter delivers TypeScript **sources**, not compiled JavaScript: `package.json` points
 * `main` at `src/main.ts`, and js-controller runs it through the `@alcalzone/esbuild-register`
 * that sits in **its own** `node_modules`. That copy is generally older than the toolchain used
 * for development, and it is the one that decides whether the instance starts.
 *
 * This has already taken a production instance down: a single `satisfies` - valid TypeScript,
 * accepted by `tsc`, accepted by the local esbuild - made js-controller abort with
 * `Expected ";" but found "satisfies"` before the adapter ever connected. Neither `npm run
 * typecheck` nor `npm run lint` nor the unit tests noticed, because all of them run on the
 * newer toolchain.
 *
 * So the rule cannot be "it compiles here". Anything below is syntax that a modern `tsc`
 * accepts while older esbuild builds reject it, and none of it may appear in shipped code.
 * Tests are exempt - they never reach a user's js-controller.
 */

/** Directories that end up in the published package; see `files` in package.json. */
const SHIPPED_DIRS = ["src"];

/** Files that are shipped but never executed by js-controller. */
const EXEMPT = /\.(test|spec)\.ts$|[\\/]mock[\\/]/;

type Rule = { name: string; pattern: RegExp; since: string; instead: string };

const FORBIDDEN: Rule[] = [
	{
		name: "inline type modifier in a named import",
		// `import { A, type B }` and the multi-line form. `import type { B }` on its own is fine.
		pattern: /^\s*type\s+[A-Za-z_$][\w$]*\s*,?\s*$|[{,]\s*type\s+[A-Za-z_$][\w$]*\s*[,}]/,
		since: "TypeScript 4.5",
		instead: "a separate `import type { X } from ...` statement"
	},
	{
		name: "satisfies",
		// Only the operator, not an identifier that happens to contain the word.
		pattern: /(?<![\w.$])satisfies\s+[A-Z_$]/,
		since: "TypeScript 4.9",
		instead: "annotate the variable: `const x: T = { ... }`"
	},
	{
		name: "using declaration",
		pattern: /(?<![\w.$])(?:await\s+)?using\s+[a-zA-Z_$][\w$]*\s*=/,
		since: "TypeScript 5.2",
		instead: "use try/finally"
	},
	{
		name: "accessor keyword",
		pattern: /(?<![\w.$])accessor\s+[a-zA-Z_$][\w$]*\s*[:=;]/,
		since: "TypeScript 4.9",
		instead: "use a getter and setter pair"
	},
	{
		name: "const type parameter",
		pattern: /<\s*const\s+[A-Z]/,
		since: "TypeScript 5.0",
		instead: "drop the `const` modifier"
	}
];

/**
 * Collects every shipped `.ts` file.
 * @param dir Directory to walk.
 * @param out Accumulator, for recursion.
 * @returns All shipped TypeScript paths.
 */
function collect(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			collect(full, out);
		} else if (full.endsWith(".ts") && !full.endsWith(".d.ts") && !EXEMPT.test(full)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Strips line and block comments, so a rule quoted in prose does not count as a violation.
 * @param source File contents.
 * @returns The source with comments blanked out.
 */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("syntax of shipped sources", () => {
	const files = SHIPPED_DIRS.flatMap((dir) => collect(dir));

	it("finds the sources to check", () => {
		// A broken walk would make every assertion below pass without testing anything.
		expect(files.length).toBeGreaterThan(50);
	});

	it.each(FORBIDDEN)("uses no $name ($since), which older esbuild builds reject", (rule) => {
		const hits: string[] = [];

		for (const file of files) {
			const lines = withoutComments(readFileSync(file, "utf8")).split("\n");
			lines.forEach((line, i) => {
				if (rule.pattern.test(line)) hits.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
			});
		}

		expect(hits, `${rule.name} is newer than the esbuild js-controller uses. Instead: ${rule.instead}.\n${hits.join("\n")}`).toEqual([]);
	});
});
