import * as d3 from "d3";
import { localCoordsToRobotCoords, robotCoordsToLocalCoords } from "@adapter/common/coordTransformation";
import { drawMapV1 } from "@adapter/common/mapDrawing/drawMapV1";
import { IMG_CHARGER, IMG_GO_TO_PIN, IMG_ROBOT_ORIGINAL } from "@adapter/common/images";
import type { DrawObstacleInput, DrawRoomLabelInput, DrawVirtualWallInput } from "@adapter/common/mapDrawing/types";
import type { B01MapData } from "@adapter/lib/map/b01/types";
import { Q10_CANVAS_SCALE, Q10MapGeometry } from "@adapter/lib/map/q10/Q10MapGeometry";
import { floorScopeKey, normalizeMapFlag, normalizeRoomId, roomNameCacheKey } from "@adapter/lib/map/roomKey";
import type { DrawFurnitureInput } from "./SVGMapRenderer";
import { ROOM_LABEL_BASE_FONT, SVGMapRenderer } from "./SVGMapRenderer";
import { ROBOT_STATES, dockActivity, robotPhase } from "./robotStates";
import {
	LIVE_TRACK_STATE,
	buildLiveRobotPose,
	buildLiveTrackSegments,
	parseLiveSnapshot,
	type LiveSnapshot,
} from "./liveTrack";
import { furnitureAssetFileName, furnitureGraphic, furnitureRect } from "./furniture";
import type { Furniture } from "@adapter/lib/map/v1/types";

/**
 * Base path for the device artwork the AppPluginManager stores in the adapter's file storage
 * (`writeFileAsync("roborock", "assets/<model>/…")`).
 *
 * The tab is served from `…/adapter/roborock/tab.html`, while the file storage is reachable at
 * `…/files/roborock/…`. The relative prefix therefore has to climb two levels — the same way
 * ioBroker.javascript resolves its own downloads. Keeping it relative also survives an admin
 * that is mounted under a sub path by a reverse proxy, which an absolute `/files/…` would not.
 *
 * Exported so `MapEngine.assets.test.ts` can pin exactly that: the obstacle icons once shipped
 * with an absolute prefix and silently rendered as broken images in every installation.
 */
export const ASSET_BASE = "../../files/roborock/assets";
import type {
	ConsumablePartModel,
	DockControlModel,
	DockStatusModel,
	EngineConnection,
	MapEngineHost,
	ModeModel,
	ObstaclePhotoModel,
	RobotEntry,
	SelectOption,
	StatusModel,
} from "./types";

// Interfaces
// -----------------------------------------------------------------------------

interface MapData {
	IMAGE: {
		position: { left: number; top: number };
		dimensions: { height: number; width: number };
		segments: {
			list: SegmentInfo[];
		};
	};
	ROBOT_POSITION?: PositionBlock;
	CHARGER_LOCATION?: PositionBlock;
	PATH?: PathBlock;
	MOP_PATH?: number[];
	OBSTACLES2?: Array<[number, number, ...any]>;
	CARPET_MAP?: number[];
	/** Block type 25. The field names are the ones `MapParser` publishes, see {@link Furniture}. */
	FURNITURES?: Furniture[];
	model?: string; // e.g. roborock.vacuum.a147, for asset paths
	mapFlag?: number; // active map/floor this map belongs to; rooms are keyed by (mapFlag, roomId)
}

type Q10FrontendMapData = B01MapData & { model?: string };
type FrontendMapData = MapData | Q10FrontendMapData;

interface PositionBlock {
	position: [number, number];
	angle: number;
}

interface PathBlock {
	current_angle: number;
	points: [number, number][];
}

interface SegmentInfo {
	id: number;
	name: string;
	center: [number, number]; // Robot coordinates
}

interface Point {
	x: number;
	y: number;
}

interface Rect {
	id: number; // Unique ID for D3 data binding
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Q10OverlayObstacleData {
	kind: "q10Obstacle";
	type: "obstacle" | "skip" | "threshold" | "easycard" | "cliff";
	x: number;
	y: number;
	obstacleId?: string | number;
}

interface MapParams {
	scaleFactor: number;
	left: number;
	topMap: number;
	mapMaxY: number;
	imageHeight: number;
	imageWidth: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const VISUAL_BLOCK_SIZE = 3; // Scale factor for visualization

/**
 * Rectangles per zoned-clean run. Kept at five on purpose: the Roborock app caps zone
 * cleaning at five rectangles as well, and the robot answers an oversized payload without
 * any usable feedback. An unbounded UI would therefore silently build requests that may be
 * rejected, so the limit stays — but it is now shown to the user instead of being invisible.
 */
const MAX_ZONES = 5;

// Room name sizing. Every `_PX` below is a CSS pixel on screen, never a map unit - the two are
// not the same thing, and `MapEngine.roomLabelScreenFontPx()` explains why.

/** Viewport edge the target size refers to; a typical admin tab is around this tall. */
const ROOM_LABEL_REFERENCE_EDGE = 620;
/** On-screen size at that reference viewport: the Roborock app's "readable at arm's length". */
const ROOM_LABEL_TARGET_PX = 17;
/** Floor, so a narrow tab or a far zoomed-out map still yields readable names. */
const ROOM_LABEL_MIN_PX = 14;
/** Ceiling, so a name cannot grow wider than the room it belongs to. */
const ROOM_LABEL_MAX_PX = 26;
/** How much of a high `devicePixelRatio` is passed on; 1 would be the full ratio. */
const ROOM_LABEL_DENSITY_WEIGHT = 0.15;

/** Command objects the mode selectors are built from; all values come from `common.states`. */
const MODE_COMMANDS = [
	{ command: "set_custom_mode", statusKey: "fanPower", labelKey: "ui_fan_power" },
	{ command: "set_mop_mode", statusKey: "mopMode", labelKey: "ui_mop_mode" },
	{ command: "set_water_box_custom_mode", statusKey: "waterBoxMode", labelKey: "ui_water_flow" },
] as const;

type ModeStatusKey = (typeof MODE_COMMANDS)[number]["statusKey"];

/** One mode selector. `options` stays empty while the device publishes no `common.states`. */
interface ModeControl {
	command: string;
	statusKey: ModeStatusKey;
	labelKey: string;
	options: SelectOption[];
}

/**
 * Dock commands the panel offers. Nothing here is a model list: an entry only becomes visible
 * when the device handler actually published the command object, and the shape of that object
 * (button, switch or value with `common.states`) decides how it is rendered.
 */
const DOCK_COMMANDS: { command: string; key: string; fallback: string }[] = [
	{ command: "app_start_wash", key: "ui_dock_start_wash", fallback: "Start mop wash" },
	{ command: "app_stop_wash", key: "ui_dock_stop_wash", fallback: "Stop mop wash" },
	{ command: "app_start_mop_drying", key: "ui_dock_start_drying", fallback: "Start mop drying" },
	{ command: "app_stop_mop_drying", key: "ui_dock_stop_drying", fallback: "Stop mop drying" },
	{ command: "app_start_collect_dust", key: "ui_dock_start_dust", fallback: "Start dust collection" },
	{ command: "app_stop_collect_dust", key: "ui_dock_stop_dust", fallback: "Stop dust collection" },
	{ command: "app_set_dryer_status", key: "ui_dock_dryer", fallback: "Mop dryer" },
	{ command: "app_switch_dock_cool_fan", key: "ui_dock_cool_fan", fallback: "Dock cool fan" },
	{ command: "set_wash_towel_mode", key: "ui_dock_wash_mode", fallback: "Station cleaning mode" },
	{ command: "set_wash_water_temperature", key: "ui_dock_wash_temperature", fallback: "Wash water temperature" },
	{ command: "set_back_wash_mode", key: "ui_dock_back_wash_mode", fallback: "Backwash mode" },
];

/** Folder the consumable services publish their values in. */
const CONSUMABLES_FOLDER = "consumables";
/** Folder the consumable services publish their reset buttons in. */
const RESET_CONSUMABLES_FOLDER = "resetConsumables";
/** Folder the station status lives in; absent on devices without a dock. */
const DOCK_STATUS_FOLDER = "dockingStationStatus";

/** Suffixes the adapter appends to a consumable name, longest first (avoids "_work_time" eating "_work_times"). */
const CONSUMABLE_SUFFIXES = ["_work_times", "_work_time", "_dirty_time", "_life"];

/** Below this share of the declared lifetime a part counts as due. */
const CONSUMABLE_WARN_PERCENT = 10;

/** One published value of a consumable, e.g. remaining hours or remaining percent. */
interface ConsumableMetric {
	stateId: string;
	name: string;
	unit: string;
	min: number | null;
	max: number | null;
}

/** One physical part, grouping every value the adapter publishes for it. */
interface ConsumablePart {
	part: string;
	name: string;
	metrics: ConsumableMetric[];
	/** State name inside `resetConsumables`, or null when the device offers no reset. */
	resetCommand: string | null;
}

/** One dock command the device published; the shell decides how it looks. */
interface DockControl {
	command: string;
	stateId: string;
	label: string;
	kind: "button" | "switch" | "select";
	options: SelectOption[];
}

/** One station state shown in the panel. */
interface DockStatusRow {
	stateId: string;
	name: string;
	states: Record<string, string> | null;
	unit: string;
}

const UI_CONSTANTS = {
	ROBOT_SIZE_BASE: 5,
	CHARGER_SIZE_BASE: 3,
	OBSTACLE_RADIUS_BASE: 3,
	ZONE_STROKE_BASE: 1.5,
	ZONE_HANDLE_RADIUS_BASE: 5,
	PIN_WIDTH_BASE: 29,
	PIN_HEIGHT_BASE: 24,
	PIN_Y_OFFSET_BASE: 5,
	PATH_MOP_WIDTH_BASE: 6.5,
	PATH_MAIN_WIDTH_RATIO_BASE: 0.8,
	PATH_BACKWASH_WIDTH_BASE: 0.5,
};

/** Type → suffix (429.js); asset obstacle_new_p{suffix}.png */
const Q10_ROOM_TAG_BASE = [
	q10PackedArgbToCss(4279123053),
	q10PackedArgbToCss(4283645184),
	q10PackedArgbToCss(4286455337),
	q10PackedArgbToCss(4278537798)
] as const;
const Q10_ROOM_TAG_STROKE = [
	q10PackedArgbToCss(4278528336),
	q10PackedArgbToCss(4281147648),
	q10PackedArgbToCss(4284156949),
	q10PackedArgbToCss(4278202925)
] as const;
const Q10_ROOM_LABEL_LAYOUT = {
	bubbleRadius: 6,
	iconSize: 6,
	gap: 4,
	font: '900 12px "Segoe UI", sans-serif',
	widthPadding: 1
} as const;

function q10RoomTagAssetFileName(roomType: number): string {
	const normalized = Number.isInteger(roomType) && roomType >= 0 && roomType <= 11 ? roomType : 0;
	return `src_resources_map_images_light_maproomtag${normalized}.png`;
}

function q10PackedArgbToCss(color: number): string {
	const a = ((color >>> 24) & 0xff) / 255;
	const r = (color >>> 16) & 0xff;
	const g = (color >>> 8) & 0xff;
	const b = color & 0xff;
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

let q10RoomLabelMeasureContext: CanvasRenderingContext2D | null = null;

function measureQ10RoomLabelWidth(label: string): number {
	if (!q10RoomLabelMeasureContext) {
		const canvas = document.createElement("canvas");
		q10RoomLabelMeasureContext = canvas.getContext("2d");
	}
	if (!q10RoomLabelMeasureContext) return label.length * 8;
	q10RoomLabelMeasureContext.font = Q10_ROOM_LABEL_LAYOUT.font;
	return q10RoomLabelMeasureContext.measureText(label).width;
}

export const OBSTACLE_MAPPING: Record<number, string> = {
	[-99]: "99",
	0: "0",
	1: "1",
	2: "2",
	3: "3",
	4: "3",
	5: "5_cn",
	9: "9",
	10: "10",
	18: "18",
	25: "25",
	26: "26",
	27: "26",
	34: "10",
	42: "18",
	48: "48",
	49: "49",
	50: "49",  // robot type 50 → p49 icon (p50 wrong for this type)
	51: "51",
	54: "54",
	65: "65",
	67: "67",
	69: "69",
	70: "70",
	99: "99",
};

export function obstacleAssetFileName(suffix: string): string {
	return `projects_comroborocktanos_resources_obstacle_new_p${suffix}.png`;
}
export function obstacleAssetFileNameAlt(suffix: string): string {
	return `projects_comroborocktanos_resources_map_object_top_${suffix}.png`;
}

function isQ10MapData(map: FrontendMapData | undefined): map is Q10FrontendMapData {
	return !!map && typeof map === "object" && "header" in map && !!(map as Q10FrontendMapData).q10CreatorData?.q10Detected;
}

// -----------------------------------------------------------------------------
// Map Application Class
// -----------------------------------------------------------------------------

/**
 * Draws the robot map and drives every command the tab offers.
 *
 * The drawing, zooming and hit-testing logic is the one the standalone page used; only the
 * edges moved: the ioBroker access arrives as {@link EngineConnection} (the admin socket of
 * `GenericApp`) and every piece of UI state leaves through {@link MapEngineHost} instead of
 * being written into a fixed HTML document.
 */
export class MapEngine {
	// State
	private connection: EngineConnection;
	private host: MapEngineHost;
	private instanceId: string = "";
	private currentRobotDuid: string | null = null;
	private robots: RobotEntry[] = [];
	private floors: SelectOption[] = [];
	private selectedFloor: string | null = null;
	/** Repeat count of a zoned run; the shell owns the input, the engine only stores it. */
	private cleanCount = 1;
	private connectionChannel = "";
	private destroyed = false;
	private onStateChange: ((id: string, state: any | null | undefined) => void) | null = null;
	private currentMapSubscriptions: string[] = [];

	// Map Data
	private map: FrontendMapData | undefined;
	private mapImage: MapData["IMAGE"] | undefined;
	private mapMinX: number = 0;
	private mapMinY: number = 0;
	private mapSizeX: number = 0;
	private mapSizeY: number = 0;
	private mapMaxY: number = 0;
	private goToTarget = false;
	private currentMapBase64Clean: string | null = null;
	private q10Status: number | null = null;
	private q10CleaningInfo: Record<string, unknown> | null = null;
	private q10CurrentCleanRoomIds: number[] = [];

	// D3 & SVG State
	private image = new Image();
	private initialTransform: d3.ZoomTransform | undefined;
	private svg: d3.Selection<d3.BaseType, unknown, HTMLElement, any>;
	private svgContainer: d3.Selection<d3.BaseType, unknown, HTMLElement, any>;
	private mainGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private mapImageElement: d3.Selection<SVGImageElement, unknown, HTMLElement, any>;

	// Layers
	private carpetGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private pathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private mopPathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private backwashPathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private pureCleanPathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;

	/** Live driven/mopped track from `get_dynamic_data`, see `engine/liveTrack.ts`. */
	private liveTrackGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	/** Live position marker; separate layer so it can outlive or predate the track. */
	private liveRobotGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;

	// Element Groups
	private furnitureGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private chargerGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private robotGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private roomNameGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private zoneGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private zonesOverlayGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private obstacleGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private pinGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
	private zoom: d3.ZoomBehavior<Element, unknown>;

	private wheelZoom = 1;
	private readonly minZoom = 0.1;
	private readonly maxZoom = 10;

	// UI Interaction State
	private popupTimeout: number | null = null;
	private popupX: number = 0;
	private popupY: number = 0;
	private selectedObstacleID: any;
	private model: string | null = null;
	private robotModels: Record<string, string> = {};
	/** Last asset folder handed to the shell; kept so the callback only fires on a real change. */
	private lastAssetBase: string | null = null;
	private rects: Rect[] = [];
	private zones: number[][] = [];
	private rectCounter = 0;
	/** Cache: "duid.mapFlag.roomId" -> room name (from get_room_names for cloud maps). */
	private roomNamesFromStates: Record<string, string> = {};
	/** Guard: "duid.mapFlag" of the floor whose room names have already been requested. */
	private roomNamesRequestedForFloor: string | null = null;

	/** Admin language, used to resolve the per-language `common.name` of an object. */
	private language: string = "en";

	// Room selection (segment ids of the currently displayed map).
	private selectedRoomIds = new Set<number>();
	private roomLabelCount = 0;

	// Status bar values, all read from Devices.<duid>.deviceStatus.*
	private statusValues: {
		state: number | null;
		status: number | null;
		battery: number | null;
		errorCode: number | null;
		cleanArea: number | null;
		cleanTime: number | null;
		fanPower: number | null;
		mopMode: number | null;
		waterBoxMode: number | null;
	} = {
		state: null,
		status: null,
		battery: null,
		errorCode: null,
		cleanArea: null,
		cleanTime: null,
		fanPower: null,
		mopMode: null,
		waterBoxMode: null,
	};
	/** Value texts from the object definitions, so the UI needs no model knowledge. */
	private stateTexts: Record<string, string> = {};
	private errorTexts: Record<string, string> = {};
	private modeControls: ModeControl[] = [];

	// Consumable and dock panels. Both are built from the device objects, so a device that
	// publishes nothing keeps its panel hidden instead of showing an empty box.
	private consumableParts: ConsumablePart[] = [];
	private dockControls: DockControl[] = [];
	private dockStatusRows: DockStatusRow[] = [];
	/** Ids of every panel state, so the shared state handler can route updates. */
	private panelStateIds = new Set<string>();
	/** Last known value of each panel state. */
	private panelValues: Record<string, unknown> = {};
	/** Panel states currently subscribed, unsubscribed again on device change. */
	private panelSubscriptions: string[] = [];
	/** Dock fault state of this device, or null when the device publishes none. */
	private dockErrorStateId: string | null = null;

	/** Latest `get_dynamic_data` snapshot, or null while the device publishes none. */
	private liveSnapshot: LiveSnapshot | null = null;
	/** Last value handed to `onLiveTrack`, so the callback only fires on a real change. */
	private lastLiveTrackPresence: boolean | null = null;

	/** True once the user panned/zoomed by hand; a resize then keeps their view. */
	private userAdjustedView = false;
	/** Pointer position when the current gesture started, to tell a click from a pan. */
	private pointerDownAt: { x: number; y: number } | null = null;

	// The only DOM the engine owns: the map surface and the small hover preview above it.
	// Everything else is React, but this preview follows the zoom transform pixel by pixel,
	// so keeping it next to the SVG is simpler and steadier than syncing it into React state.
	private popup!: HTMLDivElement;
	private popupImage!: HTMLImageElement;
	private resizeObserver: ResizeObserver | null = null;
	private windowResizeHandler: (() => void) | null = null;
	/** One handler per subscription, so `unsubscribeState` can drop exactly this listener. */
	private readonly stateHandler = (id: string, state: any): void => {
		if (this.onStateChange) this.onStateChange(id, state);
	};

	constructor(connection: EngineConnection, host: MapEngineHost) {
		this.connection = connection;
		this.host = host;
		// Initialize D3 selections with empty selections initially or in init()
		// We will initialize them properly in init() after DOM is ready
		this.svg = d3.select(null) as any;
		this.svgContainer = d3.select(null) as any;
		this.mainGroup = d3.select(null) as any;
		this.mapImageElement = d3.select(null) as any;
		this.carpetGroup = d3.select(null) as any;
		this.pathGroup = d3.select(null) as any;
		this.mopPathGroup = d3.select(null) as any;
		this.backwashPathGroup = d3.select(null) as any;
		this.pureCleanPathGroup = d3.select(null) as any;
		this.liveTrackGroup = d3.select(null) as any;
		this.liveRobotGroup = d3.select(null) as any;
		this.furnitureGroup = d3.select(null) as any;
		this.chargerGroup = d3.select(null) as any;
		this.robotGroup = d3.select(null) as any;
		this.roomNameGroup = d3.select(null) as any;
		this.zoneGroup = d3.select(null) as any;
		this.zonesOverlayGroup = d3.select(null) as any;
		this.obstacleGroup = d3.select(null) as any;
		this.pinGroup = d3.select(null) as any;
		this.zoom = d3.zoom();
	}

	/**
	 * Starts the engine for one adapter instance.
	 * @param instanceId Adapter instance the tab talks to, e.g. `roborock.0`.
	 */
	public async init(instanceId: string): Promise<void> {
		this.instanceId = instanceId;
		this.modeControls = MODE_COMMANDS.map((mode) => ({
			command: mode.command,
			statusKey: mode.statusKey,
			labelKey: mode.labelKey,
			options: [],
		}));

		this.buildDom();
		this.setupD3();
		this.fetchRobotList();
	}

	/**
	 * Sets the language used to resolve a per-language `common.name` of an object.
	 * @param language Admin language, e.g. `de`.
	 */
	public setLanguage(language: string): void {
		this.language = language || "en";
	}

	/** Drops every subscription, observer and DOM node the engine created. */
	public destroy(): void {
		this.destroyed = true;
		for (const id of this.currentMapSubscriptions) this.connection.unsubscribeState(id, this.stateHandler);
		for (const id of this.panelSubscriptions) this.connection.unsubscribeState(id, this.stateHandler);
		this.currentMapSubscriptions = [];
		this.panelSubscriptions = [];
		this.onStateChange = null;

		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.windowResizeHandler) {
			window.removeEventListener("resize", this.windowResizeHandler);
			this.windowResizeHandler = null;
		}
		if (this.popupTimeout) {
			clearTimeout(this.popupTimeout);
			this.popupTimeout = null;
		}
		this.host.container.replaceChildren();
	}

	/**
	 * Creates the map surface. React owns everything around it, but the SVG and the small
	 * obstacle preview above it are drawn imperatively, exactly as before.
	 */
	private buildDom(): void {
		const container = document.createElement("div");
		container.className = "rr-map-surface";

		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", "rr-map-svg");
		container.appendChild(svg);

		this.popupImage = document.createElement("img");
		this.popupImage.className = "rr-map-popup-image";
		this.popupImage.alt = "";
		this.popupImage.addEventListener("click", () => this.openObstaclePhoto());

		this.popup = document.createElement("div");
		this.popup.className = "rr-map-popup";
		this.popup.appendChild(this.popupImage);

		container.appendChild(this.popup);
		this.host.container.replaceChildren(container);

		this.svgContainer = d3.select(container) as any;
		this.svg = d3.select(svg) as any;
	}

	private setupD3() {
		this.mainGroup = this.svg.append("g").attr("class", "main-group");
		this.mapImageElement = this.mainGroup.append("image").attr("class", "map-image");

		// Add carpet layer (Vector SVG)
		this.carpetGroup = this.mainGroup.append("g").attr("class", "carpet");

		this.mopPathGroup = this.mainGroup
			.append("g")
			.attr("class", "mop-paths")
			.style("opacity", 0.18);
		this.pathGroup = this.mainGroup
			.append("g")
			.attr("class", "paths")
			.style("opacity", 0.5);
		this.backwashPathGroup = this.mainGroup
			.append("g")
			.attr("class", "backwash-paths")
			.style("opacity", 0.2);
		this.pureCleanPathGroup = this.mainGroup
			.append("g")
			.attr("class", "pure-clean-paths");

		// Furniture sits above the driven paths - it is a permanent part of the room, not a trace -
		// but below charger, obstacles and robot, which have to stay readable on top of it.
		this.furnitureGroup = this.mainGroup.append("g").attr("class", "furniture-models");

		// The live track goes above the furniture on purpose: it answers "what did it just clean",
		// and a piece of furniture drawn over it would hide exactly the stretch the user is looking
		// for. Above the historic paths for the same reason.
		this.liveTrackGroup = this.mainGroup.append("g").attr("class", "live-track");

		this.chargerGroup = this.mainGroup.append("g").attr("class", "charger");
		this.obstacleGroup = this.mainGroup.append("g").attr("class", "obstacles");
		this.zoneGroup = this.mainGroup.append("g").attr("class", "zones");
		this.zonesOverlayGroup = this.mainGroup.append("g").attr("class", "zones-overlay");
		this.robotGroup = this.mainGroup.append("g").attr("class", "robot");
		// Directly above the map's own robot, which is hidden while a live position exists.
		this.liveRobotGroup = this.mainGroup.append("g").attr("class", "live-robot-marker");
		this.pinGroup = this.mainGroup.append("g").attr("class", "pins");
		this.roomNameGroup = this.mainGroup.append("g").attr("class", "room-names");

		this.pinGroup
			.append("image")
			.attr("class", "goto-pin")
			.attr("href", IMG_GO_TO_PIN)
			.attr("width", 29)
			.attr("height", 24)
			.style("opacity", 0)
			.style("display", "none")
			.style("pointer-events", "none");

		this.zoom = d3
			.zoom()
			.scaleExtent([this.minZoom, this.maxZoom])
			.on("zoom", (event: any) => this.handleZoom(event));

		this.svgContainer.call(this.zoom as any);

		// Remember where a gesture started so panning the map does not select a room.
		this.svgContainer.on("pointerdown.roomselect", (event: PointerEvent) => {
			this.pointerDownAt = { x: event.clientX, y: event.clientY };
		});

		// The map fills the available area instead of a fixed 450 x 450 box.
		this.updateSvgSize();
		const container = this.svgContainer.node() as HTMLElement | null;
		if (container && typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => this.updateSvgSize());
			this.resizeObserver.observe(container);
		} else {
			this.windowResizeHandler = () => this.updateSvgSize();
			window.addEventListener("resize", this.windowResizeHandler);
		}
	}

