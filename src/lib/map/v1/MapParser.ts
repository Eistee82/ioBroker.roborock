// src/lib/map/v1/MapParser.ts
import * as crypto from "node:crypto";
import type { Roborock } from "../../../main";
import type { Furniture, SegmentInfo } from "./types";
import type { SegmentRaster } from "../../../common/segmentRaster";
import { encodeRasterRuns, imagePixelsFromCells, MAX_RASTER_RUN_VALUES } from "../../../common/segmentRaster";

export type { Furniture };

// --------------------
// Constants
// --------------------
const TYPES = {
	CHARGER_LOCATION: 1,
	IMAGE: 2,
	PATH: 3,
	GOTO_PATH: 4,
	GOTO_PREDICTED_PATH: 5,
	CURRENTLY_CLEANED_ZONES: 6,
	GOTO_TARGET: 7,
	ROBOT_POSITION: 8,
	FORBIDDEN_ZONES: 9,
	VIRTUAL_WALLS: 10,
	CURRENTLY_CLEANED_BLOCKS: 11,
	NO_MOP_ZONE: 12,
	OBSTACLES: 13,
	IGNORED_OBSTACLES: 14,
	OBSTACLES2: 15,
	IGNORED_OBSTACLES2: 16,
	CARPET_MAP: 17,
	MOP_PATH: 18,
	CARPET_FORBIDDEN_ZONE: 19,
	SMART_ZONE_PATH_TYPE: 20,
	SMART_ZONE: 21,
	CUSTOM_CARPET: 22,
	CL_FORBIDDEN_ZONES: 23,
	FLOOR_MAP: 24,
	FURNITURES: 25,
	DOCK_TYPE: 26,
	ENEMIES: 27,
	DS_FORBIDDEN_ZONES: 28,
	STUCK_POINTS: 29,
	CLF_FORBIDDEN_ZONES: 30,
	SMART_DS: 31,
	FLOOR_DIRECTION: 32,
	DATE: 33,
	NONCEDATA: 34,
	EXT_ZONES: 36,
	PATROL: 37,
	PET_PATROL: 38,
	MODE_CARPET: 39,
	STROY_PT: 41,
	DIRTY_RECT: 42,
	IGNORE_DIRTY_RECT: 43,
	BRUSH_PT: 44,
	DIRTY_NEW: 45,
	MOP_ERR_PT: 46,
	ERAZER_ZONE: 47,
	LONG_CARPET: 48,
	DS_SIDES: 49,
	STEERING_PT: 50,
	SENSOR_INFO: 51,
	LOW_SPACES: 52,
	TIDY_ZONES: 53,
	GARBAGE: 54,
	ZONE_LINES: 55,
	DIGEST: 1024,
	/** Not in app workermapparser.jx (gap between 34 and 36). */
	UNKNOWN_35: 35,
	/** Not in app workermapparser.jx (gap between 39 and 41). */
	UNKNOWN_40: 40,
	/** Not in app workermapparser.jx (gap between 55 and 57). */
	UNKNOWN_56: 56,
	/** Block 59: curtain zones (门帘). From app workermapparser.jx type "curtain". */
	CURTAIN: 59,
	/** Block 60: missed-cleaning areas (漏扫的区域). From app workermapparser.jx type "missZone". */
	MISS_ZONE: 60,
};
const TYPES_REVERSE = Object.fromEntries(Object.entries(TYPES).map(([key, value]) => [value, key]));
const OFFSETS = {
	HLENGTH: 0x02,
	LENGTH: 0x04,
	TYPE_COUNT: 0x08,
	TARGET_X: 0x08,
	ANGLE: 0x10,
	PATH: 0x14,
	TARGET_Y: 0x0a,
	BLOCKS: 0x0c,
};

