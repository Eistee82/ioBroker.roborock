// Renders the generated sections of the user documentation (docs/<lang>/README.md).
//
// Only the parts between the marker comments are owned by the generator:
//
//     <!-- BEGIN:states -->  ... generated ...  <!-- END:states -->
//
// Everything outside the markers is hand written prose and is never touched, so the
// generator can run as often as it likes without destroying the setup instructions.

const fs = require('node:fs');
const path = require('node:path');

const { buildDeviceCatalog } = require('./deviceCatalog');
const { buildConfigCatalog } = require('./configCatalog');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DOCS_DIR = path.join(ROOT_DIR, 'docs');

/** Languages the user documentation is written for. Prose has to exist for each of them. */
const LANGUAGES = ['en', 'de'];

/** Ids of the generated blocks, in the order they appear in the documents. */
const BLOCK_IDS = ['models', 'config', 'states', 'errors'];

/** Maximum number of value mappings printed inline before the list is cut off. */
const MAX_INLINE_VALUES = 12;

const TEXTS = {
    en: {
        generatedHint: 'The following section is generated from the source code. Do not edit it by hand - run `npm run docs`.',
        modelsHeading: 'Supported models',
        modelsIntro: (count) => `The adapter ships ${count} model profiles. A robot whose model id is not listed still works with a generic profile, but without the model specific commands. "Command objects" counts the writable objects the profile creates, "Features" the capabilities it declares statically (dock, camera, mop wash and so on).`,
        modelsColumns: ['Model', 'Model id', 'Protocol', 'Command objects', 'Features'],
        configHeading: 'Configuration reference',
        configIntro: 'Every setting of the adapter instance, taken from the admin configuration definition.',
        configColumns: ['Setting', 'Key', 'Type', 'Default', 'Description'],
        configOptions: 'Options',
        configHiddenWhen: 'Hidden when',
        statesHeading: 'States reference',
        statesIntro: 'All objects live below `roborock.<instance>.Devices.<duid>`. Writable command objects are grouped in the folders below, read only values from the robot follow further down.',
        commandFolderIntro: (folder) => `Writable objects in \`Devices.<duid>.${folder}\`.`,
        dataFolderIntro: (folder) => `Values reported by the robot in \`Devices.<duid>.${folder}\`.`,
        commandColumns: ['Object', 'Name', 'Type', 'Role', 'Default', 'Values / range', 'Models'],
        dataColumns: ['Object', 'Name', 'Type', 'Unit', 'Values'],
        resetableHeading: 'Resettable consumables',
        resetableIntro: 'These consumables get a button below `Devices.<duid>.resetConsumables` that resets the counter in the robot.',
        errorsHeading: 'Error codes',
        errorsIntro: 'Values of `deviceStatus.error_code`. The adapter also publishes the resolved text in `deviceStatus.error_code` value list.',
        errorsColumns: ['Code', 'Meaning'],
        allModels: 'all',
        varies: 'model dependent',
        none: '-'
    },
    de: {
        generatedHint: 'Der folgende Abschnitt wird aus dem Quelltext erzeugt. Nicht von Hand bearbeiten - stattdessen `npm run docs` ausführen.',
        modelsHeading: 'Unterstützte Modelle',
        modelsIntro: (count) => `Der Adapter bringt ${count} Modellprofile mit. Ein Roboter, dessen Modell-ID hier nicht steht, läuft mit einem allgemeinen Profil, allerdings ohne die modellspezifischen Befehle. "Befehlsobjekte" zählt die beschreibbaren Objekte, die das Profil anlegt, "Funktionen" die Fähigkeiten, die es statisch angibt (Station, Kamera, Moppwäsche und so weiter).`,
        modelsColumns: ['Modell', 'Modell-ID', 'Protokoll', 'Befehlsobjekte', 'Funktionen'],
        configHeading: 'Konfigurationsreferenz',
        configIntro: 'Alle Einstellungen der Adapter-Instanz, entnommen aus der Admin-Konfigurationsbeschreibung.',
        configColumns: ['Einstellung', 'Schlüssel', 'Typ', 'Vorgabe', 'Beschreibung'],
        configOptions: 'Auswahl',
        configHiddenWhen: 'Ausgeblendet, wenn',
        statesHeading: 'States-Referenz',
        statesIntro: 'Alle Objekte liegen unter `roborock.<instanz>.Devices.<duid>`. Beschreibbare Befehlsobjekte stehen in den folgenden Ordnern, die vom Roboter gemeldeten Werte weiter unten.',
        commandFolderIntro: (folder) => `Beschreibbare Objekte in \`Devices.<duid>.${folder}\`.`,
        dataFolderIntro: (folder) => `Vom Roboter gemeldete Werte in \`Devices.<duid>.${folder}\`.`,
        commandColumns: ['Objekt', 'Name', 'Typ', 'Rolle', 'Vorgabe', 'Werte / Bereich', 'Modelle'],
        dataColumns: ['Objekt', 'Name', 'Typ', 'Einheit', 'Werte'],
        resetableHeading: 'Zurücksetzbare Verbrauchsteile',
        resetableIntro: 'Für diese Verbrauchsteile legt der Adapter unter `Devices.<duid>.resetConsumables` einen Knopf an, der den Zähler im Roboter zurücksetzt.',
        errorsHeading: 'Fehlercodes',
        errorsIntro: 'Werte von `deviceStatus.error_code`. Den aufgelösten Text veröffentlicht der Adapter zusätzlich in der Werteliste von `deviceStatus.error_code`.',
        errorsColumns: ['Code', 'Bedeutung'],
        allModels: 'alle',
        varies: 'modellabhängig',
        none: '-'
    }
};

