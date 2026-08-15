/**
 * Keeps the 3D model in step with the two map states.
 *
 * The same two the 2D view subscribes to - `map.mapBase64Clean` and `map.mapData`
 * (`engine/MapEngine.ts:1267-1268`). Reading them a second time costs nothing: ioBroker delivers a
 * state change to every subscriber, and no request reaches the robot either way.
 *
 * Its own source rather than a branch inside the engine, for the same reason the active-floor
 * marker got one: the engine owns what is drawn in 2D, and this owns a second picture of the same
 * data. Neither has to know about the other.
 */

import { buildMap3DModel } from "./map3dModel";
import type { Map3DModel } from "./map3dModel";
import type { EngineConnection } from "../engine/types";

interface Map3DSourceHost {
	/** The model, or null while there is nothing drawable. */
	onModel: (model: Map3DModel | null) => void;
}

export class Map3DSource {
	private ids: string[] = [];
	private destroyed = false;
	private rawMapData: unknown = null;
	private imageSrc: unknown = null;

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
		this.imageSrc = null;
		this.host.onModel(null);
		if (!duid) return;

		const root = `${instanceId}.Devices.${duid}.map`;
		const imageId = `${root}.mapBase64Clean`;
		const dataId = `${root}.mapData`;

		try {
			const states = await this.connection.getStates([imageId, dataId]);
			this.imageSrc = states?.[imageId]?.val ?? null;
			this.rawMapData = states?.[dataId]?.val ?? null;
			this.publish();
		} catch {
			// A robot without a map answers with nothing. That is "no 3D view", not an error worth
			// putting in front of the user - the 2D view says the same thing in the same situation.
			this.host.onModel(null);
		}

		if (this.destroyed) return;

		try {
			await this.connection.subscribeState(imageId, this.onImage);
			await this.connection.subscribeState(dataId, this.onData);
			this.ids = [imageId, dataId];
		} catch {
			// Without the subscriptions the view simply does not follow later map updates.
		}
	}

	/** Drops the subscriptions and clears the model. */
	public destroy(): void {
		this.destroyed = true;
		this.unsubscribe();
	}

	private readonly onImage = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.imageSrc = state?.val ?? null;
		this.publish();
	};

	private readonly onData = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.rawMapData = state?.val ?? null;
		this.publish();
	};

	/**
	 * Rebuilds the model from whatever is currently held.
	 *
	 * Both states arrive separately and in no fixed order, so this runs on each of them and
	 * `buildMap3DModel` returns null until both are there. A view built from one of the two would
	 * be a floor without a picture or a picture without a grid.
	 */
	private publish(): void {
		this.host.onModel(buildMap3DModel(this.rawMapData, this.imageSrc));
	}

	private unsubscribe(): void {
		const ids = this.ids;
		this.ids = [];
		if (!ids.length) return;
		try {
			this.connection.unsubscribeState(ids[0], this.onImage);
			this.connection.unsubscribeState(ids[1], this.onData);
		} catch {
			// Unsubscribing from a state that is already gone is not a failure worth reporting.
		}
	}
}
