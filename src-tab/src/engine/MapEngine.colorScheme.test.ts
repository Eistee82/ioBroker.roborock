import { afterEach, describe, expect, it, vi } from "vitest";
import { MapEngine } from "./MapEngine";
import type { EngineConnection, MapEngineHost } from "./types";
import {
	DARK_MAP_OVERLAY_COLORS,
	LIGHT_MAP_OVERLAY_COLORS,
	MAP_COLOR_SCHEME_STATE,
} from "./mapOverlayColors";

/**
 * How the map's own light/dark decision reaches the things the tab draws on top of it.
 *
 * The zones and the room marker lie **on the map**, so they have to follow the bitmap, not the
 * admin theme - and the two are allowed to disagree, because `map_color_scheme` may be pinned to
 * `light` inside a dark admin. The tab cannot work the answer out; the adapter publishes it in the
 * state `mapColorScheme` and this is the wiring that reads it.
 *
 * What is tested here is exactly that wiring. The values themselves are `mapOverlayColors.test.ts`.
 */

const SCHEME_STATE_ID = `roborock.0.${MAP_COLOR_SCHEME_STATE}`;

interface EngineInternals {
	rects: { id: number; x: number; y: number; width: number; height: number }[];
	selectedRoomIds: Set<number>;
	applyRoomSelectionStyling(): void;
}

interface Started {
	engine: MapEngine;
	internals: EngineInternals;
	container: HTMLDivElement;
	connection: EngineConnection;
	/** Handlers the engine registered per state id. */
	subscriptions: Map<string, ((id: string, state: any) => void)[]>;
}

let live: MapEngine | null = null;

/**
 * Boots an engine whose `mapColorScheme` state already holds a value.
 * @param stored Value the adapter has published, or undefined for a state that does not exist.
 */
async function startEngine(stored?: string): Promise<Started> {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();

	const connection: EngineConnection = {
		sendTo: vi.fn().mockResolvedValue({}),
		getObject: vi.fn().mockResolvedValue(null),
		getStates: vi.fn(async (ids: string[]) => {
			const states: Record<string, any> = {};
			for (const id of ids) {
				if (id === SCHEME_STATE_ID && stored !== undefined) states[id] = { val: stored };
			}
			return states;
		}),
		subscribeState: vi.fn(async (id: string, handler: (id: string, state: any) => void) => {
			const list = subscriptions.get(id) ?? [];
			list.push(handler);
			subscriptions.set(id, list);
		}),
		unsubscribeState: vi.fn((id: string, handler: (id: string, state: any) => void) => {
			const list = (subscriptions.get(id) ?? []).filter((entry) => entry !== handler);
			if (list.length) subscriptions.set(id, list);
			else subscriptions.delete(id);
		}),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const container = document.createElement("div");
	document.body.appendChild(container);

	const host: MapEngineHost = {
		container,
		t: (_key: string, fallback: string) => fallback,
	};

	const engine = new MapEngine(connection, host);
	live = engine;
	await engine.init("roborock.0");
	// The stored value is fetched, so it arrives one microtask after `init` returns.
	await Promise.resolve();
	await Promise.resolve();

	return { engine, internals: engine as unknown as EngineInternals, container, connection, subscriptions };
}

/** The value a custom property currently has on the map surface. */
function surfaceVariable(container: HTMLDivElement, name: string): string {
	const surface = container.querySelector(".rr-map-surface") as HTMLElement | null;
	return surface?.style.getPropertyValue(name).trim() ?? "";
}

/** Pushes a state change to everything subscribed to the scheme. */
function pushScheme(started: Started, value: unknown): void {
	for (const handler of started.subscriptions.get(SCHEME_STATE_ID) ?? []) {
		handler(SCHEME_STATE_ID, { val: value });
	}
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.replaceChildren();
});

