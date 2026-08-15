/**
 * Frontend V1 map renderer: draws into D3 SVG groups. Single source: drawMapV1 drives all layers.
 */
import * as d3 from "d3";
import type {
	DrawCarpetInput,
	DrawChargerInput,
	DrawObstacleInput,
	DrawPathInput,
	DrawPredictedPathInput,
	DrawRect,
	DrawRoomLabelInput,
	DrawVirtualWallInput,
	DrawZoneRectInput,
	IMapRenderer,
	PathLayer,
} from "@adapter/common/mapDrawing/types";
import { VISUAL_BLOCK_SIZE } from "@adapter/common/mapDrawing/constants";
import { chargerLayout } from "./chargerGraphic";
import type { ChargerGraphic } from "./chargerGraphic";
import { getMapOverlayColors } from "./mapOverlayColors";
import type { MapOverlayColors } from "./mapOverlayColors";
import {
	LIVE_ROBOT_COLORS,
	LIVE_ROBOT_SIZE,
	LIVE_TRACK_COLORS,
	LIVE_TRACK_WIDTH,
	liveRobotHeadingPoints,
	liveTrackPathD,
	type LiveRobotPose,
	type LiveTrackSegment,
} from "./liveTrack";

/**
 * Size the room name is drawn at, in SVG user units.
 *
 * This is not the size it ends up at: `MapEngine.applyRoomLabelZoomBehavior()` scales the whole
 * label group so the name lands at the number `MapEngine.roomLabelScreenFontPx()` computes,
 * which is where the on-screen size is actually decided. This constant is only the unit that
 * scaling is expressed in, which is why the engine imports it instead of repeating a 12.
 */
export const ROOM_LABEL_BASE_FONT = 12;

/**
 * White halo behind the name, as a share of the font size.
 *
 * `paint-order: stroke` paints it under the glyphs, so half of it eats into the letters. At
 * roughly a sixth of the font size the halo still separates the name from any room fill in
 * light and dark alike, while the letters keep their shape - the previous 2.5 on a 12 unit
 * font was over a fifth and made the names look clogged as well as small.
 */
const ROOM_LABEL_STROKE_RATIO = 1 / 6;

/** Size of the small selection-order badge, again in SVG user units. */
const ROOM_LABEL_BADGE_FONT = 9;

const PATH_LAYER_CLASS: Record<PathLayer, string> = {
	mop: "mop-path",
	main: "main-path",
	backwash: "backwash-path",
	pure: "pure-clean-path",
};

function segmentsToPathD(segments: { x: number; y: number }[][]): string {
	const thresholdSq = 10 * VISUAL_BLOCK_SIZE * (10 * VISUAL_BLOCK_SIZE);
	let d = "";
	for (const seg of segments) {
		let lastX = -1,
			lastY = -1;
		for (const p of seg) {
			if (lastX < 0) d += `M${p.x},${p.y}`;
			else {
				const jump = (p.x - lastX) ** 2 + (p.y - lastY) ** 2 > thresholdSq;
				d += jump ? `M${p.x},${p.y}` : `L${p.x},${p.y}`;
			}
			lastX = p.x;
			lastY = p.y;
		}
	}
	return d;
}

function carpetPositionsToPathD(positions: { x: number; y: number }[]): string {
	const stride = 3;
	const pathCoords: string[] = [];
	for (const pos of positions) {
		for (let dx = 0; dx < VISUAL_BLOCK_SIZE; dx++) {
			for (let dy = 0; dy < VISUAL_BLOCK_SIZE; dy++) {
				if ((dx + dy) % stride === 2) pathCoords.push(`M${pos.x + dx} ${pos.y + dy}h1v1h-1z`);
			}
		}
	}
	return pathCoords.join("");
}

/**
 * One piece of furniture, ready to draw: the rectangle its four corner points span, the rotation
 * that turns it back onto them, and the graphic that may or may not be downloaded already.
 *
 * Only furniture the user placed or confirmed reaches this point - `MapEngine` drops the entries
 * whose `edit` byte is zero, which is what the app does as well (analysis §2.4).
 */
export interface DrawFurnitureInput {
	/** Furniture id of the block entry; used as the D3 key so an update reuses its element. */
	id: number;
	/** Left edge in SVG user units, before the rotation. */
	x: number;
	/** Top edge in SVG user units, before the rotation. */
	y: number;
	width: number;
	height: number;
	/** Centre the rotation turns around. */
	centerX: number;
	centerY: number;
	/** Rotation in degrees, clockwise. */
	angle: number;
	/** URL of the proven graphic, or null when this type/subtype pair has none. */
	imageHref: string | null;
	/** Name of the piece, shown as the native SVG tooltip; null when the name is unproven. */
	title: string | null;
}

