import { afterEach, describe, expect, it, vi } from "vitest";
import { SCENE_PRESET_LIST_STATE } from "@adapter/common/scenePresets";
import { EMPTY_PRESETS, START_PRESET_COMMAND, ScenePresetSource, isCloudFreeInstance } from "./presetSource";
import type { ScenePresetModel } from "./presetSource";
import type { EngineConnection } from "../engine/types";

/**
 * Reading the saved programs.
 *
 * The failure this file exists for is not an empty panel. It is an empty panel **with the wrong
 * reason**: a cloud-free instance can never have programs, and saying "you have none" there is a
 * different and false statement from "they cannot be read from here". Both directions are tested,
 * including the case where the instance object cannot be read at all - which must not produce the
 * sentence either.
 */

const LIST_STATE = `roborock.0.Devices.duid1.${SCENE_PRESET_LIST_STATE}`;
const INSTANCE_OBJECT = "system.adapter.roborock.0";

/** Two of the measured programs, in the shape the adapter publishes. */
const MEASURED = JSON.stringify([
	{ id: "12101885", name: "Kamin", enabled: true, valid: true, steps: [{ method: "do_scenes_zones", tid: "1767377550650", target: "zone", targetIds: [1], fanPower: 108, waterBoxMode: 200 }] },
	{ id: "7085747", name: "Küche", enabled: true, valid: false, steps: [{ method: "do_scenes_segments", tid: "1745006632377", target: "segment", targetIds: [18], fanPower: 104, waterBoxMode: 203 }] },
]);

let live: ScenePresetSource | null = null;

afterEach(() => {
	live?.destroy();
	live = null;
});

function harness(options: { list?: unknown; connectionMode?: string; instanceThrows?: boolean } = {}) {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();
	const reported: ScenePresetModel[] = [];
	const errors: string[] = [];
	const sendTo = vi.fn(async () => ({ result: "accepted" }));

	const connection = {
		sendTo,
		getObject: vi.fn(async (id: string) => {
			if (options.instanceThrows) throw new Error("no such object");
			if (id !== INSTANCE_OBJECT) return null;
			return { native: { connectionMode: options.connectionMode ?? "cloud" } };
		}),
		getStates: vi.fn(async (ids: string[]) => {
			const answer: Record<string, any> = {};
			for (const id of ids) if (id === LIST_STATE && options.list !== undefined) answer[id] = { val: options.list };
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
		getObjectViewSystem: vi.fn(),
	} as unknown as EngineConnection;

	const source = new ScenePresetSource(connection, {
		onPresets: model => reported.push(model),
		onError: message => errors.push(message),
	});
	live = source;

	return { source, connection, sendTo, subscriptions, reported, errors, latest: () => reported[reported.length - 1] };
}

describe("isCloudFreeInstance", () => {
	it("recognises the configured mode", () => {
		expect(isCloudFreeInstance({ native: { connectionMode: "local" } })).toBe(true);
		expect(isCloudFreeInstance({ native: { connectionMode: "cloud" } })).toBe(false);
	});

	it("answers false for anything it cannot read", () => {
		// "Unknown" must never become "cloud-free": that would explain an empty panel with a reason
		// that is not true.
		for (const value of [null, undefined, {}, { native: null }, { native: {} }, "local", 42]) {
			expect(isCloudFreeInstance(value)).toBe(false);
		}
	});
});

describe("ScenePresetSource", () => {
	it("starts empty and stays empty without a device", async () => {
		const view = harness();
		await view.source.setDevice("roborock.0", "");
		expect(view.latest()).toEqual(EMPTY_PRESETS);
	});

	it("reads the published list", async () => {
		const view = harness({ list: MEASURED });
		await view.source.setDevice("roborock.0", "duid1");

		const model = view.latest();
		expect(model.published).toBe(true);
		expect(model.cloudRequired).toBe(false);
		expect(model.presets.map(entry => entry.name)).toEqual(["Kamin", "Küche"]);
		expect(model.presets[1].valid).toBe(false);
	});

	it("tells an absent state from a published empty list", async () => {
		// Both draw nothing, and they are different facts: the first is "no adapter wrote this", the
		// second is "the account has no program for this robot".
		const missing = harness();
		await missing.source.setDevice("roborock.0", "duid1");
		expect(missing.latest()).toMatchObject({ published: false, presets: [] });

		const empty = harness({ list: "[]" });
		await empty.source.setDevice("roborock.0", "duid1");
		expect(empty.latest()).toMatchObject({ published: true, presets: [] });
	});

	it("reports a cloud-free instance so the panel can say why it is empty", async () => {
		const view = harness({ connectionMode: "local" });
		await view.source.setDevice("roborock.0", "duid1");
		expect(view.latest()).toMatchObject({ cloudRequired: true, published: false, presets: [] });
	});

	it("does not claim cloud-free when the instance object cannot be read", async () => {
		const view = harness({ instanceThrows: true });
		await view.source.setDevice("roborock.0", "duid1");
		expect(view.latest().cloudRequired).toBe(false);
	});

	it("follows a program added while the tab is open", async () => {
		const view = harness({ list: "[]" });
		await view.source.setDevice("roborock.0", "duid1");

		view.subscriptions.get(LIST_STATE)?.forEach(handler => handler(LIST_STATE, { val: MEASURED }));
		expect(view.latest().presets).toHaveLength(2);
	});

	it("drops the subscription of the previous robot", async () => {
		const view = harness({ list: MEASURED });
		await view.source.setDevice("roborock.0", "duid1");
		expect(view.subscriptions.has(LIST_STATE)).toBe(true);

		await view.source.setDevice("roborock.0", "duid2");
		expect(view.subscriptions.has(LIST_STATE)).toBe(false);
	});

	it("sends the start through the adapter, never by writing the button", async () => {
		// The message is the boundary that checks the target really is a program this adapter
		// published; writing the state directly would skip it.
		const view = harness({ list: MEASURED });
		await view.source.setDevice("roborock.0", "duid1");
		await view.source.start("12101885");

		expect(view.sendTo).toHaveBeenCalledWith("roborock.0", START_PRESET_COMMAND, { duid: "duid1", sceneId: "12101885" });
	});

	it("reports a failed send instead of swallowing it", async () => {
		const view = harness({ list: MEASURED });
		await view.source.setDevice("roborock.0", "duid1");
		(view.connection.sendTo as any).mockRejectedValueOnce(new Error("no handler"));

		await view.source.start("12101885");
		expect(view.errors).toEqual(["no handler"]);
	});

	it("sends nothing after destroy", async () => {
		const view = harness({ list: MEASURED });
		await view.source.setDevice("roborock.0", "duid1");
		view.source.destroy();

		await view.source.start("12101885");
		expect(view.sendTo).not.toHaveBeenCalled();
	});

	it("survives a state that holds something unreadable", async () => {
		const view = harness({ list: "not json" });
		await view.source.setDevice("roborock.0", "duid1");
		// Published, because the state exists - and empty, because nothing could be read out of it.
		expect(view.latest()).toMatchObject({ published: true, presets: [] });
	});
});
