import type { Canvas, CanvasRenderingContext2D } from "@napi-rs/canvas";
import { createCanvas, Image, loadImage } from "@napi-rs/canvas";
import { drawMapV1 } from "../../../common/mapDrawing/drawMapV1";
import { getMapSurfaceColors, hexToRgbaString, VISUAL_BLOCK_SIZE } from "../../../common/mapDrawing/constants";
import * as Images from "../../../common/images";
import { Roborock } from "../../../main";
import { assignRoborockRoomColorsToHex } from "../../roomColoring";
import { ROBOROCK_PALETTE } from "../MapHelper";
import { LEGACY_COLORS } from "../../../common/mapDrawing/constants";
import { fadeHexTowards, fadeSurfaceColors, getSelectionFadeFactor } from "../../../common/mapDrawing/roomSelectionFade";
import { floorFolderId, groupSelectedRoomsByMapFlag, normalizeMapFlag, sortRoomIds } from "../roomKey";
// Do not use "import { X, type Y }" — ioBroker runtime (esbuild-register) does not support inline type in named imports
import { CanvasMapRenderer } from "./CanvasMapRenderer";

const OFFSET = 60;
const MAX_BLOCK_NUM = 32;

/** How far the unselected part of the map is mixed into the ground, and which ground that is. */
interface SegmentFade {
	/** Share of the original colour that survives: the app's 0.3 (light) or 0.7 (dark). */
	keep: number;
	/** The colour everything fades towards - the map's own floor. */
	ground: string;
}

const ORG_COLORS = ROBOROCK_PALETTE;

interface CanvasMapOptions {
	selectedMap?: any;
	mappedRooms?: any;
	model?: string;
	duid?: string;
	options?: {
		FLOORCOLOR?: string;
		WALLCOLOR?: string;
		PATHCOLOR?: string;
		newmap?: boolean;
		ROBOT?: string;
	};
}

// Define a custom interface to handle missing type definitions in @napi-rs/canvas
interface ExtendedContext2D extends CanvasRenderingContext2D {
	drawImage(image: Image | Canvas, dx: number, dy: number, dw?: number, dh?: number): void;
	canvas: Canvas;
	antialias?: string;
}

// -----------------------------------------------------------------------------
// Map Creator Class
// -----------------------------------------------------------------------------

export class MapBuilder {
	adapter: Roborock;
	colors: { floor: string; obstacle: string; path: string; newmap: boolean };

	constructor(adapter: Roborock) {
		this.adapter = adapter;
		this.colors = {
			floor: LEGACY_COLORS.floor,
			obstacle: LEGACY_COLORS.obstacle,
			path: LEGACY_COLORS.path,
			newmap: true,
		};
	}

	// --------------------
	// Segment color (for drawMapV1 getSegmentColor callback)
	// --------------------

