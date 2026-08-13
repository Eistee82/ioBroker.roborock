// Reads the admin configuration definition and turns it into documentation rows.
//
// `admin/jsonConfig.json` already carries type, default value and visibility condition
// of every setting, and `admin/i18n/<lang>.json` carries the label and the help text in
// every language the adapter ships. Both together are enough to describe the
// configuration in any supported language without translating a single string here.

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const JSON_CONFIG_FILE = path.join(ROOT_DIR, 'admin', 'jsonConfig.json');
const I18N_DIR = path.join(ROOT_DIR, 'admin', 'i18n');

/** Item types that only structure the dialog and carry no value. */
const LAYOUT_TYPES = new Set(['panel', 'header', 'divider', 'staticText', 'staticLink', 'staticImage']);

/**
 * Loads the translation table of one language.
 * @param {string} language ISO code, e.g. `de`.
 * @returns {Record<string, string>}
 */
function loadTranslations(language) {
    const file = path.join(I18N_DIR, `${language}.json`);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Lists every language the adapter ships translations for.
 * @returns {string[]}
 */
function listLanguages() {
    if (!fs.existsSync(I18N_DIR)) return [];
    return fs.readdirSync(I18N_DIR)
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.basename(file, '.json'))
        .sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Builds the configuration catalogue for one language.
 * @param {string} language ISO code, e.g. `en`.
 * @returns {{ language: string, sections: object[] }}
 */
function buildConfigCatalog(language) {
    const jsonConfig = JSON.parse(fs.readFileSync(JSON_CONFIG_FILE, 'utf8'));
    const translations = loadTranslations(language);
    const translate = (text) => (typeof text === 'string' && translations[text] ? translations[text] : text);

    const sections = [];

    for (const [panelId, panel] of Object.entries(jsonConfig.items || {})) {
        if (!panel || panel.type !== 'panel') continue;
        const section = {
            id: panelId,
            label: translate(panel.label) || panelId,
            notes: [],
            settings: []
        };

        for (const [itemId, item] of Object.entries(panel.items || {})) {
            if (!item || typeof item !== 'object') continue;

            if (LAYOUT_TYPES.has(item.type)) {
                // Explanatory blocks carry real setup information and are kept as notes.
                const text = translate(item.text);
                if (item.type === 'staticText' && text) section.notes.push(text);
                continue;
            }

            section.settings.push({
                id: itemId,
                label: translate(item.label) || itemId,
                type: item.type,
                default: item.default,
                help: translate(item.help) || translate(item.tooltip) || '',
                options: Array.isArray(item.options)
                    ? item.options.map((option) => ({ value: option.value, label: translate(option.label) }))
                    : undefined,
                shownWhen: typeof item.hidden === 'string' ? item.hidden : undefined
            });
        }

        sections.push(section);
    }

    return { language, sections };
}

module.exports = { buildConfigCatalog, listLanguages, loadTranslations };
