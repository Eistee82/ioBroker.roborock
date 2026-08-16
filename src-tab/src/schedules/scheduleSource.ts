/**
 * Reads the schedules of the selected robot off the ioBroker socket and keeps them current.
 *
 * Its own module rather than part of the map engine, for the same reason the history and the settings
 * are: it reads states, draws nothing and needs neither the map nor D3.
 *
 * ## Why the whole branch is subscribed with one pattern
 *
 * Unlike the settings, the set of states is not known in advance - a schedule's identifier is a
 * number the robot chose, and schedules come and go. One wildcard therefore covers the branch, and
 * that is affordable here in a way it would not be for `Devices.<duid>.*`: a schedule carries a
 * handful of short strings, while the map states of a large flat are measured in megabytes and
 * `subscribeState` fetches the current value of everything the pattern matches.
 *
 * ## How a deleted schedule disappears
 *
 * Without a timer. Deleting a confirmed schedule removes its whole folder in the adapter
 * (`v1VacuumFeatures.removeScheduleObject`), and ioBroker delivers a removed state to its subscribers
 * as `null` - so the same handler that keeps the values current is what drops the entry. A state that
 * arrives for an identifier this source has no object for is the opposite case, a schedule that just
 * appeared, and that is the one thing worth re-listing the objects for.
 */

import type { EngineConnection } from "../engine/types";
import type { ScheduleStateDefinition, ScheduleStateValue, SchedulesModel } from "./schedules";
import { buildSchedules, schedulesRoot } from "./schedules";

interface ScheduleSourceHost {
	/** The model, or null while no device is selected. */
	onSchedules: (model: SchedulesModel | null) => void;
	/** A failed write, already worded for the user. */
	onError?: (message: string) => void;
}

/**
 * How long a newly seen state waits before the objects are listed again.
 *
 * A schedule read from the robot writes several states in a row, and each of them would otherwise
 * start its own listing. Short enough that the panel fills in the same moment it would have anyway.
 */
const RELOAD_DEBOUNCE_MS = 250;

export class ScheduleSource {
	private root: string | null = null;
	private duid = "";
	private instanceId = "";
	private destroyed = false;
	private generation = 0;
	private pattern: string | null = null;
	private definitions: ScheduleStateDefinition[] = [];
	private values: Record<string, ScheduleStateValue | null> = {};
	private reloadTimer: ReturnType<typeof setTimeout> | null = null;

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: ScheduleSourceHost,
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device whose schedules to read; an empty value clears the panel.
	 */
	public setDevice(instanceId: string, duid: string): void {
		if (this.destroyed) return;

		this.dropSubscriptions();
		this.generation++;
		this.definitions = [];
		this.values = {};

		if (!instanceId || !duid) {
			this.root = null;
			this.host.onSchedules(null);
			return;
		}

		this.instanceId = instanceId;
		this.duid = duid;
		this.root = schedulesRoot(instanceId, duid);
		this.host.onSchedules(null);

		this.pattern = `${this.root}.*`;
		void this.connection.subscribeState(this.pattern, this.stateHandler);
		void this.reload();
	}

	/** Lists the objects below the schedules folder and reads their values. */
	private async reload(): Promise<void> {
		const root = this.root;
		if (this.destroyed || !root) return;

		const generation = this.generation;
		const definitions = await this.listStates(root);
		if (this.destroyed || generation !== this.generation) return;

		const values = definitions.length
			? ((await this.connection.getStates(definitions.map(definition => definition.id))) as Record<string, ScheduleStateValue | null>)
			: {};
		if (this.destroyed || generation !== this.generation) return;

		this.definitions = definitions;
		// What the subscription delivered while the listing was running is newer than what the bulk
		// read returned, so it wins.
		this.values = { ...values, ...this.values };
		this.publish();
	}