// --------------------
// Interfaces
// --------------------
interface MapMetaData {
	header_length: number;
	data_length: number;
	version: { major: number; minor: number };
	map_index: number;
	map_sequence: number;
	SHA1: string;
	expectedSHA1: string;
}
interface PositionBlock {
	position: [number, number];
	angle: number;
}
interface ImageBlock {
	segments: {
		count: number;
		list: SegmentInfo[];
	};
	position: { top: number; left: number };
	dimensions: { height: number; width: number };
	/**
	 * Floor, obstacle and segment cells, the way this block was published until the raster replaced
	 * them.
	 *
	 * **Present only when {@link ImageBlock.raster} is not.** They are derived views of the raster -
	 * one filter each, see `imagePixels` - and sending both cost 472 KiB of every map cycle on the
	 * reference device against the raster's 23 KiB. Readers go through `imagePixels`, which prefers
	 * these lists when a `mapData` state written by an older adapter version still carries them.
	 */
	pixels?: { floor: number[]; obstacle: number[]; segments: number[] };
	/**
	 * The grid as the robot sends it, one byte per cell, run-length coded.
	 *
	 * Richer than the `pixels` lists above, not just smaller: `pixels.obstacle` keeps only the cell
	 * index and throws the segment id away, which is exactly what dividing a room needs. See
	 * {@link SegmentRaster} for the coding and for why it is not gzipped.
	 *
	 * Absent when the raster does not compress - see {@link MapParser.buildSegmentRaster}.
	 */
	raster?: SegmentRaster;
}
interface PathBlock {
	current_angle: number;
	points: [number, number][];
}
type Obstacle = [number, number, number, number, number, number, string];
interface NonceData {
	type: number;
	unixTime: number;
}
export interface ParsedMapData {
	metaData: MapMetaData;
	/** Active map/floor this map belongs to. Rooms are keyed by the composite (mapFlag, roomId). */
	mapFlag?: number;
	ROBOT_POSITION?: PositionBlock;
	CHARGER_LOCATION?: PositionBlock;
	IMAGE?: ImageBlock;
	PATH?: PathBlock;
	GOTO_PATH?: PathBlock;
	GOTO_PREDICTED_PATH?: PathBlock;
	CURRENTLY_CLEANED_ZONES?: number[][];
	GOTO_TARGET?: [number, number];
	VIRTUAL_WALLS?: number[][];
	CURRENTLY_CLEANED_BLOCKS?: number[];
	FORBIDDEN_ZONES?: number[][];
	NO_MOP_ZONE?: number[][];
	OBSTACLES2?: Obstacle[];
	CARPET_MAP?: number[];
	MOP_PATH?: number[];
	CARPET_FORBIDDEN_ZONE?: number[][];
	DS_FORBIDDEN_ZONES?: number[][];
	CLF_FORBIDDEN_ZONES?: number[][];
	MODE_CARPET?: number[][];
	NONCEDATA?: NonceData[];
	STROY_PT?: any[];
	DIRTY_RECT?: any[];
	IGNORE_DIRTY_RECT?: any[];
	BRUSH_PT?: any[];
	DIRTY_NEW?: any[];
	MOP_ERR_PT?: any[];
	ERAZER_ZONE?: any[];
	LONG_CARPET?: any[];
	DS_SIDES?: any[];
	STEERING_PT?: any[];
	SENSOR_INFO?: any[];
	LOW_SPACES?: any[];
	TIDY_ZONES?: any[];
	GARBAGE?: any[];
	ZONE_LINES?: any[];
	OBSTACLES?: any[];
	IGNORED_OBSTACLES?: any[];
	IGNORED_OBSTACLES2?: any[];
	SMART_ZONE_PATH_TYPE?: number;
	SMART_ZONE?: any[];
	/** Carpet areas, four corners each. One entry per record, `[]` when the block is empty. */
	CUSTOM_CARPET?: number[][];
	FLOOR_MAP?: number[];
	FURNITURES?: Furniture[];
	DOCK_TYPE?: number;
	ENEMIES?: any[];
	STUCK_POINTS?: any[];
	/** Four corners each, like the other zone blocks. */
	SMART_DS?: number[][];
	FLOOR_DIRECTION?: any[];
	DATE?: number;
	/** Four corners each, like the other zone blocks. */
	EXT_ZONES?: number[][];
	PATROL?: any[];
	PET_PATROL?: any[];
}

export class MapParser {
	adapter: Roborock;

	constructor(adapter: Roborock) {
		this.adapter = adapter;
	}