	private buildGetSegmentColor(mapdata: any, highlightedBlocks: number[], fade: SegmentFade | null): (segmentId: number) => string | undefined {
		const image = mapdata.IMAGE;
		if (!image.pixels?.segments?.length) return () => undefined;
		const segmentsData: Record<number, { count: number }> = {};
		image.pixels.segments.forEach((px: number) => {
			const segnum = px >>> 21;
			if (segnum >= MAX_BLOCK_NUM) return;
			if (!segmentsData[segnum]) segmentsData[segnum] = { count: 0 };
			segmentsData[segnum].count++;
		});
		const segmentNums = Object.keys(segmentsData).map(Number);
		const maxId = segmentNums.length ? Math.max(...segmentNums) : 0;
		const matrixSize = MAX_BLOCK_NUM;
		const adjacencyMatrix = this.buildAdjacencyMatrix(image.pixels.segments, image.dimensions.width, image.dimensions.height, maxId);
		const pointsCount = new Array(matrixSize).fill(0);
		for (const segStr of segmentNums) {
			if (segStr >= 0 && segStr < matrixSize) pointsCount[segStr] = segmentsData[segStr].count;
		}
		const neighborInfo = new Array(matrixSize * matrixSize).fill(0);
		for (let i = 0; i < matrixSize; i++) {
			for (let j = 0; j < matrixSize; j++) {
				if (adjacencyMatrix[i]?.[j] === 1) neighborInfo[i * matrixSize + j] = 1;
			}
			if (pointsCount[i] > 0) neighborInfo[i * matrixSize + i] = 1;
		}
		const coloring = this.colors.newmap
			? assignRoborockRoomColorsToHex({ maxBlockNum: matrixSize, neighborInfo, pointsCount }, { oneBased: true })
			: { getColor: () => "#CCCCCC" };
		const segColorHex: Record<number, string> = {};
		for (let i = 0; i < matrixSize; i++) {
			if (pointsCount[i] > 0) {
				if (this.colors.newmap) {
					let theme = this.adapter.config.map_theme;
					if (theme !== "light") theme = "dark";
					const isSelectionMode = highlightedBlocks?.length > 0;
					const isHighlighted = isSelectionMode && highlightedBlocks?.includes(i);
					const paletteType: "light_normal" | "light_highlight" | "dark_normal" | "dark_highlight" = isSelectionMode
						? (isHighlighted ? (theme === "dark" ? "dark_highlight" : "light_highlight") : theme === "dark" ? "dark_normal" : "light_normal")
						: theme === "dark" ? "dark_highlight" : "light_highlight";
					const hex = coloring.getColor(i, paletteType);
					// The second half of the app's effect: the muted palette alone is not what makes
					// the unselected rooms recede - they also fade into the ground (see
					// src/common/mapDrawing/roomSelectionFade.ts).
					segColorHex[i] = fade && !isHighlighted ? fadeHexTowards(hex, fade.ground, fade.keep) : hex;
				} else {
					if (highlightedBlocks?.includes(i)) {
						segColorHex[i] = i >= 0 && i < ORG_COLORS.length ? (ORG_COLORS[i] || "#CCCCCC") : "#CCCCCC";
					}
				}
			}
		}
		return (segmentId: number) => {
			const hex = segColorHex[segmentId];
			return hex ? hexToRgbaString(hex) : undefined;
		};
	}

	private buildAdjacencyMatrix(segmentPixels: number[], width: number, height: number, maxIdFromCaller: number): number[][] {
		let maxSegInPixels = 0;
		for (const px of segmentPixels) {
			const segnum = px >>> 21;
			if (segnum > maxSegInPixels) maxSegInPixels = segnum;
		}
		const size = Math.max(maxIdFromCaller + 1, maxSegInPixels + 1, MAX_BLOCK_NUM);

		const matrix: number[][] = Array.from({ length: size }, () => Array(size).fill(0));
		const segMap = new Int16Array(width * height).fill(-1);

		for (const px of segmentPixels) {
			const pixelIndex = px & 0x1fffff;
			const segnum = px >>> 21;
			if (pixelIndex >= 0 && pixelIndex < segMap.length && segnum < size) {
				segMap[pixelIndex] = segnum;
			}
		}

		for (let i = 0; i < segMap.length; i++) {
			const segA = segMap[i];
			if (segA < 0) continue;
			const x = i % width;
			const y = Math.floor(i / width);

			if (segA < size) matrix[segA][segA] = 1;

			if (y > 0) {
				const segB = segMap[i - width];
				if (segB >= 0 && segA !== segB && segA < size && segB < size) {
					matrix[segA][segB] = 1;
					matrix[segB][segA] = 1;
				}
			}
			if (x > 0) {
				const segB = segMap[i - 1];
				if (segB >= 0 && segA !== segB && segA < size && segB < size) {
					matrix[segA][segB] = 1;
					matrix[segB][segA] = 1;
				}
			}
		}
		return matrix;
	}

	// --------------------
	// Main Map Generation (single source: drawMapV1 + CanvasMapRenderer)
	// --------------------

