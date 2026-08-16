/**
 * Backend V1 map renderer: draws via @napi-rs/canvas. Used only by drawMapV1 (single source).
 */
import type { Canvas, Image } from "@napi-rs/canvas";
import { createCanvas } from "@napi-rs/canvas";
import type {
	DrawCarpetInput,
	DrawObstacleInput,
	DrawPredictedPathInput,
	DrawRect,
	DrawRoomLabelInput,
	DrawVirtualWallInput,
	DrawZoneRectInput,
	IMapRenderer,
} from "../../../common/mapDrawing/types";
import { VISUAL_BLOCK_SIZE } from "../../../common/mapDrawing/constants";

/** Node canvas 2D context (no DOM types). */
export interface NodeCanvasContext2D {
	canvas: Canvas;
	drawImage(image: Canvas | Image, dx: number, dy: number, dw?: number, dh?: number): void;
	getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
	putImageData(imagedata: ImageData, dx: number, dy: number): void;
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	lineCap: string;
	lineJoin: string;
	globalAlpha: number;
	imageSmoothingEnabled: boolean;
	antialias?: string;
	save(): void;
	restore(): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	closePath(): void;
	stroke(): void;
	fill(): void;
	fillRect(x: number, y: number, w: number, h: number): void;
	strokeRect(x: number, y: number, w: number, h: number): void;
	arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
	setLineDash(segments: number[]): void;
	translate(x: number, y: number): void;
	rotate(angle: number): void;
	font: string;
	textAlign: string;
	textBaseline: string;
	strokeText(text: string, x: number, y: number): void;
	fillText(text: string, x: number, y: number): void;
}

export interface CanvasMapRendererOptions {
	ctx: NodeCanvasContext2D;
	robotImage: Canvas | Image;
	chargerImage: Canvas | Image;
	goToPinImage: Canvas | Image;
	loadObstacleImage?(suffix: string, model?: string): Promise<Canvas | Image | null>;
	model?: string;
	/** Log warnings (e.g. missing obstacle image). */
	logWarn?(msg: string): void;
	/**
	 * Also record the map's **surface** on a canvas of its own.
	 *
	 * Off by default because it costs a second PNG encode of the full canvas. See
	 * {@link CanvasMapRenderer.getSurfaceSnapshot} for what lands on it.
	 */
	captureSurface?: boolean;
}

export class CanvasMapRenderer implements IMapRenderer {
	private ctx: NodeCanvasContext2D;
	private robotImage: Canvas | Image;
	private chargerImage: Canvas | Image;
	private goToPinImage: Canvas | Image;
	private loadObstacleImage?: (suffix: string, model?: string) => Promise<Canvas | Image | null>;
	private model?: string;
	private logWarn?: (msg: string) => void;
	private cleanSnapshotBase64: string | null = null;
	private carpetSprite: Canvas | null = null;
	private captureSurface: boolean;
	/** The second picture, created at the clean cut and painted alongside the first from there on. */
	private surfaceCanvas: Canvas | null = null;
	private surfaceCtx: NodeCanvasContext2D | null = null;
	private surfaceSnapshotBase64: string | null = null;

	constructor(options: CanvasMapRendererOptions) {
		this.ctx = options.ctx;
		this.robotImage = options.robotImage;
		this.chargerImage = options.chargerImage;
		this.goToPinImage = options.goToPinImage;
		this.loadObstacleImage = options.loadObstacleImage;
		this.model = options.model;
		this.logWarn = options.logWarn;
		this.captureSurface = options.captureSurface === true;
	}

	getCleanSnapshot(): string | null {
		if (this.cleanSnapshotBase64 === null) {
			const canvas = this.ctx.canvas;
			this.cleanSnapshotBase64 = canvas.toDataURL();
			// `drawMapV1` takes the clean cut right after the segments and before anything is laid on
			// top, which is exactly where the surface picture has to start from. Copying the finished
			// bitmap costs one blit; re-rasterising floor, walls and segments a second time would cost
			// the most expensive part of the whole render.
			if (this.captureSurface) this.startSurfaceCapture(canvas);
		}
		return this.cleanSnapshotBase64;
	}

