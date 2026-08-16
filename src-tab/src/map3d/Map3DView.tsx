import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";
import { buildScene } from "./scene";
import type { BuiltScene, ScenePalette } from "./scene";
import { loadRoborockModels } from "./roborockModels";
import { provablyDifferentMap, sceneGeometryKey } from "./map3dModel";
import type { CellPoint, Map3DModel } from "./map3dModel";

/**
 * The 3D map: a canvas, a dynamically loaded three.js, and a way back to 2D when it cannot run.
 *
 * ## three.js is loaded here and nowhere else
 *
 * The two `import()` calls below are the entire reason the shipped bundle does not carry three.js.
 * Vite turns each into its own chunk, and neither is fetched until this component mounts - which
 * only happens after somebody presses the 3D button. Anyone who never does downloads nothing.
 *
 * `OrbitControls` is loaded the same way and is worth its weight: it brings pinch, two-finger pan
 * and inertia, which is what makes the view usable on the tablet the admin is often opened from.
 *
 * ## The scene is built rarely and updated often
 *
 * A map cycle hands down a new `Map3DModel` object every `liveMapInterval` seconds - three, as
 * shipped - and the live channel a new position roughly as often again. Rebuilding for either was
 * the reported "the 3D view keeps resetting": `buildScene` mints a new `PerspectiveCamera` at a
 * fixed place, so the angle the user had just dragged to was discarded a second or two later.
 *
 * So there are four effects, in the order they must run:
 *
 * | Effect | Runs when | Costs |
 * | --- | --- | --- |
 * | start-up | {@link sceneGeometryKey} or the palette changes | the whole scene |
 * | floor texture | the map picture changes | one texture |
 * | map bodies | the map moves the robot or the dock | two assignments |
 * | live position | the live channel reports | two assignments |
 *
 * The camera survives a rebuild unless the map itself changed; see {@link provablyDifferentMap}.
 *
 * ## Three ways this can fail, and all three end in the 2D view
 *
 * WebGL missing (asked before mounting, see `webgl.ts`), the chunk failing to load (offline, or a
 * proxy that mangles it), and the renderer throwing while starting. The last two are caught here
 * and reported through {@link Map3DViewProps.onUnavailable}, so the shell can switch back rather
 * than leave a black rectangle - which is what a dead canvas looks like, and it looks like a broken
 * adapter.
 */

interface Map3DViewProps {
	model: Map3DModel;
	palette: ScenePalette;
	/**
	 * Where the robot is right now, in cell coordinates, or null while the live channel is quiet.
	 *
	 * Deliberately not part of the model: it arrives every second or two, and it moves an existing
	 * body rather than producing a new scene. See {@link BuiltScene.robot}.
	 */
	livePosition: CellPoint | null;
	/** Called when the view cannot run after all; the shell then returns to 2D. */
	onUnavailable: (reason: string) => void;
}

/** Where the user had put the camera, and which map that was. */
interface CameraMemory {
	mapFlag: number | null;
	position: { x: number; y: number; z: number };
	target: { x: number; y: number; z: number };
}

/**
 * Decodes a map picture into something three.js can put on the floor.
 *
 * Decoded before it is handed over, because a texture built from an image that has not loaded yet
 * paints the floor black for the first frames.
 *
 * ## Why the anisotropy matters here more than anywhere else
 *
 * The floor is the one surface in this scene that is **always** seen at a shallow angle - the
 * camera is tilted about 50 degrees onto it and the far half of the map runs away towards the
 * horizon. That is the exact case in which a texel's footprint on screen is long and thin, the
 * sampler falls back to a coarser mip level, and one-pixel-wide detail is averaged out of
 * existence. The map picture's thinnest feature is the line the robot drove.
 *
 * Anisotropic sampling is what that setting exists for, and it costs nothing to ask for: the value
 * is the hardware's own maximum, so a device that offers none gets 1 and behaves as before.
 *
 * **Stated as a mechanism, not as a measurement.** Everything else in this round was measured, and
 * this could not be: there is no GPU in the test run, so the loss it addresses cannot be
 * reproduced here. What *was* measured is that the line is thin enough for it to matter - see
 * `PATH_WIDTH_FACTORS`.
 *
 * @param three The loaded three.js namespace.
 * @param imageSrc The picture as a data URI.
 * @param anisotropy Maximum the renderer supports; 1 where it is not known yet.
 * @returns The texture, ready to use.
 */
async function makeTexture(three: any, imageSrc: string, anisotropy: number): Promise<any> {
	const image = new Image();
	image.src = imageSrc;
	await image.decode().catch(() => undefined);
	const texture = new three.Texture(image);
	texture.colorSpace = three.SRGBColorSpace;
	texture.anisotropy = anisotropy;
	texture.needsUpdate = true;
	return texture;
}

