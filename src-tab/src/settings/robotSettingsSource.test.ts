import { afterEach, describe, expect, it, vi } from "vitest";
import { RobotSettingsSource } from "./robotSettingsSource";
import { settingsRoot } from "./robotSettings";
import type { EngineConnection } from "../engine/types";
import type { RobotSettingsModel } from "./robotSettings";

/**
 * What the settings source reads, what it subscribes to and what it sends.
 *
 * The write path is the part worth guarding: everything leaves through the adapter's guarded
 * generic writer, with the folder and command the model produced and nothing the panel invented.
 */

const ROOT = settingsRoot("roborock.0", "duid1");

/** The objects a robot with both settings publishes. */
const OBJECTS: Record<string, { common: Record<string, unknown> }> = {
	[`${ROOT}.settings.set_dnd_timer`]: { common: { name: "Do Not Disturb Mode", type: "string" } },
	[`${ROOT}.settings.close_dnd_timer`]: { common: { name: "Do Not Disturb Mode off", type: "boolean" } },
	[`${ROOT}.settings.set_child_lock_status`]: { common: { name: "Child Lock", type: "boolean" } },
	[`${ROOT}.deviceStatus.dnd_enabled`]: { common: { type: "number" } },
	[`${ROOT}.deviceStatus.dnd_start`]: { common: { type: "string" } },
	[`${ROOT}.deviceStatus.dnd_end`]: { common: { type: "string" } },
};

const VALUES: Record<string, { val: unknown }> = {
	[`${ROOT}.settings.set_dnd_timer`]: { val: "22:00-07:00" },
	[`${ROOT}.settings.set_child_lock_status`]: { val: false },
	[`${ROOT}.deviceStatus.dnd_enabled`]: { val: 1 },
	[`${ROOT}.deviceStatus.dnd_start`]: { val: "22:00" },
	[`${ROOT}.deviceStatus.dnd_end`]: { val: "07:00" },
};

let live: RobotSettingsSource | null = null;

afterEach(() => {
	live?.destroy();
	live = null;
});

function harness(objects: Record<string, { common: Record<string, unknown> }> = OBJECTS) {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();
	const models: (RobotSettingsModel | null)[] = [];
	const errors: string[] = [];

	const connection: EngineConnection = {
		sendTo: vi.fn().mockResolvedValue({ result: "ok" }),
		getObject: vi.fn(async (id: string) => objects[id] ?? null),
		getStates: vi.fn(async (ids: string[]) => {
			const answer: Record<string, any> = {};
			for (const id of ids) if (VALUES[id]) answer[id] = VALUES[id];
			return answer;
		}),
		subscribeState: vi.fn(async (id: string, handler: (id: string, state: any) => void) => {
			const list = subscriptions.get(id) ?? [];
			list.push(handler);
			subscriptions.set(id, list);
		}),
		unsubscribeState: vi.fn((id: string, handler: (id: string, state: any) => void) => {
			const list = (subscriptions.get(id) ?? []).filter(entry => entry !== handler);
			if (list.length) subscriptions.set(id, list);
			else subscriptions.delete(id);
		}),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const source = new RobotSettingsSource(connection, {
		onSettings: model => models.push(model),
		onError: message => errors.push(message),
	});
	live = source;

	return {
		source,
		connection,
		subscriptions,
		models,
		errors,
		fire: (id: string, val: unknown) => {
			for (const handler of subscriptions.get(id) ?? []) handler(id, { val });
		},
	};
}

/**
 * Waits for the source to finish its reload.
 *
 * This used to be twelve microtask turns, which is a count of the awaits the source happened to
 * have at the time - adding five settings to `KNOWN_SETTINGS` pushed it past twelve and made three
 * unrelated tests fail with an empty model. A macrotask drains everything queued behind it
 * regardless of how many awaits there are, so the number of settings no longer decides whether
 * these tests pass.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RobotSettingsSource", () => {
	it("publishes both settings of a robot that has them", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		const model = h.models[h.models.length - 1];
		expect(model?.entries.map(entry => entry.command)).toEqual(["set_dnd_timer", "set_child_lock_status"]);
	});

	it("subscribes only to the states that really exist", async () => {
		const withoutLock = { ...OBJECTS };
		delete withoutLock[`${ROOT}.settings.set_child_lock_status`];

		const h = harness(withoutLock);
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		expect(Array.from(h.subscriptions.keys())).not.toContain(`${ROOT}.settings.set_child_lock_status`);
		expect(Array.from(h.subscriptions.keys())).toContain(`${ROOT}.deviceStatus.dnd_enabled`);
		expect(h.models[h.models.length - 1]?.entries.map(entry => entry.command)).toEqual(["set_dnd_timer"]);
	});

	it("follows a change the robot reports", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		h.fire(`${ROOT}.deviceStatus.dnd_enabled`, 0);
		const model = h.models[h.models.length - 1];
		expect(model?.entries[0]).toMatchObject({ command: "set_dnd_timer", enabled: false });
	});

	it("sends a write through the adapter's guarded writer", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		await h.source.apply({ folder: "settings", command: "set_child_lock_status", value: true });
		expect(h.connection.sendTo).toHaveBeenCalledWith("roborock.0", "set_state", {
			duid: "duid1",
			folder: "settings",
			command: "set_child_lock_status",
			value: true,
		});
	});

	it("refuses to write outside the two folders it knows", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		await h.source.apply({ folder: "commands", command: "app_start", value: true });
		expect(h.connection.sendTo).not.toHaveBeenCalled();
	});

	it("reports a rejected write instead of swallowing it", async () => {
		const h = harness();
		(h.connection.sendTo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not allowed"));
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		await h.source.apply({ folder: "settings", command: "set_child_lock_status", value: true });
		expect(h.errors).toContain("not allowed");
	});

	it("clears the panel and every subscription when no device is selected", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		h.source.setDevice("roborock.0", "", "en");
		expect(h.models[h.models.length - 1]).toBeNull();
		expect(Array.from(h.subscriptions.keys())).toHaveLength(0);
	});

	it("drops every subscription on destroy", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		h.source.destroy();
		expect(Array.from(h.subscriptions.keys())).toHaveLength(0);
	});

	it("sends nothing after it was destroyed", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		h.source.destroy();
		await h.source.apply({ folder: "settings", command: "set_child_lock_status", value: true });
		expect(h.connection.sendTo).not.toHaveBeenCalled();
	});
});
