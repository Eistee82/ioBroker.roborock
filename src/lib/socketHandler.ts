// /lib/socketHandler.ts

import { Roborock } from "../main"; // Import main adapter type
import type { BaseDeviceFeatures } from "./features/baseDeviceFeatures";
import { isReportableMapTheme } from "./map/mapColorScheme";
import { NON_ROOM_STATE_NAMES, floorFolderId, isRoomSwitchOn, normalizeMapFlag, normalizeRoomId } from "./map/roomKey";
import {
	APP_RC_END,
	APP_RC_MOVE,
	APP_RC_START,
	APP_RC_STOP,
	REMOTE_LAUNCH_MS,
	REMOTE_LEASE_MS,
	REMOTE_REFRESH_MS,
	isKnownRemoteDirection,
	remoteStartVerdict
} from "./features/vacuum/remoteControl";

// Robot object definition
interface Robot {
	duid: string;
	name: string;
}

// Message handler type
type MessageHandler = (message: any, id?: string | number) => Promise<any>;

/**
 * Allowed characters for state path fragments that originate from the web UI.
 * Keeps duid/folder/command from escaping the intended object path.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Folder the consumable services publish their reset buttons in. It is not a registered
 * command folder (main.ts routes it to 'reset_consumable' directly), so it gets its own
 * check instead of being allowed through the generic `set_state` boundary.
 */
const RESET_CONSUMABLES_FOLDER = "resetConsumables";

/**
 * What the tab gets back the moment a command has been taken on.
 *
 * It deliberately no longer says `ok`. The only thing this side can know at that point is that the
 * command was *accepted* - the robot has not been asked yet, and on the `set_state` route the write
 * has not even reached `onStateChange`. What became of it appears afterwards on the command state
 * itself, as its quality and comment; see `lib/commandFeedback.ts`.
 */
interface CommandAcknowledgement {
	result: "accepted";
}

export class socketHandler {
	private adapter: Roborock;

	// Command routing map
	private commandHandlers: Map<string, MessageHandler>;

	constructor(adapterInstance: Roborock) {
		this.adapter = adapterInstance;

		// Initialize command map
		this.commandHandlers = new Map<string, MessageHandler>();
		this.commandHandlers.set("getDeviceList", () => this.handleGetDeviceList());
		this.commandHandlers.set("scanLocalDevices", (msg) => this.handleScanLocalDevices(msg));

		this.commandHandlers.set("app_start", (msg, id) => this.handleSimpleCommand(msg.duid, "app_start", id));
		this.commandHandlers.set("app_pause", (msg, id) => this.handleSimpleCommand(msg.duid, "app_pause", id));
		this.commandHandlers.set("app_stop", (msg, id) => this.handleSimpleCommand(msg.duid, "app_stop", id));
		this.commandHandlers.set("app_charge", (msg, id) => this.handleSimpleCommand(msg.duid, "app_charge", id));
		this.commandHandlers.set("app_goto_target", (msg, id) => this.handleGotoTarget(msg, id));
		this.commandHandlers.set("app_zoned_clean", (msg, id) => this.handleZonedClean(msg, id));
		this.commandHandlers.set("app_segment_clean", (msg, id) => this.handleSegmentClean(msg, id));
		this.commandHandlers.set("load_multi_map", (msg) => this.handleLoadMultiMap(msg));
		this.commandHandlers.set("set_state", (msg) => this.handleSetState(msg));
		this.commandHandlers.set("reset_consumable", (msg) => this.handleResetConsumable(msg));
		this.commandHandlers.set("get_translations", () => this.handleGetTranslations());
		this.commandHandlers.set("set_map_theme", (msg) => this.handleSetMapTheme(msg));
		this.commandHandlers.set("set_room_selection", (msg) => this.handleSetRoomSelection(msg));

		this.commandHandlers.set("remote_start", (msg, id) => this.handleRemoteStart(msg, id));
		this.commandHandlers.set("remote_move", (msg, id) => this.handleRemoteMove(msg, id));
		this.commandHandlers.set("remote_stop", (msg, id) => this.handleRemoteSimple(msg, APP_RC_STOP, id));
		this.commandHandlers.set("remote_end", (msg, id) => this.handleRemoteSimple(msg, APP_RC_END, id));
	}

	/**
	 * Milliseconds the app waits after pausing a running job before it starts the remote mode
	 * (`_delayedSuccessCallback`, A65:785931-785939).
	 */
	private static readonly REMOTE_PAUSE_SETTLE_MS = 800;