	public async canvasMap(mapdata: any, params: CanvasMapOptions = {}): Promise<[string, string, string]> {
		const { mappedRooms = null, options = {} } = params;

		if (!mapdata || !mapdata.IMAGE || !mapdata.IMAGE.dimensions) {
			this.adapter.rLog("MapManager", params.model || null, "Warn", undefined, undefined, "Received invalid or empty map data, cannot generate map.", "warn");
			const errorCanvas = createCanvas(1, 1).toDataURL();
			return [errorCanvas, errorCanvas, errorCanvas];
		}

		this.applyOptions(options);

		const [imgRobot, imgCharger, imgGoToPin] = await this.loadImages(options.ROBOT);

		// Grid dimensions (unchanged in mapdata for web UI)
		const gridW = mapdata.IMAGE.dimensions.width;
		const gridH = mapdata.IMAGE.dimensions.height;
		const canvasWidth = gridW * VISUAL_BLOCK_SIZE;
		const canvasHeight = gridH * VISUAL_BLOCK_SIZE;

		const canvas = createCanvas(canvasWidth, canvasHeight);
		const ctx = canvas.getContext("2d") as unknown as ExtendedContext2D;
		ctx.imageSmoothingEnabled = false;
		if ("antialias" in ctx) ctx.antialias = "none";

		const scheme = this.resolveColorScheme();
		const surfaceColors = getMapSurfaceColors(scheme);
		const highlightedBlocks = await this.resolveHighlightedBlocks(mapdata, params.duid);
		// No selection means no fade at all: the picture stays byte for byte the one the adapter
		// draws today. The app does the same - its opacity stays at the 1 it was initialised with.
		const fade: SegmentFade | null = highlightedBlocks.length
			? { keep: getSelectionFadeFactor(scheme), ground: surfaceColors.floor }
			: null;

		const getSegmentColor = this.buildGetSegmentColor(mapdata, highlightedBlocks, fade);
		const roomNames = await this.buildRoomNamesMap(mappedRooms, params.duid);

		const renderer = new CanvasMapRenderer({
			ctx: ctx as any,
			robotImage: imgRobot,
			chargerImage: imgCharger,
			goToPinImage: imgGoToPin,
			loadObstacleImage: (suffix, model) => this.loadObstacleImageForRenderer(suffix, model),
			model: params.model,
			logWarn: (msg) => this.adapter.rLog("MapManager", params.model || null, "Warn", undefined, undefined, msg, "debug"),
		});

		const t0 = Date.now();
		const result = await drawMapV1(mapdata, renderer, {
			scaleFactor: VISUAL_BLOCK_SIZE,
			dimensionsAreScaled: false,
			getSegmentColor,
			roomNames,
			// Walls fade with the rooms, the path does not - fadeSurfaceColors draws that line.
			// Everything drawn after the segments (carpet, path, zones, obstacle icons, robot,
			// charger, labels) keeps its own colours and therefore stays fully opaque, which is the
			// layer separation the app gets for free by dimming only its background image.
			colors: fade ? fadeSurfaceColors(surfaceColors, fade.keep) : surfaceColors,
		});
		const t1 = Date.now();

		const cleanMapUncroppedBase64 = renderer.getCleanSnapshot() ?? canvas.toDataURL();
		const fullMapUncroppedBase64 = canvas.toDataURL();

		const bounds = result.bounds
			? { minleft: result.bounds.minX, mintop: result.bounds.minY, maxleft: result.bounds.maxX, maxtop: result.bounds.maxY }
			: { minleft: 0, mintop: 0, maxleft: canvasWidth, maxtop: canvasHeight };
		const croppedMapBase64 = this.cropMap(canvas, ctx, bounds);

		if (t1 - t0 > 1000) {
			this.adapter.rLog("MapManager", params.model || null, "Warn", "MapProfiler", undefined, `[Slow Map] drawMapV1: ${t1 - t0}ms`, "debug");
		}

		return [cleanMapUncroppedBase64, fullMapUncroppedBase64, croppedMapBase64];
	}

