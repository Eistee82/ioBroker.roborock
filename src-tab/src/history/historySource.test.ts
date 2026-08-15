import { afterEach, describe, expect, it, vi } from "vitest";
import { CleaningHistorySource } from "./historySource";
import { MAP_COLOR_SCHEME_STATE } from "../engine/mapOverlayColors";
import type { EngineConnection } from "../engine/types";
import type { CleaningHistoryModel } from "./historyTypes";

/**
 * What the source reads, what it subscribes to, and what it deliberately does **not** read.
 *
 * The two rules worth guarding are both about size: the bulk read must skip the base64 map images,
 * and the reload trigger must be a handful of states rather than one per field. Both were chosen
 * because a device keeps twenty runs of around twenty fields plus a rendered PNG each.
 */

const ROOT = "roborock.0.Devices.duid1.cleaningInfo";
const SCHEME_STATE = `roborock.0.${MAP_COLOR_SCHEME_STATE}`;

interface Harness {
	source: CleaningHistorySource;
	connection: EngineConnection;
	subscriptions: Map<string, ((id: string, state: any) => void)[]>;
	models: (CleaningHistoryModel | null)[];
	schemes: string[];
	/** Ids the last bulk read asked for. */
	lastBulkRead: string[];
	fire: (id: string) => void;
}

/** The branch a V1 device publishes for two runs, as objects. */
const OBJECTS: Record<string, { common: { unit?: string } }> = {
	[`${ROOT}.clean_count`]: { common: {} },
	[`${ROOT}.JSON`]: { common: {} },
	[`${ROOT}.records.0.startTime`]: { common: {} },
	[`${ROOT}.records.0.duration`]: { common: { unit: "min" } },
	[`${ROOT}.records.0.map.mapBase64`]: { common: {} },
	[`${ROOT}.records.1.startTime`]: { common: {} },
	[`${ROOT}.records.1.mapBase64`]: { common: {} },
};

const VALUES: Record<string, { val: unknown }> = {
	[`${ROOT}.clean_count`]: { val: 190 },
	[`${ROOT}.records.0.startTime`]: { val: 1765198801 },
	[`${ROOT}.records.0.duration`]: { val: 76 },
	[`${ROOT}.records.0.map.mapBase64`]: { val: "data:image/png;base64,AAAA" },
	[`${ROOT}.records.1.startTime`]: { val: 1764939602 },
	[`${ROOT}.records.1.mapBase64`]: { val: "data:image/png;base64,BBBB" },
	[SCHEME_STATE]: { val: "dark" },
};

let live: CleaningHistorySource | null = null;

afterEach(() => {
	live?.destroy();
	live = null;
	vi.useRealTimers();
});

function harness(): Harness {
	const subscriptions = new Map<string, ((id: string, state: any) => void)[]>();
	const models: (CleaningHistoryModel | null)[] = [];
	const schemes: string[] = [];
	const state = { lastBulkRead: [] as string[] };

	const connection: EngineConnection = {
		sendTo: vi.fn().mockResolvedValue({}),
		getObject: vi.fn().mockResolvedValue(null),
		getStates: vi.fn(async (ids: string[]) => {
			if (ids.length !== 1 || ids[0] !== SCHEME_STATE) state.lastBulkRead = [...ids];
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
		getObjectViewSystem: vi.fn().mockResolvedValue(OBJECTS),
	};

	const source = new CleaningHistorySource(connection, {
		onHistory: model => models.push(model),
		onMapColorScheme: scheme => schemes.push(scheme),
	});
	live = source;

	return {
		source,
		connection,
		subscriptions,
		models,
		schemes,
		get lastBulkRead() {
			return state.lastBulkRead;
		},
		fire: (id: string) => {
			for (const handler of subscriptions.get(id) ?? []) handler(id, { val: Date.now() });
		},
	};
}

/** Lets the promise chain of a reload settle. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("CleaningHistorySource", () => {
	it("reads the branch and publishes the model", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		const model = h.models[h.models.length - 1];
		expect(model?.runs.map(run => run.startedAt)).toEqual([1765198801, 1764939602]);
		expect(model?.summary.map(entry => entry.key)).toEqual(["clean_count"]);
	});

	it("leaves the base64 images out of the bulk read", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		expect(h.lastBulkRead).toContain(`${ROOT}.records.0.duration`);
		expect(h.lastBulkRead).not.toContain(`${ROOT}.records.0.map.mapBase64`);
		expect(h.lastBulkRead).not.toContain(`${ROOT}.records.1.mapBase64`);
	});

	it("still points every run at its image", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		const model = h.models[h.models.length - 1];
		expect(model?.runs[0].mapStateId).toBe(`${ROOT}.records.0.map.mapBase64`);
		expect(model?.runs[1].mapStateId).toBe(`${ROOT}.records.1.mapBase64`);
	});

	it("fetches a single image on demand and rejects anything that is not one", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		await expect(h.source.loadMap(`${ROOT}.records.0.map.mapBase64`)).resolves.toBe("data:image/png;base64,AAAA");
		await expect(h.source.loadMap(`${ROOT}.clean_count`)).resolves.toBeNull();
	});

	it("subscribes to three trigger states, not to every field", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		const subscribed = Array.from(h.subscriptions.keys()).filter(id => id.startsWith(ROOT));
		expect(subscribed.sort()).toEqual([`${ROOT}.JSON`, `${ROOT}.clean_count`, `${ROOT}.record_count`].sort());
	});

	it("coalesces the several writes of one adapter pass into one re-read", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();
		const before = (h.connection.getObjectViewSystem as ReturnType<typeof vi.fn>).mock.calls.length;

		h.fire(`${ROOT}.clean_count`);
		h.fire(`${ROOT}.JSON`);
		h.fire(`${ROOT}.record_count`);
		await vi.advanceTimersByTimeAsync(600);
		await settle();

		expect((h.connection.getObjectViewSystem as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
	});

	it("reports the scheme the adapter painted its maps in", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();
		expect(h.schemes).toContain("dark");
	});

	it("clears the panel and every subscription when no device is selected", async () => {
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		h.source.setDevice("roborock.0", "", "en");
		expect(h.models[h.models.length - 1]).toBeNull();
		expect(Array.from(h.subscriptions.keys())).toHaveLength(0);
	});

	it("drops every subscription and timer on destroy", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		h.fire(`${ROOT}.JSON`);
		h.source.destroy();
		const after = (h.connection.getObjectViewSystem as ReturnType<typeof vi.fn>).mock.calls.length;
		await vi.advanceTimersByTimeAsync(600);
		await settle();

		expect(Array.from(h.subscriptions.keys())).toHaveLength(0);
		expect((h.connection.getObjectViewSystem as ReturnType<typeof vi.fn>).mock.calls.length).toBe(after);
	});

	it("survives an object view that is not reachable", async () => {
		const h = harness();
		(h.connection.getObjectViewSystem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no view"));
		h.source.setDevice("roborock.0", "duid1", "en");
		await settle();

		expect(h.models[h.models.length - 1]).toEqual({ summary: [], runs: [] });
	});
});
