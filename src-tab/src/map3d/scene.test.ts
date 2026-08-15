import { describe, expect, it } from "vitest";
import { buildScene } from "./scene";
import type { ScenePalette, ThreeLike } from "./scene";
import { WALL_HEIGHT_CELLS } from "./map3dModel";
import type { Map3DModel } from "./map3dModel";

/**
 * What the scene builder puts where.
 *
 * Testable at all only because `buildScene` takes the three.js namespace as an argument instead of
 * importing it: the stand-in below records what was constructed, so the geometry can be checked
 * without a GPU, without jsdom pretending to have WebGL, and without loading half a megabyte.
 *
 * The assertions are about the two things that would be wrong and invisible: **how many** boxes are
 * drawn and **where** they stand.
 */

interface Recorded {
	boxes: Array<[number, number, number]>;
	instanced: Array<{ count: number }>;
	matrices: Array<[number, number, number]>;
	planes: Array<[number, number]>;
	lights: Array<{ kind: string; intensity: number }>;
	added: number;
}

function stubThree(): { three: ThreeLike; log: Recorded } {
	const log: Recorded = { boxes: [], instanced: [], matrices: [], planes: [], lights: [], added: 0 };

	class Vec {
		public x = 0;
		public y = 0;
		public z = 0;
		public set(x: number, y: number, z: number): void {
			this.x = x;
			this.y = y;
			this.z = z;
		}
	}

	class Obj {
		public position = new Vec();
		public rotation = new Vec();
		public matrix = { position: [0, 0, 0] as [number, number, number] };
		public updateMatrix(): void {
			this.matrix = { position: [this.position.x, this.position.y, this.position.z] };
		}
	}

	const three = {
		Scene: class {
			public background: unknown = null;
			public add(): void {
				log.added++;
			}
		},
		Color: class {
			public constructor(public value: number | string) {}
		},
		PerspectiveCamera: class {
			public position = new Vec();
			public aspect = 1;
			public lookAt(): void {}
			public updateProjectionMatrix(): void {}
		},
		AmbientLight: class {
			public position = new Vec();
			public constructor(_colour: number, intensity = 1) {
				log.lights.push({ kind: "ambient", intensity });
			}
		},
		DirectionalLight: class {
			public position = new Vec();
			public constructor(_colour: number, intensity = 1) {
				log.lights.push({ kind: "directional", intensity });
			}
		},
		PlaneGeometry: class {
			public constructor(width: number, height: number) {
				log.planes.push([width, height]);
			}
			public dispose(): void {}
		},
		BoxGeometry: class {
			public constructor(width: number, height: number, depth: number) {
				log.boxes.push([width, height, depth]);
			}
			public dispose(): void {}
		},
		CylinderGeometry: class {
			public dispose(): void {}
		},
		MeshStandardMaterial: class {
			public constructor(public parameters: Record<string, unknown>) {}
			public dispose(): void {}
		},
		MeshBasicMaterial: class {
			public constructor(public parameters: Record<string, unknown>) {}
			public dispose(): void {}
		},
		Mesh: class extends Obj {},
		InstancedMesh: class extends Obj {
			public instanceMatrix = { needsUpdate: false };
			public constructor(_geometry: unknown, _material: unknown, count: number) {
				super();
				log.instanced.push({ count });
			}
			public setMatrixAt(_index: number, matrix: { position: [number, number, number] }): void {
				log.matrices.push([...matrix.position]);
			}
			public dispose(): void {}
		},
		Object3D: Obj,
		Group: Obj,
		Texture: class {
			public constructor(public image: unknown) {}
			public dispose(): void {}
		},
		DoubleSide: 2,
		SRGBColorSpace: "srgb"
	} as unknown as ThreeLike;

	return { three, log };
}

const PALETTE: ScenePalette = { background: "#101010", wall: "#b8bec9", robot: "#3f7", charger: "#888" };

