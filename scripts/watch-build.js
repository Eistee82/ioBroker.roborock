const { spawn } = require("node:child_process");
const path = require("node:path");
const chokidar = require("chokidar");

const SRC_DIR = path.join(__dirname, "..", "src");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const DEBOUNCE_MS = 10000; // 10s after last save before building (avoids build on every keystroke)
const DEBOUNCE_TAB_MS = 1500; // 1.5s for tab rebuild (faster feedback for map UI)
const RESTART_DELAY_MS = 3000; // delay before auto-restart after crash/error

let timer = null;
let timerTab = null;
let isBuilding = false;
let isBuildingTab = false;
let watcher = null;
let restartTimeout = null;

function runBuildTab(isInitial = false) {
    if (isBuildingTab) return;
    isBuildingTab = true;
    const label = isInitial ? "Initial tab build" : "tab change detected";
    console.log(`\n🌐 ${label} → building admin/tab.html + admin/assets...\n`);

    try {
        const proc = spawn(`${npmCmd} run build:tab`, { stdio: "inherit", shell: true });
        proc.on("close", (code) => {
            isBuildingTab = false;
            if (code === 0) {
                console.log("\n✅ tab build done. Watching for changes...");
            } else {
                console.error(`\n❌ build:tab failed with code ${code}.`);
            }
        });
    } catch (e) {
        console.error("❌ build:tab failed to start:", e);
        isBuildingTab = false;
    }
}

function runCheck(isInitial = false) {
    if (isBuilding) return;
    isBuilding = true;
    const label = isInitial ? "Initial run" : "Change detected";
    console.log(`\n\n📦 ${label}! Running ci:check (lint + typecheck + unit tests)...\n`);

    try {
        const proc = spawn(`${npmCmd} run ci:check`, { stdio: "inherit", shell: true });
        proc.on("close", (code) => {
            isBuilding = false;
            if (code === 0) {
                console.log("\n✅ ci:check passed! Watching for changes...");
            } else {
                console.error(`\n❌ ci:check failed with code ${code}.`);
            }
        });
    } catch (e) {
        console.error("❌ ci:check failed to start:", e);
        isBuilding = false;
    }
}

function stopWatching() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    if (timerTab) {
        clearTimeout(timerTab);
        timerTab = null;
    }
    if (watcher) {
        try {
            watcher.close();
        } catch (e) {
            // ignore
        }
        watcher = null;
    }
    if (restartTimeout) {
        clearTimeout(restartTimeout);
        restartTimeout = null;
    }
}

function startWatching() {
    stopWatching();
    isBuilding = false;

    console.log(`👀 Watching for changes in: ${SRC_DIR}`);
    console.log("   On save: ci:check = lint + typecheck + unit tests (after 10s debounce).");
    console.log("   Changes under src/common → build:tab (admin/tab.html + admin/assets) after 1.5s.");
    console.log("   For full CI (incl. integration/package): run 'npm run verify' with JS-Controller stopped.\n");

    watcher = chokidar.watch(SRC_DIR, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        ignoreInitial: true
    });

    // The tab bundles these shared modules, so a change in them has to reach admin/assets too.
    const isMapDrawing = (filePath) => {
        const normalized = filePath.replace(/\\/g, "/");
        return normalized.includes("/common/mapDrawing/") || normalized.includes("/common/coordTransformation") || normalized.includes("/common/pathProcessor");
    };

    watcher.on("all", (event, filePath) => {
        if (filePath && (filePath.endsWith(".ts") || filePath.endsWith(".json") || filePath.endsWith(".css") || filePath.endsWith(".html"))) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                runCheck(false);
            }, DEBOUNCE_MS);
            if (isMapDrawing(filePath)) {
                if (timerTab) clearTimeout(timerTab);
                timerTab = setTimeout(() => {
                    runBuildTab(false);
                }, DEBOUNCE_TAB_MS);
            }
        }
    });

    watcher.on("error", (err) => {
        console.error("❌ Watcher error:", err.message || err);
        stopWatching();
        console.log(`🔄 Restarting watcher in ${RESTART_DELAY_MS / 1000}s...`);
        restartTimeout = setTimeout(() => startWatching(), RESTART_DELAY_MS);
    });

    runCheck(true);
    runBuildTab(true);
}

// Auto-restart on uncaught errors so "watch:all" keeps running
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught exception:", err.message || err);
    stopWatching();
    console.log(`🔄 Restarting watcher in ${RESTART_DELAY_MS / 1000}s...`);
    restartTimeout = setTimeout(() => startWatching(), RESTART_DELAY_MS);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Unhandled rejection:", reason);
    stopWatching();
    console.log(`🔄 Restarting watcher in ${RESTART_DELAY_MS / 1000}s...`);
    restartTimeout = setTimeout(() => startWatching(), RESTART_DELAY_MS);
});

startWatching();
