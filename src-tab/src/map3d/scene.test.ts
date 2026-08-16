import { describe, expect, it } from "vitest";
import { buildScene } from "./scene";
import type { ScenePalette, ThreeLike } from "./scene";
import { WALL_HEIGHT_CELLS } from "./map3dModel";
import type { Map3DModel } from "./map3dModel";
import { shapeFor } from "./furnitureShapes";

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

type Triple = [number, number, number];

interface Placement {
	position: Triple;
	scale: Triple;
}

/** A placement plus which instanced mesh it went into, since the two are filled side by side. */
interface Instance extends Placement {
	mesh: number;
}

interface Recorded {
	boxes: Triple[];
	instanced: Array<{ count: number }>;
	/** One entry per `setMatrixAt`, tagged with the mesh it belongs to. */
	matrices: Instance[];
	planes: Array<[number, number]>;
	materials: Array<Record<string, unknown>>;
	/** Every `MeshBasicMaterial` - the floor is one, and what it does with alpha decides the view. */
	basicMaterials: Array<Record<string, unknown>>;
	/** Every plain `Mesh`, in construction order, so position, rotation and scale can be read back. */
	meshes: Array<{
		position: { x: number; y: number; z: number };
		rotation: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	}>;
	/** Every `Group` - one per piece of furniture, carrying that piece's place and turn. */
	groups: Array<{ position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }>;
	lights: Array<{ kind: string; intensity: number }>;
	added: number;
}

function stubThree(): { three: ThreeLike; log: Recorded } {
	const log: Recorded = { boxes: [], instanced: [], matrices: [], planes: [], materials: [], basicMaterials: [], meshes: [], groups: [], lights: [], added: 0 };

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
		public scale = new Vec();
		public matrix: Placement = { position: [0, 0, 0], scale: [1, 1, 1] };
		public updateMatrix(): void {
			this.matrix = {
				position: [this.position.x, this.position.y, this.position.z],
				scale: [this.scale.x, this.scale.y, this.scale.z]
			};
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
			public constructor(public parameters: Record<string, unknown>) {
				log.materials.push(parameters);
			}
			public dispose(): void {}
		},
		MeshBasicMaterial: class {
			public constructor(public parameters: Record<string, unknown>) {
				log.basicMaterials.push(parameters);
			}
			public dispose(): void {}
		},
		Mesh: class extends Obj {
			public constructor() {
				super();
				log.meshes.push(this);
			}
		},
		InstancedMesh: class extends Obj {
			public instanceMatrix = { needsUpdate: false };
			private readonly id: number;
			public constructor(_geometry: unknown, _material: unknown, count: number) {
				super();
				this.id = log.instanced.length;
				log.instanced.push({ count });
			}
			public setMatrixAt(_index: number, matrix: Placement): void {
				log.matrices.push({ mesh: this.id, position: [...matrix.position], scale: [...matrix.scale] });
			}
			public dispose(): void {}
		},
		BufferGeometry: class {
			public setAttribute(): void {}
			public setIndex(): void {}
			public dispose(): void {}
		},
		BufferAttribute: class {
			public constructor(
				public array: ArrayLike<number>,
				public itemSize: number
			) {}
		},
		Object3D: Obj,
		Group: class extends Obj {
			public constructor() {
				super();
				log.groups.push(this);
			}
			public add(): void {}
		},
		Texture: class {
			public constructor(public image: unknown) {}
			public dispose(): void {}
		},
		DoubleSide: 2,
		SRGBColorSpace: "srgb"
	} as unknown as ThreeLike;

	return { three, log };
}

const PALETTE: ScenePalette = {
	background: "#101010",
	wall: "#b8bec9",
	robot: "#3f7",
	charger: "#888",
	furniture: "#c2ab93",
	furnitureUnknown: "#a9aeb8",
	forbiddenZone: "#FF5E4A",
	noMopZone: "#65ACFA",
	virtualWall: "#FF5E4A"
};

