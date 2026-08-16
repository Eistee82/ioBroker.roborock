import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { CellPoint, Map3DModel } from "./map3dModel";
import type { ScenePalette } from "./scene";

/**
 * What makes the view rebuild, and what the camera survives.
 *
 * ## The bug this pins
 *
 * The user reported the 3D view snapping back to its starting angle a second or two after every
 * drag. The cause was not the live position - that path was already separate - but the map: the
 * start-up effect listed `model` among its dependencies, so a new map object tore the whole scene
 * down and built a new one, and `buildScene` mints a fresh `PerspectiveCamera` at a fixed place
 * (`scene.ts`). The user's rotation lived only in the discarded camera.
 *
 * A map object is new far more often than the old comment in `scene.ts` assumed ("the map tick is
 * minutes apart"): `io-package.json` ships `liveMapInterval: 3`, and while the robot works its path
 * and position change with every one of those cycles, so `map.mapData` and `map.mapBase64Surface`
 * really do carry new values every three seconds.
 *
 * ## Why the assertions count constructions rather than look at pixels
 *
 * three.js is replaced below, so nothing is rendered and nothing needs a GPU. What is measured is
 * the only thing that matters for the report: **how many times `buildScene` ran** and **which camera
 * the controls are driving**. Both are invisible when reading the component and immediately obvious
 * on screen, which is exactly the sort of thing that has to be pinned.
 */

interface FakeCamera {
	aspect: number;
	position: FakeVec;
	updateProjectionMatrix: () => void;
}

interface FakeControls {
	camera: FakeCamera;
	target: FakeVec;
}

interface SceneLog {
	/** One entry per `buildScene` call. */
	builds: number;
	/** Every `OrbitControls` made, in order - one per build. */
	controls: FakeControls[];
	/** Textures handed to `setFloorTexture` after the build, by their image source. */
	floorTextures: string[];
	/** Disposed textures, counted across every swap and teardown. */
	disposedTextures: number;
	/** The scene most recently built, so its bodies can be read back. */
	current: { robot: FakeVec | null; charger: FakeVec | null } | null;
}

const log: SceneLog = { builds: 0, controls: [], floorTextures: [], disposedTextures: 0, current: null };

class FakeVec {
	public x = 0;
	public y = 0;
	public z = 0;
	public set(x: number, y: number, z: number): this {
		this.x = x;
		this.y = y;
		this.z = z;
		return this;
	}
	public copy(other: { x: number; y: number; z: number }): this {
		return this.set(other.x, other.y, other.z);
	}
}

vi.mock("three", () => {
	class Texture {
		public colorSpace = "";
		public needsUpdate = false;
		public constructor(public image?: unknown) {}
		public dispose(): void {
			log.disposedTextures++;
		}
	}
	class WebGLRenderer {
		public domElement: HTMLElement = document.createElement("div");
		public constructor(public options?: unknown) {}
		public setClearColor(): void {}
		public setPixelRatio(): void {}
		public setSize(): void {}
		public render(): void {}
		public dispose(): void {}
	}
	return { Texture, WebGLRenderer, SRGBColorSpace: "srgb" };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => {
	class OrbitControls {
		public enableDamping = false;
		public maxPolarAngle = 0;
		public target = new FakeVec();
		public constructor(
			public camera: FakeCamera,
			public element: unknown
		) {
			log.controls.push(this as unknown as FakeControls);
		}
		public update(): void {}
		public dispose(): void {}
	}
	return { OrbitControls };
});

vi.mock("./roborockModels", () => ({
	loadRoborockModels: (): Promise<null> => Promise.resolve(null)
}));

vi.mock("./scene", async () => {
	const actual = await vi.importActual<typeof import("./scene")>("./scene");
	return {
		...actual,
		buildScene: (_three: unknown, model: Map3DModel): unknown => {
			log.builds++;
			// A new camera object per build, at a place derived from the map, exactly as the real
			// `buildScene` does - which is why a rebuild loses the user's angle unless it is restored.
			const camera: FakeCamera = { aspect: 1, position: new FakeVec(), updateProjectionMatrix: (): void => {} };
			const span = Math.max(model.width, model.height);
			camera.position.set(model.width / 2, span * 0.9, model.height / 2 + span * 0.8);
			const robot = model.robot ? new FakeVec().set(model.robot.x, 1.5, model.robot.y) : null;
			const charger = model.charger ? new FakeVec().set(model.charger.x, 1, model.charger.y) : null;
			log.current = { robot, charger };
			return {
				scene: {},
				camera,
				disposables: [{ dispose: (): void => {} }],
				centre: { x: model.width / 2, z: model.height / 2 },
				wallCount: model.walls.length,
				robot: robot ? { position: robot } : null,
				charger: charger ? { position: charger } : null,
				setFloorTexture: (texture: { image?: { src?: string } }): void => {
					log.floorTextures.push(texture.image?.src ?? "");
				}
			};
		}
	};
});

// Imported after the mocks so the component picks the stand-ins up.
const { Map3DView } = await import("./Map3DView");

// This file drives `createRoot` itself rather than going through `@testing-library/react`, because
// the assertions are about effects and not about the DOM. That library sets the flag below on the
// way in; without it React only warns and leaves updates unflushed.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Two browser things the view uses and jsdom does not have. Without them the start-up throws and
 * reports itself unavailable, which would make every assertion below pass for the wrong reason -
 * a scene that was never built also never rebuilds.
 */
if (!("ResizeObserver" in globalThis)) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
		public observe(): void {}
		public unobserve(): void {}
		public disconnect(): void {}
	};
}
if (!HTMLImageElement.prototype.decode) {
	HTMLImageElement.prototype.decode = (): Promise<void> => Promise.resolve();
}

