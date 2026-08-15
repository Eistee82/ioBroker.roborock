import { beforeEach, describe, expect, it, vi } from "vitest";
import { socketHandler } from "./socketHandler";

interface FakeHandler {
	hasCommandFolder: (folder: string) => boolean;
	getCommandSpec: (folder: string, command: string) => unknown;
}

function createAdapter(overrides: Record<string, unknown> = {}) {
	const commandSpecs: Record<string, Record<string, unknown>> = {
		commands: {
			set_custom_mode: { type: "number", states: { 101: "Quiet", 102: "Balanced" } },
			set_clean_repeat_times: { type: "number", min: 1, max: 2, states: { 1: "1x", 2: "2x" } },
			app_start: { type: "boolean", role: "button" },
			set_water_box_distance_off: { type: "number", min: 1, max: 30 }
		},
		dockCommands: {
			app_start_wash: { type: "boolean", role: "button" }
		}
	};

	const handler: FakeHandler = {
		hasCommandFolder: (folder: string) => Object.prototype.hasOwnProperty.call(commandSpecs, folder),
		getCommandSpec: (folder: string, command: string) => commandSpecs[folder]?.[command]
	};

	const adapter = {
		namespace: "roborock.0",
		language: "de",
		translations: { app_start: "Start" },
		deviceFeatureHandlers: new Map<string, FakeHandler>([["duid1", handler]]),
		requestsHandler: { command: vi.fn().mockResolvedValue(undefined) },
		handleFloorSwitch: vi.fn().mockResolvedValue(undefined),
		getObjectAsync: vi.fn().mockResolvedValue({ common: { states: { 0: "Ground floor", 1: "First floor" } } }),
		setState: vi.fn().mockResolvedValue(undefined),
		sendTo: vi.fn(),
		rLog: vi.fn(),
		catchError: vi.fn(),
		errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
		...overrides
	};

	return adapter;
}

/** Runs one sendTo message through the handler and returns what was answered to the caller. */
async function send(adapter: ReturnType<typeof createAdapter>, command: string, message: unknown): Promise<any> {
	const instance = new socketHandler(adapter as any);
	await instance.handleMessage({
		command,
		message,
		from: "system.adapter.web.0",
		callback: { id: 1 }
	} as any);

	const call = adapter.sendTo.mock.calls.at(-1);
	return call?.[2];
}

