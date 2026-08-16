import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * The saved programs, from the cloud answer to the object tree.
 *
 * `processScenes` used to write two things per scene - a folder and an `enabled` flag - and to take
 * the device from `items[0].entityId` for the whole scene. Everything the panel needs was parsed in
 * `executeSceneLocal` and thrown away again.
 *
 * Four properties are worth pinning here, and each of them is a way the branch could lie:
 *
 *  - the **device** comes from the step, so a scene addressing two robots lands in two folders;
 *  - the single-value states are written **only when all steps agree**, because the measured account
 *    has a scene that vacuums with one setting and mops with another;
 *  - `valid` appears **only** where the robot actually answered `get_scenes_valid_tids`;
 *  - a folder is removed when the account drops the program - but **never** all of them at once.
 */

/** The measured payload of one scene, as `_appanalysis/szenen-roh.json` records it. */
function scene(id: number, name: string, duid: string, method: string, params: unknown, enabled = true) {
	return {
		id,
		name,
		enabled,
		param: JSON.stringify({
			triggers: [],
			action: { type: "S", items: [{ id: 1, type: "CMD", name: "", entityId: duid, param: JSON.stringify({ id: 1, method, params }) }] }
		})
	};
}

/** "Küche": one segment, fan 104, water 203. */
const KUECHE = scene(7085747, "Küche", "duid1", "do_scenes_segments", {
	data: [{ tid: "1745006632377", segs: [{ sid: 18 }], map_flag: 0, fan_power: 104, water_box_mode: 203, mop_mode: 300, repeat: 1 }],
	source: 101
});

/** "Kamin": one zone, fan 108, water 200 - the one program of the account that only vacuums. */
const KAMIN = scene(12101885, "Kamin", "duid1", "do_scenes_zones", {
	data: [{ tid: "1767377550650", zones: [{ zid: 1, repeat: 1 }], map_flag: 0, fan_power: 108, water_box_mode: 200, mop_mode: 300, repeat: 1 }],
	source: 101
});

/** "Saugen, dann Wischen": two steps with different settings, on a second robot. */
const ZWEISTUFIG = {
	id: 4841021,
	name: "Saugen, dann Wischen",
	enabled: true,
	param: JSON.stringify({
		action: {
			type: "S",
			items: [
				{ type: "CMD", entityId: "duid2", param: JSON.stringify({ method: "do_scenes_app_start", params: [{ fan_power: 108, water_box_mode: 200, mop_mode: 300, repeat: 1 }] }) },
				{ type: "CMD", entityId: "duid2", param: JSON.stringify({ method: "do_scenes_app_start", params: [{ fan_power: 105, water_box_mode: 203, mop_mode: 300, repeat: 1 }] }) }
			]
		}
	})
};

interface AdapterOptions {
	scenes?: unknown[];
	/** What `get_scenes_valid_tids` answers; an Error is thrown instead. */
	validTids?: unknown;
	/** Folders that already exist below `programs`, as full object ids. */
	storedFolders?: string[];
	cloudSession?: boolean;
	devices?: string[];
}

async function createAdapter(options: AdapterOptions = {}) {
	const { Roborock } = await import("../../src/main");

	const states = new Map<string, unknown>();
	const objects = new Map<string, Record<string, unknown>>();
	const deleted: string[] = [];
	const devices = options.devices ?? ["duid1", "duid2"];

	const sendRequest = vi.fn(async (_duid: string, method: string) => {
		if (method !== "get_scenes_valid_tids") return ["ok"];
		if (options.validTids instanceof Error) throw options.validTids;
		return options.validTids;
	});

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		namespace: "roborock.0",
		translations: {},
		deviceFeatureHandlers: new Map(devices.map((duid) => [duid, { protocolVersion: "1.0" }])),
		requestsHandler: { sendRequest },
		http_api: {
			hasCloudSession: () => options.cloudSession !== false,
			getScenes: vi.fn(async () => ({ result: options.scenes ?? [] }))
		},
		rLog: vi.fn(),
		errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
		ensureFolder: vi.fn(async (path: string) => {
			objects.set(`roborock.0.${path}`, { type: "folder" });
		}),
		ensureState: vi.fn(async (path: string, common: Record<string, unknown>) => {
			objects.set(`roborock.0.${path}`, { type: "state", common });
		}),
		setStateChanged: vi.fn(async (path: string, value: { val: unknown }) => {
			states.set(path, value.val);
		}),
		ensureSceneQueueState: vi.fn(async () => undefined),
		getForeignObjectsAsync: vi.fn(async (pattern: string) => {
			const prefix = pattern.replace(/\*$/, "");
			const answer: Record<string, unknown> = {};
			for (const id of options.storedFolders ?? []) if (id.startsWith(prefix)) answer[id] = { type: "folder" };
			return answer;
		}),
		delObjectAsync: vi.fn(async (id: string) => {
			deleted.push(id);
		})
	});

	return { adapter, states, objects, deleted, sendRequest };
}

