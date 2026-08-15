/**
 * Reads the operable robot settings off the ioBroker socket and keeps them current.
 *
 * Unlike the cleaning history this branch is small - a handful of states - so every one of them is
 * subscribed directly. What arrives from the robot arrives as a status update, and the panel has to
 * follow it: a child lock switched at the robot itself, or a Do Not Disturb window the adapter
 * re-read after a command, both have to be visible without reopening the tab.
 */

import type { EngineConnection } from "../engine/types";
import type { RobotSettingsModel, SettingStateDefinition, SettingStateValue, SettingWrite } from "./robotSettings";
import { SETTINGS_FOLDER, STATUS_FOLDER, buildRobotSettings, settingsRoot, settingsStateIds } from "./robotSettings";

interface RobotSettingsSourceHost {
	/** The model, or null while no device is selected. */
	onSettings: (model: RobotSettingsModel | null) => void;
	/** A failed write, already worded for the user. */
	onError?: (message: string) => void;
}

export class RobotSettingsSource {
	private root: string | null = null;
	private duid = "";
	private instanceId = "";
	private language = "en";
	private destroyed = false;
	private generation = 0;
	private subscriptions: string[] = [];
	private definitions: SettingStateDefinition[] = [];
	private values: Record<string, SettingStateValue | null> = {};

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: RobotSettingsSourceHost,
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device the settings belong to; an empty value clears the panel.
	 * @param language Admin language, used to resolve per-language object names.
	 */
	public setDevice(instanceId: string, duid: string, language: string): void {
		if (this.destroyed) return;

		this.language = language || "en";
		this.dropSubscriptions();
		this.generation++;
		this.definitions = [];
		this.values = {};

		if (!duid) {
			this.root = null;
			this.host.onSettings(null);
			return;
		}

		this.instanceId = instanceId;
		this.duid = duid;
		this.root = settingsRoot(instanceId, duid);
		this.host.onSettings(null);
		void this.reload();
	}

	/** Reads the objects and their values, then subscribes to each of them. */
	private async reload(): Promise<void> {
		const root = this.root;
		if (this.destroyed || !root) return;

		const generation = ++this.generation;
		const ids = settingsStateIds(root);
		const definitions = await this.readDefinitions(ids);
		if (this.destroyed || generation !== this.generation) return;

		const values = (await this.connection.getStates(ids)) as Record<string, SettingStateValue | null>;
		if (this.destroyed || generation !== this.generation) return;

		this.definitions = definitions;
		this.values = values;
		this.publish();

		// Only the states that really exist are subscribed - a robot without a child lock has no
		// such object, and subscribing to it would be a subscription that can never fire.
		for (const definition of definitions) {
			this.subscriptions.push(definition.id);
			void this.connection.subscribeState(definition.id, this.stateHandler);
		}
	}

	/**
	 * Fetches the definitions of the states this build knows about.
	 *
	 * Asked one by one rather than through an object view: the list is short and fixed, and the two
	 * folders it spans (`settings` and `deviceStatus`) would otherwise both have to be enumerated
	 * in full - `deviceStatus` alone is dozens of objects on a modern robot.
	 * @param ids State ids to look up.
	 */
	private async readDefinitions(ids: string[]): Promise<SettingStateDefinition[]> {
		const found: SettingStateDefinition[] = [];
		for (const id of ids) {
			try {
				const object = await this.connection.getObject(id);
				if (object) found.push({ id, common: (object as { common?: SettingStateDefinition["common"] }).common ?? {} });
			} catch {
				// A state that cannot be read is a state this robot does not have; the model skips it.
			}
		}
		return found;
	}

	private readonly stateHandler = (id: string, state: SettingStateValue | null | undefined): void => {
		if (this.destroyed || !this.root) return;
		this.values = { ...this.values, [id]: state ?? null };
		this.publish();
	};

	private publish(): void {
		if (!this.root) return;
		this.host.onSettings(buildRobotSettings({
			root: this.root,
			definitions: this.definitions,
			values: this.values,
			language: this.language,
		}));
	}

	/**
	 * Performs one write through the adapter's guarded generic writer.
	 *
	 * Nothing is sent that did not come out of the model, and the adapter checks the target against
	 * its own registered command list again before it acts - this is the same path the mode
	 * selectors and the dock panel take.
	 * @param write What to write, as planned by `robotSettings.ts`.
	 */
	public async apply(write: SettingWrite): Promise<void> {
		if (this.destroyed || !this.duid) return;
		if (write.folder !== SETTINGS_FOLDER && write.folder !== STATUS_FOLDER) return;

		try {
			await this.connection.sendTo(this.instanceId, "set_state", {
				duid: this.duid,
				folder: write.folder,
				command: write.command,
				value: write.value,
			});
		} catch (error) {
			this.host.onError?.(error instanceof Error ? error.message : String(error));
		}
	}

	private dropSubscriptions(): void {
		for (const id of this.subscriptions) this.connection.unsubscribeState(id, this.stateHandler);
		this.subscriptions = [];
	}

	/** Drops every subscription the source created. */
	public destroy(): void {
		this.destroyed = true;
		this.generation++;
		this.dropSubscriptions();
	}
}