describe("socketHandler", () => {
	let adapter: ReturnType<typeof createAdapter>;

	beforeEach(() => {
		adapter = createAdapter();
	});

	describe("app_segment_clean", () => {
		it("forwards the selected room ids to the device handler", async () => {
			const result = await send(adapter, "app_segment_clean", { duid: "duid1", segments: [16, "17"] });

			expect(result).toEqual({ result: "ok" });
			expect(adapter.requestsHandler.command).toHaveBeenCalledWith(expect.anything(), "duid1", "app_segment_clean", [16, 17], "1");
		});

		it("rejects an empty room selection", async () => {
			const result = await send(adapter, "app_segment_clean", { duid: "duid1", segments: [] });

			expect(result.error).toMatch(/non-empty 'segments'/);
			expect(adapter.requestsHandler.command).not.toHaveBeenCalled();
		});

		it("rejects unknown devices", async () => {
			const result = await send(adapter, "app_segment_clean", { duid: "nope", segments: [1] });

			expect(result.error).toMatch(/No handler for DUID/);
		});
	});

	describe("load_multi_map", () => {
		it("switches to a map flag the adapter published", async () => {
			const result = await send(adapter, "load_multi_map", { duid: "duid1", mapFlag: 1 });

			expect(result).toEqual({ result: "ok" });
			expect(adapter.handleFloorSwitch).toHaveBeenCalledWith("duid1", 1, "Devices.duid1.floors.1.load");
		});

		it("rejects map flags that are not in the command object", async () => {
			const result = await send(adapter, "load_multi_map", { duid: "duid1", mapFlag: 7 });

			expect(result.error).toMatch(/Unknown map flag 7/);
			expect(adapter.handleFloorSwitch).not.toHaveBeenCalled();
		});

		it("rejects a missing map flag", async () => {
			const result = await send(adapter, "load_multi_map", { duid: "duid1" });

			expect(result.error).toMatch(/numeric 'mapFlag'/);
			expect(adapter.handleFloorSwitch).not.toHaveBeenCalled();
		});
	});

	describe("set_state security check", () => {
		it("writes a registered command unacknowledged", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "set_custom_mode", value: "102" });

			expect(result).toEqual({ result: "ok" });
			expect(adapter.setState).toHaveBeenCalledWith("Devices.duid1.commands.set_custom_mode", { val: 102, ack: false });
		});

		it("writes registered extra command folders too", async () => {
			await send(adapter, "set_state", { duid: "duid1", folder: "dockCommands", command: "app_start_wash", value: true });

			expect(adapter.setState).toHaveBeenCalledWith("Devices.duid1.dockCommands.app_start_wash", { val: true, ack: false });
		});

		it("refuses folders that are not command folders", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "deviceStatus", command: "battery", value: 5 });

			expect(result.error).toMatch(/is not a command folder/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("refuses unregistered commands inside a command folder", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "definitely_not_a_command", value: 1 });

			expect(result.error).toMatch(/Unregistered command/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("refuses path traversal in the target", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "../../../system.adapter.roborock.0", value: 1 });

			expect(result.error).toMatch(/illegal characters/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("refuses a foreign state id smuggled through the duid", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1.commands.app_start", folder: "commands", command: "app_start", value: true });

			expect(result.error).toMatch(/illegal characters/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("refuses values outside the declared range", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "set_water_box_distance_off", value: 99 });

			expect(result.error).toMatch(/above the allowed maximum/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("refuses values that are not part of the declared states", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "set_custom_mode", value: 999 });

			expect(result.error).toMatch(/is not allowed for this command/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("refuses a repeat count the adapter command does not allow", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "set_clean_repeat_times", value: 3 });

			expect(result.error).toMatch(/above the allowed maximum 2/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("accepts the repeat count the adapter allows", async () => {
			await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "set_clean_repeat_times", value: 2 });

			expect(adapter.setState).toHaveBeenCalledWith("Devices.duid1.commands.set_clean_repeat_times", { val: 2, ack: false });
		});

		it("refuses non numeric values for numeric commands", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands", command: "set_custom_mode", value: "loud" });

			expect(result.error).toMatch(/is not a number/);
			expect(adapter.setState).not.toHaveBeenCalled();
		});

		it("requires duid, folder and command", async () => {
			const result = await send(adapter, "set_state", { duid: "duid1", folder: "commands" });

			expect(result.error).toMatch(/requires 'duid', 'folder' and 'command'/);
		});
	});

	describe("reset_consumable security check", () => {
		/** Mimics the objects the consumable services publish under `resetConsumables`. */
		function createResetAdapter(objects: Record<string, unknown>) {
			return createAdapter({
				getObjectAsync: vi.fn(async (id: string) => objects[id] ?? null)
			});
		}

		const resetButton = {
			type: "state",
			common: { name: "Reset Main Brush", type: "boolean", role: "button", write: true }
		};

		it("presses a reset button the adapter published", async () => {
			const resetAdapter = createResetAdapter({ "Devices.duid1.resetConsumables.reset_main_brush": resetButton });

			const result = await send(resetAdapter, "reset_consumable", { duid: "duid1", consumable: "reset_main_brush" });

			expect(result).toEqual({ result: "ok" });
			expect(resetAdapter.setState).toHaveBeenCalledWith("Devices.duid1.resetConsumables.reset_main_brush", { val: true, ack: false });
		});

		it("refuses a reset button that does not exist", async () => {
			const resetAdapter = createResetAdapter({});

			const result = await send(resetAdapter, "reset_consumable", { duid: "duid1", consumable: "reset_nothing" });

			expect(result.error).toMatch(/is not a consumable reset button/);
			expect(resetAdapter.setState).not.toHaveBeenCalled();
		});

		it("refuses a state in the folder that is not a writable boolean button", async () => {
			const resetAdapter = createResetAdapter({
				"Devices.duid1.resetConsumables.reset_main_brush": { type: "state", common: { type: "number", role: "value", write: false } }
			});

			const result = await send(resetAdapter, "reset_consumable", { duid: "duid1", consumable: "reset_main_brush" });

			expect(result.error).toMatch(/is not a consumable reset button/);
			expect(resetAdapter.setState).not.toHaveBeenCalled();
		});

		it("refuses path traversal out of the reset folder", async () => {
			const resetAdapter = createResetAdapter({ "Devices.duid1.resetConsumables.reset_main_brush": resetButton });

			const result = await send(resetAdapter, "reset_consumable", { duid: "duid1", consumable: "../commands/app_start" });

			expect(result.error).toMatch(/illegal characters/);
			expect(resetAdapter.setState).not.toHaveBeenCalled();
		});

		it("refuses a foreign state id smuggled through the duid", async () => {
			const resetAdapter = createResetAdapter({ "Devices.duid1.resetConsumables.reset_main_brush": resetButton });

			const result = await send(resetAdapter, "reset_consumable", { duid: "duid1.resetConsumables.reset_main_brush", consumable: "reset_main_brush" });

			expect(result.error).toMatch(/illegal characters/);
			expect(resetAdapter.setState).not.toHaveBeenCalled();
		});

		it("rejects unknown devices", async () => {
			const resetAdapter = createResetAdapter({ "Devices.nope.resetConsumables.reset_main_brush": resetButton });

			const result = await send(resetAdapter, "reset_consumable", { duid: "nope", consumable: "reset_main_brush" });

			expect(result.error).toMatch(/No handler for DUID/);
			expect(resetAdapter.setState).not.toHaveBeenCalled();
		});

		it("requires duid and consumable", async () => {
			const result = await send(adapter, "reset_consumable", { duid: "duid1" });

			expect(result.error).toMatch(/requires 'duid' and 'consumable'/);
		});
	});

	describe("get_translations", () => {
		it("returns the adapter language and its loaded translations", async () => {
			const result = await send(adapter, "get_translations", {});

			expect(result).toEqual({ language: "de", translations: { app_start: "Start" } });
		});

		it("falls back to english when no language is configured", async () => {
			const result = await send(createAdapter({ language: undefined, translations: undefined }), "get_translations", {});

			expect(result).toEqual({ language: "en", translations: {} });
		});
	});

	describe("set_map_theme", () => {
		it("hands a reported theme to the adapter and answers with the resolved scheme", async () => {
			const themeAdapter = createAdapter({
				setReportedMapTheme: vi.fn().mockResolvedValue(undefined),
				getMapColorScheme: () => "dark"
			});

			const result = await send(themeAdapter, "set_map_theme", { theme: "dark" });

			expect((themeAdapter as unknown as { setReportedMapTheme: ReturnType<typeof vi.fn> }).setReportedMapTheme).toHaveBeenCalledWith("dark");
			expect(result).toEqual({ scheme: "dark" });
		});

		it("refuses anything that is not one of the two theme names", async () => {
			const themeAdapter = createAdapter({
				setReportedMapTheme: vi.fn().mockResolvedValue(undefined),
				getMapColorScheme: () => "light"
			});

			for (const theme of [undefined, "", "auto", "Dark", 1, true, { theme: "dark" }]) {
				const result = await send(themeAdapter, "set_map_theme", { theme });
				expect(result.error, String(theme)).toMatch(/'light' or 'dark'/);
			}
			expect((themeAdapter as unknown as { setReportedMapTheme: ReturnType<typeof vi.fn> }).setReportedMapTheme).not.toHaveBeenCalled();
		});
	});

	describe("set_room_selection", () => {
		/**
		 * A device with two floors. Floor 0 holds three rooms plus the metadata states the adapter
		 * publishes beside them; floor 1 holds a room with the very same id, which is the case the
		 * scoping has to survive.
		 */
		function createSelectionAdapter(overrides: Record<string, unknown> = {}) {
			const values: Record<string, { val: unknown }> = {
				"roborock.0.Devices.duid1.floors.0.16": { val: false },
				"roborock.0.Devices.duid1.floors.0.17": { val: true },
				"roborock.0.Devices.duid1.floors.0.18": { val: false },
				"roborock.0.Devices.duid1.floors.0.load": { val: false },
				"roborock.0.Devices.duid1.floors.0.name": { val: "Ground floor" },
				"roborock.0.Devices.duid1.floors.1.16": { val: false }
			};
			const roomSwitch = { type: "state", common: { type: "boolean", role: "switch", write: true } };

			return createAdapter({
				getStatesAsync: vi.fn(async (pattern: string) => {
					const prefix = pattern.replace(/\*$/, "");
					return Object.fromEntries(Object.entries(values).filter(([id]) => id.startsWith(prefix)));
				}),
				getObjectAsync: vi.fn(async () => roomSwitch),
				...overrides
			});
		}

		/** Ids the handler actually wrote, as `roomId -> value`. */
		function writes(adapter: ReturnType<typeof createAdapter>): Record<string, unknown> {
			return Object.fromEntries(adapter.setState.mock.calls.map((call: any[]) => [call[0], call[1].val]));
		}

		it("switches the picked rooms on and the rest of that floor off", async () => {
			const selectionAdapter = createSelectionAdapter();

			const result = await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 0, rooms: [16, "18"] });

			expect(result).toEqual({ result: "ok", mapFlag: 0, selected: [16, 18] });
			// 17 was on and is not picked any more; 16 and 18 change the other way. Unchanged
			// switches are not written at all, so a repaint is not triggered for nothing.
			expect(writes(selectionAdapter)).toEqual({
				"Devices.duid1.floors.0.16": true,
				"Devices.duid1.floors.0.17": false,
				"Devices.duid1.floors.0.18": true
			});
		});

		it("writes unacknowledged, which is what makes the adapter draw the map again", async () => {
			const selectionAdapter = createSelectionAdapter();

			await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 0, rooms: [16] });

			for (const call of selectionAdapter.setState.mock.calls) {
				expect(call[1]).toMatchObject({ ack: false });
			}
		});

		it("clears the floor when nothing is picked", async () => {
			const selectionAdapter = createSelectionAdapter();

			const result = await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 0, rooms: [] });

			expect(result).toEqual({ result: "ok", mapFlag: 0, selected: [] });
			expect(writes(selectionAdapter)).toEqual({ "Devices.duid1.floors.0.17": false });
		});

		it("never touches the metadata states below the same folder", async () => {
			const selectionAdapter = createSelectionAdapter();

			await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 0, rooms: [] });

			for (const call of selectionAdapter.setState.mock.calls) {
				expect(String(call[0])).not.toMatch(/\.(load|name|mapFlag|map_id|add_time)$/);
			}
		});

		it("leaves the rooms of other floors alone", async () => {
			const selectionAdapter = createSelectionAdapter();

			await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 0, rooms: [16] });

			for (const call of selectionAdapter.setState.mock.calls) {
				expect(String(call[0])).toContain("floors.0.");
			}
		});

		it("ignores a room id that does not exist on that floor", async () => {
			const selectionAdapter = createSelectionAdapter();

			const result = await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 0, rooms: [16, 99] });

			// The answer names the rooms that are really switched on, so an invented id is visibly
			// missing from it rather than silently confirmed.
			expect(result.selected).toEqual([16]);
			expect(writes(selectionAdapter)["Devices.duid1.floors.0.99"]).toBeUndefined();
		});

		it("refuses to write a state that is not a writable boolean the adapter published", async () => {
			const selectionAdapter = createSelectionAdapter({
				getObjectAsync: vi.fn(async () => ({ type: "state", common: { type: "string", write: true } }))
			});

			await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 0, rooms: [16] });

			expect(selectionAdapter.setState).not.toHaveBeenCalled();
		});

		it("rejects an unknown floor instead of creating one", async () => {
			const selectionAdapter = createSelectionAdapter();

			const result = await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag: 7, rooms: [16] });

			expect(result.error).toMatch(/Unknown map flag 7/);
			expect(selectionAdapter.setState).not.toHaveBeenCalled();
		});

		it("rejects a missing or non numeric floor", async () => {
			const selectionAdapter = createSelectionAdapter();

			for (const mapFlag of [undefined, null, "", "bogus", -1, 1.5]) {
				const result = await send(selectionAdapter, "set_room_selection", { duid: "duid1", mapFlag, rooms: [16] });
				expect(result.error, String(mapFlag)).toMatch(/numeric 'mapFlag'/);
			}
			expect(selectionAdapter.setState).not.toHaveBeenCalled();
		});

		it("rejects a duid that tries to escape the object path", async () => {
			const selectionAdapter = createSelectionAdapter();

			const result = await send(selectionAdapter, "set_room_selection", { duid: "../../system.adapter.admin.0", mapFlag: 0, rooms: [16] });

			expect(result.error).toMatch(/valid 'duid'/);
			expect(selectionAdapter.setState).not.toHaveBeenCalled();
		});

		it("rejects a device the adapter does not manage", async () => {
			const selectionAdapter = createSelectionAdapter();

			const result = await send(selectionAdapter, "set_room_selection", { duid: "unknown", mapFlag: 0, rooms: [16] });

			expect(result.error).toMatch(/No handler for DUID unknown/);
			expect(selectionAdapter.setState).not.toHaveBeenCalled();
		});
	});

	it("still rejects unknown commands", async () => {
		const result = await send(adapter, "definitely_unknown", {});

		expect(result).toEqual({ error: "Unknown command" });
	});
});