	/**
	 * Parses the raw map data from V1 Roborock vacuums.
	 * @see test/unit/v1_map_specification.test.ts for the binary format specification.
	 */
	async parsedata(buf: Buffer, mappedRooms: any[] | null, options: { isHistoryMap?: boolean; duid?: string } = { isHistoryMap: false }): Promise<ParsedMapData | {}> {
		if (buf.length < 8) {
			this.adapter.rLog("MapManager", null, "Warn", "1.0", undefined, `Received map buffer is too small (< 8 bytes). Length: ${buf.length}`, "warn");
			return {};
		}

		let metaData: MapMetaData;
		let dataPosition = 0;
		let dataLength = buf.length;

		if (buf.length >= 20 && buf[0x00] === 0x72 && buf[0x01] === 0x72) {
			metaData = this.parseHeader(buf);

			if (!metaData.header_length) {
				this.adapter.rLog("MapManager", null, "Error", "1.0", undefined, "Failed to parse LIVE map header (Invalid structure).", "error");
				return {};
			}
			if (metaData.SHA1 !== metaData.expectedSHA1) {
				this.adapter.rLog("MapManager", null, "Error", "1.0", undefined, "Invalid map hash!", "error");
				return {};
			}

			dataPosition = 0x14; // Skip 20-byte header
			dataLength = metaData.data_length;
		} else if (options.isHistoryMap) {
			this.adapter.rLog("MapManager", null, "Debug", "1.0", undefined, "Parsing as History Map (No 'rr' Header).", "debug");
			metaData = { map_index: -1 } as any;
			dataPosition = 0;
			dataLength = buf.length;
		} else {
			this.adapter.rLog("MapManager", null, "Warn", "1.0", undefined, "Invalid map header signature (expected 'rr').", "warn");
			return {};
		}

		const result: any = { metaData };

		const roomIDsAll = options.duid && this.adapter.http_api.isSharedDevice(options.duid)
			? await this.adapter.http_api.getSharedDeviceRooms(options.duid)
			: this.adapter.http_api.getMatchedRoomIDs(false);

		// Loop through all blocks
		while (dataPosition < dataLength) {
			if (dataPosition + OFFSETS.LENGTH + 4 > buf.length) {
				this.adapter.rLog("MapManager", null, "Warn", "1.0", undefined, "Reached end of buffer prematurely while reading block header.", "warn");
				break;
			}

			const type = buf.readUInt16LE(dataPosition);
			const hlength = buf.readUInt16LE(dataPosition + OFFSETS.HLENGTH);
			const length = buf.readUInt32LE(dataPosition + OFFSETS.LENGTH);

			if (dataPosition + hlength + length > buf.length) {
				this.adapter.rLog("MapManager", null, "Warn", "1.0", undefined, `Block (Type ${type}) claims to be larger than buffer. Stopping parse.`, "warn");
				break;
			}

			const blockBuffer = buf.subarray(dataPosition, dataPosition + hlength + length);
			const [offset1, offset2] = this.getTwoByteOffsets(blockBuffer);

			const typeName = TYPES_REVERSE[type];
			if (typeName) {
				try {
					switch (type) {
						case TYPES.ROBOT_POSITION:
						case TYPES.CHARGER_LOCATION: {
							const position = this.getXYPositions(blockBuffer, offset1, offset2);
							const angle = length >= 12 ? this.getAngle(blockBuffer) : 0;
							result[typeName] = { position, angle };
							break;
						}
						case TYPES.IMAGE: {
							result[typeName] = this.parseImageBlock(blockBuffer, buf, dataPosition, length, hlength, mappedRooms, roomIDsAll);
							break;
						}
						case TYPES.CARPET_MAP: {
							const carpets: number[] = [];
							const dataStart = dataPosition + offset1;
							for (let i = 0; i < length; i++) {
								if (this.getPixelType(buf, dataStart + i) === 1) {
									carpets.push(i);
								}
							}
							result[typeName] = carpets;
							break;
						}
						case TYPES.MOP_PATH: {
							const mopPath: number[] = [];
							const dataStart = dataPosition + hlength;
							for (let i = 0; i < length; i++) {
								mopPath.push(...this.readUInt8(buf, dataStart + i, 0, 1));
							}
							result[typeName] = mopPath;
							break;
						}
						case TYPES.PATH:
						case TYPES.GOTO_PATH:
						case TYPES.GOTO_PREDICTED_PATH: {
							result[typeName] = this.parsePathBlock(blockBuffer, buf, dataPosition, length);
							break;
						}
						case TYPES.GOTO_TARGET:
							result[typeName] = this.getGoToTarget(blockBuffer);
							break;

						case TYPES.CURRENTLY_CLEANED_ZONES:
						case TYPES.VIRTUAL_WALLS:
							result[typeName] = this.readZoneRecords(buf, blockBuffer, dataPosition + hlength, length, 4);
							break;
						case TYPES.FORBIDDEN_ZONES:
						case TYPES.NO_MOP_ZONE:
						case TYPES.CARPET_FORBIDDEN_ZONE:
						// `DS_FORBIDDEN_ZONES` looks like it should not be here, and it is: its payload
						// divides by its record count to a clean 244 bytes, not 16, on both stored maps
						// (`count=5, length=1220` and `count=3, length=732`). That is not a record size.
						// Measured on the bytes: the zones sit **contiguously at the front**, `count`
						// times 16 bytes, and the remainder is padding with a handful of fields at
						// offsets that stay put as the count changes - `count` again at +240, 5000 at
						// +420, two -1 at +572 and +672, two small negative floats at +688. So this
						// reader is right, and the space beyond the zones belongs to something else.
						// The proof that the front really is coordinates: all five zones of the
						// reference map come out as exact rectangles - four right angles, opposite
						// edges equal to the millimetre, same corner order as `FORBIDDEN_ZONES` beside
						// them, edges of 100 to 2837 mm. Bytes read at the wrong stride do not do that.
						// What the padding carries is **not** established; do not write this block back.
						case TYPES.DS_FORBIDDEN_ZONES:
						case TYPES.CLF_FORBIDDEN_ZONES:
						case TYPES.MODE_CARPET:
						// These four used to be read once, without the count, which produced a zone
						// that was not there - see {@link MapParser.readZoneRecords}.
						case TYPES.CUSTOM_CARPET:
						case TYPES.CL_FORBIDDEN_ZONES:
						case TYPES.SMART_DS:
						case TYPES.EXT_ZONES:
							result[typeName] = this.readZoneRecords(buf, blockBuffer, dataPosition + hlength, length, 8);
							break;
						case TYPES.OBSTACLES2:
							result[typeName] = this.extractObstacles(blockBuffer, hlength);
							break;
						case TYPES.CURRENTLY_CLEANED_BLOCKS: {
							const count = this.getCount(blockBuffer);
							const blocks: number[] = [];
							for (let i = 0; i < count; i++) {
								blocks.push(buf.readUInt8(dataPosition + OFFSETS.BLOCKS + i));
							}
							result[typeName] = blocks;
							break;
						}
						case TYPES.NONCEDATA:
							result[typeName] = this.getNonceData(blockBuffer);
							break;
						case TYPES.STROY_PT:
							result[typeName] = this.getStroyPt(blockBuffer, hlength);
							break;
						case TYPES.DIRTY_RECT:
						case TYPES.IGNORE_DIRTY_RECT:
							result[typeName] = this.getDirtyRect(blockBuffer, hlength);
							break;
						case TYPES.BRUSH_PT:
							result[typeName] = this.getBrushPt(blockBuffer, hlength);
							break;
						case TYPES.DIRTY_NEW:
							result[typeName] = this.getDirtyNew(blockBuffer, hlength, length);
							break;
						case TYPES.MOP_ERR_PT:
							result[typeName] = this.getMopErrPt(blockBuffer, hlength);
							break;
						case TYPES.ERAZER_ZONE:
						case TYPES.LOW_SPACES:
							result[typeName] = this.getEraserZone(blockBuffer, hlength, length);
							break;
						case TYPES.LONG_CARPET:
							result[typeName] = this.getLongCarpet(blockBuffer, hlength, length);
							break;
						case TYPES.DS_SIDES:
							result[typeName] = this.getDsSides(blockBuffer, hlength, length);
							break;
						case TYPES.STEERING_PT:
							result[typeName] = this.getSteeringPt(blockBuffer, hlength, length);
							break;
						case TYPES.SENSOR_INFO:
							result[typeName] = this.getSensorInfo(blockBuffer, hlength, length);
							break;
						case TYPES.TIDY_ZONES:
							result[typeName] = this.getTidyZones(blockBuffer, hlength, length);
							break;
						case TYPES.GARBAGE:
							result[typeName] = this.getGarbage(blockBuffer, hlength, length);
							break;
						case TYPES.ZONE_LINES:
							result[typeName] = this.getZoneLines(blockBuffer, hlength);
							break;
						case TYPES.OBSTACLES:
						case TYPES.IGNORED_OBSTACLES:
							result[typeName] = this.getObstaclesOld(blockBuffer, hlength);
							break;
						case TYPES.IGNORED_OBSTACLES2:
							result[typeName] = this.getIgnoredObstacles2(blockBuffer, hlength);
							break;
						case TYPES.SMART_ZONE_PATH_TYPE:
							result[typeName] = buf.readUInt8(dataPosition + offset1);
							break;
						case TYPES.SMART_ZONE:
							result[typeName] = this.getSmartZone(blockBuffer, hlength);
							break;
						case TYPES.FLOOR_MAP:
							result[typeName] = this.readUInt8(buf, dataPosition, hlength, length);
							break;
						case TYPES.FURNITURES:
							result[typeName] = this.getFurnitures(blockBuffer, hlength);
							break;
						case TYPES.DOCK_TYPE:
							result[typeName] = buf.readUInt8(dataPosition + offset1);
							break;
						case TYPES.ENEMIES:
						case TYPES.STUCK_POINTS:
							result[typeName] = this.getEnemies(blockBuffer, hlength);
							break;
						case TYPES.FLOOR_DIRECTION:
							result[typeName] = this.getFloorDirection(blockBuffer, hlength, length);
							break;
						case TYPES.DATE:
							result[typeName] = buf.readUInt32LE(dataPosition + offset1);
							break;
						case TYPES.PATROL:
						case TYPES.PET_PATROL:
							result[typeName] = this.getPatrol(blockBuffer, hlength);
							break;
						case TYPES.CURTAIN: {
							const count = this.getCount(blockBuffer);
							const zones: number[][] = [];
							const dataStart = dataPosition + hlength;
							const entryLen = 20; // 8 coords (16 B) + status (2 B) + count (2 B)
							for (let i = 0; i < count && dataStart + (i + 1) * entryLen <= dataPosition + hlength + length; i++) {
								zones.push(this.readUInt16LE(buf, dataStart + i * entryLen, 0, 8));
							}
							result[typeName] = zones;
							break;
						}
						case TYPES.MISS_ZONE: {
							const count = this.getCount(blockBuffer);
							const zones: number[][] = [];
							const dataStart = dataPosition + hlength;
							const payloadLen = length;
							const entryLen = count > 0 ? Math.floor(payloadLen / count) : 0; // 29 or 31
							for (let i = 0; i < count && entryLen >= 29; i++) {
								zones.push(this.readUInt16LE(buf, dataStart + i * entryLen + 12, 0, 8));
							}
							result[typeName] = zones;
							break;
						}
						case TYPES.UNKNOWN_35:
						case TYPES.UNKNOWN_40:
						case TYPES.UNKNOWN_56:
							this.adapter.rLog("MapManager", null, "Info", "1.0", undefined, `Unknown map block (report for analysis): type=${type} length=${length} hex=${blockBuffer.toString("hex")}`, "info");
							break;
					}
				} catch (e: any) {
					this.adapter.rLog("MapManager", null, "Error", "1.0", undefined, `Error parsing block ${typeName} (Type ${type}): ${e.stack}`, "error");
				}
			} else {
				this.adapter.rLog("MapManager", null, "Warn", "1.0", undefined, `Unknown map block (report for analysis): type=${type} length=${length} hex=${blockBuffer.toString("hex")}`, "warn");
			}
			dataPosition += length + hlength;
		}
		return result;
	}