export interface SVGMapRendererGroups {
	carpetGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	pathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	mopPathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	backwashPathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	pureCleanPathGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	chargerGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	robotGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	pinGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	obstacleGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	roomNameGroup: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	zonesOverlayGroup?: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	/** Optional so a caller that does not draw furniture keeps working unchanged. */
	furnitureGroup?: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	/** Live driven/mopped track; absent means the caller does not show live data. */
	liveTrackGroup?: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
	/** Live position marker, kept apart from the track so either can be cleared alone. */
	liveRobotGroup?: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>;
}

export interface SVGMapRendererOptions {
	groups: SVGMapRendererGroups;
	/** Base sizes (before zoom) for path stroke. Zoom handler will update by class. */
	pathMainWidth: number;
	pathMopWidth: number;
	pathBackwashWidth: number;
	robotSize: number;
	chargerSize: number;
	pinWidth: number;
	pinHeight: number;
	pinYOffset: number;
	obstacleRadius: number;
	obstacleImageSize: number;
	/** Asset base URL for obstacle icons, e.g. "assets/roborock.vacuum.a147/drawable-mdpi/" */
	obstacleAssetBaseUrl: string;
	obstacleMapping: Record<number, string>;
	obstacleFileName: (suffix: string) => string;
	obstacleFileNameAlt: (suffix: string) => string;
	/** Callback when obstacle is clicked (e.g. show popup). Receives obstacle data bound to element. */
	onObstacleClick?: (event: MouseEvent, obstacleData: unknown) => void;
	/** Callback when a room label is clicked. Makes room labels selectable. */
	onRoomLabelClick?: (segmentId: number, event: MouseEvent) => void;
	/** Segment ids that are currently selected; drawn with a highlight box. */
	selectedSegmentIds?: ReadonlySet<number>;
	/**
	 * Colours of everything drawn over the map bitmap, for the scheme the bitmap itself uses.
	 *
	 * Only the room name needs them here - the pill behind it is styled from `styles.css` through
	 * the same custom properties, but the name's own colour cannot be: the caller writes a fill
	 * per label (`textFill`) as an inline style, and an inline style beats every rule. So the
	 * renderer picks between the two, from the same source the stylesheet reads.
	 *
	 * Optional so a caller that draws no room labels keeps working; the light set is the fallback,
	 * exactly as in {@link getMapOverlayColors}.
	 */
	overlayColors?: MapOverlayColors;
	/** Image hrefs for robot, charger, go-to pin. */
	robotImageHref: string;
	chargerImageHref: string;
	goToPinImageHref: string;
	/**
	 * The Roborock app's own dock artwork, or null to keep the built-in symbol.
	 *
	 * Null is not an error case: the Q10 pipeline measures its map in units this was never proven
	 * against, and a device that has not reported a dock type could be given the wrong station.
	 * Both keep the symbol that has always been drawn there.
	 */
	chargerArt?: ChargerArt | null;
}

/** The dock artwork of one device, resolved to URLs by the engine that knows its model folder. */
export interface ChargerArt {
	graphic: ChargerGraphic;
	/** URL of the body image. */
	bodyHref: string;
	/** URL of the image drawn on top of the body, or null when the family has none. */
	topHref: string | null;
	/** Size of one map cell in SVG user units, so the graphic comes out to scale. */
	cellSize: number;
}

export class SVGMapRenderer implements IMapRenderer {
	private opts: SVGMapRendererOptions;
	private pathGroupByLayer: Record<PathLayer, d3.Selection<SVGGElement, unknown, HTMLElement, unknown>>;

	constructor(options: SVGMapRendererOptions) {
		this.opts = options;
		const g = options.groups;
		this.pathGroupByLayer = {
			mop: g.mopPathGroup,
			main: g.pathGroup,
			backwash: g.backwashPathGroup,
			pure: g.pureCleanPathGroup,
		};
	}

	getCleanSnapshot(): string | null {
		return null;
	}

	drawFloor(_rects: DrawRect[]): void {
		// Base image already contains floor; no-op for frontend
	}

	drawSegmentRects(_rects: DrawRect[]): void {
		// Base image already contains segments; no-op for frontend
	}

	drawCarpet(input: DrawCarpetInput): void {
		const g = this.opts.groups.carpetGroup;
		g.selectAll("*").remove();
		if (!input.positions.length) return;
		const pathD = carpetPositionsToPathD(input.positions);
		g.append("path")
			.attr("class", "carpet-path")
			.style("fill", "rgba(0, 0, 0, 0.4)")
			.attr("shape-rendering", "crispEdges")
			.attr("d", pathD);
	}