	/**
	 * The map with everything that **lies on** the floor, and nothing that **stands in** the room.
	 *
	 * On it: carpet, the driven path, the mopped band, the predicted route, the detected objects and
	 * the room labels. Off it: no-go and no-mop zones, virtual walls, the active cleaning zone, the
	 * robot, the dock and the go-to pin.
	 *
	 * The line runs between "a marking of the floor" and "a thing standing in the room". The route
	 * and the pin it leads to fall on opposite sides of it: the route is a line drawn on the ground,
	 * the pin is a marker meant to be seen upright.
	 *
	 * That split exists for the 3D view, whose floor is textured with a map picture while the robot,
	 * the dock, the zones and the walls are bodies standing on it. `mapBase64Clean` leaves it with
	 * bare room colours - no path, no names, no objects - and `mapBase64` would lay a flat copy of
	 * every body underneath the body itself.
	 *
	 * **One snapshot cannot produce this picture**, which is why the drawing is mirrored instead:
	 * `drawMapV1` draws the zones before the room labels (`src/common/mapDrawing/drawMapV1.ts:256`
	 * and `:387`), so no single cut through that sequence has the labels without the zones.
	 * @returns Base64 PNG data URI, or null when nothing was captured - the option was off, or
	 * `drawMapV1` never reached its clean cut.
	 */
	getSurfaceSnapshot(): string | null {
		if (!this.surfaceCanvas) return null;
		if (this.surfaceSnapshotBase64 === null) {
			this.surfaceSnapshotBase64 = this.surfaceCanvas.toDataURL();
		}
		return this.surfaceSnapshotBase64;
	}

	private startSurfaceCapture(source: Canvas): void {
		const canvas = createCanvas(source.width, source.height);
		const ctx = canvas.getContext("2d") as unknown as NodeCanvasContext2D;
		ctx.imageSmoothingEnabled = false;
		if ("antialias" in ctx) ctx.antialias = "none";
		ctx.drawImage(source, 0, 0);
		this.surfaceCanvas = canvas;
		this.surfaceCtx = ctx;
	}

	/**
	 * The canvases a layer of the surface has to reach: the map itself, and the surface copy when one
	 * is being recorded.
	 */
	private surfaceTargets(): NodeCanvasContext2D[] {
		return this.surfaceCtx ? [this.ctx, this.surfaceCtx] : [this.ctx];
	}

	private createCarpetSprite(): Canvas {
		if (this.carpetSprite) return this.carpetSprite;
		const spriteCanvas = createCanvas(VISUAL_BLOCK_SIZE, VISUAL_BLOCK_SIZE);
		const ctx = spriteCanvas.getContext("2d") as unknown as NodeCanvasContext2D;
		ctx.imageSmoothingEnabled = false;
		if ("antialias" in ctx) ctx.antialias = "none";
		ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
		const STRIDE = 3;
		for (let dx = 0; dx < VISUAL_BLOCK_SIZE; dx++) {
			for (let dy = 0; dy < VISUAL_BLOCK_SIZE; dy++) {
				if ((dx + dy) % STRIDE === 2) ctx.fillRect(dx, dy, 1, 1);
			}
		}
		this.carpetSprite = spriteCanvas;
		return spriteCanvas;
	}

	private drawPathSegments(
		segments: { x: number; y: number }[][],
		stroke: string,
		lineWidth: number,
		opacity: number,
		dashed: boolean
	): void {
		if (!segments?.length) return;
		const tempCanvas = createCanvas(this.ctx.canvas.width, this.ctx.canvas.height);
		const tempCtx = tempCanvas.getContext("2d");
		tempCtx.strokeStyle = stroke;
		tempCtx.lineWidth = lineWidth;
		tempCtx.lineCap = "round";
		tempCtx.lineJoin = "round";
		tempCtx.setLineDash(dashed ? [VISUAL_BLOCK_SIZE, 2 * VISUAL_BLOCK_SIZE] : []);
		tempCtx.beginPath();
		for (const segment of segments) {
			if (segment.length > 0) {
				tempCtx.moveTo(segment[0].x, segment[0].y);
				for (let i = 1; i < segment.length; i++) tempCtx.lineTo(segment[i].x, segment[i].y);
			}
		}
		tempCtx.stroke();
		for (const ctx of this.surfaceTargets()) {
			ctx.save();
			ctx.globalAlpha = opacity;
			ctx.drawImage(tempCanvas as unknown as Canvas, 0, 0);
			ctx.restore();
		}
	}

	drawFloor(rects: DrawRect[]): void {
		const width = this.ctx.canvas.width;
		const height = this.ctx.canvas.height;
		const imgData = this.ctx.getImageData(0, 0, width, height);
		const data = imgData.data;
		for (const r of rects) {
			const [fr, fg, fb, fa] = parseRgba(r.fill);
			for (let dy = 0; dy < r.h; dy++) {
				const py = r.y + dy;
				if (py >= height) continue;
				for (let dx = 0; dx < r.w; dx++) {
					const px = r.x + dx;
					if (px >= width) continue;
					const idx = (py * width + px) * 4;
					data[idx] = fr;
					data[idx + 1] = fg;
					data[idx + 2] = fb;
					data[idx + 3] = fa;
				}
			}
		}
		this.ctx.putImageData(imgData, 0, 0);
	}

