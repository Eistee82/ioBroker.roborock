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

import { WALL_HEIGHT_CELLS } from "./units";
import type { Map3DModel } from "./map3dModel";
import { VIRTUAL_WALL_THICKNESS, ZONE_FLOOR_HEIGHT, ZONE_HEIGHT, ZONE_WALL_THICKNESS } from "./zones3d";
import type { RoborockModel } from "./roborockModels";

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
	/** For Roborock's own furniture models, which arrive as flat buffers. */
	BufferGeometry: new () => any;
	BufferAttribute: new (array: ArrayLike<number>, itemSize: number) => any;
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
	/** Furniture of a known type. */
	furniture: string;
	/** Furniture of a type this build does not know - see {@link Map3DModel.furniture}. */
	furnitureUnknown: string;
	/** No-go zones; the 2D view's own `noGoStroke`. */
	forbiddenZone: string;
	/** No-mop zones; the 2D view's own `noMopStroke`. */
	noMopZone: string;
	/** Virtual walls; the 2D view's own `wallStroke`. */
	virtualWall: string;
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
	/**
	 * The robot body, or null when the map does not place one.
	 *
	 * Handed back so the live channel can move it without rebuilding the scene. The live tick is
	 * seconds apart and the map tick, at the shipped `liveMapInterval: 3`, is barely slower;
	 * rebuilding 299 wall boxes, the floor texture and every piece of furniture at either rate is
	 * visible as a stutter and throws away the user's camera position on top.
	 */
	robot: any | null;
	/** The dock body, or null when the map does not place one. Moved rather than rebuilt, as above. */
	charger: any | null;
	/**
	 * Puts a new map picture on the floor.
	 *
	 * The picture changes on every map cycle even when nothing about the geometry does - the cleaned
	 * path and the mopped band are painted into it - so this is the whole of what such a cycle costs.
	 * The old texture is **not** disposed here: whoever created it owns it, and the view disposes it
	 * once the swap has happened.
	 */
	setFloorTexture: (texture: any) => void;
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
 * **`depthWrite` is off**, which is where this departs from libGDX. The app leaves it on, and can:
 * its 3D scene has no no-go zones in it. Here a wall that writes depth hides every transparent
 * thing behind it - a zone, a virtual wall - while still showing the opaque furniture, because
 * opaque geometry is drawn in an earlier pass than transparent geometry. The result reads as a
 * wall that is see-through for some things and not for others, which is worse than no transparency
 * at all.
 */
const WALL_OPACITY = 0.5;
const WALL_CAP_OPACITY = 0.7;

/** Thickness of the cap, and where it sits. The app puts its plate at 10.15 (`C4192OooO0oo.java:185`). */
const WALL_CAP_THICKNESS = 0.3;

/**
 * How solid a zone is.
 *
 * The colours come from the tab's own overlay table, which already carries the app's `66` alpha in
 * the hex string - but a three.js material takes the alpha as a separate number, and a `#RRGGBBAA`
 * string would have its last two digits quietly dropped. So the alpha is set here, at the value the
 * app writes: `0x66 / 255`.
 */
