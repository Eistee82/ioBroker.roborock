// src/main.ts
/// <reference types="@iobroker/adapter-core" />

import * as utils from "@iobroker/adapter-core";
import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import go2rtcPath from "go2rtc-static";
import { commitInfo } from "./lib/commitInfo";

// --- API & Helper Imports ---
import { AppPluginManager } from "./lib/AppPluginManager";
import { B01Variant, getB01VariantFromModel } from "./lib/b01Variant";
import { OUTCOME_QUALITY, buildCommandComment, classifyRequestFailure, isProblemOutcome, isShutdownFailure, outcomeArgs } from "./lib/commandFeedback";
import type { CommandOrigin, CommandOutcome, CommandOutcomeReport } from "./lib/commandFeedback";
import { ConnectionStatusManager } from "./lib/connectionStatus";
import { DeviceManager } from "./lib/deviceManager";
import { LOCAL_ONLY_LIMITATIONS, isLocalOnlyMode, parseManualDevices } from "./lib/manualDevices";
import { BaseDeviceFeatures } from "./lib/features/baseDeviceFeatures";
import type { CommandSpec } from "./lib/features/baseDeviceFeatures";
import { Feature } from "./lib/features/features.enum";

import { Device, http_api } from "./lib/httpApi";
import { local_api } from "./lib/localApi";
import { MapManager } from "./lib/map/MapManager";
import { isReportableMapTheme, resolveMapColorScheme } from "./lib/map/mapColorScheme";
import { NON_ROOM_STATE_NAMES, normalizeRoomId } from "./lib/map/roomKey";
import { mqtt_api } from "./lib/mqttApi";
import { isChannelUnavailableError } from "./lib/requestPolicy";
import { PendingMapEntry, RequestPriority, RoborockRequest, requestsHandler } from "./lib/requestsHandler";
import { socketHandler } from "./lib/socketHandler";
import { TranslationManager } from "./lib/translationManager";

interface SentryPlugin {
	getSentryObject(): {
		captureException(error: unknown): void;
	};
}

type SceneQueueCommand = {
	duid: string;
	method: string;
	params: unknown;
	waitForCompletionAfter?: boolean;
	attempts?: number;
};

type PersistedSceneQueue = {
	version: 1;
	id: string;
	sceneId: string;
	sceneName?: string;
	commands: SceneQueueCommand[];
	nextIndex: number;
	waitingForCompletion: boolean;
	createdAt: number;
	updatedAt: number;
};

type SceneExecutionMode = "local" | "cloud";
type SceneSegmentWaitResult = "ready" | "not-started" | "finish-timeout" | "cancelled";
type SceneSegmentStartResult = "started" | "not-started" | "cancelled";
type SceneSegmentInactiveResult = "ready" | "timeout" | "cancelled";

/**
 * State patterns the adapter watches on top of the per device command folders
 * (`Devices.*.<commandFolder>.*`, derived at runtime from the feature handlers).
 *
 * Every writable state needs to be covered here, otherwise its writes never reach
 * {@link Roborock.onStateChange} and the state looks operable while doing nothing. The nested
 * entries `schedules.<timerId>.enabled` and `floors.<mapFlag>.load` are exactly such cases.
 * `test/unit/state_subscriptions.test.ts` guards the coverage.
 */
export const STATIC_SUBSCRIPTION_PATTERNS = [
	"Devices.*.resetConsumables.*",
	"Devices.*.programs.*",
	"Devices.*.schedules.*",
	"Devices.*.floors.*",
	"Devices.*.deviceStatus.state",
	"Devices.*.deviceStatus.status",
	"loginCode",
	// Root state, written by the admin tab (and settable by hand): which theme the map bitmap
	// should be painted for. Only consulted when `map_color_scheme` is `auto`.
	"mapTheme"
] as const;

const SCENE_QUEUE_VERSION = 1;
const SCENE_SEGMENT_START_MAX_ATTEMPTS = 3;
const SCENE_SEGMENT_START_TIMEOUT_MS = 2 * 60 * 1000;
const SCENE_SEGMENT_FINISH_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const SCENE_SEGMENT_READY_STABLE_MS = 30 * 1000;
const SCENE_SEGMENT_RETRY_DELAY_MS = 30 * 1000;
const SCENE_SEGMENT_DOCK_CANCEL_STABLE_MS = 2 * 60 * 1000;
const SCENE_SEGMENT_POLL_INTERVAL_MS = 10 * 1000;
const SCENE_SEGMENT_STARTED_STATES = new Set([
	18, // Room Clean
]);
const SCENE_SEGMENT_ACTIVE_STATES = new Set([
	5,  // Cleaning
	6,  // Returning Dock
	7,  // Manual Mode
	10, // Paused
	11, // Spot Cleaning
	15, // Docking
	16, // Go To
	17, // Zone Clean
	18, // Room Clean
	22, // Emptying dust container
	23, // Washing the mop
	25, // Washing duster
	26, // Going to wash the mop
	29, // Mapping
	33, // Setting up the mop
	34, // Removing the mop
	38, // Tidy-up housework
	39, // Remote pick-up
	41, // Arm resetting
	42, // Program mode
]);
const SCENE_SEGMENT_RETURN_TO_DOCK_STATES = new Set([
	6,  // Returning Dock
	15, // Docking
]);
const SCENE_SEGMENT_DOCK_SERVICE_STATES = new Set([
	22, // Emptying dust container
	23, // Washing the mop
	25, // Washing duster
	26, // Going to wash the mop
	33, // Setting up the mop
	34, // Removing the mop
]);
export class Roborock extends utils.Adapter {
	// --- Public APIs (accessible by helpers) ---
	public http_api: http_api;
	public local_api: local_api;
	public mqtt_api: mqtt_api;
	public requestsHandler: requestsHandler;
	public socketHandler!: socketHandler;
	public deviceManager!: DeviceManager;
	public mapManager: MapManager;
	public translationManager!: TranslationManager;
	public connectionStatus: ConnectionStatusManager;

	// --- Internal Properties ---
	public deviceFeatureHandlers: Map<string, BaseDeviceFeatures>;
	public nonce: Buffer;
	public pendingRequests: Map<number, RoborockRequest | PendingMapEntry>;
	/** B01: FIFO queue of expected 301 map response types (classify + taskBeginDate match using this order). */
	public b01MapResponseQueue: Map<string, Array<"get_map_v1" | "get_clean_record_map">> = new Map();
	public appPluginManager: AppPluginManager;

	public isInitializing: boolean;
	public sentryInstance: SentryPlugin | undefined;
	public translations: Record<string, string> = {};

	private commandTimeouts: Map<string, ioBroker.Timeout> = new Map();
	private activeSceneQueueProcessors: Set<string> = new Set();
	private ensuredSceneQueueStates: Set<string> = new Set();
	/** Set by `onUnload`; stops command outcomes from being written during the tear-down. */
	private shuttingDown = false;
	private mqttReconnectInterval: ioBroker.Interval | undefined = undefined;
	public instance: number = 0;
	private go2rtcProcess: ChildProcess | null = null;
	// Bound exit handler to prevent memory leaks while allowing process.removeListener
	private onExitBound: (() => void) | null = null;

	constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({ ...options, name: "roborock", useFormatDate: true });

		this.instance = options.instance || 0;
		this.nonce = randomBytes(16);
		this.pendingRequests = new Map();
		this.http_api = new http_api(this);
		this.local_api = new local_api(this);
		this.mqtt_api = new mqtt_api(this);
		this.requestsHandler = new requestsHandler(this);
		this.mapManager = new MapManager(this);
		this.translationManager = new TranslationManager(this);

		this.connectionStatus = new ConnectionStatusManager(this);
		this.deviceManager = new DeviceManager(this);
		this.socketHandler = new socketHandler(this);
		this.deviceFeatureHandlers = this.deviceManager.deviceFeatureHandlers;

		this.appPluginManager = new AppPluginManager(this);

