import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import {
	DEL_CLEAN_RECORD,
	V1CleanRecordDeleteService,
	parseRecordStartTime
} from "../../src/lib/features/vacuum/v1CleanRecordDelete";

/**
 * Deleting one run from the robot's cleaning history.
 *
 * The payload proof is in the module comment with its line numbers. What these tests guard is the
 * part a proof cannot: that the one destructive command in this group refuses everything it was not
 * asked for, and that success is decided by the run list rather than by the robot's answer.
 *
 * Nothing here talks to a device. The service is deliberately free of the request layer - it is fed
 * the run list and asked what to send, which is why it can be tested at all.
 */

function createDeps(): { deps: FeatureDependencies; adapter: any } {
	const adapter: any = {
		namespace: "roborock.0",
		translationManager: { get: (_key: string, fallback: string) => fallback },
		rLog: vi.fn(),
		errorMessage: (e: unknown) => String(e),
		getObjectAsync: vi.fn().mockResolvedValue(null),
		delObjectAsync: vi.fn().mockResolvedValue(undefined)
	};
	return { deps: { adapter } as unknown as FeatureDependencies, adapter };
}

describe("reading a start timestamp", () => {
	it("takes the numbers a state really carries", () => {
		expect(parseRecordStartTime(1786807834)).toBe(1786807834);
		// A script or a text field produces strings; the robot's own value is a number.
		expect(parseRecordStartTime("1786807834")).toBe(1786807834);
	});

	it("takes nothing else", () => {
		expect(parseRecordStartTime(0)).toBeNull();
		expect(parseRecordStartTime(-1)).toBeNull();
		expect(parseRecordStartTime("")).toBeNull();
		expect(parseRecordStartTime("yesterday")).toBeNull();
		expect(parseRecordStartTime(null)).toBeNull();
		expect(parseRecordStartTime(undefined)).toBeNull();
		expect(parseRecordStartTime(Number.NaN)).toBeNull();
	});
});

describe("what goes on the wire", () => {
	let service: V1CleanRecordDeleteService;

	beforeEach(() => {
		service = new V1CleanRecordDeleteService(createDeps().deps, "duid-test");
		service.noteRecords([1786807834, 1786790619]);
	});

	it("sends the timestamp in an array, as the wrapper builds it", () => {
		// A65:228107-228113: `new Array(1)` holding the argument, and the caller passes `record.start`
		// (A65:875841-875846).
		expect(service.buildCommandParams(DEL_CLEAN_RECORD, 1786807834)).toEqual({
			method: DEL_CLEAN_RECORD,
			params: [1786807834]
		});
	});

	it("refuses a run the robot never listed", () => {
		// The one destructive command here. A number nobody recognises is far more likely to be a
		// mistake than a run the summary happened to miss, and refusing costs nothing.
		expect(() => service.buildCommandParams(DEL_CLEAN_RECORD, 1234567890)).toThrow(/refuses 1234567890/);
	});

	it("refuses when the robot listed nothing at all", () => {
		const empty = new V1CleanRecordDeleteService(createDeps().deps, "duid-test");
		empty.noteRecords([]);
		expect(() => empty.buildCommandParams(DEL_CLEAN_RECORD, 1786807834)).toThrow(/no runs at all/);
	});

	it("refuses a value that is not a timestamp", () => {
		expect(() => service.buildCommandParams(DEL_CLEAN_RECORD, "")).toThrow(/needs the start timestamp/);
		expect(() => service.buildCommandParams(DEL_CLEAN_RECORD, true)).toThrow(/needs the start timestamp/);
	});
});

describe("whether the robot really has the function", () => {
	it("says no while it has listed no runs", () => {
		const service = new V1CleanRecordDeleteService(createDeps().deps, "duid-test");
		expect(service.noteRecords([])).toBe(false);
		// A probe is impossible here - calling the method is the deletion - so this is the whole
		// capability decision, and it must not turn into "offer it to everyone".
		expect(service.records).toEqual([]);
	});

	it("says yes as soon as one run is reported, and drops nonsense from the list", () => {
		const service = new V1CleanRecordDeleteService(createDeps().deps, "duid-test");
		expect(service.noteRecords([1786807834, 0, Number.NaN, -5])).toBe(true);
		expect(service.records).toEqual([1786807834]);
	});
});

describe("judging a deletion by the history rather than by the answer", () => {
	let service: V1CleanRecordDeleteService;

	beforeEach(() => {
		service = new V1CleanRecordDeleteService(createDeps().deps, "duid-test");
	});

	it("counts it done only when the run is gone from the new list", () => {
		expect(service.isDeleted(1786807834, [1786790619])).toBe(true);
		expect(service.isDeleted(1786807834, [1786807834, 1786790619])).toBe(false);
	});

	it("registers the command as a number, because it has to name a run", () => {
		const registered: Record<string, any> = {};
		service.registerCommands((name, spec) => {
			registered[name] = spec;
		});

		expect(registered[DEL_CLEAN_RECORD]).toMatchObject({ type: "number", write: true });
		// No `states` map: the set of runs changes with every clean, and a picker frozen at
		// registration time would go stale within the hour.
		expect(registered[DEL_CLEAN_RECORD]).not.toHaveProperty("states");
		expect(service.handles(DEL_CLEAN_RECORD)).toBe(true);
	});
});

describe("the record folders after a deletion", () => {
	it("removes the tail the shorter list no longer fills", async () => {
		// The history is published as a dense list and the writer only ever moves entries forward -
		// until now it could only grow. Without this the last folder would keep showing the run that
		// was just deleted.
		const { deps, adapter } = createDeps();
		const service = new V1CleanRecordDeleteService(deps, "duid-test");

		adapter.getObjectAsync = vi.fn(async (id: string) =>
			id === "Devices.duid-test.cleaningInfo.records.2" ? { common: {} } : null
		);

		await service.pruneRecordFolders(2);

		expect(adapter.delObjectAsync).toHaveBeenCalledWith("Devices.duid-test.cleaningInfo.records.2", { recursive: true });
		expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
	});

	it("removes nothing when the list is as long as before", async () => {
		const { deps, adapter } = createDeps();
		await new V1CleanRecordDeleteService(deps, "duid-test").pruneRecordFolders(3);
		expect(adapter.delObjectAsync).not.toHaveBeenCalled();
	});

	it("stops rather than looping when a folder cannot be removed", async () => {
		const { deps, adapter } = createDeps();
		adapter.getObjectAsync = vi.fn().mockResolvedValue({ common: {} });
		adapter.delObjectAsync = vi.fn().mockRejectedValue(new Error("object database is away"));

		await new V1CleanRecordDeleteService(deps, "duid-test").pruneRecordFolders(0);

		expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
	});
});