/**
 * Two runs: a horizontal one four cells wide along the top edge, and a single cell further down.
 * Enough to see both the merged case and the degenerate one.
 */
const WALLS = [
	{ x0: 0, y0: 0, x1: 3, y1: 0 },
	{ x0: 2, y0: 2, x1: 2, y1: 2 }
];

function model(over: Partial<Map3DModel> = {}): Map3DModel {
	return {
		width: 4,
		height: 3,
		left: 10,
		top: 20,
		walls: [...WALLS],
		wallCellCount: 5,
		furniture: [],
		zones: [],
		virtualWalls: [],
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

	it("cuts the picture's transparent parts away instead of painting them black - and stays opaque doing it", () => {
		// Two mistakes are pinned here, because the view was shipped with each of them in turn.
		//
		// Without any alpha handling, three.js draws every transparent pixel of the map PNG as
		// opaque black: a black slab the size of the grid with the flat in the middle.
		//
		// With `transparent: true` the slab goes away and something subtler takes its place - the
		// floor joins the transparency queue, which is drawn after everything opaque and sorted
		// back to front, and it then loses to every half-transparent wall standing on it. The floor
		// starts vanishing behind walls.
		//
		// `alphaTest` without `transparent` is the combination that is right: opaque queue, and the
		// see-through pixels discarded rather than blended.
		const { three, log } = stubThree();
		buildScene(three, model(), { fake: true }, PALETTE);

		const floor = log.basicMaterials.find((m) => "map" in m);
		expect(floor).toBeDefined();
		expect(floor?.alphaTest).toBeGreaterThan(0);
		expect(floor?.transparent).not.toBe(true);
	});
});

describe("the walls", () => {
	it("are see-through for everything behind them, not only for the furniture", () => {
		// A transparent material that writes depth is transparent in colour and opaque in the depth
		// buffer. Opaque geometry - the furniture - is drawn in an earlier pass and survives; a
		// transparent thing behind the wall, a no-go zone or a virtual wall, is drawn later, finds
		// the wall's depth already written, and is discarded before it is ever blended. The wall
		// then looks see-through for some things and solid for others, which is worse than an
		// honestly solid wall.
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		const walls = log.materials.filter((m) => m.color === PALETTE.wall);
		expect(walls.length).toBeGreaterThan(0);
		for (const wall of walls) {
			expect(wall.transparent).toBe(true);
			expect(wall.depthWrite).toBe(false);
		}
	});

	it("draws one box per merged run, body and cap, two instanced meshes in all", () => {
		// One box per *run*, not per cell - that is the whole point of `extractWalls`. Two instanced
		// meshes and two geometries no matter how large the flat: 3 468 separate meshes were visibly
		// slow on a tablet, and 541 would be no better a habit.
		const { three, log } = stubThree();
		const built = buildScene(three, model(), {}, PALETTE);

		expect(log.instanced).toEqual([{ count: 2 }, { count: 2 }]);
		expect(built.wallCount).toBe(2);
	});

	it("uses the app's wall height and a unit footprint it scales per run", () => {
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		expect(log.boxes[0]).toEqual([1, WALL_HEIGHT_CELLS, 1]);
	});

	it("stretches each box over its run and stands it on the floor", () => {
		// Both ends of a run are inclusive, so 0..3 is four cells wide and its centre is at 2, not at
		// 1.5. Getting that wrong shortens every wall in the view by one cell.
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		const y = WALL_HEIGHT_CELLS / 2;
		const bodies = log.matrices.filter((entry) => entry.mesh === 0).map(({ position, scale }) => ({ position, scale }));
		expect(bodies).toEqual([
			{ position: [2, y, 0.5], scale: [4, 1, 1] }, // run (0,0)..(3,0)
			{ position: [2.5, y, 2.5], scale: [1, 1, 1] } // single cell (2,2)
		]);
	});

	it("puts the cap on top of the body, not inside it", () => {
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		// The app's plate sits at 10.15 over a wall of height 10 (`C4192OooO0oo.java:185`). Here the
		// cap is a slab rather than a plate, and half its thickness above a 10-high wall lands on the
		// same 10.15 - which is a pleasant check that the two are talking about the same geometry.
		const caps = log.matrices.filter((entry) => entry.mesh === 1);
		expect(caps).toHaveLength(2);
		expect(caps[0].position).toEqual([2, 10.15, 0.5]);
		expect(caps[0].scale).toEqual([4, 1, 1]);
	});

	it("makes the walls translucent, with the values read out of the app", () => {
		// `C4192OooO0oo.java:107-113`: the body is white at alpha 0.5, the cap white at alpha 0.7,
		// both with ordinary SRC_ALPHA / ONE_MINUS_SRC_ALPHA blending. Only the alpha is copied - the
		// colour comes from the palette, because this view has a dark theme and the app does not.
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		const [body, cap] = log.materials;
		expect(body).toMatchObject({ color: PALETTE.wall, transparent: true, opacity: 0.5 });
		expect(cap).toMatchObject({ color: PALETTE.wall, transparent: true, opacity: 0.7 });
	});

	it("builds no instanced mesh at all when nothing is occupied", () => {
		const { three, log } = stubThree();
		const built = buildScene(three, model({ walls: [], wallCellCount: 0 }), {}, PALETTE);

		expect(log.instanced).toEqual([]);
		expect(built.wallCount).toBe(0);
	});
});