	/**
	 * The segments that must keep their full colour while everything else fades.
	 *
	 * Two sources, exactly as in the app, which uses one and the same presentation for both
	 * (`_appanalysis/17-raumauswahl.md` section 2, `hasSelBlock` at A65:492632-492700):
	 *
	 * 1. **A run in progress** - the robot names the segments it is cleaning, and they win. While
	 *    the robot is working, what it is working on is what the picture has to show; a selection
	 *    left over in the room switches must not overpaint that.
	 * 2. **The room switches** `Devices.<duid>.floors.<mapFlag>.<roomId>` - the same states
	 *    `app_segment_clean` reads to decide what to clean, so the map shows what a start would do.
	 *
	 * Only the switches of the floor this very map belongs to are read. Room ids repeat across the
	 * maps of one robot, so the switches of another floor would highlight arbitrary rooms here (see
	 * src/lib/map/roomKey.ts). A map that does not know its floor therefore gets no selection at
	 * all rather than a guessed one - and history maps, which are drawn without a duid, never do.
	 * @param mapdata Parsed V1 map; `CURRENTLY_CLEANED_BLOCKS` and `mapFlag` are read from it.
	 * @param duid Device the map belongs to, when known.
	 * @returns Segment ids to keep vivid; empty when nothing is selected or running.
	 */
	private async resolveHighlightedBlocks(mapdata: any, duid?: string): Promise<number[]> {
		const cleaned = mapdata?.CURRENTLY_CLEANED_BLOCKS;
		if (Array.isArray(cleaned) && cleaned.length) return cleaned;

		const mapFlag = normalizeMapFlag(mapdata?.mapFlag);
		if (!duid || mapFlag === null || typeof this.adapter?.getStatesAsync !== "function") return [];

		try {
			const states = await this.adapter.getStatesAsync(`${this.adapter.namespace}.${floorFolderId(duid, mapFlag)}.*`);
			return sortRoomIds(groupSelectedRoomsByMapFlag(states).get(mapFlag));
		} catch (e: unknown) {
			// A map that cannot be drawn is worse than a map drawn without the highlight.
			this.adapter.rLog("MapManager", duid, "Warn", "Map", undefined, `Could not read the room selection for the highlight: ${this.adapter.errorMessage(e)}`, "debug");
			return [];
		}
	}

	/**
	 * The colour set this render should use.
	 *
	 * Read through a guard rather than called directly because `MapBuilder` is handed adapter
	 * stubs in tests, and a missing theme must degrade to the light set - the picture every
	 * existing installation already has - instead of failing the whole render.
	 * @returns `"light"` or `"dark"`.
	 */
	private resolveColorScheme(): "light" | "dark" {
		const adapter = this.adapter as unknown as { getMapColorScheme?: () => "light" | "dark" };
		return typeof adapter.getMapColorScheme === "function" ? adapter.getMapColorScheme() : "light";
	}

	private async buildRoomNamesMap(mappedRooms: any, duid?: string): Promise<Map<number, string> | undefined> {
		if (!mappedRooms || !Array.isArray(mappedRooms) || !this.adapter?.http_api) return undefined;
		const roomIDsAll = duid && this.adapter.http_api.isSharedDevice(duid)
			? await this.adapter.http_api.getSharedDeviceRooms(duid)
			: this.adapter.http_api.getMatchedRoomIDs(false);
		const map = new Map<number, string>();
		for (const mapping of mappedRooms) {
			const segIdStr = mapping[0];
			const roomID = mapping[1];
			const segnum = parseInt(String(segIdStr), 10);
			const roomObj = roomIDsAll.find((r: any) => String(r.id) === String(roomID));
			if (roomObj?.name) map.set(segnum, roomObj.name);
		}
		return map.size ? map : undefined;
	}

	private async loadObstacleImageForRenderer(suffix: string, model?: string): Promise<import("@napi-rs/canvas").Image | null> {
		const imagePath = await this.findObstacleImage(suffix, model);
		if (!imagePath) return null;
		return this.loadImageFromAdapterPath(imagePath);
	}