		this.isInitializing = true;

		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));

		// Global Error Handlers
		process.on("uncaughtException", (err) => {
			this.rLog("System", null, "Error", undefined, undefined, `Uncaught Exception: ${err.message}\n${err.stack}`, "error");
		});

		process.on("unhandledRejection", (reason) => {
			this.rLog("System", null, "Error", undefined, undefined, `Unhandled Rejection: ${reason}`, "error");
		});
	}

	/**
	 * Loads admin translations from the current short i18n format and keeps a fallback
	 * for older local builds that still contain long-format files.
	 */
	private loadAdminTranslations(): Record<string, string> {
		const lang = this.language || "en";
		for (const candidate of [`../admin/i18n/${lang}.json`, `../admin/i18n/${lang}/translations.json`, "../admin/i18n/en.json", "../admin/i18n/en/translations.json"]) {
			try {
				return require(candidate);
			} catch {
				// Try the next supported translation layout.
			}
		}
		return {};
	}

	/**
	 * Adapter ready logic.
	 */
	async onReady() {
		const localOnly = isLocalOnlyMode(this.config);
		const manualDevices = parseManualDevices(this.config.manualDevices);

		for (const error of manualDevices.errors) {
			this.rLog("System", null, "Error", undefined, undefined, `[Manual device config] ${error}`, "error");
		}
		for (const warning of manualDevices.warnings) {
			this.rLog("System", null, "Warn", undefined, undefined, `[Manual device config] ${warning}`, "warn");
		}

		// Config properties are now type-safe thanks to types.d.ts
		if (!localOnly && !this.config.username) {
			this.rLog("System", null, "Error", undefined, undefined, "Username missing!", "error");
			this.isInitializing = false;
			return;
		}

		if (localOnly && manualDevices.devices.length === 0) {
			this.rLog("System", null, "Error", undefined, undefined, "Connection mode is 'local only' but no manual device is configured. Add at least one device with duid and localKey.", "error");
			this.isInitializing = false;
			return;
		}

		this.translationManager.init();
		await this.initMapThemeState();

		this.sentryInstance = this.getPluginInstance("sentry") as SentryPlugin | undefined;
		this.translations = this.loadAdminTranslations();

		this.rLog("System", null, "Info", undefined, undefined, `Build Info: Date=${commitInfo.commitDate}, Commit=${commitInfo.commitHash}`, "debug");

		// Log adapter settings at start (no credentials) for easier support/debugging
		const safeSettings: Record<string, unknown> = {
			enable_map_creation: this.config.enable_map_creation,
			updateInterval: this.config.updateInterval,
			region: this.config.region,
			loginMethod: this.config.loginMethod,
			map_theme: this.config.map_theme,
			map_color_scheme: this.config.map_color_scheme,
			sceneExecutionMode: this.getSceneExecutionMode(),
			connectionMode: localOnly ? "local" : "cloud",
			manualDeviceCount: manualDevices.devices.length,
			udpDiscoveryEnabled: this.local_api.isUdpDiscoveryEnabled(),
			udpBindAddress: this.local_api.getUdpBindAddress() ?? "all interfaces",
		};
		if ("map_creation_interval" in this.config) safeSettings.map_creation_interval = (this.config as Record<string, unknown>).map_creation_interval;
		if ("map_scale" in this.config) safeSettings.map_scale = (this.config as Record<string, unknown>).map_scale;
		if ("webserverPort" in this.config) safeSettings.webserverPort = (this.config as Record<string, unknown>).webserverPort;
		this.rLog("System", null, "Info", undefined, undefined, `Settings: ${JSON.stringify(safeSettings)}`, "info");

		// Full config for debug (credentials redacted)
		const configSummary = {
			...this.config,
			username: this.config.username ? "******" : "NOT_SET",
			password: this.config.password ? "******" : "NOT_SET",
			cameraPin: this.config.cameraPin ? "******" : undefined,
			// Contains localKeys - never write it to the log.
			manualDevices: manualDevices.devices.length > 0 ? `****** (${manualDevices.devices.length} device(s))` : "NOT_SET",
		};
		this.rLog("System", null, "Info", undefined, undefined, `Config: ${JSON.stringify(configSummary)}`, "debug");

		await this.setupBasicObjects();

		try {
			// Manual entries are the only device source in cloud-free operation and take
			// precedence over the cloud copy when both exist.
			this.http_api.applyManualDevices(manualDevices.devices);

			if (localOnly) {
				this.rLog("System", null, "Info", undefined, undefined, `Cloud-free operation active. The adapter will not contact the Roborock cloud. Not available in this mode: ${LOCAL_ONLY_LIMITATIONS.join("; ")}.`, "info");
				if (this.config.enable_map_creation) {
					this.rLog("System", null, "Warn", undefined, undefined, "Map creation is enabled, but map retrieval currently needs the cloud connection. Maps will stay empty in 'local only' mode.", "warn");
				}
			} else {
				const clientID = await this.ensureClientID();
				await this.http_api.init(clientID);

				// 1. Start Cloud Data Sync (Get Keys & DUIDs)
				await this.http_api.updateHomeData();

				// 1b. Asset download for account models (before device init)
				await this.downloadAssetsForAccountModels();
			}

			// 2a. Start UDP Discovery (Essential for determining Local/Cloud mode before Init)
			await this.local_api.startUdpDiscovery();

			// 2a2. Statically configured endpoints work without any discovery at all.
			await this.local_api.applyManualEndpoints(manualDevices.devices);

			// 2b. Start MQTT and WAIT for the connection to be established
			if (!localOnly) {
				await this.mqtt_api.init();
			}

			// --- Pre-Init Network Probe (Docker/VLAN Support) ---
			this.rLog("System", null, "Info", undefined, undefined, "Starting Pre-Init Network Probe...", "debug");
			const allDevices = this.http_api.getDevices() || [];
			const probePromises = allDevices.map(async (device) => {
				const duid = device.duid;
				if (!device.online) return; // Skip devices cloud reports as offline
				// If already local (UDP found it), skip
				if (this.local_api.isConnected(duid)) return;
				// The probe asks the robot via get_network_info; without the cloud there is no
				// transport for that when no local session exists yet.
				if (localOnly) return;
				const protocolVersion = device.pv || await this.getDeviceProtocolVersion(duid);
				if (protocolVersion === "B01") {
					const model = this.http_api.getRobotModel(duid) || "";
					if (model && getB01VariantFromModel(model) === "Q10") {
						return;
					}
				}

				try {
					const promoted = await this.local_api.probeLocalEndpointFromNetworkInfo(duid, "pre-init network probe", 1500, true, 10000);
					if (!promoted) {
						this.rLog("System", duid, "Debug", undefined, undefined, "Probe did not resolve a local TCP endpoint.", "debug");
					}
				} catch (e: unknown) {
					const errorMsg = e instanceof Error ? e.message : String(e);
					this.rLog("System", duid, "Debug", undefined, undefined, `Probe failed: ${errorMsg}`, "debug");
				}
			});

			// Wait for all probes to finish (with timeout to not block forever)
			await Promise.race([
				Promise.all(probePromises),
				this.delay(10000) // Max 10s probe time
			]);
			this.rLog("System", null, "Info", undefined, undefined, "Network Probe finished.", "info");
			// ----------------------------------------------------

			// 3. Initialize Devices (now that communication channels are ready)
			await this.deviceManager.initializeDevices();

			const writableFolders = new Set<string>();
			for (const handler of this.deviceFeatureHandlers.values()) {
				for (const folder of handler.getCommandFolders()) {
					writableFolders.add(folder);
				}
			}

			// Parallelize non-dependent startup tasks
			await Promise.all([
				...(localOnly ? [] : [this.processScenes(), this.start_go2rtc()]),
				...this.getSubscriptionPatterns(writableFolders).map((pattern) => this.subscribeStatesAsync(pattern))
			]);

			if (!localOnly) {
				await this.resumeSceneQueues();
			}

			this.deviceManager.startPolling();
			this.local_api.startTcpKeepaliveInterval();
			await this.connectionStatus.updateAll();
			this.connectionStatus.start();

			this.rLog("System", null, "Info", undefined, undefined, "Adapter startup finished. Let's go!", "info");
			this.isInitializing = false;

			// Schedule MQTT API reset every hour (legacy behavior to prevent stale connections)
			if (!localOnly) {
				this.mqttReconnectInterval = this.setInterval(() => {
					this.rLog("System", null, "Debug", undefined, undefined, "Running scheduled MQTT reconnect...", "debug");
					this.resetMqttApi().catch((e: unknown) => {
						this.rLog("System", null, "Error", undefined, undefined, `Scheduled MQTT reconnect failed: ${e instanceof Error ? e.message : String(e)}`, "error");
						this.catchError(e, "resetMqttApi (scheduled)");
					});
				}, 3600 * 1000);
			}
		} catch (e: unknown) {
			this.rLog("System", null, "Error", undefined, undefined, `Failed to initialize adapter: ${this.errorMessage(e)}`, "error");
			this.catchError(e, "onReady");
			this.isInitializing = false;
		}
	}

	/**
	 * Message handler for Admin/Vis communication.
	 */
	async onMessage(obj: ioBroker.Message) {
		if (obj && obj.command && obj.callback) {
			try {
				// Forward to the dedicated handler
				await this.socketHandler.handleMessage(obj);
			} catch (err: unknown) {
				this.rLog("Requests", null, "Error", undefined, undefined, `Failed to execute command ${obj.command}: ${this.errorMessage(err)}`, "error");
				this.sendTo(obj.from, obj.command, { error: this.errorMessage(err) }, obj.callback);
			}
		}
	}

	private getSceneExecutionMode(): SceneExecutionMode {
		return this.config.sceneExecutionMode === "cloud" ? "cloud" : "local";
	}

	/**
	 * Theme a browser last reported through {@link setReportedMapTheme}.
	 *
	 * Cached in memory because it is read once per rendered map and the render path must stay
	 * synchronous; the `mapTheme` state is the durable copy and seeds this on startup.
	 */
	private reportedMapTheme: "light" | "dark" | null = null;

	/** State id (relative to the instance) carrying the theme a browser reported. */
	private static readonly MAP_THEME_STATE = "mapTheme";

	/**
	 * State id (relative to the instance) carrying the colour set the map is actually painted with.
	 *
	 * The answer, where {@link MAP_THEME_STATE} is only one of the two questions: with the option
	 * `map_color_scheme` pinned to `light` or `dark` the reported theme never reaches the picture
	 * at all. Anything that draws **on** the map - the zones and the room marker in the admin tab -
	 * needs this value and cannot compute it, because it knows neither the option nor what other
	 * browsers reported.
	 *
	 * Read only on purpose. `mapTheme` stays writable so a script can steer the map without a
	 * browser; writing the resolved scheme by hand would only be overwritten by the next report.
	 */
	private static readonly MAP_COLOR_SCHEME_STATE = "mapColorScheme";

	/**
	 * The colour set the map bitmap is currently painted with.
	 *
	 * Called by the V1 renderer on every map it draws. See `src/lib/map/mapColorScheme.ts` for why
	 * a browser has to report its theme at all and what that means when several are open.
	 * @returns `"light"` or `"dark"`; `"light"` is the picture every installation had before.
	 */
	public getMapColorScheme(): "light" | "dark" {
		return resolveMapColorScheme(this.config.map_color_scheme, this.reportedMapTheme);
	}

	/**
	 * Creates the `mapTheme` state, adopts whatever it already holds, and publishes the scheme that
	 * follows from it.
	 *
	 * Without the first part the first map after a restart would be drawn light even though the
	 * admin is dark, until a browser happens to reconnect and report again.
	 *
	 * The second part has to happen **here**, not on the first report: the option may have been
	 * changed while the adapter was stopped, in which case no report is coming and the published
	 * scheme would describe the previous run. This runs early in `onReady`, before any device is
	 * set up, so the value is in place before the first bitmap exists - a tab that opens later can
	 * never read a scheme older than the map it is looking at.
	 */
	private async initMapThemeState(): Promise<void> {
		await this.ensureState(Roborock.MAP_THEME_STATE, {
			name: "Map theme reported by the admin tab",
			type: "string",
			role: "state",
			read: true,
			write: true,
			states: { light: "Light", dark: "Dark" },
		});

		const stored = await this.getStateAsync(Roborock.MAP_THEME_STATE);
		if (isReportableMapTheme(stored?.val)) {
			this.reportedMapTheme = stored.val;
		}

		await this.ensureState(Roborock.MAP_COLOR_SCHEME_STATE, {
			name: "Colour set the map is painted with",
			type: "string",
			role: "state",
			read: true,
			write: false,
			states: { light: "Light", dark: "Dark" },
		});
		await this.publishMapColorScheme();

		this.rLog("System", null, "Info", undefined, undefined, `Map colour scheme: ${this.getMapColorScheme()} (setting '${this.config.map_color_scheme ?? "light"}', reported theme '${this.reportedMapTheme ?? "none"}')`, "debug");
	}

	/**
	 * Writes the currently resolved colour scheme to {@link MAP_COLOR_SCHEME_STATE}.
	 *
	 * Everything that draws on the map reads this, so it must never trail the bitmap: called once
	 * at startup and again whenever the resolved scheme changes, in both cases **before** the maps
	 * are painted with it.
	 */
	private async publishMapColorScheme(): Promise<void> {
		await this.setState(Roborock.MAP_COLOR_SCHEME_STATE, { val: this.getMapColorScheme(), ack: true });
	}

	/**
	 * Takes the theme a browser reports and repaints the stored maps when it actually changes
	 * something.
	 *
	 * Guarded twice on purpose: an unchanged report costs nothing, and a report that does not
	 * change the resolved scheme - which is every report while the option is `light` or `dark` -
	 * must not trigger a render either. Only a real change of the resolved scheme repaints, and it
	 * repaints from the map data already stored, so no robot is asked anything.
	 * @param theme Theme name reported by a client.
	 */
	public async setReportedMapTheme(theme: "light" | "dark"): Promise<void> {
		const before = this.getMapColorScheme();
		const changed = this.reportedMapTheme !== theme;
		this.reportedMapTheme = theme;

		if (changed) {
			await this.setState(Roborock.MAP_THEME_STATE, { val: theme, ack: true });
		}

		const after = this.getMapColorScheme();
		if (before === after) return;

		this.rLog("System", null, "Info", undefined, undefined, `Map colour scheme changed to '${after}'; repainting the stored maps.`, "info");
		// Announced before the repaint, not after: the tab draws its zones and its room marker in
		// these colours, and repainting every stored map takes long enough that the other order
		// would leave the overlays on the old set while the picture under them is already the new
		// one. The reverse gap is the harmless one - the overlays are redrawn on the map that
		// arrives moments later anyway.
		await this.publishMapColorScheme();
		await this.mapManager.repaintStoredMaps();
	}

	async executeSceneProgram(duid: string, sceneId: string | number): Promise<void> {
		const mode = this.getSceneExecutionMode();
		if (!this.http_api.hasCloudSession()) {
			// No silent detour: saved programs are defined in the cloud, so say so instead of failing obscurely.
			await this.ensureSceneQueueState(duid);
			await this.setSceneQueueStatus(duid, "cloud-required");
			this.rLog("Requests", duid, "Error", undefined, undefined, `[Scene] Saved program ${sceneId} cannot be started: the scene definition currently needs the cloud connection, which is disabled in 'local only' mode.`, "error");
			return;
		}
		await this.ensureSceneQueueState(duid);
		await this.setState(this.getSceneQueueModeStateId(duid), { val: mode, ack: true });

		if (mode === "cloud") {
			await this.executeSceneCloud(duid, sceneId);
			return;
		}

		await this.executeSceneLocal(duid, sceneId);
	}

	private async executeSceneCloud(duid: string, sceneId: string | number): Promise<void> {
		try {
			this.rLog("Requests", duid, "Info", undefined, undefined, `[Scene] Executing cloud scene ${sceneId} via Roborock scene endpoint`, "info");
			await this.clearSceneQueue(duid, "cloud");
			const response = await this.http_api.executeScene(sceneId);
			await this.setSceneQueueStatus(duid, "cloud-triggered");
			this.rLog("Requests", duid, "Debug", undefined, undefined, `[Scene] Cloud scene ${sceneId} response: ${JSON.stringify(response)}`, "debug");
		} catch (error: unknown) {
			await this.setSceneQueueStatus(duid, "cloud-error");
			this.rLog("Requests", duid, "Error", undefined, undefined, `[Scene] Failed to execute cloud scene ${sceneId}: ${this.errorMessage(error)}`, "error");
		}
	}

	/**
	 * Executes a scene locally by parsing the scene definition and sending commands to the device.
	 */
	async executeSceneLocal(duid: string, sceneId: string | number): Promise<void> {
		try {
			this.rLog("Requests", duid, "Info", undefined, undefined, `[Scene] Executing local scene ${sceneId}`, "info");

			// 1. Fetch scenes
			const scenes = await this.http_api.getScenes();
			if (!scenes || !scenes.result) {
				this.rLog("Requests", duid, "Error", undefined, undefined, `[Scene] Failed to fetch scenes or no result for ${sceneId}`, "error");
				return;
			}

			// 2. Find target scene
			// Scene ID from state might be string, API returns number. Compare loosely or convert.
			const scene = scenes.result.find((s) => s.id == sceneId);
			if (!scene) {
				this.rLog("Requests", duid, "Error", undefined, undefined, `[Scene] Scene ${sceneId} not found`, "error");
				return;
			}

			this.rLog("Requests", duid, "Debug", undefined, undefined, `[Scene] Found scene "${scene.name}"`, "debug");

			let params;
			try {
				params = JSON.parse(scene.param);
			} catch (e: unknown) {
				this.rLog("Requests", duid, "Error", undefined, undefined, `[Scene] Failed to parse params for ${sceneId}: ${this.errorMessage(e)}`, "error");
				return;
			}

			const actionItems = params?.action?.items;
			if (!Array.isArray(actionItems) || actionItems.length === 0) {
				this.rLog("Requests", duid, "Warn", undefined, undefined, `[Scene] Scene ${sceneId} has no actions`, "warn");
				return;
			}
			const targetDuid = this.resolveSceneTargetDuid(duid, actionItems);
			const commands = await this.buildSceneQueueCommands(targetDuid, sceneId, actionItems);
			if (commands.length === 0) {
				this.rLog("Requests", targetDuid, "Warn", undefined, undefined, `[Scene] Scene ${sceneId} has no executable commands`, "warn");
				return;
			}

			for (let index = 0; index < commands.length; index++) {
				commands[index].waitForCompletionAfter = commands[index].method === "do_scenes_segments" && index < commands.length - 1;
			}

			const now = Date.now();
			const queue: PersistedSceneQueue = {
				version: SCENE_QUEUE_VERSION,
				id: `${now}-${randomBytes(4).toString("hex")}`,
				sceneId: String(sceneId),
				sceneName: typeof scene.name === "string" ? scene.name : undefined,
				commands,
				nextIndex: 0,
				waitingForCompletion: false,
				createdAt: now,
				updatedAt: now,
			};

			await this.saveSceneQueue(targetDuid, queue);
			this.rLog("Requests", targetDuid, "Info", undefined, undefined, `[Scene] Queued local scene ${sceneId} with ${commands.length} command(s)`, "info");
			void this.processSceneQueue(targetDuid);
		} catch (e: unknown) {
			this.rLog("Requests", duid, "Error", undefined, undefined, `[Scene] Error executing ${sceneId}: ${this.errorMessage(e)}`, "error");
		}
	}
	private async buildSceneQueueCommands(defaultDuid: string, sceneId: string | number, actionItems: unknown[]): Promise<SceneQueueCommand[]> {
		const commands: SceneQueueCommand[] = [];

		for (const item of actionItems) {
			if (!this.isRecord(item) || item.type !== "CMD") continue;
			const itemDuid = typeof item.entityId === "string" && item.entityId.trim().length > 0 ? item.entityId : defaultDuid;

			const rawCommandPayload = this.tryParseSceneCommandPayload(item.param);
			const parsedCommandPayload = this.isRecord(rawCommandPayload) ? rawCommandPayload : null;
			if (!parsedCommandPayload?.method) {
				const itemId = typeof item.id === "string" ? item.id : `${item.id}`;
				this.rLog("Requests", itemDuid, "Warn", undefined, undefined, `[Scene] Invalid command item ${itemId} in ${sceneId}`, "warn");
				continue;
			}

			const method = typeof parsedCommandPayload.method === "string" ? parsedCommandPayload.method : "";
			if (!method) {
				const itemId = typeof item.id === "string" ? item.id : `${item.id}`;
				this.rLog("Requests", itemDuid, "Warn", undefined, undefined, `[Scene] Command without string method for item ${itemId} in ${sceneId}`, "warn");
				continue;
			}

			const args = this.tryParseSceneCommandPayload(parsedCommandPayload.params);
			const commandArgs = args !== undefined ? args : parsedCommandPayload.params;

			if (method === "do_scenes_segments") {
				const segmentPayloads = this.toSingleSceneSegmentsPayloads(commandArgs);
				if (segmentPayloads) {
					for (const segmentPayload of segmentPayloads) {
						commands.push({ duid: itemDuid, method, params: segmentPayload });
					}
					continue;
				}
			}

			if (method === "app_start_program") {
				try {
					const startArgs = await this.resolveStartProgramArgs(itemDuid, commandArgs ?? {});
					commands.push({ duid: itemDuid, method, params: startArgs });
				} catch (error: unknown) {
					this.rLog(
						"Requests",
						itemDuid,
						"Error",
						undefined,
						undefined,
						`[Scene] Failed to resolve app_start_program payload for ${sceneId}: ${this.errorMessage(error)}`,
						"error"
					);
				}
				continue;
			}

			commands.push({ duid: itemDuid, method, params: commandArgs });
		}

		return commands;
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	private async processSceneQueue(duid: string): Promise<void> {
		if (this.activeSceneQueueProcessors.has(duid)) return;
		this.activeSceneQueueProcessors.add(duid);

		try {
			while (true) {
				const queue = await this.loadSceneQueue(duid);
				if (!queue) return;

				if (queue.waitingForCompletion) {
					const previousIndex = Math.max(0, queue.nextIndex - 1);
					const previousCommand = queue.commands[Math.max(0, queue.nextIndex - 1)];
					const nextCommand = queue.commands[queue.nextIndex];
					const waitDuid = previousCommand?.duid ?? nextCommand?.duid ?? duid;
					this.rLog(
						"Requests",
						waitDuid,
						"Info",
						undefined,
						undefined,
						`[Scene] Waiting for segment completion before continuing scene ${queue.sceneId} (${queue.nextIndex}/${queue.commands.length})`,
						"info"
					);
					const waitResult = await this.waitForSceneSegmentReadyForNext(waitDuid);

					const latestQueue = await this.loadSceneQueue(duid);
					if (!latestQueue) return;
					if (latestQueue.id !== queue.id) continue;

					if (waitResult === "cancelled") {
						await this.clearSceneQueue(duid, "cancelled");
						this.rLog(
							"Requests",
							waitDuid,
							"Info",
							undefined,
							undefined,
							`[Scene] Cleared local scene ${latestQueue.sceneId} queue because the robot returned to dock`,
							"info"
						);
						return;
					}

					if (waitResult === "not-started" && previousCommand?.method === "do_scenes_segments") {
						const retryCommand = latestQueue.commands[previousIndex];
						if (retryCommand && (retryCommand.attempts ?? 0) < SCENE_SEGMENT_START_MAX_ATTEMPTS) {
							latestQueue.nextIndex = previousIndex;
							latestQueue.waitingForCompletion = false;
							latestQueue.updatedAt = Date.now();
							await this.saveSceneQueue(duid, latestQueue);
							await this.setSceneQueueStatus(duid, "retrying");
							await this.delay(SCENE_SEGMENT_RETRY_DELAY_MS);
							continue;
						}

						this.rLog(
							"Requests",
							waitDuid,
							"Error",
							undefined,
							undefined,
							`[Scene] Segment task in ${latestQueue.sceneId} did not start after ${SCENE_SEGMENT_START_MAX_ATTEMPTS} attempt(s); continuing`,
							"error"
						);
					}

					latestQueue.waitingForCompletion = false;
					latestQueue.updatedAt = Date.now();
					await this.saveSceneQueue(duid, latestQueue);
					continue;
				}

				if (queue.nextIndex >= queue.commands.length) {
					await this.clearSceneQueue(duid, "completed");
					this.rLog("Requests", duid, "Info", undefined, undefined, `[Scene] Local scene ${queue.sceneId} queue completed`, "info");
					return;
				}

				const command = queue.commands[queue.nextIndex];
				if (!command) {
					await this.clearSceneQueue(duid, "invalid");
					return;
				}

				this.rLog(
					"Requests",
					command.duid,
					"Info",
					undefined,
					undefined,
					`[Scene] Executing queued local scene command ${queue.nextIndex + 1}/${queue.commands.length}: ${command.method}`,
					"info"
				);

				command.attempts = (command.attempts ?? 0) + 1;
				queue.commands[queue.nextIndex] = command;
				queue.updatedAt = Date.now();
				await this.saveSceneQueue(duid, queue);

				let commandSucceeded = false;
				try {
					await this.executeSceneCommand(command.duid, command.method, command.params);
					commandSucceeded = true;
				} catch (error: unknown) {
					this.logSceneQueueCommandError(queue, command, error);
				}

				const latestQueue = await this.loadSceneQueue(duid);
				if (!latestQueue) return;
				if (latestQueue.id !== queue.id) continue;

				latestQueue.nextIndex = queue.nextIndex + 1;
				latestQueue.waitingForCompletion = commandSucceeded && command.method === "do_scenes_segments";
				latestQueue.updatedAt = Date.now();

				if (latestQueue.nextIndex >= latestQueue.commands.length && !latestQueue.waitingForCompletion) {
					const completedStatus = command.method === "app_start_program" ? "program-started" : "completed";
					await this.clearSceneQueue(duid, completedStatus);
					this.rLog("Requests", duid, "Info", undefined, undefined, `[Scene] Local scene ${latestQueue.sceneId} queue completed`, "info");
					return;
				}

				await this.saveSceneQueue(duid, latestQueue);
			}
		} catch (error: unknown) {
			await this.setSceneQueueStatus(duid, "error");
			this.rLog("Requests", duid, "Error", undefined, undefined, `[Scene] Local scene queue failed: ${this.errorMessage(error)}`, "error");
		} finally {
			this.activeSceneQueueProcessors.delete(duid);
		}
	}

	private logSceneQueueCommandError(queue: PersistedSceneQueue, command: SceneQueueCommand, error: unknown): void {
		const level = command.method === "do_scenes_segments" || command.method === "app_start_program" ? "Error" : "Warn";
		this.rLog(
			"Requests",
			command.duid,
			level,
			undefined,
			undefined,
			`[Scene] Failed to execute queued command ${command.method} in ${queue.sceneId}: ${this.errorMessage(error)}`,
			level === "Error" ? "error" : "warn"
		);
	}

	private getSceneQueueStateId(duid: string): string {
		return `Devices.${duid}.programs.sceneQueue`;
	}

	private getSceneQueueLengthStateId(duid: string): string {
		return `Devices.${duid}.programs.sceneQueueLength`;
	}

	private getSceneQueueStatusStateId(duid: string): string {
		return `Devices.${duid}.programs.sceneQueueStatus`;
	}

	private getSceneQueueModeStateId(duid: string): string {
		return `Devices.${duid}.programs.sceneExecutionMode`;
	}

	private async ensureSceneQueueState(duid: string): Promise<void> {
		if (this.ensuredSceneQueueStates.has(duid)) return;
		await this.ensureFolder(`Devices.${duid}.programs`);
		await this.ensureState(this.getSceneQueueStateId(duid), {
			name: "Local scene queue",
			type: "string",
			role: "json",
			read: true,
			write: false,
		});
		await this.ensureState(this.getSceneQueueLengthStateId(duid), {
			name: "Local scene queue length",
			type: "number",
			role: "value",
			read: true,
			write: false,
			def: 0,
		});
		await this.ensureState(this.getSceneQueueStatusStateId(duid), {
			name: "Scene queue status",
			type: "string",
			role: "text",
			read: true,
			write: false,
			def: "idle",
		});
		await this.ensureState(this.getSceneQueueModeStateId(duid), {
			name: "Scene execution mode",
			type: "string",
			role: "text",
			read: true,
			write: false,
			states: {
				local: "local",
				cloud: "cloud",
			},
			def: "local",
		});
		this.ensuredSceneQueueStates.add(duid);
	}

	private async saveSceneQueue(duid: string, queue: PersistedSceneQueue): Promise<void> {
		await this.ensureSceneQueueState(duid);
		await this.setState(this.getSceneQueueStateId(duid), { val: JSON.stringify(queue), ack: true });
		await this.setSceneQueueSummaryStates(duid, queue, queue.waitingForCompletion ? "waiting" : "running");
	}

	private async clearSceneQueue(duid: string, status = "idle"): Promise<void> {
		await this.ensureSceneQueueState(duid);
		await this.setState(this.getSceneQueueStateId(duid), { val: "", ack: true });
		await this.setSceneQueueSummaryStates(duid, null, status);
	}

	private shouldClearSceneQueueForCommand(command: string, value: unknown): boolean {
		return (command === "app_stop" || command === "app_charge") && this.isTruthy(value);
	}

	private async clearSceneQueueForManualCancel(duid: string, command: string): Promise<void> {
		const queue = await this.loadSceneQueue(duid);
		if (!queue) return;
		await this.clearSceneQueue(duid, "cancelled");
		this.rLog("Requests", duid, "Info", undefined, undefined, `[Scene] Cleared local scene ${queue.sceneId} queue because ${command} was requested`, "info");
	}

	private async setSceneQueueStatus(duid: string, status: string): Promise<void> {
		await this.ensureSceneQueueState(duid);
		await this.setSceneQueueSummaryStates(duid, await this.loadSceneQueue(duid), status);
	}

	private async setSceneQueueSummaryStates(duid: string, queue: PersistedSceneQueue | null, status: string): Promise<void> {
		const length = queue ? Math.max(0, queue.commands.length - queue.nextIndex) : 0;
		await Promise.all([
			this.setState(this.getSceneQueueLengthStateId(duid), { val: length, ack: true }),
			this.setState(this.getSceneQueueStatusStateId(duid), { val: status, ack: true }),
			this.setState(this.getSceneQueueModeStateId(duid), { val: this.getSceneExecutionMode(), ack: true }),
		]);
	}

	private async loadSceneQueue(duid: string): Promise<PersistedSceneQueue | null> {
		let state: ioBroker.State | null | undefined;
		try {
			state = await this.getStateAsync(this.getSceneQueueStateId(duid));
		} catch {
			return null;
		}

		if (typeof state?.val !== "string" || state.val.trim() === "") {
			return null;
		}

		try {
			return this.parseSceneQueueState(state.val);
		} catch (error: unknown) {
			this.rLog("Requests", duid, "Warn", undefined, undefined, `[Scene] Ignoring invalid persisted scene queue: ${this.errorMessage(error)}`, "warn");
			await this.clearSceneQueue(duid);
			return null;
		}
	}

	private parseSceneQueueState(value: string): PersistedSceneQueue {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("queue state is not an object");
		}
		if (parsed.version !== SCENE_QUEUE_VERSION) {
			throw new Error(`unsupported queue version ${String(parsed.version)}`);
		}
		if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
			throw new Error("queue has no commands");
		}

		const commands = parsed.commands.map((command) => this.parseSceneQueueCommand(command));
		const nextIndex = typeof parsed.nextIndex === "number" && Number.isInteger(parsed.nextIndex)
			? Math.max(0, Math.min(parsed.nextIndex, commands.length))
			: 0;
		const now = Date.now();

		return {
			version: SCENE_QUEUE_VERSION,
			id: typeof parsed.id === "string" && parsed.id.trim() !== "" ? parsed.id : `${now}-${randomBytes(4).toString("hex")}`,
			sceneId: typeof parsed.sceneId === "string" && parsed.sceneId.trim() !== "" ? parsed.sceneId : "unknown",
			sceneName: typeof parsed.sceneName === "string" ? parsed.sceneName : undefined,
			commands,
			nextIndex,
			waitingForCompletion: parsed.waitingForCompletion === true,
			createdAt: typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : now,
			updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : now,
		};
	}

	private parseSceneQueueCommand(value: unknown): SceneQueueCommand {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("queue command is not an object");
		}

		const command = value as Record<string, unknown>;
		if (typeof command.duid !== "string" || command.duid.trim() === "") {
			throw new Error("queue command has no duid");
		}
		if (typeof command.method !== "string" || command.method.trim() === "") {
			throw new Error("queue command has no method");
		}

		return {
			duid: command.duid,
			method: command.method,
			params: command.params,
			waitForCompletionAfter: command.waitForCompletionAfter === true,
			attempts: typeof command.attempts === "number" && Number.isInteger(command.attempts) && command.attempts > 0 ? command.attempts : undefined,
		};
	}

	private async resumeSceneQueues(): Promise<void> {
		const duids = new Set<string>();
		for (const device of this.http_api.getDevices() || []) {
			if (typeof device.duid === "string" && device.duid.trim() !== "") {
				duids.add(device.duid);
			}
		}

		const mode = this.getSceneExecutionMode();
		for (const duid of duids) {
			await this.ensureSceneQueueState(duid);
			if (mode === "cloud") {
				await this.clearSceneQueue(duid, "cloud-idle");
				continue;
			}

			const queue = await this.loadSceneQueue(duid);
			if (!queue) continue;

			const status = await this.refreshSceneSegmentStatus(duid);
			if (!this.isSceneSegmentActiveStatus(status)) {
				await this.clearSceneQueue(duid, "cancelled");
				this.rLog(
					"Requests",
					duid,
					"Info",
					undefined,
					undefined,
					`[Scene] Cleared local scene ${queue.sceneId} queue on adapter start because the robot is idle`,
					"info"
				);
				continue;
			}

			this.rLog(
				"Requests",
				duid,
				"Info",
				undefined,
				undefined,
				`[Scene] Resuming local scene ${queue.sceneId} at command ${queue.nextIndex + 1}/${queue.commands.length}`,
				"info"
			);
			void this.processSceneQueue(duid);
		}
	}

	private resolveSceneTargetDuid(defaultDuid: string, actionItems: unknown[]): string {
		for (const item of actionItems) {
			const sceneItem = item as Record<string, unknown>;
			const entityId = typeof sceneItem?.entityId === "string" && sceneItem.entityId.trim().length > 0 ? sceneItem.entityId : null;
			if (entityId) return entityId;
		}
		return defaultDuid;
	}
	private toSingleSceneSegmentsPayloads(value: unknown): Record<string, unknown>[] | null {
		const parsed = this.tryParseSceneCommandPayload(value);
		const payload = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
		if (!this.isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
			return null;
		}

		return payload.data.map((entry) => ({
			...payload,
			data: [entry],
		}));
	}

	private async waitForSceneSegmentReadyForNext(duid: string): Promise<SceneSegmentWaitResult> {
		const startResult = await this.waitForSceneSegmentStarted(duid, SCENE_SEGMENT_START_TIMEOUT_MS);
		if (startResult === "cancelled") {
			this.rLog(
				"Requests",
				duid,
				"Info",
				undefined,
				undefined,
				"[Scene] Segment task was cancelled by return to dock",
				"info"
			);
			return "cancelled";
		}
		if (startResult === "not-started") {
			this.rLog(
				"Requests",
				duid,
				"Warn",
				undefined,
				undefined,
				"[Scene] Segment task did not report a room-cleaning start before timeout",
				"warn"
			);
			return "not-started";
		}

		const finishResult = await this.waitForSceneSegmentInactiveStable(duid, SCENE_SEGMENT_FINISH_TIMEOUT_MS, SCENE_SEGMENT_READY_STABLE_MS);
		if (finishResult === "cancelled") {
			this.rLog(
				"Requests",
				duid,
				"Info",
				undefined,
				undefined,
				"[Scene] Segment task was cancelled by return to dock",
				"info"
			);
			return "cancelled";
		}
		if (finishResult === "timeout") {
			this.rLog(
				"Requests",
				duid,
				"Warn",
				undefined,
				undefined,
				"[Scene] Segment task did not reach stable idle before timeout; continuing with next scene task",
				"warn"
			);
			return "finish-timeout";
		}

		return "ready";
	}
	private async waitForSceneSegmentStarted(duid: string, timeoutMs: number): Promise<SceneSegmentStartResult> {
		let deadline = Date.now() + timeoutMs;
		const hardDeadline = Date.now() + SCENE_SEGMENT_FINISH_TIMEOUT_MS;
		let idleSince: number | null = null;
		let sawPaused = false;
		let sawReturnToDock = false;
		let sawDockServiceAfterReturn = false;

		do {
			const status = await this.refreshSceneSegmentStatus(duid);
			if (this.isSceneSegmentStartedStatus(status)) {
				return "started";
			}

			const now = Date.now();
			if (this.isSceneSegmentPausedStatus(status)) {
				sawPaused = true;
			}
			if (this.isSceneSegmentReturnToDockStatus(status)) {
				sawReturnToDock = true;
			}
			if (sawReturnToDock && this.isSceneSegmentDockServiceStatus(status)) {
				sawDockServiceAfterReturn = true;
			}

			if (this.isSceneSegmentActiveStatus(status)) {
				deadline = now + timeoutMs;
				idleSince = null;
			} else {
				idleSince ??= now;
				if (sawReturnToDock && (sawPaused || !sawDockServiceAfterReturn)) {
					if (now - idleSince >= SCENE_SEGMENT_DOCK_CANCEL_STABLE_MS) {
						return "cancelled";
					}
				} else if (now >= deadline) {
					return "not-started";
				}
			}

			await this.delay(SCENE_SEGMENT_POLL_INTERVAL_MS);
		} while (Date.now() < hardDeadline);
		return "not-started";
	}
	private async waitForSceneSegmentInactiveStable(duid: string, timeoutMs: number, stableMs: number): Promise<SceneSegmentInactiveResult> {
		const deadline = Date.now() + timeoutMs;
		let idleSince: number | null = null;
		let sawPaused = false;
		let sawReturnToDock = false;
		let sawDockServiceAfterReturn = false;

		do {
			const status = await this.refreshSceneSegmentStatus(duid);
			const now = Date.now();
			if (this.isSceneSegmentPausedStatus(status)) {
				sawPaused = true;
			}
			if (this.isSceneSegmentReturnToDockStatus(status)) {
				sawReturnToDock = true;
			}
			if (sawReturnToDock && this.isSceneSegmentDockServiceStatus(status)) {
				sawDockServiceAfterReturn = true;
			}

			if (!this.isSceneSegmentActiveStatus(status)) {
				idleSince ??= now;
				const idleFor = now - idleSince;
				if (sawReturnToDock && (sawPaused || !sawDockServiceAfterReturn)) {
					if (idleFor >= SCENE_SEGMENT_DOCK_CANCEL_STABLE_MS) {
						return "cancelled";
					}
				} else if (idleFor >= stableMs) {
					return "ready";
				}
			} else {
				idleSince = null;
			}
			await this.delay(SCENE_SEGMENT_POLL_INTERVAL_MS);
		} while (Date.now() < deadline);
		return "timeout";
	}
	private async refreshSceneSegmentStatus(duid: string): Promise<Record<string, unknown>> {
		const handler = this.deviceFeatureHandlers.get(duid);
		if (handler) {
			try {
				await handler.updateStatus();
			} catch (error: unknown) {
				this.rLog(
					"Requests",
					duid,
					"Warn",
					handler.protocolVersion || undefined,
					undefined,
					`[Scene] Failed to update status while sequencing scene tasks: ${this.errorMessage(error)}`,
					"warn"
				);
			}
		}

		const status: Record<string, unknown> = {};
		const deviceStatusKeys = [
			"state",
			"status",
			"in_cleaning",
			"in_returning",
			"isWashing",
			"dockCanStopWash",
			"isInBackDockTask",
			"wash_phase",
			"wash_status",
			"washingTaskStatus",
			"dust_collection_status",
		];
		const dockingStationStatusKeys = [
			"washingTaskStatus",
		];

		await Promise.all(deviceStatusKeys.map(async (key) => {
			try {
				const state = await this.getStateAsync(`Devices.${duid}.deviceStatus.${key}`);
				if (state?.val !== null && state?.val !== undefined) {
					status[key] = state.val;
				}
			} catch {
				// Some protocols expose only a subset of these states.
			}
		}));
		await Promise.all(dockingStationStatusKeys.map(async (key) => {
			try {
				const state = await this.getStateAsync(`Devices.${duid}.dockingStationStatus.${key}`);
				if (state?.val !== null && state?.val !== undefined) {
					status[`dockingStationStatus.${key}`] = state.val;
				}
			} catch {
				// Some devices do not expose station detail states.
			}
		}));
		return status;
	}

	private isSceneSegmentPausedStatus(status: Record<string, unknown>): boolean {
		const state = this.numberFromStateValue(status.state ?? status.status);
		return state === 10;
	}
	private isSceneSegmentReturnToDockStatus(status: Record<string, unknown>): boolean {
		const inReturning = this.numberFromStateValue(status.in_returning);
		if (inReturning !== null && inReturning > 0) {
			return true;
		}

		const state = this.numberFromStateValue(status.state ?? status.status);
		return state !== null && SCENE_SEGMENT_RETURN_TO_DOCK_STATES.has(state);
	}

	private isSceneSegmentDockServiceStatus(status: Record<string, unknown>): boolean {
		if (this.booleanFromStateValue(status.isWashing) || this.booleanFromStateValue(status.dockCanStopWash)) {
			return true;
		}

		const rawWashStatus = this.numberFromStateValue(status.wash_status);
		if (rawWashStatus !== null && this.isActiveWashingTaskStatus(rawWashStatus & 0xff)) {
			return true;
		}

		const deviceWashingTaskStatus = this.numberFromStateValue(status.washingTaskStatus);
		if (deviceWashingTaskStatus !== null && this.isActiveWashingTaskStatus(deviceWashingTaskStatus)) {
			return true;
		}

		const dockWashingTaskStatus = this.numberFromStateValue(status["dockingStationStatus.washingTaskStatus"]);
		if (dockWashingTaskStatus !== null && this.isActiveWashingTaskStatus(dockWashingTaskStatus)) {
			return true;
		}

		const washPhase = this.numberFromStateValue(status.wash_phase);
		if (washPhase !== null && washPhase !== 0 && washPhase !== 17) {
			return true;
		}

		const dustCollectionStatus = this.numberFromStateValue(status.dust_collection_status);
		if (dustCollectionStatus !== null && dustCollectionStatus > 0) {
			return true;
		}

		const state = this.numberFromStateValue(status.state ?? status.status);
		return state !== null && SCENE_SEGMENT_DOCK_SERVICE_STATES.has(state);
	}
	private isSceneSegmentActiveStatus(status: Record<string, unknown>): boolean {
		const inCleaning = this.numberFromStateValue(status.in_cleaning);
		const inReturning = this.numberFromStateValue(status.in_returning);
		if ((inCleaning !== null && inCleaning > 0) || (inReturning !== null && inReturning > 0)) {
			return true;
		}

		if (
			this.booleanFromStateValue(status.isWashing)
			|| this.booleanFromStateValue(status.dockCanStopWash)
			|| this.booleanFromStateValue(status.isInBackDockTask)
		) {
			return true;
		}

		const rawWashStatus = this.numberFromStateValue(status.wash_status);
		if (rawWashStatus !== null && this.isActiveWashingTaskStatus(rawWashStatus & 0xff)) {
			return true;
		}

		const deviceWashingTaskStatus = this.numberFromStateValue(status.washingTaskStatus);
		if (deviceWashingTaskStatus !== null && this.isActiveWashingTaskStatus(deviceWashingTaskStatus)) {
			return true;
		}

		const dockWashingTaskStatus = this.numberFromStateValue(status["dockingStationStatus.washingTaskStatus"]);
		if (dockWashingTaskStatus !== null && this.isActiveWashingTaskStatus(dockWashingTaskStatus)) {
			return true;
		}

		const washPhase = this.numberFromStateValue(status.wash_phase);
		if (washPhase !== null && washPhase !== 0 && washPhase !== 17) {
			return true;
		}

		const state = this.numberFromStateValue(status.state ?? status.status);
		return state !== null && SCENE_SEGMENT_ACTIVE_STATES.has(state);
	}

	private isSceneSegmentStartedStatus(status: Record<string, unknown>): boolean {
		const state = this.numberFromStateValue(status.state ?? status.status);
		if (state !== null) {
			return SCENE_SEGMENT_STARTED_STATES.has(state);
		}

		const inCleaning = this.numberFromStateValue(status.in_cleaning);
		return inCleaning !== null && inCleaning > 0;
	}

	private isActiveWashingTaskStatus(status: number): boolean {
		return Number.isFinite(status) && status > 0 && status !== 4;
	}

	private booleanFromStateValue(value: unknown): boolean {
		if (typeof value === "boolean") {
			return value;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			return value !== 0;
		}
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			return normalized === "true" || normalized === "1";
		}
		return false;
	}

	private numberFromStateValue(value: unknown): number | null {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	private async executeSceneCommand(duid: string, method: string, args: unknown): Promise<void> {
		const handler = this.deviceFeatureHandlers.get(duid);
		if (handler) {
			await this.requestsHandler.command(handler, duid, method, this.tryParseSceneCommandPayload(args) ?? args);
		} else {
			await this.requestsHandler.sendRequest(duid, method, this.tryParseSceneCommandPayload(args) ?? args);
		}
	}

	private tryParseSceneCommandPayload(value: unknown): unknown | undefined {
		if (typeof value === "string") {
			const parsed = this.tryParseJson(value);
			return parsed !== undefined ? parsed : value;
		}
		return value as unknown;
	}
	private async resolveStartProgramArgs(duid: string, value: unknown): Promise<Record<string, unknown>> {
		const parsed = this.resolveProgramArgPayload(this.tryParseSceneCommandPayload(value) ?? value);
		const cmdIds = this.collectNonEmptyArray(parsed, "cmd_ids");
		if (cmdIds.length > 0) {
			return { cmd_ids: cmdIds };
		}

		const programId = this.resolveProgramId(parsed);
		if (programId != null) {
			return this.resolveStartProgramFromProgramId(duid, programId);
		}

		throw new Error("app_start_program payload has no program_id/cmd_ids");
	}

	private resolveProgramArgPayload(value: unknown): Record<string, unknown> {
		if (Array.isArray(value)) {
			if (value.length === 1) {
				const entry = value[0];
				if (
					typeof entry === "number"
					|| typeof entry === "string"
					|| (
						this.isRecord(entry)
						&& ("program_id" in entry || "programId" in entry || "cmd_ids" in entry)
					)
				) {
					return this.resolveProgramArgPayload(entry);
				}
			}

			if (value.length > 0) {
				return { cmd_ids: value };
			}

			return {};
		}

		if (typeof value === "number") {
			return { program_id: value };
		}

		if (typeof value === "string") {
			const parsed = this.tryParseJson(value);
			if (parsed !== undefined) {
				const normalized = this.resolveProgramArgPayload(parsed);
				if (this.isRecord(normalized)) {
					return normalized;
				}
			}

			if (value.trim() !== "" && Number.isFinite(Number(value))) {
				return { program_id: Number(value) };
			}
		}

		if (this.isRecord(value)) {
			return value;
		}

		return {};
	}

	private resolveProgramId(payload: Record<string, unknown>): number | null {
		if (typeof payload.program_id === "number" && Number.isFinite(payload.program_id)) {
			return payload.program_id;
		}

		if (typeof payload.programId === "number" && Number.isFinite(payload.programId)) {
			return payload.programId;
		}

		if (typeof payload.programId === "string" && payload.programId.trim() !== "" && Number.isFinite(Number(payload.programId))) {
			return Number(payload.programId);
		}

		if (typeof payload.program_id === "string" && payload.program_id.trim() !== "" && Number.isFinite(Number(payload.program_id))) {
			return Number(payload.program_id);
		}

		return null;
	}

	private collectNonEmptyArray(payload: Record<string, unknown>, key: string): unknown[] {
		const rawValue = payload[key];
		if (!rawValue) return [];

		if (Array.isArray(rawValue)) {
			return rawValue.length > 0 ? rawValue : [];
		}

		if (typeof rawValue === "string") {
			const parsed = this.tryParseJson(rawValue);
			if (Array.isArray(parsed) && parsed.length > 0) return parsed;
			if (rawValue.trim() !== "" && Number.isFinite(Number(rawValue))) return [Number(rawValue)];
		}

		if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
			return [rawValue];
		}

		return [];
	}

	private async resolveStartProgramFromProgramId(duid: string, programId: number): Promise<Record<string, unknown>> {
		const response = await this.requestsHandler.sendRequest(duid, "app_get_program", { program_id: programId });
		const normalized = this.unwrapSingleItemArrays(this.normalizeSceneRpcPayload(response));
		if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
			throw new Error(`app_get_program returned no usable payload for program_id ${programId}`);
		}

		const cmdIds = this.collectNonEmptyArray(normalized as Record<string, unknown>, "cmd_ids");
		if (cmdIds.length === 0) {
			throw new Error(`app_get_program returned no cmd_ids for program_id ${programId}`);
		}

		return { cmd_ids: cmdIds };
	}

	private normalizeSceneRpcPayload(value: unknown): unknown {
		let current = value;
		while (typeof current === "object" && current !== null && !Array.isArray(current) && "version" in current && "data" in current) {
			current = (current as { data?: unknown }).data;
		}

		if (typeof current === "object" && current !== null && !Array.isArray(current) && "result" in current) {
			current = (current as { result?: unknown }).result;
		}
		return current;
	}

	private unwrapSingleItemArrays(value: unknown): unknown {
		let current = value;
		while (Array.isArray(current) && current.length === 1) {
			current = current[0];
		}
		return current;
	}

	/** Legacy request-based keepalive. TCP socket sessions now use localApi PINGREQ frames. */
	sendTcpKeepalive(duid: string): void {
		this.requestsHandler.sendRequest(duid, "get_prop", ["get_status"], { priority: RequestPriority.LOW }).catch(() => {});
	}

	/**
	 * Is called when adapter shuts down.
	 */
	onUnload(callback: () => void) {
		try {
			// Nothing is reported about a command any more once the adapter is on its way out: a
			// request cancelled by the shutdown says nothing about the robot, and the states are
			// being torn down anyway.
			this.shuttingDown = true;

			// Before anything is torn down: a robot that is being driven by hand must not be left in
			// that mode. The calls cannot be awaited here - js-controller wants the callback now - so
			// this is one of four defences, not the only one. See `features/vacuum/remoteControl.ts`.
			for (const handler of this.deviceFeatureHandlers.values()) {
				try {
					handler.shutdownRemoteControl();
				} catch (e: unknown) {
					this.rLog("System", null, "Warn", undefined, undefined, `Failed to end a remote control session: ${this.errorMessage(e)}`, "warn");
				}
			}

			if (this.mqttReconnectInterval) {
				this.clearInterval(this.mqttReconnectInterval);
			}
			this.clearTimersAndIntervals();
			this.connectionStatus.stop();
			this.mqtt_api.cleanup();
			this.local_api.stopUdpDiscovery();
			this.local_api.stopTcpKeepaliveInterval();

			// Remove the global process exit listener to prevent memory leaks
			if (this.onExitBound) {
				process.removeListener("exit", this.onExitBound);
				this.onExitBound = null;
			}

			if (this.go2rtcProcess) {
				this.rLog("Local", null, "Info", undefined, undefined, "Stopping go2rtc process...", "info");
				this.go2rtcProcess.kill();
				this.go2rtcProcess = null;
			}
			this.setState("info.connection", { val: false, ack: true });
			callback();
		} catch (e: unknown) {
			this.rLog("System", null, "Error", undefined, undefined, `Failed to unload adapter: ${this.errorStack(e)}`, "error");
			callback();
		}
	}

	/**
	 * Every state pattern the adapter subscribes to.
	 *
	 * The per device command folders are only known once the feature handlers exist, the rest is
	 * static ({@link STATIC_SUBSCRIPTION_PATTERNS}). Kept as its own method so the coverage of all
	 * writable states can be asserted without booting the adapter.
	 * @param commandFolders Command folders reported by the feature handlers.
	 */
	public getSubscriptionPatterns(commandFolders: Iterable<string>): string[] {
		const folderPatterns = [...new Set(commandFolders)].map((folder) => `Devices.*.${folder}.*`);
		return [...folderPatterns, ...STATIC_SUBSCRIPTION_PATTERNS];
	}

	/**
	 * Is called if a subscribed state changes.
	 */
	async onStateChange(id: string, state: ioBroker.State | null | undefined) {
		if (!state) return;

		const idParts = id.split(".");

		// deviceStatus.state (V1) or deviceStatus.status (B01): react only to our own updates (ack) — active -> idle triggers cleaning records update
		if (state.ack && idParts[2] === "Devices" && idParts.length >= 6 && idParts[4] === "deviceStatus" && (idParts[5] === "state" || idParts[5] === "status")) {
			const duid = idParts[3];
			const newVal = state.val != null ? Number(state.val) : 0;
			if (!isNaN(newVal)) {
				this.deviceManager.onDeviceStateChange(duid, newVal).catch((e: unknown) => this.catchError(e, "onStateChange(deviceStatus)", duid));
			}
			return;
		}

		if (state.ack) {
			if (id.endsWith(".online") && idParts.length >= 4) {
				this.rLog("System", idParts[3], "Info", undefined, undefined, `Device is now ${state.val ? "online" : "offline"}`, "info");
			}
			return;
		}

		// An unacknowledged write that already carries a quality is this adapter noting down that a
		// command failed (see `markCommandOutcome`), not somebody asking for it again. Without this
		// the note would be read back as a new command and sent forever.
		//
		// Nothing genuine can be caught here: the states database resets `q` to 0 on every write that
		// does not name one (`@iobroker/db-states-redis/.../statesInRedisClient.js:513-517`), so a
		// command from a script, from vis or from the object view always arrives with `q = 0`.
		if (state.q) return;

		// Check for root loginCode (roborock.0.loginCode)
		if (idParts[2] === "loginCode" && state.val && String(state.val).length === 6) {
			this.http_api.submitLoginCode(String(state.val));
			return;
		}

		// Root mapTheme: normally written by the admin tab through the `set_map_theme` message,
		// but writable by hand as well so a script or a vis can steer the map without a browser.
		if (idParts[2] === Roborock.MAP_THEME_STATE) {
			if (isReportableMapTheme(state.val)) {
				await this.setReportedMapTheme(state.val);
			} else {
				this.rLog("System", null, "Warn", undefined, undefined, `Ignoring write to ${Roborock.MAP_THEME_STATE}: '${String(state.val)}' is neither 'light' nor 'dark'.`, "warn");
			}
			return;
		}

		// Devices logic
		if (idParts[2] !== "Devices") return;
		if (idParts.length < 6) return;

		const duid = idParts[3];
		const folder = idParts[4];
		const command = idParts[5];

		// Special handling for floors (deeply nested: Devices.duid.floors.<mapFlag>.<target>)
		if (folder === "floors" && idParts.length >= 7) {
			const mapFlag = Number(idParts[5]);
			const target = idParts[6];

			// Load Map Button
			if (target === "load" && Number.isInteger(mapFlag) && mapFlag >= 0 && this.isTruthy(state.val)) {
				await this.handleFloorSwitch(duid, mapFlag, id);
			}

			// Anything else below floors is a room switch or floor metadata. Room switches are read
			// on demand when a segment cleaning starts, so a write needs no request of its own -
			// but the rendered map shows the selection, so it has to be drawn again.
			if (!NON_ROOM_STATE_NAMES.has(target) && normalizeRoomId(target) !== null) {
				this.scheduleMapRepaint(duid);
			}
			return;
		}

		// Special handling for schedules (deeply nested: Devices.duid.schedules.<timerId>.enabled)
		if (folder === "schedules" && idParts.length >= 7 && idParts[6] === "enabled") {
			await this.handleScheduleToggle(duid, idParts[5], state, id);
			return;
		}

		this.rLog("Requests", duid, "Info", undefined, undefined, `[onStateChange] Processing ${folder}.${command}`, "info");

		const handler = this.deviceFeatureHandlers.get(duid);
		if (!handler) {
			this.rLog("Requests", duid, "Warn", undefined, undefined, "[onStateChange] Received command for unknown device", "warn");
			return;
		}

		try {
			await this.handleCommand(duid, folder, command, state, handler, id);
		} catch (e: unknown) {
			this.catchError(e, `onStateChange (${command})`, duid);
		}
	}

	/**
	 * Handles commands from onStateChange.
	 */
	private async handleCommand(duid: string, folder: string, command: string, state: ioBroker.State, handler: BaseDeviceFeatures, id: string) {
		if (folder === "resetConsumables" && state.val === true) {
			// The state id is passed on rather than folder plus command: the reset buttons sit one
			// level deeper than a command object, so nothing could reconstruct this path.
			await this.requestsHandler.command(handler, duid, "reset_consumable", command, id, { stateId: id, folder });
			// Reset button
			this.setResetTimeout(id);
		} else if (folder === "programs" && command === "startProgram") {
			await this.executeSceneProgram(duid, state.val as string | number);
			// Scene execution can continue asynchronously in local queue mode.
			await this.setState(id, { val: null, ack: true });
		} else if (handler.hasCommandFolder(folder)) {
			const cmdDef: CommandSpec | undefined = handler.getCommandSpec(folder, command);
			if (!cmdDef) {
				this.rLog("Requests", duid, "Warn", handler.protocolVersion || undefined, undefined, `[handleCommand] Ignoring unregistered command ${folder}.${command}`, "warn");
				return;
			}

			this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[handleCommand] Entering commands block for ${command}`, "info");
			try {
				if (this.shouldClearSceneQueueForCommand(command, state.val)) {
					await this.clearSceneQueueForManualCancel(duid, command);
				}
				await this.executeCommand(handler, duid, command, state, cmdDef, { stateId: id, folder });
			} finally {
				// Reset boolean command state ONLY if it is defined as boolean - and only when it
				// really is a button. A switch has to keep the position it was put in; resetting it
				// a second later would make it snap back in every UI that shows it.
				const isBoolean = cmdDef.type === "boolean" && !Roborock.isSwitchCommand(cmdDef);

				if (isBoolean && this.isTruthy(state.val)) {
					this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[handleCommand] Scheduling reset for ${id} (boolean)`, "info");
					this.setResetTimeout(id);
				}
			}
		}
	}

	/**
	 * Executes a specific command for a device.
	 */
	/**
	 * Tells a switch from a button among the boolean commands.
	 *
	 * Both are `type: "boolean"`, and until now both were treated as buttons - which meant a switch
	 * could be turned **on** and never off: `executeCommand` dropped every falsy write, and the
	 * value was reset to `false` a second later anyway. Nineteen commands were affected
	 * (`set_child_lock_status`, `set_collision_avoid_status`, `set_flow_led_status` and the rest of
	 * the a179 set, plus `child_lock`, `carpet_turbo`, `light_mode` and `green_laser` on B01),
	 * two of them with `def: true` - a switch that starts on and cannot be switched off.
	 *
	 * The test is the declared role and nothing else. Everything the adapter means as a switch
	 * carries a role from ioBroker's `switch` family; everything else keeps exactly the behaviour it
	 * had, so a boolean without a role stays the button it always was.
	 * @param spec Command definition as the feature handler registered it.
	 */
	private static isSwitchCommand(spec: CommandSpec): boolean {
		const role = typeof spec.role === "string" ? spec.role : "";
		return role === "switch" || role.startsWith("switch.");
	}

	private async executeCommand(handler: BaseDeviceFeatures, duid: string, command: string, state: ioBroker.State, cmdDef: CommandSpec, origin?: CommandOrigin) {
		const val = state.val;

		// A switch sends both of its positions; see isSwitchCommand for what that repairs.
		if (cmdDef.type === "boolean" && Roborock.isSwitchCommand(cmdDef)) {
			this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[executeCommand] Setting switch ${command} to ${String(val)}`, "info");
			await this.requestsHandler.command(handler, duid, command, this.isTruthy(val), undefined, origin);
			return;
		}

		// 1. Common command types handling
		const isButton = cmdDef.role === "button" || cmdDef.type === "boolean";

		if (isButton) {
			if (this.isTruthy(val)) {
				this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[executeCommand] Triggering button command ${command}`, "info");
				await this.requestsHandler.command(handler, duid, command, undefined, undefined, origin);
			} else {
				this.rLog("Requests", duid, "Debug", handler.protocolVersion || undefined, undefined, `[executeCommand] Ignoring button command ${command} (val=${val})`, "debug");
			}
			return;
		}

		// Log start of command execution for diagnostics
		this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[executeCommand] Starting ${command} with params ${typeof val === "object" ? JSON.stringify(val) : val}`, "info");

		// 2. Generic data commands (Numbers, Strings, JSON strings)
		// We pass the raw value. getCommandParams in feature handlers will do the packaging (e.g. [val]).
		if (typeof val === "string") {
			const parsed = this.tryParseJson(val);
			await this.requestsHandler.command(handler, duid, command, parsed !== undefined ? parsed : val, undefined, origin);
		} else {
			await this.requestsHandler.command(handler, duid, command, val, undefined, origin);
		}
	}

	private isTruthy(val: unknown): boolean {
		return val === true || val === "true" || val === 1 || val === "1";
	}

	/**
	 * Lets a button spring back a second after it was pressed, without claiming more than that.
	 *
	 * The button **has** to spring back - one that stays down is worse than one that lies - but until
	 * now it sprang back with `ack: true` and nothing else, out of a `finally` that runs whether the
	 * command worked or threw. That was the one place in the adapter that asserted a confirmation
	 * which did not exist.
	 *
	 * It now keeps whatever `markCommandOutcome` has meanwhile written onto the same state. `ack: true`
	 * stays, and rightly so: the value being acknowledged is `false`, and the button really is not
	 * pressed any more. The quality and the comment carry what became of the press.
	 *
	 * A failure that arrives later than this - a request may time out after 30 seconds - is written by
	 * `markCommandOutcome` afterwards and simply stands on its own.
	 *
	 * @param id State id of the button.
	 */
	private setResetTimeout(id: string): void {
		const timeoutKey = `${id}_reset`;
		if (this.commandTimeouts.has(timeoutKey)) {
			this.clearTimeout(this.commandTimeouts.get(timeoutKey)!);
		}
		const timeout = this.setTimeout(() => {
			this.commandTimeouts.delete(timeoutKey);
			void this.resetCommandButton(id);
		}, 1000);
		if (timeout) this.commandTimeouts.set(timeoutKey, timeout);
	}

	/**
	 * Writes a button back to `false`, carrying any failure mark along.
	 * @param id State id of the button.
	 */
	private async resetCommandButton(id: string): Promise<void> {
		try {
			this.rLog("Requests", null, "Debug", undefined, undefined, `[setResetTimeout] Resetting ${id} to false`, "debug");

			// Read rather than remember: the mark may have been written by any of the four points the
			// funnel reports from, on a different turn of the event loop.
			const current = await this.getStateAsync(id);
			if (current?.q) {
				await this.setState(id, { val: false, ack: true, q: current.q, c: typeof current.c === "string" ? current.c : "" });
				return;
			}

			await this.setState(id, { val: false, ack: true });
		} catch (error: unknown) {
			this.catchError(error, "resetCommandButton");
		}
	}

	/**
	 * Writes down on the command state itself what became of the command.
	 *
	 * This is the one place the admin tab, a script and the object tree learn that a command did not
	 * do what it looked like it did. It never throws: a command must not fail because its outcome
	 * could not be noted, and it must not fail twice over.
	 *
	 * Both directions are written on purpose. A failure leaves a quality and a reason; a success
	 * **clears** them again, and that has to be said explicitly, because the usual way a command state
	 * is brought up to date is `setStateChanged` from `processStatus` - which writes nothing at all
	 * when the value did not change, and would leave yesterday's failure standing for ever.
	 *
	 * @param duid   Device the command was sent to.
	 * @param report What is known about the command; see `commandFeedback.ts`.
	 */
	public async markCommandOutcome(duid: string, report: CommandOutcomeReport): Promise<void> {
		try {
			// Nothing is noted once the adapter is on its way out: a request cancelled by the shutdown
			// says nothing about the robot, and the states are being torn down anyway.
			if (this.shuttingDown) return;

			const stateId = this.commandStateId(duid, report);
			if (!stateId) return;

			const current = await this.getStateAsync(stateId);
			// No state, nothing to mark. This is the normal case for a command that has no state of its
			// own, and writing one here would create an object nobody declared.
			if (!current) return;

			if (!isProblemOutcome(report.outcome)) {
				// Nothing to clear is the common case, and reading is cheaper than writing.
				if (!current.q) return;
				await this.setState(stateId, { val: current.val, ack: current.ack, q: 0x00, c: "" });
				return;
			}

			// Neither the value nor `ack` is touched - the mark only adds why. That keeps both readings
			// honest at once: a command still waiting stays unacknowledged, which is exactly what
			// "somebody wanted this and it did not happen" means; a button that has meanwhile sprung
			// back to `false` keeps its `ack: true`, because `false` really is where it stands.
			// Claiming `ack: true` for a value the robot never took would be the very lie this change
			// removes. See `commandFeedback.ts` for the guard in `onStateChange` that keeps this write
			// from being read back as a new command.
			await this.setState(stateId, {
				val: current.val,
				ack: current.ack,
				q: OUTCOME_QUALITY[report.outcome],
				c: buildCommandComment(report.outcome, outcomeArgs(report))
			});
		} catch (error: unknown) {
			this.rLog("Requests", duid, "Debug", undefined, undefined, `[commandOutcome] Could not mark ${report.command}: ${this.errorMessage(error)}`, "debug");
		}
	}

	/**
	 * Finds the state a command outcome belongs on.
	 *
	 * A command that arrived through `onStateChange` brings its own state id, which is the only thing
	 * that works for the two nested cases (`floors.<mapFlag>.load`, `resetConsumables.<part>`).
	 * A command sent straight down a socket message never touched a state, so its command object is
	 * looked up in the folder that declares it - `app_goto_target`, `app_zoned_clean` and
	 * `app_segment_clean` all have one, they are simply not what the tab writes to.
	 *
	 * @param duid   Device id.
	 * @param report The report.
	 * @returns The state id relative to the namespace, or null when the command has no state.
	 */
	private commandStateId(duid: string, report: CommandOutcomeReport): string | null {
		if (report.stateId) return report.stateId;

		const handler = this.deviceFeatureHandlers.get(duid);
		if (!handler) return null;

		if (report.folder && handler.getCommandSpec(report.folder, report.command)) {
			return `Devices.${duid}.${report.folder}.${report.command}`;
		}

		for (const folder of handler.getCommandFolders()) {
			if (handler.getCommandSpec(folder, report.command)) return `Devices.${duid}.${folder}.${report.command}`;
		}
		return null;
	}

	/** How long room switch writes are collected before the map is drawn again. */
	private static readonly MAP_REPAINT_DEBOUNCE_MS = 400;

	/**
	 * Draws the stored map of one device again, once the user has stopped clicking.
	 *
	 * Picking rooms means a burst of single writes - one per room, plus one per room again when the
	 * selection is cleared, and the tab sends the whole set on every click, which turns one tap into
	 * two writes. Each of them changes the picture, but only the last one is worth drawing: the
	 * canvas pass is the part of the map pipeline the adapter already warns about when it exceeds a
	 * second. So this is not a delay that can be dropped - four rooms tapped in a row give one
	 * redraw, not four, and `floor_switch_button.test.ts` pins that. The timeout lives in the same
	 * map every other adapter timeout does, so `onUnload` clears it with the rest.
	 * @param duid Device Unique ID.
	 */
	private scheduleMapRepaint(duid: string): void {
		const timeoutKey = `${duid}_map_repaint`;
		if (this.commandTimeouts.has(timeoutKey)) {
			this.clearTimeout(this.commandTimeouts.get(timeoutKey)!);
		}
		const timeout = this.setTimeout(() => {
			this.commandTimeouts.delete(timeoutKey);
			this.mapManager
				.repaintStoredMap(duid)
				.catch((e: unknown) => this.catchError(e, "scheduleMapRepaint", duid));
		}, Roborock.MAP_REPAINT_DEBOUNCE_MS);
		if (timeout) this.commandTimeouts.set(timeoutKey, timeout);
	}

	/**
	 * Ensures a ClientID exists.
	 */
	async ensureClientID(): Promise<string> {
		try {
			const clientIDState = await this.getStateAsync("clientID"); // Revert to Async
			if (clientIDState?.val) {
				this.rLog("System", null, "Info", undefined, undefined, `Loaded existing clientID: ${clientIDState.val}`, "info");
				return clientIDState.val.toString();
			}
			const randomClientID = randomBytes(16).toString("hex");
			await this.setState("clientID", { val: randomClientID, ack: true });
			this.rLog("System", null, "Info", undefined, undefined, `Generated and saved new clientID: ${randomClientID}`, "info");
			return randomClientID;
		} catch (error: unknown) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.rLog("System", null, "Error", undefined, undefined, `Error ensuring clientID: ${errorMsg}`, "error");
			throw error;
		}
	}

	/**
	 * Creates base adapter objects (Folders, States).
	 */
	async setupBasicObjects() {
		await this.setObjectNotExistsAsync("Devices", { type: "folder", common: { name: "Devices" }, native: {} });
		await this.ensureState("UserData", { name: "UserData string", write: false });
		await this.ensureState("HomeData", { name: "HomeData string", write: false });
		await this.ensureState("clientID", { name: "Client ID", write: false });
		await this.ensureState("endpoint", { name: "MQTT endpoint", write: false });
	}

	/** Obstacle assets for account models at startup (before device init). */
	private async downloadAssetsForAccountModels(): Promise<void> {
		try {
			await this.http_api.ensureProductInfo();
			let devices = this.http_api.getDevices() || [];
			for (let attempt = 0; attempt < 6 && devices.length === 0; attempt++) {
				await this.delay(500);
				devices = this.http_api.getDevices() || [];
			}
			const modelsInAccount = new Set<string>();
			for (const d of devices) {
				const m = this.http_api.getRobotModel(d.duid);
				if (m && m !== "unknown" && m.includes(".")) modelsInAccount.add(m);
			}
			if (modelsInAccount.size === 0) return;
			this.rLog("System", null, "Info", undefined, undefined, `Downloading obstacle assets for ${modelsInAccount.size} model(s)...`, "info");
			await this.http_api.downloadProductImages();
			for (const model of modelsInAccount) {
				await this.appPluginManager.downloadAssetsForModelIfMissing(model).catch((e: unknown) => {
					this.rLog("Cloud", null, "Debug", undefined, undefined, `Asset download for ${model}: ${e instanceof Error ? e.message : String(e)}`, "debug");
				});
			}
		} catch (e: unknown) {
			this.rLog("System", null, "Warn", undefined, undefined, `Obstacle asset download failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
		}
	}

	/**
	 * Processes scenes from HTTP API.
	 */
	async processScenes() {
		if (!this.http_api.hasCloudSession()) {
			this.rLog("Requests", null, "Debug", undefined, undefined, "[processScenes] Skipped: saved programs need the cloud connection.", "debug");
			return;
		}
		const scenes = await this.http_api.getScenes();
		if (!scenes?.result) return;

		const data = scenes.result;
		const programs: Record<string, Record<string, string>> = {};

		for (const program of data) {
			try {
				const { enabled, id, name, param } = program;
				const params = JSON.parse(param);
				const duid = params.action.items[0].entityId;

				if (!programs[duid]) programs[duid] = {};
				programs[duid][id] = name;

				await this.ensureFolder(`Devices.${duid}.programs`);
				await this.setObjectNotExistsAsync(`Devices.${duid}.programs.${id}`, {
					type: "folder",
					common: { name },
					native: {},
				});

				await this.ensureState(`Devices.${duid}.programs.${id}.enabled`, { name: "Enabled", type: "boolean" });
				this.setState(`Devices.${duid}.programs.${id}.enabled`, enabled, true);
			} catch (e: unknown) {
				const errorMsg = e instanceof Error ? e.message : String(e);
				this.rLog("Requests", null, "Warn", undefined, undefined, `[processScenes] Failed to process scene "${program.name}" (${program.id}): ${errorMsg}`, "warn");
			}
		}

		for (const duid in programs) {
			await this.ensureState(`Devices.${duid}.programs.startProgram`, {
				name: "Start saved program",
				type: "string",
				write: true,
				states: programs[duid],
			});
			await this.ensureSceneQueueState(duid);
		}
	}

	/**
	 * Clears all timeouts and intervals.
	 */
	clearTimersAndIntervals() {
		this.commandTimeouts.forEach((timeout) => this.clearTimeout(timeout));
		this.commandTimeouts.clear();

		this.deviceManager.stopPolling();
		// permanent=true: also stops the request-ID reset interval and latches the handler.
		this.requestsHandler.clearQueue(true);
	}

	/** Timestamp keys we format as readable date string; all other keys passed through as-is. */
	private static readonly DEVICE_INFO_DATE_KEYS = ["activeTime", "active_time", "createTime", "create_time"];
	private static readonly DEVICE_INFO_NAME_OVERRIDES: Record<string, string> = {
		activeTime: "Last Activity",
		active_time: "Last Activity",
		createTime: "Created At",
		create_time: "Created At"
	};

	/**
	 * Updates deviceInfo from cloud HomeData: all top-level device fields are written to
	 * Devices.${duid}.deviceInfo.* (names unchanged). Scalars as-is; objects/arrays as JSON string.
	 */
	async updateDeviceInfo(duid: string, devices: Device[]) {
		const device = devices.find((d) => d.duid === duid);
		if (!device) return;

		await this.removeLegacyLocalKeyState(duid);

		const raw = device as unknown as Record<string, unknown>;
		for (const attr of Object.keys(raw)) {
			// The localKey is the device secret; it must never end up in a readable state.
			if (attr === "localKey") continue;
			let value: ioBroker.StateValue = raw[attr] as ioBroker.StateValue;
			if (typeof value === "object" && value !== null) {
				value = JSON.stringify(value);
			}
			const common: Partial<ioBroker.StateCommon> = {};
			let finalValue: ioBroker.StateValue = value;
			if (Roborock.DEVICE_INFO_NAME_OVERRIDES[attr]) {
				common.name = Roborock.DEVICE_INFO_NAME_OVERRIDES[attr];
			}
			if (Roborock.DEVICE_INFO_DATE_KEYS.includes(attr) && typeof value === "number") {
				finalValue = this.formatRoborockDate(value);
				common.type = "string";
			} else {
				common.type = typeof finalValue as ioBroker.CommonType;
			}
			await this.ensureState(`Devices.${duid}.deviceInfo.${attr}`, common);
			await this.setStateChanged(`Devices.${duid}.deviceInfo.${attr}`, { val: finalValue, ack: true });
		}
	}

	/** Older adapter versions wrote the localKey into deviceInfo. Remove it once. */
	private cleanedLocalKeyStates?: Set<string>;
	private async removeLegacyLocalKeyState(duid: string): Promise<void> {
		this.cleanedLocalKeyStates ??= new Set<string>();
		if (this.cleanedLocalKeyStates.has(duid)) return;
		this.cleanedLocalKeyStates.add(duid);

		const stateId = `Devices.${duid}.deviceInfo.localKey`;
		try {
			const existing = await this.getObjectAsync(stateId);
			if (!existing) return;
			await this.delObjectAsync(stateId);
			this.rLog("System", duid, "Info", undefined, undefined, "Removed the legacy deviceInfo.localKey state; the local key is a secret and is no longer exposed as a state.", "info");
		} catch (e: unknown) {
			this.rLog("System", duid, "Debug", undefined, undefined, `Could not remove legacy localKey state: ${this.errorMessage(e)}`, "debug");
		}
	}

	/**
	 * Checks for new firmware.
	 */
	async checkForNewFirmware(duid: string) {
		const isLocal = this.local_api.isLocalDevice(duid);
		if (!isLocal) return;
		if (!this.http_api.hasCloudSession()) {
			this.rLog("HTTP", duid, "Debug", undefined, undefined, "[checkForNewFirmware] Skipped: firmware information needs the cloud connection.", "debug");
			return;
		}

		try {
			this.rLog("HTTP", duid, "Debug", undefined, undefined, "[checkForNewFirmware] Checking for firmware update...", "debug");
			const update = await this.http_api.getFirmwareStates(duid);
			this.rLog("HTTP", duid, "Debug", undefined, undefined, `[checkForNewFirmware] Result: ${JSON.stringify(update)}`, "debug");

			if (update.data.result) {
				for (const state in update.data.result) {
					const value = update.data.result[state];
					await this.ensureState(`Devices.${duid}.updateStatus.${state}`, { type: typeof value as ioBroker.CommonType });
					await this.setStateChanged(`Devices.${duid}.updateStatus.${state}`, { val: value, ack: true });
				}
			} else {
				this.rLog("HTTP", duid, "Warn", undefined, undefined, "[checkForNewFirmware] No result in firmware update response", "warn");
			}
		} catch (error: unknown) {
			this.rLog("HTTP", duid, "Warn", undefined, undefined, `Failed to check for new firmware: ${this.errorMessage(error)}`, "warn");
		}
	}

	/**
	 * Creates a state if it doesn't exist, applying translations.
	 */
	public async ensureState(path: string, commonOptions: Partial<ioBroker.StateCommon>, native: Record<string, unknown> = {}) {
		const stateName = path.split(".").pop() || path;
		// Allow empty string as name if explicitly provided. Only use fallback if name is undefined.
		const translatedName = commonOptions.name !== undefined ? commonOptions.name : (this.translations[stateName] || stateName);

		const baseCommon: ioBroker.StateCommon = {
			name: translatedName,
			type: "string",
			role: "value",
			read: true,
			write: false,
		};

		const finalCommon = { ...baseCommon, ...commonOptions, name: translatedName };
		if (finalCommon.def === undefined || finalCommon.def === null || finalCommon.def === "") {
			delete finalCommon.def;
		}

		let oldObj: ioBroker.Object | null | undefined;
		try {
			oldObj = await this.getObjectAsync(path);
		} catch {
			oldObj = null; // Does not exist
		}

		// Check if object exists AND if its metadata is different from what we need
		if (oldObj && !this.hasCommonChanged(oldObj.common as ioBroker.StateCommon, finalCommon)) {
			return;
		}

		try {
			if (oldObj) {
				// Object exists, but metadata changed
				await this.applyCommonUpdate(path, oldObj, finalCommon);
			} else {
				// Object does not exist, create it new.
				// Provide mandatory defaults for a valid ioBroker state object.
				const defaults: Partial<ioBroker.StateCommon> = {
					role: "state",
					read: true,
					write: false,
					type: "mixed"
				};
				const commonObj: ioBroker.StateCommon = { ...defaults, ...finalCommon } as ioBroker.StateCommon;

				if (!commonObj.type) commonObj.type = "mixed";

				await this.setObjectNotExistsAsync(path, {
					type: "state",
					common: commonObj,
					native: native,
				});
			}
		} catch (e: unknown) {
			this.rLog("System", null, "Error", undefined, undefined, `[ensureState] Failed to update/create object for "${path}": ${this.errorMessage(e)}`, "error");
		}
	}

	/**
	 * Writes a changed `common` onto an object that already exists.
	 *
	 * The obvious call is `extendObject`, and for almost every change it is the right one. It
	 * cannot, however, take anything away: js-controller merges the update into the stored object
	 * with `node.extend(true, …)`, a recursive merge that walks into nested objects and only ever
	 * adds or overwrites keys. Verified in the shipped controller, not from memory:
	 *
	 * * `js-controller-adapter/build/esm/lib/adapter/adapter.js:2283` hands the update to the
	 *   objects client,
	 * * `db-objects-redis/build/esm/lib/objects/objectsInRedisClient.js:3611` does
	 *   `oldObj = extend(true, oldObj, obj)` (unchanged on the 7.2.3 line),
	 * * `node.extend@2.0.3/lib/extend.js` recurses into every plain object and skips `undefined`,
	 * * `db-objects-file` and `db-objects-jsonl` both re-export `Client` from `db-objects-redis`,
	 *   so this holds for every database backend.
	 *
	 * A `null` is no escape hatch either - it is copied as a value, leaving the key in place with
	 * an empty label. (`setObject` does read `null` as "delete", but only for the five preserved
	 * settings `custom`, `smartName`, `material`, `habpanel`, `mobile`.)
	 *
	 * That matters because the adapter does remove entries: a water level the robot proves it does
	 * not have, a suction level a model never had. Through `extendObject` those deletions reach a
	 * fresh installation and no other - which is the worse outcome of the two, because the value
	 * stays exactly where a user would look for it.
	 *
	 * So when the update drops a key from a nested object, the whole object is written instead.
	 * `setObject` replaces rather than merges, and the objects client carries `common.custom`
	 * (history, InfluxDB, …), `smartName`, `material`, `habpanel`, `mobile` and the ACL over by
	 * itself (`objectsInRedisClient.js:64` and the block above `_setObject`), so nothing a user
	 * configured on the state is lost. Everything else keeps the cheap merge.
	 *
	 * @param path Full object id.
	 * @param oldObj The object as it is stored now.
	 * @param commonUpdate The `common` properties to apply; merged over the stored ones.
	 */
	public async applyCommonUpdate(path: string, oldObj: ioBroker.Object, commonUpdate: Partial<ioBroker.StateCommon>): Promise<void> {
		const merged = { ...oldObj.common, ...commonUpdate } as ioBroker.StateCommon;

		if (oldObj.type === "state" && this.removesNestedCommonKeys(oldObj.common as Record<string, unknown>, commonUpdate as Record<string, unknown>)) {
			await this.setObject(path, {
				type: "state",
				common: merged,
				native: (oldObj.native as Record<string, unknown>) || {},
			});
			return;
		}

		await this.extendObject(path, { common: merged });
	}

	/**
	 * Whether applying `commonUpdate` would drop a key out of a nested object such as
	 * `common.states` - the one thing `extendObject` cannot express.
	 */
	private removesNestedCommonKeys(oldCommon: Record<string, unknown>, commonUpdate: Record<string, unknown>): boolean {
		if (!oldCommon) return false;

		for (const key of Object.keys(commonUpdate)) {
			const oldValue = oldCommon[key];
			const newValue = commonUpdate[key];
			if (!this.isPlainRecord(oldValue) || !this.isPlainRecord(newValue)) continue;

			for (const nestedKey of Object.keys(oldValue)) {
				if (!(nestedKey in newValue)) return true;
			}
		}

		return false;
	}

	/** A `{...}` that a recursive merge would descend into - not an array, not null. */
	private isPlainRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	/**
	 * Helper to check if common properties of an object have meaningfully changed.
	 *
	 * PERFORMANCE CRITICAL:
	 * This method prevents "Write Storms" to the ioBroker database (objects.json/redis).
	 * Writing objects is expensive (disk I/O) and triggers system-wide events.
	 * We only write if the definition (name, role, unit, etc.) has actually changed.
	 * This significantly reduces CPU usage and disk wear on startup.
	 */
	private hasCommonChanged(oldCommon: ioBroker.StateCommon, newCommon: Partial<ioBroker.StateCommon>): boolean {
		if (newCommon.type !== undefined && oldCommon.type !== newCommon.type) return true;
		if (newCommon.name !== undefined && this.stringifySorted(oldCommon.name) !== this.stringifySorted(newCommon.name)) return true;
		if (newCommon.states !== undefined && this.stringifySorted(oldCommon.states) !== this.stringifySorted(newCommon.states)) return true;
		if (newCommon.role !== undefined && oldCommon.role !== newCommon.role) return true;
		if (newCommon.unit !== undefined && oldCommon.unit !== newCommon.unit) return true;
		if (newCommon.min !== undefined && oldCommon.min !== newCommon.min) return true;
		if (newCommon.max !== undefined && oldCommon.max !== newCommon.max) return true;
		if (newCommon.icon !== undefined && oldCommon.icon !== newCommon.icon) return true;
		if (newCommon.read !== undefined && oldCommon.read !== newCommon.read) return true;
		if (newCommon.write !== undefined && oldCommon.write !== newCommon.write) return true;
		if (newCommon.def !== undefined && oldCommon.def !== newCommon.def) return true;
		return false;
	}

	/**
	 * JSON.stringify with sorted keys for consistent object comparison.
	 */
	private stringifySorted(obj: unknown): string {
		return JSON.stringify(obj, (_key, value) => {
			if (value && typeof value === "object" && !Array.isArray(value)) {
				return Object.keys(value)
					.sort()
					.reduce((sorted: Record<string, unknown>, key) => {
						sorted[key] = (value as Record<string, unknown>)[key];
						return sorted;
					}, {});
			}
			return value;
		});
	}

	/**
	 * Safe string from any thrown value (message if Error, else String(e)).
	 * Use in catch (e: unknown) instead of repeating e instanceof Error ? e.message : String(e).
	 */
	public errorMessage(e: unknown): string {
		return e instanceof Error ? e.message : String(e);
	}

	/**
	 * Stack trace if Error, else message, else String(e).
	 */
	public errorStack(e: unknown): string {
		if (e instanceof Error) return e.stack ?? e.message;
		return String(e);
	}

	/**
	 * Helper to format Roborock timestamps (seconds) to locale string.
	 */
	public formatRoborockDate(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleString();
	}

	/**
	 * Helper to safely parse JSON strings that look like objects/arrays.
	 */
	private tryParseJson(value: string): unknown | undefined {
		const trimmed = value.trim();
		if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && (trimmed.endsWith("}") || trimmed.endsWith("]"))) {
			try {
				return JSON.parse(trimmed);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	/**
	 * Creates a folder if it doesn't exist, applying translations.
	 */
	async ensureFolder(path: string, customName?: string | ioBroker.StringOrTranslated) {
		const attribute = path.split(".").pop() || path;
		const name = customName || this.translations[attribute] || attribute;

		let oldObj: ioBroker.Object | null | undefined;
		try {
			oldObj = await this.getObjectAsync(path);
		} catch {
			oldObj = null; // Does not exist
		}

		const folderObject = {
			type: "folder" as const,
			common: {
				name: name
			},
			native: {}
		};

		if (!oldObj) {
			await this.setObjectNotExistsAsync(path, {
				...folderObject
			});
		} else if (oldObj.type !== "folder") {
			await this.extendObject(path, folderObject);
		} else if (customName !== undefined) {
			// Only update name when explicitly passed; avoid overwriting with path segment when ensuring existence (issue #1140)
			const currentName = oldObj.common.name;
			const isDifferent = JSON.stringify(currentName) !== JSON.stringify(name);

			if (isDifferent) {
				try {
					await this.extendObject(path, { common: { name } });
				} catch (e: unknown) {
					this.rLog("System", null, "Error", undefined, undefined, `Failed to update folder name for ${path}: ${this.errorMessage(e)}`, "error");
				}
			}
		}
	}

	/**
	 * Gets the protocol version for a device.
	 */
	async getDeviceProtocolVersion(duid: string): Promise<string> {
		const tcpConnected = this.local_api.isConnected(duid);

		if (tcpConnected) {
			const localPv = this.local_api.getLocalProtocolVersion(duid);
			if (localPv) return localPv;
		}

		const devices = this.http_api.getDevices();
		const device = devices ? devices.find((d) => d.duid == duid) : undefined;
		if (device?.pv) return device.pv;

		// Discovery broadcasts carry the protocol version in clear text (first three bytes),
		// so use it when neither cloud nor manual configuration knows the device.
		return this.local_api.getLocalProtocolVersion(duid) || "1.0";
	}

	/**
	 * Returns the B01 sub-variant for a device when applicable.
	 * Q10 behaves event-driven and is routed separately from classic B01/Q7.
	 */
	async getB01Variant(duid: string): Promise<B01Variant | null> {
		const handler = this.deviceFeatureHandlers.get(duid);
		if (handler && "b01Variant" in handler && typeof (handler as { b01Variant?: unknown }).b01Variant === "string") {
			return (handler as { b01Variant: B01Variant }).b01Variant;
		}

		const pv = await this.getDeviceProtocolVersion(duid);
		if (pv !== "B01") return null;

		const model = this.http_api.getRobotModel(duid);
		return model ? getB01VariantFromModel(model) : "Q7";
	}

	/**
	 * Starts the go2rtc process if cameras are present.
	 */
	async start_go2rtc() {
		if (!this.http_api.hasCloudSession()) {
			this.rLog("Local", null, "Debug", undefined, undefined, "[go2rtc] Skipped: camera streaming is relayed through the Roborock cloud broker.", "debug");
			return;
		}
		const devices = this.http_api.getDevices() || [];
		const localKeys = this.http_api.getMatchedLocalKeys();
		const { u, s, k } = this.http_api.get_rriot();

		const apiPort = 1984 + this.instance; // API/Web Port
		const rtspPort = 8554 + this.instance; // RTSP Port
		const go2rtcConfig = {
			server: { listen: `:${apiPort}` },
			rtsp: { listen: `:${rtspPort}` },
			streams: {} as Record<string, string>,
		};
		let cameraCount = 0;

		for (const device of devices) {
			const duid = device.duid;
			const handler = this.deviceFeatureHandlers.get(duid);
			const localKey = localKeys.get(duid);

			if (handler && localKey && handler.hasStaticFeature(Feature.Camera)) {
				cameraCount++;
				go2rtcConfig.streams[duid] = `roborock://mqtt-eu-3.roborock.com:8883?u=${u}&s=${s}&k=${k}&did=${duid}&key=${localKey}&pin=${this.config.cameraPin}`;
			}
		}

		if (cameraCount > 0 && go2rtcPath) {
			try {
				this.go2rtcProcess = spawn(go2rtcPath.toString(), ["-config", JSON.stringify(go2rtcConfig)], { shell: false, detached: false, windowsHide: true });

				this.go2rtcProcess!.on("error", (err) => this.rLog("Local", null, "Error", undefined, undefined, `go2rtc start error: ${err.message}`, "error"));
				this.go2rtcProcess!.stdout!.on("data", (data) => this.rLog("Local", null, "Debug", undefined, undefined, `go2rtc output: ${data.toString().trim()}`, "debug"));
				this.go2rtcProcess!.stderr!.on("data", (data) => {
					const msg = data.toString().trim();
					const isShutdown = /signal:\s*terminated|exit with signal/i.test(msg);
					this.rLog("Local", null, isShutdown ? "Info" : "Error", undefined, undefined, `go2rtc ${isShutdown ? "output" : "error output"}: ${msg}`, isShutdown ? "info" : "error");
				});

				// Remove the process reference on exit to prevent double-kill attempts
				this.go2rtcProcess!.on("exit", () => {
					this.go2rtcProcess = null;
				});

				// Safety net: Ensure child process ensures if Node.js crashes/exits
				this.onExitBound = () => {
					if (this.go2rtcProcess) {
						this.go2rtcProcess.kill();
					}
				};
				process.on("exit", this.onExitBound);
			} catch (error: unknown) {
				this.rLog("Local", null, "Error", undefined, undefined, `Failed to spawn go2rtc: ${this.errorMessage(error)}`, "error");
			}
		}
	}

	/**
	 * Processes A01 (Tuya) protocol messages.
	 */
	async processA01(duid: string, response: { dps?: Record<string, unknown> }): Promise<void> {
		if (!response?.dps) {
			this.rLog("Local", duid, "Warn", "A01", undefined, `Invalid response: ${JSON.stringify(response)}`, "warn");
			return;
		}

		const determineType = (value: unknown): ioBroker.CommonType => {
			const t = typeof value;
			if (t === "number") return "number";
			if (t === "boolean") return "boolean";
			if (t === "object" && value !== null) return "object";
			return "string";
		};

		// Recursive helper for nested JSON objects
		const processNested = async (basePath: string, obj: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(obj)) {
				const path = `${basePath}.${key}`;
				if (typeof value === "object" && value !== null && !Array.isArray(value)) {
					await this.ensureFolder(path);
					await processNested(path, value as Record<string, unknown>);
				} else {
					const val = typeof value === "object" || value === null ? JSON.stringify(value) : (value as ioBroker.StateValue);
					await this.ensureState(path, { name: key, type: determineType(value), write: false });
					await this.setStateChanged(path, { val, ack: true });
				}
			}
		};

		for (const [id, value] of Object.entries(response.dps)) {
			// A01 states are not defined in main.ts anymore, this is just a fallback name
			const stateName = id;
			let parsedValue = value;
			let isJson = false;

			if (typeof value === "object" && value !== null) {
				parsedValue = value;
				isJson = true;
			} else if (typeof value === "string") {
				const maybeJson = this.tryParseJson(value);
				if (maybeJson !== undefined) {
					parsedValue = maybeJson;
					isJson = true;
				}
			}

			if (isJson && typeof parsedValue === "object" && parsedValue !== null) {
				const basePath = `Devices.${duid}.${id}`; // Use ID as folder name
				await this.ensureFolder(basePath);
				await processNested(basePath, parsedValue as Record<string, unknown>);
			} else {
				const path = `Devices.${duid}.deviceStatus.${id}`;
				await this.ensureState(path, { name: stateName, type: determineType(value), write: false });
				await this.setStateChanged(path, { val: parsedValue as ioBroker.StateValue, ack: true });
			}
		}
	}

	/**
	 * Resets the MQTT API instance.
	 */
	async resetMqttApi() {
		this.rLog("System", null, "Info", undefined, undefined, "Resetting MQTT API instance...", "info");
		if (this.mqtt_api) {
			this.mqtt_api.cleanup();
			this.requestsHandler.clearQueue(); // Prevents pending promises
		}
		// Create a new MQTT API instance and initialize it
		this.mqtt_api = new mqtt_api(this);
		await this.mqtt_api.init();
		this.rLog("System", null, "Info", undefined, undefined, "MQTT API instance has been reset.", "info");
	}

	/**
	 * Centralized error handler.
	 */
	async catchError(error: unknown, attribute?: string, duid?: string) {
		const robotModel = duid ? this.http_api.getRobotModel(duid) : "unknown";
		const stack = this.errorStack(error);
		const errorMsg = this.errorMessage(error);
		const msg = `Failed processing ${attribute || "task"} on ${duid || "adapter"} (${robotModel}): ${stack}`;

		if (errorMsg.includes("retry") || errorMsg.includes("locating") || errorMsg.includes("timed out")) {
			this.rLog("System", duid, "Warn", undefined, undefined, msg, "warn");
		} else {
			this.rLog("System", duid, "Error", undefined, undefined, msg, "error");
			if (this.sentryInstance) {
				this.sentryInstance.getSentryObject().captureException(error);
			}
		}
	}

	/**
	 * Centralized Logging Function for Protocol Messages
	 * Format: [Connection] [duid] direction [version] [protocol] [ID: id] | payload
	 */
	rLog(connection: "MQTT" | "TCP" | "UDP" | "HTTP" | "Cloud" | "Local" | "System" | "MapManager" | "Requests" | "Unknown", duid: string | null | undefined, direction: "<-" | "->" | "Info" | "Error" | "Warn" | "Debug", version: string | undefined, protocol: string | number | undefined, message: string, level: "debug" | "info" | "warn" | "error" = "debug", msgId?: string | number): void {
		// Use == as a neutral placeholder for alignment if it's not actual traffic (<- or ->).
		const directionDisplay = (direction === "<-" || direction === "->") ? direction : "==";

		// Construct prefix and message body using parts to ensure clean spacing.
		const parts = [directionDisplay, `[${connection}]`];
		if (duid) parts.push(`[${duid}]`);
		if (version) parts.push(`[${version}]`);
		if (protocol) parts.push(`[${protocol}]`);
		if (msgId !== undefined) parts.push(`[ID: ${msgId}]`);

		const logMsg = `${parts.join(" ")} | ${message}`;

		switch (level) {
			case "debug":
				this.log.debug(logMsg);
				break;
			case "info":
				this.log.info(logMsg);
				break;
			case "warn":
				this.log.warn(logMsg);
				break;
			case "error":
				this.log.error(logMsg);
				break;
		}
	}

	/**
	 * Enables or disables an existing device schedule (timer).
	 *
	 * `updateTimers()` publishes every timer of the robot as `schedules.<timerId>.enabled`.
	 * The counterpart of the `get_timer` read is `upd_timer`, which takes the timer id together
	 * with the literal on/off state that `get_timer` also reports:
	 *   `{"method":"upd_timer","params":["1498595904821","off"]}` -> `["ok"]`
	 * The timer id is exactly the one `get_timer` returned, so no id translation is needed.
	 *
	 * The switch is only acknowledged after the robot confirmed the change. On any other answer
	 * the timers are re-read so the state keeps showing what the robot actually does instead of
	 * the value the user just clicked.
	 * @param duid Device unique id.
	 * @param timerId Timer id as reported by `get_timer`.
	 * @param state The state that was written by the user.
	 * @param stateId Full object id of that state.
	 */
	async handleScheduleToggle(duid: string, timerId: string, state: ioBroker.State, stateId: string): Promise<void> {
		const handler = this.deviceFeatureHandlers.get(duid);
		if (!handler) {
			this.rLog("Requests", duid, "Warn", undefined, undefined, "[scheduleToggle] Received schedule command for unknown device", "warn");
			return;
		}
		if (!timerId) return;

		const enabled = this.isTruthy(state.val);
		const mode = enabled ? "on" : "off";

		try {
			this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[scheduleToggle] Switching timer ${timerId} ${mode}`, "info");
			const result = await this.requestsHandler.sendRequest(duid, "upd_timer", [timerId, mode]);

			const data = (result && typeof result === "object" && "data" in result) ? (result as { data: unknown }).data : result;
			if (Array.isArray(data) && data.length === 1 && data[0] === "ok") {
				await this.setState(stateId, { val: enabled, ack: true });
				return;
			}

			this.rLog("Requests", duid, "Warn", handler.protocolVersion || undefined, undefined, `[scheduleToggle] upd_timer for ${timerId} returned unexpected result: ${JSON.stringify(data)} (expected ["ok"])`, "warn");
			await handler.updateTimers();
		} catch (e: unknown) {
			this.catchError(e, "scheduleToggle", duid);
			// Re-read so the switch falls back to the timer state the robot really has.
			await handler.updateTimers().catch((refreshError: unknown) => this.catchError(refreshError, "scheduleToggle(refresh)", duid));
		}
	}

	// Helper to handle floor switching logic (extracted to reduce nesting)
	async handleFloorSwitch(duid: string, mapFlag: number, stateId: string): Promise<void> {
		const handler = this.deviceFeatureHandlers.get(duid);
		if (!handler) return;

		// The outcome goes onto the very button that was pressed. That is also the only place it could
		// go: `floors.<mapFlag>.load` is one level deeper than a command object, so no folder rule
		// would find it.
		const reportFloorSwitch = (outcome: CommandOutcome, detail?: string, extraArgs?: string[]): Promise<void> =>
			this.markCommandOutcome(duid, {
				command: "load_multi_map",
				outcome,
				stateId,
				folder: "floors",
				detail,
				extraArgs
			});

		try {
			this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[floorSwitch] Loading map ${mapFlag}`, "info");
			// 1. Send load command and wait for robot ACK
			await this.requestsHandler.sendRequest(duid, "load_multi_map", [mapFlag], { timeout: 60000 });

			this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, "[floorSwitch] Load acknowledged, verifying map index sync", "info");

			// Failsafe: Robot says "ok" but might need a few seconds to switch currentMapIndex
			const startTime = Date.now();
			let verified = false;
			for (let i = 0; i < 10; i++) {
				await handler.updateStatus();
				const currentIndex = handler.getCurrentMapIndex();
				// Use exposed method if available or cast to any to access internal if needed (assuming logic added to V1Feature)
				// For now relying on public interface which delegates to V1MapService
				const rawStatus = (handler as any).mapService ? (handler as any).mapService.lastMapStatus : -1;

				const elapsed = Date.now() - startTime;

				// Verify using both index match and verifying raw status supports it
				if (currentIndex === mapFlag) {
					this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[floorSwitch] Synced map index to ${currentIndex} (status=${rawStatus}, attempt=${i + 1}/10, elapsed=${elapsed}ms)`, "info");
					verified = true;
					break;
				}
				this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[floorSwitch] Waiting for sync (current=${currentIndex}, target=${mapFlag}, status=${rawStatus}, attempt=${i + 1}/10, elapsed=${elapsed}ms)`, "info");
				await this.delay(2000);
			}

			if (!verified) {
				this.rLog("Requests", duid, "Warn", handler.protocolVersion || undefined, undefined, `[floorSwitch] Map index did not sync to ${mapFlag} after retries; proceeding`, "warn");
			}

			// The floor switch is the one command that was always acknowledged towards the tab before
			// it had happened, because it takes longer than a socket answer may wait
			// (`socketHandler.handleLoadMultiMap`). It now says so afterwards on the button itself:
			// the robot accepted the load, but its own map index never became the requested one -
			// which is precisely the "acknowledged and yet not in effect" case.
			await reportFloorSwitch(
				verified ? "confirmed" : "ineffective",
				undefined,
				verified ? undefined : [`${Math.round((Date.now() - startTime) / 1000)}s`, `map ${handler.getCurrentMapIndex()}`]
			);

			await handler.updateMultiMapsList();
			await handler.updateRoomMapping();
			await handler.updateMap();

			this.rLog("Requests", duid, "Info", handler.protocolVersion || undefined, undefined, `[floorSwitch] Completed switch to map ${mapFlag}`, "info");
		} catch (e: unknown) {
			const message = this.errorMessage(e);
			if (!isShutdownFailure(message)) {
				const outcome = classifyRequestFailure(message, isChannelUnavailableError(e));
				await reportFloorSwitch(outcome, outcome === "error" ? message : undefined);
			}
			this.catchError(e, "floorSwitch", duid);
		} finally {
			// Reset button
			this.setResetTimeout(stateId);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions>) => new Roborock(options);
} else {
	// otherwise start the instance directly
	new Roborock();
}