	/** Matches the SVG viewport to its container and refits the map when the user did not zoom. */
	private updateSvgSize(): void {
		const container = this.svgContainer.node() as HTMLElement | null;
		if (!container) return;

		const width = Math.max(1, Math.round(container.clientWidth));
		const height = Math.max(1, Math.round(container.clientHeight));
		if (width === (parseFloat(this.svg.attr("width")) || 0) && height === (parseFloat(this.svg.attr("height")) || 0)) return;

		this.svg.attr("width", width).attr("height", height);
		// Room names are sized from this viewport, so they have to be re-measured here - also
		// when the user adjusted the view, which returns before the refit below.
		this.applyRoomLabelZoomBehavior();

		if (this.userAdjustedView) return;
		const transform = this.computeFitTransform();
		if (!transform) return;
		this.initialTransform = transform;
		this.applyFitTransform(transform);
	}

	/** Zoom transform that centers the detected map content in the current SVG viewport. */
	private computeFitTransform(): d3.ZoomTransform | null {
		if (!this.hasDrawableMapBounds()) return null;

		const svgWidth = parseFloat(this.svg.attr("width")) || 450;
		const svgHeight = parseFloat(this.svg.attr("height")) || 450;

		const aspectRatio = svgWidth / svgHeight;
		const contentAspectRatio = this.mapSizeX / this.mapSizeY;
		let zoomLevel =
			contentAspectRatio > aspectRatio
				? this.roundTwoDecimals((svgWidth * 0.95) / this.mapSizeX)
				: this.roundTwoDecimals((svgHeight * 0.95) / this.mapSizeY);
		if (zoomLevel < 0.1) zoomLevel = 0.1;

		const contentCenterX = this.mapMinX + this.mapSizeX / 2;
		const contentCenterY = this.mapMinY + this.mapSizeY / 2;

		return d3.zoomIdentity
			.translate(svgWidth / 2, svgHeight / 2)
			.scale(zoomLevel)
			.translate(-contentCenterX, -contentCenterY);
	}

	/** Applies a fit transform without marking the view as user adjusted. */
	private applyFitTransform(transform: d3.ZoomTransform): void {
		this.svgContainer.call(this.zoom.transform as any, transform);
		this.userAdjustedView = false;
	}

	// -----------------------------------------------------------------------------
	// Localization and user feedback
	// -----------------------------------------------------------------------------

	/**
	 * Translates a key. The admin already loaded `admin/i18n/<lang>.json` into `I18n`, so the
	 * tab no longer fetches a second translation store over the socket.
	 */
	private t(key: string, fallback: string, ...args: (string | number)[]): string {
		return this.host.t(key, fallback, ...args);
	}

	private errorText(error: unknown): string {
		if (error instanceof Error) return error.message;
		if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
		return String(error);
	}

	/** Shows a failure in the page instead of hiding it in the browser console. */
	private showError(message: string): void {
		this.host.onError?.(message);
	}

	/** Sends a command to the adapter and surfaces failures in the UI. */
	private sendCommand(command: string, params: Record<string, unknown>): Promise<void> {
		return this.connection
			.sendTo(this.instanceId, command, params)
			.then((response: any) => {
				if (response && typeof response === "object" && response.error) {
					throw new Error(String(response.error));
				}
			})
			.catch((err: unknown) => {
				console.error(`Error sending command '${command}':`, err);
				this.showError(this.t("ui_command_failed", "Command failed: %s", this.errorText(err)));
			});
	}

	/** Reads an object without letting a missing object break the caller. */
	private async getObjectSafe(id: string): Promise<any | null> {
		try {
			return await this.connection.getObject(id);
		} catch {
			return null;
		}
	}