const PALETTE: ScenePalette = {
	background: "#000000",
	wall: "#111111",
	robot: "#222222",
	charger: "#333333",
	furniture: "#444444",
	furnitureUnknown: "#555555",
	forbiddenZone: "#666666",
	noMopZone: "#777777",
	virtualWall: "#888888"
};

function model(over: Partial<Map3DModel> = {}): Map3DModel {
	return {
		width: 40,
		height: 30,
		left: 10,
		top: 20,
		walls: [{ x0: 0, y0: 0, x1: 3, y1: 0 }],
		wallCellCount: 4,
		furniture: [],
		zones: [],
		virtualWalls: [],
		imageSrc: "data:image/png;base64,AAAA",
		robot: { x: 2.5, y: 0.5, angle: 90 },
		charger: { x: 1.5, y: 1.5, angle: 0 },
		mapFlag: 0,
		...over
	};
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/**
 * Renders the view and waits for its asynchronous start-up to finish.
 *
 * `start()` awaits three dynamic imports and an `image.decode()`, so a plain `act` returns before
 * the scene exists. Flushing microtasks a few times inside `act` is what makes the assertions look
 * at a started view rather than at a loading spinner.
 */
async function render(element: React.JSX.Element): Promise<void> {
	if (!root) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () => {
		root?.render(element);
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});
	await act(async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});
}

afterEach(() => {
	if (root) {
		const current = root;
		act(() => current.unmount());
		root = null;
	}
	host?.remove();
	host = null;
	log.builds = 0;
	log.controls.length = 0;
	log.floorTextures.length = 0;
	log.disposedTextures = 0;
	log.current = null;
});

