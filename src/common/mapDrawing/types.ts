/**
 * Single source for V1 map drawing: one interface, one orchestration (drawMapV1).
 * Backend uses CanvasMapRenderer; frontend uses SVGMapRenderer. No duplicate drawing logic.
 */

import type { MapSurfaceColors } from "./constants";

export interface DrawRect {
	x: number;
	y: number;
	w: number;
	h: number;
	fill: string;
}

export interface DrawCarpetInput {
	/** Pixel positions (x,y) for each carpet tile (top-left of VISUAL_BLOCK_SIZE block). */
	positions: { x: number; y: number }[];
}

/** Path layer for SVG (which D3 group to draw into). */
export type PathLayer = "mop" | "main" | "backwash" | "pure";

export interface DrawPathInput {
	segments: { x: number; y: number }[][];
	stroke: string;
	lineWidth: number;
	opacity?: number;
	dashed?: boolean;
	/** Frontend: which path group (main-path, mop-path, etc.). Ignored by Canvas renderer. */
	pathLayer?: PathLayer;
}

export interface DrawRobotInput {
	x: number;
	y: number;
	angle: number; // degrees, for rotation
}

export interface DrawChargerInput {
	x: number;
	y: number;
	/**
	 * Which way the dock faces, in degrees, straight out of the map's `CHARGER_LOCATION` block.
	 *
	 * Optional because only the SVG renderer turns the artwork; a renderer that draws a symmetric
	 * symbol simply ignores it, and a map pipeline that reports no angle leaves it out.
	 */
	angle?: number;
}

export interface DrawGoToPinInput {
	x: number;
	y: number;
}

export interface DrawObstacleInput {
	x: number;
	y: number;
	typeOrSuffix: number | string;
	/** Optional: backend loads from adapter; frontend uses asset URL. */
	imageHref?: string | null;
	imageSize?: number;
	hideBackground?: boolean;
	/** Frontend: full obstacle row for D3 data binding (e.g. [x, y, type, ...] for click handler). */
	obstacleData?: unknown;
}

export interface DrawRoomLabelInput {
	segmentId: number;
	x: number;
	y: number;
	text: string;
	iconHref?: string | null;
	bubbleFill?: string;
	bubbleStroke?: string;
	textFill?: string;
	badgeText?: string | null;
	bubbleRadius?: number;
	iconSize?: number;
	gap?: number;
	bubbleCenterOffsetX?: number;
	textOffsetX?: number;
	badgeCenterOffsetX?: number;
	badgeCenterOffsetY?: number;
}

export interface DrawZoneRectInput {
	x: number;
	y: number;
	w: number;
	h: number;
	fill: string;
	stroke: string;
}

/** Virtual wall: line from (x1,y1) to (x2,y2). */
export interface DrawVirtualWallInput {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	stroke: string;
	lineWidth: number;
}

export interface DrawPredictedPathInput {
	points: { x: number; y: number }[];
	stroke: string;
	lineWidth: number;
	dashArray: number[];
}

/**
 * Renderer interface for V1 map. Backend implements with Canvas; frontend with SVG (D3 groups).
 * All coordinates are in the same space (scaled pixel / display).
 */
export interface IMapRenderer {
	drawFloor(rects: DrawRect[]): void;
	drawSegmentRects(rects: DrawRect[]): void;
	drawCarpet(input: DrawCarpetInput): void;
	drawPath(input: DrawPathInput): void;
	drawRobot(input: DrawRobotInput): void;
	drawCharger(input: DrawChargerInput): void;
	drawGoToPin(input: DrawGoToPinInput): void;
	drawObstacles(items: DrawObstacleInput[]): void | Promise<void>;
	drawRoomLabels(labels: DrawRoomLabelInput[]): void;
	drawActiveZones(zones: DrawZoneRectInput[]): void;
	drawRestrictedZones(zones: DrawZoneRectInput[], virtualWalls: DrawVirtualWallInput[]): void;
	drawPredictedPath(input: DrawPredictedPathInput): void;
	/** Backend: return base64 PNG after segments (before carpet). Frontend: return null. */
	getCleanSnapshot?(): string | null;
}

export interface DrawMapV1Options {
	/** If true, mapData.IMAGE.dimensions are already in pixel space (scaled). Default false = grid units. */
	dimensionsAreScaled?: boolean;
	/** Scale factor (default VISUAL_BLOCK_SIZE). */
	scaleFactor?: number;
	/** Segment fill color per segment id. Backend provides this (theme, adjacency, currentlyCleaned). */
	getSegmentColor?(segmentId: number): string | undefined;
	/** Room name per segment id (for labels). */
	roomNames?: Map<number, string> | Record<number, string>;
	/** Precomputed room labels (e.g. frontend: from segments.list + robotToSvg). If set, used instead of building from pixels. */
	roomLabels?: DrawRoomLabelInput[];
	/**
	 * Surface colours (floor, walls, driven path). Omitted means the light set, i.e. the picture
	 * the adapter produced before the dark scheme existed.
	 */
	colors?: MapSurfaceColors;
	/**
	 * Leaves `FORBIDDEN_ZONES`, `NO_MOP_ZONE` and `VIRTUAL_WALLS` to the caller.
	 *
	 * The admin tab draws those three in a layer of its own, where they are controls rather than
	 * decoration: they can be selected, turned and deleted. Drawing them here as well would put a
	 * second, unturned copy of every zone underneath - the rectangles above are reduced to the
	 * bounding box of their four corners, which is a different shape as soon as a zone is turned.
	 *
	 * Omitted, and therefore false, everywhere else: the adapter's own PNG has no such layer and
	 * must keep drawing all five overlays.
	 */
	editableZonesDrawnElsewhere?: boolean;
}