	drawPath(input: DrawPathInput): void {
		const layer = input.pathLayer ?? "main";
		const group = this.pathGroupByLayer[layer];
		group.selectAll("*").remove();
		const pathD = segmentsToPathD(input.segments);
		if (!pathD) return;
		const strokeWidth =
			layer === "mop"
				? this.opts.pathMopWidth
				: layer === "main"
					? this.opts.pathMainWidth
					: this.opts.pathBackwashWidth;
		group
			.append("path")
			.attr("class", PATH_LAYER_CLASS[layer])
			.attr("d", pathD)
			.style("fill", "none")
			.style("stroke", input.stroke)
			.style("stroke-width", `${strokeWidth}px`)
			.style("stroke-linecap", "round")
			.style("stroke-linejoin", "round")
			.style("stroke-dasharray", input.dashed ? "4, 8" : "");
	}

	drawRobot(input: { x: number; y: number; angle: number }): void {
		const g = this.opts.groups.robotGroup;
		g.selectAll("*").remove();
		const size = this.opts.robotSize;
		const angle = -(input.angle ?? 0) + 90;
		g.append("image")
			.attr("class", "robot")
			.attr("href", this.opts.robotImageHref)
			.attr("width", size)
			.attr("height", size)
			.attr(
				"transform",
				`translate(${input.x}, ${input.y}) rotate(${angle}) translate(${-size / 2}, ${-size / 2})`
			);
	}

	/**
	 * Draws the dock, preferring the Roborock app's own artwork over the built-in symbol.
	 *
	 * **The built-in symbol goes down first, every time.** The app's dock graphics come out of the
	 * control plugin, which is downloaded per user account; an installation that runs purely
	 * locally has never seen them. Binding the plugin URL directly would turn that into an empty
	 * spot where the dock used to be, so the symbol is drawn and only replaced once an off-screen
	 * probe has confirmed the file is really there - the same order `drawFurniture` uses, and for
	 * the same reason.
	 *
	 * The plugin family draws in two layers: a body and, for every dock above a plain charger, a
	 * plate on top of it. Both sit in one rotated group, so the overlay cannot drift off the body.
	 *
	 * @param input Charging position in SVG user units and the angle the map reported for it.
	 */
	drawCharger(input: DrawChargerInput): void {
		const g = this.opts.groups.chargerGroup;
		g.selectAll("*").remove();
		const size = this.opts.chargerSize;
		const builtIn = g
			.append("image")
			.attr("class", "charger")
			.attr("href", this.opts.chargerImageHref)
			.attr("width", size)
			.attr("height", size)
			.attr("x", input.x - size / 2)
			.attr("y", input.y - size / 2);

		const art = this.opts.chargerArt;
		if (!art) return;

		const layout = chargerLayout({
			x: input.x,
			y: input.y,
			angle: input.angle,
			graphic: art.graphic,
			cellSize: art.cellSize,
		});
		const topHref = art.topHref;

		const probe = new Image();
		probe.onload = () => {
			// The map may have been redrawn while the image was loading.
			const node = builtIn.node();
			if (!node || !g.node()?.contains(node)) return;
			builtIn.remove();

			const piece = g
				.append("g")
				.attr("class", "charger-art")
				.attr("data-dock-kind", art.graphic.kind)
				.attr(
					"transform",
					`translate(${layout.centerX}, ${layout.centerY}) rotate(${layout.rotation}) translate(${-layout.width / 2}, ${-layout.height / 2})`
				);

			piece
				.append("image")
				.attr("class", "charger-body")
				.attr("x", 0)
				.attr("y", 0)
				.attr("width", layout.width)
				.attr("height", layout.height)
				// The box was derived from this image's own aspect, so fitting it in changes
				// nothing; saying so keeps the two layers on the same rule.
				.attr("preserveAspectRatio", "xMidYMid meet")
				.attr("href", art.bodyHref);

			if (!topHref) return;
			const topProbe = new Image();
			topProbe.onload = () => {
				const pieceNode = piece.node();
				if (!pieceNode || !g.node()?.contains(pieceNode)) return;
				piece
					.append("image")
					.attr("class", "charger-top")
					.attr("x", 0)
					.attr("y", 0)
					.attr("width", layout.width)
					.attr("height", layout.height)
					// `resizeMode: 'contain'` in the app: this one has a slightly taller aspect
					// than the body and is letterboxed into its box rather than stretched.
					.attr("preserveAspectRatio", "xMidYMid meet")
					.attr("href", topHref);
			};
			topProbe.onerror = () => {
				// The body on its own is still a recognisable dock; nothing to undo.
			};
			topProbe.src = topHref;
		};
		probe.onerror = () => {
			// Nothing to do - the built-in symbol is already on the map.
		};
		probe.src = art.bodyHref;
	}

	drawGoToPin(input: { x: number; y: number }): void {
		const g = this.opts.groups.pinGroup;
		const pinW = this.opts.pinWidth;
		const pinH = this.opts.pinHeight;
		const pinYOffset = this.opts.pinYOffset;
		g.select("image.goto-pin")
			.attr("x", input.x - pinW / 2)
			.attr("y", input.y - (pinH - pinYOffset))
			.attr("width", pinW)
			.attr("height", pinH)
			.attr("data-center-x", String(input.x))
			.attr("data-center-y", String(input.y))
			.style("display", null)
			.style("opacity", "1");
	}