describe("the furniture", () => {
	const SOFA = { x: 6, z: 26, width: 6, depth: 4, height: 16, angle: 0, type: 46, subType: 1, known: true, parts: shapeFor(46, 1), model: null };
	const STRANGE = { x: 2, z: 2, width: 3, depth: 2, height: 8, angle: 90, type: 99, subType: 0, known: false, parts: null, model: null };

	it("stands a piece without a shape on the floor at its own size", () => {
		// No shape means the plain block it always had: the full footprint, standing on the ground
		// rather than sunk halfway into it.
		const { three, log } = stubThree();
		buildScene(three, model({ furniture: [STRANGE] }), {}, PALETTE);

		const block = log.meshes[1]; // [0] is the floor plane
		expect([block.scale.x, block.scale.y, block.scale.z]).toEqual([3, 8, 2]);
		expect([block.position.x, block.position.y, block.position.z]).toEqual([0, 4, 0]);
	});

	it("turns the piece as a whole, with the sign the two frames differ by", () => {
		// The map's angle is clockwise in a y-down picture; three.js turns counter-clockwise about
		// +Y. Same magnitude, opposite sign - and nothing else. A missing minus here mirrors every
		// turned piece across its own centre, which on a sofa against a wall looks almost right.
		//
		// The turn is on the group rather than on each part: a headboard belongs at the head of the
		// bed whichever way the bed faces, and turning the parts one by one would need their offsets
		// turned too - which is exactly where a sign goes missing.
		const { three, log } = stubThree();
		buildScene(three, model({ furniture: [STRANGE] }), {}, PALETTE);

		expect(log.groups).toHaveLength(1);
		expect(log.groups[0].rotation.y).toBeCloseTo(-Math.PI / 2);
		expect([log.groups[0].position.x, log.groups[0].position.y, log.groups[0].position.z]).toEqual([2, 0, 2]);
	});

	it("draws Roborock's own model when it has been loaded, and falls back when it has not", () => {
		// The model wins over the substitute shape, and a piece whose model failed to load still
		// gets drawn - a missing download costs detail, never the piece.
		const withModel = { ...SOFA, model: "sofa1" };
		const roborock = {
			sofa1: {
				position: new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 3]),
				normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
				index: new Uint16Array([0, 1, 2]),
				size: { x: 2, y: 1, z: 3 },
				centre: { x: 1, y: 0.5, z: 1.5 }
			}
		};

		// Counted as a difference against a scene with no furniture at all: the robot and the dock
		// are meshes too, and counting from a fixed index breaks the moment one is added.
		const bare = stubThree();
		buildScene(bare.three, model({ furniture: [] }), {}, PALETTE, roborock);
		const baseline = bare.log.meshes.length;

		const loaded = stubThree();
		buildScene(loaded.three, model({ furniture: [withModel] }), {}, PALETTE, roborock);
		// One mesh for the piece, not one per part of the substitute shape.
		expect(loaded.log.meshes.length - baseline).toBe(1);
		// Scaled from the model's own box onto the footprint the robot measured. Furniture is drawn
		// after the floor and before the robot, so it is the second mesh.
		const drawn = loaded.log.meshes[1];
		expect(drawn.scale.x).toBeCloseTo(SOFA.width / 2);
		expect(drawn.scale.z).toBeCloseTo(SOFA.depth / 3);

		const missing = stubThree();
		buildScene(missing.three, model({ furniture: [withModel] }), {}, PALETTE, null);
		expect(missing.log.meshes.length - baseline).toBeGreaterThan(1);
	});

	it("draws a known piece from several parts rather than as one block", () => {
		// The point of the whole shape table: a sofa has a seat, a back and two arms, and from any
		// angle that reads as a sofa where a single block reads as a block.
		const { three, log } = stubThree();
		buildScene(three, model({ furniture: [SOFA] }), {}, PALETTE);

		const parts = log.meshes.slice(1); // [0] is the floor plane
		expect(parts.length).toBeGreaterThan(1);
		// Every part stays inside the piece's own footprint and above the floor.
		for (const part of parts) {
			expect(part.scale.x).toBeLessThanOrEqual(SOFA.width);
			expect(part.scale.z).toBeLessThanOrEqual(SOFA.depth);
			expect(part.position.y - part.scale.y / 2).toBeGreaterThanOrEqual(-1e-9);
		}
	});

	it("is solid when the type is known and faint when it is not", () => {
		// A stand-in says so by being faint. It may not be left out: a piece the robot reports is a
		// piece somebody can trip over.
		const { three, log } = stubThree();
		buildScene(three, model({ furniture: [SOFA, STRANGE] }), {}, PALETTE);

		const furnitureMaterials = log.materials.filter((m) => m.color === PALETTE.furniture || m.color === PALETTE.furnitureUnknown);
		expect(furnitureMaterials).toHaveLength(2);
		expect(furnitureMaterials[0]).toMatchObject({ color: PALETTE.furniture, transparent: false, opacity: 1 });
		expect(furnitureMaterials[1]).toMatchObject({ color: PALETTE.furnitureUnknown, transparent: true });
		expect(furnitureMaterials[1].opacity).toBeLessThan(1);
	});

	it("draws nothing at all when the map carries no furniture", () => {
		const { three, log } = stubThree();
		buildScene(three, model({ furniture: [] }), {}, PALETTE);

		expect(log.materials.some((m) => m.color === PALETTE.furniture)).toBe(false);
	});

	it("hands every part's geometry and the shared material to the teardown", () => {
		// One material per piece and one geometry per part. A part whose geometry is not handed over
		// leaks a GPU buffer on every redraw, which on a live map is every few seconds.
		const { three } = stubThree();
		const withOne = buildScene(three, model({ furniture: [SOFA] }), {}, PALETTE);
		const without = buildScene(three, model({ furniture: [] }), {}, PALETTE);

		const partCount = shapeFor(46, 1)?.length ?? 0;
		expect(partCount).toBeGreaterThan(0);
		expect(withOne.disposables.length).toBe(without.disposables.length + partCount + 1);
	});
});