const ZONE_OPACITY = 0x66 / 255;

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
export function buildScene(
	three: ThreeLike,
	model: Map3DModel,
	texture: any,
	palette: ScenePalette,
	models?: Record<string, RoborockModel> | null
): BuiltScene {
	const scene = new three.Scene();
	// The scene paints the ground itself, in the map's own colour rather than the admin page's -
	// see `scenePalette` in `MapView`, where taking the wrong one of the two turned the area
	// around the rooms black in the dark theme.
	//
	// Painted here **and** left transparent at the renderer: a canvas asked for an alpha buffer
	// does not always get one, and a clear colour of transparent black then arrives as plain
	// black. With the scene carrying the colour, the picture is right either way.
	scene.background = new three.Color(palette.background);

	const disposables: Array<{ dispose: () => void }> = [];
	const centre = { x: model.width / 2, z: model.height / 2 };

	// --- The floor: the 2D map, laid flat -------------------------------------------------------
	//
	// Exactly what the app does (§0: "Der 3D-Boden ist eine texturierte Ebene mit dem 2D-Kartenbild
	// darauf"). It also means the floor shows rooms, their colours and their names without this
	// module knowing anything about rooms.
	const floorGeometry = new three.PlaneGeometry(model.width, model.height);
	// The map picture is a PNG with an alpha channel: the rooms are painted and **everything around
	// them is fully transparent**, because a flat is not a rectangle and a picture is. Something has
	// to act on that channel or every transparent pixel is drawn as opaque black - a black quad the
	// size of the whole grid with the flat in the middle of it.
	//
	// **`alphaTest` alone, and deliberately not `transparent`.** The two look interchangeable and
	// are not. `transparent: true` moves a material into the transparency queue, which is drawn
	// after everything opaque and sorted back to front - and the floor then loses to every
	// half-transparent wall standing on it, because a wall drawn earlier has already written its
	// depth. That is exactly what happened when this was first fixed with `transparent: true`: the
	// black slab went away and the floor started vanishing behind walls instead.
	//
	// With `alphaTest` and no `transparent`, the material stays **opaque**: it is drawn in the
	// first pass, its see-through pixels are discarded outright rather than blended, and nothing
	// about the draw order can hide it. The threshold is high enough to cut the picture's
	// anti-aliased edges cleanly.
	const floorMaterial = new three.MeshBasicMaterial({
		map: texture,
		side: three.DoubleSide,
		alphaTest: 0.5
	});
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
		opacity: WALL_OPACITY,
		// A see-through wall must not write depth. It did, and the result was a wall you could see
		// the furniture through but not the no-go zone behind it: the furniture is opaque and is
		// drawn *before* the wall, while a zone is transparent and is drawn after - by which time
		// the wall has already claimed those pixels in the depth buffer and the zone is discarded
		// without ever being blended.
		//
		// This is where the view departs from the app, and knowingly. libGDX leaves depth writing on
		// here, but the app also has no no-go zones standing in its 3D scene, so the case never
		// arises there. What is drawn behind glass has to be visible through it, or the glass is
		// just an opaque wall that happens to be pale.
		depthWrite: false
	});
	const capGeometry = new three.BoxGeometry(1, WALL_CAP_THICKNESS, 1);
	const capMaterial = new three.MeshStandardMaterial({
		color: palette.wall,
		roughness: 0.9,
		metalness: 0,
		transparent: true,
		opacity: WALL_CAP_OPACITY,
		depthWrite: false
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

	// --- Furniture ------------------------------------------------------------------------------
	//
	// One box per piece, sized and turned by the map itself; only the height is chosen - see
	// {@link FURNITURE_HEIGHTS_MM}. Solid rather than translucent, because a piece of furniture is
	// a thing standing in the room and not a boundary, and because a see-through sofa in front of a
	// see-through wall stops being readable.
	//
	// A separate mesh each: there are a handful of pieces, not thousands, and each needs its own
	// size and rotation. Instancing would buy nothing here and cost the per-piece material.
	for (const piece of model.furniture) {
		const material = new three.MeshStandardMaterial({
			color: piece.known ? palette.furniture : palette.furnitureUnknown,
			roughness: 0.75,
			metalness: 0,
			// A stand-in body says so by being faint. It must still be visible - a piece the robot
			// reports is a piece the user can trip over, so it may not be left out.
			transparent: !piece.known,
			opacity: piece.known ? 1 : 0.55
		});
		disposables.push(material);

		// One material for every part of a piece, and one rotation for the whole piece: the parts
		// are placed in the piece's own frame and turned with it, so a headboard stays at the head
		// of the bed whichever way the bed is turned. Rotating each part on its own would need the
		// offsets rotated too, which is where a sign gets lost.
		const group = new three.Group();
		group.position.set(piece.x, 0, piece.z);
		// The map's angle turns clockwise in a y-down picture; three.js turns counter-clockwise about
		// +Y. Picture x maps to world x and picture y to world z, so the two conventions differ by a
		// sign and by nothing else.
		group.rotation.y = (-piece.angle * Math.PI) / 180;

		// Roborock's own model where there is one. It is scaled onto the footprint the robot
		// measured rather than drawn at its own size: the footprint is the one measurement in this
		// scene, and a model at its native size would sit beside the outline instead of in it.
		// Height follows the mean of the two ground scales, so a piece is never stretched upwards
		// by a footprint that happens to be narrow.
		const own = piece.model ? models?.[piece.model] : undefined;
		if (own) {
			const geometry = new three.BufferGeometry();
			geometry.setAttribute("position", new three.BufferAttribute(own.position, 3));
			geometry.setAttribute("normal", new three.BufferAttribute(own.normal, 3));
			geometry.setIndex(new three.BufferAttribute(own.index, 1));

			const sx = own.size.x > 0 ? piece.width / own.size.x : 1;
			const sz = own.size.z > 0 ? piece.depth / own.size.z : 1;
			const sy = (sx + sz) / 2;

			const mesh = new three.Mesh(geometry, material);
			mesh.scale.set(sx, sy, sz);
			// The models are not centred on their own origin, and they sit on their own floor: the
			// centre is pulled to 0 across the ground and the bottom of the box to y = 0.
			mesh.position.set(-own.centre.x * sx, (own.size.y / 2 - own.centre.y) * sy, -own.centre.z * sz);
			group.add(mesh);
			disposables.push(geometry);
			scene.add(group);
			continue;
		}

		// No model: the shape from `furnitureShapes.ts`, or the plain block for a type that has
		// neither.
		const parts = piece.parts ?? [{ dx: 0, dz: 0, w: 1, d: 1, y0: 0, h: 1 }];
		for (const part of parts) {
			const w = piece.width * part.w;
			const d = piece.depth * part.d;
			const h = piece.height * part.h;
			// A part with no extent would be an invisible mesh with a live buffer behind it.
			if (!(w > 0) || !(d > 0) || !(h > 0)) continue;

			const geometry = part.round
				? // A cylinder takes one radius, so an oval footprint is scaled into shape below;
					// its own diameter is 1 and the mesh carries the difference.
					new three.CylinderGeometry(0.5, 0.5, 1, 24)
				: new three.BoxGeometry(1, 1, 1);
			const mesh = new three.Mesh(geometry, material);
			mesh.scale.set(w, h, d);
			mesh.position.set(piece.width * part.dx, piece.height * part.y0 + h / 2, piece.depth * part.dz);
			group.add(mesh);
			disposables.push(geometry);
		}
		scene.add(group);
	}

	// --- Zones and virtual walls ------------------------------------------------------------------
	//
	// Shapes taken from the native renderer, see {@link buildZones3D}: a zone is a floor patch plus
	// four sides and **no lid**, a virtual wall is a thin slab. Both stand as tall as the map walls,
	// which is what makes a zone read as a barrier rather than as a rug.
	//
	// Look only. The handles, the dragging and the confirmation path all live in the 2D editor; a
	// second way to move a no-go zone is a second way to get it wrong.
	for (const zone of model.zones) {
		const colour = zone.kind === "forbidden" ? palette.forbiddenZone : palette.noMopZone;
		const material = new three.MeshStandardMaterial({
			color: colour,
			roughness: 0.9,
			metalness: 0,
			transparent: true,
			opacity: ZONE_OPACITY,
			side: three.DoubleSide
		});
		disposables.push(material);

		const group = new three.Group();
		group.position.set(zone.x, 0, zone.z);
		group.rotation.y = (-zone.angle * Math.PI) / 180;

		// The floor patch, at the app's own 0.1 above the ground so it does not fight the map texture
		// for the same depth value.
		const floorGeometry = new three.BoxGeometry(zone.width, ZONE_FLOOR_HEIGHT, zone.depth);
		const floorMesh = new three.Mesh(floorGeometry, material);
		floorMesh.position.set(0, 0.1, 0);
		group.add(floorMesh);
		disposables.push(floorGeometry);

		// Four sides. The app draws faces without thickness; a face has no volume in three.js either,
		// but a slab reads better at a grazing angle and costs nothing.
		const sides: Array<[number, number, number, number, number]> = [
			[zone.width, ZONE_WALL_THICKNESS, 0, (zone.depth - ZONE_WALL_THICKNESS) / 2, 0],
			[zone.width, ZONE_WALL_THICKNESS, 0, -(zone.depth - ZONE_WALL_THICKNESS) / 2, 0],
			[ZONE_WALL_THICKNESS, zone.depth, (zone.width - ZONE_WALL_THICKNESS) / 2, 0, 0],
			[ZONE_WALL_THICKNESS, zone.depth, -(zone.width - ZONE_WALL_THICKNESS) / 2, 0, 0]
		];
		for (const [sideWidth, sideDepth, offsetX, offsetZ] of sides) {
			const geometry = new three.BoxGeometry(sideWidth, ZONE_HEIGHT, sideDepth);
			const mesh = new three.Mesh(geometry, material);
			mesh.position.set(offsetX, ZONE_HEIGHT / 2, offsetZ);
			group.add(mesh);
			disposables.push(geometry);
		}
		scene.add(group);
	}

	for (const wall of model.virtualWalls) {
		const geometry = new three.BoxGeometry(wall.length, ZONE_HEIGHT, VIRTUAL_WALL_THICKNESS);
		const material = new three.MeshStandardMaterial({
			color: palette.virtualWall,
			roughness: 0.9,
			metalness: 0,
			transparent: true,
			opacity: ZONE_OPACITY
		});
		const mesh = new three.Mesh(geometry, material);
		mesh.position.set(wall.x, ZONE_HEIGHT / 2, wall.z);
		mesh.rotation.y = (-wall.angle * Math.PI) / 180;
		scene.add(mesh);
		disposables.push(geometry, material);
	}

	// --- Robot and dock -------------------------------------------------------------------------
	//
	// Plain bodies, not models. The app's 3D robot is a `.g3db` file from the APK assets, and those
	// may not be shipped with this adapter (§3.4, §8.5) - the same line the project already drew at
	// the dock artwork. A cylinder for the robot and a low box for the dock say where each one is,
	// which is the whole job here.
	let robot: any = null;
	if (model.robot) {
		const geometry = new three.CylinderGeometry(3.5, 3.5, 3, 24);
		const material = new three.MeshStandardMaterial({ color: palette.robot, roughness: 0.5, metalness: 0.1 });
		robot = new three.Mesh(geometry, material);
		robot.position.set(model.robot.x, 1.5, model.robot.y);
		scene.add(robot);
		disposables.push(geometry, material);
	}

	let charger: any = null;
	if (model.charger) {
		const geometry = new three.BoxGeometry(5, 2, 4);
		const material = new three.MeshStandardMaterial({ color: palette.charger, roughness: 0.7, metalness: 0 });
		charger = new three.Mesh(geometry, material);
		charger.position.set(model.charger.x, 1, model.charger.y);
		scene.add(charger);
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

	return {
		scene,
		camera,
		disposables,
		centre,
		wallCount: model.walls.length,
		robot,
		charger,
		setFloorTexture: (next: any): void => {
			floorMaterial.map = next;
			// The material's shader program depends on whether it has a map at all, so three.js has
			// to be told; without this the floor keeps drawing the picture it started with.
			floorMaterial.needsUpdate = true;
		}
	};
}