	private parseHeader(mapBuf: Buffer): MapMetaData {
		return {
			header_length: mapBuf.readUInt16LE(OFFSETS.HLENGTH),
			data_length: mapBuf.readUInt32LE(OFFSETS.LENGTH),
			version: {
				major: mapBuf.readUInt16LE(0x08),
				minor: mapBuf.readUInt16LE(0x0a),
			},
			map_index: mapBuf.readUInt32LE(0x0c),
			map_sequence: mapBuf.readUInt32LE(0x10),
			SHA1: crypto
				.createHash("sha1")
				.update(mapBuf.subarray(0, mapBuf.length - 20))
				.digest("hex"),
			expectedSHA1: mapBuf.subarray(mapBuf.length - 20).toString("hex"),
		};
	}

	private parseImageBlock(
		blockBuffer: Buffer,
		buf: Buffer,
		dataPosition: number,
		length: number,
		hlength: number,
		mappedRooms: any[] | null,
		roomIDsAll: { id: number; name: string }[]
	): ImageBlock {
		// MM per pixel (5cm)
		const MM_PER_PIXEL = 50;

		// Get unscaled pixel dimensions and offsets
		const offset = this.getSingleByteOffset(blockBuffer);
		const { left, top, width: width_px, height: height_px } = this.getMapSizes(blockBuffer, offset);

		const parameters: ImageBlock = {
			segments: {
				count: hlength > 24 ? this.getCount(blockBuffer) : 0,
				list: [],
			},
			position: { top, left },
			dimensions: { height: height_px, width: width_px },
		};

		if (height_px <= 0 || width_px <= 0) return parameters;

		// Create Bounding Boxes for segments
		const segBB: Record<number, { minX: number; maxX: number; minY: number; maxY: number; count: number }> = {};
		const segmentIDsInImage: Set<number> = new Set();

		const dataStart = dataPosition + offset;

		// The grid as it arrives, kept verbatim so that the segment id of a *wall* cell survives -
		// the `pixels.obstacle` view drops it, and dividing a room needs it. Copied in this loop
		// rather than sliced afterwards so the block is walked exactly once.
		const rasterCells = new Uint8Array(length);

		for (let i = 0; i < length; i++) {
			const pixelByte = buf.readUInt8(dataStart + i);
			rasterCells[i] = pixelByte;

			const pixelType = pixelByte & 0x07;

			// Walls take no further part here: their segment id lives in the raster, and the room
			// metrics below are counted over floor cells only.
			if (pixelType === 0 || pixelType === 1) continue;

			const segmentID = (pixelByte & 248) >> 3;
			segmentIDsInImage.add(segmentID);

			// Calculate UN-SCALED pixel coordinates relative to the data block (0, 0)
			const x = i % width_px;
			const y = Math.floor(i / width_px);

			const bb = segBB[segmentID];
			if (!bb) {
				segBB[segmentID] = { minX: x, maxX: x, minY: y, maxY: y, count: 1 };
			} else {
				if (x < bb.minX) bb.minX = x;
				if (x > bb.maxX) bb.maxX = x;
				if (y < bb.minY) bb.minY = y;
				if (y > bb.maxY) bb.maxY = y;
				bb.count++;
			}
		}

		// The raster is what gets published; the three cell lists are derived from it at every
		// reader. Only when it has to be dropped do the lists go on the wire in its place, because a
		// map with neither draws as an empty picture - see `imagePixels`.
		const raster = this.buildSegmentRaster(rasterCells, width_px, height_px);
		if (raster) parameters.raster = raster;
		else parameters.pixels = imagePixelsFromCells(rasterCells);

		// --- Process all found segments ---

		for (const segId of segmentIDsInImage) {
			if (segId === 0) continue; // Skip "no segment"

			const bb = segBB[segId];
			if (!bb) continue;

			const centerX_px = Math.round((bb.minX + bb.maxX) / 2);
			const centerY_px = Math.round((bb.minY + bb.maxY) / 2);

			// This logic MUST match the working localCoordsToRobotCoords formula
			// x_robot = (center_x_px + offset_x_px) * MM_PER_PIXEL
			// y_robot = ((height_px / scale) + top_px - center_y_px) * MM_PER_PIXEL

			const centerX_robot = Math.round((centerX_px + left) * MM_PER_PIXEL);

			// NOTE: The map creator scales dimensions.height by map_scale, which cancels out:
			// (height_px * scale / scale) = height_px
			const centerY_robot = Math.round((centerY_px + top) * MM_PER_PIXEL);

			let roomName = "";
			const mapping = mappedRooms?.find(([id]) => parseInt(id) === segId);
			if (mapping) {
				const roomApiID = mapping[1];
				const roomObj = roomIDsAll.find((r) => String(r.id) === String(roomApiID));
				roomName = roomObj?.name || "";
			}

			parameters.segments.list.push({
				id: segId,
				name: roomName,
				center: [centerX_robot, centerY_robot], // Store correct MM coordinates
				count: bb.count,
				bounds: { minX: bb.minX, maxX: bb.maxX, minY: bb.minY, maxY: bb.maxY },
			});
		}

		return parameters;
	}