	/**
	 * Normalizes an ioBroker `common.states` definition into value -> label.
	 * Accepts the object, array and "value:label;..." notations.
	 */
	private normalizeStates(states: unknown): Record<string, string> | null {
		if (!states) return null;

		if (typeof states === "string") {
			const result: Record<string, string> = {};
			for (const part of states.split(";")) {
				const separator = part.indexOf(":");
				if (separator < 0) continue;
				result[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
			}
			return Object.keys(result).length ? result : null;
		}

		if (Array.isArray(states)) {
			const result: Record<string, string> = {};
			states.forEach((label, index) => {
				result[String(index)] = String(label);
			});
			return Object.keys(result).length ? result : null;
		}

		if (typeof states === "object") {
			const result: Record<string, string> = {};
			for (const [value, label] of Object.entries(states as Record<string, unknown>)) {
				result[value] = String(label);
			}
			return Object.keys(result).length ? result : null;
		}

		return null;
	}

	private fetchRobotList() {
		const startKey = `${this.instanceId}.Devices.`;
		const endKey = `${this.instanceId}.Devices.\u9999`;

		this.connection
			.getObjectViewSystem("device", startKey, endKey)
			.then((objects: Record<string, any>) => {
				const robots: RobotEntry[] = [];
				for (const [id, value] of Object.entries(objects ?? {})) {
					const idParts = id.split(".");
					const duid = idParts[idParts.length - 1];
					const name = value?.common?.name ? String(value.common.name) : duid;
					// Extract model from native object
					const model = value?.native?.model || value?.native?.deviceInfo?.model || null;

					if (duid) {
						robots.push({ duid: duid, name: name });
						if (model) {
							this.robotModels[duid] = model;
						}
					}
				}

				this.robots = robots;
				if (robots.length === 0) {
					// Nothing to select; the shell shows its "no device" hint instead of an empty list.
					this.currentRobotDuid = null;
					this.host.onRobots?.([], null);
					return;
				}

				const duid = robots[0].duid;
				this.currentRobotDuid = duid;
				this.host.onRobots?.(robots, duid);
				this.setupSocketListeners(duid);

				// Fetch HomeData to resolve models reliably
				const homeDataId = `${this.instanceId}.HomeData`;
				this.connection.getStates([homeDataId]).then((states: Record<string, any>) => {
					const state = states[homeDataId];
					if (state && state.val) {
						try {
							const homeData = typeof state.val === "string" ? JSON.parse(state.val) : state.val;
							const productMap: Record<string, string> = {};
							if (homeData.products) {
								homeData.products.forEach((p: any) => {
									if (p.id && p.model) productMap[p.id] = p.model;
								});
							}
							const processDeviceList = (list: any[]) => {
								if (list) {
									list.forEach((d: any) => {
										if (d.duid && d.productId && productMap[d.productId]) {
											this.robotModels[d.duid] = productMap[d.productId];
										}
									});
								}
							};
							processDeviceList(homeData.devices);
							processDeviceList(homeData.receivedDevices);

							// Re-trigger listeners if we have a model now (refresh overlays with correct asset URLs)
							if (this.currentRobotDuid && this.robotModels[this.currentRobotDuid]) {
								this.model = this.robotModels[this.currentRobotDuid];
								this.publishAssetBase();
								if (this.map) this.drawOverlaysFromMap();
							}
						} catch (e) {
							console.error("Failed to parse HomeData:", e);
						}
					}
				});
			})
			.catch((err) => console.error("Error fetching robot list:", err));
	}

	private setupSocketListeners(duid: string) {
		this.currentMapSubscriptions.forEach((id) => this.connection.unsubscribeState(id, this.stateHandler));
		this.currentMapSubscriptions = [];
		this.panelSubscriptions.forEach((id) => this.connection.unsubscribeState(id, this.stateHandler));
		this.panelSubscriptions = [];
		this.clearPanels();

		this.roomNamesRequestedForFloor = null;
		this.roomNamesFromStates = {};

		this.map = undefined;
		this.mapImage = undefined;
		this.mapImageElement.attr("href", null);
		this.carpetGroup.selectAll("*").remove();
		this.furnitureGroup.selectAll("*").remove();
		this.obstacleGroup.selectAll("*").remove();
		this.zonesOverlayGroup.selectAll("*").remove();
		this.pinGroup.select("image.goto-pin").style("display", "none").style("opacity", 0);
		this.robotGroup.selectAll("*").remove();
		this.chargerGroup.selectAll("*").remove();
		this.roomNameGroup.selectAll("*").remove();
		this.pathGroup.selectAll("*").remove();
		this.mopPathGroup.selectAll("*").remove();
		this.backwashPathGroup.selectAll("*").remove();
		this.pureCleanPathGroup.selectAll("*").remove();
		this.liveSnapshot = null;
		this.drawLiveOverlay();
		this.rects = [];
		this.drawZones();
		this.currentMapBase64Clean = null;
		this.q10Status = null;
		this.q10CleaningInfo = null;
		this.q10CurrentCleanRoomIds = [];
		this.selectedRoomIds.clear();
		this.roomLabelCount = 0;
		this.userAdjustedView = false;
		this.connectionChannel = "";
		this.resetStatusValues();
		this.updateMapPlaceholder();
		this.renderRoomSelection();
		this.renderZoneHint();

		const deviceRoot = `${this.instanceId}.Devices.${duid}`;
		const mapBase64CleanStateId = `${deviceRoot}.map.mapBase64Clean`;
		const mapDataStateId = `${deviceRoot}.map.mapData`;
		const q10StatusStateId = `${deviceRoot}.deviceStatus.status`;
		const q10CleaningInfoStateId = `${deviceRoot}.deviceStatus.cleaning_info`;
		const q10CurrentCleanRoomIdsStateId = `${deviceRoot}.deviceStatus.current_clean_room_ids`;
		// The live channel. Absent on an adapter version that does not publish it yet, which simply
		// means the overlay stays empty - every other layer is unaffected.
		const liveTrackStateId = `${deviceRoot}.${LIVE_TRACK_STATE}`;

		// Status bar and mode selectors. deviceStatus.state is the V1 robot state that the UI
		// used to guess locally; deviceStatus.status is its B01/Q10 counterpart.
		const statusKeyByStateId = new Map<string, keyof MapEngine["statusValues"]>([
			[`${deviceRoot}.deviceStatus.state`, "state"],
			[`${deviceRoot}.deviceStatus.battery`, "battery"],
			[`${deviceRoot}.deviceStatus.error_code`, "errorCode"],
			[`${deviceRoot}.deviceStatus.clean_area`, "cleanArea"],
			[`${deviceRoot}.deviceStatus.clean_time`, "cleanTime"],
			[`${deviceRoot}.deviceStatus.fan_power`, "fanPower"],
			[`${deviceRoot}.deviceStatus.mop_mode`, "mopMode"],
			[`${deviceRoot}.deviceStatus.water_box_mode`, "waterBoxMode"],
		]);

		// Transport channel of the local/cloud work package; simply hidden while it is absent.
		const connectionPreferredStateId = `${deviceRoot}.connection.preferred`;

		this.currentMapSubscriptions = [
			mapBase64CleanStateId,
			mapDataStateId,
			q10StatusStateId,
			q10CleaningInfoStateId,
			q10CurrentCleanRoomIdsStateId,
			connectionPreferredStateId,
			liveTrackStateId,
			...statusKeyByStateId.keys()
		];

		this.onStateChange = (id: string, state: any | null | undefined) => {
			if (this.panelStateIds.has(id)) {
				this.panelValues[id] = state && state.val !== undefined ? state.val : null;
				this.updateConsumableValues();
				this.updateDockValues();
				return;
			}

			if (id === connectionPreferredStateId) {
				this.connectionChannel = state && state.val !== null && state.val !== undefined ? String(state.val) : "";
				this.renderStatusBar();
				return;
			}

			const statusKey = statusKeyByStateId.get(id);
			if (statusKey) {
				const raw = state && state.val !== null && state.val !== undefined ? Number(state.val) : NaN;
				this.statusValues[statusKey] = Number.isFinite(raw) ? raw : null;
				this.renderStatusBar();
				return;
			}

			if (id === liveTrackStateId) {
				// One branch for both cases: an empty state and a broken payload both mean "nothing
				// live to show", and `parseLiveSnapshot` answers either with null.
				this.liveSnapshot = state ? parseLiveSnapshot(state.val) : null;
				this.drawLiveOverlay();
				return;
			}

			if (!state || state.val === null || state.val === undefined) {
				if (id === mapBase64CleanStateId) {
					this.currentMapBase64Clean = null;
					this.updateBackgroundImageFromStateCache();
				}
				if (id === mapDataStateId) {
					this.map = undefined;
					this.zonesOverlayGroup.selectAll("*").remove();
					this.furnitureGroup.selectAll("*").remove();
					this.robotGroup.selectAll("*").remove();
					this.updateMapPlaceholder();
				}
				if (id === q10StatusStateId) {
					this.q10Status = null;
					this.statusValues.status = null;
					this.renderStatusBar();
				}
				if (id === q10CleaningInfoStateId) this.q10CleaningInfo = null;
				if (id === q10CurrentCleanRoomIdsStateId) this.q10CurrentCleanRoomIds = [];
				if (
					(id === q10StatusStateId || id === q10CleaningInfoStateId || id === q10CurrentCleanRoomIdsStateId)
					&& isQ10MapData(this.map)
				) {
					this.drawOverlaysFromMap();
				}
				return;
			}

			switch (id) {
				case mapBase64CleanStateId:
					this.currentMapBase64Clean = String(state.val);
					this.updateBackgroundImageFromStateCache();
					break;

				case mapDataStateId:
					try {
						this.map = typeof state.val === "string" ? JSON.parse(state.val) : state.val;
						if (this.map && "IMAGE" in this.map && this.map.IMAGE) {
							this.model = this.map.model ?? (this.currentRobotDuid ? this.robotModels[this.currentRobotDuid] : null) ?? null;
							this.mapImage = this.map.IMAGE;
							this.updateMapImageSize();
							this.drawOverlaysFromMap();
						} else if (isQ10MapData(this.map)) {
							this.model = this.map.model ?? (this.currentRobotDuid ? this.robotModels[this.currentRobotDuid] : null) ?? null;
							this.mapImage = undefined;
							this.drawOverlaysFromMap();
						}
						this.publishAssetBase();
						this.updateMapPlaceholder();
						this.syncFloorSelection();
					} catch (e) {
						console.error("Failed to parse map data JSON:", state.val, e);
						this.showError(this.t("ui_command_failed", "Command failed: %s", this.errorText(e)));
					}
					break;

				case q10StatusStateId:
					this.q10Status = Number(state.val);
					this.statusValues.status = Number.isFinite(this.q10Status) ? this.q10Status : null;
					this.renderStatusBar();
					if (isQ10MapData(this.map)) this.drawOverlaysFromMap();
					break;

				case q10CleaningInfoStateId:
					this.q10CleaningInfo = this.parseQ10CleaningInfoState(state.val);
					if (isQ10MapData(this.map)) this.drawOverlaysFromMap();
					break;

				case q10CurrentCleanRoomIdsStateId:
					this.q10CurrentCleanRoomIds = this.parseQ10RoomIdsState(state.val);
					if (isQ10MapData(this.map)) this.drawOverlaysFromMap();
					break;
			}
		};

		this.currentMapSubscriptions.forEach((id) => void this.connection.subscribeState(id, this.stateHandler));

		void this.connection.getStates(this.currentMapSubscriptions).then((states: Record<string, any | null | undefined>) => {
			if (!this.onStateChange) return;

			// Try to resolve model from map if already populated. Assigning unconditionally also
			// clears the previous robot's model on a device switch - its assets are a different
			// folder, and the map data arriving below fills the value back in when it knows better.
			this.model = this.robotModels[duid] ?? null;
			this.publishAssetBase();

			for (const id of this.currentMapSubscriptions) {
				this.onStateChange(id, states[id]);
			}
		});

		this.loadDeviceDefinitions(duid).catch((err) => console.error("Failed to load device definitions:", err));
	}

	// -----------------------------------------------------------------------------
	// Status bar, mode selectors and floor list
	// -----------------------------------------------------------------------------

	private resetStatusValues(): void {
		for (const key of Object.keys(this.statusValues) as (keyof MapEngine["statusValues"])[]) {
			this.statusValues[key] = null;
		}
		this.stateTexts = {};
		this.errorTexts = {};
		this.renderStatusBar();
	}

	/**
	 * Loads the object definitions of the selected device. Everything the UI needs to know
	 * about the model (state texts, available modes, floors) comes from these objects.
	 * @param duid Device to load the definitions for.
	 */
	private async loadDeviceDefinitions(duid: string): Promise<void> {
		const deviceRoot = `${this.instanceId}.Devices.${duid}`;

		const [stateObject, statusObject, errorObject] = await Promise.all([
			this.getObjectSafe(`${deviceRoot}.deviceStatus.state`),
			this.getObjectSafe(`${deviceRoot}.deviceStatus.status`),
			this.getObjectSafe(`${deviceRoot}.deviceStatus.error_code`),
		]);
		if (this.currentRobotDuid !== duid) return;

		this.stateTexts = this.normalizeStates(stateObject?.common?.states) ?? this.normalizeStates(statusObject?.common?.states) ?? {};
		this.errorTexts = this.normalizeStates(errorObject?.common?.states) ?? {};

		await this.populateModeControls(duid, deviceRoot);
		await this.populateFloors(duid, deviceRoot);
		await this.populateConsumables(duid, deviceRoot);
		await this.populateDock(duid, deviceRoot);
		this.subscribePanelStates(duid);

		if (this.currentRobotDuid === duid) this.renderStatusBar();
	}

	// -----------------------------------------------------------------------------
	// Consumable and dock panels
	// -----------------------------------------------------------------------------

	/** Drops everything the previous device contributed to the two panels. */
	private clearPanels(): void {
		this.consumableParts = [];
		this.dockControls = [];
		this.dockStatusRows = [];
		this.panelStateIds.clear();
		this.panelValues = {};
		this.dockErrorStateId = null;

		this.host.onConsumables?.([]);
		this.host.onDock?.({ controls: [], status: [], faulty: false });
	}

	/** Lists the state objects below a path prefix; an unreachable view yields an empty panel, not an error. */
	private async getStateObjectsBelow(prefix: string): Promise<{ id: string; common: Record<string, any> }[]> {
		try {
			const objects = await this.connection.getObjectViewSystem("state", prefix, `${prefix}\u9999`);
			return Object.entries(objects ?? {})
				.map(([id, value]) => ({ id: String(id), common: ((value as any)?.common ?? {}) as Record<string, any> }))
				.filter((entry) => entry.id.startsWith(prefix) && entry.id.length > prefix.length);
		} catch {
			return [];
		}
	}

	/** Resolves `common.name`, which ioBroker allows to be a plain string or a per-language map. */
	private objectName(name: unknown, fallback: string): string {
		if (typeof name === "string" && name.trim()) return name;
		if (name && typeof name === "object") {
			const translated = name as Record<string, unknown>;
			const candidate = translated[this.language] ?? translated.en;
			if (typeof candidate === "string" && candidate.trim()) return candidate;
		}
		return fallback;
	}

	/** Reads a numeric member of an object definition, or null when it is absent. */
	private numericCommon(common: Record<string, any>, key: string): number | null {
		const value = Number(common?.[key]);
		return Number.isFinite(value) ? value : null;
	}

	/** Strips the value suffix the adapter appends, leaving the part name (e.g. "main_brush"). */
	private consumablePartName(stateName: string): string {
		for (const suffix of CONSUMABLE_SUFFIXES) {
			if (stateName.endsWith(suffix)) return stateName.slice(0, -suffix.length);
		}
		return stateName;
	}

	/**
	 * Builds one row per consumable part out of the published objects. Everything shown -
	 * label, unit and lifetime range - comes from the object definitions, so the UI needs no
	 * model knowledge, exactly like the mode selectors.
	 * @param duid Device the definitions belong to.
	 * @param deviceRoot Object path of that device.
	 */
	private async populateConsumables(duid: string, deviceRoot: string): Promise<void> {
		const [values, resets] = await Promise.all([
			this.getStateObjectsBelow(`${deviceRoot}.${CONSUMABLES_FOLDER}.`),
			this.getStateObjectsBelow(`${deviceRoot}.${RESET_CONSUMABLES_FOLDER}.`),
		]);
		if (this.currentRobotDuid !== duid) return;

		// Reset buttons are named `reset_<part>`; only writable buttons are offered.
		const resetByPart = new Map<string, { command: string; name: string }>();
		for (const reset of resets) {
			const command = reset.id.split(".").pop() ?? "";
			if (!command.startsWith("reset_") || reset.common?.type !== "boolean" || reset.common?.write !== true) continue;
			resetByPart.set(command.slice("reset_".length), { command, name: this.objectName(reset.common?.name, command).replace(/^reset\s+/i, "") });
		}

		const partsByName = new Map<string, ConsumablePart>();
		for (const value of values) {
			const stateName = value.id.split(".").pop() ?? "";
			if (!stateName || value.common?.type !== "number") continue;

			const partName = this.consumablePartName(stateName);
			let part = partsByName.get(partName);
			if (!part) {
				const reset = resetByPart.get(partName) ?? null;
				part = {
					part: partName,
					name: reset?.name || this.objectName(value.common?.name, partName),
					metrics: [],
					resetCommand: reset?.command ?? null,
				};
				partsByName.set(partName, part);
			}

			part.metrics.push({
				stateId: value.id,
				name: this.objectName(value.common?.name, stateName),
				unit: String(value.common?.unit ?? ""),
				min: this.numericCommon(value.common, "min"),
				max: this.numericCommon(value.common, "max"),
			});
		}

		this.consumableParts = Array.from(partsByName.values()).filter((part) => part.metrics.length > 0);

		// The part name is already the row heading, so it is dropped from the value labels.
		for (const part of this.consumableParts) {
			for (const metric of part.metrics) {
				if (metric.name.length > part.name.length && metric.name.toLowerCase().startsWith(part.name.toLowerCase())) {
					metric.name = metric.name.slice(part.name.length).trim() || metric.name;
				}
			}
		}

		this.updateConsumableValues();
	}

	/** True when the object definition declares a range a remaining percentage can be derived from. */
	private hasLifetimeRange(metric: ConsumableMetric): boolean {
		if (metric.unit === "%") return true;
		return metric.max !== null && metric.max > (metric.min ?? 0);
	}

	/** Remaining share of the declared lifetime, or null when the definition declares no range. */
	private consumablePercent(metric: ConsumableMetric, value: number): number | null {
		if (metric.unit === "%") return Math.max(0, Math.min(100, value));
		if (metric.max === null) return null;
		const min = metric.min ?? 0;
		if (metric.max <= min) return null;
		return Math.max(0, Math.min(100, ((value - min) / (metric.max - min)) * 100));
	}

	/**
	 * True when a part has reached the end of its life. Percentages use a common threshold;
	 * a remaining time published in hours is due once nothing is left.
	 */
	private isConsumableDue(metric: ConsumableMetric, value: number): boolean {
		const percent = this.consumablePercent(metric, value);
		if (percent !== null) return percent <= CONSUMABLE_WARN_PERCENT;
		return metric.unit === "h" && value <= 0;
	}

	/** Publishes the current consumable values as view models for the shell. */
	private updateConsumableValues(): void {
		const models: ConsumablePartModel[] = this.consumableParts.map((part) => {
			let due = false;
			let percent: number | null = null;
			const metrics = part.metrics.map((metric) => {
				const raw = this.panelValues[metric.stateId];
				const value = raw === null || raw === undefined ? null : Number(raw);
				const known = value !== null && Number.isFinite(value);
				if (known) {
					if (this.isConsumableDue(metric, value)) due = true;
					const metricPercent = this.consumablePercent(metric, value);
					if (metricPercent !== null && (percent === null || metricPercent < percent)) percent = metricPercent;
				}
				return {
					name: metric.name,
					text: known ? `${value}${metric.unit ? ` ${metric.unit}` : ""}` : "–",
				};
			});

			// A meter is only honest when a part publishes a range the percentage can refer to.
			const hasRange = part.metrics.some((metric) => this.hasLifetimeRange(metric));
			return {
				part: part.part,
				name: part.name,
				metrics,
				percent: hasRange ? (percent ?? 0) : null,
				due,
				resetCommand: part.resetCommand,
			};
		});

		this.host.onConsumables?.(models);
	}

	/**
	 * Builds the dock panel from the command objects the device handler registered. A device
	 * without any dock command and without station states keeps the panel hidden entirely.
	 * @param duid Device the definitions belong to.
	 * @param deviceRoot Object path of that device.
	 */
	private async populateDock(duid: string, deviceRoot: string): Promise<void> {
		const commandObjects = await Promise.all(
			DOCK_COMMANDS.map(async (entry) => ({ entry, object: await this.getObjectSafe(`${deviceRoot}.commands.${entry.command}`) }))
		);
		const statusObjects = await this.getStateObjectsBelow(`${deviceRoot}.${DOCK_STATUS_FOLDER}.`);
		// The dock fault lives next to the robot status, but belongs into this panel.
		const dockErrorId = `${deviceRoot}.deviceStatus.dock_error_status`;
		const dockErrorObject = await this.getObjectSafe(dockErrorId);
		if (this.currentRobotDuid !== duid) return;

		this.dockControls = [];

		for (const { entry, object } of commandObjects) {
			if (!object?.common) continue;
			const control = this.createDockControl(entry, object.common, `${deviceRoot}.commands.${entry.command}`);
			if (control) this.dockControls.push(control);
		}

		this.dockErrorStateId = dockErrorObject?.common ? dockErrorId : null;
		this.dockStatusRows = statusObjects.map((status) => this.createDockStatusRow(status.id, status.common));
		if (dockErrorObject?.common) {
			this.dockStatusRows.unshift(this.createDockStatusRow(dockErrorId, dockErrorObject.common));
		}

		this.updateDockValues();
	}

	/** Turns one command object into the control its definition asks for. */
	private createDockControl(entry: { command: string; key: string; fallback: string }, common: Record<string, any>, stateId: string): DockControl | null {
		const label = this.t(entry.key, entry.fallback);
		const states = this.normalizeStates(common.states);

		if (states) {
			const options = Object.entries(states).map(([value, text]) => ({ value, label: text }));
			return { command: entry.command, stateId, label, kind: "select", options };
		}

		if (common.type !== "boolean") return null;

		// A switch keeps both positions reachable; a button only knows "trigger".
		if (common.role !== "button") {
			return {
				command: entry.command,
				stateId,
				label,
				kind: "switch",
				options: [
					{ value: "true", label: this.t("ui_on", "On") },
					{ value: "false", label: this.t("ui_off", "Off") },
				],
			};
		}

		return { command: entry.command, stateId, label, kind: "button", options: [] };
	}

	/** Writes a dock command through the guarded generic writer. */
	public sendDockValue(command: string, value: unknown): void {
		if (!this.currentRobotDuid) return;
		void this.sendCommand("set_state", { duid: this.currentRobotDuid, folder: "commands", command, value });
	}

	/** Describes one station status line; the label and value texts come from the object definition. */
	private createDockStatusRow(stateId: string, common: Record<string, any>): DockStatusRow {
		return {
			stateId,
			name: this.objectName(common?.name, stateId.split(".").pop() ?? stateId),
			states: this.normalizeStates(common?.states),
			unit: String(common?.unit ?? ""),
		};
	}

	/** Publishes the current dock values as a view model for the shell. */
	private updateDockValues(): void {
		const controls: DockControlModel[] = this.dockControls.map((control) => {
			const raw = this.panelValues[control.stateId];
			let value: string | null = null;
			if (raw !== null && raw !== undefined) {
				const candidate = control.kind === "switch" ? String(raw === true || raw === "true") : String(raw);
				if (control.options.some((option) => option.value === candidate)) value = candidate;
			}
			return { command: control.command, label: control.label, kind: control.kind, options: control.options, value };
		});

		const status: DockStatusModel[] = this.dockStatusRows.map((row) => {
			const raw = this.panelValues[row.stateId];
			if (raw === null || raw === undefined) return { stateId: row.stateId, name: row.name, text: "–" };
			const text = row.states?.[String(raw)] ?? (typeof raw === "boolean" ? this.t(raw ? "ui_on" : "ui_off", raw ? "On" : "Off") : undefined);
			return { stateId: row.stateId, name: row.name, text: text ?? `${String(raw)}${row.unit ? ` ${row.unit}` : ""}` };
		});

		// A collapsed panel would hide a dock fault, so it is flagged on the summary line.
		const dockError = this.dockErrorStateId === null ? null : Number(this.panelValues[this.dockErrorStateId]);
		const faulty = dockError !== null && Number.isFinite(dockError) && dockError > 0;

		this.host.onDock?.({ controls, status, faulty });
	}

	/** Subscribes to every state the two panels display and fetches their current values. */
	private subscribePanelStates(duid: string): void {
		if (this.currentRobotDuid !== duid) return;

		const ids = new Set<string>();
		for (const part of this.consumableParts) {
			for (const metric of part.metrics) ids.add(metric.stateId);
		}
		for (const control of this.dockControls) {
			// A push button has no value to display, so it needs no subscription either.
			if (control.kind !== "button") ids.add(control.stateId);
		}
		for (const row of this.dockStatusRows) ids.add(row.stateId);

		this.panelStateIds = ids;
		this.panelSubscriptions = Array.from(ids);
		if (this.panelSubscriptions.length === 0) return;

		this.panelSubscriptions.forEach((id) => void this.connection.subscribeState(id, this.stateHandler));
		void this.connection.getStates(this.panelSubscriptions).then((states: Record<string, any | null | undefined>) => {
			if (this.currentRobotDuid !== duid) return;
			for (const id of this.panelSubscriptions) {
				const state = states[id];
				this.panelValues[id] = state && state.val !== undefined ? state.val : null;
			}
			this.updateConsumableValues();
			this.updateDockValues();
		});
	}

	/** Builds the fan/mop/water selectors purely from the command objects' `common.states`. */
	private async populateModeControls(duid: string, deviceRoot: string): Promise<void> {
		for (const control of this.modeControls) {
			const object = await this.getObjectSafe(`${deviceRoot}.commands.${control.command}`);
			if (this.currentRobotDuid !== duid) return;

			const states = this.normalizeStates(object?.common?.states);
			// An empty option list hides the selector; the device simply does not offer that mode.
			control.options = states ? Object.entries(states).map(([value, label]) => ({ value, label })) : [];
		}

		this.publishModes();
	}

	/**
	 * Publishes the folder the current robot's Roborock graphics live in, so React can show the
	 * app's own mode icons next to the mode names.
	 *
	 * Unlike the map drawing code this deliberately has **no** fallback model. The map falls back
	 * because a map without a robot sprite is useless; a selector without an icon is merely plain
	 * text and therefore still correct. Guessing a model here would point at another device's
	 * artwork, so an unknown model publishes null and the shell keeps showing text.
	 */
	private publishAssetBase(): void {
		const modelFolder = this.model || (this.currentRobotDuid ? this.robotModels[this.currentRobotDuid] : null) || null;
		const base = modelFolder ? `${ASSET_BASE}/${modelFolder}` : null;
		if (base === this.lastAssetBase) return;
		this.lastAssetBase = base;
		this.host.onAssetBase?.(base);
	}

	/** Publishes the mode selectors together with the value the robot currently reports. */
	private publishModes(): void {
		// The model often arrives after the selectors do, so this rides along with every update.
		this.publishAssetBase();
		const models: ModeModel[] = this.modeControls
			.filter((control) => control.options.length > 0)
			.map((control) => {
				const value = this.statusValues[control.statusKey];
				const option = value === null ? null : String(value);
				return {
					command: control.command,
					labelKey: control.labelKey,
					options: control.options,
					value: option !== null && control.options.some((entry) => entry.value === option) ? option : null,
				};
			});
		this.host.onModes?.(models);
	}

	/** Fills the floor selector from the `load_multi_map` command object the adapter maintains. */
	private async populateFloors(duid: string, deviceRoot: string): Promise<void> {
		const object = await this.getObjectSafe(`${deviceRoot}.commands.load_multi_map`);
		if (this.currentRobotDuid !== duid) return;

		const states = this.normalizeStates(object?.common?.states);

		// A single floor is not a choice, so the selector stays away entirely.
		this.floors = !states || Object.keys(states).length < 2 ? [] : Object.entries(states).map(([mapFlag, name]) => ({ value: mapFlag, label: name }));
		this.selectedFloor = null;
		this.syncFloorSelection();
	}

	/** Marks the floor the currently displayed map belongs to. */
	private syncFloorSelection(): void {
		if (this.floors.length) {
			const mapFlag = normalizeMapFlag((this.map as { mapFlag?: unknown } | undefined)?.mapFlag);
			if (mapFlag !== null) {
				const value = String(mapFlag);
				if (this.floors.some((floor) => floor.value === value)) this.selectedFloor = value;
			}
		}
		this.host.onFloors?.(this.floors, this.selectedFloor);
	}

	/**
	 * Resolves a reported state code into the admin's language.
	 *
	 * The adapter writes the `common.states` of `deviceStatus.state` in English (the table in
	 * `vacuumConstants.ts`), so the strip used to read "Charging" in a German admin. The code
	 * is therefore translated through `engine/robotStates.ts` first. Everything below that is
	 * a fallback chain, because an unknown code must never leave the strip empty: the object's
	 * own text comes next - a B01 already publishes it localized - then the English wording of
	 * the table, and finally "Unknown (<code>)" for a value nobody has ever seen.
	 * @param stateCode Value the device reported, or null while none arrived.
	 */
	private resolveStateText(stateCode: number | null): string | null {
		if (stateCode === null) return null;

		const fromObject = this.stateTexts[String(stateCode)] || "";
		const known = ROBOT_STATES[stateCode];
		if (known) return this.t(known.key, fromObject || known.en);
		return fromObject || `${this.t("ui_unknown", "Unknown")} (${stateCode})`;
	}

	/** Publishes the live device status and refreshes the mode selectors. */
	private renderStatusBar(): void {
		const stateCode = this.statusValues.state ?? this.statusValues.status;
		const errorCode = this.statusValues.errorCode;

		const status: StatusModel = {
			stateText: this.resolveStateText(stateCode),
			battery: this.statusValues.battery,
			cleanArea: this.statusValues.cleanArea,
			cleanTime: this.statusValues.cleanTime,
			errorText: errorCode !== null && errorCode > 0 ? this.errorTexts[String(errorCode)] || String(errorCode) : null,
			connectionChannel: this.connectionChannel,
			// Which controls make sense follows the reported robot state instead of a local guess,
			// so a run started from the phone app shows up here as well.
			phase: robotPhase(stateCode),
			// The station reports its running job through the robot state, so the dock panel can
			// offer Stop for exactly the job that is under way.
			dockActivity: dockActivity(stateCode),
		};

		this.host.onStatus?.(status);
		this.publishModes();
	}

	/** Tells the shell whether any map content arrived, so it can hide its waiting hint. */
	private updateMapPlaceholder(): void {
		this.host.onMapPresence?.(!!this.currentMapBase64Clean || !!this.map);
	}
	// -----------------------------------------------------------------------------
	// Drawing Methods (single source: drawMapV1 + SVGMapRenderer)
	// -----------------------------------------------------------------------------

	/** Draws all map overlays via shared drawMapV1. Call when map or mapData changes. */
	private drawOverlaysFromMap(): void {
		if (!this.map) return;

		this.pinGroup.select("image.goto-pin").style("display", "none").style("opacity", "0");

		if (isQ10MapData(this.map)) {
			// Furniture is a V1 block; a Q10 map never carries it, so the layer is emptied here
			// rather than being left over from the device that was selected before.
			this.furnitureGroup.selectAll("*").remove();
			this.setPathGroupOpacityMode(true);
			this.drawQ10Overlays(this.map);
			this.applyRoomLabelZoomBehavior();
			return;
		}

		this.setPathGroupOpacityMode(false);

		if (!this.mapImage?.dimensions) return;
		const params = this.getMapParams();
		if (!params) return;

		const list = this.map.IMAGE?.segments?.list;
		const duid = this.currentRobotDuid;
		// Rooms are keyed by (mapFlag, roomId): several stored maps of one robot reuse the same
		// room ids and names, so room names may only be resolved within the map they belong to.
		const mapFlag = normalizeMapFlag(this.map.mapFlag);
		const roomScope = duid !== null && mapFlag !== null ? { duid, mapFlag } : null;
		const cacheKey = (id: number): string => (roomScope ? roomNameCacheKey(roomScope.duid, roomScope.mapFlag, id) : "");
		const segmentName = (s: SegmentInfo) => s.name || (roomScope ? this.roomNamesFromStates[cacheKey(s.id)] : "") || "";

		const roomLabels = list
			?.filter((s: SegmentInfo) => segmentName(s))
			.map((s: SegmentInfo) => ({
				segmentId: s.id,
				x: this.robotToSvg({ x: s.center[0], y: s.center[1] }, params).x,
				y: this.robotToSvg({ x: s.center[0], y: s.center[1] }, params).y,
				text: segmentName(s),
			}));

		// Cloud maps: segment names may be empty; fetch from the room states of THIS floor and redraw once.
		// Without a known map flag no request is made at all - names from another floor would be wrong.
		if (roomScope && Array.isArray(list)) {
			const scopeKey = floorScopeKey(roomScope.duid, roomScope.mapFlag);
			const missing = list.filter((s: SegmentInfo) => !s.name && !this.roomNamesFromStates[cacheKey(s.id)]);
			if (missing.length > 0 && this.roomNamesRequestedForFloor !== scopeKey) {
				this.roomNamesRequestedForFloor = scopeKey;
				const segmentIds = missing.map((s: SegmentInfo) => s.id);
				this.connection
					.sendTo(this.instanceId, "get_room_names", { duid: roomScope.duid, floor: roomScope.mapFlag, segmentIds })
					.then((res: any) => {
						if (res && typeof res === "object" && !res.error) {
							for (const [id, name] of Object.entries(res)) {
								const roomId = normalizeRoomId(id);
								if (roomId === null || !name || !String(name).trim()) continue;
								this.roomNamesFromStates[roomNameCacheKey(roomScope.duid, roomScope.mapFlag, roomId)] = String(name).trim();
							}
							this.drawOverlaysFromMap();
						}
					})
					.catch(() => {});
			}
		}

		const baseUrl = this.assetBaseUrl();
		const renderer = this.createSvgRenderer(baseUrl, params);

		drawMapV1(this.map as any, renderer, {
			scaleFactor: VISUAL_BLOCK_SIZE,
			dimensionsAreScaled: false,
			roomLabels: roomLabels?.length ? roomLabels : undefined,
		});
		renderer.drawFurniture(this.buildFurnitureItems(this.map.FURNITURES, params, baseUrl));
		// The map geometry may have changed with this redraw, so the overlay has to be converted
		// again - otherwise it would keep sitting on the geometry of the previous map.
		this.drawLiveOverlay();
		this.applyRoomLabelZoomBehavior();
		this.syncRoomSelectionWithLabels(roomLabels?.map((label) => label.segmentId) ?? []);
	}

	/**
	 * Draws the live track and the live position marker, or clears both.
	 *
	 * Called from two directions: when a new snapshot arrives, and when the map underneath was
	 * redrawn. Both have to go through here, because the overlay only means anything together with
	 * the geometry it was converted against.
	 *
	 * **The map's own robot is hidden while a live position is known.** The two channels report the
	 * same robot at different ages - the map's `ROBOT_POSITION` is as old as the last full map,
	 * the live one is seconds old - and showing both would put two robots in two rooms with no way
	 * for the user to tell which is real. As soon as the live position is gone the map's robot is
	 * shown again, so a device without the live channel is unchanged.
	 *
	 * A Q10 map places its robot in its own overlay pipeline and reports no `get_dynamic_data`, so
	 * nothing is drawn there; the guard is `getMapParams()` returning the geometry either way.
	 */
	private drawLiveOverlay(): void {
		// Before `init()` there is nothing to draw into; the reset path can reach this first.
		if (this.liveTrackGroup.empty() || this.liveRobotGroup.empty()) return;

		// V1 geometry only. `getMapParams()` also answers for a Q10 map, but that pipeline places
		// everything through `Q10MapGeometry` instead - converting the live track with the V1
		// formula would put it on the map at the wrong spot rather than not at all. Those devices
		// do not answer `get_dynamic_data` in the first place, so nothing is lost by refusing.
		const params = this.map && isQ10MapData(this.map) ? null : this.getMapParams();
		const toSvg = params ? (point: Point): Point => this.robotToSvg(point, params) : null;

		const segments = toSvg ? buildLiveTrackSegments(this.liveSnapshot, toSvg) : [];
		const pose = toSvg ? buildLiveRobotPose(this.liveSnapshot, toSvg) : null;

		const renderer = this.createSvgRenderer(this.assetBaseUrl(), params);
		renderer.drawLiveTrack(segments);
		renderer.drawLiveRobot(pose);

		if (pose) this.robotGroup.style("display", "none");
		else this.robotGroup.style("display", null);

		const present = segments.length > 0 || pose !== null;
		if (present !== this.lastLiveTrackPresence) {
			this.lastLiveTrackPresence = present;
			this.host.onLiveTrack?.(present);
		}
	}

	/**
	 * Turns block type 25 into draw commands.
	 *
	 * Three decisions are made here, all of them from `_appanalysis/15-livemap-und-moebel.md`:
	 *
	 *  - **Which pieces.** Only those whose `edit` byte is set. A zero there marks a detection the
	 *    AI proposed and the user never confirmed; the app keeps those in a separate `hide` list
	 *    and does not draw them either (§2.4). Drawing them would put furniture on the map that
	 *    the user never placed - exactly the opposite of what was asked for.
	 *  - **Where.** The corner points are robot coordinates in millimetres, the same unit and
	 *    origin `robotCoordsToLocalCoords` already converts for the robot and the charger, so they
	 *    go through it unchanged (§2.5). Rectangle and rotation follow from the four converted
	 *    points.
	 *  - **Which graphic.** Only assignments proven in the control plugin; an unproven type or
	 *    subtype yields null and is drawn as a neutral outline instead of another type's artwork.
	 *
	 * @param furnitures The `FURNITURES` block, or undefined when the map carries none.
	 * @param params Geometry of the current map.
	 * @param baseUrl Asset folder of the current model, ending in a slash.
	 */
	private buildFurnitureItems(
		furnitures: Furniture[] | undefined,
		params: MapParams,
		baseUrl: string
	): DrawFurnitureInput[] {
		if (!Array.isArray(furnitures) || !furnitures.length) return [];

		const items: DrawFurnitureInput[] = [];
		for (const piece of furnitures) {
			if (!piece || typeof piece !== "object") continue;
			if (!piece.edit) continue;

			const corners = [
				this.robotToSvg({ x: piece.x1, y: piece.y1 }, params),
				this.robotToSvg({ x: piece.x2, y: piece.y2 }, params),
				this.robotToSvg({ x: piece.x3, y: piece.y3 }, params),
				this.robotToSvg({ x: piece.x4, y: piece.y4 }, params),
			];
			const rect = furnitureRect(corners);
			if (!rect) continue;

			const graphic = furnitureGraphic(piece.type, piece.subType);
			items.push({
				id: piece.id,
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				centerX: rect.centerX,
				centerY: rect.centerY,
				angle: rect.angle,
				imageHref: graphic ? baseUrl + furnitureAssetFileName(graphic.image) : null,
				title: graphic?.title ?? null,
			});
		}
		return items;
	}

	/**
	 * Folder the current device's Roborock graphics live in, ending in a slash.
	 *
	 * Shared by every V1 draw path so they cannot drift apart. The fallback model only decides
	 * which artwork is attempted; a file that is not there is handled by the probing in
	 * {@link SVGMapRenderer}, never shown as a broken image.
	 * @returns The URL prefix of the density folder.
	 */
	private assetBaseUrl(): string {
		const modelFolder =
			this.model ||
			(this.currentRobotDuid && this.robotModels[this.currentRobotDuid]) ||
			(Object.keys(this.robotModels).length ? this.robotModels[Object.keys(this.robotModels)[0]] : null) ||
			"roborock.vacuum.a147";
		return `${ASSET_BASE}/${modelFolder}/drawable-mdpi/`;
	}

	private createSvgRenderer(baseUrl: string, params: MapParams | null): SVGMapRenderer {
		return this.createSvgRendererWithOptions(baseUrl, params, {});
	}

	private createSvgRendererWithOptions(
		baseUrl: string,
		params: MapParams | null,
		options: Partial<{ obstacleRadius: number; obstacleImageSize: number; robotSize: number; chargerSize: number }>
	): SVGMapRenderer {
		return new SVGMapRenderer({
			groups: {
				carpetGroup: this.carpetGroup,
				pathGroup: this.pathGroup,
				mopPathGroup: this.mopPathGroup,
				backwashPathGroup: this.backwashPathGroup,
				pureCleanPathGroup: this.pureCleanPathGroup,
				chargerGroup: this.chargerGroup,
				robotGroup: this.robotGroup,
				pinGroup: this.pinGroup,
				obstacleGroup: this.obstacleGroup,
				roomNameGroup: this.roomNameGroup,
				zonesOverlayGroup: this.zonesOverlayGroup,
				furnitureGroup: this.furnitureGroup,
				liveTrackGroup: this.liveTrackGroup,
				liveRobotGroup: this.liveRobotGroup,
			},
			pathMainWidth: this.rescaler.pathMainWidth(),
			pathMopWidth: this.rescaler.pathMopWidth(),
			pathBackwashWidth: this.rescaler.pathBackwashWidth(),
			robotSize: options.robotSize ?? this.rescaler.robotSize(),
			chargerSize: options.chargerSize ?? this.rescaler.chargerSize(),
			pinWidth: this.rescaler.pinWidth(),
			pinHeight: this.rescaler.pinHeight(),
			pinYOffset: this.rescaler.pinYOffset(),
			obstacleRadius: options.obstacleRadius ?? this.rescaler.scale() * UI_CONSTANTS.OBSTACLE_RADIUS_BASE,
			obstacleImageSize: options.obstacleImageSize ?? this.rescaler.scale() * UI_CONSTANTS.OBSTACLE_RADIUS_BASE * 1.8,
			obstacleAssetBaseUrl: baseUrl,
			obstacleMapping: OBSTACLE_MAPPING,
			obstacleFileName: obstacleAssetFileName,
			obstacleFileNameAlt: obstacleAssetFileNameAlt,
			onObstacleClick: (event: MouseEvent, obstacleData: unknown) => {
				this.handleObstacleClick(event, obstacleData, params);
			},
			onRoomLabelClick: (segmentId: number, event: MouseEvent) => {
				if (this.isDragGesture(event)) return;
				this.toggleRoomSelection(segmentId);
			},
			selectedSegmentIds: this.selectedRoomIds,
			robotImageHref: IMG_ROBOT_ORIGINAL,
			chargerImageHref: IMG_CHARGER,
			goToPinImageHref: IMG_GO_TO_PIN,
		});
	}

	private handleObstacleClick(event: MouseEvent, obstacleData: unknown, params: MapParams | null): void {
		if (!this.currentRobotDuid) return;
		event.stopPropagation();

		if (Array.isArray(obstacleData)) {
			const d = obstacleData as [number, number, number, unknown, unknown, unknown, unknown];
			if (!params) return;
			this.selectedObstacleID = d?.[6];
			const robotPoint = { x: d[0], y: d[1] };
			const worldPoint = robotCoordsToLocalCoords(robotPoint, params);
			this.popupX = worldPoint.x;
			this.popupY = worldPoint.y;
			this.showObstaclePopup(this.selectedObstacleID, 1);
			return;
		}

		if (!obstacleData || typeof obstacleData !== "object") return;
		const q10Obstacle = obstacleData as Q10OverlayObstacleData;
		if (q10Obstacle.kind !== "q10Obstacle") return;

		this.popupX = q10Obstacle.x;
		this.popupY = q10Obstacle.y;
		if (q10Obstacle.obstacleId == null) return;
		this.selectedObstacleID = q10Obstacle.obstacleId;
		this.showObstaclePopup(this.selectedObstacleID, 1);

	}

	private showObstaclePopup(obstacleId: unknown, type: number): void {
		if (obstacleId == null || !this.currentRobotDuid) return;
		if (this.popupTimeout) clearTimeout(this.popupTimeout);
		this.connection
			.sendTo(this.instanceId, "get_obstacle_image", {
				obstacleId,
				duid: this.currentRobotDuid,
				type,
			})
			.then((response: any) => {
				if (response?.image) {
					let imageData = response.image as string;
					if (typeof imageData === "string" && !imageData.startsWith("data:image/")) {
						imageData = "data:image/png;base64," + imageData;
					}
					this.popupImage.src = imageData;
					this.popup.style.display = "block";
					this.updatePopupPosition();
					this.popupTimeout = window.setTimeout(() => this.hideObstaclePopup(), 3000);
				}
		})
			.catch((err) => {
				console.error("Error getting obstacle image:", err);
				this.showError(this.t("ui_command_failed", "Command failed: %s", this.errorText(err)));
			});
		this.updatePopupPosition();
	}

	private setPathGroupOpacityMode(isQ10: boolean): void {
		if (isQ10) {
			this.mopPathGroup.style("opacity", 1);
			this.pathGroup.style("opacity", 1);
			this.backwashPathGroup.style("opacity", 1);
			this.pureCleanPathGroup.style("opacity", 1);
			return;
		}

		this.mopPathGroup.style("opacity", 0.18);
		this.pathGroup.style("opacity", 0.5);
		this.backwashPathGroup.style("opacity", 0.2);
		this.pureCleanPathGroup.style("opacity", 1);
	}

	private normalizeQ10NativePathType(type: number | undefined): number {
		if (type === 0 || type === 1 || type === 2 || type === 3 || type === 4) return type;
		return 0;
	}

	private historyUpdateToQ10NativePathType(update: number | undefined): number {
		if (update === 6) return 0;
		if (update === 4) return 1;
		if (update === 5) return 2;
		return 0;
	}

	private getQ10PathOverlayPoints(map: Q10FrontendMapData): Array<{ x: number; y: number; type: number }> {
		const creator = map.q10CreatorData;
		if (creator?.pathPixels?.length) {
			return creator.pathPixels.map((point) => ({
				x: point.x,
				y: point.y,
				type: this.normalizeQ10NativePathType(point.type)
			}));
		}

		const resolution = Math.max(map.header.resolution, 0.001);
		const sourcePathPoints = map.q10SourceData?.pathPoints ?? [];
		if (sourcePathPoints.length) {
			return sourcePathPoints.map((point) => ({
				x: point.x / resolution,
				y: point.y / resolution,
				type: this.normalizeQ10NativePathType(point.type)
			}));
		}

		const historyPoints = map.history ?? [];
		return historyPoints.map((point) => ({
			x: (point.x - map.header.minX) / resolution,
			y: (map.header.maxY - point.y) / resolution,
			type: this.historyUpdateToQ10NativePathType(point.update)
		}));
	}

	private packageQ10PathPointsLikeNative(points: Array<{ x: number; y: number; type: number }>): Array<Array<Array<{ x: number; y: number }>>> {
		const paths: Array<Array<Array<{ x: number; y: number }>>> = [[], [], [], [], []];
		let previous: { x: number; y: number; type: number } | null = null;

		for (const point of points) {
			const bucket = paths[point.type] ?? paths[0]!;
			const changedType = previous?.type !== point.type;
			if (changedType) {
				const subPath: Array<{ x: number; y: number }> = [];
				if (previous && previous.type !== -1) {
					subPath.push({ x: previous.x, y: previous.y });
				} else {
					subPath.push({ x: point.x, y: point.y });
				}
				subPath.push({ x: point.x, y: point.y });
				bucket.push(subPath);
			} else if (bucket.length > 0) {
				bucket[bucket.length - 1]!.push({ x: point.x, y: point.y });
			}
			previous = point;
		}

		return paths;
	}

	private q10PathSegmentsToSvgPath(segments: Array<Array<{ x: number; y: number }>>, geometry: Q10MapGeometry): string {
		const drawable = segments.filter((segment) => segment.length >= 2);
		if (!drawable.length) return "";

		return drawable
			.map((segment) => {
				const start = geometry.mapPoint(segment[0]!);
				const commands = [`M${start.x} ${start.y}`];
				for (let index = 1; index < segment.length; index++) {
					const point = geometry.mapPoint(segment[index]!);
					commands.push(`L${point.x} ${point.y}`);
				}
				return commands.join(" ");
			})
			.join(" ");
	}

	private appendQ10SvgPath(
		group: d3.Selection<SVGGElement, unknown, HTMLElement, any>,
		pathData: string,
		className: string,
		stroke: string,
		lineWidth: number,
		dash?: readonly number[],
		dashOffset = 0
	): void {
		if (!pathData) return;

		const path = group
			.append("path")
			.attr("class", className)
			.attr("d", pathData)
			.style("fill", "none")
			.style("stroke", stroke)
			.style("stroke-width", `${lineWidth}px`)
			.style("stroke-linecap", "round")
			.style("stroke-linejoin", "round");

		if (dash) {
			path.style("stroke-dasharray", dash.join(",")).style("stroke-dashoffset", `${dashOffset}px`);
		}
	}

	private drawQ10PathOverlays(map: Q10FrontendMapData, geometry: Q10MapGeometry): void {
		const points = this.getQ10PathOverlayPoints(map);
		if (!points.length) return;

		const paths = this.packageQ10PathPointsLikeNative(points);
		const primaryWidth = geometry.mapCanvasSize().width / 375;
		const glowWidth = geometry.mapLength(0.3 / Math.max(map.header.resolution, 0.001));
		const wideGlowColor = q10PackedArgbToCss(1728053247);
		const solidWhite = q10PackedArgbToCss(4294967295);
		const thinGlowColor = q10PackedArgbToCss(1728053247);
		const dashedColor = q10PackedArgbToCss(2583691263);

		const pathStyles = [
			{
				group: this.pathGroup,
				classPrefix: "q10-main-type0",
				segments: paths[0]!,
				layers: [
					{ stroke: wideGlowColor, width: glowWidth },
					{ stroke: solidWhite, width: primaryWidth }
				]
			},
			{
				group: this.mopPathGroup,
				classPrefix: "q10-main-type1",
				segments: paths[1]!,
				layers: [
					{ stroke: wideGlowColor, width: glowWidth },
					{ stroke: thinGlowColor, width: primaryWidth }
				]
			},
			{
				group: this.backwashPathGroup,
				classPrefix: "q10-main-type2",
				segments: paths[2]!,
				layers: [
					{ stroke: solidWhite, width: primaryWidth }
				]
			},
			{
				group: this.pureCleanPathGroup,
				classPrefix: "q10-main-type3",
				segments: paths[3]!,
				layers: [
					{
						stroke: dashedColor,
						width: primaryWidth,
						dash: [primaryWidth, primaryWidth * 3],
						dashOffset: primaryWidth * 3
					}
				]
			}
		] as const;

		for (const pathStyle of pathStyles) {
			const pathData = this.q10PathSegmentsToSvgPath(pathStyle.segments, geometry);
			if (!pathData) continue;
			for (let index = 0; index < pathStyle.layers.length; index++) {
				const layer = pathStyle.layers[index]!;
				this.appendQ10SvgPath(
					pathStyle.group,
					pathData,
					`${pathStyle.classPrefix}-${index}`,
					layer.stroke,
					layer.width,
					"dash" in layer ? layer.dash : undefined,
					"dashOffset" in layer ? layer.dashOffset : 0
				);
			}
		}
	}

	private drawQ10Overlays(map: Q10FrontendMapData): void {
		const creator = map.q10CreatorData;
		if (!creator?.q10Detected) return;

		this.carpetGroup.selectAll("*").remove();
		this.pathGroup.selectAll("*").remove();
		this.mopPathGroup.selectAll("*").remove();
		this.backwashPathGroup.selectAll("*").remove();
		this.pureCleanPathGroup.selectAll("*").remove();
		this.chargerGroup.selectAll("*").remove();
		this.robotGroup.selectAll("*").remove();
		this.zonesOverlayGroup.selectAll("*").remove();
		this.obstacleGroup.selectAll("*").remove();
		this.roomNameGroup.selectAll("*").remove();
		this.drawZones();
		const modelFolder =
			this.model ||
			(this.currentRobotDuid && this.robotModels[this.currentRobotDuid]) ||
			"roborock.vacuum.ss09";
		const baseUrl = `${ASSET_BASE}/${modelFolder}/drawable-mdpi/`;
		const geometry = new Q10MapGeometry(map, 1, this.getQ10CanvasScale(map));
		const renderer = this.createSvgRendererWithOptions(baseUrl, null, {
			obstacleRadius: 0,
			obstacleImageSize: geometry.imgRateLength(6),
			robotSize: geometry.imgRateLength(8),
			chargerSize: geometry.imgRateLength(8)
		});

		this.drawQ10PathOverlays(map, geometry);
		this.drawQ10RoomSelectionMask(creator, geometry);

		const virtualWalls: DrawVirtualWallInput[] = creator.virtualWalls
			.filter((wall) => wall.points.length >= 2)
			.map((wall) => {
				const start = geometry.mapPoint(wall.points[0]!);
				const end = geometry.mapPoint(wall.points[1]!);
				return {
					x1: start.x,
					y1: start.y,
					x2: end.x,
					y2: end.y,
					stroke: "rgba(255, 69, 58, 1)",
					lineWidth: Math.max(2, geometry.layoutLength(2))
				};
			});

		if (virtualWalls.length) {
			renderer.drawRestrictedZones([], virtualWalls);
		}

		if (creator.chargerPixel) {
			const chargerPoint = geometry.mapPoint(creator.chargerPixel);
			renderer.drawCharger({
				x: chargerPoint.x,
				y: chargerPoint.y
			});
		}

		if (creator.robotPixel) {
			const robotPose = geometry.mapPose(creator.robotPixel);
			if (robotPose) {
				renderer.drawRobot({
					x: robotPose.x,
					y: robotPose.y,
					angle: robotPose.phi ?? 0
				});
			}
		}

		const obstacleItems: DrawObstacleInput[] = [];
		for (const entry of creator.obstaclePixels) {
			const point = geometry.mapPoint(entry.point);
			obstacleItems.push({
				x: point.x,
				y: point.y,
				typeOrSuffix: "q10",
				imageHref: `${baseUrl}src_resources_map_images_light_mapobstacle.png`,
				imageSize: geometry.imgRateLength(6),
				hideBackground: true,
				obstacleData: { kind: "q10Obstacle", type: "obstacle", x: point.x, y: point.y } satisfies Q10OverlayObstacleData
			});
		}
		for (const entry of creator.skipPixels) {
			const point = geometry.mapPoint(entry.point);
			obstacleItems.push({
				x: point.x,
				y: point.y,
				typeOrSuffix: "q10-skip",
				imageHref: `${baseUrl}src_resources_map_images_light_map_tiaoguo_icon.png`,
				imageSize: geometry.imgRateLength(6),
				hideBackground: true,
				obstacleData: { kind: "q10Obstacle", type: "skip", x: point.x, y: point.y } satisfies Q10OverlayObstacleData
			});
		}
		for (const entry of creator.suspectedPoints) {
			const point = geometry.mapPoint(entry.point);
			const imageHref =
				entry.type === "threshold"
					? `${baseUrl}src_resources_map_images_light_map_yisi_menkan.png`
					: entry.type === "easycard"
						? `${baseUrl}src_resources_map_images_light_map_yisi_yika.png`
						: `${baseUrl}src_resources_map_images_light_map_yisi_xuanya.png`;
			obstacleItems.push({
				x: point.x,
				y: point.y,
				typeOrSuffix: `q10-${entry.type}`,
				imageHref,
				imageSize: geometry.layoutLength(16),
				hideBackground: true,
				obstacleData: { kind: "q10Obstacle", type: entry.type, x: point.x, y: point.y } satisfies Q10OverlayObstacleData
			});
		}

		const roomLabels: DrawRoomLabelInput[] = creator.roomModels
			.filter((room) => room.roomName && room.roomName.trim())
			.map((room) => {
				const label = room.roomName.trim();
				const point = geometry.mapPoint(room.transCenterPoint);
				const colorIndex = room.colorID >= 0 && room.colorID < Q10_ROOM_TAG_BASE.length ? room.colorID : 0;
				const textWidth = measureQ10RoomLabelWidth(label);
				const bubbleDiameter = Q10_ROOM_LABEL_LAYOUT.bubbleRadius * 2;
				const totalWidth = bubbleDiameter + Q10_ROOM_LABEL_LAYOUT.gap + textWidth + Q10_ROOM_LABEL_LAYOUT.widthPadding;
				const bubbleCenterOffsetX = -totalWidth / 2 + Q10_ROOM_LABEL_LAYOUT.bubbleRadius;
				const textOffsetX = -totalWidth / 2 + bubbleDiameter + Q10_ROOM_LABEL_LAYOUT.gap;
				return {
					segmentId: room.roomID,
					x: point.x,
					y: point.y,
					text: label,
					iconHref: `${baseUrl}${q10RoomTagAssetFileName(room.roomType)}`,
					bubbleFill: Q10_ROOM_TAG_BASE[colorIndex],
					bubbleStroke: Q10_ROOM_TAG_STROKE[colorIndex],
					textFill: Q10_ROOM_TAG_BASE[colorIndex],
					badgeText: room.cleanOrder > 0 ? String(room.cleanOrder) : null,
					bubbleRadius: Q10_ROOM_LABEL_LAYOUT.bubbleRadius,
					iconSize: Q10_ROOM_LABEL_LAYOUT.iconSize,
					gap: Q10_ROOM_LABEL_LAYOUT.gap,
					bubbleCenterOffsetX,
					textOffsetX,
					badgeCenterOffsetX: bubbleCenterOffsetX - 3,
					badgeCenterOffsetY: 12
				};
			});

		renderer.drawObstacles(obstacleItems);
		renderer.drawRoomLabels(roomLabels);
		this.syncRoomSelectionWithLabels(roomLabels.map((label) => label.segmentId));
	}

	// -----------------------------------------------------------------------------
	// Room selection
	// -----------------------------------------------------------------------------

	/**
	 * Keeps the selection in sync with what the map actually shows and refreshes the panel.
	 * @param drawnSegmentIds Segment ids of the room labels just drawn.
	 */
	private syncRoomSelectionWithLabels(drawnSegmentIds: number[]): void {
		const available = new Set(drawnSegmentIds);
		this.roomLabelCount = available.size;
		for (const selected of Array.from(this.selectedRoomIds)) {
			if (!available.has(selected)) this.selectedRoomIds.delete(selected);
		}
		this.renderRoomSelection();
	}

	/** True when the pointer moved far enough that the "click" was really a pan. */
	private isDragGesture(event: MouseEvent): boolean {
		if (!this.pointerDownAt) return false;
		return Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y) > 5;
	}

