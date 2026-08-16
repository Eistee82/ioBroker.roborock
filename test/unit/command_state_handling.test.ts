import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

describe("command state handling", () => {
	async function createSceneAdapter(sceneParam: string, sendRequest: ReturnType<typeof vi.fn>, commandSpy: ReturnType<typeof vi.fn>) {
		const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
		const { Roborock } = await import("../../src/main");
		const handler = { protocolVersion: "L01" };
		const states = new Map<string, unknown>();
		const setState = vi.fn().mockImplementation(async (id: string, value: { val?: unknown } | unknown) => {
			states.set(id, value && typeof value === "object" && "val" in value ? value.val : value);
		});
		const getStateAsync = vi.fn().mockImplementation(async (id: string) => states.has(id) ? { val: states.get(id) } : null);

		return {
			adapter: Object.assign(Object.create(Roborock.prototype), {
				activeSceneQueueProcessors: new Set<string>(),
				config: { sceneExecutionMode: "local" },
				deviceFeatureHandlers: new Map([["duid1", handler]]),
				ensuredSceneQueueStates: new Set<string>(),
				ensureFolder: vi.fn().mockResolvedValue(undefined),
				ensureState: vi.fn().mockResolvedValue(undefined),
				getStateAsync,
				http_api: {
					getScenes: vi.fn().mockResolvedValue({
						result: [{
							id: 23,
							name: "Multi Step Program",
							param: sceneParam
						}]
					})
				},
				requestsHandler: {
					command: commandSpy,
					sendRequest
				},
				rLog: vi.fn(),
				setState,
				errorMessage
			}),
			handler
		};
	}

	async function drainSceneQueue(adapter: { activeSceneQueueProcessors: Set<string> }): Promise<void> {
		for (let attempt = 0; attempt < 20 && adapter.activeSceneQueueProcessors.size > 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	it("ignores stale command states that are no longer registered", async () => {
		const { Roborock } = await import("../../src/main");
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const handler = {
			protocolVersion: "1.0",
			hasCommandFolder: vi.fn().mockReturnValue(true),
			getCommandSpec: vi.fn().mockReturnValue(undefined)
		};
		const adapter = Object.assign(Object.create(Roborock.prototype), {
			deviceFeatureHandlers: new Map([["duid1", handler]]),
			requestsHandler: { command: commandSpy },
			rLog: vi.fn(),
			catchError: vi.fn()
		});

		await adapter.onStateChange("roborock.0.Devices.duid1.commands.app_start_dust_collection", {
			val: true,
			ack: false
		});

		expect(handler.getCommandSpec).toHaveBeenCalledWith("commands", "app_start_dust_collection");
		expect(commandSpy).not.toHaveBeenCalled();
		expect(adapter.catchError).not.toHaveBeenCalled();
	}, 10000);

	it("starts scene programs with the full cmd_ids payload resolved from app_get_program", async () => {
		const cmdIds = [
			{ id: 11, cmd_id: "sound", value: "code_mode_process_9" },
			{ id: 12, cmd_id: "arm_out" }
		];
		const sceneParam = JSON.stringify({
			action: {
				items: [{
					id: "scene-item-1",
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({
						method: "app_start_program",
						params: JSON.stringify({ program_id: 7 })
					})
				}]
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({ result: { program_id: 7, cmd_ids: cmdIds } });
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter, handler } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		expect(sendRequest).toHaveBeenCalledWith("duid1", "app_get_program", { program_id: 7 });
		expect(commandSpy).toHaveBeenCalledWith(handler, "duid1", "app_start_program", { cmd_ids: cmdIds });
	});

	it("uses complete scene cmd_ids directly when they are already present", async () => {
		const cmdIds = [
			{ id: 11, cmd_id: "sound", value: "code_mode_process_9" },
			{ id: 12, cmd_id: "arm_out" }
		];
		const sceneParam = JSON.stringify({
			action: {
				items: [{
					id: "scene-item-1",
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({
						method: "app_start_program",
						params: { program_id: 7, cmd_ids: cmdIds }
					})
				}]
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({ result: { program_id: 7, cmd_ids: [] } });
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter, handler } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		expect(sendRequest).not.toHaveBeenCalled();
		expect(commandSpy).toHaveBeenCalledWith(handler, "duid1", "app_start_program", { cmd_ids: cmdIds });
	});

	it("runs multi-step do_scenes_segments scene actions as single-task requests and waits between them", async () => {
		const tasks = [
			{ tid: "1780688479002", segs: [{ sid: 1 }], map_flag: 0, fan_power: 108, water_box_mode: 200, mop_mode: 303, repeat: 1 },
			{ tid: "1780688480859", segs: [{ sid: 2 }], map_flag: 0, fan_power: 108, water_box_mode: 200, mop_mode: 303, repeat: 2 },
			{ tid: "1780688482671", segs: [{ sid: 1 }], map_flag: 0, fan_power: 105, water_box_mode: 250, mop_mode: 303, repeat: 1 },
			{ tid: "1780688484498", segs: [{ sid: 2 }], map_flag: 0, fan_power: 105, water_box_mode: 250, mop_mode: 303, repeat: 2 }
		];
		const sceneParam = JSON.stringify({
			action: {
				items: tasks.map((task, index) => ({
					id: `scene-item-${index}`,
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({
						method: "do_scenes_segments",
						params: { data: [task], source: 101 }
					})
				}))
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({});
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter, handler } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);
		const waitSpy = vi.spyOn(adapter as any, "waitForSceneRunReadyForNext").mockResolvedValue("ready");

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		expect(commandSpy).toHaveBeenCalledTimes(4);
		for (const [index, task] of tasks.entries()) {
			expect(commandSpy).toHaveBeenNthCalledWith(index + 1, handler, "duid1", "do_scenes_segments", {
				data: [task],
				source: 101
			});
		}
		expect(waitSpy).toHaveBeenCalledTimes(4);
		expect(sendRequest).not.toHaveBeenCalled();
	});

	it("splits multi-entry do_scenes_segments payloads before sending them to the robot", async () => {
		const tasks = [
			{ tid: "task-0", segs: [{ sid: 1 }] },
			{ tid: "task-1", segs: [{ sid: 2 }] }
		];
		const sceneParam = JSON.stringify({
			action: {
				items: [{
					id: "scene-item-1",
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({
						method: "do_scenes_segments",
						params: {
							data: tasks,
							source: 101
						}
					})
				}]
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({});
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter, handler } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);
		const waitSpy = vi.spyOn(adapter as any, "waitForSceneRunReadyForNext").mockResolvedValue("ready");

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		expect(commandSpy).toHaveBeenCalledTimes(2);
		expect(commandSpy).toHaveBeenNthCalledWith(1, handler, "duid1", "do_scenes_segments", {
			data: [tasks[0]],
			source: 101
		});
		expect(commandSpy).toHaveBeenNthCalledWith(2, handler, "duid1", "do_scenes_segments", {
			data: [tasks[1]],
			source: 101
		});
		expect(waitSpy).toHaveBeenCalledTimes(2);
		expect(sendRequest).not.toHaveBeenCalled();
	});

	it("preserves do_scenes_segments metadata while sequencing scene actions", async () => {
		const sceneParam = JSON.stringify({
			action: {
				items: [101, 102].map((source, index) => ({
					id: `scene-item-${index}`,
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({
						method: "do_scenes_segments",
						params: {
							data: [{ tid: `task-${index}`, segs: [{ sid: index + 1 }] }],
							source
						}
					})
				}))
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({});
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter, handler } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);
		const waitSpy = vi.spyOn(adapter as any, "waitForSceneRunReadyForNext").mockResolvedValue("ready");

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		expect(commandSpy).toHaveBeenCalledTimes(2);
		expect(commandSpy).toHaveBeenNthCalledWith(1, handler, "duid1", "do_scenes_segments", {
			data: [{ tid: "task-0", segs: [{ sid: 1 }] }],
			source: 101
		});
		expect(commandSpy).toHaveBeenNthCalledWith(2, handler, "duid1", "do_scenes_segments", {
			data: [{ tid: "task-1", segs: [{ sid: 2 }] }],
			source: 102
		});
		expect(waitSpy).toHaveBeenCalledTimes(2);
	});

	it("does not start scene programs with a raw program_id when cmd_ids cannot be resolved", async () => {
		const sceneParam = JSON.stringify({
			action: {
				items: [{
					id: "scene-item-1",
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({
						method: "app_start_program",
						params: { program_id: 7 }
					})
				}]
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({ result: { program_id: 7 } });
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		expect(sendRequest).toHaveBeenCalledWith("duid1", "app_get_program", { program_id: 7 });
		expect(commandSpy).not.toHaveBeenCalled();
	});

	/**
	 * Builds a scene whose action items are sent verbatim, and reports for every wait how many
	 * commands had already gone out at that moment. That is what proves the wait sits *between*
	 * the steps rather than being called at some point.
	 * @param items Method and params per scene step.
	 */
	async function runSceneSteps(items: { method: string; params: unknown }[]) {
		const sceneParam = JSON.stringify({
			action: {
				items: items.map((item, index) => ({
					id: `scene-item-${index}`,
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({ method: item.method, params: item.params })
				}))
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({});
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter, handler } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);
		const commandsSentBeforeWait: number[] = [];
		const waitSpy = vi.spyOn(adapter as any, "waitForSceneRunReadyForNext").mockImplementation(async () => {
			commandsSentBeforeWait.push(commandSpy.mock.calls.length);
			return "ready";
		});

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		return { adapter, handler, commandSpy, waitSpy, commandsSentBeforeWait };
	}

	// The user's fifth scene, "Saugen, dann Wischen" (id 4841021): two whole-home runs on one
	// device, vacuum first and mop second. Both steps are do_scenes_app_start, so before this was
	// fixed both fell through the wait condition and the mop run went out on the heels of the
	// vacuum run. Raw definition in _appanalysis/szenen-roh.json.
	it("waits between the two do_scenes_app_start steps of a vacuum-then-mop scene", async () => {
		const vacuum = { fan_power: 108, water_box_mode: 200, mop_mode: 300, mop_template_id: 300, repeat: 1, auto_dustCollection: 1, source: 101 };
		const mop = { fan_power: 105, water_box_mode: 203, mop_mode: 300, mop_template_id: 300, repeat: 1, auto_dustCollection: 1, source: 101 };
		const { handler, commandSpy, waitSpy, commandsSentBeforeWait } = await runSceneSteps([
			{ method: "do_scenes_app_start", params: [vacuum] },
			{ method: "do_scenes_app_start", params: [mop] }
		]);

		expect(commandSpy).toHaveBeenCalledTimes(2);
		expect(commandSpy).toHaveBeenNthCalledWith(1, handler, "duid1", "do_scenes_app_start", [vacuum]);
		expect(commandSpy).toHaveBeenNthCalledWith(2, handler, "duid1", "do_scenes_app_start", [mop]);
		// One wait after the first run, one after the second - the final run is seen through to its
		// end as well, otherwise the queue would report the scene as done while the robot still mops.
		expect(commandsSentBeforeWait).toEqual([1, 2]);
		expect(waitSpy).toHaveBeenNthCalledWith(1, "duid1", "do_scenes_app_start");
	});

	it("waits between multi-step do_scenes_zones runs", async () => {
		const first = { data: [{ tid: "1767377550650", zones: [{ zid: 1, repeat: 1 }], map_flag: 0, fan_power: 108, water_box_mode: 200 }], source: 101 };
		const second = { data: [{ tid: "1767377550651", zones: [{ zid: 0, repeat: 1 }], map_flag: 0, fan_power: 104, water_box_mode: 203 }], source: 101 };
		const { handler, commandSpy, waitSpy, commandsSentBeforeWait } = await runSceneSteps([
			{ method: "do_scenes_zones", params: first },
			{ method: "do_scenes_zones", params: second }
		]);

		expect(commandSpy).toHaveBeenCalledTimes(2);
		expect(commandSpy).toHaveBeenNthCalledWith(1, handler, "duid1", "do_scenes_zones", first);
		expect(commandSpy).toHaveBeenNthCalledWith(2, handler, "duid1", "do_scenes_zones", second);
		expect(commandsSentBeforeWait).toEqual([1, 2]);
		expect(waitSpy).toHaveBeenNthCalledWith(1, "duid1", "do_scenes_zones");
	});

	it("does not wait after scene steps that start no cleaning run", async () => {
		const { commandSpy, waitSpy, commandsSentBeforeWait } = await runSceneSteps([
			{ method: "do_scenes_app_start", params: [{ fan_power: 108, source: 101 }] },
			{ method: "app_charge", params: [{ source: 101 }] }
		]);

		expect(commandSpy).toHaveBeenCalledTimes(2);
		// Only the cleaning run is waited out; `app_charge` is done when it has answered.
		expect(commandsSentBeforeWait).toEqual([1]);
		expect(waitSpy).toHaveBeenCalledTimes(1);
	});

	it("treats exactly the three do_scenes_* methods as cleaning runs", async () => {
		const { Roborock } = await import("../../src/main");
		const adapter = Object.create(Roborock.prototype);
		const isRun = (method: string): boolean => (adapter as any).isSceneRunMethod(method);

		for (const method of ["do_scenes_app_start", "do_scenes_segments", "do_scenes_zones"]) {
			expect(isRun(method)).toBe(true);
		}
		for (const method of ["app_start_program", "app_charge", "app_stop", "set_fan_power", ""]) {
			expect(isRun(method)).toBe(false);
		}
	});

	// Upstream issue #1318: the robot answered `ok` and then only passed through state 8 and the
	// dock states 22/33 - the run never began. So the start marker is the run state belonging to
	// the method, and the three methods have three different ones (RobotStateCodeMap:
	// 5 = CLEAN, 17 = ZONED_CLEAN, 18 = SEGMENT_CLEAN).
	it("accepts only the run state that belongs to the scene method as a start", async () => {
		const { Roborock } = await import("../../src/main");
		const adapter = Object.create(Roborock.prototype);
		const started = (state: number, method: string): boolean => (adapter as any).isSceneRunStartedStatus({ state }, method);

		expect(started(5, "do_scenes_app_start")).toBe(true);
		expect(started(17, "do_scenes_zones")).toBe(true);
		expect(started(18, "do_scenes_segments")).toBe(true);

		expect(started(18, "do_scenes_app_start")).toBe(false);
		expect(started(5, "do_scenes_segments")).toBe(false);
		expect(started(17, "do_scenes_segments")).toBe(false);
		for (const state of [8, 22, 33]) {
			expect(started(state, "do_scenes_app_start")).toBe(false);
		}

		// B01 publishes the same numbers under `status`.
		expect((adapter as any).isSceneRunStartedStatus({ status: 17 }, "do_scenes_zones")).toBe(true);
		// Without a state code at all, `in_cleaning` is the only marker left.
		expect((adapter as any).isSceneRunStartedStatus({ in_cleaning: 1 }, "do_scenes_app_start")).toBe(true);
		expect((adapter as any).isSceneRunStartedStatus({ in_cleaning: 0 }, "do_scenes_app_start")).toBe(false);
	});

	it("leaves the persisted queue untouched while the adapter unloads", async () => {
		const sceneParam = JSON.stringify({
			action: {
				items: [{
					id: "scene-item-0",
					type: "CMD",
					entityId: "duid1",
					param: JSON.stringify({ method: "do_scenes_app_start", params: [{ fan_power: 108, source: 101 }] })
				}]
			}
		});
		const sendRequest = vi.fn().mockResolvedValue({});
		const commandSpy = vi.fn().mockResolvedValue(undefined);
		const { adapter } = await createSceneAdapter(sceneParam, sendRequest, commandSpy);
		adapter.shuttingDown = true;

		await adapter.executeSceneLocal("duid1", 23);
		await drainSceneQueue(adapter);

		// `resumeSceneQueues` picks the queue up again after the restart.
		expect(commandSpy).not.toHaveBeenCalled();
	});
});
