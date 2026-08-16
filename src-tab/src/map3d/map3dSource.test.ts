import { beforeEach, describe, expect, it, vi } from "vitest";
import { Map3DSource } from "./map3dSource";
import type { Map3DModel } from "./map3dModel";
import type { EngineConnection } from "../engine/types";

/**
 * Which picture the 3D floor is textured with.
 *
 * Three states can carry a map picture and only one of them is right here:
 *
 *  - `map.mapBase64Clean` is bare room colour. No driven path, no mopped band, no room names, no
 *    detected objects - which was issue #78: the 3D floor showed nothing but the rooms.
 *  - `map.mapBase64` has all of that, and a painted robot, dock and zone on top. In 3D those are
 *    bodies standing on the floor, so the picture would put a flat copy of each one underneath it.
 *  - `map.mapBase64Surface` is the one the adapter added for exactly this: everything that lies on
 *    the floor, nothing that stands in the room.
 *
 * The surface state does not exist everywhere. B01 and Q10 have no V1 drawing pipeline, and an
 * adapter older than the state has nothing to publish. Falling back to the clean picture is the
 * difference between "the markings are missing again" and "the 3D view is broken".
 */

const INSTANCE = "roborock.0";
const DUID = "duid1";
const ROOT = `${INSTANCE}.Devices.${DUID}.map`;
const SURFACE_ID = `${ROOT}.mapBase64Surface`;
const CLEAN_ID = `${ROOT}.mapBase64Clean`;
const DATA_ID = `${ROOT}.mapData`;

const SURFACE_IMAGE = "data:image/png;base64,c3VyZmFjZQ==";
const CLEAN_IMAGE = "data:image/png;base64,Y2xlYW4=";

/** A grid `buildMap3DModel` accepts: four cells wide, three high, one row of wall. */
const MAP_DATA = JSON.stringify({
	IMAGE: {
		position: { left: 0, top: 0 },
		dimensions: { width: 4, height: 3 },
		pixels: { obstacle: [0, 1, 2, 3], floor: [4, 5, 6, 7] }
	}
});

interface Harness {
	connection: EngineConnection;
	handlers: Map<string, (id: string, state: { val?: unknown } | null) => void>;
	models: Array<Map3DModel | null>;
	source: Map3DSource;
}

function harness(states: Record<string, { val: unknown } | undefined>): Harness {
	const handlers = new Map<string, (id: string, state: { val?: unknown } | null) => void>();
	const models: Array<Map3DModel | null> = [];
	const connection = {
		getStates: vi.fn(async (ids: string[]) => {
			const out: Record<string, unknown> = {};
			for (const id of ids) if (states[id]) out[id] = states[id];
			return out;
		}),
		subscribeState: vi.fn(async (id: string, handler: (id: string, state: { val?: unknown } | null) => void) => {
			handlers.set(id, handler);
		}),
		unsubscribeState: vi.fn((id: string) => {
			handlers.delete(id);
		})
	} as unknown as EngineConnection;

	const source = new Map3DSource(connection, {
		onModel: (model) => models.push(model),
		onLiveRobot: () => undefined
	});
	return { connection, handlers, models, source };
}

/** The picture of the newest model that is not null, or undefined when there was none. */
function lastTexture(models: Array<Map3DModel | null>): string | undefined {
	for (let i = models.length - 1; i >= 0; i--) {
		if (models[i]) return models[i]!.imageSrc;
	}
	return undefined;
}

describe("Map3DSource picks the picture for the floor", () => {
	let h: Harness;

	beforeEach(() => {
		h = harness({});
	});

	it("uses the surface picture when the adapter publishes one", async () => {
		h = harness({
			[SURFACE_ID]: { val: SURFACE_IMAGE },
			[CLEAN_ID]: { val: CLEAN_IMAGE },
			[DATA_ID]: { val: MAP_DATA }
		});

		await h.source.setDevice(INSTANCE, DUID);

		expect(lastTexture(h.models)).toBe(SURFACE_IMAGE);
	});

	it("falls back to the clean picture where there is no surface state", async () => {
		// B01/Q10, or an adapter that predates the state. The markings are missing again, which is
		// the old behaviour - but the view still has a floor.
		h = harness({
			[CLEAN_ID]: { val: CLEAN_IMAGE },
			[DATA_ID]: { val: MAP_DATA }
		});

		await h.source.setDevice(INSTANCE, DUID);

		expect(lastTexture(h.models)).toBe(CLEAN_IMAGE);
	});

	it("falls back when the surface state exists but has never been written", async () => {
		h = harness({
			[SURFACE_ID]: { val: null },
			[CLEAN_ID]: { val: CLEAN_IMAGE },
			[DATA_ID]: { val: MAP_DATA }
		});

		await h.source.setDevice(INSTANCE, DUID);

		expect(lastTexture(h.models)).toBe(CLEAN_IMAGE);
	});

	it("switches to the surface picture as soon as one arrives", async () => {
		h = harness({
			[CLEAN_ID]: { val: CLEAN_IMAGE },
			[DATA_ID]: { val: MAP_DATA }
		});
		await h.source.setDevice(INSTANCE, DUID);
		expect(lastTexture(h.models)).toBe(CLEAN_IMAGE);

		h.handlers.get(SURFACE_ID)!(SURFACE_ID, { val: SURFACE_IMAGE });

		expect(lastTexture(h.models)).toBe(SURFACE_IMAGE);
	});

	it("subscribes to both pictures, so neither update is missed", async () => {
		h = harness({ [DATA_ID]: { val: MAP_DATA } });

		await h.source.setDevice(INSTANCE, DUID);

		expect(h.handlers.has(SURFACE_ID)).toBe(true);
		expect(h.handlers.has(CLEAN_ID)).toBe(true);
	});

	it("drops every subscription it took when the device changes", async () => {
		h = harness({
			[SURFACE_ID]: { val: SURFACE_IMAGE },
			[CLEAN_ID]: { val: CLEAN_IMAGE },
			[DATA_ID]: { val: MAP_DATA }
		});
		await h.source.setDevice(INSTANCE, DUID);
		const taken = [...h.handlers.keys()];

		await h.source.setDevice(INSTANCE, "");

		expect(taken.length).toBe(4);
		expect(h.handlers.size).toBe(0);
	});

	it("rebuilds nothing when a state changes that this view does not draw from", async () => {
		// Three states can fire per map cycle and two of them carry a picture. Rebuilding the scene
		// for a clean picture that is not the one being used would cost every wall run and every
		// piece of furniture twice, and would throw the camera away with it.
		h = harness({
			[SURFACE_ID]: { val: SURFACE_IMAGE },
			[CLEAN_ID]: { val: CLEAN_IMAGE },
			[DATA_ID]: { val: MAP_DATA }
		});
		await h.source.setDevice(INSTANCE, DUID);
		const before = h.models.length;

		h.handlers.get(CLEAN_ID)!(CLEAN_ID, { val: "data:image/png;base64,YW5vdGhlcg==" });

		expect(h.models.length).toBe(before);

		// And a real change still gets through.
		h.handlers.get(SURFACE_ID)!(SURFACE_ID, { val: "data:image/png;base64,bmV3" });
		expect(h.models.length).toBe(before + 1);
	});

	it("reports no model at all while there is no picture", async () => {
		h = harness({ [DATA_ID]: { val: MAP_DATA } });

		await h.source.setDevice(INSTANCE, DUID);

		expect(h.models.every((model) => model === null)).toBe(true);
	});
});
