import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandFeedbackSource } from "./commandFeedbackSource";
import { commandStatePatterns } from "./commandFeedback";
import type { CommandFeedbackNotice, CommandStateLike } from "./commandFeedback";
import type { EngineConnection } from "../engine/types";

/**
 * What the source announces, and - more importantly - what it keeps quiet about.
 *
 * A failure mark stays on the command state until the next attempt clears it, so subscribing
 * delivers history. Announcing that would show the user a failure they did not cause, at a moment
 * they did not act.
 */

const PATTERNS = commandStatePatterns("roborock.0", "duid1");
const STATE_ID = "roborock.0.Devices.duid1.commands.set_custom_mode";

/** A failed command as the adapter leaves it on the state. */
function failed(overrides: Partial<CommandStateLike> = {}): CommandStateLike {
	return {
		val: 102,
		ack: false,
		q: 0x44,
		c: JSON.stringify({
			m: "The robot rejected set_custom_mode and answered [\"unknown_method\"].",
			k: "ui_cmdres_rejected",
			a: ["set_custom_mode", "[\"unknown_method\"]"]
		}),
		ts: 5050,
		...overrides
	};
}

let live: CommandFeedbackSource | null = null;

afterEach(() => {
	live?.destroy();
	live = null;
});

function harness(initial?: CommandStateLike, now = 5000) {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();
	const notices: CommandFeedbackNotice[] = [];
	let clock = now;

	const connection: EngineConnection = {
		sendTo: vi.fn().mockResolvedValue({}),
		getObject: vi.fn().mockResolvedValue(null),
		getStates: vi.fn().mockResolvedValue({}),
		// Mirrors the real client: a wildcard subscription hands over the current value of everything
		// it matches before the first change arrives
		// (`@iobroker/socket-client/.../Connection.js:776-793`).
		subscribeState: vi.fn(async (id: string, handler: (id: string, state: any) => void) => {
			const list = subscriptions.get(id) ?? [];
			list.push(handler);
			subscriptions.set(id, list);
			await Promise.resolve();
			if (initial !== undefined && id.includes(".commands.")) handler(STATE_ID, initial);
		}),
		unsubscribeState: vi.fn((id: string, handler: (id: string, state: any) => void) => {
			const list = (subscriptions.get(id) ?? []).filter(entry => entry !== handler);
			if (list.length) subscriptions.set(id, list);
			else subscriptions.delete(id);
		}),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const source = new CommandFeedbackSource(connection, { onNotice: notice => notices.push(notice) }, () => clock);
	live = source;

	const push = (state: CommandStateLike | null, id: string = STATE_ID): void => {
		for (const [pattern, handlers] of subscriptions) {
			if (!pattern.includes(".commands.")) continue;
			for (const handler of handlers) handler(id, state);
		}
	};

	return {
		connection,
		source,
		notices,
		subscriptions,
		push,
		setNow: (value: number) => { clock = value; },
	};
}

/** Lets the subscribe promises inside `setDevice` settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("the command feedback source", () => {
	it("watches every folder the tab can write a command to", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		for (const pattern of PATTERNS) {
			expect(h.connection.subscribeState).toHaveBeenCalledWith(pattern, expect.any(Function));
		}
	});

	it("never subscribes to the whole device - that would pull the map data along", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		for (const pattern of PATTERNS) expect(pattern).not.toBe("roborock.0.Devices.duid1.*");
	});

	it("watches nothing without a device", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "");
		await settle();

		expect(h.connection.subscribeState).not.toHaveBeenCalled();
	});

	it("announces a failure that arrives", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		h.setNow(5100);
		h.push(failed());

		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toMatchObject({ severity: "error", messageKey: "ui_cmdres_rejected", stateId: STATE_ID, quality: 0x44 });
	});

	it("shows the two outcomes nobody can be sure about as a warning", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		h.setNow(5100);
		h.push(failed({ q: 0x01, c: JSON.stringify({ m: "no answer", k: "ui_cmdres_no_answer", a: ["set_custom_mode"] }) }));

		expect(h.notices[0].severity).toBe("warning");
	});

	it("keeps quiet about the mark that was already on the state", async () => {
		// Opening the tab is not a command, and the last failure may be hours old.
		const h = harness(failed({ ts: 4000 }));
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		expect(h.notices).toHaveLength(0);
	});

	it("keeps quiet about the same mark delivered twice", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		h.setNow(5100);
		h.push(failed());
		h.push(failed());

		expect(h.notices).toHaveLength(1);
	});

	it("announces the next failure on a state whose mark was cleared in between", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		h.setNow(5100);
		h.push(failed({ ts: 5050 }));
		// The clearing write bumps the timestamp; forgetting it is what lets the next mark through.
		h.push({ val: 102, ack: true, q: 0, ts: 5060 });
		h.push(failed({ ts: 5055 }));

		expect(h.notices).toHaveLength(2);
	});

	it("keeps quiet about a mark that is too old to be news", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		h.setNow(5_000_000);
		h.push(failed());

		expect(h.notices).toHaveLength(0);
	});

	it("keeps quiet about a command that worked", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		h.setNow(5100);
		h.push({ val: 102, ack: true, q: 0, ts: 5050 });

		expect(h.notices).toHaveLength(0);
	});

	it("survives a state that carries nonsense", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();

		h.setNow(5100);
		expect(() => h.push({ q: 0x44, c: "not json", ts: 5050 })).not.toThrow();
		expect(() => h.push(null)).not.toThrow();
		expect(h.notices).toHaveLength(0);
	});

	it("drops the old subscriptions when the device changes", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();
		h.source.setDevice("roborock.0", "duid2");
		await settle();

		for (const pattern of PATTERNS) {
			expect(h.connection.unsubscribeState).toHaveBeenCalledWith(pattern, expect.any(Function));
			expect(h.subscriptions.has(pattern)).toBe(false);
		}
	});

	it("leaves nothing subscribed when it is destroyed", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1");
		await settle();
		h.source.destroy();

		for (const pattern of PATTERNS) expect(h.subscriptions.has(pattern)).toBe(false);

		// And a late delivery after the tear-down says nothing.
		h.setNow(5100);
		h.push(failed());
		expect(h.notices).toHaveLength(0);
	});
});