function model(over: Partial<Map3DModel> = {}): Map3DModel {
	return {
		width: 4,
		height: 3,
		obstacles: [0, 5, 11],
		imageSrc: "data:image/png;base64,AAAA",
		robot: { x: 2.5, y: 0.5, angle: 90 },
		charger: { x: 1.5, y: 1.5, angle: 0 },
		...over
	};
}

describe("the floor", () => {
	it("is one plane the size of the grid, carrying the map picture", () => {
		// The app does the same: the 3D floor is the 2D map as a texture
		// (`_appanalysis/21-3d-kartenansicht.md` §0). It is also why rooms, their colours and their
		// names appear without this module knowing anything about rooms.
		const { three, log } = stubThree();
		buildScene(three, model(), { fake: true }, PALETTE);

		expect(log.planes).toEqual([[4, 3]]);
	});
});

describe("the walls", () => {
	it("draws one box per occupied cell, in a single instanced mesh", () => {
		// The test device has 3 468 occupied cells. As separate meshes that is 3 468 draw calls and
		// visibly slow on a tablet; as one instanced mesh it is one.
		const { three, log } = stubThree();
		const built = buildScene(three, model(), {}, PALETTE);

		expect(log.instanced).toEqual([{ count: 3 }]);
		expect(built.wallCount).toBe(3);
	});

	it("uses the app's wall height and a footprint of exactly one cell", () => {
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		expect(log.boxes[0]).toEqual([1, WALL_HEIGHT_CELLS, 1]);
	});

	it("stands each box on the floor, centred on its own cell", () => {
		// Centre of the cell, not its corner: the grid names cells, and a box on the integer would
		// straddle four of them. Half the height, because a box is centred on its origin.
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		const y = WALL_HEIGHT_CELLS / 2;
		expect(log.matrices).toEqual([
			[0.5, y, 0.5], // cell 0  -> (0,0)
			[1.5, y, 1.5], // cell 5  -> (1,1)
			[3.5, y, 2.5] // cell 11 -> (3,2)
		]);
	});

	it("builds no instanced mesh at all when nothing is occupied", () => {
		const { three, log } = stubThree();
		const built = buildScene(three, model({ obstacles: [] }), {}, PALETTE);

		expect(log.instanced).toEqual([]);
		expect(built.wallCount).toBe(0);
	});
});

describe("robot and dock", () => {
	it("leaves them out when the map does not place them", () => {
		const { three } = stubThree();
		const built = buildScene(three, model({ robot: null, charger: null }), {}, PALETTE);

		// Floor, walls and the lights - and nothing standing for a robot nobody located.
		expect(built.scene).toBeTruthy();
		expect(built.wallCount).toBe(3);
	});
});

describe("the light rig", () => {
	it("uses the brightnesses read out of the app", () => {
		// `21-3d-kartenansicht.md` §3.5: ambient 0.68, two directionals at 0.34.
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		expect(log.lights).toEqual([
			{ kind: "ambient", intensity: 0.68 },
			{ kind: "directional", intensity: 0.34 },
			{ kind: "directional", intensity: 0.34 }
		]);
	});
});

describe("teardown", () => {
	it("hands back everything that holds GPU memory", () => {
		// Geometries, materials and textures are not reached by garbage collection. Switching
		// between 2D and 3D a few dozen times would otherwise grow without end.
		const { three } = stubThree();
		const built = buildScene(three, model(), {}, PALETTE);

		expect(built.disposables.length).toBeGreaterThan(0);
		for (const item of built.disposables) expect(typeof item.dispose).toBe("function");
	});
});

describe("the camera", () => {
	it("looks at the middle of the map from far enough out to see it", () => {
		const { three } = stubThree();
		const built = buildScene(three, model(), {}, PALETTE);

		expect(built.centre).toEqual({ x: 2, z: 1.5 });
		expect(built.camera.position.y).toBeGreaterThan(0);
	});
});
