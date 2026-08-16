/**
 * Keeps the 3D model in step with the map states.
 *
 * Three of them, and none of them fetched for this view: `map.mapBase64Surface`,
 * `map.mapBase64Clean` and `map.mapData`, the latter two being what the 2D view subscribes to
 * anyway (`engine/MapEngine.ts:1267-1268`). Reading them a second time costs nothing: ioBroker
 * delivers a state change to every subscriber, and no request reaches the robot either way.
 *
 * ## Why two pictures rather than one
 *
 * The floor is textured with a map picture while the robot, the dock, the zones and the walls are
 * bodies standing on it. `mapBase64Clean` is the bare room colour - it has no path, no mopped band,
 * no room names and no detected objects, which is the whole of issue #78. `mapBase64` has all of
 * that but carries a flat painted copy of every body as well, which would sit under the body
 * itself. `mapBase64Surface` is the adapter's answer: everything that lies **on** the floor,
 * nothing that stands **in** the room (`src/lib/map/v1/CanvasMapRenderer.ts`).
 *
 * It is preferred where it exists and simply absent otherwise - on a B01/Q10 robot, which has no V1
 * drawing pipeline, and on an adapter older than the state. The clean picture is then used exactly
 * as before, so the view loses the markings again but never breaks.
 *
 * Its own source rather than a branch inside the engine, for the same reason the active-floor
 * marker got one: the engine owns what is drawn in 2D, and this owns a second picture of the same
 * data. Neither has to know about the other.
 */

import { buildMap3DModel, robotMmToCell } from "./map3dModel";
import type { CellPoint, Map3DModel } from "./map3dModel";
import { LIVE_TRACK_STATE, parseLiveSnapshot } from "../engine/liveTrack";
import type { EngineConnection } from "../engine/types";

interface Map3DSourceHost {
	/** The model, or null while there is nothing drawable. */
	onModel: (model: Map3DModel | null) => void;
	/**
	 * Where the robot is right now, in the model's own cell coordinates, or null.
	 *
	 * Separate from the model on purpose: the view moves the existing body instead of taking a new
	 * model for it.
	 *
	 * The two cadences are closer together than this comment used to claim. `io-package.json` ships
	 * `liveMapInterval: 3` and `liveTrackInterval: 1500`, so while the robot works a map arrives
	 * every three seconds and a position every one and a half. Separating them is therefore not
	 * enough on its own - the view has to decide what a **new map** is worth rebuilding for too, and
	 * it does; see `sceneGeometryKey` in `map3dModel.ts`.
	 */
	onLiveRobot: (position: CellPoint | null) => void;
}

export class Map3DSource {
	private subscriptions: Array<{ id: string; handler: (id: string, state: { val?: unknown } | null) => void }> = [];
	private destroyed = false;
	private rawMapData: unknown = null;
	/** `map.mapBase64Surface`, the picture this view wants, or null where the adapter has none. */
	private surfaceSrc: unknown = null;
	/** `map.mapBase64Clean`, the fallback. */
	private cleanSrc: unknown = null;
	private liveRaw: unknown = null;
	/** Last published model, kept only for the grid the live position has to be converted against. */
	private model: Map3DModel | null = null;
	/**
	 * What the last published model was built from.
	 *
	 * Three states can trigger a rebuild and two of them carry a picture, so a single map cycle would
	 * otherwise rebuild the whole scene three times - every wall run, every piece of furniture - for
	 * two identical results. Only the picture actually used counts here: while a surface picture is
	 * being published, a new clean one changes nothing this view draws.
	 */
	private published: { texture: unknown; data: unknown } | null = null;

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: Map3DSourceHost
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 *
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device whose map to read; an empty value clears the model.
	 */
	public async setDevice(instanceId: string, duid: string): Promise<void> {
		if (this.destroyed) return;

		this.unsubscribe();
		this.rawMapData = null;
		this.surfaceSrc = null;
		this.cleanSrc = null;
		this.liveRaw = null;
		this.model = null;
		this.published = null;
		this.host.onModel(null);
		this.host.onLiveRobot(null);
		if (!duid) return;

		const deviceRoot = `${instanceId}.Devices.${duid}`;
		const root = `${deviceRoot}.map`;
		const surfaceId = `${root}.mapBase64Surface`;
		const cleanId = `${root}.mapBase64Clean`;
		const dataId = `${root}.mapData`;
		const liveId = `${deviceRoot}.${LIVE_TRACK_STATE}`;

		try {
			const states = await this.connection.getStates([surfaceId, cleanId, dataId, liveId]);
			this.surfaceSrc = states?.[surfaceId]?.val ?? null;
			this.cleanSrc = states?.[cleanId]?.val ?? null;
			this.rawMapData = states?.[dataId]?.val ?? null;
			this.liveRaw = states?.[liveId]?.val ?? null;
			this.publish();
		} catch {
			// A robot without a map answers with nothing. That is "no 3D view", not an error worth
			// putting in front of the user - the 2D view says the same thing in the same situation.
			this.host.onModel(null);
		}

		if (this.destroyed) return;

		const wanted: Array<{ id: string; handler: (id: string, state: { val?: unknown } | null) => void }> = [
			{ id: surfaceId, handler: this.onSurface },
			{ id: cleanId, handler: this.onClean },
			{ id: dataId, handler: this.onData },
			{ id: liveId, handler: this.onLive }
		];
		try {
			for (const entry of wanted) {
				await this.connection.subscribeState(entry.id, entry.handler);
				this.subscriptions.push(entry);
			}
		} catch {
			// Without the subscriptions the view simply does not follow later map updates. Whatever
			// was subscribed before the failure is remembered, so it is still unsubscribed later.
		}
	}