	/**
	 * Handles incoming 'sendTo' messages.
	 * Routes commands to the appropriate handler using the commandHandlers map.
	 * @param obj The message object
	 */
	public async handleMessage(obj: ioBroker.Message): Promise<void> {
		if (!obj || !obj.command) {
			this.adapter.rLog("System", null, "Warn", undefined, undefined, "Received invalid message object.", "warn");
			return;
		}

		if (obj.command === "get_obstacle_image") {
			return this.handleGetObstacleImage(obj);
		}
		if (obj.command === "get_room_names") {
			return this.handleGetRoomNames(obj);
		}

		// --- Standard Handlers ---
		const handler = this.commandHandlers.get(obj.command);

		if (!handler) {
			this.adapter.rLog("System", null, "Warn", undefined, undefined, `Unknown command received: ${obj.command}`, "warn");
			if (obj.callback) {
				this.adapter.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
			}
			return;
		}

		// Centralized error handling
		try {
			// Extract message payload and pass callback ID
			const result = await handler(obj.message, obj.callback?.id);
			if (obj.callback) {
				this.adapter.sendTo(obj.from, obj.command, result, obj.callback);
			}
		} catch (error: unknown) {
			this.adapter.rLog("System", null, "Error", undefined, undefined, `Error handling command '${obj.command}': ${this.adapter.errorMessage(error)}`, "error");
			if (obj.callback) {
				this.adapter.sendTo(obj.from, obj.command, { error: this.adapter.errorMessage(error) || "Failed" }, obj.callback);
			}
		}
	}

	private async handleGetObstacleImage(msg: ioBroker.Message): Promise<void> {
		const { duid } = msg.message;

		if (!duid) {
			this.adapter.rLog("MapManager", duid, "Warn", undefined, undefined, "'get_obstacle_image' missing duid.", "warn");
			if (msg.callback) {
				this.adapter.sendTo(msg.from, msg.command, { error: "Missing duid" }, msg.callback);
			}
			return;
		}

		const obstacleId = msg.message.obstacleId || msg.message.imgId || msg.message.img_id;

		if (obstacleId === undefined || obstacleId === null) {
			this.adapter.rLog("MapManager", duid, "Warn", undefined, undefined, "[Photo] Received get_photo request without obstacleId or imgId", "warn");
			if (msg.callback) this.adapter.sendTo(msg.from, msg.command, { error: "Missing ID" }, msg.callback);
			return;
		}

		const imageType = msg.message.type !== undefined ? Number(msg.message.type) : 1;
		this.adapter.rLog("MapManager", duid, "Debug", undefined, undefined, `[Photo] Requesting image type: ${imageType} (ID: ${obstacleId})`, "debug");

		try {
			if (!this.adapter.requestsHandler) {
				throw new Error("RequestHandler is not available");
			}

			const handler = this.adapter.deviceFeatureHandlers.get(duid);
			if (!handler) {
				throw new Error(`No device handler found for DUID ${duid}`);
			}

			const photoResponse = await handler.getPhoto(obstacleId, imageType);

			let potentialBuffer: Buffer | null = null;
			let bbox: any = null;

			// Helper to find the buffer and bbox in various response structures
			const extractData = (obj: any): { buf: Buffer; bbox?: any } | null => {
				if (!obj) return null;
				if (Buffer.isBuffer(obj)) return { buf: obj };
				if (obj.buffer && Buffer.isBuffer(obj.buffer)) return { buf: obj.buffer, bbox: obj.bbox };
				if (obj.data) {
					if (Buffer.isBuffer(obj.data)) return { buf: obj.data };
					if (obj.data.buffer && Buffer.isBuffer(obj.data.buffer)) return { buf: obj.data.buffer, bbox: obj.data.bbox };
				}
				return null;
			};

			let payload: any = photoResponse;
			const extracted = extractData(photoResponse);
			if (extracted) {
				potentialBuffer = extracted.buf;
				bbox = extracted.bbox;
			}

			if (Buffer.isBuffer(potentialBuffer)) {
				let mimeType = "image/png";
				// Check for JPEG (FF D8)
				if (potentialBuffer[0] === 0xff && potentialBuffer[1] === 0xd8) {
					mimeType = "image/jpeg";
				} else if (potentialBuffer[0] === 0x89 && potentialBuffer[1] === 0x50 && potentialBuffer[2] === 0x4e && potentialBuffer[3] === 0x47) {
					mimeType = "image/png";
				} else {
					this.adapter.rLog("MapManager", duid, "Warn", undefined, undefined, `[Photo] Unknown image format. Header: ${potentialBuffer.subarray(0, 8).toString("hex")}`, "warn");
				}

				const base64Str = potentialBuffer.toString("base64");
				payload = {
					image: `data:${mimeType};base64,` + base64Str,
					bbox: bbox
				};
			}

			if (msg.callback) {
				const imageLen = (payload && payload.image) ? payload.image.length : 0;
				this.adapter.rLog("MapManager", duid, "Debug", undefined, undefined, `[Photo] Sending photo response to frontend (Image length: ${imageLen})`, "debug");
				this.adapter.sendTo(msg.from, msg.command, payload, msg.callback);
			}
		} catch (error: unknown) {
			this.adapter.rLog("MapManager", duid, "Error", undefined, undefined, `[Photo] Failed to get obstacle image ${obstacleId}: ${this.adapter.errorMessage(error)}`, "error");
			this.adapter.catchError(error, "handleGetObstacleImage", duid);

			if (msg.callback) {
				this.adapter.sendTo(msg.from, msg.command, { error: this.adapter.errorMessage(error) || "Failed" }, msg.callback);
			}
		}
	}