/** Makes a value survive inside a markdown table cell (code spans keep their raw text). */
function rawCell(value) {
    if (value === undefined || value === null || value === '') return '';
    return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Like `rawCell()`, but also neutralises angle brackets so `<duid>` is not read as a tag. */
function cell(value) {
    return rawCell(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function code(value) {
    const raw = rawCell(value);
    return raw === '' ? '' : `\`${raw}\``;
}

function table(columns, rows) {
    const lines = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
    for (const row of rows) {
        lines.push(`| ${row.map((value) => (value === undefined || value === null || value === '' ? '' : value)).join(' | ')} |`);
    }
    return lines.join('\n');
}

/** Formats `common.states`, `min`/`max` and `unit` into one human readable cell. */
function formatValues(entry, texts) {
    if (entry.varies) return texts.varies;

    if (entry.states) {
        const keys = Object.keys(entry.states);
        const shown = keys.slice(0, MAX_INLINE_VALUES).map((key) => `${code(key)} = ${cell(entry.states[key])}`);
        if (keys.length > MAX_INLINE_VALUES) shown.push(`… (${keys.length})`);
        return shown.join('<br>');
    }

    const parts = [];
    if (entry.min !== undefined && entry.max !== undefined) {
        parts.push(`${entry.min} … ${entry.max}`);
    } else if (entry.min !== undefined) {
        parts.push(`&ge; ${entry.min}`);
    } else if (entry.max !== undefined) {
        parts.push(`&le; ${entry.max}`);
    }
    if (entry.unit) parts.push(`[${cell(entry.unit)}]`);
    return parts.join(' ');
}

function renderModelsBlock(catalog, texts) {
    const rows = catalog.models.map((model) => [
        cell(model.name),
        code(model.id),
        cell(model.protocol),
        String(model.commandCount),
        String(model.features.length)
    ]);
    return [
        `### ${texts.modelsHeading}`,
        '',
        texts.modelsIntro(catalog.modelCount),
        '',
        table(texts.modelsColumns, rows)
    ].join('\n');
}

function renderConfigBlock(configCatalog, texts) {
    const parts = [`### ${texts.configHeading}`, '', texts.configIntro];

    for (const section of configCatalog.sections) {
        parts.push('', `#### ${section.label}`);
        for (const note of section.notes) {
            parts.push('', `> ${note}`);
        }

        const rows = section.settings.map((setting) => {
            const description = [];
            if (setting.help) description.push(cell(setting.help));
            if (setting.options) {
                description.push(`${texts.configOptions}: ${setting.options.map((option) => `\`${cell(option.value)}\` = ${cell(option.label)}`).join(', ')}`);
            }
            if (setting.shownWhen) {
                description.push(`${texts.configHiddenWhen} \`${cell(setting.shownWhen)}\``);
            }
            return [
                cell(setting.label),
                code(setting.id),
                code(setting.type),
                setting.default === undefined ? '' : code(JSON.stringify(setting.default)),
                description.join('<br>')
            ];
        });

        if (rows.length > 0) {
            parts.push('', table(texts.configColumns, rows));
        }
    }

    return parts.join('\n');
}

function renderStatesBlock(catalog, texts) {
    const parts = [`### ${texts.statesHeading}`, '', texts.statesIntro];

    for (const group of catalog.commands) {
        parts.push('', `#### \`${group.folder}\``, '', texts.commandFolderIntro(group.folder), '');
        const rows = group.entries.map((entry) => [
            code(entry.id),
            cell(entry.name),
            code(entry.type),
            code(entry.role),
            entry.varies || entry.def === undefined ? '' : code(JSON.stringify(entry.def)),
            formatValues(entry, texts),
            entry.modelCount === catalog.modelCount ? texts.allModels : `${entry.modelCount}/${catalog.modelCount}`
        ]);
        parts.push(table(texts.commandColumns, rows));
    }

    for (const group of catalog.dataStates) {
        parts.push('', `#### \`${group.folder}\``, '', texts.dataFolderIntro(group.folder), '');
        const rows = group.entries.map((entry) => [
            code(entry.id),
            cell(entry.name),
            code(entry.type),
            code(entry.unit),
            formatValues(entry, texts)
        ]);
        parts.push(table(texts.dataColumns, rows));
    }

    parts.push('', `#### ${texts.resetableHeading}`, '', texts.resetableIntro, '');
    parts.push(catalog.resetableConsumables.map((name) => `- \`${cell(name)}\``).join('\n'));

    return parts.join('\n');
}

function renderErrorsBlock(catalog, texts) {
    const rows = catalog.errorCodes.map((entry) => [code(entry.code), cell(entry.text)]);
    return [
        `### ${texts.errorsHeading}`,
        '',
        texts.errorsIntro,
        '',
        '<details>',
        `<summary>${texts.errorsHeading} (${catalog.errorCodes.length})</summary>`,
        '',
        table(texts.errorsColumns, rows),
        '',
        '</details>'
    ].join('\n');
}

/**
 * Renders every generated block for one language.
 * @param {string} language ISO code.
 * @param {object} catalog Device catalogue from `buildDeviceCatalog()`.
 * @returns {Record<string, string>}
 */
function renderBlocks(language, catalog) {
    const texts = TEXTS[language];
    if (!texts) throw new Error(`No documentation texts defined for language '${language}'`);
    const configCatalog = buildConfigCatalog(language);

    return {
        models: renderModelsBlock(catalog, texts),
        config: renderConfigBlock(configCatalog, texts),
        states: renderStatesBlock(catalog, texts),
        errors: renderErrorsBlock(catalog, texts)
    };
}

function beginMarker(id) {
    return `<!-- BEGIN:${id} -->`;
}

function endMarker(id) {
    return `<!-- END:${id} -->`;
}

/**
 * Replaces the content between the markers, keeping everything else untouched.
 * @param {string} content Current file content.
 * @param {Record<string, string>} blocks Rendered blocks by id.
 * @param {string} label File name used in error messages.
 * @param {string[]} blockIds Blocks to replace, defaults to every known block.
 * @returns {string}
 */
function applyBlocks(content, blocks, label, blockIds = BLOCK_IDS) {
    let result = content;

    for (const id of blockIds) {
        const begin = beginMarker(id);
        const end = endMarker(id);
        const beginIndex = result.indexOf(begin);
        const endIndex = result.indexOf(end);

        if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
            throw new Error(`${label}: missing or misordered markers ${begin} … ${end}`);
        }

        const before = result.slice(0, beginIndex + begin.length);
        const after = result.slice(endIndex);
        result = `${before}\n\n${blocks[id]}\n\n${after}`;
    }

    return result;
}