describe("zones and virtual walls", () => {
	const ZONE = { kind: "forbidden" as const, x: 6, z: 26, width: 6, depth: 4, angle: 0 };
	const WALL = { x: 6, z: 26, length: 9, angle: 0 };

	it("builds a zone as a floor patch and four sides, and no lid", () => {
		// The app draws exactly that (`C4192OooO0oo.java:125-152`). A closed box would double the
		// alpha along the top edge and read as a solid block instead of a barrier.
		const { three, log } = stubThree();
		buildScene(three, model({ zones: [ZONE] }), {}, PALETTE);

		const zoneBoxes = log.boxes.filter((b) => b[1] === 0.2 || b[1] === WALL_HEIGHT_CELLS);
		// One patch of height 0.2 plus four sides of the wall height - the wall geometry itself is a
		// unit box, so it is not in this filter.
		expect(zoneBoxes.filter((b) => b[1] === 0.2)).toHaveLength(1);
		expect(zoneBoxes.filter((b) => b[1] === WALL_HEIGHT_CELLS && b[0] !== 1)).toHaveLength(4);
	});

	it("stands a zone as tall as the map walls", () => {
		const { three, log } = stubThree();
		buildScene(three, model({ zones: [ZONE] }), {}, PALETTE);

		for (const box of log.boxes.filter((b) => b[0] === ZONE.width && b[1] !== 0.2)) {
			expect(box[1]).toBe(WALL_HEIGHT_CELLS);
		}
	});

	it("colours the two kinds apart, at the app's own alpha", () => {
		const { three, log } = stubThree();
		buildScene(three, model({ zones: [ZONE, { ...ZONE, kind: "noMop" }] }), {}, PALETTE);

		const zoneMaterials = log.materials.filter((m) => m.color === PALETTE.forbiddenZone || m.color === PALETTE.noMopZone);
		// One material per zone, shared by its five boxes.
		expect(zoneMaterials).toHaveLength(2);
		expect(zoneMaterials[0]).toMatchObject({ color: PALETTE.forbiddenZone, transparent: true });
		expect(zoneMaterials[1]).toMatchObject({ color: PALETTE.noMopZone, transparent: true });
		expect(zoneMaterials[0].opacity).toBeCloseTo(0x66 / 255);
	});

	it("draws a virtual wall as one slab of the wall height", () => {
		const { three, log } = stubThree();
		buildScene(three, model({ virtualWalls: [WALL] }), {}, PALETTE);

		expect(log.boxes).toContainEqual([9, WALL_HEIGHT_CELLS, 1]);
		expect(log.materials.some((m) => m.color === PALETTE.virtualWall)).toBe(true);
	});

	it("draws nothing when the map carries neither", () => {
		const { three, log } = stubThree();
		buildScene(three, model(), {}, PALETTE);

		expect(log.materials.some((m) => m.color === PALETTE.forbiddenZone || m.color === PALETTE.noMopZone)).toBe(false);
	});
});

describe("the robot body", () => {
	it("is handed back so the live channel can move it without a rebuild", () => {
		// The map tick is minutes apart, the live tick seconds. Rebuilding 299 wall boxes, the floor
		// texture and every piece of furniture at the live rate would stutter and would throw the
		// user's camera away with each update.
		const { three } = stubThree();
		const built = buildScene(three, model(), {}, PALETTE);

		expect(built.robot).toBeTruthy();
		expect(built.robot.position.x).toBe(2.5);
		expect(built.robot.position.z).toBe(0.5);
	});

	it("is null when the map places no robot", () => {
		const { three } = stubThree();
		expect(buildScene(three, model({ robot: null }), {}, PALETTE).robot).toBeNull();
	});
});

describe("robot and dock", () => {
	it("leaves them out when the map does not place them", () => {
		const { three } = stubThree();
		const built = buildScene(three, model({ robot: null, charger: null }), {}, PALETTE);

		// Floor, walls and the lights - and nothing standing for a robot nobody located.
		expect(built.scene).toBeTruthy();
		expect(built.wallCount).toBe(2);
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