	/**
	 * Draws the obstacle icons.
	 *
	 * The data join below was always here - and was defeated by a `g.selectAll(".obstacle-group")
	 * .remove()` on the line above it, which meant every element was an entering one on every call
	 * and `exit()` and `merge()` never had anything to do. The icons load through the same
	 * asynchronous probe the furniture uses, so the effect was the same: a frame showing the
	 * fallback icon after every redraw. The `remove()` is gone and the join is keyed by position and
	 * type, which is what an obstacle is - it does not move, it is either detected or it is not.
	 *
	 * @param items Obstacles to draw; an empty list clears the layer.
	 */
	drawObstacles(items: DrawObstacleInput[]): void {
		const g = this.opts.groups.obstacleGroup;
		const bgRadius = this.opts.obstacleRadius * 1.1;
		const baseUrl = this.opts.obstacleAssetBaseUrl;
		const obstacleFileName = this.opts.obstacleFileName;
		const obstacleFileNameAlt = this.opts.obstacleFileNameAlt;
		const fallbackUrl = baseUrl + obstacleFileName("18");
		const mapping = this.opts.obstacleMapping;
		const onObstacleClick = this.opts.onObstacleClick;

		const groups = g
			.selectAll<SVGGElement, DrawObstacleInput>(".obstacle-group")
			.data(items, (d) => `${d.x}|${d.y}|${String(d.typeOrSuffix)}`);

		groups.exit().remove();

		const enter = groups
			.enter()
			.append("g")
			.attr("class", "obstacle-group")
			.style("cursor", onObstacleClick ? "pointer" : "default")
			.attr("transform", (d) => `translate(${d.x}, ${d.y})`);

		if (onObstacleClick) {
			enter.on("click", function (event: MouseEvent, d: DrawObstacleInput) {
				event.stopPropagation();
				onObstacleClick(event, d.obstacleData ?? d);
			});
		}

		enter
			.append("circle")
			.attr("class", "obstacle-bg")
			.style("display", (d) => d.hideBackground ? "none" : null)
			.attr("r", bgRadius)
			.attr("fill", "rgba(100, 100, 100, 0.2)")
			.attr("stroke", "white")
			.attr("stroke-width", 0.5);

		enter
			.append("image")
			.attr("class", "obstacle-icon")
			.attr("width", (d) => d.imageSize ?? this.opts.obstacleImageSize)
			.attr("height", (d) => d.imageSize ?? this.opts.obstacleImageSize)
			.attr("x", (d) => -(d.imageSize ?? this.opts.obstacleImageSize) / 2)
			.attr("y", (d) => -(d.imageSize ?? this.opts.obstacleImageSize) / 2)
			.attr("href", (d) => d.imageHref || fallbackUrl)
			.each(function (this: SVGImageElement, d: DrawObstacleInput) {
				if (d.imageHref) return;
				const suffix = typeof d.typeOrSuffix === "number" ? (mapping[d.typeOrSuffix] ?? "18") : d.typeOrSuffix;
				if (suffix === "18") return;
				const primaryUrl = baseUrl + obstacleFileName(suffix);
				const altUrl = baseUrl + obstacleFileNameAlt(suffix);
				const el = this;
				const img = new Image();
				const tryAlt = () => {
					img.onload = () => {
						d3.select(el).attr("href", altUrl);
					};
					img.onerror = () => {};
					img.src = altUrl;
				};
				img.onload = () => {
					d3.select(el).attr("href", primaryUrl);
				};
				img.onerror = tryAlt;
				img.src = primaryUrl;
			});

		const merged = enter.merge(groups);
		merged.attr("transform", (d) => `translate(${d.x}, ${d.y})`);
		// Only a href the caller actually named is refreshed here. Where it named none, the icon on
		// the element is whatever the probe above settled on, and overwriting that with the fallback
		// would undo the probe on every redraw. Writing the identical value is skipped so the
		// browser is never given a reason to fetch again.
		merged.select<SVGImageElement>("image.obstacle-icon").each(function (this: SVGImageElement, d: DrawObstacleInput) {
			if (!d.imageHref) return;
			const icon = d3.select(this);
			if (icon.attr("href") !== d.imageHref) icon.attr("href", d.imageHref);
		});
	}