	/** Drops the subscriptions and clears the model. */
	public destroy(): void {
		this.destroyed = true;
		this.unsubscribe();
	}

	private readonly onSurface = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.surfaceSrc = state?.val ?? null;
		this.publish();
	};

	private readonly onClean = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.cleanSrc = state?.val ?? null;
		this.publish();
	};

	private readonly onData = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.rawMapData = state?.val ?? null;
		this.publish();
	};

	private readonly onLive = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.liveRaw = state?.val ?? null;
		this.publishLive();
	};

	/**
	 * Turns the live snapshot into cell coordinates and hands it on.
	 *
	 * The conversion needs the grid the model was built on, so nothing is reported until there is a
	 * model - a position without a map has nowhere to be drawn. It goes through the same
	 * `robotMmToCell` the map's own robot uses; a second conversion here is how the live body and the
	 * map body would end up in different rooms.
	 */
	private publishLive(): void {
		const model = this.model;
		if (!model) {
			this.host.onLiveRobot(null);
			return;
		}
		const snapshot = parseLiveSnapshot(this.liveRaw);
		const position = snapshot?.position;
		if (!position) {
			this.host.onLiveRobot(null);
			return;
		}
		this.host.onLiveRobot(robotMmToCell({ x: position.x, y: position.y }, model.left, model.top, model.height));
	}

	/**
	 * The picture to texture the floor with: the surface where the adapter publishes one, the clean
	 * map otherwise.
	 *
	 * A non-string or an empty value counts as absent, so a state that exists but has never been
	 * written does not push the fallback out of the way.
	 */
	private textureSource(): unknown {
		return typeof this.surfaceSrc === "string" && this.surfaceSrc ? this.surfaceSrc : this.cleanSrc;
	}

	/**
	 * Rebuilds the model from whatever is currently held.
	 *
	 * The states arrive separately and in no fixed order, so this runs on each of them and
	 * `buildMap3DModel` returns null until a picture and a grid are both there. A view built from one
	 * of the two would be a floor without a picture or a picture without a grid.
	 */
	private publish(): void {
		const texture = this.textureSource();
		if (this.published && this.published.texture === texture && this.published.data === this.rawMapData) return;
		this.published = { texture, data: this.rawMapData };
		this.model = buildMap3DModel(this.rawMapData, texture);
		this.host.onModel(this.model);
		// A new map moves the grid under the live position; re-reporting keeps the body where the
		// robot actually is instead of where the previous grid put it.
		this.publishLive();
	}

	private unsubscribe(): void {
		const subscriptions = this.subscriptions;
		this.subscriptions = [];
		for (const entry of subscriptions) {
			try {
				this.connection.unsubscribeState(entry.id, entry.handler);
			} catch {
				// Unsubscribing from a state that is already gone is not a failure worth reporting.
			}
		}
	}
}
