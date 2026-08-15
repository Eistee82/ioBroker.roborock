/**
 * Builds the 3D scene out of a {@link Map3DModel}.
 *
 * ## Why three.js is a parameter and not an import
 *
 * The module never writes `import * as THREE from "three"`. It takes the namespace as an argument,
 * and the component hands it over after loading it with `import()`. Two things follow, and both
 * were requirements rather than preferences:
 *
 * - **The shipped bundle does not grow.** `admin/assets/` is tracked and installed with the
 *   adapter; three.js is several hundred kilobytes. With the import inside a dynamic chunk, a user
 *   who never presses the 3D button downloads none of it.
 * - **This file can be tested without a GPU.** Every call goes through the passed namespace, so a
 *   test hands over a small stand-in and checks what was built - how many boxes, at which
 *   positions, with which height - which is the part that can silently go wrong.
 *
 * ## The unit is one map cell
 *
 * X and Z are cell coordinates, Y is up. A cell is 50 mm, so the numbers here are the same ones the
 * 2D view works in, and the wall height of 10 is the app's own constant - see {@link Map3DModel}.
 *
 * Cell `(cx, cy)` sits at world `(cx + 0.5, ·, cy + 0.5)`: the grid names cells, and a box centred
 * on the integer would straddle four of them.
 */

import { WALL_HEIGHT_CELLS } from "./map3dModel";
import type { Map3DModel } from "./map3dModel";

/**
 * The parts of the three.js namespace this module uses.
 *
 * Written out rather than taken as `typeof import("three")` so a test can supply a stand-in without
 * building the whole library, and so the surface stays small enough to see.
 */
export interface ThreeLike {
	Scene: new () => any;
	Color: new (value: number | string) => any;
	PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => any;
	AmbientLight: new (colour: number, intensity?: number) => any;
	DirectionalLight: new (colour: number, intensity?: number) => any;
	PlaneGeometry: new (width: number, height: number) => any;
	BoxGeometry: new (width: number, height: number, depth: number) => any;
	CylinderGeometry: new (top: number, bottom: number, height: number, segments: number) => any;
	MeshStandardMaterial: new (parameters: Record<string, unknown>) => any;
	MeshBasicMaterial: new (parameters: Record<string, unknown>) => any;
	Mesh: new (geometry: any, material: any) => any;
	InstancedMesh: new (geometry: any, material: any, count: number) => any;
	Object3D: new () => any;
	Group: new () => any;
	Texture: new (image: any) => any;
	DoubleSide: number;
	SRGBColorSpace: string;
}

/** Colours of the scene, so light and dark mode can hand over their own. */
export interface ScenePalette {
	/** Behind everything. */
	background: string;
	/** The extruded cells. */
	wall: string;
	/** The robot marker. */
	robot: string;
	/** The dock marker. */
	charger: string;
}

/** What {@link buildScene} produced, so the caller can drive and dispose of it. */
export interface BuiltScene {
	scene: any;
	camera: any;
	/** Everything that holds GPU memory and has to be released on teardown. */
	disposables: Array<{ dispose: () => void }>;
	/** Centre of the map in world coordinates; where the camera looks. */
	centre: { x: number; z: number };
	/** How many wall segments were extruded. Reported so the caller can say so, and asserted in tests. */
	wallCount: number;
}

/**
 * Transparency of the walls, read out of the app rather than chosen.
 *
 * `com/roborock/smart/react/mapv2/view/C4192OooO0oo.java:107-113` builds exactly two materials for
 * the wall geometry and uses them at `:174` (the body) and `:184` (the cap):
 *
 * ```java
 * new C5472OooO0Oo(o000.OooO0O0.OooO0Oo(new com.badlogic.gdx.graphics.OooO0O0(1.0f, 1.0f, 1.0f, 0.5f)));
 * c5472OooO0Oo.OooOO0(new o000.OooO00o(true, 770, 771, 1.0f));   // blend SRC_ALPHA / ONE_MINUS_SRC_ALPHA
 * ```
 *
 * So: white at **alpha 0.5** for the sides, white at **alpha 0.7** for the top plate, both with
 * ordinary alpha blending. The alpha carries over unchanged; the colour comes from the palette
 * instead of being hard-coded white, because this view has a dark theme and the app does not.
 *
 * `depthWrite` stays at the three.js default (`true`), which is what libGDX does here too - the
 * blending attribute changes the colour maths, not the depth buffer.
 */