	drawSegmentRects(rects: DrawRect[]): void {
		const width = this.ctx.canvas.width;
		const height = this.ctx.canvas.height;
		const imgData = this.ctx.getImageData(0, 0, width, height);
		const data = imgData.data;
		for (const r of rects) {
			const [fr, fg, fb, fa] = parseRgba(r.fill);
			for (let dy = 0; dy < r.h; dy++) {
				const py = r.y + dy;
				if (py >= height) continue;
				for (let dx = 0; dx < r.w; dx++) {
					const px = r.x + dx;
					if (px >= width) continue;
					const idx = (py * width + px) * 4;
					data[idx] = fr;
					data[idx + 1] = fg;
					data[idx + 2] = fb;
					data[idx + 3] = fa;
				}
			}
		}
		this.ctx.putImageData(imgData, 0, 0);
	}

	drawCarpet(input: DrawCarpetInput): void {
		if (!input.positions.length) return;
		const sprite = this.createCarpetSprite();
		for (const ctx of this.surfaceTargets()) {
			ctx.imageSmoothingEnabled = false;
			if ("antialias" in ctx) ctx.antialias = "none";
			for (const pos of input.positions) {
				ctx.drawImage(sprite, pos.x, pos.y);
			}
		}
	}

	drawPath(input: { segments: { x: number; y: number }[][]; stroke: string; lineWidth: number; opacity?: number; dashed?: boolean }): void {
		this.drawPathSegments(
			input.segments,
			input.stroke,
			input.lineWidth,
			input.opacity ?? 1,
			input.dashed ?? false
		);
	}

	drawRobot(input: { x: number; y: number; angle: number }): void {
		const drawAngle = -input.angle + 90;
		const robotSize = VISUAL_BLOCK_SIZE * 5;
		this.ctx.save();
		this.ctx.translate(input.x, input.y);
		this.ctx.rotate((drawAngle * Math.PI) / 180);
		this.ctx.drawImage(this.robotImage, -robotSize / 2, -robotSize / 2, robotSize, robotSize);
		this.ctx.restore();
	}

	drawCharger(input: { x: number; y: number }): void {
		const w = VISUAL_BLOCK_SIZE * 3;
		const h = VISUAL_BLOCK_SIZE * 3;
		this.ctx.drawImage(this.chargerImage, input.x - w / 2, input.y - h / 2, w, h);
	}

	drawGoToPin(input: { x: number; y: number }): void {
		const pinW = VISUAL_BLOCK_SIZE * 3;
		const pinH = (pinW / 29) * 24;
		this.ctx.drawImage(this.goToPinImage, input.x - pinW / 2, input.y - (pinH + VISUAL_BLOCK_SIZE / 2), pinW, pinH);
	}

	async drawObstacles(items: DrawObstacleInput[]): Promise<void> {
		if (!items.length) return;
		const suffixMap: Record<number, string> = {
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
			50: "49",
			51: "51",
			54: "54",
			65: "65",
			67: "67",
			69: "69",
			70: "70",
			99: "99",
		};
		const radius = VISUAL_BLOCK_SIZE * 3.5;
		const size = VISUAL_BLOCK_SIZE * 5;
		const targets = this.surfaceTargets();
		for (const ob of items) {
			const suffix = typeof ob.typeOrSuffix === "number" ? (suffixMap[ob.typeOrSuffix] ?? "18") : ob.typeOrSuffix;
			// Resolved once and painted onto every target: the artwork comes out of the adapter's file
			// store, and reading it a second time per obstacle would be file I/O for a picture that is
			// already in hand.
			let image: Canvas | Image | null = null;
			if (ob.imageHref) {
				// Pre-loaded image passed (e.g. data URL or buffer loaded by caller)
				try {
					image = await loadImageFromData(ob.imageHref);
				} catch {
					// ignore
				}
			} else if (this.loadObstacleImage) {
				image = await this.loadObstacleImage(suffix, this.model);
				if (!image && this.logWarn) this.logWarn(`Could not find obstacle image for suffix ${suffix}`);
			}
			for (const ctx of targets) {
				ctx.beginPath();
				ctx.arc(ob.x, ob.y, radius, 0, 2 * Math.PI);
				ctx.fillStyle = "rgba(100, 100, 100, 0.2)";
				ctx.fill();
				ctx.lineWidth = 0.5;
				ctx.strokeStyle = "white";
				ctx.stroke();
				if (image) ctx.drawImage(image, ob.x - size / 2, ob.y - size / 2, size, size);
			}
		}
	}