	/**
	 * Run-length codes the grid, unless the result would be too big to put in a state.
	 *
	 * A floor plan is made of long runs of the same value, so the coding is normally two orders of
	 * magnitude smaller than the cells it replaces. A grid without that structure is not a floor
	 * plan, but a state this adapter writes should not be able to balloon on unexpected input
	 * either - hence {@link MAX_RASTER_RUN_VALUES}, which no real map comes near.
	 * @param cells One byte per grid cell, row-major.
	 * @param width Cells per row.
	 * @param height Rows.
	 * @returns The coded raster, or `undefined` when it would exceed the ceiling.
	 */
	private buildSegmentRaster(cells: Uint8Array, width: number, height: number): SegmentRaster | undefined {
		if (cells.length !== width * height || cells.length === 0) return undefined;

		const runs = encodeRasterRuns(cells);
		if (runs.length > MAX_RASTER_RUN_VALUES) return undefined;

		return { encoding: "rle", width, height, runs };
	}

	private parsePathBlock(blockBuffer: Buffer, buf: Buffer, dataPosition: number, length: number): PathBlock {
		const pathData: PathBlock = {
			current_angle: this.getAngle(blockBuffer),
			points: [],
		};
		const pathDataPosition = dataPosition + OFFSETS.PATH;

		for (let i = 0; i < length; i += 4) {
			pathData.points.push(this.getPointInPath(buf, pathDataPosition + i));
		}

		if (pathData.points.length >= 2) {
			const last = pathData.points[pathData.points.length - 1];
			const secondLast = pathData.points[pathData.points.length - 2];
			pathData.current_angle = (Math.atan2(last[1] - secondLast[1], last[0] - secondLast[0]) * 180) / Math.PI;
		}

		return pathData;
	}