	/** Toggles a room on click in the map. */
	private toggleRoomSelection(segmentId: number): void {
		const roomId = normalizeRoomId(segmentId);
		if (roomId === null) return;

		if (this.selectedRoomIds.has(roomId)) this.selectedRoomIds.delete(roomId);
		else this.selectedRoomIds.add(roomId);

		this.applyRoomSelectionStyling();
		this.renderRoomSelection();
	}

	private clearRoomSelection(): void {
		if (!this.selectedRoomIds.size) return;
		this.selectedRoomIds.clear();
		this.applyRoomSelectionStyling();
		this.renderRoomSelection();
	}

	/** Shows/hides the highlight box of each drawn room label without a full redraw. */
	private applyRoomSelectionStyling(): void {
		const selected = this.selectedRoomIds;
		this.roomNameGroup.selectAll<SVGGElement, unknown>("g.room-label").each(function () {
			const label = d3.select(this);
			const segmentId = normalizeRoomId(label.attr("data-segment-id"));
			const box = label.select("rect.room-label-selection");
			if (segmentId !== null && selected.has(segmentId)) box.style("display", null);
			else box.style("display", "none");
		});
	}

	/** Publishes how many rooms are selected and how many the current map offers. */
	private renderRoomSelection(): void {
		this.host.onRooms?.({ selected: this.selectedRoomIds.size, available: this.roomLabelCount });
	}

