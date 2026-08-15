import React, { useEffect, useRef, useState } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";
import { buildScene } from "./scene";
import type { BuiltScene, ScenePalette } from "./scene";
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
	 * Deliberately not part of the model: it arrives every second or two, and the model rebuilds the
	 * whole scene. See {@link BuiltScene.robot}.
	 */
	livePosition: CellPoint | null;
	/** Called when the view cannot run after all; the shell then returns to 2D. */
	onUnavailable: (reason: string) => void;
}

export function Map3DView({ model, palette, livePosition, onUnavailable }: Map3DViewProps): React.JSX.Element {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const builtRef = useRef<BuiltScene | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		// Everything the teardown has to undo, filled as the start-up gets further. A start that
		// fails halfway therefore cleans up exactly as much as it managed to build.
		let cancelled = false;
		let renderer: any = null;
		let controls: any = null;
		let built: BuiltScene | null = null;
		let texture: any = null;
		let frame = 0;
		let observer: ResizeObserver | null = null;

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
				// The map picture, decoded before the scene is built: a texture from an image that has
				// not loaded yet paints the floor black on the first frames.
				const image = new Image();
				image.src = model.imageSrc;
				await image.decode().catch(() => undefined);
				if (cancelled) return;

				texture = new three.Texture(image);
				texture.colorSpace = three.SRGBColorSpace;
				texture.needsUpdate = true;

				built = buildScene(three, model, texture, palette);
				builtRef.current = built;

				renderer = new three.WebGLRenderer({ antialias: true, alpha: false });
				renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
				host.appendChild(renderer.domElement);
				renderer.domElement.style.width = "100%";
				renderer.domElement.style.height = "100%";
				renderer.domElement.style.display = "block";

				controls = new OrbitControls(built.camera, renderer.domElement);
				controls.enableDamping = true;
				controls.target.set(built.centre.x, 0, built.centre.z);
				// Never below the floor: from underneath the map is an unlit back face and the view
				// looks broken rather than rotated.
				controls.maxPolarAngle = Math.PI / 2 - 0.05;
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

				if (!cancelled) setLoading(false);
			} catch (error: unknown) {
				if (!cancelled) onUnavailable(error instanceof Error ? error.message : String(error));
			}
		};

		void start();

		return () => {
			cancelled = true;
			builtRef.current = null;
			if (frame) cancelAnimationFrame(frame);
			observer?.disconnect();
			controls?.dispose?.();
			// Geometries, materials and textures hold GPU memory that garbage collection does not
			// reach. Switching between 2D and 3D a few dozen times would otherwise grow without end.
			for (const item of built?.disposables ?? []) item.dispose?.();
			texture?.dispose?.();
			renderer?.dispose?.();
			if (renderer?.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
		};
	}, [model, palette, onUnavailable]);

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
	}, [livePosition, model]);

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
