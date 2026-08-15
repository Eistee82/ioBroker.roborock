import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * The outcome of a command is written onto the command state itself - there is no second channel.
 *
 * These tests pin the three decisions that were argued out before the code was written:
 *
 * 1. A failure keeps `ack: false`. `ack: true` means "this is how it is", and a command that failed
 *    has no such value. The quality and the comment carry the failure instead.
 * 2. Writing that back must not be read as a new command. `onStateChange` treats every
 *    unacknowledged write as a command, so without a guard the adapter would send itself in a
 *    circle for ever.
 * 3. A success **clears** the mark, explicitly. `processStatus` mirrors the status with
 *    `setStateChanged`, which writes nothing when the value did not change - so a mark nobody
 *    cleared would stand for ever.
 */

interface Written {
	id: string;
	state: Record<string, unknown>;
}

async function createAdapter(options: { commands?: Record<string, Record<string, unknown>>; states?: Record<string, Record<string, unknown>> } = {}) {
	const { Roborock } = await import("../../src/main");

	const commands = options.commands ?? { commands: { set_custom_mode: { type: "number", role: "level" } } };
	const states = new Map<string, Record<string, unknown>>(Object.entries(options.states ?? {}));
	const written: Written[] = [];

	const handler = {
		protocolVersion: "1.0",
		hasCommandFolder: (folder: string) => Object.prototype.hasOwnProperty.call(commands, folder),
		getCommandFolders: () => Object.keys(commands),
		getCommandSpec: (folder: string, command: string) => commands[folder]?.[command],
	};

	const adapter = Object.assign(Object.create(Roborock.prototype), {
		deviceFeatureHandlers: new Map([["duid1", handler]]),
		requestsHandler: { command: vi.fn().mockResolvedValue(undefined) },
		commandTimeouts: new Map(),
		rLog: vi.fn(),
		catchError: vi.fn(),
		errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e)),
		getStateAsync: vi.fn(async (id: string) => states.get(id) ?? null),
		setState: vi.fn(async (id: string, state: Record<string, unknown>) => {
			written.push({ id, state });
		}),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
	});

	return { adapter, written, states, handler };
}

const STATE_ID = "roborock.0.Devices.duid1.commands.set_custom_mode";