	/** Publishes the zone count; the limit is a UI decision, see MAX_ZONES. */
	private renderZoneHint(): void {
		this.host.onZones?.({ count: this.rects.length, max: MAX_ZONES, atLimit: this.rects.length >= MAX_ZONES });
	}

	private updateBackgroundImageFromStateCache(): void {
		const image = this.currentMapBase64Clean;
		this.updateMapPlaceholder();
		if (!image) {
			this.mapImageElement.attr("href", null);
			return;
		}

		this.pinGroup.select("image.goto-pin").style("display", "none").style("opacity", 0);
		this.drawBackgroundImage(image);
	}

	private parseQ10CleaningInfoState(raw: unknown): Record<string, unknown> | null {
		if (!raw) return null;
		if (typeof raw === "string") {
			try {
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? parsed as Record<string, unknown>
					: null;
			} catch {
				return null;
			}
		}

		return typeof raw === "object" && !Array.isArray(raw)
			? raw as Record<string, unknown>
			: null;
	}

	private parseQ10RoomIdsState(raw: unknown): number[] {
		if (!raw) return [];

		const normalize = (value: unknown): number[] => {
			if (!Array.isArray(value)) return [];
			return value
				.map((entry) => Number(entry))
				.filter((entry) => Number.isInteger(entry) && entry > 0);
		};

		if (typeof raw === "string") {
			try {
				return normalize(JSON.parse(raw));
			} catch {
				return [];
			}
		}

		return normalize(raw);
	}