describe("the map colour scheme the overlays follow", () => {
	it("starts light when the adapter published nothing yet", async () => {
		// The same fallback the adapter makes: no answer means a light map, so light overlays.
		const started = await startEngine();
		expect(surfaceVariable(started.container, "--rr-zone-fill")).toBe(LIGHT_MAP_OVERLAY_COLORS.zoneFill);
	});

	it("adopts the value already stored, without waiting for a change", async () => {
		// A tab is normally opened long after the adapter settled on its scheme; a subscription
		// alone would leave it light until the next switch.
		const started = await startEngine("dark");
		expect(started.connection.getStates).toHaveBeenCalledWith([SCHEME_STATE_ID]);
		expect(surfaceVariable(started.container, "--rr-zone-fill")).toBe(DARK_MAP_OVERLAY_COLORS.zoneFill);
		expect(surfaceVariable(started.container, "--rr-zone-stroke")).toBe(DARK_MAP_OVERLAY_COLORS.zoneStroke);
		expect(surfaceVariable(started.container, "--rr-zone-focus")).toBe(DARK_MAP_OVERLAY_COLORS.focusView);
	});

	it("switches every overlay colour when the adapter repaints the map", async () => {
		const started = await startEngine("light");

		pushScheme(started, "dark");
		expect(surfaceVariable(started.container, "--rr-zone-fill")).toBe(DARK_MAP_OVERLAY_COLORS.zoneFill);
		expect(surfaceVariable(started.container, "--rr-zone-handle-ink")).toBe(DARK_MAP_OVERLAY_COLORS.handleInk);
		// The delete handle has a red of its own and follows the same switch.
		expect(surfaceVariable(started.container, "--rr-zone-delete-backing")).toBe(DARK_MAP_OVERLAY_COLORS.deleteBacking);

		pushScheme(started, "light");
		expect(surfaceVariable(started.container, "--rr-zone-fill")).toBe(LIGHT_MAP_OVERLAY_COLORS.zoneFill);
		expect(surfaceVariable(started.container, "--rr-zone-handle-ink")).toBe(LIGHT_MAP_OVERLAY_COLORS.handleInk);
		expect(surfaceVariable(started.container, "--rr-zone-delete-backing")).toBe(LIGHT_MAP_OVERLAY_COLORS.deleteBacking);
	});

	it("ignores a value that is neither name and keeps the set it had", async () => {
		const started = await startEngine("dark");

		for (const value of [undefined, null, "", "auto", "Dark", 7]) {
			pushScheme(started, value);
			expect(surfaceVariable(started.container, "--rr-zone-fill"), String(value)).toBe(
				DARK_MAP_OVERLAY_COLORS.zoneFill,
			);
		}
	});

	it("drops its subscription on destroy, like every other one the engine holds", async () => {
		const started = await startEngine("dark");
		expect(started.subscriptions.has(SCHEME_STATE_ID)).toBe(true);

		started.engine.destroy();
		live = null;
		expect(started.subscriptions.has(SCHEME_STATE_ID)).toBe(false);
	});
});

describe("the name of a picked room", () => {
	/**
	 * Builds one room label the way `SVGMapRenderer` leaves it behind.
	 * @param container Host element of the engine.
	 * @param segmentId Segment the label belongs to.
	 */
	function appendRoomLabel(container: HTMLDivElement, segmentId: number): SVGTextElement {
		const group = container.querySelector("g.room-names") as SVGGElement;
		const label = document.createElementNS("http://www.w3.org/2000/svg", "g");
		label.setAttribute("class", "room-label");
		label.setAttribute("data-segment-id", String(segmentId));
		label.setAttribute("data-text-fill", "#123456");
		const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		box.setAttribute("class", "room-label-selection");
		const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
		text.setAttribute("class", "room-name");
		label.append(box, text);
		group.append(label);
		return text as SVGTextElement;
	}

	it("takes the marker's contrast while picked and its own colour again after", async () => {
		// The pill itself is styled from the custom properties. The name cannot be: the renderer
		// writes a fill per label as an inline style, and no stylesheet can overrule that - which
		// is why the colour is written here and the unpicked one parked on the element.
		const started = await startEngine("dark");
		const text = appendRoomLabel(started.container, 16);

		started.internals.selectedRoomIds.add(16);
		started.internals.applyRoomSelectionStyling();
		expect(text.style.fill).toBe(DARK_MAP_OVERLAY_COLORS.roomSelectionInk);

		started.internals.selectedRoomIds.delete(16);
		started.internals.applyRoomSelectionStyling();
		expect(text.style.fill).toBe("#123456");
	});

	it("follows the map when the scheme changes under a standing selection", async () => {
		const started = await startEngine("dark");
		const text = appendRoomLabel(started.container, 16);

		started.internals.selectedRoomIds.add(16);
		started.internals.applyRoomSelectionStyling();
		expect(text.style.fill).toBe(DARK_MAP_OVERLAY_COLORS.roomSelectionInk);

		pushScheme(started, "light");
		expect(text.style.fill).toBe(LIGHT_MAP_OVERLAY_COLORS.roomSelectionInk);
	});
});
