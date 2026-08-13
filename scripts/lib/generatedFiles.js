// Ownership rules for the docs folder.
//
// The generator used to delete every *.md below docs/ before a run, which silently removed
// hand maintained documents such as docs/map/Q10_B01_Map_Pipeline.md. A file is only ever
// deleted when it carries the marker this generator writes into every file it owns.

const fs = require('node:fs');
const path = require('node:path');

/** Header line that marks a markdown file as fully owned by the generator. */
const GENERATED_FILE_MARKER = '> **Auto-Generated**: This document is generated from the source code/tests to ensure 1:1 accuracy with the implementation.';

/** The marker sits in the header, so there is no need to read whole files. */
const MARKER_SEARCH_LENGTH = 4096;

/** Directories inside docs/ that are never traversed. */
const PRESERVED_DIRECTORIES = new Set(['_media']);

/**
 * Checks whether a markdown file was produced by this generator.
 * @param {string} filePath Absolute path of the file.
 * @returns {boolean} `true` only for files the generator owns.
 */
function isGeneratedFile(filePath) {
    let handle;
    try {
        handle = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(MARKER_SEARCH_LENGTH);
        const read = fs.readSync(handle, buffer, 0, MARKER_SEARCH_LENGTH, 0);
        return buffer.toString('utf8', 0, read).includes(GENERATED_FILE_MARKER);
    } catch {
        return false;
    } finally {
        if (handle !== undefined) fs.closeSync(handle);
    }
}

/**
 * Removes the documents of a previous run and nothing else.
 * @param {string} dir Directory to clean.
 * @returns {string[]} Absolute paths of the removed files.
 */
function clearGeneratedDocs(dir) {
    if (!fs.existsSync(dir)) return [];

    const removed = [];
    for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            if (PRESERVED_DIRECTORIES.has(file)) continue;
            removed.push(...clearGeneratedDocs(filePath));
            if (fs.readdirSync(filePath).length === 0) {
                fs.rmdirSync(filePath);
            }
        } else if (file.endsWith('.md') && isGeneratedFile(filePath)) {
            fs.unlinkSync(filePath);
            removed.push(filePath);
        }
    }
    return removed;
}

module.exports = { GENERATED_FILE_MARKER, isGeneratedFile, clearGeneratedDocs };