	/**
	 * Returns segment id → room name for a device (e.g. for cloud maps where mapData has no segment names).
	 * Message: { duid: string, floor?: number, segmentIds?: number[] }. Returns { [segmentId: string]: string }.
	 */
	private async handleGetRoomNames(msg: ioBroker.Message): Promise<void> {
		const { duid, floor = 0, segmentIds } = msg.message || {};
		if (!duid) {
			if (msg.callback) this.adapter.sendTo(msg.from, msg.command, { error: "Missing duid" }, msg.callback);
			return;
		}
		const result: Record<string, string> = {};
		try {
			const prefix = `Devices.${duid}.floors.${floor}.`;
			if (Array.isArray(segmentIds) && segmentIds.length > 0) {
				for (const id of segmentIds) {
					const obj = await this.adapter.getObjectAsync(prefix + id);
					const name = (obj as any)?.common?.name;
					if (name && String(name).trim()) result[String(id)] = String(name).trim();
				}
			} else {
				const ns = this.adapter.namespace;
				const list = await (this.adapter.getObjectListAsync as (n: string, o: { type: string; startkey: string; endkey: string }) => Promise<unknown>)(ns, {
					type: "state",
					startkey: `${ns}.${prefix}`,
					endkey: `${ns}.${prefix}\u9999`
				});
				const rows = (list as any)?.rows ?? (Array.isArray(list) ? list : []);
				for (const row of rows) {
					const o = row.value ?? row;
					if (!o || !o._id) continue;
					const segId = o._id.slice((ns + "." + prefix).length);
					if (!segId) continue;
					const name = o.common?.name;
					if (name && String(name).trim()) result[segId] = String(name).trim();
				}
			}
			if (msg.callback) this.adapter.sendTo(msg.from, msg.command, result, msg.callback);
		} catch (error: any) {
			this.adapter.rLog("System", duid, "Error", undefined, undefined, `get_room_names failed: ${error.message}`, "error");
			if (msg.callback) this.adapter.sendTo(msg.from, msg.command, { error: error.message || "Failed" }, msg.callback);
		}
	}

	/**
	 * Admin diagnostics: lists devices announcing themselves on UDP 58866.
	 * Cloud-free setups need the duid before a manual device entry can be created.
	 * Never returns a localKey.
	 * @param message Optional { timeout: number } in milliseconds.
	 */
	private async handleScanLocalDevices(message?: { timeout?: number }): Promise<{ result: string; devices: { duid: string; ip: string; pv: string; known: boolean }[] }> {
		const requested = Number(message?.timeout);
		const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 60_000) : 16_000;

		const scan = await this.adapter.local_api.scanForDevices(timeoutMs);
		const devices = scan.devices.map((device) => ({ duid: device.duid, ip: device.ip, pv: device.version, known: device.known }));

		const lines: string[] = [];
		if (devices.length === 0) {
			lines.push("No devices found.");
		} else {
			lines.push(`${devices.length} device(s) found:`);
			for (const device of devices) {
				lines.push(`- duid: ${device.duid} | ip: ${device.ip} | pv: ${device.pv}${device.known ? " | localKey known" : " | localKey missing"}`);
			}
		}
		if (scan.hint) lines.push(scan.hint);
		if (!scan.discoveryEnabled) lines.push("Discovery is currently switched off.");