	private getQ10SelectedRoomIds(): Set<number> {
		if (this.q10Status !== 18) return new Set<number>();

		if (this.q10CurrentCleanRoomIds.length > 0) {
			return new Set(this.q10CurrentCleanRoomIds);
		}

		const cleanInfo = this.q10CleaningInfo;
		if (!cleanInfo) return new Set<number>();

		const cleanInfoRoomIds = this.parseQ10RoomIdsState(cleanInfo.room_id_list);
		if (cleanInfoRoomIds.length > 0) {
			return new Set(cleanInfoRoomIds);
		}

		const targetSegmentId = Number(cleanInfo.target_segment_id);
		if (Number.isInteger(targetSegmentId) && targetSegmentId > 0) {
			return new Set([targetSegmentId]);
		}

		return new Set<number>();
	}

	private getQ10CanvasScale(map: Q10FrontendMapData): number {
		const naturalWidth = this.image?.naturalWidth ?? 0;
		const sizeX = map.header?.sizeX ?? 0;
		if (naturalWidth > 0 && sizeX > 0) {
			return naturalWidth / sizeX;
		}
		return Q10_CANVAS_SCALE;
	}

	private q10PolygonToSvgPath(points: Array<{ x: number; y: number }>, geometry: Q10MapGeometry): string {
		if (points.length < 2) return "";
		const start = geometry.mapPoint(points[0]!);
		const segments = [`M${start.x} ${start.y}`];
		for (let index = 1; index < points.length; index++) {
			const point = geometry.mapPoint(points[index]!);
			segments.push(`L${point.x} ${point.y}`);
		}
		segments.push("Z");
		return segments.join(" ");
	}

