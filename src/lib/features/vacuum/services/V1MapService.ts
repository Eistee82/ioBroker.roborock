import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { MapManager } from "../../../map/MapManager";
import { normalizeMapFlag, normalizeRoomId } from "../../../map/roomKey";
import { decideRoomPruning, ROOM_ABSENCE_THRESHOLD } from "./roomStatePruning";
import type { RoomAbsenceCounters } from "./roomStatePruning";
import type { FeatureDependencies } from "../../baseDeviceFeatures";

const gunzipAsync = promisify(gunzip);

export class V1MapService {
	public mapManager: MapManager;
	private adapter: FeatureDependencies["adapter"];

	// Mapped rooms cache (currently seems unused/null in V1VacuumFeatures but kept for compatibility)
	private mappedRooms: any[] | null = null;
	private currentMapIndex: number = -1;
	public get currentIndex(): number {
		return this.currentMapIndex;
	}
	private multiMaps: any[] = [];
	private lastMapStatus: number = -1;

	constructor(
		private deps: FeatureDependencies,
		private duid: string
	) {
		this.adapter = deps.adapter;
		this.mapManager = new MapManager(this.adapter);
	}

	public async updateMap(): Promise<void> {
		try {
			// "get_map_v1" is usually the command to GET the map.
			const result = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_map_v1", [], { priority: 0 });

			let mapBuf: Buffer | undefined;
			let mapVer = await this.deps.adapter.getDeviceProtocolVersion(this.duid);
			const robotModel = this.deps.adapter.http_api.getRobotModel(this.duid) || "";

			// Handle new return format { data, version } or legacy Buffer
			if (result && typeof result === "object" && "data" in result && Buffer.isBuffer((result as any).data)) {
				mapBuf = (result as any).data;
				if ((result as any).version) mapVer = (result as any).version;
			} else if (Buffer.isBuffer(result)) {
				mapBuf = result;
			} else if (result) {
				this.adapter.rLog("System", this.duid, "Debug", undefined, undefined, `get_map_v1 returned non-buffer: ${typeof result}`, "debug");
			}

			if (mapBuf) {
				const mapResult = await this.mapManager.processMap(mapBuf, mapVer, robotModel, this.duid, this.mappedRooms, this.duid, "Unknown", undefined, this.currentMapIndex);
				if (mapResult) {
					await this.processMapResults(mapResult);
				}
			}
		} catch (e: any) {
			this.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to update map: ${e.message}`, "warn");
		}
	}

	private async processMapResults(mapResult: { mapBase64: string, mapBase64Clean?: string, mapData?: any } | null): Promise<void> {
		if (!mapResult) return;

		await this.mapManager.saveGeneratedMap(this.duid, mapResult);

		// Logic to determine current floor (mapFlag) based on active map slot
		if (this.lastMapStatus !== -1 && this.lastMapStatus < 250) {
			const slotIndex = this.lastMapStatus >> 2;
			if (slotIndex >= 0 && slotIndex !== this.currentMapIndex) {
				this.currentMapIndex = slotIndex;
				this.adapter.rLog("MapManager", this.duid, "Debug", "1.0", undefined, `Updated current map index to ${this.currentMapIndex} from status ${this.lastMapStatus}`, "debug");
			}
		}

		// Only create room states for segments that are on this map – ensures rooms are 100% assigned to this floor
		if (mapResult.mapData && mapResult.mapData.IMAGE && mapResult.mapData.IMAGE.segments && Array.isArray(mapResult.mapData.IMAGE.segments.list)) {
			const currentMapFlag = this.currentMapIndex;
			await this.deps.ensureFolder(`Devices.${this.duid}.floors`);
			await this.deps.ensureFolder(`Devices.${this.duid}.floors.${currentMapFlag}`);

			for (const segment of mapResult.mapData.IMAGE.segments.list) {
				const id = segment.id;
				// Skip invalid IDs if any
				if (!id) continue;

				const roomStateId = `Devices.${this.duid}.floors.${currentMapFlag}.${id}`;

				// We update the name even if the state exists, IF the state name is empty or numeric
				const segmentName = segment.name;
				let finalName = segmentName || "";
				if (String(finalName).match(/^\d+$/)) {
					finalName = "";
				}

				const obj = await this.adapter.getObjectAsync(roomStateId);
				const currentName = obj?.common?.name;

				// If we have a new name, or if state doesn't exist, or if current name is just a number/invalid
				const isInvalidName = !currentName || String(currentName).match(/^\d+$/);

				if (!obj || (finalName && currentName !== finalName) || (isInvalidName && finalName !== currentName)) {
					if (!obj) {
						this.adapter.rLog("MapManager", this.duid, "Info", "1.0", undefined, `Found new room in map (ID: ${id}, Name: "${finalName}"). Adding state.`, "info");
					} else if (finalName) {
						this.adapter.rLog("MapManager", this.duid, "Debug", "1.0", undefined, `Updating room name for ${roomStateId}: "${currentName}" -> "${finalName}"`, "debug");
					}

					const common: Partial<ioBroker.StateCommon> = {
						type: "boolean",
						role: "switch",
						write: true,
						name: finalName || (obj?.common?.name as string) || "",
						def: false
					};

					await this.deps.ensureState(roomStateId, common);
					await this.adapter.extendObject(roomStateId, {
						native: { id: id }
					});
				}
			}

			await this.pruneRoomStates(currentMapFlag, mapResult.mapData.IMAGE.segments.list);
		}
	}

	/**
	 * Evidence that a room is gone, per map slot. Reset whenever a reading is not usable.
	 *
	 * In memory only: a restart starts the evidence over, which delays a deletion and can never
	 * cause one.
	 */
	private roomAbsences = new Map<number, RoomAbsenceCounters>();

	/**
	 * Removes room switches for segments the robot no longer has.
	 *
	 * **The only place in this adapter that deletes objects a user may have built on** - scripts,
	 * vis widgets and scenes all point at `floors.<mapFlag>.<roomId>`. It exists because splitting
	 * or merging rooms renumbers the robot's segments, and a switch that keeps the old number keeps
	 * the old *name* with it: a "Kitchen" switch that now points at the bathroom.
	 *
	 * Four things hold it back, and each of them is a case where doing nothing is correct:
	 *
	 *  1. **Only a map slot that is actually known.** An unknown flag would prune the wrong floor.
	 *  2. **Only a reading with segments.** An empty list is the absence of a reading, not a reading
	 *     of "no rooms" - see {@link decideRoomPruning}.
	 *  3. **Only after {@link ROOM_ABSENCE_THRESHOLD} consecutive clean readings** of this same slot
	 *     have all missed the room. A map fetched while the robot is still driving can legitimately
	 *     carry fewer segments than the finished one.
	 *  4. **Only states this adapter created as room switches** - a `state` with `native.id`. Nothing
	 *     else below the floor is touched, whoever put it there.
	 *
	 * Every deletion is logged with its path and its reason, so a missing switch can be explained
	 * rather than guessed at.
	 * @param mapFlag Map slot the reading belongs to.
	 * @param segments Segment list of that reading.
	 */
	private async pruneRoomStates(mapFlag: unknown, segments: unknown[]): Promise<void> {
		const slot = normalizeMapFlag(mapFlag);
		if (slot === null) return;

		const present: number[] = [];
		for (const segment of segments) {
			const id = normalizeRoomId((segment as { id?: unknown } | null)?.id);
			if (id !== null) present.push(id);
		}

		const existing = await this.readRoomStateIds(slot);
		if (existing === null) return;

		const decision = decideRoomPruning({
			present,
			existing,
			absences: this.roomAbsences.get(slot) ?? {},
		});
		this.roomAbsences.set(slot, decision.absences);

		for (const roomId of decision.remove) {
			const stateId = `Devices.${this.duid}.floors.${slot}.${roomId}`;
			if (!(await this.isOwnRoomSwitch(stateId))) continue;
			try {
				await this.adapter.delObjectAsync(stateId);
				this.adapter.rLog("MapManager", this.duid, "Info", "1.0", undefined,
					`Removed the room switch ${stateId}: segment ${roomId} was missing from ${ROOM_ABSENCE_THRESHOLD} consecutive readings of map ${slot}, so the robot no longer has it - most likely because rooms were split or merged, which renumbers the segments. Anything that referred to this room by that number (scripts, vis, scenes) has to be pointed at the new one.`,
					"info");
			} catch (e: unknown) {
				this.adapter.rLog("MapManager", this.duid, "Warn", "1.0", undefined, `Could not remove the stale room switch ${stateId}: ${this.adapter.errorMessage(e)}`, "warn");
			}
		}
	}

	/**
	 * Reads which room switches this adapter has below one map slot.
	 *
	 * A read that fails answers `null` rather than "none": an empty answer would look like a floor
	 * whose rooms had all vanished, and the caller would count that as evidence.
	 * @param slot Map slot to look below.
	 * @returns The room ids, or null when the folder could not be read.
	 */
	private async readRoomStateIds(slot: number): Promise<number[] | null> {
		const relativePrefix = `Devices.${this.duid}.floors.${slot}.`;
		const fullPrefix = `${this.adapter.namespace}.${relativePrefix}`;
		try {
			// The same way the rest of the adapter enumerates room states (`v1VacuumFeatures.ts:871`
			// and `:1087`, documented at `roomKey.ts:120`).
			const states = await this.adapter.getStatesAsync(`${relativePrefix}*`);
			if (!states) return null;

			const ids: number[] = [];
			for (const id of Object.keys(states)) {
				// Only direct children: a room switch is `floors.<slot>.<roomId>` and nothing deeper.
				const tail = id.startsWith(fullPrefix) ? id.slice(fullPrefix.length) : null;
				if (tail === null || tail.includes(".")) continue;

				const roomId = normalizeRoomId(tail);
				if (roomId !== null) ids.push(roomId);
			}
			return ids;
		} catch (e: unknown) {
			this.adapter.rLog("MapManager", this.duid, "Debug", "1.0", undefined, `Could not read the room switches of map ${slot}, so none are removed: ${this.adapter.errorMessage(e)}`, "debug");
			return null;
		}
	}

	/**
	 * Whether a state is one this adapter created as a room switch.
	 *
	 * Checked immediately before a deletion rather than while enumerating, because this is the last
	 * gate in front of an object a user may have built on. A room switch is a `state` that carries
	 * the segment id in its `native` - both written by `processMapResults`. Anything else below the
	 * floor was put there by somebody else and stays, whatever its name looks like.
	 * @param stateId Full or relative id of the candidate.
	 * @returns True when it may be removed.
	 */
	private async isOwnRoomSwitch(stateId: string): Promise<boolean> {
		try {
			const object = await this.adapter.getObjectAsync(stateId);
			if (!object || object.type !== "state") return false;
			return (object.native as { id?: unknown } | undefined)?.id !== undefined;
		} catch {
			// Unreadable is not "deletable".
			return false;
		}
	}

	public async getCleaningRecordMap(startTime: number): Promise<{ mapBase64CleanUncropped: string; mapBase64: string; mapData: string } | null> {
		try {
			// B01 devices are handled via override/other logic.
			// V1 devices (1.0) expect an object with start_time.
			const params = { start_time: startTime };
			const cleaningRecordMapRes = (await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_clean_record_map", params, { priority: -10 })); // LOW

			let unwrapped = cleaningRecordMapRes;
			while (Array.isArray(unwrapped) && unwrapped.length === 1) {
				unwrapped = unwrapped[0];
			}

			let cleaningRecordMap: Buffer;
			// Check new return format { data, version } or legacy Buffer
			if (unwrapped && typeof unwrapped === "object" && "data" in unwrapped && Buffer.isBuffer((unwrapped as any).data)) {
				cleaningRecordMap = (unwrapped as any).data;
			} else if (Buffer.isBuffer(unwrapped)) {
				cleaningRecordMap = unwrapped;
			} else {
				return null;
			}

			const t0 = Date.now();

			// Check if map is gzipped (starts with 0x1f 0x8b)
			let mapBuf: Buffer = cleaningRecordMap;
			if (cleaningRecordMap[0] === 0x1f && cleaningRecordMap[1] === 0x8b) {
				try {
					mapBuf = await gunzipAsync(cleaningRecordMap);
				} catch (e) {
					this.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Failed to unzip map data: ${e}`, "error");
					return null;
				}
			}
			const t1 = Date.now();

			const mapData = await this.deps.adapter.mapManager.mapParser.parsedata(mapBuf, null, { isHistoryMap: true });
			if (!mapData) {
				return null;
			}
			const t2 = Date.now();

			// Generate images
			const [mapBase64CleanUncropped, mapBase64] = await this.deps.adapter.mapManager.mapCreator.canvasMap(mapData);
			const t3 = Date.now();

			this.adapter.rLog("MapManager", this.duid, "Debug", "Profiler", undefined, `[MapProfiler] History Map ${startTime} processed. Total: ${t3 - t0}ms | Unzip: ${t1 - t0}ms | Parse: ${t2 - t1}ms | Canvas: ${t3 - t2}ms | Size: ${cleaningRecordMap.length}`, "debug");

			return {
				mapBase64CleanUncropped,
				mapBase64,

				mapData: JSON.stringify(mapData),
			};
		} catch (e: any) {
			this.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to get cleaning record map: ${e.message}`, "warn");
			return null;
		}
	}

	/**
	 * Fetches room mapping from API and stores it for name resolution when the map is loaded.
	 * Room states are NOT created here – they are only created in processMapResults when segments
	 * are present on the loaded map, so rooms exist only where they are 100% assigned to that floor.
	 */
	public async updateRoomMapping(): Promise<boolean> {
		// Runs before the request so the orphan state also disappears on devices whose
		// get_room_mapping keeps failing.
		await this.removeLegacyCleanCountState();
		try {
			let rawResult: any = null;
			for (let i = 0; i < 3; i++) {
				rawResult = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_room_mapping", []);

				const hasMapInfo = rawResult && typeof rawResult === "object" &&
					((Array.isArray(rawResult) && rawResult[0] && (rawResult[0] as any).map_info) || (rawResult as any).map_info);
				if (hasMapInfo || (Array.isArray(rawResult) && rawResult.length > 0)) {
					break;
				}
				if (i < 2) await new Promise(resolve => {
					const timeout = this.adapter.setTimeout(() => resolve(undefined), 2000);
					if (!timeout) resolve(undefined);
				});
			}

			const mapInfoFromApi: any[] | undefined = Array.isArray(rawResult) && rawResult[0] && (rawResult[0] as any).map_info
				? (rawResult[0] as any).map_info
				: (rawResult && (rawResult as any).map_info);
			const hasRoomsPerMap = Array.isArray(mapInfoFromApi) && mapInfoFromApi.some((m: any) => Array.isArray(m.rooms) && m.rooms.length > 0);

			let stored = false;
			if (hasRoomsPerMap) {
				// Store per-map room list for parser name resolution; do not create any room states here
				for (const map of mapInfoFromApi) {
					const mapFlag = map.mapFlag ?? map.id;
					const rooms = map.rooms;
					if (!Array.isArray(rooms) || rooms.length === 0) continue;
					const roomEntries: [number, number][] = rooms.map((r: any) => [r.id, r.iot_name_id != null ? r.iot_name_id : 0]);
					if (this.currentMapIndex === mapFlag) this.mappedRooms = roomEntries;
					const existing = this.multiMaps.find((m: any) => (m.mapFlag ?? m.id) === mapFlag);
					if (existing) existing.rooms = rooms;
				}
				stored = true;
				this.adapter.rLog("MapManager", this.duid, "Info", "1.0", undefined, `[updateRoomMapping] Stored room mapping for ${mapInfoFromApi.length} maps (room states only when map is loaded)`, "info");
			} else {
				// Legacy: flat room list for current map only
				let result: any[] = Array.isArray(rawResult) && rawResult.length > 0 && Array.isArray(rawResult[0])
					? rawResult as any[]
					: [];
				if (result.length === 0) {
					const currentFloor = this.multiMaps.find(m => m.mapFlag === this.currentMapIndex);
					if (currentFloor && Array.isArray(currentFloor.rooms)) {
						result = currentFloor.rooms.map((r: any) => [r.id, r.iot_name_id, r.tag]);
					}
				}
				if (result.length > 0) {
					this.mappedRooms = result;
					stored = true;
					this.adapter.rLog("MapManager", this.duid, "Info", "1.0", undefined, `[updateRoomMapping] Stored room mapping for current floor (${result.length} rooms; states only when map loaded)`, "info");
				} else {
					this.adapter.rLog("MapManager", this.duid, "Warn", "1.0", undefined, `[updateRoomMapping] No room mapping for Floor ${this.currentMapIndex}`, "warn");
				}
			}

			// Ensure floors parent exists (single-map / empty multi-map devices may not get it from updateMultiMapsList)
			await this.deps.ensureFolder(`Devices.${this.duid}.floors`);
			return stored;
		} catch (e: any) {
			this.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to update room mapping: ${e.message}`, "warn");
		}
		return false;
	}

	/**
	 * Older adapter versions created a writable `floors.cleanCount` state. Nothing ever read it:
	 * the repeat count actually used comes from `commands.set_clean_repeat_times` (falling back
	 * to `deviceStatus.repeat`), and that command is the only one the firmware accepts — with a
	 * range of 1..2. The orphan state suggested both a per-floor scope and an unlimited value
	 * range, neither of which exists, so it is removed instead of wired up.
	 */
	private legacyCleanCountRemoved = false;
	private async removeLegacyCleanCountState(): Promise<void> {
		if (this.legacyCleanCountRemoved) return;
		this.legacyCleanCountRemoved = true;

		const stateId = `Devices.${this.duid}.floors.cleanCount`;
		try {
			const existing = await this.adapter.getObjectAsync(stateId);
			if (!existing) return;
			await this.adapter.delObjectAsync(stateId);
			this.adapter.rLog("MapManager", this.duid, "Info", "1.0", undefined, "Removed the unused floors.cleanCount state; the repeat count is set through commands.set_clean_repeat_times (1 or 2).", "info");
		} catch (e: unknown) {
			this.adapter.rLog("MapManager", this.duid, "Debug", "1.0", undefined, `Could not remove legacy floors.cleanCount state: ${this.adapter.errorMessage(e)}`, "debug");
		}
	}

	public async updateMultiMapsList(): Promise<any[] | null> {
		try {
			// Cast result to any[] as we expect an array response
			const result: any[] = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_multi_maps_list", []) as any[];
			let mapInfo: any[] = [];

			if (Array.isArray(result) && result[0] && result[0].map_info) {
				mapInfo = result[0].map_info;
			} else if (typeof result === "object" && (result as any).map_info) {
				mapInfo = (result as any).map_info;
			}

			this.multiMaps = mapInfo;

			if (mapInfo.length > 0) {
				await this.deps.ensureFolder(`Devices.${this.duid}.floors`);

				// Legacy: Global parameters from result[0] (e.g. max_multi_map)
				if (result[0]) {
					for (const key in result[0]) {
						if (typeof result[0][key] === "number") {
							await this.deps.ensureState(`Devices.${this.duid}.floors.${key}`, { name: key, type: "number", write: false });
							await this.adapter.setStateChanged(`Devices.${this.duid}.floors.${key}`, { val: result[0][key], ack: true });
						}
					}
				}

				const maps: Record<string, string> = {};

				for (const map of mapInfo) {
					const mapFlag = map.mapFlag;
					const name = map.name || `Map ${mapFlag}`;
					const formattedTime = map.add_time ? new Date(map.add_time * 1000).toLocaleString() : "Unknown";

					maps[mapFlag] = name;

					// Create folder for this floor (using mapFlag as stable ID)
					await this.deps.ensureFolder(`Devices.${this.duid}.floors.${mapFlag}`);
					await this.adapter.extendObject(`Devices.${this.duid}.floors.${mapFlag}`, { common: { name } });

					// Create States
					await this.deps.ensureState(`Devices.${this.duid}.floors.${mapFlag}.name`, { name: "Floor Name", type: "string", write: false });
					await this.adapter.setStateChanged(`Devices.${this.duid}.floors.${mapFlag}.name`, { val: name, ack: true });

					await this.deps.ensureState(`Devices.${this.duid}.floors.${mapFlag}.mapFlag`, { name: "Map Flag", type: "number", write: false });
					await this.adapter.setStateChanged(`Devices.${this.duid}.floors.${mapFlag}.mapFlag`, { val: mapFlag, ack: true });

					await this.deps.ensureState(`Devices.${this.duid}.floors.${mapFlag}.add_time`, { name: "Created At", type: "string", write: false });
					await this.adapter.setStateChanged(`Devices.${this.duid}.floors.${mapFlag}.add_time`, { val: formattedTime, ack: true });

					// Legacy: Also keep local load button (optional but useful)
					await this.deps.ensureState(`Devices.${this.duid}.floors.${mapFlag}.load`, { name: "Load Map", type: "boolean", role: "button", write: true, def: false });
				}

				// Legacy: Create load_multi_map command
				if (result[0] && result[0]["max_multi_map"] > 1) {
					await this.deps.ensureState(`Devices.${this.duid}.commands.load_multi_map`, {
						name: "Load map",
						type: "number",
						role: "level",
						write: true,
						def: 0,
						states: maps
					});
				}

				return mapInfo;
			}
			return null;
		} catch (e: any) {
			this.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to update floors/multi-maps: ${e.message}`, "warn");
		}
		return null;
	}

	public updateCurrentMapIndex(mapStatus: number): boolean {
		this.lastMapStatus = mapStatus;
		if (mapStatus === undefined || mapStatus === null) return false;

		if (mapStatus >= 250) return false;

		const slotIndex = mapStatus >> 2;
		if (slotIndex >= 0 && slotIndex !== this.currentMapIndex) {
			this.currentMapIndex = slotIndex;
			// Use room mapping for new floor from multiMaps (if we have it) so parser can resolve names when map is loaded
			const floor = this.multiMaps.find((m: any) => (m.mapFlag ?? m.id) === slotIndex);
			this.mappedRooms = Array.isArray(floor?.rooms)
				? floor.rooms.map((r: any) => [r.id, r.iot_name_id != null ? r.iot_name_id : 0])
				: null;
			return true;
		}
		return false;
	}

	public resetCurrentMapIndex(): void {
		this.adapter.rLog("System", this.duid, "Info", undefined, undefined, "resetCurrentMapIndex: Forcing reset of map index to 0", "info");
		this.currentMapIndex = 0;
		this.lastMapStatus = -1;
	}
}