export function Map3DView({ model, palette, livePosition, onUnavailable }: Map3DViewProps): React.JSX.Element {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const builtRef = useRef<BuiltScene | null>(null);
	/** The loaded three.js namespace, so the light effects can make a texture without importing. */
	const threeRef = useRef<any>(null);
	/** The texture currently on the floor. Whoever replaces it disposes the one it replaced. */
	const textureRef = useRef<any>(null);
	/** Largest anisotropy the renderer supports; see {@link makeTexture}. */
	const anisotropyRef = useRef<number>(1);
	/** The newest model, read by the start-up effect at the moment it runs. */
	const modelRef = useRef<Map3DModel>(model);
	const cameraMemoryRef = useRef<CameraMemory | null>(null);
	const [loading, setLoading] = useState(true);
	/**
	 * Bumped whenever a scene has finished starting.
	 *
	 * The three light effects below cannot do anything before there is a scene, and the start-up is
	 * asynchronous, so they would silently skip the first update after every build. Depending on this
	 * makes them run once more the moment the scene is live.
	 */
	const [sceneEpoch, setSceneEpoch] = useState(0);

	/**
	 * What a rebuild is actually needed for. Everything else about the model is applied to the
	 * standing scene by the effects further down.
	 */
	const geometryKey = useMemo(() => sceneGeometryKey(model), [model]);

	// Declared before the start-up effect so that effect reads the model of the render it belongs
	// to. React runs a component's effects in declaration order within one commit.
	useEffect(() => {
		modelRef.current = model;
	});

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		// Everything the teardown has to undo, filled as the start-up gets further. A start that
		// fails halfway therefore cleans up exactly as much as it managed to build.
		let cancelled = false;
		let renderer: any = null;
		let controls: any = null;
		let built: BuiltScene | null = null;
		let frame = 0;
		let observer: ResizeObserver | null = null;
		// The map this build belongs to, remembered for the teardown: by then the props may already
		// describe the next one, and the camera has to be filed under the map it was aimed at.
		let builtMapFlag: number | null = null;

		const start = async (): Promise<void> => {
			let three: any;
			let OrbitControls: any;
			try {
				[three, { OrbitControls }] = await Promise.all([
					import("three"),
					import("three/examples/jsm/controls/OrbitControls.js")
				]);
			} catch (error: unknown) {
				if (!cancelled) onUnavailable(error instanceof Error ? error.message : String(error));
				return;
			}
			if (cancelled) return;

			try {
				// The newest model, not the one of the render that scheduled this effect: a build that
				// starts late should draw what is current.
				const current = modelRef.current;
				builtMapFlag = current.mapFlag;

				// Built before the texture, and only for that reason: the texture wants the largest
				// anisotropy this hardware offers, and only a renderer can say what that is.
				//
				// Transparent rather than filled: the canvas sits on the panel the tab already
				// painted, so letting that show through is right in either theme and stays right
				// when the admin switches one. Painting a background here meant carrying the
				// theme's colour into WebGL, and a colour space conversion on the way made it come
				// out near-black in the light theme - a canvas that has no background of its own
				// cannot get that wrong.
				renderer = new three.WebGLRenderer({ antialias: true, alpha: true });
				renderer.setClearColor(0x000000, 0);
				renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
				host.appendChild(renderer.domElement);
				renderer.domElement.style.width = "100%";
				renderer.domElement.style.height = "100%";
				renderer.domElement.style.display = "block";

				anisotropyRef.current = Math.max(1, Number(renderer.capabilities?.getMaxAnisotropy?.()) || 1);

				const texture = await makeTexture(three, current.imageSrc, anisotropyRef.current);
				if (cancelled) {
					texture.dispose?.();
					return;
				}

				// Roborock's own furniture models, in a chunk of their own. Awaited rather than
				// applied later so the first frame already shows the furniture the way every later
				// frame will - a piece that turns from a box into a sofa a second after the view
				// opens looks like a fault. A failed load returns null and the view draws its own
				// shapes, which is what it did before the models existed.
				const furnitureModels = await loadRoborockModels();
				if (cancelled) {
					texture.dispose?.();
					return;
				}

				built = buildScene(three, current, texture, palette, furnitureModels);
				builtRef.current = built;
				threeRef.current = three;
				textureRef.current = texture;

				controls = new OrbitControls(built.camera, renderer.domElement);
				controls.enableDamping = true;
				controls.target.set(built.centre.x, 0, built.centre.z);
				// Never below the floor: from underneath the map is an unlit back face and the view
				// looks broken rather than rotated.
				controls.maxPolarAngle = Math.PI / 2 - 0.05;

				// Back to where the user had turned it, unless this is a different map - a stored
				// map of another floor has nothing in common with the angle chosen for the last one.
				const memory = cameraMemoryRef.current;
				if (memory && !provablyDifferentMap(memory.mapFlag, builtMapFlag)) {
					built.camera.position.set(memory.position.x, memory.position.y, memory.position.z);
					controls.target.set(memory.target.x, memory.target.y, memory.target.z);
				} else {
					cameraMemoryRef.current = null;
				}
				controls.update();

				const resize = (): void => {
					if (!renderer || !built) return;
					const width = host.clientWidth || 1;
					const height = host.clientHeight || 1;
					renderer.setSize(width, height, false);
					built.camera.aspect = width / height;
					built.camera.updateProjectionMatrix();
				};
				resize();
				observer = new ResizeObserver(resize);
				observer.observe(host);

				const tick = (): void => {
					frame = requestAnimationFrame(tick);
					controls?.update();
					if (renderer && built) renderer.render(built.scene, built.camera);
				};
				tick();

				if (!cancelled) {
					setLoading(false);
					setSceneEpoch(epoch => epoch + 1);
				}
			} catch (error: unknown) {
				if (!cancelled) onUnavailable(error instanceof Error ? error.message : String(error));
			}
		};

		void start();

		return () => {
			cancelled = true;
			// Where the user was looking, so the next build can put them back. Read before anything
			// is disposed; a scene that never got that far simply leaves the previous memory alone.
			if (built && controls) {
				cameraMemoryRef.current = {
					mapFlag: builtMapFlag,
					position: { x: built.camera.position.x, y: built.camera.position.y, z: built.camera.position.z },
					target: { x: controls.target.x, y: controls.target.y, z: controls.target.z }
				};
			}
			builtRef.current = null;
			threeRef.current = null;
			if (frame) cancelAnimationFrame(frame);
			observer?.disconnect();
			controls?.dispose?.();
			// Geometries, materials and textures hold GPU memory that garbage collection does not
			// reach. Switching between 2D and 3D a few dozen times would otherwise grow without end.
			for (const item of built?.disposables ?? []) item.dispose?.();
			textureRef.current?.dispose?.();
			textureRef.current = null;
			renderer?.dispose?.();
			if (renderer?.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
		};
	}, [geometryKey, palette, onUnavailable]);

	/**
	 * Puts the new map picture on the floor.
	 *
	 * This is what a map cycle usually amounts to: the geometry is the same flat it was three
	 * seconds ago, but the path and the mopped band have grown. One texture instead of a whole
	 * scene, and the camera is not touched at all.
	 *
	 * Nothing happens while the scene is still starting - that build reads the newest picture
	 * itself, and `sceneEpoch` brings this effect back the moment it is live.
	 */
	useEffect(() => {
		const three = threeRef.current;
		const built = builtRef.current;
		if (!three || !built) return;
		if (textureRef.current?.image?.src === model.imageSrc) return;

		let cancelled = false;
		void (async () => {
			const texture = await makeTexture(three, model.imageSrc, anisotropyRef.current);
			// A rebuild that started meanwhile owns the floor now; this texture belongs to a scene
			// that no longer exists and would otherwise leak.
			if (cancelled || builtRef.current !== built) {
				texture.dispose?.();
				return;
			}
			const previous = textureRef.current;
			textureRef.current = texture;
			built.setFloorTexture(texture);
			previous?.dispose?.();
		})();

		return () => {
			cancelled = true;
		};
	}, [model.imageSrc, sceneEpoch]);

	/**
	 * Moves the bodies the map places: the robot where the live channel is quiet, and the dock.
	 *
	 * The live channel wins for the robot, and by a lot - the map's idea of where the robot is can be
	 * seconds old, so applying it over a live position would drag the body backwards once per cycle.
	 */
	useEffect(() => {
		const built = builtRef.current;
		if (!built) return;
		if (built.robot && !livePosition && model.robot) {
			built.robot.position.x = model.robot.x;
			built.robot.position.z = model.robot.y;
		}
		if (built.charger && model.charger) {
			built.charger.position.x = model.charger.x;
			built.charger.position.z = model.charger.y;
		}
	}, [model.robot, model.charger, livePosition, sceneEpoch]);

	/**
	 * Moves the robot body when the live channel reports a new position.
	 *
	 * Nothing is rebuilt and nothing is re-rendered on purpose: the animation loop is already running
	 * for the orbit damping, so it picks the new position up on its next frame. That also means the
	 * body slides with the camera rather than jumping in a frame of its own.
	 *
	 * Without a live position the body stays where the map put it. That is the honest state - the map
	 * is where the robot was when the map was made - and it is what the 2D view does too.
	 */
	useEffect(() => {
		const robot = builtRef.current?.robot;
		if (!robot || !livePosition) return;
		robot.position.x = livePosition.x;
		robot.position.z = livePosition.y;
	}, [livePosition, sceneEpoch]);

	return (
		<Box sx={{ position: "absolute", inset: 0, overflow: "hidden" }}>
			<Box
				ref={hostRef}
				sx={{ position: "absolute", inset: 0 }}
			/>
			{loading ? (
				<Box
					sx={{
						position: "absolute",
						inset: 0,
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						gap: 1.5,
						pointerEvents: "none"
					}}
				>
					<CircularProgress size={28} />
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{I18n.t("ui_map3d_loading")}
					</Typography>
				</Box>
			) : null}
		</Box>
	);
}