/** Minimal document used when a language file does not exist yet. */
function createSkeleton(language) {
    const texts = TEXTS[language];
    const lines = ['# ioBroker.roborock', '', `<!-- ${texts.generatedHint} -->`, ''];
    for (const id of BLOCK_IDS) {
        lines.push(beginMarker(id), endMarker(id), '');
    }
    return lines.join('\n');
}

function normalise(content) {
    return content.replace(/\r\n/g, '\n');
}

function documentPath(language) {
    return path.join(DOCS_DIR, language, 'README.md');
}

/**
 * Writes (or verifies) the generated sections of every user document.
 * @param {{ check?: boolean }} options `check: true` only reports drift and writes nothing.
 * @returns {Promise<{ files: string[], outdated: string[] }>}
 */
async function generateUserDocs(options = {}) {
    const check = options.check === true;
    const catalog = await buildDeviceCatalog();

    const files = [];
    const outdated = [];

    for (const language of LANGUAGES) {
        const filePath = documentPath(language);
        const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
        const exists = fs.existsSync(filePath);
        const current = exists ? normalise(fs.readFileSync(filePath, 'utf8')) : createSkeleton(language);
        const updated = applyBlocks(current, renderBlocks(language, catalog), relativePath);

        files.push(relativePath);

        if (!exists || current !== updated) {
            outdated.push(relativePath);
            if (!check) {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, updated, 'utf8');
            }
        }
    }

    return { files, outdated };
}

module.exports = { generateUserDocs, renderBlocks, applyBlocks, documentPath, LANGUAGES, BLOCK_IDS };