		this.adapter.rLog("UDP", null, "Info", undefined, undefined, `Network scan finished: ${devices.length} device(s).`, "info");
		return { result: lines.join("\n"), devices };
	}

	/**
	 * Fetches robot list.
	 */
	private async handleGetDeviceList(): Promise<Robot[]> {
		this.adapter.rLog("System", null, "Debug", undefined, undefined, "Executing handleGetDeviceList...", "debug");
		let devices: ioBroker.DeviceObject[];

		try {
			const adapterObjects = await this.adapter.getAdapterObjectsAsync();

			// Filter for devices in 'Devices' folder
			devices = Object.values(adapterObjects).filter(
				(obj: any): obj is ioBroker.DeviceObject => obj && typeof obj === "object" && obj.type === "device" && obj._id.startsWith(this.adapter.namespace + ".Devices.")
			);
		} catch (e: unknown) {
			this.adapter.rLog("System", null, "Error", undefined, undefined, `Error getting adapter objects: ${this.adapter.errorMessage(e)}`, "error");
			return []; // Return empty list on error
		}

		if (devices.length === 0) {
			this.adapter.rLog("System", null, "Warn", undefined, undefined, "No device objects found under 'Devices' folder.", "warn");
			return [];
		}

		const robotList: Robot[] = devices
			.map((dev) => {
				// e.g. "roborock.0.Devices.ABCDEFG"
				const idParts = dev._id.split(".");
				const duid = idParts.pop();
				const name = dev.common.name ? String(dev.common.name) : "Unknown Robot";

				if (!duid) {
					this.adapter.rLog("System", null, "Warn", undefined, undefined, `Could not parse DUID from _id: ${dev._id}`, "warn");
					return null;
				}
				return { duid, name };
			})
			.filter((robot): robot is Robot => robot !== null); // Filter out any nulls

		this.adapter.rLog("System", null, "Debug", undefined, undefined, `Returning robot list: ${JSON.stringify(robotList)}`, "debug");
		return robotList;
	}

	/**
	 * Handles simple commands.
	 */
	private async handleSimpleCommand(duid: string, command: string, id?: string | number): Promise<CommandAcknowledgement> {
		if (!duid) throw new Error(`Invalid message: '${command}' requires a 'duid'.`);
		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received '${command}' (ID: ${id})`, "info");

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);

		await this.adapter.requestsHandler.command(handler, duid, command, undefined, id ? String(id) : undefined);
		return { result: "accepted" };
	}

	/**
	 * Handles 'app_goto_target'.
	 */
	private async handleGotoTarget(message: { duid: string; points: [number, number] }, id?: string | number): Promise<CommandAcknowledgement> {
		const { duid, points } = message;
		if (!duid || !points || !Array.isArray(points) || points.length !== 2) {
			throw new Error("Invalid 'app_goto_target' message: requires 'duid' and 'points' array [x, y]");
		}

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'app_goto_target' with points: ${JSON.stringify(points)} (ID: ${id})`, "info");

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);

		// No state is written on this route, so the outcome is marked on the `app_goto_target`
		// command object that the device handler registered anyway. Same for the two below.
		await this.adapter.requestsHandler.command(handler, duid, "app_goto_target", points, id ? String(id) : undefined);
		return { result: "accepted" };
	}

	/**
	 * Handles 'app_zoned_clean'.
	 */
	private async handleZonedClean(message: { duid: string; zones: any[] }, id?: string | number): Promise<CommandAcknowledgement> {
		const { duid, zones } = message;
		if (!duid || !zones || !Array.isArray(zones)) {
			throw new Error("Invalid 'app_zoned_clean' message: requires 'duid' and 'zones' array");
		}

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'app_zoned_clean' with zones: ${JSON.stringify(zones)} (ID: ${id})`, "info");

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);

		await this.adapter.requestsHandler.command(handler, duid, "app_zoned_clean", zones, id ? String(id) : undefined);
		return { result: "accepted" };
	}

	/**
	 * Handles 'app_segment_clean'. The web UI sends the explicitly selected room ids,
	 * so the device handler does not have to collect the room states itself.
	 */
	private async handleSegmentClean(message: { duid: string; segments: unknown }, id?: string | number): Promise<CommandAcknowledgement> {
		const duid = message?.duid;
		const rawSegments = message?.segments;
		const segments = Array.isArray(rawSegments) ? rawSegments.map((segment) => Number(segment)).filter((segment) => Number.isInteger(segment) && segment > 0) : [];

		if (!duid || segments.length === 0) {
			throw new Error("Invalid 'app_segment_clean' message: requires 'duid' and a non-empty 'segments' array");
		}

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'app_segment_clean' with segments: ${JSON.stringify(segments)} (ID: ${id})`, "info");

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);

		await this.adapter.requestsHandler.command(handler, duid, "app_segment_clean", segments, id ? String(id) : undefined);
		return { result: "accepted" };
	}

	/**
	 * Handles 'load_multi_map' (floor switch). Only map flags the adapter itself published
	 * on the 'load_multi_map' command object are accepted.
	 */
	private async handleLoadMultiMap(message: { duid: string; mapFlag: unknown }): Promise<CommandAcknowledgement> {
		const duid = message?.duid;
		const mapFlag = Number(message?.mapFlag);

		if (!duid || !Number.isInteger(mapFlag) || mapFlag < 0) {
			throw new Error("Invalid 'load_multi_map' message: requires 'duid' and a numeric 'mapFlag'");
		}

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);

		const commandObject = await this.adapter.getObjectAsync(`Devices.${duid}.commands.load_multi_map`);
		const knownMaps = (commandObject as any)?.common?.states;
		if (!knownMaps || typeof knownMaps !== "object" || !(String(mapFlag) in knownMaps)) {
			throw new Error(`Unknown map flag ${mapFlag} for DUID ${duid}`);
		}

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'load_multi_map' for map flag ${mapFlag}`, "info");

		// The floor switch verifies the map index and reloads rooms/map afterwards; that easily
		// takes more than a minute, so the tab is acknowledged immediately. What actually became of
		// it appears afterwards on the button itself, as its quality and comment.
		void this.adapter.handleFloorSwitch(duid, mapFlag, `Devices.${duid}.floors.${mapFlag}.load`)
			.catch((error: unknown) => this.adapter.catchError(error, "handleLoadMultiMap", duid));

		return { result: "accepted" };
	}

	/**
	 * Generic writer for command states. This is a security boundary: the web UI may only write
	 * to command folders that the device handler registered (same check as main.ts handleCommand).
	 */
	private async handleSetState(message: { duid: string; folder: string; command: string; value: unknown }): Promise<CommandAcknowledgement> {
		const duid = message?.duid;
		const folder = message?.folder;
		const command = message?.command;

		if (!duid || !folder || !command) {
			throw new Error("Invalid 'set_state' message: requires 'duid', 'folder' and 'command'");
		}
		if (!SAFE_PATH_SEGMENT.test(String(duid)) || !SAFE_PATH_SEGMENT.test(String(folder)) || !SAFE_PATH_SEGMENT.test(String(command))) {
			throw new Error("Invalid 'set_state' message: illegal characters in target");
		}

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);

		if (!handler.hasCommandFolder(folder)) {
			throw new Error(`'${folder}' is not a command folder of DUID ${duid}`);
		}

		const spec = handler.getCommandSpec(folder, command);
		if (!spec) {
			throw new Error(`Unregistered command ${folder}.${command}`);
		}

		const value = this.coerceCommandValue(spec, message.value);
		const stateId = `Devices.${duid}.${folder}.${command}`;

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'set_state' for ${folder}.${command} = ${String(value)}`, "info");

		// Written unacknowledged on purpose: this is the same path a script or the admin UI takes.
		// Nothing is added to the write - the state that is being written here is the very state the
		// outcome will be marked on, so there is nothing to correlate.
		await this.adapter.setState(stateId, { val: value, ack: false });
		return { result: "accepted" };
	}

	/**
	 * Presses one consumable reset button. This is a security boundary of its own: only a state
	 * the adapter itself published inside the reset folder as a writable boolean button may be
	 * triggered, and the value is always `true` - the web UI cannot choose it.
	 */
	private async handleResetConsumable(message: { duid: string; consumable: string }): Promise<CommandAcknowledgement> {
		const duid = message?.duid;
		const consumable = message?.consumable;

		if (!duid || !consumable) {
			throw new Error("Invalid 'reset_consumable' message: requires 'duid' and 'consumable'");
		}
		if (!SAFE_PATH_SEGMENT.test(String(duid)) || !SAFE_PATH_SEGMENT.test(String(consumable))) {
			throw new Error("Invalid 'reset_consumable' message: illegal characters in target");
		}

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);

		const stateId = `Devices.${duid}.${RESET_CONSUMABLES_FOLDER}.${consumable}`;
		const object = await this.adapter.getObjectAsync(stateId);
		const common = (object as { common?: Partial<ioBroker.StateCommon> } | null | undefined)?.common;

		if (!object || (object as ioBroker.Object).type !== "state" || common?.type !== "boolean" || common?.role !== "button" || common?.write !== true) {
			throw new Error(`'${consumable}' is not a consumable reset button of DUID ${duid}`);
		}

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'reset_consumable' for ${consumable}`, "info");

		// Unacknowledged on purpose: main.ts turns this write into the reset_consumable request.
		await this.adapter.setState(stateId, { val: true, ack: false });
		return { result: "accepted" };
	}

	/**
	 * Takes over the rooms the user picked in the map.
	 *
	 * The picked rooms are not a message the robot ever sees - they are the room switches
	 * `Devices.<duid>.floors.<mapFlag>.<roomId>` the adapter publishes anyway. Writing them from
	 * the tab makes the picture and the cleaning agree: the renderer fades everything that is not
	 * switched on, and `app_segment_clean` without explicit segments cleans exactly the same set.
	 *
	 * This is a security boundary of the same kind as `reset_consumable`, and it is drawn tightly
	 * on purpose - a message that could write arbitrary states would reach far past the tab:
	 *
	 * - the floor must be a known one, i.e. a folder the adapter itself created for this device;
	 * - only ids that already exist as states inside that folder are touched, so an invented room
	 *   number creates nothing;
	 * - each state is verified to be a writable boolean the adapter published, and metadata names
	 *   below the same folder (`load`, `name`, ...) are never candidates;
	 * - the value is derived from the message, never taken from it, and is always a boolean.
	 *
	 * Rooms of other floors are left untouched: room ids repeat across the maps of one robot, so
	 * clearing them here would silently drop a selection the user made on another floor.
	 * @param message Payload with `duid`, the `mapFlag` the selection belongs to and the picked `rooms`.
	 * @returns The floor and the ids that are switched on now.
	 */
	private async handleSetRoomSelection(message: { duid: string; mapFlag: unknown; rooms: unknown }): Promise<{ result: string; mapFlag: number; selected: number[] }> {
		const duid = message?.duid;
		if (!duid || !SAFE_PATH_SEGMENT.test(String(duid))) {
			throw new Error("Invalid 'set_room_selection' message: requires a valid 'duid'");
		}
		if (!this.adapter.deviceFeatureHandlers.get(duid)) throw new Error(`No handler for DUID ${duid}`);

		const mapFlag = normalizeMapFlag(message?.mapFlag);
		if (mapFlag === null) {
			throw new Error("Invalid 'set_room_selection' message: requires a numeric 'mapFlag'");
		}

		const wanted = new Set<number>();
		if (Array.isArray(message?.rooms)) {
			for (const raw of message.rooms) {
				const roomId = normalizeRoomId(raw);
				if (roomId !== null) wanted.add(roomId);
			}
		}

		const folder = floorFolderId(String(duid), mapFlag);
		const states = await this.adapter.getStatesAsync(`${this.adapter.namespace}.${folder}.*`);
		if (!states || Object.keys(states).length === 0) {
			throw new Error(`Unknown map flag ${mapFlag} for DUID ${duid}`);
		}

		const selected: number[] = [];
		let written = 0;
		for (const [stateId, state] of Object.entries(states)) {
			const name = stateId.split(".").pop();
			if (!name || NON_ROOM_STATE_NAMES.has(name)) continue;
			const roomId = normalizeRoomId(name);
			if (roomId === null) continue;

			const shouldBeOn = wanted.has(roomId);
			if (shouldBeOn) selected.push(roomId);
			if (isRoomSwitchOn(state?.val) === shouldBeOn) continue;

			const object = await this.adapter.getObjectAsync(`${folder}.${roomId}`);
			const common = (object as { common?: Partial<ioBroker.StateCommon> } | null | undefined)?.common;
			if (!object || (object as ioBroker.Object).type !== "state" || common?.type !== "boolean" || common?.write !== true) {
				continue;
			}

			// Unacknowledged on purpose: this is the path a script or the object tree takes, and it
			// is what makes the adapter draw the map again.
			await this.adapter.setState(`${folder}.${roomId}`, { val: shouldBeOn, ack: false });
			written++;
		}

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'set_room_selection' for floor ${mapFlag}: ${selected.length ? selected.join(", ") : "nothing"} (${written} switch(es) changed)`, "info");

		return { result: "ok", mapFlag, selected: selected.sort((left, right) => left - right) };
	}

	/**
	 * Finds the feature handler of a device that really offers remote control.
	 *
	 * The gate is the registered command folder and nothing else - the same boundary `set_state`
	 * draws. A robot whose firmware did not report feature 125 never gets the folder
	 * (`features/vacuum/v1VacuumFeatures.ts`, `detectRemoteControl`), so these four messages cannot
	 * reach it however they are addressed.
	 *
	 * @param duid Device the message names.
	 * @returns The handler; throws when the device is unknown or cannot be driven.
	 */
	private remoteHandler(duid: unknown): BaseDeviceFeatures {
		if (!duid || typeof duid !== "string" || !SAFE_PATH_SEGMENT.test(duid)) {
			throw new Error("Invalid remote control message: requires a valid 'duid'");
		}

		const handler = this.adapter.deviceFeatureHandlers.get(duid);
		if (!handler) throw new Error(`No handler for DUID ${duid}`);
		if (!handler.hasCommandFolder("remoteControl")) {
			throw new Error(`DUID ${duid} does not offer remote control`);
		}
		return handler;
	}

	/**
	 * Reads the robot's last reported state code.
	 * @param duid Device to look at.
	 * @returns The code, or null when none was ever written.
	 */
	private async robotStateCode(duid: string): Promise<number | null> {
		const state = await this.adapter.getStateAsync(`Devices.${duid}.deviceStatus.state`);
		const value = Number(state?.val);
		return Number.isFinite(value) ? value : null;
	}

	/**
	 * Opens the remote control mode, asking first where the app asks first.
	 *
	 * The three answers mirror `_checkRemoteControlCondition` (A65:785665-785840) and nothing beyond
	 * it, so this side never blocks something the app allows:
	 *
	 * - `refused` while the firmware is updating - the app refuses that outright, with a toast.
	 * - `confirm` while a job is running: the caller has to come back with `confirmed: true`, and
	 *   only then is the job paused. Answering the question here rather than in the tab keeps the
	 *   rule in one place, and a caller that ignores the answer simply does not start.
	 * - `accepted` otherwise.
	 *
	 * The 800 ms between the pause and the start are the app's own
	 * (`_delayedSuccessCallback`, A65:785931-785939), not a guess about what the robot needs.
	 *
	 * `launchMs` travels back so the caller can grey its pad out for as long as the app does: the
	 * robot answers `app_rc_start` long before it acts on a direction, and the app sends nothing for
	 * six seconds (A65:790960-790975).
	 *
	 * @param message Payload with `duid` and an optional `confirmed`.
	 * @param id Callback id, only used for the log line.
	 */
	private async handleRemoteStart(
		message: { duid: string; confirmed?: boolean },
		id?: string | number
	): Promise<{ result: "accepted" | "confirm" | "refused"; stateCode: number | null; launchMs?: number; refreshMs?: number; leaseMs?: number }> {
		const handler = this.remoteHandler(message?.duid);
		const duid = message.duid;

		const stateCode = await this.robotStateCode(duid);
		const verdict = remoteStartVerdict(stateCode);

		if (verdict === "refuse") {
			this.adapter.rLog("System", duid, "Info", undefined, undefined,
				`Refusing 'remote_start': the robot reports state ${stateCode} (updating).`, "info");
			return { result: "refused", stateCode };
		}

		if (verdict === "confirm" && message?.confirmed !== true) {
			return { result: "confirm", stateCode };
		}

		if (verdict === "confirm") {
			this.adapter.rLog("System", duid, "Info", undefined, undefined,
				`'remote_start' confirmed while the robot is in state ${stateCode}; pausing the run first.`, "info");
			await this.adapter.requestsHandler.command(handler, duid, "app_pause", undefined, id ? String(id) : undefined);
			await this.wait(socketHandler.REMOTE_PAUSE_SETTLE_MS);
		}

		this.adapter.rLog("System", duid, "Info", undefined, undefined, `Received 'remote_start' (ID: ${id})`, "info");
		await this.adapter.requestsHandler.command(handler, duid, APP_RC_START, undefined, id ? String(id) : undefined);

		return { result: "accepted", stateCode, launchMs: REMOTE_LAUNCH_MS, refreshMs: REMOTE_REFRESH_MS, leaseMs: REMOTE_LEASE_MS };
	}

	/**
	 * Drives one step in one of the app's eight directions.
	 *
	 * **One message, one move.** Nothing here repeats anything: the robot acts on a move for at most
	 * 1.5 s and then stops by itself, so a caller that goes silent - a closed tab, a sleeping browser,
	 * a broken connection - leaves a robot that stops. Repeating the move in the adapter would take
	 * that away and turn a lost "stop" into a collision.
	 *
	 * @param message Payload with `duid` and a `direction` from 0 to 8; 0 means stand still.
	 * @param id Callback id, only used for the log line.
	 */
	private async handleRemoteMove(message: { duid: string; direction: unknown }, id?: string | number): Promise<CommandAcknowledgement> {
		const handler = this.remoteHandler(message?.duid);

		const direction = Number(message?.direction);
		if (!Number.isFinite(direction) || !isKnownRemoteDirection(direction)) {
			throw new Error(`Invalid 'remote_move' message: 'direction' must be 0 to 8, received ${JSON.stringify(message?.direction)}`);
		}

		// Deliberately at debug: this arrives about every 400 ms while a key is held, and an info
		// line per move would bury everything else in the log.
		this.adapter.rLog("System", message.duid, "Debug", undefined, undefined, `Received 'remote_move' direction ${direction}`, "debug");

		await this.adapter.requestsHandler.command(handler, message.duid, APP_RC_MOVE, direction, id ? String(id) : undefined);
		return { result: "accepted" };
	}

	/**
	 * Stops the motion (`app_rc_stop`) or leaves the mode (`app_rc_end`).
	 *
	 * The two are not the same call and not the same effect: the app sends the stop whenever both
	 * components of the motion fall to zero and keeps the mode open (A65:790666-790690), and the end
	 * only when it really leaves (A65:791093-791096).
	 *
	 * @param message Payload with `duid`.
	 * @param method Which of the two to send.
	 * @param id Callback id, only used for the log line.
	 */
	private async handleRemoteSimple(message: { duid: string }, method: string, id?: string | number): Promise<CommandAcknowledgement> {
		const handler = this.remoteHandler(message?.duid);

		this.adapter.rLog("System", message.duid, "Info", undefined, undefined, `Received '${method}' (ID: ${id})`, "info");
		await this.adapter.requestsHandler.command(handler, message.duid, method, undefined, id ? String(id) : undefined);
		return { result: "accepted" };
	}

	/**
	 * Waits, on a timer the adapter owns so `onUnload` disposes of it.
	 * @param ms How long to wait.
	 */
	private wait(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			this.adapter.setTimeout(() => resolve(), ms);
		});
	}

	/**
	 * Converts a value coming from the web UI into the type the command object declares
	 * and rejects everything the command definition does not allow.
	 */
	private coerceCommandValue(spec: { type?: string; min?: number; max?: number; states?: unknown }, raw: unknown): ioBroker.StateValue {
		if (spec?.type === "boolean") {
			return raw === true || raw === "true" || raw === 1 || raw === "1";
		}

		let value: ioBroker.StateValue;
		if (spec?.type === "number") {
			const numeric = Number(raw);
			if (!Number.isFinite(numeric)) {
				throw new Error(`Value '${String(raw)}' is not a number`);
			}
			if (typeof spec.min === "number" && numeric < spec.min) {
				throw new Error(`Value ${numeric} is below the allowed minimum ${spec.min}`);
			}
			if (typeof spec.max === "number" && numeric > spec.max) {
				throw new Error(`Value ${numeric} is above the allowed maximum ${spec.max}`);
			}
			value = numeric;
		} else {
			value = raw === null || raw === undefined ? "" : String(raw);
		}

		const states = spec?.states;
		if (states && typeof states === "object" && !Array.isArray(states) && !(String(value) in (states as Record<string, unknown>))) {
			throw new Error(`Value '${String(value)}' is not allowed for this command`);
		}

		return value;
	}

	/**
	 * Returns the adapter language plus the loaded admin translations so the web UI
	 * can label itself without shipping a second translation store.
	 */
	private async handleGetTranslations(): Promise<{ language: string; translations: Record<string, string> }> {
		return {
			language: this.adapter.language || "en",
			translations: this.adapter.translations || {}
		};
	}

	/**
	 * Takes the light/dark theme the admin tab currently displays.
	 *
	 * The map is a PNG the adapter paints, so it cannot follow a browser on its own; this is the
	 * one place where the browser tells it. Deliberately a message and not a direct state write:
	 * the value steers what the adapter renders, so it passes the same boundary as every other
	 * command from the UI and is rejected unless it is exactly `light` or `dark`.
	 *
	 * Whether the report has any effect is the adapter's decision - with the option set to a fixed
	 * scheme it is remembered and otherwise ignored.
	 * @param msg Message payload, expected to carry `theme`.
	 * @returns The resolved scheme, so the caller can tell whether its report mattered.
	 */
	private async handleSetMapTheme(msg: { theme?: unknown }): Promise<{ scheme: "light" | "dark" } | { error: string }> {
		const theme = msg?.theme;
		if (!isReportableMapTheme(theme)) {
			return { error: "theme must be 'light' or 'dark'" };
		}
		await this.adapter.setReportedMapTheme(theme);
		return { scheme: this.adapter.getMapColorScheme() };
	}
}