	private drawQ10RoomSelectionMask(
		creator: NonNullable<Q10FrontendMapData["q10CreatorData"]>,
		geometry: Q10MapGeometry
	): void {
		this.zonesOverlayGroup.selectAll("*").remove();

		const selectedRoomIds = this.getQ10SelectedRoomIds();
		if (!selectedRoomIds.size) return;

		const roomMaskPath = creator.roomModels
			.filter((room) => !selectedRoomIds.has(room.roomID))
			.flatMap((room) => room.borderArr)
			.map((polygon) => this.q10PolygonToSvgPath(polygon, geometry))
			.filter(Boolean)
			.join(" ");

		if (!roomMaskPath) return;

		this.zonesOverlayGroup
			.append("path")
			.attr("class", "q10-room-selection-mask")
			.attr("d", roomMaskPath)
			.attr("fill", "rgba(0, 0, 0, 0.36)")
			.attr("fill-rule", "evenodd");
	}

	/**
	 * The on-screen height a room name should have, in CSS pixels.
	 *
	 * Worked through rather than guessed, because the scaling chain hides the real number:
	 * a label sits in `roomNameGroup` inside `mainGroup`, and `mainGroup` carries the d3 zoom
	 * transform with the factor `k = wheelZoom`. {@link applyRoomLabelZoomBehavior} then gives
	 * the label itself `scale(1 / k)`. A length L drawn inside the label therefore lands on
	 * screen as `L * (1/k) * k = L` - the two cancel exactly. The renderer's
	 * `font-size: {@link ROOM_LABEL_BASE_FONT} px` was consequently **12 CSS pixels on screen,
	 * at every zoom level and on every display**, which is why raising the drawn size alone or
	 * zooming in never made the names any bigger. The counter-scale is not the bug though - it
	 * is what keeps the names constant and readable at any zoom - so it stays, and this method
	 * replaces the constant it cancels down to.
	 *
	 * The target is the wording of the Roborock app: readable on a tablet at arm's length,
	 * which is around 17 px at a normal map size instead of 12. From there:
	 *
	 *  - it follows the size the map is really shown at, the shorter edge of the viewport
	 *    against a {@link ROOM_LABEL_REFERENCE_EDGE} px reference, damped by a square root so a
	 *    maximised window grows the names noticeably without doubling them;
	 *  - it is lifted where a CSS pixel is physically small (`devicePixelRatio`, capped at 3);
	 *  - and it is clamped in CSS pixels, not in map units, so the floor really is a floor on
	 *    screen: {@link ROOM_LABEL_MIN_PX} px in a narrow tab or a far zoomed-out map,
	 *    {@link ROOM_LABEL_MAX_PX} px at the top so a name cannot cover its own room.
	 *
	 * Measured results: 400 px edge → 14 px (floor); 620 px → 17 px; 900 px → 20.5 px;
	 * 1400 px → 25.5 px; the same 620 px viewport on a 2x display → 19.6 px.
	 */
	private roomLabelScreenFontPx(): number {
		const container = this.svgContainer.node() as HTMLElement | null;
		const shortEdge = container ? Math.min(container.clientWidth, container.clientHeight) : 0;
		const sizeFactor = shortEdge > 0 ? Math.sqrt(shortEdge / ROOM_LABEL_REFERENCE_EDGE) : 1;

		const density = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
		const densityFactor = 1 + (density - 1) * ROOM_LABEL_DENSITY_WEIGHT;

		const wanted = ROOM_LABEL_TARGET_PX * sizeFactor * densityFactor;
		return Math.min(ROOM_LABEL_MAX_PX, Math.max(ROOM_LABEL_MIN_PX, wanted));
	}

	private applyRoomLabelZoomBehavior(): void {
		// One transform, not two: the `1 / wheelZoom` half cancels the map zoom so the label
		// keeps a fixed size on screen, and the second half turns that fixed size into the
		// number {@link roomLabelScreenFontPx} asked for, expressed as a multiple of the size
		// the renderer actually drew.
		const zoomScale = (1 / Math.max(this.wheelZoom, 0.001)) * (this.roomLabelScreenFontPx() / ROOM_LABEL_BASE_FONT);
		this.roomNameGroup.selectAll<SVGGElement, unknown>("g.room-label").each(function () {
			const element = d3.select(this);
			const x = Number(element.attr("data-x") || 0);
			const y = Number(element.attr("data-y") || 0);
			element.attr("transform", `translate(${x}, ${y}) scale(${zoomScale})`);
		});
	}

	private updateMapImageSize() {
		if (!this.image.naturalWidth || !this.image.naturalHeight) return;

		// Use natural size of the image (1:1 scale)
		const displayWidth = this.image.naturalWidth;
		const displayHeight = this.image.naturalHeight;

		this.mapImageElement
			.attr("href", this.image.src)
			.attr("width", displayWidth)
			.attr("height", displayHeight)
			.attr("transform", null)
			.style("image-rendering", "pixelated");
	}

	private drawBackgroundImage(mapBase64: string) {
		if (!mapBase64) {
			this.mapImageElement.attr("href", null);
			return;
		}

		this.image.src = mapBase64;
		this.image.onload = () => {
			const tempCanvas = document.createElement("canvas");
			const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
			if (!tempCtx) return;

			tempCanvas.width = this.image.width;
			tempCanvas.height = this.image.height;
			tempCtx.imageSmoothingEnabled = false;
			tempCtx.drawImage(this.image, 0, 0);

			let mapMaxX = 0;
			this.mapMaxY = 0;
			this.mapMinX = this.image.width;
			this.mapMinY = this.image.height;

			const imageData = tempCtx.getImageData(0, 0, this.image.width, this.image.height);
			const pixels = imageData.data;
			for (let i = 0; i < pixels.length; i += 4) {
				const alpha = pixels[i + 3];
				if (alpha > 50) {
					const x = (i / 4) % this.image.width;
					const y = Math.floor(i / 4 / this.image.width);
					if (x < this.mapMinX) this.mapMinX = x;
					if (x > mapMaxX) mapMaxX = x;
					if (y < this.mapMinY) this.mapMinY = y;
					if (y > this.mapMaxY) this.mapMaxY = y;
				}
			}

			if (this.mapMinX > mapMaxX) {
				this.mapMinX = 0;
				mapMaxX = this.image.width;
				this.mapMinY = 0;
				this.mapMaxY = this.image.height;
			}

			// Calculate content dimensions based on detected pixels
			this.mapSizeX = mapMaxX - this.mapMinX;
			this.mapSizeY = this.mapMaxY - this.mapMinY;

			// Sanity check
			if (this.mapSizeX <= 0) this.mapSizeX = this.image.width;
			if (this.mapSizeY <= 0) this.mapSizeY = this.image.height;

			this.updateMapImageSize();

			this.carpetGroup.attr("transform", null);

			// Zoom-to-fit; the same calculation is reused when the viewport is resized.
			const fitTransform = this.computeFitTransform();
			if (fitTransform) {
				this.initialTransform = fitTransform;
				this.applyFitTransform(fitTransform);
			}

			if (this.map) {
				this.drawOverlaysFromMap();
			}
		};
	}

	private drawZones() {
		const dragHandler = d3
			.drag<SVGGElement, Rect>()
			.on("start", (event: any) => {
				const element = event.sourceEvent.target.closest("g.zone");
				if (element) d3.select(element).raise().style("cursor", "grabbing");
			})
			.on("drag", (event: any, d: Rect) => {
				if (!this.hasDrawableMapBounds()) return;
				const minBoundX = this.mapMinX,
					minBoundY = this.mapMinY,
					maxBoundX = this.mapMinX + this.mapSizeX,
					maxBoundY = this.mapMinY + this.mapSizeY;
				let newX = Math.max(minBoundX, d.x + event.dx);
				let newY = Math.max(minBoundY, d.y + event.dy);
				if (newX + d.width > maxBoundX) newX = maxBoundX - d.width;
				if (newY + d.height > maxBoundY) newY = maxBoundY - d.height;
				d.x = newX;
				d.y = newY;
				const element = event.sourceEvent.target.closest("g.zone");
				if (element) d3.select(element).attr("transform", `translate(${d.x}, ${d.y})`);
			})
			.on("end", (event: any) => {
				const element = event.sourceEvent.target.closest("g.zone");
				if (element) d3.select(element).style("cursor", "move");
				this.updateRobotZones();
			});

		const resizeHandler = d3
			.drag<SVGCircleElement, Rect>()
			.on("start", (event: any) => {
				event.sourceEvent.stopPropagation();
				const element = event.sourceEvent.target;
				if (element) d3.select(element).raise();
			})
			.on("drag", (event: any, d: Rect) => {
				if (!this.hasDrawableMapBounds()) return;
				const maxBoundX = this.mapMinX + this.mapSizeX,
					maxBoundY = this.mapMinY + this.mapSizeY;
				let newWidth = Math.max(d.width + event.dx, 20);
				let newHeight = Math.max(d.height + event.dy, 20);
				if (d.x + newWidth > maxBoundX) newWidth = maxBoundX - d.x;
				if (d.y + newHeight > maxBoundY) newHeight = maxBoundY - d.y;
				d.width = newWidth;
				d.height = newHeight;
				const element = event.sourceEvent.target;
				if (element) {
					const parentGroup = d3.select(element.parentNode as SVGGElement);
					parentGroup.select("rect").attr("width", d.width).attr("height", d.height);
					parentGroup.select("circle.zone-handle").attr("cx", d.width).attr("cy", d.height);
				}
			})
			.on("end", () => this.updateRobotZones());

		const selection = this.zoneGroup.selectAll("g.zone").data(this.rects, (d: any) => d.id);
		selection.exit().remove();
		const enterGroup = selection.enter().append("g").attr("class", "zone").call(dragHandler as any);
		enterGroup.append("rect").attr("class", "zone-rect").attr("x", 0).attr("y", 0).style("stroke-width", this.rescaler.zoneStrokeWidth());
		enterGroup.append("circle").attr("class", "zone-handle").attr("r", this.rescaler.zoneHandleRadius()).call(resizeHandler as any);
		const mergedSelection = selection.merge(enterGroup as any);
		mergedSelection.attr("transform", (d: Rect) => `translate(${d.x}, ${d.y})`);
		mergedSelection
			.select("rect")
			.attr("width", (d: Rect) => d.width)
			.attr("height", (d: Rect) => d.height)
			.style("stroke-width", this.rescaler.zoneStrokeWidth());
		mergedSelection
			.select("circle.zone-handle")
			.attr("cx", (d: Rect) => d.width)
			.attr("cy", (d: Rect) => d.height)
			.attr("r", this.rescaler.zoneHandleRadius());
	}

	// -----------------------------------------------------------------------------
	// Helper Methods
	// -----------------------------------------------------------------------------

	private updateRobotZones() {
		const params = this.getMapParams();
		if (!params) return;
		this.zones = [];
		const cleanCount = this.cleanCount;
		for (const rect of this.rects) {
			const p1 = { x: rect.x, y: rect.y };
			const p2 = { x: rect.x + rect.width, y: rect.y + rect.height };
			const coords1 = localCoordsToRobotCoords(p1, params);
			const coords2 = localCoordsToRobotCoords(p2, params);
			this.zones.push([
				Math.min(coords1.x, coords2.x),
				Math.min(coords1.y, coords2.y),
				Math.max(coords1.x, coords2.x),
				Math.max(coords1.y, coords2.y),
				cleanCount,
			]);
		}
	}

	private updatePopupPosition() {
		if (this.popup.style.display === "block" && this.popupX !== undefined && this.popupY !== undefined) {
			const transform = d3.zoomTransform(this.svgContainer.node() as Element);
			const svgCoords = this.worldToSvgCoords(this.popupX, this.popupY);
			const screenCoords = transform.apply([svgCoords.x, svgCoords.y]);
			this.popup.style.left = `${screenCoords[0]}px`;
			this.popup.style.top = `${screenCoords[1]}px`;
		}
	}