	drawRoomLabels(labels: DrawRoomLabelInput[]): void {
		if (!labels.length) return;
		for (const ctx of this.surfaceTargets()) {
			ctx.font = `bold ${VISUAL_BLOCK_SIZE * 6}px Arial`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.lineWidth = 1;
			ctx.strokeStyle = "white";
			ctx.fillStyle = "black";
			for (const l of labels) {
				ctx.strokeText(l.text, l.x, l.y);
				ctx.fillText(l.text, l.x, l.y);
			}
		}
	}

	drawActiveZones(zones: DrawZoneRectInput[]): void {
		for (const z of zones) {
			this.ctx.fillStyle = z.fill;
			this.ctx.fillRect(z.x, z.y, z.w, z.h);
			this.ctx.strokeStyle = z.stroke;
			this.ctx.lineWidth = 4;
			this.ctx.strokeRect(z.x, z.y, z.w, z.h);
		}
	}

	drawRestrictedZones(zones: DrawZoneRectInput[], virtualWalls: DrawVirtualWallInput[]): void {
		for (const z of zones) {
			this.ctx.fillStyle = z.fill;
			this.ctx.strokeStyle = z.stroke;
			this.ctx.lineWidth = (1 * VISUAL_BLOCK_SIZE) / 2;

			// The corners when the zone has them: a map stores these zones as four points, and a
			// turned one is a different shape from the box around it. See `DrawZoneRectInput.points`.
			if (z.points && z.points.length >= 3) {
				this.ctx.beginPath();
				this.ctx.moveTo(z.points[0].x, z.points[0].y);
				for (let i = 1; i < z.points.length; i++) {
					this.ctx.lineTo(z.points[i].x, z.points[i].y);
				}
				this.ctx.closePath();
				this.ctx.fill();
				this.ctx.stroke();
				continue;
			}

			this.ctx.fillRect(z.x, z.y, z.w, z.h);
			this.ctx.strokeRect(z.x, z.y, z.w, z.h);
		}
		for (const w of virtualWalls) {
			this.ctx.strokeStyle = w.stroke;
			this.ctx.lineWidth = w.lineWidth;
			this.ctx.beginPath();
			this.ctx.moveTo(w.x1, w.y1);
			this.ctx.lineTo(w.x2, w.y2);
			this.ctx.stroke();
		}
	}

	drawPredictedPath(input: DrawPredictedPathInput): void {
		if (!input.points.length) return;
		// On the surface as well, unlike the go-to pin it leads to. The pin is a marker meant to stand
		// upright and reads wrong lying flat; the route to it is a line on the floor, like the driven
		// path beside it, and 3D gives it no body of its own to be doubled against.
		for (const ctx of this.surfaceTargets()) {
			ctx.lineWidth = input.lineWidth;
			ctx.strokeStyle = input.stroke;
			ctx.setLineDash(input.dashArray);
			ctx.lineCap = "round";
			ctx.beginPath();
			let lastX = -1,
				lastY = -1;
			input.points.forEach((p, index) => {
				if (index === 0) {
					ctx.fillStyle = "rgba(255, 255, 255, 1)";
					ctx.fillRect(p.x, p.y, (1 * VISUAL_BLOCK_SIZE) / 2, (1 * VISUAL_BLOCK_SIZE) / 2);
					ctx.moveTo(p.x, p.y);
				} else if (p.x !== lastX || p.y !== lastY) {
					ctx.lineTo(p.x, p.y);
				}
				lastX = p.x;
				lastY = p.y;
			});
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.lineCap = "butt";
		}
	}
}

function parseRgba(css: string): [number, number, number, number] {
	const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
	if (m) {
		const a = m[4] != null ? Math.round(parseFloat(m[4]) * 255) : 255;
		return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), a];
	}
	return [0, 0, 0, 255];
}

async function loadImageFromData(data: string): Promise<Canvas | Image | null> {
	// data can be base64 data URL or path; @napi-rs/canvas loadImage can accept buffer
	const { loadImage } = await import("@napi-rs/canvas");
	if (data.startsWith("data:")) {
		const base64 = data.replace(/^data:image\/\w+;base64,/, "");
		const buf = Buffer.from(base64, "base64");
		return await loadImage(buf);
	}
	return await loadImage(data);
}
