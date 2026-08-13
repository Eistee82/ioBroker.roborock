import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

const userDocs = require(path.join(repoRoot, "scripts", "lib", "userDocs.js")) as {
	generateUserDocs: (options?: { check?: boolean }) => Promise<{ files: string[]; outdated: string[] }>;
	applyBlocks: (content: string, blocks: Record<string, string>, label: string, blockIds?: string[]) => string;
	documentPath: (language: string) => string;
	LANGUAGES: string[];
	BLOCK_IDS: string[];
};

const generatedFiles = require(path.join(repoRoot, "scripts", "lib", "generatedFiles.js")) as {
	GENERATED_FILE_MARKER: string;
	isGeneratedFile: (filePath: string) => boolean;
	clearGeneratedDocs: (dir: string) => string[];
};

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roborock-docs-"));
	temporaryDirectories.push(dir);
	return dir;
}

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const dir = temporaryDirectories.pop()!;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("generated user documentation", () => {
	it("has a document with all generated markers for every documented language", () => {
		for (const language of userDocs.LANGUAGES) {
			const filePath = userDocs.documentPath(language);
			expect(fs.existsSync(filePath), `${filePath} is missing`).toBe(true);

			const content = fs.readFileSync(filePath, "utf8");
			for (const blockId of userDocs.BLOCK_IDS) {
				expect(content, `${filePath} has no <!-- BEGIN:${blockId} --> marker`).toContain(`<!-- BEGIN:${blockId} -->`);
				expect(content, `${filePath} has no <!-- END:${blockId} --> marker`).toContain(`<!-- END:${blockId} -->`);
			}
		}
	});

	// This is the guard that keeps the generated sections honest: as soon as a command,
	// a state definition or a configuration field changes, the tables no longer match and
	// this test fails until "npm run docs" has been run.
	it("is up to date with the code and the admin configuration", async () => {
		const result = await userDocs.generateUserDocs({ check: true });

		expect(result.files.length).toBe(userDocs.LANGUAGES.length);
		expect(
			result.outdated,
			`Generated documentation is out of date: ${result.outdated.join(", ")}. Run "npm run docs" and commit the result.`
		).toEqual([]);
	}, 120_000);

	it("keeps the hand written prose outside the markers untouched", () => {
		const content = ["# Title", "", "Hand written intro.", "", "<!-- BEGIN:states -->", "old table", "<!-- END:states -->", "", "Hand written outro.", ""].join("\n");
		const blocks: Record<string, string> = {};
		for (const blockId of userDocs.BLOCK_IDS) blocks[blockId] = "new table";

		// Only the states block exists in this fragment, so the others must be reported.
		expect(() => userDocs.applyBlocks(content, blocks, "fragment.md")).toThrow(/markers/);

		const updated = userDocs.applyBlocks(content, { states: "new table" }, "fragment.md", ["states"]);
		expect(updated).toContain("Hand written intro.");
		expect(updated).toContain("Hand written outro.");
		expect(updated).toContain("new table");
		expect(updated).not.toContain("old table");

		// Running it again on its own output must not change anything.
		expect(userDocs.applyBlocks(updated, { states: "new table" }, "fragment.md", ["states"])).toBe(updated);
	});
});

describe("documentation cleanup", () => {
	it("removes generated documents and keeps hand written ones", () => {
		const dir = makeTempDir();
		const generated = path.join(dir, "Generated.md");
		const handWritten = path.join(dir, "HandWritten.md");
		const media = path.join(dir, "_media");

		fs.writeFileSync(generated, `# Generated\n\n${generatedFiles.GENERATED_FILE_MARKER}\n\nbody\n`);
		fs.writeFileSync(handWritten, "# Hand written\n\nThis file is maintained by a person.\n");
		fs.mkdirSync(media);
		fs.writeFileSync(path.join(media, "note.md"), "# Media note\n");

		const removed = generatedFiles.clearGeneratedDocs(dir);

		expect(removed).toEqual([generated]);
		expect(fs.existsSync(generated)).toBe(false);
		expect(fs.existsSync(handWritten)).toBe(true);
		expect(fs.existsSync(path.join(media, "note.md"))).toBe(true);
	});

	it("recognises only files carrying the marker as generated", () => {
		const dir = makeTempDir();
		const withMarker = path.join(dir, "with.md");
		const withoutMarker = path.join(dir, "without.md");

		fs.writeFileSync(withMarker, `# X\n\n${generatedFiles.GENERATED_FILE_MARKER}\n`);
		fs.writeFileSync(withoutMarker, "# X\n\nplain document\n");

		expect(generatedFiles.isGeneratedFile(withMarker)).toBe(true);
		expect(generatedFiles.isGeneratedFile(withoutMarker)).toBe(false);
		expect(generatedFiles.isGeneratedFile(path.join(dir, "missing.md"))).toBe(false);
	});
});
