import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * A boolean command can be a button or a switch, and until now the adapter treated both as buttons.
 *
 * The consequence was a switch that could only ever be turned **on**: `executeCommand` dropped every
 * falsy write, and one second later the state was reset to `false` anyway. Nineteen commands were
 * affected - the a179 set around `set_child_lock_status`, `set_collision_avoid_status` and
 * `set_flow_led_status`, plus `child_lock`, `carpet_turbo`, `light_mode` and `green_laser` on B01,
 * the last two declared `def: true`, i.e. a switch that starts on and cannot be switched off.
 *
 * The test that decides is the declared role. These tests pin both halves: a switch sends both of
 * its positions and keeps them, and everything that is not declared a switch behaves exactly as
 * before.
 */

interface Recorded {
	command: ReturnType<typeof vi.fn>;
	setState: ReturnType<typeof vi.fn>;
	states: Map<string, Record<string, unknown>>;
	timeouts: (() => void)[];
}

/**
 * Builds an adapter whose only registered command is the one under test.
 * @param spec Command definition as a feature handler would register it.
 */
async function createAdapter(spec: Record<string, unknown>): Promise<{ adapter: any; recorded: Recorded }> {
	const { Roborock } = await import("../../src/main");
	const recorded: Recorded = {
		command: vi.fn().mockResolvedValue(undefined),
		setState: vi.fn().mockResolvedValue(undefined),
		states: new Map<string, Record<string, unknown>>(),
		timeouts: []
	};

	const handler = {
		protocolVersion: "1.0",
		hasCommandFolder: vi.fn().mockReturnValue(true),
		getCommandSpec: vi.fn().mockReturnValue(spec)
	};

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		deviceFeatureHandlers: new Map([["duid1", handler]]),
		requestsHandler: { command: recorded.command },
		commandTimeouts: new Map(),
		rLog: vi.fn(),
		catchError: vi.fn(),
		setState: recorded.setState,
		// The button reset reads the state again, to carry a failure mark along; see setResetTimeout.
		getStateAsync: vi.fn(async (id: string) => recorded.states.get(id) ?? null),
		// The reset is what makes a switch snap back, so the test has to see whether one is armed.
		setTimeout: vi.fn((callback: () => void) => {
			recorded.timeouts.push(callback);
			return recorded.timeouts.length;
		}),
		clearTimeout: vi.fn()
	});

	return { adapter, recorded };
}

/** Lets the asynchronous part of the button reset run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Writes a value into the state of the registered command, unacknowledged. */
async function write(adapter: any, folder: string, command: string, value: unknown): Promise<void> {
	await adapter.onStateChange(`roborock.0.Devices.duid1.${folder}.${command}`, { val: value, ack: false });
}

/**
 * Where a command came from, as `executeCommand` passes it on since command outcomes are marked on
 * the command state: the exact state the write arrived on, and the folder it lives in.
 */
const ORIGIN = (folder: string, command: string) => ({ stateId: `roborock.0.Devices.duid1.${folder}.${command}`, folder });

describe("a boolean command declared as a switch", () => {
	const SWITCH = { type: "boolean", role: "switch.enable", name: "Child Lock", def: false };

	it("sends the on position", async () => {
		const { adapter, recorded } = await createAdapter(SWITCH);
		await write(adapter, "settings", "set_child_lock_status", true);

		expect(recorded.command).toHaveBeenCalledWith(expect.anything(), "duid1", "set_child_lock_status", true, undefined, ORIGIN("settings", "set_child_lock_status"));
	});

	it("sends the off position too - the whole point of the change", async () => {
		const { adapter, recorded } = await createAdapter(SWITCH);
		await write(adapter, "settings", "set_child_lock_status", false);

		expect(recorded.command).toHaveBeenCalledWith(expect.anything(), "duid1", "set_child_lock_status", false, undefined, ORIGIN("settings", "set_child_lock_status"));
	});

	it("keeps its position instead of being reset a second later", async () => {
		const { adapter, recorded } = await createAdapter(SWITCH);
		await write(adapter, "settings", "set_child_lock_status", true);

		expect(recorded.timeouts).toHaveLength(0);
	});

	it("treats the plain switch role the same way", async () => {
		const { adapter, recorded } = await createAdapter({ type: "boolean", role: "switch", name: "Child Lock" });
		await write(adapter, "commands", "child_lock", false);

		expect(recorded.command).toHaveBeenCalledWith(expect.anything(), "duid1", "child_lock", false, undefined, ORIGIN("commands", "child_lock"));
	});

	it("accepts the string spellings a script may write", async () => {
		const { adapter, recorded } = await createAdapter(SWITCH);
		await write(adapter, "settings", "set_child_lock_status", "true");
		expect(recorded.command).toHaveBeenLastCalledWith(expect.anything(), "duid1", "set_child_lock_status", true, undefined, ORIGIN("settings", "set_child_lock_status"));

		await write(adapter, "settings", "set_child_lock_status", "false");
		expect(recorded.command).toHaveBeenLastCalledWith(expect.anything(), "duid1", "set_child_lock_status", false, undefined, ORIGIN("settings", "set_child_lock_status"));
	});
});

