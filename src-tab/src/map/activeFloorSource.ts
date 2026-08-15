/**
 * Which floor the **robot** is on, as opposed to the one being looked at.
 *
 * The floor selector picks what the tab draws. On a robot with more than one map those two come
 * apart the moment somebody looks at the cellar while the robot is cleaning the ground floor - and
 * until now nothing said so. The selector showed one name, the map showed that floor's picture, and
 * the robot was somewhere else entirely.
 *
 * This reads the one state the adapter publishes for it, `mapInventory.activeMapFlag`
 * (`src/lib/features/vacuum/v1MapInventory.ts`), and nothing else. It is deliberately a source of
 * its own rather than a line in the map engine: the engine owns what is drawn, and this owns a
 * remark about what is drawn.
 *
 * A robot that never publishes the state - one whose firmware does not list its maps - reports
 * `null`, and the selector then looks exactly as it did before.
 */

import type { EngineConnection } from "../engine/types";

/** State the adapter publishes the active slot in, relative to the device. */
export const ACTIVE_MAP_STATE = "mapInventory.activeMapFlag";

interface ActiveFloorHost {
	/** The slot the robot has loaded, or null while nothing is known. */
	onActiveFloor: (mapFlag: number | null) => void;
}

/** Reads a state value as a map flag, or null. */
export function readMapFlag(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class ActiveFloorSource {
	private stateId: string | null = null;
	private destroyed = false;

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: ActiveFloorHost
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 *
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device to watch; an empty value clears the marker.
	 */
	public async setDevice(instanceId: string, duid: string): Promise<void> {
		if (this.destroyed) return;

		await this.unsubscribe();
		this.host.onActiveFloor(null);
		if (!duid) return;

		const stateId = `${instanceId}.Devices.${duid}.${ACTIVE_MAP_STATE}`;

		try {
			const states = await this.connection.getStates([stateId]);
			this.host.onActiveFloor(readMapFlag(states?.[stateId]?.val));
		} catch {
			// A robot without the state answers with nothing; that is "no marker", not an error
			// worth putting in front of the user.
			this.host.onActiveFloor(null);
		}

		if (this.destroyed) return;

		try {
			await this.connection.subscribeState(stateId, this.onState);
			this.stateId = stateId;
		} catch {
			// Same: without the subscription the marker simply does not follow a floor switch.
		}
	}

	/** Drops the subscription and clears the marker. */
	public destroy(): void {
		this.destroyed = true;
		void this.unsubscribe();
	}

	private readonly onState = (_id: string, state: { val?: unknown } | null): void => {
		if (this.destroyed) return;
		this.host.onActiveFloor(readMapFlag(state?.val));
	};

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
