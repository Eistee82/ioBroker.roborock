// Builds a machine readable catalogue of everything the adapter publishes below
// `Devices.<duid>.*` by instantiating the real feature handlers offline.
//
// The feature handlers are TypeScript, so they are bundled with esbuild (already a
// dev dependency, `npm run build:www` uses it as well) into a CommonJS module below
// node_modules/.cache and required from there. Every dependency the handlers touch
// is stubbed, so no network, no ioBroker and no robot is involved: `initialize()`
// is called with `online = false`, which stops after the command objects have been
// created.
//
// The command definitions are not read from `handler.commands` but recorded from the
// injected `ensureState`. That way the catalogue contains the object definition the
// adapter really creates (including the role and default value that
// `BaseDeviceFeatures.processCommand()` derives) instead of a second, hand written
// copy of that logic.

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT_DIR, 'node_modules', '.cache', 'roborock-docs');
const BUNDLE_FILE = path.join(CACHE_DIR, 'featureRegistry.cjs');

const DOC_DUID = 'DOC';

/** Folders that hold writable command objects. */
const COMMAND_FOLDER_ORDER = ['commands', 'queries', 'settings'];

/**
 * Compiles the feature registry to CommonJS and loads it.
 * @returns {{ BaseDeviceFeatures: any, B01BaseVacuumFeatures: any, Feature: any, VACUUM_CONSTANTS: any }}
 */