describe("everything that is not declared a switch keeps its old behaviour", () => {
	it("a button still fires only when it is pressed", async () => {
		const { adapter, recorded } = await createAdapter({ type: "boolean", role: "button", name: "Start", def: false });

		await write(adapter, "commands", "app_start", false);
		expect(recorded.command).not.toHaveBeenCalled();

		await write(adapter, "commands", "app_start", true);
		expect(recorded.command).toHaveBeenCalledWith(expect.anything(), "duid1", "app_start", undefined, undefined, ORIGIN("commands", "app_start"));
	});

	it("a button is still reset after it was pressed", async () => {
		const { adapter, recorded } = await createAdapter({ type: "boolean", role: "button", name: "Start", def: false });
		await write(adapter, "commands", "app_start", true);

		expect(recorded.timeouts).toHaveLength(1);
		recorded.timeouts[0]();
		await settle();
		expect(recorded.setState).toHaveBeenCalledWith("roborock.0.Devices.duid1.commands.app_start", { val: false, ack: true });
	});

	it("a button that failed springs back and keeps saying why", async () => {
		// The reset used to write `ack: true` and nothing else, out of a `finally` that runs whether
		// the command worked or threw - the one place in the adapter that claimed a confirmation
		// which did not exist. The button still has to spring back, but it carries the truth now.
		const { adapter, recorded } = await createAdapter({ type: "boolean", role: "button", name: "Start", def: false });
		const id = "roborock.0.Devices.duid1.commands.app_start";
		recorded.states.set(id, { val: true, ack: false, q: 0x42, c: "{\"m\":\"no connection\",\"k\":\"ui_cmdres_unreachable\",\"a\":[\"app_start\"]}" });

		await write(adapter, "commands", "app_start", true);
		recorded.timeouts[0]();
		await settle();

		expect(recorded.setState).toHaveBeenCalledWith(id, {
			val: false,
			ack: true,
			q: 0x42,
			c: "{\"m\":\"no connection\",\"k\":\"ui_cmdres_unreachable\",\"a\":[\"app_start\"]}"
		});
	});

	it("a boolean without any role stays the button it always was", async () => {
		// Deliberately unchanged: the rule reads the declared role and nothing else, so a
		// definition that never said "switch" cannot start behaving like one.
		const { adapter, recorded } = await createAdapter({ type: "boolean", name: "Something", def: false });

		await write(adapter, "commands", "something", false);
		expect(recorded.command).not.toHaveBeenCalled();

		await write(adapter, "commands", "something", true);
		expect(recorded.command).toHaveBeenCalledWith(expect.anything(), "duid1", "something", undefined, undefined, ORIGIN("commands", "something"));
		expect(recorded.timeouts).toHaveLength(1);
	});

	it("a value command still passes its value through", async () => {
		const { adapter, recorded } = await createAdapter({ type: "number", role: "level", name: "Suction" });
		await write(adapter, "commands", "set_custom_mode", 104);

		expect(recorded.command).toHaveBeenCalledWith(expect.anything(), "duid1", "set_custom_mode", 104, undefined, ORIGIN("commands", "set_custom_mode"));
		expect(recorded.timeouts).toHaveLength(0);
	});

	it("a text command still passes its text through", async () => {
		const { adapter, recorded } = await createAdapter({ type: "string", role: "text", name: "Do Not Disturb" });
		await write(adapter, "settings", "set_dnd_timer", "22:00-07:00");

		expect(recorded.command).toHaveBeenCalledWith(expect.anything(), "duid1", "set_dnd_timer", "22:00-07:00", undefined, ORIGIN("settings", "set_dnd_timer"));
	});
});