const WALL_OPACITY = 0.5;
const WALL_CAP_OPACITY = 0.7;

/** Thickness of the cap, and where it sits. The app puts its plate at 10.15 (`C4192OooO0oo.java:185`). */
const WALL_CAP_THICKNESS = 0.3;

/**
 * The light rig, taken from the app rather than invented.
 *
 * `_appanalysis/21-3d-kartenansicht.md` §3.5 read the values out of the native renderer: ambient
 * light at 0.68, and two directional lights at 0.34 from `(-1,-0.8,-0.8)` and `(1,-1,1)`. Those are
 * libGDX conventions - its directional light points *along* the given vector, so the direction is
 * negated here to place a three.js light. The brightness carries over unchanged.
 */
const AMBIENT = 0.68;
const DIRECTIONALS: ReadonlyArray<{ intensity: number; direction: [number, number, number] }> = [
	{ intensity: 0.34, direction: [-1, -0.8, -0.8] },
	{ intensity: 0.34, direction: [1, -1, 1] }
];

/**
 * Builds the whole scene.
 *
 * @param three The three.js namespace, loaded by the caller.
 * @param model What to draw.
 * @param texture The map picture, already loaded into something three.js accepts as a texture image.
 * @param palette Colours for the current theme.
 * @returns The scene, its camera, and everything that has to be disposed of.
 */