describe("Map3DView rebuild behaviour", () => {
	// A start-up that failed would report a reason here; failing loudly beats every later
	// assertion passing because no scene was ever built.
	const noop = (reason: string): void => {
		throw new Error(`start-up reported itself unavailable: ${reason}`);
	};

	it("builds the scene once when it starts", async () => {
		await render(
			<Map3DView
				model={model()}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		expect(log.builds).toBe(1);
	});

	it("does not rebuild when only the live position changes", async () => {
		const one = model();
		await render(
			<Map3DView
				model={one}
				palette={PALETTE}
				livePosition={{ x: 1, y: 1 }}
				onUnavailable={noop}
			/>
		);
		expect(log.builds).toBe(1);

		// Ten live ticks, each a new object, as `map3dSource.publishLive` produces them.
		for (let i = 0; i < 10; i++) {
			const position: CellPoint = { x: 1 + i, y: 2 + i };
			await render(
				<Map3DView
					model={one}
					palette={PALETTE}
					livePosition={position}
					onUnavailable={noop}
				/>
			);
		}
		expect(log.builds).toBe(1);
	});

	/**
	 * The regression itself: a map cycle hands down a new `Map3DModel` object every three seconds,
	 * and that must not cost a rebuild while the map it describes is the same one.
	 */
	it("does not rebuild when a map cycle brings an equal model", async () => {
		await render(
			<Map3DView
				model={model()}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		expect(log.builds).toBe(1);

		for (let i = 0; i < 5; i++) {
			await render(
				<Map3DView
					model={model()}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
		}
		expect(log.builds).toBe(1);
	});

	it("keeps one set of orbit controls while the geometry stands", async () => {
		await render(
			<Map3DView
				model={model()}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		expect(log.controls).toHaveLength(1);
		const controls = log.controls[0];

		for (let i = 0; i < 3; i++) {
			await render(
				<Map3DView
					model={model({ imageSrc: `data:image/png;base64,PATH${i}` })}
					palette={PALETTE}
					livePosition={{ x: i, y: i }}
					onUnavailable={noop}
				/>
			);
		}
		expect(log.controls).toHaveLength(1);
		expect(log.controls[0]).toBe(controls);
	});

	/** The new picture reaches the floor without the scene being torn down for it. */
	it("swaps the floor texture when only the map picture changes", async () => {
		await render(
			<Map3DView
				model={model()}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		expect(log.floorTextures).toEqual([]);

		await render(
			<Map3DView
				model={model({ imageSrc: "data:image/png;base64,WITHPATH" })}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		expect(log.builds).toBe(1);
		expect(log.floorTextures).toEqual(["data:image/png;base64,WITHPATH"]);
		// The picture it replaced was released rather than left on the GPU.
		expect(log.disposedTextures).toBe(1);
	});

	/** The same map with the same picture must not make work of its own. */
	it("does not swap the texture when the picture is unchanged", async () => {
		await render(
			<Map3DView
				model={model()}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		for (let i = 0; i < 4; i++) {
			await render(
				<Map3DView
					model={model()}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
		}
		expect(log.floorTextures).toEqual([]);
		expect(log.disposedTextures).toBe(0);
	});

	it("moves the dock the map places instead of rebuilding for it", async () => {
		await render(
			<Map3DView
				model={model()}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		await render(
			<Map3DView
				model={model({ charger: { x: 20, y: 25, angle: 0 } })}
				palette={PALETTE}
				livePosition={null}
				onUnavailable={noop}
			/>
		);
		expect(log.builds).toBe(1);
		expect(log.current?.charger?.x).toBe(20);
		expect(log.current?.charger?.z).toBe(25);
	});

	/** The map's robot position is older than the live channel's and must not drag the body back. */
	it("lets the live position win over the map's robot position", async () => {
		await render(
			<Map3DView
				model={model()}
				palette={PALETTE}
				livePosition={{ x: 33, y: 44 }}
				onUnavailable={noop}
			/>
		);
		await render(
			<Map3DView
				model={model({ robot: { x: 1, y: 1, angle: 0 } })}
				palette={PALETTE}
				livePosition={{ x: 33, y: 44 }}
				onUnavailable={noop}
			/>
		);
		expect(log.current?.robot?.x).toBe(33);
		expect(log.current?.robot?.z).toBe(44);
	});

	describe("when the geometry really changes", () => {
		it("rebuilds", async () => {
			await render(
				<Map3DView
					model={model()}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			expect(log.builds).toBe(1);

			await render(
				<Map3DView
					model={model({ width: 60, height: 45 })}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			expect(log.builds).toBe(2);
		});

		/**
		 * The heart of the report. A robot discovering new walls changes the geometry, so a rebuild
		 * is unavoidable there - but the angle the user dragged to has to come back with it.
		 */
		it("puts the camera back where the user had turned it", async () => {
			await render(
				<Map3DView
					model={model()}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			const turned = log.controls[0];
			turned.camera.position.set(11, 22, 33);
			turned.target.set(4, 0, 5);

			await render(
				<Map3DView
					model={model({ walls: [{ x0: 0, y0: 0, x1: 9, y1: 0 }] })}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			expect(log.builds).toBe(2);
			const rebuilt = log.controls[1];
			expect(rebuilt).not.toBe(turned);
			expect([rebuilt.camera.position.x, rebuilt.camera.position.y, rebuilt.camera.position.z]).toEqual([11, 22, 33]);
			expect([rebuilt.target.x, rebuilt.target.y, rebuilt.target.z]).toEqual([4, 0, 5]);
		});

		/** Another stored map is another place; carrying an angle across it would aim at nothing. */
		it("starts the camera over when the map flag says it is a different map", async () => {
			await render(
				<Map3DView
					model={model({ mapFlag: 0 })}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			log.controls[0].camera.position.set(11, 22, 33);

			await render(
				<Map3DView
					model={model({ mapFlag: 1, width: 60, height: 45 })}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			const rebuilt = log.controls[1];
			// The default `buildScene` places the camera from the map's own size, not at (11,22,33).
			expect(rebuilt.camera.position.x).toBe(30);
			expect(rebuilt.camera.position.y).toBe(54);
		});

		/**
		 * A robot that publishes no map flag - B01, Q10 - gets the friendlier of the two mistakes:
		 * the camera is kept, because an unknown flag is no evidence that the map changed.
		 */
		it("keeps the camera when no map flag is published", async () => {
			await render(
				<Map3DView
					model={model({ mapFlag: null })}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			log.controls[0].camera.position.set(11, 22, 33);

			await render(
				<Map3DView
					model={model({ mapFlag: null, width: 60, height: 45 })}
					palette={PALETTE}
					livePosition={null}
					onUnavailable={noop}
				/>
			);
			expect(log.controls[1].camera.position.x).toBe(11);
		});
	});
});
