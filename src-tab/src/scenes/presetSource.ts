/**
 * The saved programs of the selected robot, and starting one.
 *
 * Its own module rather than part of the map engine, for the same reason the history, the settings
 * and the schedules are: it reads a state, draws nothing, and needs neither the map nor D3.
 *
 * ## One state, no wildcard
 *
 * Unlike the schedules this subscribes exactly one id, `programs.list`. The adapter publishes the
 * whole list as one JSON value **and** a folder per program; the folders are for ioBroker scripts,
 * the list is for this page. That is not a duplicate but a division of labour - a panel needs the
 * rows at once to draw them, and the schedules branch had to grow a debounced re-listing precisely
 * because it assembles its rows out of separate states.
 *
 * ## Why the cloud question is asked at all
 *
 * A saved program's name, target and cleaning values live in the Roborock account; the robot itself
 * knows only a `tid` and a geometry (`_appanalysis/32-presets.md` §3). So in "local only" operation
 * the adapter never publishes the list, and it never will - this is not a race that resolves a
 * moment later.
 *
 * An empty panel would read as "you have no programs", which is a different and wrong statement. So
 * the mode is read from the instance's own configuration object, where it is a fact rather than a
 * guess, and the panel says the sentence instead of showing nothing.
 */

import { SCENE_PRESET_LIST_STATE, parseScenePresetList } from "@adapter/common/scenePresets";
import type { ScenePresetEntry } from "@adapter/common/scenePresets";
import type { EngineConnection } from "../engine/types";

/** Adapter message that starts one program. */
export const START_PRESET_COMMAND = "start_program";

/** What the panel draws. */
export interface ScenePresetModel {
	/** The programs of this robot, in the order the adapter published them. */
	presets: ScenePresetEntry[];
	/**
	 * True when this instance runs cloud-free, so there can be no programs at all.
	 *
	 * The one case in which the panel appears **although** it has nothing to list: it exists to say
	 * why. See the file comment.
	 */
	cloudRequired: boolean;
	/**
	 * Whether the adapter has published a list for this device at all.
	 *
	 * False keeps the panel away, exactly as an absent map list keeps the maps panel away. It covers
	 * the moment before the first read and an older adapter that never wrote the state.
	 */
	published: boolean;
}

/** Nothing read yet, and nothing to say about it. */
export const EMPTY_PRESETS: ScenePresetModel = { presets: [], cloudRequired: false, published: false };

interface ScenePresetHost {
	/** The list as it reads now. */
	onPresets: (model: ScenePresetModel) => void;
	/** Something this page could not do; the adapter's own refusals arrive as command feedback. */
	onError: (message: string) => void;
}

/**
 * Reads `native.connectionMode` of an instance object.
 *
 * @param object The `system.adapter.<instance>` object, in whatever shape it came back.
 * @returns True when the instance is configured cloud-free.
 */
export function isCloudFreeInstance(object: unknown): boolean {
	if (!object || typeof object !== "object") return false;
	const native = (object as { native?: unknown }).native;
	if (!native || typeof native !== "object") return false;
	return (native as { connectionMode?: unknown }).connectionMode === "local";
}

export class ScenePresetSource {
	private stateId: string | null = null;
	private instanceId = "";
	private duid = "";
	private destroyed = false;
	private presets: ScenePresetEntry[] = [];
	private cloudRequired = false;
	private published = false;
	/** Raised on every device change, so a late answer for the previous robot is dropped. */
	private generation = 0;

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: ScenePresetHost,
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 *
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device to read; an empty value clears the panel.
	 */
	public async setDevice(instanceId: string, duid: string): Promise<void> {
		if (this.destroyed) return;

		await this.unsubscribe();
		const generation = ++this.generation;

		this.instanceId = instanceId;
		this.duid = duid;
		this.presets = [];
		this.published = false;
		this.cloudRequired = false;
		this.publish();
		if (!instanceId || !duid) return;

		// Asked before the list, so the first thing the panel draws already knows which of the two
		// things it is: a list, or the sentence about the cloud. Otherwise the sentence would appear
		// a moment after an empty panel, which reads as the page changing its mind.
		this.cloudRequired = await this.readCloudFree(instanceId);
		if (this.destroyed || generation !== this.generation) return;
		this.publish();

		const stateId = `${instanceId}.Devices.${duid}.${SCENE_PRESET_LIST_STATE}`;

		try {
			const states = await this.connection.getStates([stateId]);
			if (this.destroyed || generation !== this.generation) return;
			const value = states?.[stateId]?.val;
			// `undefined` is "no such state"; an empty string is a state that exists and holds nothing,
			// which is a published empty list. The two look the same to `parseScenePresetList` and are
			// different answers to "does this device have programs".
			this.published = value !== undefined && value !== null;
			this.presets = parseScenePresetList(value);
		} catch {
			// A device without the state answers with nothing. That is "no list", not a failure worth
			// putting in front of the user - the same rule the map list follows.
			this.published = false;
			this.presets = [];
		}
		this.publish();

		try {
			await this.connection.subscribeState(stateId, this.onState);
			if (this.destroyed || generation !== this.generation) {
				this.connection.unsubscribeState(stateId, this.onState);
				return;
			}
			this.stateId = stateId;
		} catch {
			// Without the subscription the list simply stops following a program added in the app.
		}
	}

	/** Drops the subscription and clears the panel. */
	public destroy(): void {
		this.destroyed = true;
		void this.unsubscribe();
	}

	/**
	 * Starts one saved program.
	 *
	 * The adapter is asked rather than the button written directly, the same boundary every other
	 * message from this page passes: `start_program` checks that the target really is a program this
	 * adapter published before it writes anything.
	 *
	 * **Nothing here reports success.** Starting a program queues a chain of robot commands that runs
	 * long after this call returns, and what became of it arrives on the command states as feedback -
	 * see `feedback/commandFeedbackSource.ts`. A green tick here would be a claim nobody has checked.
	 *
	 * @param sceneId Program to run.
	 */
	public async start(sceneId: string): Promise<void> {
		if (this.destroyed || !this.instanceId || !this.duid) return;
		try {
			await this.connection.sendTo(this.instanceId, START_PRESET_COMMAND, { duid: this.duid, sceneId });
		} catch (error: unknown) {
			this.host.onError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Whether this instance is configured cloud-free. A object that cannot be read counts as not. */
	private async readCloudFree(instanceId: string): Promise<boolean> {
		try {
			return isCloudFreeInstance(await this.connection.getObject(`system.adapter.${instanceId}`));
		} catch {
			// Without the instance object the mode is unknown, and "unknown" must not produce the
			// sentence: claiming the cloud is switched off when it is not would explain an empty panel
			// with the wrong reason.
			return false;
		}
	}

	private readonly onState = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		const value = state?.val;
		this.published = value !== undefined && value !== null;
		this.presets = parseScenePresetList(value);
		this.publish();
	};

	private publish(): void {
		this.host.onPresets({ presets: this.presets, cloudRequired: this.cloudRequired, published: this.published });
	}

	private async unsubscribe(): Promise<void> {
		if (!this.stateId) return;
		const stateId = this.stateId;
		this.stateId = null;
		try {
			this.connection.unsubscribeState(stateId, this.onState);
		} catch {
			// Unsubscribing from a state that is already gone is not a failure worth reporting.
		}
	}
}