export function buildScene(three: ThreeLike, model: Map3DModel, texture: any, palette: ScenePalette): BuiltScene {
	const scene = new three.Scene();
	scene.background = new three.Color(palette.background);

	const disposables: Array<{ dispose: () => void }> = [];
	const centre = { x: model.width / 2, z: model.height / 2 };

	// --- The floor: the 2D map, laid flat -------------------------------------------------------
	//
	// Exactly what the app does (§0: "Der 3D-Boden ist eine texturierte Ebene mit dem 2D-Kartenbild
	// darauf"). It also means the floor shows rooms, their colours and their names without this
	// module knowing anything about rooms.
	const floorGeometry = new three.PlaneGeometry(model.width, model.height);
	const floorMaterial = new three.MeshBasicMaterial({ map: texture, side: three.DoubleSide });
	const floor = new three.Mesh(floorGeometry, floorMaterial);
	// Flat on the ground, and rotated so the picture's top edge points away from the camera rather
	// than at it - without this the map is mirrored front to back.
	floor.rotation.x = -Math.PI / 2;
	floor.position.set(centre.x, 0, centre.z);
	scene.add(floor);
	disposables.push(floorGeometry, floorMaterial);

	// --- The walls: one box per merged run, plus a cap, in two draw calls -----------------------
	//
	// One box per run, not per cell: 541 instead of 3 468 on the test device, and - the point the
	// user actually raised - the picture reads as walls around rooms instead of gravel. See
	// {@link extractWalls} for where the runs come from.
	//
	// Both layers are `InstancedMesh` with a unit box scaled per instance, so the whole wall set is
	// two draw calls and two geometries no matter how large the flat is. That was the right call for
	// 3 468 boxes on a tablet and stays the right one for 541.
	const wallGeometry = new three.BoxGeometry(1, WALL_HEIGHT_CELLS, 1);
	const wallMaterial = new three.MeshStandardMaterial({
		color: palette.wall,
		roughness: 0.9,
		metalness: 0,
		transparent: true,
		opacity: WALL_OPACITY
	});
	const capGeometry = new three.BoxGeometry(1, WALL_CAP_THICKNESS, 1);
	const capMaterial = new three.MeshStandardMaterial({
		color: palette.wall,
		roughness: 0.9,
		metalness: 0,
		transparent: true,
		opacity: WALL_CAP_OPACITY
	});
	disposables.push(wallGeometry, wallMaterial, capGeometry, capMaterial);

	if (model.walls.length > 0) {
		const walls = new three.InstancedMesh(wallGeometry, wallMaterial, model.walls.length);
		const caps = new three.InstancedMesh(capGeometry, capMaterial, model.walls.length);
		const dummy = new three.Object3D();
		for (let i = 0; i < model.walls.length; i++) {
			const segment = model.walls[i];
			// Both ends are inclusive, so a run from 4 to 7 is four cells wide, and its centre sits
			// half a cell past the last one.
			const spanX = segment.x1 - segment.x0 + 1;
			const spanZ = segment.y1 - segment.y0 + 1;
			const centreX = segment.x0 + spanX / 2;
			const centreZ = segment.y0 + spanZ / 2;

			dummy.scale.set(spanX, 1, spanZ);
			// Half the height, because a box is centred on its origin and this one stands on the floor.
			dummy.position.set(centreX, WALL_HEIGHT_CELLS / 2, centreZ);
			dummy.updateMatrix();
			walls.setMatrixAt(i, dummy.matrix);

			dummy.position.set(centreX, WALL_HEIGHT_CELLS + WALL_CAP_THICKNESS / 2, centreZ);
			dummy.updateMatrix();
			caps.setMatrixAt(i, dummy.matrix);
		}
		walls.instanceMatrix.needsUpdate = true;
		caps.instanceMatrix.needsUpdate = true;
		scene.add(walls);
		scene.add(caps);
		disposables.push(walls, caps);
	}

	// --- Robot and dock -------------------------------------------------------------------------
	//
	// Plain bodies, not models. The app's 3D robot is a `.g3db` file from the APK assets, and those
	// may not be shipped with this adapter (§3.4, §8.5) - the same line the project already drew at
	// the dock artwork. A cylinder for the robot and a low box for the dock say where each one is,
	// which is the whole job here.
	if (model.robot) {
		const geometry = new three.CylinderGeometry(3.5, 3.5, 3, 24);
		const material = new three.MeshStandardMaterial({ color: palette.robot, roughness: 0.5, metalness: 0.1 });
		const mesh = new three.Mesh(geometry, material);
		mesh.position.set(model.robot.x, 1.5, model.robot.y);
		scene.add(mesh);
		disposables.push(geometry, material);
	}

	if (model.charger) {
		const geometry = new three.BoxGeometry(5, 2, 4);
		const material = new three.MeshStandardMaterial({ color: palette.charger, roughness: 0.7, metalness: 0 });
		const mesh = new three.Mesh(geometry, material);
		mesh.position.set(model.charger.x, 1, model.charger.y);
		scene.add(mesh);
		disposables.push(geometry, material);
	}

	// --- Light ----------------------------------------------------------------------------------
	scene.add(new three.AmbientLight(0xffffff, AMBIENT));
	for (const entry of DIRECTIONALS) {
		const light = new three.DirectionalLight(0xffffff, entry.intensity);
		// libGDX gives the direction the light travels; three.js places the light and points it at
		// the origin. Negating turns one into the other.
		light.position.set(-entry.direction[0], -entry.direction[1], -entry.direction[2]);
		scene.add(light);
	}

	// --- Camera -----------------------------------------------------------------------------------
	//
	// The app's camera parameters are the one thing §3.5 could not resolve ("Nicht verfolgt"), so
	// this is chosen rather than copied, and says so: far enough out that the whole map fits, and
	// tilted about 50 degrees, which is the angle at which extruded walls read as walls.
	const camera = new three.PerspectiveCamera(50, 1, 0.1, 4000);
	const span = Math.max(model.width, model.height);
	camera.position.set(centre.x, span * 0.9, centre.z + span * 0.8);
	camera.lookAt(centre.x, 0, centre.z);

	return { scene, camera, disposables, centre, wallCount: model.walls.length };
}