describe("processScenes publishes the saved programs", () => {
	it("writes the whole list as one JSON value per device", async () => {
		const { adapter, states } = await createAdapter({ scenes: [KUECHE, KAMIN] });

		await adapter.processScenes();

		const list = JSON.parse(states.get("Devices.duid1.programs.list") as string);
		expect(list.map((entry: { name: string }) => entry.name)).toEqual(["Küche", "Kamin"]);
		expect(list[0].steps[0]).toMatchObject({ target: "segment", targetIds: [18], fanPower: 104, mode: "vacmop" });
		expect(list[1].steps[0]).toMatchObject({ target: "zone", targetIds: [1], fanPower: 108, mode: "vacuum" });
	});

	it("puts a scene in the folder of the device its step names", async () => {
		// The old code read `items[0].entityId` for the whole scene, which attributed the two-step
		// program to whichever robot happened to be first.
		const { adapter, states } = await createAdapter({ scenes: [KUECHE, ZWEISTUFIG] });

		await adapter.processScenes();

		expect(JSON.parse(states.get("Devices.duid1.programs.list") as string)).toHaveLength(1);
		expect(JSON.parse(states.get("Devices.duid2.programs.list") as string)).toHaveLength(1);
	});

	it("publishes name, target and the cleaning values as single states", async () => {
		const { adapter, states } = await createAdapter({ scenes: [KUECHE] });

		await adapter.processScenes();

		expect(states.get("Devices.duid1.programs.7085747.name")).toBe("Küche");
		expect(states.get("Devices.duid1.programs.7085747.enabled")).toBe(true);
		expect(states.get("Devices.duid1.programs.7085747.target")).toBe("segment");
		expect(states.get("Devices.duid1.programs.7085747.targetIds")).toBe("[18]");
		expect(states.get("Devices.duid1.programs.7085747.fanPower")).toBe(104);
		expect(states.get("Devices.duid1.programs.7085747.waterBoxMode")).toBe(203);
		expect(states.get("Devices.duid1.programs.7085747.mopMode")).toBe(300);
		expect(states.get("Devices.duid1.programs.7085747.mapFlag")).toBe(0);
		expect(states.get("Devices.duid1.programs.7085747.mode")).toBe("vacmop");
	});

	it("leaves a single-value state empty when the steps disagree", async () => {
		// The two steps of "Saugen, dann Wischen" run at 108/200 and 105/203. Publishing either as
		// "the" suction level of the program would state something untrue of it; `steps` has both.
		const { adapter, states } = await createAdapter({ scenes: [ZWEISTUFIG] });

		await adapter.processScenes();

		expect(states.get("Devices.duid2.programs.4841021.fanPower")).toBeNull();
		expect(states.get("Devices.duid2.programs.4841021.mode")).toBeNull();
		// What they do agree on is still written.
		expect(states.get("Devices.duid2.programs.4841021.target")).toBe("all");
		expect(states.get("Devices.duid2.programs.4841021.repeat")).toBe(1);
		expect(JSON.parse(states.get("Devices.duid2.programs.4841021.steps") as string)).toHaveLength(2);
	});

	it("offers a start button per program beside the collective select", async () => {
		const { adapter, objects } = await createAdapter({ scenes: [KUECHE, KAMIN] });

		await adapter.processScenes();

		expect(objects.get("roborock.0.Devices.duid1.programs.7085747.start")?.common).toMatchObject({ type: "boolean", role: "button", write: true });
		expect(objects.get("roborock.0.Devices.duid1.programs.startProgram")?.common).toMatchObject({
			write: true,
			states: { 7085747: "Küche", 12101885: "Kamin" }
		});
	});

	it("marks a program the robot no longer knows", async () => {
		const { adapter, states } = await createAdapter({
			scenes: [KUECHE, KAMIN],
			validTids: [{ tid: "1745006632377", map_flag: 0, segs: [{ sid: 18 }] }]
		});

		await adapter.processScenes();

		expect(states.get("Devices.duid1.programs.7085747.valid")).toBe(true);
		expect(states.get("Devices.duid1.programs.12101885.valid")).toBe(false);
	});

	it("publishes no valid state at all when the robot does not answer the getter", async () => {
		// `unknown_method` is silence, not a verdict. A state written `false` here would put a warning
		// on every program of every device whose firmware lacks the call.
		const { adapter, states, objects } = await createAdapter({ scenes: [KUECHE], validTids: "unknown_method" });

		await adapter.processScenes();

		expect(objects.has("roborock.0.Devices.duid1.programs.7085747.valid")).toBe(false);
		expect(states.has("Devices.duid1.programs.7085747.valid")).toBe(false);
		expect(JSON.parse(states.get("Devices.duid1.programs.list") as string)[0].valid).toBeNull();
	});

	it("survives the getter throwing", async () => {
		const { adapter, states } = await createAdapter({ scenes: [KUECHE], validTids: new Error("timeout") });

		await adapter.processScenes();

		expect(JSON.parse(states.get("Devices.duid1.programs.list") as string)).toHaveLength(1);
	});

	it("does not ask a device it has no handler for", async () => {
		const { adapter, sendRequest } = await createAdapter({ scenes: [KUECHE], devices: [] });

		await adapter.processScenes();

		expect(sendRequest).not.toHaveBeenCalled();
	});

	it("removes the folder of a program the account no longer lists", async () => {
		const { adapter, deleted } = await createAdapter({
			scenes: [KUECHE],
			storedFolders: ["roborock.0.Devices.duid1.programs.7085747", "roborock.0.Devices.duid1.programs.999999"]
		});

		await adapter.processScenes();

		expect(deleted).toEqual(["roborock.0.Devices.duid1.programs.999999"]);
	});

	it("removes nothing when the account suddenly lists none", async () => {
		// The guard `DeviceManager.cleanupOrphanedDevices` learned the hard way: a cloud answer that
		// came back empty by mistake would otherwise wipe every program the user has.
		const { adapter, deleted } = await createAdapter({
			scenes: [KAMIN],
			storedFolders: ["roborock.0.Devices.duid2.programs.4841021"],
			devices: ["duid1", "duid2"]
		});

		await adapter.processScenes();

		// duid2 got no scene this round, so it is not even visited - and nothing of it is removed.
		expect(deleted).toEqual([]);
	});

	it("does nothing at all without a cloud session", async () => {
		// A saved program's name lives in the account. There is nothing to publish, and an empty
		// branch would read as "this robot has none".
		const { adapter, states } = await createAdapter({ scenes: [KUECHE], cloudSession: false });

		await adapter.processScenes();

		expect(states.size).toBe(0);
	});
});