	/**
	 * Draws the furniture models of block type 25.
	 *
	 * Two things are worth knowing here.
	 *
	 * **A missing graphic must never show as a broken image.** The artwork is downloaded per user
	 * from that user's own Roborock account, so a purely local installation has none of it. Every
	 * piece is therefore drawn as a neutral outline first and the `href` is only set once an
	 * off-screen probe has confirmed the file is really there - the same approach the obstacle
	 * icons use, and the reason this does not simply bind `href` and hope.
	 *
	 * **The rotation is applied around the centre**, not around the element origin, because the
	 * rectangle itself is the axis-aligned hull the four corner points were reduced to.
	 *
	 * @param items Furniture to draw; an empty list clears the layer.
	 */
	drawFurniture(items: DrawFurnitureInput[]): void {
		const g = this.opts.groups.furnitureGroup;
		if (!g) return;

		const pieces = g.selectAll<SVGGElement, DrawFurnitureInput>("g.furniture").data(items, (d) => String(d.id));

		pieces.exit().remove();

		const enter = pieces
			.enter()
			.append("g")
			.attr("class", "furniture")
			.attr("data-furniture-id", (d) => String(d.id));

		enter
			.append("rect")
			.attr("class", "furniture-shape")
			.attr("x", 0)
			.attr("y", 0)
			.style("fill", "rgba(120, 120, 120, 0.18)")
			.style("stroke", "rgba(60, 60, 60, 0.55)")
			.style("stroke-width", "0.75px");

		const merged = enter.merge(pieces);

		merged.attr(
			"transform",
			(d) => `translate(${d.centerX}, ${d.centerY}) rotate(${d.angle}) translate(${-d.width / 2}, ${-d.height / 2})`
		);

		merged
			.select("rect.furniture-shape")
			.attr("width", (d) => d.width)
			.attr("height", (d) => d.height)
			.attr("rx", (d) => Math.min(d.width, d.height) * 0.1);

		// Native SVG tooltip. The app shows no permanent text on the map either (analysis §2.7), so
		// the name stays out of the way until the pointer asks for it.
		merged.each(function (this: SVGGElement, d: DrawFurnitureInput) {
			const piece = d3.select(this);
			const title = piece.select("title");
			if (!d.title) {
				title.remove();
				return;
			}
			if (title.empty()) piece.insert("title", ":first-child").text(d.title);
			else if (title.text() !== d.title) title.text(d.title);
		});

		merged.each((d, index, nodes) => this.syncFurnitureImage(nodes[index] as SVGGElement, d));
	}

	/**
	 * Brings one piece's artwork in line with its data, without ever reloading a picture that is
	 * already correct.
	 *
	 * This is where the flickering came from. The layer used to be thrown away and rebuilt on every
	 * redraw, and because the `<image>` is only appended in an `Image()` probe's `onload` - which
	 * fires a tick later **even for a file the browser already has** - every redraw left a frame
	 * showing nothing but the grey placeholder. With the map republished every few seconds that
	 * frame is exactly what the user reported as flickering.
	 *
	 * The probe itself has to stay: the artwork is downloaded per user from that user's own Roborock
	 * account, so a purely local installation has none of it, and binding `href` straight to a file
	 * that may not exist would show a broken-image icon on the map. What changed is that the probe
	 * now runs **once per piece and href** instead of once per redraw. `data-probe-href` records
	 * which file a node has already asked for; a failure clears it again, so a piece whose artwork
	 * arrives later - the plugin download runs after start-up - still picks it up on a later redraw.
	 *
	 * @param node The piece's group element.
	 * @param item Its data.
	 */
	private syncFurnitureImage(node: SVGGElement, item: DrawFurnitureInput): void {
		const piece = d3.select(node);
		const image = piece.select<SVGImageElement>("image.furniture-icon");
		const shape = piece.select("rect.furniture-shape");
		const wanted = item.imageHref;

		// Nothing to show, or a different file is meant now: back to the outline, and let the block
		// below fetch the new one. Leaving the old picture up would show the wrong furniture.
		if (!image.empty() && (!wanted || image.attr("href") !== wanted)) {
			image.remove();
			shape.style("display", null);
			piece.attr("data-probe-href", null);
		}

		if (!wanted) {
			piece.attr("data-probe-href", null);
			return;
		}

		const current = piece.select<SVGImageElement>("image.furniture-icon");
		if (!current.empty()) {
			// The picture is right; only its footprint can have changed.
			current.attr("width", item.width).attr("height", item.height);
			return;
		}

		// A probe for this very file is already pending or has already failed for this node.
		if (piece.attr("data-probe-href") === wanted) return;
		piece.attr("data-probe-href", wanted);

		const probe = new Image();
		probe.onload = (): void => {
			// The piece may have been removed, or moved on to another graphic, while this loaded.
			if (!node.isConnected || piece.attr("data-probe-href") !== wanted) return;
			piece.select("rect.furniture-shape").style("display", "none");
			piece
				.append("image")
				.attr("class", "furniture-icon")
				.attr("x", 0)
				.attr("y", 0)
				.attr("width", item.width)
				.attr("height", item.height)
				// The rectangle is the real footprint, so the artwork fills it instead of being
				// letterboxed into it.
				.attr("preserveAspectRatio", "none")
				.attr("href", wanted);
		};
		probe.onerror = (): void => {
			// The neutral outline is already on the map. Forget the attempt so a graphic that only
			// arrives later - the per-account download runs after start-up - is picked up again.
			if (piece.attr("data-probe-href") === wanted) piece.attr("data-probe-href", null);
		};
		probe.src = wanted;
	}

