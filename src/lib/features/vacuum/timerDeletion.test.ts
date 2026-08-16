import { describe, expect, it } from "vitest";
import {
	DEL_SERVER_TIMER,
	DEL_TIMER,
	TIMER_SOURCE_DEVICE,
	TIMER_SOURCE_SERVER,
	canDeleteSchedules,
	deleteMethodForSource,
	isSendableTimerId,
	listMethodForSource,
	parseTimerSource,
	timerIsGone
} from "./timerDeletion";

describe("timerDeletion - which command removes which schedule", () => {
	it("sends del_timer for a schedule the robot keeps itself", () => {
		// A65:228155-228172 (wrapper) and A65:238179 (Methods.DelTimer -> del_timer).
		expect(deleteMethodForSource(TIMER_SOURCE_DEVICE)).toBe(DEL_TIMER);
		expect(DEL_TIMER).toBe("del_timer");
	});

	it("sends del_server_timer for a schedule the robot keeps on the server", () => {
		// A65:228137-228154 (wrapper), spelled the same in both method tables (A65:238176/238179).
		expect(deleteMethodForSource(TIMER_SOURCE_SERVER)).toBe(DEL_SERVER_TIMER);
		expect(DEL_SERVER_TIMER).toBe("del_server_timer");
	});

	it("asks the matching list when it checks whether the deletion took", () => {
		expect(listMethodForSource(TIMER_SOURCE_DEVICE)).toBe("get_timer");
		expect(listMethodForSource(TIMER_SOURCE_SERVER)).toBe("get_server_timer");
	});
});

describe("timerDeletion - reading the source state", () => {
	it("accepts the two words it writes itself", () => {
		expect(parseTimerSource("device")).toBe(TIMER_SOURCE_DEVICE);
		expect(parseTimerSource("server")).toBe(TIMER_SOURCE_SERVER);
	});

	it("refuses anything else instead of falling back to a default", () => {
		// The B01 shadow service writes `schedules.<id>` from Tuya data points that neither command
		// reaches. A default here would send a delete about a schedule it has nothing to do with.
		for (const value of [undefined, null, "", "Device", "robot", 0, 1, true, {}, []]) {
			expect(parseTimerSource(value)).toBeNull();
		}
	});
});

describe("timerDeletion - which handlers may be handed a delete", () => {
	it("accepts a handler that implements deleteSchedule", () => {
		expect(canDeleteSchedules({ deleteSchedule: async () => ({ outcome: "confirmed" as const }) })).toBe(true);
	});

	it("refuses one that does not, and every non-object", () => {
		expect(canDeleteSchedules({})).toBe(false);
		expect(canDeleteSchedules({ deleteSchedule: 1 })).toBe(false);
		expect(canDeleteSchedules(null)).toBe(false);
		expect(canDeleteSchedules(undefined)).toBe(false);
	});
});

describe("timerDeletion - identifiers that may be sent", () => {
	it("accepts the identifiers both lists actually report", () => {
		// Measured: get_server_timer -> [["1743140136890","on",-1]] (19-geraetefaehigkeiten.md 5.5).
		expect(isSendableTimerId("1743140136890")).toBe(true);
		expect(isSendableTimerId("1498595904821")).toBe(true);
		expect(isSendableTimerId("timer_id_1")).toBe(true);
	});

	it("refuses anything that could leave the identifier and become part of a path", () => {
		for (const value of ["", "../other", "a.b", "a b", "a/b", "a\\b", "*", "x".repeat(65), 12345, null, undefined]) {
			expect(isSendableTimerId(value)).toBe(false);
		}
	});
});

describe("timerDeletion - reading the list back", () => {
	const gone = "1743140136890";
	const other = "1498595904821";

	it("calls it gone when the list no longer names it", () => {
		expect(timerIsGone([[other, "on", -1]], gone)).toBe(true);
		expect(timerIsGone([], gone)).toBe(true);
	});

	it("calls it present while the list still names it", () => {
		expect(timerIsGone([[gone, "on", -1]], gone)).toBe(false);
		expect(timerIsGone([[other, "on", -1], [gone, "disable", -1]], gone)).toBe(false);
	});

	it("reads the device-timer rows as well, which carry the cron in place of the -1", () => {
		const rows = [[gone, "on", ["0 14 * * 5", ["start_clean", {}], 1234567890]]];
		expect(timerIsGone(rows, gone)).toBe(false);
		expect(timerIsGone(rows, other)).toBe(true);
	});

	it("compares as text, so a numeric identifier is not mistaken for a missing one", () => {
		expect(timerIsGone([[1743140136890, "on", -1]], gone)).toBe(false);
	});

	it("unwraps the single-element wrapper the request layer sometimes adds", () => {
		expect(timerIsGone({ data: [[[other, "on", -1]]] }, gone)).toBe(true);
		expect(timerIsGone({ data: [[[gone, "on", -1]]] }, gone)).toBe(false);
	});

	it("treats an answer it cannot read as 'still there'", () => {
		// A shape nobody recognises is not evidence of a deletion. Erring the other way would remove
		// the object while the schedule keeps running - the one outcome nobody would notice.
		for (const answer of [null, undefined, "unknown_method", 0, { result: "unknown_method" }]) {
			expect(timerIsGone(answer, gone)).toBe(false);
		}
	});
});