describe("marking a command state with what became of the command", () => {
	it("leaves the quality and the reason, without touching the value or ack", async () => {
		const { adapter, written } = await createAdapter({ states: { [STATE_ID]: { val: 104, ack: false, q: 0 } } });

		await adapter.markCommandOutcome("duid1", { command: "set_custom_mode", outcome: "unreachable", stateId: STATE_ID, folder: "commands" });

		expect(written).toHaveLength(1);
		expect(written[0].state).toMatchObject({ val: 104, ack: false, q: 0x42 });
		expect(JSON.parse(written[0].state.c as string)).toMatchObject({ k: "ui_cmdres_unreachable", a: ["set_custom_mode"] });
	});

	it("does not turn an acknowledged state back into an unacknowledged one", async () => {
		// A button that has already sprung back to false is telling the truth about itself; only the
		// reason for the failed press is added.
		const { adapter, written } = await createAdapter({ states: { [STATE_ID]: { val: false, ack: true, q: 0 } } });

		await adapter.markCommandOutcome("duid1", { command: "set_custom_mode", outcome: "rejected", stateId: STATE_ID, detail: "[\"nope\"]" });

		expect(written[0].state).toMatchObject({ val: false, ack: true, q: 0x44 });
	});

	it("clears a mark from an earlier attempt when a command works", async () => {
		// setStateChanged would not: with an unchanged value it compares nothing and writes nothing.
		const { adapter, written } = await createAdapter({ states: { [STATE_ID]: { val: 104, ack: true, q: 0x42, c: "old" } } });

		await adapter.markCommandOutcome("duid1", { command: "set_custom_mode", outcome: "accepted", stateId: STATE_ID });

		expect(written).toHaveLength(1);
		expect(written[0].state).toEqual({ val: 104, ack: true, q: 0x00, c: "" });
	});

	it("writes nothing when a command works and there was nothing to clear", async () => {
		const { adapter, written } = await createAdapter({ states: { [STATE_ID]: { val: 104, ack: true, q: 0 } } });

		await adapter.markCommandOutcome("duid1", { command: "set_custom_mode", outcome: "accepted", stateId: STATE_ID });

		expect(written).toHaveLength(0);
	});

	it("finds the command state by name when the command never touched one", async () => {
		// The three driving commands go straight down a socket message, but their command objects
		// exist - so this is where their outcome shows up.
		const { adapter, written } = await createAdapter({
			commands: { commands: { app_segment_clean: { type: "boolean", role: "button" } } },
			states: { "Devices.duid1.commands.app_segment_clean": { val: true, ack: false } }
		});

		await adapter.markCommandOutcome("duid1", { command: "app_segment_clean", outcome: "no_answer" });

		expect(written[0].id).toBe("Devices.duid1.commands.app_segment_clean");
		expect(written[0].state).toMatchObject({ q: 0x01 });
	});

	it("searches the other command folders when the named one does not declare it", async () => {
		const { adapter, written } = await createAdapter({
			commands: { commands: {}, settings: { set_child_lock_status: { type: "boolean", role: "switch" } } },
			states: { "Devices.duid1.settings.set_child_lock_status": { val: true, ack: false } }
		});

		await adapter.markCommandOutcome("duid1", { command: "set_child_lock_status", outcome: "rejected", folder: "commands" });

		expect(written[0].id).toBe("Devices.duid1.settings.set_child_lock_status");
	});

	it("writes nothing when the command has no state of its own", async () => {
		const { adapter, written } = await createAdapter();

		await adapter.markCommandOutcome("duid1", { command: "some_internal_call", outcome: "error", detail: "boom" });

		expect(written).toHaveLength(0);
	});

	it("writes nothing when the state does not exist yet", async () => {
		// Creating one here would add an object no feature handler declared.
		const { adapter, written } = await createAdapter();

		await adapter.markCommandOutcome("duid1", { command: "set_custom_mode", outcome: "error", stateId: STATE_ID });

		expect(written).toHaveLength(0);
	});

	it("says nothing while the adapter is shutting down", async () => {
		const { adapter, written } = await createAdapter({ states: { [STATE_ID]: { val: 104, ack: false } } });
		(adapter as any).shuttingDown = true;

		await adapter.markCommandOutcome("duid1", { command: "set_custom_mode", outcome: "unreachable", stateId: STATE_ID });

		expect(written).toHaveLength(0);
	});

	it("never throws, whatever goes wrong while marking", async () => {
		// A command must not fail because its outcome could not be noted, and it must not fail twice.
		const { adapter, written } = await createAdapter({ states: { [STATE_ID]: { val: 104, ack: false } } });
		adapter.setState = vi.fn(async () => { throw new Error("states db closed"); });

		await expect(adapter.markCommandOutcome("duid1", { command: "set_custom_mode", outcome: "unreachable", stateId: STATE_ID })).resolves.toBeUndefined();
		expect(written).toHaveLength(0);
	});
});

describe("the mark is not read back as a new command", () => {
	it("ignores an unacknowledged write that already carries a quality", async () => {
		// Without this the adapter would answer its own failure note with the same command, for ever.
		const { adapter } = await createAdapter();

		await adapter.onStateChange(STATE_ID, { val: 104, ack: false, q: 0x42, c: "{\"k\":\"ui_cmdres_unreachable\"}" });

		expect(adapter.requestsHandler.command).not.toHaveBeenCalled();
	});

	it("still runs a command that arrives with a good quality", async () => {
		// The states database resets `q` to 0 on any write that does not name one, so this is what
		// every genuine command looks like - from a script, from vis or from the object view.
		const { adapter } = await createAdapter();

		await adapter.onStateChange(STATE_ID, { val: 104, ack: false, q: 0 });
		await adapter.onStateChange(STATE_ID, { val: 103, ack: false });

		expect(adapter.requestsHandler.command).toHaveBeenCalledTimes(2);
	});
});