	private handleZoom(event: any) {
		const transform = event.transform;
		this.mainGroup.attr("transform", transform);
		this.wheelZoom = transform.k;
		// Only a real gesture counts; programmatic fits pass no source event.
		if (event.sourceEvent) this.userAdjustedView = true;

		this.zoneGroup.selectAll("rect.zone-rect").style("stroke-width", this.rescaler.zoneStrokeWidth());
		this.zoneGroup.selectAll("circle.zone-handle").attr("r", this.rescaler.zoneHandleRadius());

		const q10Geometry = isQ10MapData(this.map)
			? new Q10MapGeometry(this.map, 1, this.getQ10CanvasScale(this.map))
			: null;
		const scaledRobotSize = q10Geometry ? q10Geometry.imgRateLength(8) : this.rescaler.robotSize();
		const params = this.getMapParams();
		// Robot and charger positions only exist on V1 maps; a Q10 map places them in its overlays.
		const v1Map = this.map && !isQ10MapData(this.map) ? (this.map as MapData) : undefined;
		this.robotGroup.selectAll("image.robot").attr("width", scaledRobotSize).attr("height", scaledRobotSize);
		if (params && v1Map?.ROBOT_POSITION?.position) {
			const pos = v1Map.ROBOT_POSITION.position;
			const svgCoords = this.robotToSvg({ x: pos[0], y: pos[1] }, params);
			const angle = -(v1Map.ROBOT_POSITION.angle ?? 0) + 90;
			this.robotGroup
				.selectAll("image.robot")
				.attr("transform", `translate(${svgCoords.x}, ${svgCoords.y}) rotate(${angle}) translate(${-scaledRobotSize / 2}, ${-scaledRobotSize / 2})`);
		}

		const scaledChargerSize = q10Geometry ? q10Geometry.imgRateLength(8) : this.rescaler.chargerSize();
		this.chargerGroup.selectAll("image.charger").attr("width", scaledChargerSize).attr("height", scaledChargerSize);
		if (params && v1Map?.CHARGER_LOCATION?.position) {
			const pos = v1Map.CHARGER_LOCATION.position;
			const c = this.robotToSvg({ x: pos[0], y: pos[1] }, params);
			this.chargerGroup
				.selectAll("image.charger")
				.attr("x", c.x - scaledChargerSize / 2)
				.attr("y", c.y - scaledChargerSize / 2);
		}

		this.pathGroup.selectAll("path.main-path").style("stroke-width", `${this.rescaler.pathMainWidth()}px`);
		this.backwashPathGroup.selectAll("path.backwash-path").style("stroke-width", `${this.rescaler.pathBackwashWidth()}px`);
		this.mopPathGroup.selectAll("path.mop-path").style("stroke-width", `${this.rescaler.pathMopWidth()}px`);
		this.pureCleanPathGroup.selectAll("path.pure-clean-path").style("stroke-width", `${this.rescaler.pathBackwashWidth()}px`);

		const scaledPinWidth = this.rescaler.pinWidth();
		const scaledPinHeight = this.rescaler.pinHeight();
		const scaledPinYOffset = this.rescaler.pinYOffset();
		this.pinGroup
			.selectAll("image.goto-pin")
			.attr("width", scaledPinWidth)
			.attr("height", scaledPinHeight)
			.attr("x", function () {
				const centerX = d3.select(this).attr("data-center-x");
				return (parseFloat(centerX) || 0) - scaledPinWidth / 2;
			})
			.attr("y", function () {
				const centerY = d3.select(this).attr("data-center-y");
				return (parseFloat(centerY) || 0) - (scaledPinHeight - scaledPinYOffset);
			});

		this.applyRoomLabelZoomBehavior();
		this.updatePopupPosition();
	}

	private getMapParams(): MapParams | null {
		if (this.mapImage?.dimensions) {
			// coordTransformation expects imageWidth/imageHeight in display pixels (grid × VISUAL_BLOCK_SIZE)
			// mapData stores grid dimensions (unscaled); carpet uses them as grid, paths/robot/obstacles need display size here
			const imageWidth = this.mapImage.dimensions.width * VISUAL_BLOCK_SIZE;
			const imageHeight = this.mapImage.dimensions.height * VISUAL_BLOCK_SIZE;
			return {
				scaleFactor: VISUAL_BLOCK_SIZE,
				left: this.mapImage.position.left,
				topMap: this.mapImage.position.top,
				mapMaxY: this.mapMaxY,
				imageHeight,
				imageWidth,
			};
		}

		if (this.map && isQ10MapData(this.map)) {
			const { header } = this.map;
			if (
				!Number.isFinite(header.minX) ||
				!Number.isFinite(header.minY) ||
				!Number.isFinite(header.sizeX) ||
				!Number.isFinite(header.sizeY) ||
				!Number.isFinite(header.resolution) ||
				header.resolution <= 0
			) {
				return null;
			}

			return {
				scaleFactor: VISUAL_BLOCK_SIZE,
				left: header.minX / header.resolution,
				topMap: header.minY / header.resolution,
				mapMaxY: this.mapMaxY,
				imageHeight: header.sizeY * VISUAL_BLOCK_SIZE,
				imageWidth: header.sizeX * VISUAL_BLOCK_SIZE,
			};
		}

		return null;
	}

	private hasDrawableMapBounds(): boolean {
		return Number.isFinite(this.mapMinX)
			&& Number.isFinite(this.mapMinY)
			&& Number.isFinite(this.mapSizeX)
			&& Number.isFinite(this.mapSizeY)
			&& this.mapSizeX > 0
			&& this.mapSizeY > 0;
	}

	private screenToWorldCoords(x: number, y: number): Point {
		if (this.mapMinX === undefined || this.mapMinY === undefined) return { x: 0, y: 0 };
		const transform = d3.zoomTransform(this.svgContainer.node() as Element);
		const inverted = transform.invert([x, y]);
		return { x: inverted[0], y: inverted[1] };
	}

	private worldToSvgCoords(x: number, y: number): Point {
		// Since we no longer translate the background image (it sits at 0,0),
		// we should not subtract mapMinX from the coordinates.
		// However, World Coordinates (from coords.ts) are 0-based relative to the Grid.
		// And the Image starts at Grid 0.
		// So WorldX = SvgX.
		return { x: x, y: y };
	}

	private robotToSvg(robotPoint: Point, params: any): Point {
		const worldPoint = robotCoordsToLocalCoords(robotPoint, params);
		return this.worldToSvgCoords(worldPoint.x, worldPoint.y);
	}

	private roundTwoDecimals(number: number): number {
		return Math.round(number * 100) / 100;
	}

	// -----------------------------------------------------------------------------
	// Public command surface
	//
	// What used to be a click listener on a fixed button is now a method the React shell
	// calls. The bodies are the ones the standalone page ran, so the behaviour - including
	// the zone limit and the go-to gesture - is unchanged.
	// -----------------------------------------------------------------------------

	/** Switches to another robot and rebuilds every subscription and panel for it. */
	public selectRobot(duid: string): void {
		if (!duid || duid === this.currentRobotDuid) return;
		this.currentRobotDuid = duid;
		this.host.onRobots?.(this.robots, duid);
		this.setupSocketListeners(duid);
	}

	/** Switches the active floor. The adapter verifies the map flag before it acts on it. */
	public selectFloor(value: string): void {
		const mapFlag = normalizeMapFlag(value);
		if (!this.currentRobotDuid || mapFlag === null) return;
		this.selectedFloor = value;
		this.host.onFloors?.(this.floors, this.selectedFloor);
		this.clearRoomSelection();
		void this.sendCommand("load_multi_map", { duid: this.currentRobotDuid, mapFlag });
	}

	/** Writes one of the fan/mop/water modes through the guarded generic writer. */
	public setMode(command: string, value: string): void {
		if (!this.currentRobotDuid) return;
		void this.sendCommand("set_state", { duid: this.currentRobotDuid, folder: "commands", command, value });
	}

	/** Starts a segment run for the rooms the user picked in the map. */
	public cleanSelectedRooms(): void {
		if (!this.currentRobotDuid || this.selectedRoomIds.size === 0) return;
		const segments = Array.from(this.selectedRoomIds);
		void this.sendCommand("app_segment_clean", { duid: this.currentRobotDuid, segments });
		this.clearRoomSelection();
	}

	/** Drops the room selection without sending anything. */
	public clearRooms(): void {
		this.clearRoomSelection();
	}

	/** Repeat count of the next zoned run. */
	public setCleanCount(count: number): void {
		this.cleanCount = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1;
		this.updateRobotZones();
	}

	/** Removes the zone added last. */
	public removeZone(): void {
		if (this.rects.length === 0) return;
		this.rects.pop();
		this.drawZones();
		this.renderZoneHint();
		this.updateRobotZones();
	}

	/** Drops a new zone into the middle of the current view, up to the MAX_ZONES limit. */
	public addZone(): void {
		if (this.rects.length >= MAX_ZONES) return;
		// Placing a zone and placing a go-to target are the same gesture; only one can be active.
		if (this.goToTarget) this.cancelGoTo();

		const svgWidth = parseFloat(this.svg.attr("width"));
		const svgHeight = parseFloat(this.svg.attr("height"));
		const centerWorld = this.screenToWorldCoords(svgWidth / 2, svgHeight / 2);
		const params = this.getMapParams();
		if (!params) return;

		this.rects.push({
			id: this.rectCounter++,
			x: centerWorld.x - 25 * params.scaleFactor,
			y: centerWorld.y - 25 * params.scaleFactor,
			width: 50 * params.scaleFactor,
			height: 50 * params.scaleFactor,
		});
		this.drawZones();
		this.renderZoneHint();
		this.updateRobotZones();
	}

	/** Starts a run: a zoned one while zones are drawn, otherwise the plain start. */
	public start(): void {
		if (!this.currentRobotDuid) return;
		this.updateRobotZones();
		const command = this.zones.length > 0 ? "app_zoned_clean" : "app_start";
		const parameters = this.zones.length > 0 ? { zones: this.zones, duid: this.currentRobotDuid } : { duid: this.currentRobotDuid };
		void this.sendCommand(command, parameters);
		this.rects = [];
		this.drawZones();
		this.renderZoneHint();
	}

	public pause(): void {
		if (!this.currentRobotDuid) return;
		void this.sendCommand("app_pause", { duid: this.currentRobotDuid });
	}

	public stop(): void {
		if (!this.currentRobotDuid) return;
		void this.sendCommand("app_stop", { duid: this.currentRobotDuid });
	}

	public dock(): void {
		if (!this.currentRobotDuid) return;
		void this.sendCommand("app_charge", { duid: this.currentRobotDuid });
	}

	/** Presses one consumable reset button. The shell asks for confirmation before calling this. */
	public resetConsumable(command: string): void {
		if (!this.currentRobotDuid || !command) return;
		void this.sendCommand("reset_consumable", { duid: this.currentRobotDuid, consumable: command });
	}

	/** Returns the view to the fit that was computed for the current map. */
	public resetZoom(): void {
		if (!this.initialTransform) return;
		this.svgContainer.transition().duration(750).call(this.zoom.transform as any, this.initialTransform);
		this.userAdjustedView = false;
	}

	/** Enters or leaves the go-to gesture: the next click on the map becomes the target. */
	public toggleGoTo(): void {
		if (this.goToTarget) {
			this.cancelGoTo();
			return;
		}

		this.goToTarget = true;
		this.svg.style("cursor", "none");
		this.host.onGoToMode?.(true);

		const transform = d3.zoomTransform(this.svgContainer.node() as Element);
		const svgWidth = parseFloat(this.svg.attr("width"));
		const svgHeight = parseFloat(this.svg.attr("height"));
		const [initialX, initialY] = transform.invert([svgWidth / 2, svgHeight / 2]);
		const scaledPinWidth = this.rescaler.pinWidth();
		const scaledPinHeight = this.rescaler.pinHeight();
		const scaledPinYOffset = this.rescaler.pinYOffset();
		const pin = this.pinGroup.select("image.goto-pin");
		pin
			.style("display", "block")
			.style("opacity", 0.7)
			.attr("data-center-x", initialX)
			.attr("data-center-y", initialY)
			.attr("x", initialX - scaledPinWidth / 2)
			.attr("y", initialY - (scaledPinHeight - scaledPinYOffset));

		this.svgContainer.on("mousemove.gototarget", (event: MouseEvent) => {
			const [mouseX, mouseY] = d3.pointer(event, this.mainGroup.node());
			const scaledW = this.rescaler.pinWidth();
			const scaledH = this.rescaler.pinHeight();
			const scaledOff = this.rescaler.pinYOffset();
			pin
				.attr("data-center-x", mouseX)
				.attr("data-center-y", mouseY)
				.attr("x", mouseX - scaledW / 2)
				.attr("y", mouseY - (scaledH - scaledOff));
		});

		this.svgContainer.on("click.gototarget", (event: MouseEvent) => {
			event.stopImmediatePropagation();
			const params = this.getMapParams();
			if (!this.currentRobotDuid || !params) return;
			const [mouseX, mouseY] = d3.pointer(event, this.mainGroup.node());
			const point = localCoordsToRobotCoords({ x: mouseX, y: mouseY }, params);
			void this.sendCommand("app_goto_target", { points: [point.x, point.y], duid: this.currentRobotDuid });
			// The pin stays where the robot was sent, so the target remains visible.
			pin.style("opacity", 1.0);
			this.goToTarget = false;
			this.svg.style("cursor", "grab");
			this.svgContainer.on("mousemove.gototarget", null);
			this.svgContainer.on("click.gototarget", null);
			this.host.onGoToMode?.(false);
		});
	}

	/** Leaves the go-to gesture and removes the pin again. */
	private cancelGoTo(): void {
		this.goToTarget = false;
		this.svg.style("cursor", "grab");
		this.svgContainer.on("mousemove.gototarget", null);
		this.svgContainer.on("click.gototarget", null);
		this.pinGroup.select("image.goto-pin").style("display", "none").style("opacity", 0);
		this.host.onGoToMode?.(false);
	}

	/** Closes the small hover preview above the map. */
	private hideObstaclePopup(): void {
		this.popup.style.display = "none";
		if (this.popupTimeout) clearTimeout(this.popupTimeout);
		this.popupTimeout = null;
	}

	/**
	 * Loads the full obstacle photo the user clicked in the preview and hands it to the shell,
	 * which shows it in a dialog.
	 */
	private openObstaclePhoto(): void {
		this.hideObstaclePopup();
		if (!this.currentRobotDuid || !this.selectedObstacleID) return;

		this.connection
			.sendTo(this.instanceId, "get_obstacle_image", { obstacleId: this.selectedObstacleID, duid: this.currentRobotDuid, type: 0 })
			.then((response: any) => {
				if (this.destroyed || !response?.image) return;
				let imageData = String(response.image);
				if (!imageData.startsWith("data:image/")) imageData = `data:image/png;base64,${imageData}`;

				const raw = response.bbox;
				// A bounding box is only usable when the robot reported the size it refers to.
				const bbox: ObstaclePhotoModel["bbox"] =
					raw && Number(raw.imageWidth) > 0 && Number(raw.imageHeight) > 0
						? { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h), imageWidth: Number(raw.imageWidth), imageHeight: Number(raw.imageHeight) }
						: null;

				this.host.onObstaclePhoto?.({ image: imageData.replace(/\s/g, ""), bbox });
			})
			.catch((err: unknown) => {
				console.error("Error getting large obstacle image:", err);
				this.showError(this.t("ui_command_failed", "Command failed: %s", this.errorText(err)));
			});
	}


	// Rescaler Helper
	private get rescaler() {
		return {
			scale: () => VISUAL_BLOCK_SIZE,
			robotSize: () => VISUAL_BLOCK_SIZE * UI_CONSTANTS.ROBOT_SIZE_BASE,
			chargerSize: () => VISUAL_BLOCK_SIZE * UI_CONSTANTS.CHARGER_SIZE_BASE,
			zoneStrokeWidth: () => UI_CONSTANTS.ZONE_STROKE_BASE / this.wheelZoom,
			zoneHandleRadius: () => UI_CONSTANTS.ZONE_HANDLE_RADIUS_BASE / this.wheelZoom,
			pinWidth: () => UI_CONSTANTS.PIN_WIDTH_BASE / this.wheelZoom,
			pinHeight: () => UI_CONSTANTS.PIN_HEIGHT_BASE / this.wheelZoom,
			pinYOffset: () => UI_CONSTANTS.PIN_Y_OFFSET_BASE / this.wheelZoom,
			pathMopWidth: () => UI_CONSTANTS.PATH_MOP_WIDTH_BASE * VISUAL_BLOCK_SIZE,
			pathMainWidth: () => Math.max(1, VISUAL_BLOCK_SIZE * UI_CONSTANTS.PATH_MAIN_WIDTH_RATIO_BASE),
			pathBackwashWidth: () => UI_CONSTANTS.PATH_BACKWASH_WIDTH_BASE * VISUAL_BLOCK_SIZE,
		};
	}
}