	/**
	 * Draws the room names.
	 *
	 * Same story as {@link drawObstacles}: the data join was written and then defeated by a
	 * `remove()` above it. The icon here is bound straight from `iconHref` rather than through a
	 * probe, so the gap is shorter than the furniture's - but a freshly created `<image>` still has
	 * nothing to show until the browser has decoded the file, and at one redraw every few seconds
	 * that is visible on the bubbles. Keyed by segment id, which is what a room is.
	 *
	 * Keeping the elements has a second effect that is wanted rather than merely tolerated: the
	 * selection styling written by `MapEngine.applyRoomSelectionStyling()` and the font scaling from
	 * `applyRoomLabelZoomBehavior()` both live on these nodes, and both used to be thrown away and
	 * re-derived on every redraw.
	 *
	 * @param labels Labels to draw; an empty list clears the layer.
	 */
	drawRoomLabels(labels: DrawRoomLabelInput[]): void {
		const g = this.opts.groups.roomNameGroup;
		const onRoomLabelClick = this.opts.onRoomLabelClick;
		const selectedSegmentIds = this.opts.selectedSegmentIds;
		const overlayColors = this.opts.overlayColors ?? getMapOverlayColors(null);
		const sel = g.selectAll<SVGGElement, DrawRoomLabelInput>("g.room-label").data(labels, (d) => String(d.segmentId));
		sel.exit().remove();
		const enter = sel.enter().append("g");

		if (onRoomLabelClick) {
			enter.on("click", function (event: MouseEvent, d: DrawRoomLabelInput) {
				event.stopPropagation();
				onRoomLabelClick(d.segmentId, event);
			});
		}

		// Selection highlight, drawn first so it stays behind bubble and text.
		enter.append("rect").attr("class", "room-label-selection");
		enter.append("circle").attr("class", "room-label-bubble");
		enter.append("image").attr("class", "room-label-icon");
		enter.append("text")
			.attr("class", "room-name")
			.style("font-weight", "900")
			.style("font-size", `${ROOM_LABEL_BASE_FONT}px`)
			.style("stroke-width", `${ROOM_LABEL_BASE_FONT * ROOM_LABEL_STROKE_RATIO}px`)
			.style("paint-order", "stroke")
			.attr("shape-rendering", "geometricPrecision");
		enter.append("circle").attr("class", "room-label-badge");
		enter.append("text")
			.attr("class", "room-label-badge-text")
			.style("font-weight", "900")
			.style("font-size", `${ROOM_LABEL_BADGE_FONT}px`);

		// Set on every pass, not only on entering elements: whether a label is clickable comes from
		// the renderer's options, and those can differ between two draws. A label that entered while
		// the map was read-only would otherwise stay dead for as long as it survives.
		const merged = enter.merge(sel)
			.attr("class", onRoomLabelClick ? "room-label selectable" : "room-label")
			.style("pointer-events", onRoomLabelClick ? "auto" : "none")
			.attr("data-x", (d) => String(d.x))
			.attr("data-y", (d) => String(d.y))
			.attr("data-segment-id", (d) => String(d.segmentId))
			// The colour the name carries while the room is *not* picked. Kept on the element
			// because picking a room does not redraw the labels - `MapEngine.applyRoomSelectionStyling()`
			// only restyles them, and it has no way back to the input that produced this one.
			.attr("data-text-fill", (d) => d.textFill || "#000")
			.attr("transform", (d) => `translate(${d.x}, ${d.y})`);

		merged.each(function (d: DrawRoomLabelInput) {
			const label = d3.select(this);
			const isSelected = !!selectedSegmentIds?.has(d.segmentId);
			const hasBubble = !!d.iconHref || !!d.bubbleFill || !!d.badgeText;
			const bubbleRadius = d.bubbleRadius ?? 6;
			const iconSize = d.iconSize ?? 7;
			const gap = d.gap ?? 5;
			const bubbleCenterX = d.bubbleCenterOffsetX ?? 0;
			const textX = d.textOffsetX ?? (hasBubble ? bubbleRadius + gap : 0);
			const badgeText = d.badgeText?.trim() || "";
			const badgeCenterX = d.badgeCenterOffsetX ?? (hasBubble ? bubbleCenterX - 3 : 0);
			const badgeCenterY = d.badgeCenterOffsetY ?? 12;

			label.select<SVGCircleElement>("circle.room-label-bubble")
				.style("display", hasBubble ? "" : "none")
				.attr("cx", bubbleCenterX)
				.attr("cy", 0)
				.attr("r", bubbleRadius)
				.style("fill", d.bubbleFill || "#000")
				.style("stroke", d.bubbleStroke || "#fff")
				.style("stroke-width", "1px");

			label.select<SVGImageElement>("image.room-label-icon")
				.style("display", d.iconHref ? "" : "none")
				.attr("href", d.iconHref || null)
				.attr("x", bubbleCenterX - iconSize / 2)
				.attr("y", -iconSize / 2)
				.attr("width", iconSize)
				.attr("height", iconSize);

			label.select<SVGTextElement>("text.room-name")
				.text(d.text)
				.attr("x", textX)
				.attr("y", 0)
				.attr("text-anchor", hasBubble ? "start" : "middle")
				.attr("dominant-baseline", "middle")
				// On the pill the name needs the pill's contrast, off it the colour the caller
				// chose; the halo behind the glyphs takes whatever they sit on, so it thickens the
				// letters instead of ringing them.
				.style("fill", isSelected ? overlayColors.roomSelectionInk : d.textFill || "#000")
				.style("stroke", isSelected ? overlayColors.roomSelectionFill : "white");

			label.select<SVGCircleElement>("circle.room-label-badge")
				.style("display", badgeText ? "" : "none")
				.attr("cx", badgeCenterX)
				.attr("cy", badgeCenterY)
				.attr("r", 5)
				.style("fill", "rgba(111,111,116,0.95)");

			label.select<SVGTextElement>("text.room-label-badge-text")
				.style("display", badgeText ? "" : "none")
				.text(badgeText)
				.attr("x", badgeCenterX)
				.attr("y", badgeCenterY)
				.attr("text-anchor", "middle")
				.attr("dominant-baseline", "middle")
				.style("fill", "white");

			// Highlight box around bubble + text; sized from the rendered text width.
			const textNode = label.select<SVGTextElement>("text.room-name").node();
			let textWidth = 0;
			try {
				textWidth = textNode?.getComputedTextLength() ?? 0;
			} catch {
				textWidth = d.text.length * 7;
			}
			const left = hasBubble ? bubbleCenterX - bubbleRadius : -textWidth / 2;
			const right = hasBubble ? textX + textWidth : textWidth / 2;
			// A picked room is marked at its name, not across its floor: the floor is a bitmap the
			// adapter renders, and this layer has no polygon to fill. So the pill carries the whole
			// signal.
			//
			// Its colours are in `styles.css`, from the custom properties `mapOverlayColors.ts`
			// publishes - they have to follow the map between light and dark, and a stylesheet
			// cannot correct an inline style. Geometry and visibility stay here.
			label.select<SVGRectElement>("rect.room-label-selection")
				.style("display", isSelected ? "" : "none")
				.attr("x", left - 7)
				.attr("y", -12)
				.attr("width", Math.max(right - left, 0) + 14)
				.attr("height", 24)
				.attr("rx", 8);
		});
	}