function loadFeatureRegistry() {
    const esbuild = require('esbuild');

    const entry = [
        'export { BaseDeviceFeatures } from "./src/lib/features/baseDeviceFeatures";',
        'export { B01BaseVacuumFeatures } from "./src/lib/features/vacuum/b01/B01BaseVacuumFeatures";',
        'export { Feature } from "./src/lib/features/features.enum";',
        'export { VACUUM_CONSTANTS } from "./src/lib/features/vacuum/vacuumConstants";',
        'import "./src/lib/features/vacuum/index";'
    ].join('\n');

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    esbuild.buildSync({
        stdin: { contents: entry, resolveDir: ROOT_DIR, sourcefile: 'docs-entry.ts', loader: 'ts' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        packages: 'external',
        tsconfig: path.join(ROOT_DIR, 'tsconfig.json'),
        outfile: BUNDLE_FILE,
        logLevel: 'silent'
    });

    delete require.cache[require.resolve(BUNDLE_FILE)];
    return require(BUNDLE_FILE);
}

/**
 * Creates a dependency stub that satisfies the feature handlers without any IO.
 * @param {Map<string, object>} recordedObjects Receives every object the handler creates.
 */
function createStubDependencies(recordedObjects) {
    const noop = () => undefined;
    const log = { info: noop, warn: noop, error: noop, debug: noop, silly: noop };

    const adapter = {
        namespace: 'roborock.0',
        // Fixed language so value lists that are resolved through the app translations
        // do not depend on the machine the documentation is generated on.
        language: 'en',
        log,
        translations: {},
        translationManager: { get: (_key, fallback) => fallback || _key },
        rLog: noop,
        errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
        setState: noop,
        setStateChanged: async () => undefined,
        ensureFolder: async () => undefined,
        ensureState: async () => undefined,
        getStateAsync: async () => undefined,
        getStatesAsync: async () => ({}),
        // Reporting "object does not exist yet" routes every definition through ensureState.
        getObjectAsync: async () => undefined,
        extendObject: async () => undefined,
        setObject: async () => undefined,
        setObjectNotExistsAsync: async () => undefined,
        getDeviceProtocolVersion: async () => '1.0',
        requestsHandler: {
            sendRequest: async () => ({}),
            command: async () => undefined,
            mapParser: { parsedata: async () => ({}) },
            mapCreator: { canvasMap: async () => ['', '', ''] }
        },
        http_api: {
            getFwFeaturesResult: () => undefined,
            storeFwFeaturesResult: noop,
            getRobotModel: () => '',
            getDevices: () => []
        }
    };

    return {
        adapter,
        http_api: adapter.http_api,
        log,
        config: {},
        ensureFolder: async () => undefined,
        ensureState: async (statePath, common) => {
            recordedObjects.set(statePath, common ? JSON.parse(JSON.stringify(common)) : {});
        }
    };
}

/**
 * Normalises an ioBroker `common` block down to the fields the documentation shows.
 */
function pickCommon(common) {
    const picked = {
        name: typeof common.name === 'string' ? common.name : undefined,
        type: common.type,
        role: common.role,
        unit: common.unit,
        min: common.min,
        max: common.max,
        def: common.def,
        states: undefined
    };
    if (common.states && typeof common.states === 'object') {
        picked.states = {};
        for (const key of Object.keys(common.states)) {
            picked.states[key] = String(common.states[key]);
        }
    }
    return picked;
}

/** Stable signature used to detect definitions that differ between models. */
function signature(picked) {
    return JSON.stringify([picked.type, picked.role, picked.unit, picked.min, picked.max, picked.states]);
}

function mergeCommandEntry(target, picked, modelId) {
    target.models.push(modelId);
    if (target.signature === undefined) {
        target.signature = signature(picked);
        Object.assign(target, picked);
        return;
    }
    if (target.signature !== signature(picked)) {
        target.varies = true;
    }
}

/**
 * Converts a constant table (`VACUUM_CONSTANTS.deviceStates` and friends) into doc rows.
 */
function tableToRows(table) {
    return Object.keys(table)
        .sort((a, b) => a.localeCompare(b, 'en'))
        .map((key) => {
            const entry = table[key] || {};
            return { id: key, ...pickCommon(entry) };
        });
}

/**
 * Builds the full device catalogue.
 * @returns {Promise<object>} Plain JSON friendly catalogue.
 */
async function buildDeviceCatalog() {
    const registry = loadFeatureRegistry();
    const { BaseDeviceFeatures, B01BaseVacuumFeatures, Feature, VACUUM_CONSTANTS } = registry;

    const modelIds = BaseDeviceFeatures.getRegisteredModels().slice().sort((a, b) => a.localeCompare(b, 'en'));
    const featureValues = Object.values(Feature);

    const models = [];
    const commandFolders = new Map();

    for (const modelId of modelIds) {
        const ModelClass = BaseDeviceFeatures.getRegisteredModelClass(modelId);
        const recordedObjects = new Map();
        const handler = new ModelClass(createStubDependencies(recordedObjects), DOC_DUID);
        await handler.initialize(false);

        // `profile` is a protected field of V1VacuumFeatures; the profile name is the only
        // place in the code base that carries the marketing name of a model.
        const profileName = handler.profile && typeof handler.profile.name === 'string' ? handler.profile.name : undefined;

        const features = featureValues.filter((feature) => handler.hasStaticFeature(feature)).sort((a, b) => String(a).localeCompare(String(b), 'en'));

        const commandFolderNames = new Set(handler.getCommandFolders());
        let commandCount = 0;
        for (const [statePath, common] of recordedObjects) {
            const parts = statePath.split('.');
            // Devices.<duid>.<folder>.<state>
            if (parts.length !== 4 || parts[0] !== 'Devices' || parts[1] !== DOC_DUID) continue;
            const folder = parts[2];
            const stateId = parts[3];
            if (!commandFolderNames.has(folder)) continue;
            commandCount++;

            if (!commandFolders.has(folder)) commandFolders.set(folder, new Map());
            const folderMap = commandFolders.get(folder);
            if (!folderMap.has(stateId)) folderMap.set(stateId, { id: stateId, models: [], varies: false });
            mergeCommandEntry(folderMap.get(stateId), pickCommon(common), modelId);
        }

        models.push({
            id: modelId,
            name: profileName || modelId,
            protocol: handler instanceof B01BaseVacuumFeatures ? 'B01' : 'V1',
            features,
            commandCount
        });
    }

    const folders = [...commandFolders.keys()].sort((a, b) => {
        const ai = COMMAND_FOLDER_ORDER.indexOf(a);
        const bi = COMMAND_FOLDER_ORDER.indexOf(b);
        if (ai !== bi) return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
        return a.localeCompare(b, 'en');
    });

    const commands = folders.map((folder) => ({
        folder,
        entries: [...commandFolders.get(folder).values()]
            .sort((a, b) => a.id.localeCompare(b.id, 'en'))
            .map((entry) => {
                const { signature: _signature, models: entryModels, ...rest } = entry;
                return { ...rest, modelCount: entryModels.length };
            })
    }));

    const errorCodes = Object.keys(VACUUM_CONSTANTS.errorCodes)
        .map((code) => ({ code, text: String(VACUUM_CONSTANTS.errorCodes[code]) }))
        .sort((a, b) => Number(a.code) - Number(b.code));

    return {
        modelCount: models.length,
        models,
        commands,
        dataStates: [
            { folder: 'deviceStatus', entries: tableToRows(VACUUM_CONSTANTS.deviceStates) },
            { folder: 'consumables', entries: tableToRows(VACUUM_CONSTANTS.consumables) },
            { folder: 'cleaningInfo', entries: tableToRows(VACUUM_CONSTANTS.cleaningInfo) },
            // The folder name is not the name of the constants table: no code path ever writes
            // `Devices.<duid>.cleaningRecords`. `processResultKey` reaches this table through
            // `folder.includes("records")` (src/lib/features/baseDeviceFeatures.ts:648), and the
            // folder the three pipelines actually write is `cleaningInfo.records.<index>`
            // (v1VacuumFeatures.ts:1017, B01MapService.ts:322, Q10CleanRecordService.ts:79).
            { folder: 'cleaningInfo.records.<index>', entries: tableToRows(VACUUM_CONSTANTS.cleaningRecords) }
        ],
        resetableConsumables: [...VACUUM_CONSTANTS.resetConsumables].sort((a, b) => a.localeCompare(b, 'en')),
        errorCodes
    };
}

module.exports = { buildDeviceCatalog };
