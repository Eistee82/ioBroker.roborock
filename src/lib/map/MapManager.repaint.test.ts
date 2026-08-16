import { describe, expect, it, vi } from "vitest";
import { MapManager } from "./MapManager";

/**
 * A colour scheme change has to take effect at once, and it must not cost a single request: the
 * parsed map is already stored per device, so the new picture is produced from that.
 *
 * The dangerous part is what happens to devices whose stored map is *not* a V1 map. B01 and Q10
 * keep a different structure under the same state id, and handing it to the V1 renderer yields
 * the 1x1 error image - which would then be written over a perfectly good map. Hence the test
 * that those devices are skipped entirely.
 */

const V1_MAP = JSON.stringify({
	IMAGE: {
		position: { left: 0, top: 0 },
		dimensions: { width: 4, height: 4 },
		pixels: { floor: [0], obstacle: [], segments: [] }
	}
});

/** A B01 payload as it is stored: a protobuf-shaped object without the V1 IMAGE block. */
const B01_MAP = JSON.stringify({ header: { sizeX: 4, sizeY: 4 }, mapGrid: [0, 0, 0, 0] });

function createAdapter(states: Record<string, { val: string | null }>) {
	return {
		rLog: vi.fn(),
		errorMessage: (e: unknown) => String(e),
		http_api: { getRobotModel: () => "roborock.vacuum.a65" },
		getStatesAsync: vi.fn().mockResolvedValue(states),
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		ensureState: vi.fn().mockResolvedValue(undefined),
		setStateChangedAsync: vi.fn().mockResolvedValue(undefined)
	};
}

describe("MapManager.repaintStoredMaps", () => {
	it("repaints a stored V1 map without asking the robot", async () => {
		const adapter = createAdapter({
			"roborock.0.Devices.duid1.map.mapData": { val: V1_MAP }
		});
		const manager = new MapManager(adapter as any);
		const canvasMap = vi.fn().mockResolvedValue(["clean", "full", "cropped"]);
		manager.mapCreator.canvasMap = canvasMap;

		await manager.repaintStoredMaps();

		expect(canvasMap).toHaveBeenCalledTimes(1);
		expect(canvasMap.mock.calls[0][1]).toMatchObject({ duid: "duid1", model: "roborock.vacuum.a65" });

		const written = adapter.setStateChangedAsync.mock.calls.map((c) => c[0]);
		expect(written).toContain("Devices.duid1.map.mapBase64");
		expect(written).toContain("Devices.duid1.map.mapBase64Clean");
		// The parsed data is untouched: only the picture changed.
		expect(written).not.toContain("Devices.duid1.map.mapData");
	});

	it("leaves maps of other pipelines alone", async () => {
		const adapter = createAdapter({
			"roborock.0.Devices.duid1.map.mapData": { val: B01_MAP },
			"roborock.0.Devices.duid2.map.mapData": { val: "not json at all" },
			"roborock.0.Devices.duid3.map.mapData": { val: null }
		});
		const manager = new MapManager(adapter as any);
		const canvasMap = vi.fn().mockResolvedValue(["clean", "full", "cropped"]);
		manager.mapCreator.canvasMap = canvasMap;

		await manager.repaintStoredMaps();

		expect(canvasMap).not.toHaveBeenCalled();
		expect(adapter.setStateChangedAsync).not.toHaveBeenCalled();
	});

	it("keeps going when one device fails", async () => {
		const adapter = createAdapter({
			"roborock.0.Devices.duid1.map.mapData": { val: V1_MAP },
			"roborock.0.Devices.duid2.map.mapData": { val: V1_MAP }
		});
		const manager = new MapManager(adapter as any);
		const canvasMap = vi
			.fn()
			.mockRejectedValueOnce(new Error("canvas exploded"))
			.mockResolvedValue(["clean", "full", "cropped"]);
		manager.mapCreator.canvasMap = canvasMap;

		await manager.repaintStoredMaps();

		expect(canvasMap).toHaveBeenCalledTimes(2);
		const written = adapter.setStateChangedAsync.mock.calls.map((c) => c[0]);
		expect(written).toContain("Devices.duid2.map.mapBase64");
	});

	/**
	 * The third picture, and the reason it exists: the 3D view textures its floor with a map while
	 * the robot, the dock, the zones and the walls stand on it as bodies. Neither of the other two
	 * fits - `mapBase64Clean` has no path and no room names, `mapBase64` carries a flat copy of
	 * every body. See `src/lib/map/v1/CanvasMapRenderer.ts`.
	 */
	it("asks for the surface picture and publishes it as its own state", async () => {
		const adapter = createAdapter({
			"roborock.0.Devices.duid1.map.mapData": { val: V1_MAP }
		});
		const manager = new MapManager(adapter as any);
		const canvasMap = vi.fn().mockResolvedValue(["clean", "full", "cropped", "surface"]);
		manager.mapCreator.canvasMap = canvasMap;

		await manager.repaintStoredMaps();

		expect(canvasMap.mock.calls[0][1]).toMatchObject({ surface: true });
		const surface = adapter.setStateChangedAsync.mock.calls.find(
			(c) => c[0] === "Devices.duid1.map.mapBase64Surface"
		);
		expect(surface?.[1]).toMatchObject({ val: "surface", ack: true });
	});

	it("writes no surface state when the render produced none", async () => {
		// A pipeline without one - B01, Q10, or a map that never reached the clean cut - must leave
		// the state alone. Writing an empty value would replace a good picture with a blank floor,
		// where an absent state lets the view fall back to the clean map.
		const adapter = createAdapter({
			"roborock.0.Devices.duid1.map.mapData": { val: V1_MAP }
		});
		const manager = new MapManager(adapter as any);
		manager.mapCreator.canvasMap = vi.fn().mockResolvedValue(["clean", "full", "cropped", null]);

		await manager.repaintStoredMaps();

		const written = adapter.setStateChangedAsync.mock.calls.map((c) => c[0]);
		expect(written).toContain("Devices.duid1.map.mapBase64Clean");
		expect(written).not.toContain("Devices.duid1.map.mapBase64Surface");
	});
});