	private extractObstacles(buf: Buffer, offset: number): Obstacle[] {
		const obstacleCount = this.getCount(buf);
		const obstacles: Obstacle[] = [];
		for (let i = 0; i < obstacleCount * 28; i += 28) {
			const obstacle: Obstacle = [
				buf.readUInt16LE(offset + i),
				buf.readUInt16LE(offset + i + 2),
				buf.readUInt16LE(offset + i + 4),
				buf.readUInt16LE(offset + i + 6),
				buf.readUInt16LE(offset + i + 8),
				buf.readUInt16LE(offset + i + 10),
				buf.toString("utf-8", offset + i + 12, offset + i + 12 + 16),
			];
			obstacles.push(obstacle);
		}
		return obstacles;
	}

	private getStroyPt(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const points: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 8;
			points.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2), // y
				buf.readUInt32LE(base + 4) // code
			]);
		}
		return points;
	}

	private getDirtyRect(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 18;
			data.push([
				buf.readUInt16LE(base), // type
				buf.readUInt16LE(base + 2), // x1
				buf.readUInt16LE(base + 4), // y1
				buf.readUInt16LE(base + 6), // x2
				buf.readUInt16LE(base + 8), // y2
				buf.readUInt16LE(base + 10), // x3
				buf.readUInt16LE(base + 12), // y3
				buf.readUInt16LE(base + 14), // x4
				buf.readUInt16LE(base + 16) // y4
			]);
		}
		return data;
	}

	private getBrushPt(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const points: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 4;
			points.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2) // y
			]);
		}
		return points;
	}

	private getDirtyNew(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			const hasImage = buf.readUInt8(base + 18) !== 0;
			data.push([
				buf.readUInt16LE(base), // type
				buf.readUInt16LE(base + 2), // x1
				buf.readUInt16LE(base + 4), // y1
				buf.readUInt16LE(base + 6), // x2
				buf.readUInt16LE(base + 8), // y2
				buf.readUInt16LE(base + 10), // x3
				buf.readUInt16LE(base + 12), // y3
				buf.readUInt16LE(base + 14), // x4
				buf.readUInt16LE(base + 16), // y4
				hasImage ? buf.toString("ascii", base + 18, base + 18 + 16).replace(/\0/g, "") : "" // imageid
			]);
		}
		return data;
	}

	private getMopErrPt(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const points: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 6;
			points.push([
				buf.readUInt8(base), // errorid
				buf.readUInt8(base + 1), // suberrorid
				buf.readUInt16LE(base + 2), // x
				buf.readUInt16LE(base + 4) // y
			]);
		}
		return points;
	}

	private getEraserZone(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			data.push([
				buf.readUInt32LE(base), // type
				buf.readUInt16LE(base + 4), // x1
				buf.readUInt16LE(base + 6), // y1
				buf.readUInt16LE(base + 8), // x2
				buf.readUInt16LE(base + 10), // y2
				buf.readUInt16LE(base + 12), // x3
				buf.readUInt16LE(base + 14), // y3
				buf.readUInt16LE(base + 16), // x4
				buf.readUInt16LE(base + 18) // y4
			]);
		}
		return data;
	}

	private getLongCarpet(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			data.push([
				buf.readUInt32LE(base), // id
				buf.readUInt32LE(base + 4), // total
				buf.readUInt32LE(base + 8) // longhaired
			]);
		}
		return data;
	}

	private getDsSides(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			data.push([
				buf.readUInt8(base), // id
				buf.readUInt8(base + 1),
				buf.readUInt8(base + 2),
				buf.readUInt8(base + 3)
			]);
		}
		return data;
	}

	private getSteeringPt(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			data.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2), // y
				buf.readUInt8(base + 4) // type
			]);
		}
		return data;
	}

	private getSensorInfo(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			data.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2), // y
				buf.readUInt8(base + 4), // type
				buf.readUInt8(base + 5) // status
			]);
		}
		return data;
	}

	private getTidyZones(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			data.push([
				buf.readUInt16LE(base), // id
				buf.readUInt16LE(base + 2), // type
				buf.readUInt16LE(base + 4), // x1
				buf.readUInt16LE(base + 6), // y1
				buf.readUInt16LE(base + 8), // x2
				buf.readUInt16LE(base + 10), // y2
				buf.readUInt16LE(base + 12), // x3
				buf.readUInt16LE(base + 14), // y3
				buf.readUInt16LE(base + 16), // x4
				buf.readUInt16LE(base + 18) // y4
			]);
		}
		return data;
	}

	private getGarbage(buf: Buffer, offset: number, length: number): any[] {
		const count = this.getCount(buf);
		if (count === 0) return [];
		const len = length / count;
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * len;
			data.push([
				buf.readUInt16LE(base), // robot x
				buf.readUInt16LE(base + 2), // robot y
				buf.readUInt16LE(base + 4), // garbage x
				buf.readUInt16LE(base + 6), // garbage y
				buf.readUInt16LE(base + 8), // tidyzone id
				buf.readUInt16LE(base + 10), // garbage id
				buf.toString("utf-8", base + 12, base + len) // tag
			]);
		}
		return data;
	}

	private getZoneLines(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const data: any[] = [];
		let toffset = 0;
		for (let i = 0; i < count; i++) {
			const base = offset + toffset;
			const id = buf.readUInt16LE(base);
			const num = buf.readUInt16LE(base + 2);
			const ptLen = buf.readUInt16LE(base + 4);
			const points: any[] = [];
			for (let j = 0; j < num; j++) {
				const pOff = base + 6 + j * ptLen;
				points.push([
					buf.readUInt16LE(pOff), // x
					buf.readUInt16LE(pOff + 2), // y
					buf.readUIntLE(pOff + 4, ptLen - 4) // type
				]);
			}
			toffset += 6 + num * ptLen;
			data.push({ id, num, ptLen, points });
		}
		return data;
	}

	private getObstaclesOld(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const obstacles: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 5;
			obstacles.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2), // y
				buf.readUInt8(base + 4) // type
			]);
		}
		return obstacles;
	}

	private getIgnoredObstacles2(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const obstacles: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 6;
			obstacles.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2), // y
				buf.readUInt16LE(base + 4) // type
			]);
		}
		return obstacles;
	}

	private getSmartZone(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const zones: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 18;
			zones.push({
				zid: buf.readUInt16LE(base),
				range: [
					buf.readUInt16LE(base + 2),
					buf.readUInt16LE(base + 4),
					buf.readUInt16LE(base + 6),
					buf.readUInt16LE(base + 8)
				]
			});
		}
		return zones;
	}

	/**
	 * Reads block type 25. The byte offsets are unchanged - they always matched the app - but the
	 * result is a named object now, see {@link Furniture} for why.
	 */
	private getFurnitures(buf: Buffer, offset: number): Furniture[] {
		const count = this.getCount(buf);
		const furnitures: Furniture[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 23;
			furnitures.push({
				x1: buf.readUInt16LE(base),
				y1: buf.readUInt16LE(base + 2),
				x2: buf.readUInt16LE(base + 4),
				y2: buf.readUInt16LE(base + 6),
				x3: buf.readUInt16LE(base + 8),
				y3: buf.readUInt16LE(base + 10),
				x4: buf.readUInt16LE(base + 12),
				y4: buf.readUInt16LE(base + 14),
				percent: buf.readUInt16LE(base + 16),
				type: buf.readUInt8(base + 18),
				subType: buf.readUInt8(base + 19),
				edit: buf.readUInt8(base + 20),
				id: buf.readUInt8(base + 21),
				hasAngle: buf.readUInt8(base + 22)
			});
		}
		return furnitures;
	}

	private getEnemies(buf: Buffer, offset: number): any[] {
		const count = this.getCount(buf);
		const enemies: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 6;
			enemies.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2), // y
				buf.readUInt16LE(base + 4) // type
			]);
		}
		return enemies;
	}

	private getFloorDirection(buf: Buffer, offset: number, length: number): any[] {
		const count = length / 3; // No count header? Code says data.length / 3
		const data: any[] = [];
		for (let i = 0; i < count; i++) {
			const base = offset + i * 3;
			data.push([
				buf.readUInt8(base), // blockid
				buf.readUInt16LE(base + 1) // direction
			]);
		}
		return data;
	}

	private getPatrol(buf: Buffer, offset: number): any[] {
		// Header structure inside data:
		// taskId: 4 bytes (at offset)
		// num: 1 byte (at offset + 4)
		// points: num * 278 bytes (starting at offset + 5)

		if (buf.length < offset + 5) {
			return [];
		}

		const num = buf.readUInt8(offset + 4);
		const points: any[] = [];
		const dataStart = offset + 5;
		const pointSize = 278; // Fixed size per point based on observation

		for (let i = 0; i < num; i++) {
			const base = dataStart + i * pointSize;

			// Ensure we don't read past the buffer
			if (base + 4 > buf.length) {
				this.adapter.rLog("MapManager", null, "Warn", "1.0", undefined, `[MapDataParser] getPatrol: buffer too short for point ${i + 1}/${num}`, "warn");
				break;
			}

			points.push([
				buf.readUInt16LE(base), // x
				buf.readUInt16LE(base + 2) // y
			]);
		}
		return points;
	}

	// --------------------
	// Binary Read Helpers
	// --------------------

	private getXYPositions(buf: Buffer, xOffset: number, yOffset: number): [number, number] {
		const xPosition = buf.readInt32LE(xOffset);
		const yPosition = buf.readInt32LE(yOffset);
		return [xPosition, yPosition];
	}

	/** Reads unscaled pixel dimensions and offsets from the image block header. */
	private getMapSizes(buf: Buffer, offset: number): { left: number; top: number; width: number; height: number } {
		const top = buf.readInt32LE(offset - 0x10); // Unscaled Pixel Offset Y
		const left = buf.readInt32LE(offset - 0x0c); // Unscaled Pixel Offset X
		const height = buf.readInt32LE(offset - 0x08); // Unscaled Pixel Height
		const width = buf.readInt32LE(offset - 0x04); // Unscaled Pixel Width
		return { left, top, width, height };
	}

	private getPointInPath(buf: Buffer, dataPosition: number): [number, number] {
		const x = buf.readUInt16LE(dataPosition);
		const y = buf.readUInt16LE(dataPosition + 2);
		return [x, y];
	}

	private getCount(buf: Buffer): number {
		return buf.readUInt32LE(OFFSETS.TYPE_COUNT);
	}

	private getPixelType(buf: Buffer, dataPosition: number): number {
		return buf.readUInt8(dataPosition) & 0x07;
	}

	private getAngle(buf: Buffer): number {
		return buf.readInt32LE(OFFSETS.ANGLE);
	}

	private getGoToTarget(buf: Buffer): [number, number] {
		return [buf.readUInt16LE(OFFSETS.TARGET_X), buf.readUInt16LE(OFFSETS.TARGET_Y)];
	}

	/**
	 * Reads a block of fixed-size zone records: `count` records of `values` little-endian uint16 each.
	 *
	 * ## Why this is one function and not a loop at each call site
	 *
	 * Four block types - `CUSTOM_CARPET`, `CL_FORBIDDEN_ZONES`, `SMART_DS` and `EXT_ZONES` - used to
	 * be read with a single unguarded `getForbiddenZone` call and no count at all. That is wrong in
	 * both directions, and the second one is the damaging one:
	 *
	 *  - With more than one record, only the first arrived.
	 *  - **With no records at all it invented one.** An empty block is `length = 0`, but the read
	 *    happened anyway and took its 16 bytes from whatever followed - the header of the next
	 *    block. Measured on the reference device's own map, an empty `CUSTOM_CARPET` came back as
	 *    `[28, 12, 1220, 0, 5, 0, 31712, 23618]`, which is `type = 28`, `hlength = 12`,
	 *    `length = 1220`, `count = 5` of the `DS_FORBIDDEN_ZONES` block behind it, plus its first
	 *    two coordinates.
	 *
	 * That mattered beyond a wrong number, because `CL_FORBIDDEN_ZONES` is one of
	 * `UNREPRODUCIBLE_BLOCKS`: `readOverlaysFromMap` refuses to touch the zones of a map that
	 * carries one, since `save_map` would delete it. A phantom record made that refusal fire on a
	 * map whose block is empty, which takes the whole zone editor away - no adding, moving or
	 * deleting of no-go zones, no-mop zones and virtual walls - and names a block the map does not
	 * really have.
	 *
	 * The guard against the block length is therefore not decoration: it is what stops a record
	 * count from reaching past its own block. `count` stays the authority where the two agree,
	 * which is every real map measured so far.
	 * @param buf The whole map buffer.
	 * @param blockBuffer This block, for its header.
	 * @param dataStart Absolute offset of the first record.
	 * @param length Payload length of the block, in bytes.
	 * @param values Uint16 values per record - 4 for an axis-parallel pair of corners, 8 for four corners.
	 * @returns One array of `values` numbers per record; empty when the block carries none.
	 */
	private readZoneRecords(buf: Buffer, blockBuffer: Buffer, dataStart: number, length: number, values: number): number[][] {
		const stride = values * 2;
		const fits = Math.floor(length / stride);
		const count = Math.min(this.getCount(blockBuffer), fits);
		const zones: number[][] = [];
		for (let i = 0; i < count; i++) {
			zones.push(this.readUInt16LE(buf, dataStart + i * stride, 0, values));
		}
		return zones;
	}

	private getSingleByteOffset(buf: Buffer): number {
		return buf.readUInt8(2);
	}

	private getTwoByteOffsets(buf: Buffer): [number, number] {
		return [buf.readUInt8(2), buf.readUInt8(4)];
	}

	private getNonceData(buf: Buffer): NonceData[] {
		const sections: NonceData[] = [];
		for (let i = 12; i < buf.length; i += 5) {
			const type = buf[i];
			const unixTime = buf.readUInt32LE(i + 1);
			sections.push({ type, unixTime });
		}
		return sections;
	}

	private readUInt16LE(buf: Buffer, dataPosition: number, offset: number, count: number): number[] {
		const result: number[] = [];
		for (let j = 0; j < count; j++) {
			result.push(buf.readUInt16LE(dataPosition + offset + j * 2));
		}
		return result;
	}

	private readUInt8(buf: Buffer, dataPosition: number, offset: number, count: number): number[] {
		const array: number[] = [];
		for (let j = 0; j < count; j++) {
			array.push(buf.readUInt8(offset + dataPosition + j));
		}
		return array;
	}
}