	/** Lists the state objects below the schedules folder; an unreachable view yields an empty panel. */
	private async listStates(root: string): Promise<ScheduleStateDefinition[]> {
		try {
			const prefix = `${root}.`;
			// `香` is the sentinel the map engine and the history use for the same purpose: a code
			// point far above anything an ioBroker id contains, so the view returns the whole subtree.
			const objects = await this.connection.getObjectViewSystem("state", prefix, `${prefix}香`);
			return Object.entries(objects ?? {})
				.filter(([id]) => id.startsWith(prefix) && id.length > prefix.length)
				.map(([id, value]) => ({ id: String(id), common: (value as { common?: ScheduleStateDefinition["common"] })?.common ?? {} }));
		} catch {
			return [];
		}
	}

	private readonly stateHandler = (id: string, state: ScheduleStateValue | null | undefined): void => {
		if (this.destroyed || !this.root) return;
		if (!id.startsWith(`${this.root}.`)) return;

		if (state === null || state === undefined) {
			// The schedule was deleted, or at least this state of it was. Both the value and the object
			// go, because a row built from an object whose state no longer exists is a row about
			// nothing.
			const { [id]: _removed, ...rest } = this.values;
			this.values = rest;
			this.definitions = this.definitions.filter(definition => definition.id !== id);
			this.publish();
			return;
		}

		this.values = { ...this.values, [id]: state };

		// A value for a state this source has no object for is a schedule that appeared after the
		// listing. Its object decides whether it may be switched or deleted, so it has to be fetched -
		// once for the whole burst rather than once per state.
		if (!this.definitions.some(definition => definition.id === id)) {
			this.scheduleReload();
			return;
		}

		this.publish();
	};

	/** Coalesces the listings a burst of new states would otherwise each start. */
	private scheduleReload(): void {
		if (this.reloadTimer !== null) return;
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = null;
			void this.reload();
		}, RELOAD_DEBOUNCE_MS);
	}

	private publish(): void {
		if (!this.root) return;
		this.host.onSchedules(buildSchedules({ root: this.root, definitions: this.definitions, values: this.values }));
	}

	/**
	 * Switches one schedule on or off.
	 *
	 * The adapter is asked rather than the state written directly: `set_schedule_enabled` checks that
	 * the target really is a schedule switch this adapter published before it writes anything, which
	 * is the same boundary every other message from this page passes.
	 *
	 * @param timerId Identifier of the schedule.
	 * @param enabled Wanted position.
	 */
	public async setEnabled(timerId: string, enabled: boolean): Promise<void> {
		await this.send("set_schedule_enabled", { duid: this.duid, timerId, enabled });
	}

	/**
	 * Deletes one schedule for good.
	 *
	 * Nothing is removed here on the strength of the message being accepted. The entry disappears when
	 * its states do, and they only do once the adapter has asked the robot's own list again and found
	 * the schedule gone - see `src/lib/features/vacuum/v1VacuumFeatures.ts`. A delete that did not take
	 * therefore leaves the row standing, which is what should happen.
	 *
	 * @param timerId Identifier of the schedule.
	 */
	public async remove(timerId: string): Promise<void> {
		await this.send("delete_schedule", { duid: this.duid, timerId });
	}

	private async send(command: string, payload: Record<string, unknown>): Promise<void> {
		if (this.destroyed || !this.duid) return;
		try {
			await this.connection.sendTo(this.instanceId, command, payload);
		} catch (error) {
			this.host.onError?.(error instanceof Error ? error.message : String(error));
		}
	}

	private dropSubscriptions(): void {
		if (this.pattern) {
			this.connection.unsubscribeState(this.pattern, this.stateHandler);
			this.pattern = null;
		}
		if (this.reloadTimer !== null) {
			clearTimeout(this.reloadTimer);
			this.reloadTimer = null;
		}
	}

	/** Drops every subscription and timer the source created. */
	public destroy(): void {
		this.destroyed = true;
		this.generation++;
		this.dropSubscriptions();
	}
}