	private applyOptions(options: any) {
		if (options) {
			if (options.FLOORCOLOR) this.colors.floor = options.FLOORCOLOR;
			if (options.WALLCOLOR) this.colors.obstacle = options.WALLCOLOR;
			if (options.PATHCOLOR) this.colors.path = options.PATHCOLOR;
			this.colors.newmap = options.newmap ?? true;
		}
	}

	private async loadImages(robotType?: string) {
		let robotImgSource = Images.IMG_ROBOT_ORIGINAL;
		switch (robotType) {
			case "robot":
				robotImgSource = Images.IMG_ROBOT_DEFAULT;
				break;
			case "robot1":
				robotImgSource = Images.IMG_ROBOT1;
				break;
			case "tank":
				robotImgSource = Images.IMG_TANK;
				break;
			case "spaceship":
				robotImgSource = Images.IMG_SPACESHIP;
				break;
			case "robot2":
				robotImgSource = Images.IMG_ROBOT_2;
				break;
		}
		return Promise.all([loadImage(robotImgSource), loadImage(Images.IMG_CHARGER), loadImage(Images.IMG_GO_TO_PIN)]);
	}

	private static obstacleImageCache = new Map<string, string | null>();

	private async findObstacleImage(suffix: string, model?: string): Promise<string | null> {
		const cacheKey = `${model || "default"}_${suffix}`;
		if (MapBuilder.obstacleImageCache.has(cacheKey)) {
			return MapBuilder.obstacleImageCache.get(cacheKey)!;
		}

		if (!this.adapter?.name) return null;

		const assetModels = [model, "roborock.vacuum.a147"].filter((m): m is string => !!m);
		const fileNames = [
			`projects_comroborocktanos_resources_obstacle_new_p${suffix}.png`,
			`projects_comroborocktanos_resources_map_object_top_${suffix}.png`,
		];

		let foundPath: string | null = null;
		for (const fileName of fileNames) {
			for (const m of assetModels) {
				const potentialPaths = [
					`assets/${m}/drawable-mdpi/${fileName}`,
					`assets/${m}/drawable-hdpi/${fileName}`,
					`images/${fileName}`,
				];
				for (const imagePath of potentialPaths) {
					if (await this.adapter.fileExistsAsync(this.adapter.name, imagePath)) {
						foundPath = imagePath;
						break;
					}
				}
				if (foundPath) break;
			}
			if (foundPath) break;
		}

		MapBuilder.obstacleImageCache.set(cacheKey, foundPath);
		return foundPath;
	}

	private async loadImageFromAdapterPath(adapterPath: string): Promise<Image | null> {
		if (!this.adapter?.name) return null;
		try {
			const res = await this.adapter.readFileAsync(this.adapter.name, adapterPath);
			const buf = typeof res === "object" && res !== null && "file" in res ? (res as { file: Buffer }).file : Buffer.from(res as ArrayBuffer);
			return await loadImage(buf);
		} catch {
			return null;
		}
	}

	private cropMap(canvas: Canvas, ctx: ExtendedContext2D, bounds: { minleft: number; mintop: number; maxleft: number; maxtop: number }) {
		const { minleft, mintop, maxleft, maxtop } = bounds;
		const cropW = maxleft - minleft + 2 * OFFSET;
		const cropH = maxtop - mintop + 2 * OFFSET;

		if (cropW <= 0 || cropH <= 0 || !isFinite(cropW) || !isFinite(cropH)) {
			return canvas.toDataURL();
		}

		const sx = Math.max(0, minleft - OFFSET);
		const sy = Math.max(0, mintop - OFFSET);
		const maxWidth = canvas.width - sx;
		const maxHeight = canvas.height - sy;
		const finalCropW = Math.min(cropW, maxWidth);
		const finalCropH = Math.min(cropH, maxHeight);

		const canvasTrimmedFull = createCanvas(finalCropW, finalCropH);
		const ctxTrimmedFull = canvasTrimmedFull.getContext("2d");
		const trimmedDataFull = ctx.getImageData(sx, sy, finalCropW, finalCropH);
		ctxTrimmedFull.putImageData(trimmedDataFull, 0, 0);

		return canvasTrimmedFull.toDataURL();
	}
}
