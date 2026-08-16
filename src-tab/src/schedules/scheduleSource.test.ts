import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleSource } from "./scheduleSource";
import { schedulesRoot } from "./schedules";
import type { EngineConnection } from "../engine/types";
import type { SchedulesModel } from "./schedules";

/**
 * What the schedule source lists, what it subscribes to and what it sends.
 *
 * Two things are worth guarding here and neither is the happy path. A schedule that disappears has to
 * take its row with it, because the adapter removes the whole folder once the robot confirmed the
 * deletion - and a row for a schedule that no longer exists is a control over nothing. And a schedule
 * that appears after the listing has to bring its objects along, because those are what decide
 * whether it may be switched or deleted at all.
 */

const ROOT = schedulesRoot("roborock.0", "duid1");

const OBJECTS: Record<string, { common: Record<string, unknown> }> = {
	[`${ROOT}.1743140136890.enabled`]: { common: { type: "boolean", role: "indicator", write: false } },
	[`${ROOT}.1743140136890.source`]: { common: { type: "string", role: "text", write: false } },
	[`${ROOT}.1743140136890.delete`]: { common: { type: "boolean", role: "button", write: true } },
};

const VALUES: Record<string, { val: unknown }> = {
	[`${ROOT}.1743140136890.enabled`]: { val: true },
	[`${ROOT}.1743140136890.source`]: { val: "server" },
};

let live: ScheduleSource | null = null;

afterEach(() => {
	live?.destroy();
	live = null;
	vi.useRealTimers();
});

function harness(objects: Record<string, { common: Record<string, unknown> }> = OBJECTS) {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();
	const models: (SchedulesModel | null)[] = [];
	const errors: string[] = [];
	let known = objects;

	const connection: EngineConnection = {
		sendTo: vi.fn().mockResolvedValue({ result: "accepted" }),
		getObject: vi.fn(async (id: string) => known[id] ?? null),
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
		getObjectViewSystem: vi.fn(async () => known),
	} as unknown as EngineConnection;

	const source = new ScheduleSource(connection, {
		onSchedules: model => models.push(model),
		onError: message => errors.push(message),
	});
	live = source;

	return {
		source,
		connection,
		subscriptions,
		models,
		errors,
		/** Replaces what the object view answers, for a schedule that appears later. */
		setObjects: (next: Record<string, { common: Record<string, unknown> }>) => {
			known = next;
		},
		fire: (id: string, state: unknown) => {
			for (const [pattern, handlers] of subscriptions) {
				if (!id.startsWith(pattern.replace(/\*$/, ""))) continue;
				for (const handler of handlers) handler(id, state);
			}
		},
		latest: (): SchedulesModel | null => models[models.length - 1] ?? null,
	};
}

/** Waits for the promises the source started, without pretending to know how many there are. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("reading the schedules of a device", () => {
	it("lists the branch, reads the values and subscribes to it once", async () => {
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();

		expect(context.connection.getObjectViewSystem).toHaveBeenCalledWith("state", `${ROOT}.`, `${ROOT}.香`);
		expect([...context.subscriptions.keys()]).toEqual([`${ROOT}.*`]);
		expect(context.latest()?.entries).toHaveLength(1);
		expect(context.latest()?.entries[0]).toMatchObject({ id: "1743140136890", source: "server", canDelete: true });
	});

	it("clears the panel when no device is selected", async () => {
		const context = harness();
		context.source.setDevice("roborock.0", "");
		await settle();

		expect(context.latest()).toBeNull();
		expect(context.subscriptions.size).toBe(0);
	});

	it("drops the row when the schedule's states are removed", async () => {
		// This is what a confirmed deletion looks like from here: the adapter removes the folder, and
		// ioBroker hands a removed state to its subscribers as null.
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();

		for (const id of Object.keys(OBJECTS)) context.fire(id, null);

		expect(context.latest()?.entries).toEqual([]);
	});

	it("keeps the row when a schedule the robot still has is re-read", async () => {
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();

		context.fire(`${ROOT}.1743140136890.enabled`, { val: false });

		expect(context.latest()?.entries).toHaveLength(1);
		expect(context.latest()?.entries[0]?.enabled).toBe(false);
	});

	it("lists the objects again when a schedule appears that was not there", async () => {
		vi.useFakeTimers();
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();

		const grown = {
			...OBJECTS,
			[`${ROOT}.999.enabled`]: { common: { type: "boolean", role: "switch", write: true } },
			[`${ROOT}.999.source`]: { common: { type: "string", role: "text", write: false } },
		};
		context.setObjects(grown);
		context.fire(`${ROOT}.999.source`, { val: "device" });
		context.fire(`${ROOT}.999.enabled`, { val: true });

		// One listing for the whole burst, not one per state.
		const before = (context.connection.getObjectViewSystem as any).mock.calls.length;
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect((context.connection.getObjectViewSystem as any).mock.calls.length).toBe(before + 1);

		const appeared = context.latest()?.entries.find(entry => entry.id === "999");
		expect(appeared).toMatchObject({ source: "device", enabled: true, canToggle: true });
	});

	it("keeps a value that arrived while the listing was running", async () => {
		vi.useFakeTimers();
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();

		context.fire(`${ROOT}.1743140136890.enabled`, { val: false });
		context.setObjects({ ...OBJECTS });
		context.fire(`${ROOT}.777.enabled`, { val: true });
		await vi.advanceTimersByTimeAsync(300);
		await settle();

		// The bulk read still answers `true` for this state; the live value is newer and wins.
		expect(context.latest()?.entries[0]?.enabled).toBe(false);
	});
});

describe("acting on a schedule", () => {
	it("switches one through the adapter rather than by writing the state", async () => {
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();

		await context.source.setEnabled("1743140136890", false);

		expect(context.connection.sendTo).toHaveBeenCalledWith("roborock.0", "set_schedule_enabled", {
			duid: "duid1",
			timerId: "1743140136890",
			enabled: false,
		});
	});

	it("deletes one through the adapter and removes nothing itself", async () => {
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();

		await context.source.remove("1743140136890");

		expect(context.connection.sendTo).toHaveBeenCalledWith("roborock.0", "delete_schedule", {
			duid: "duid1",
			timerId: "1743140136890",
		});
		// The row stays until the states really go. A delete that did not take must not look like one
		// that did.
		expect(context.latest()?.entries).toHaveLength(1);
	});

	it("reports a refused message instead of swallowing it", async () => {
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();
		(context.connection.sendTo as any).mockRejectedValueOnce(new Error("not a schedule of DUID duid1"));

		await context.source.remove("1743140136890");

		expect(context.errors).toEqual(["not a schedule of DUID duid1"]);
	});

	it("sends nothing once destroyed", async () => {
		const context = harness();
		context.source.setDevice("roborock.0", "duid1");
		await settle();
		context.source.destroy();

		await context.source.setEnabled("1743140136890", true);

		expect(context.connection.sendTo).not.toHaveBeenCalled();
	});
});