describe("the per-program start button", () => {
	async function createButtonAdapter() {
		const { Roborock } = await import("../../src/main");
		const timeouts = new Map<number, () => void>();
		let nextId = 1;

		const adapter = Object.assign(Object.create(Roborock.prototype), {
			deviceFeatureHandlers: new Map([["duid1", { protocolVersion: "1.0" }]]),
			rLog: vi.fn(),
			catchError: vi.fn(),
			setState: vi.fn().mockResolvedValue(undefined),
			commandTimeouts: new Map(),
			setTimeout: (callback: () => void) => {
				const id = nextId++;
				timeouts.set(id, callback);
				return id;
			},
			clearTimeout: vi.fn((id: number) => timeouts.delete(id))
		});

		const execute = vi.spyOn(adapter as any, "executeSceneProgram").mockResolvedValue(undefined);
		return { adapter, execute, timeouts };
	}

	it("runs the program the button belongs to", async () => {
		const { adapter, execute } = await createButtonAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.programs.7085747.start", { val: true, ack: false });

		expect(execute).toHaveBeenCalledWith("duid1", "7085747");
	});

	it("schedules the reset that clears the button", async () => {
		// Through the shared helper, so the timer is in the map `onUnload` empties.
		const { adapter, timeouts } = await createButtonAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.programs.7085747.start", { val: true, ack: false });

		expect(timeouts.size).toBe(1);
	});

	it("ignores the acknowledged reset back to false", async () => {
		const { adapter, execute } = await createButtonAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.programs.7085747.start", { val: false, ack: true });

		expect(execute).not.toHaveBeenCalled();
	});

	it("ignores a write of false", async () => {
		const { adapter, execute } = await createButtonAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.programs.7085747.start", { val: false, ack: false });

		expect(execute).not.toHaveBeenCalled();
	});

	it("leaves the collective select to its own path", async () => {
		// `programs.startProgram` is one level higher and carries the id as its value; it must not be
		// caught by the branch that reads the id out of the object path.
		const { adapter, execute } = await createButtonAdapter();

		await adapter.onStateChange("roborock.0.Devices.duid1.programs.startProgram", { val: "7085747", ack: false });

		// It reaches `handleCommand`, which needs the feature handler - not this branch.
		expect(execute).toHaveBeenCalledWith("duid1", "7085747");
	});
});