	drawActiveZones(zones: DrawZoneRectInput[]): void {
		const overlay = this.opts.groups.zonesOverlayGroup;
		if (!overlay) return;
		overlay.selectAll(".active-zone").remove();
		for (const z of zones) {
			const x = Math.min(z.x, z.x + z.w);
			const y = Math.min(z.y, z.y + z.h);
			const w = Math.abs(z.w);
			const h = Math.abs(z.h);
			overlay
				.append("rect")
				.attr("class", "active-zone")
				.attr("x", x)
				.attr("y", y)
				.attr("width", w)
				.attr("height", h)
				.style("fill", z.fill)
				.style("stroke", z.stroke)
				.style("stroke-width", "4px");
		}
	}

	drawRestrictedZones(zones: DrawZoneRectInput[], virtualWalls: DrawVirtualWallInput[]): void {
		const overlay = this.opts.groups.zonesOverlayGroup;
		if (!overlay) return;
		overlay.selectAll(".restricted-zone").remove();
		overlay.selectAll(".virtual-wall").remove();
		for (const z of zones) {
			const x = Math.min(z.x, z.x + z.w);
			const y = Math.min(z.y, z.y + z.h);
			const w = Math.abs(z.w);
			const h = Math.abs(z.h);

			// The corners when the zone has them: a map stores these zones as four points, and a
			// turned one is a different shape from the box around it. See `DrawZoneRectInput.points`.
			if (z.points && z.points.length >= 3) {
				overlay
					.append("polygon")
					.attr("class", "restricted-zone")
					.attr("points", z.points.map((point) => `${point.x},${point.y}`).join(" "))
					.style("fill", z.fill)
					.style("stroke", z.stroke)
					.style("stroke-width", `${(1 * VISUAL_BLOCK_SIZE) / 2}px`);
				continue;
			}

			overlay
				.append("rect")
				.attr("class", "restricted-zone")
				.attr("x", x)
				.attr("y", y)
				.attr("width", w)
				.attr("height", h)
				.style("fill", z.fill)
				.style("stroke", z.stroke)
				.style("stroke-width", `${w ? (1 * VISUAL_BLOCK_SIZE) / 2 : 0}px`);
		}
		for (const w of virtualWalls) {
			overlay
				.append("line")
				.attr("class", "virtual-wall")
				.attr("x1", w.x1)
				.attr("y1", w.y1)
				.attr("x2", w.x2)
				.attr("y2", w.y2)
				.style("stroke", w.stroke)
				.style("stroke-width", `${w.lineWidth}px`);
		}
	}

