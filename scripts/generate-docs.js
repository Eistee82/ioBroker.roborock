const fs = require('node:fs');
const path = require('node:path');

const { generateUserDocs } = require('./lib/userDocs');
const { GENERATED_FILE_MARKER, clearGeneratedDocs } = require('./lib/generatedFiles');

const OUTPUT_DIR = path.join(__dirname, '../docs');
const ROOT_DIR = path.join(__dirname, '..');
const SCAN_DIRS = [
    path.join(__dirname, '../src'),
    path.join(__dirname, '../test')
];

// Map of TargetFilename -> Array of Content Blocks
const docsMap = new Map();

function getAllTsFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getAllTsFiles(filePath));
        } else if (file.endsWith('.ts')) {
            results.push(filePath);
        }
    });
    return results;
}

function scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const commentRegex = /\/\*\*([\s\S]*?)\*\//g;
    let match;

    while ((match = commentRegex.exec(content)) !== null) {
        const commentBlock = match[1];

        // Match @doc:TargetFile.md or legacy @protocol-spec
        const docTagMatch = commentBlock.match(/@doc:([a-zA-Z0-9_./-]+)/);
        const isLegacySpec = commentBlock.includes('@protocol-spec');

        let targetFile = 'PROTOCOL.md'; // Default fallback

        if (docTagMatch) {
            targetFile = docTagMatch[1];
        } else if (isLegacySpec) {
            // Map legacy tags to logical files if not specified
            if (filePath.includes('cryptoEngine')) targetFile = 'Encryption.md';
            else if (filePath.includes('MapParser')) targetFile = 'MapProtocol.md';
            else if (filePath.includes('mqttApi')) targetFile = 'Transport.md';
            else targetFile = 'PROTOCOL.md';
        } else {
            continue; // Skip blocks without tags
        }

        const cleanLines = commentBlock.split('\n')
            .map(line => {
                let cleaned = line.trim().replace(/^\* ?/, '');
                // Remove tags
                if (cleaned.includes('@protocol-spec')) return null;
                if (cleaned.match(/@doc:[a-zA-Z0-9_.-]+/)) return null;
                if (cleaned.startsWith('@param')) return null;
                if (cleaned.startsWith('@returns')) return null;
                return cleaned;
            })
            .filter(line => line !== null);

        // Trim vertical whitespace
        while (cleanLines.length > 0 && cleanLines[0].trim() === '') cleanLines.shift();
        while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1].trim() === '') cleanLines.pop();

        if (cleanLines.length > 0) {
            if (!docsMap.has(targetFile)) docsMap.set(targetFile, []);

            let blockContent = cleanLines.join('\n');
            // Add source attribution
            const attribution = `<!-- Source: ${path.relative(ROOT_DIR, filePath).replace(/\\/g, '/')} -->\n`;
            docsMap.get(targetFile).push(attribution + blockContent);
        }
    }
}

function generateDocs() {
    console.log('📖 Cleaning old documentation...');
    // Only removes what a previous run wrote; hand maintained documents stay.
    const removed = clearGeneratedDocs(OUTPUT_DIR);
    console.log(`   ${removed.length} generated file(s) removed.`);

    console.log('📖 Scanning directories for documentation tags...');

    let allFiles = [];
    SCAN_DIRS.forEach(dir => {
        allFiles = allFiles.concat(getAllTsFiles(dir));
    });

    allFiles.forEach(scanFile);

    console.log(`📝 Verified ${allFiles.length} files. Generating ${docsMap.size} documentation books...`);

    // Ensure docs dir exists
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    docsMap.forEach((blocks, filename) => {
        const baseName = path.basename(filename, '.md');
        const title = baseName.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();

        let fileContent = `# Roborock ${title} Specification\n\n`;
        fileContent += `${GENERATED_FILE_MARKER}\n\n`;
        fileContent += blocks.join('\n\n---\n\n');

        const filePath = path.join(OUTPUT_DIR, filename);
        const fileDir = path.dirname(filePath);
        if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

        fs.writeFileSync(filePath, fileContent);
        console.log(`   ✅ Generated ${filename} (${blocks.length} sections)`);
    });
}

async function main() {
    const check = process.argv.includes('--check');

    if (!check) {
        generateDocs();
    }

    console.log(check ? '📖 Checking generated user documentation...' : '📖 Updating generated user documentation...');
    const { files, outdated } = await generateUserDocs({ check });

    for (const file of files) {
        const changed = outdated.includes(file);
        if (check) {
            console.log(`   ${changed ? '❌' : '✅'} ${file}${changed ? ' is out of date' : ''}`);
        } else {
            console.log(`   ${changed ? '✅' : '➖'} ${file}${changed ? '' : ' (unchanged)'}`);
        }
    }

    if (check && outdated.length > 0) {
        console.error(`\n${outdated.length} user document(s) are out of date. Run "npm run docs" and commit the result.`);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(`❌ Documentation generation failed: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
});