	/**
	 * Draws the live driven/mopped track.
	 *
	 * Every run is painted twice: a dark casing first, the colour on top. That is what makes the
	 * overlay independent of what lies underneath it - the map bitmap does not follow the admin
	 * theme, and the historic white path may run right along the same stretch.
	 *
	 * The runs are drawn in the order they arrive, so a mopped run that follows a driven one covers
	 * the shared point between them rather than the other way round. All casings go down before any
	 * colour, otherwise the casing of a later run would cut into the colour of an earlier one.
	 *
	 * The layer is cleared on every call. This is a live channel: a snapshot supersedes its
	 * predecessor completely, and merging the two would accumulate a track that no longer matches
	 * what the robot reports.
	 *
	 * @param segments The runs, already in SVG user units.
	 */
	drawLiveTrack(segments: LiveTrackSegment[]): void {
		const g = this.opts.groups.liveTrackGroup;
		if (!g) return;
		g.selectAll("*").remove();
		if (!segments.length) return;

		const runs = segments
			.map(segment => ({ mopped: segment.mopped, d: liveTrackPathD(segment.points) }))
			.filter(run => run.d !== "");
		if (!runs.length) return;

		for (const run of runs) {
			g.append("path")
				.attr("class", "live-track-casing")
				.attr("d", run.d)
				.style("fill", "none")
				.style("stroke", LIVE_TRACK_COLORS.casing)
				.style("stroke-width", `${LIVE_TRACK_WIDTH.track + LIVE_TRACK_WIDTH.casingExtra}px`)
				.style("stroke-linecap", "round")
				.style("stroke-linejoin", "round");
		}

		for (const run of runs) {
			g.append("path")
				.attr("class", run.mopped ? "live-track live-track-mopped" : "live-track live-track-driven")
				.attr("d", run.d)
				.style("fill", "none")
				.style("stroke", run.mopped ? LIVE_TRACK_COLORS.mopped : LIVE_TRACK_COLORS.driven)
				.style("stroke-width", `${LIVE_TRACK_WIDTH.track}px`)
				.style("stroke-linecap", "round")
				.style("stroke-linejoin", "round");
		}
	}

	/**
	 * Draws the live position marker: a disc with a heading wedge.
	 *
	 * This is a marker of its own rather than a second use of {@link drawRobot}, because the live
	 * position and the map's `ROBOT_POSITION` are two independent channels that arrive at different
	 * times. Sharing one element would let whichever redrew last win, and the map's zoom handler
	 * re-applies the map's position on every wheel tick - the stale value would snap back the
	 * moment the user zoomed.
	 *
	 * @param pose The marker, or null to clear the layer - which is what a snapshot without a
	 *             position means, and it must not leave a stale robot behind.
	 */
	drawLiveRobot(pose: LiveRobotPose | null): void {
		const g = this.opts.groups.liveRobotGroup;
		if (!g) return;
		g.selectAll("*").remove();
		if (!pose) return;

		const marker = g
			.append("g")
			.attr("class", "live-robot")
			.attr("transform", `translate(${pose.x}, ${pose.y}) rotate(${pose.rotation})`);

		marker
			.append("polygon")
			.attr("class", "live-robot-heading")
			.attr("points", liveRobotHeadingPoints())
			.style("fill", LIVE_ROBOT_COLORS.heading)
			.style("stroke", LIVE_ROBOT_COLORS.outline)
			.style("stroke-width", "0.8px")
			.style("stroke-linejoin", "round");

		marker
			.append("circle")
			.attr("class", "live-robot-body")
			.attr("cx", 0)
			.attr("cy", 0)
			.attr("r", LIVE_ROBOT_SIZE.radius)
			.style("fill", LIVE_ROBOT_COLORS.body)
			.style("stroke", LIVE_ROBOT_COLORS.outline)
			.style("stroke-width", "1.2px");
	}

	drawPredictedPath(input: DrawPredictedPathInput): void {
		const overlay = this.opts.groups.zonesOverlayGroup;
		if (!overlay || !input.points.length) return;
		overlay.selectAll(".predicted-path").remove();
		const pathD = input.points.reduce((acc, p, i) => (i === 0 ? `M${p.x},${p.y}` : `${acc} L${p.x},${p.y}`), "");
		overlay
			.append("path")
			.attr("class", "predicted-path")
			.attr("d", pathD)
			.style("fill", "none")
			.style("stroke", input.stroke)
			.style("stroke-width", `${input.lineWidth}px`)
			.style("stroke-dasharray", input.dashArray.join(","));
	}
}
