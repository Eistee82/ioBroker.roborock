import { describe, expect, it } from "vitest";
import { timerSwitchState, unwrapTimerRows } from "./deviceTimers";

const TIMER_ID = "1498595904821";
const OTHER_ID = "1743140136890";

/** One row as `get_timer` reports it: `[id, state, [cron, [command, params], created]]`. */
function row(id: string, state: unknown): unknown[] {
	return [id, state, ["0 14 * * 5", ["start_clean", {}], 1234567890]];
}

describe("deviceTimers - what the list says about one schedule", () => {
	it("hands back the state field as reported, not as a boolean", () => {
		// Which spellings mean "off" is `serverTimers.ts`'s question; this reader does not answer it.
		expect(timerSwitchState([row(TIMER_ID, "on")], TIMER_ID)).toBe("on");
		expect(timerSwitchState([row(TIMER_ID, "off")], TIMER_ID)).toBe("off");
		expect(timerSwitchState([row(TIMER_ID, "disable")], TIMER_ID)).toBe("disable");
	});

	it("finds the row among others", () => {
		const rows = [row(OTHER_ID, "on"), row(TIMER_ID, "off")];
		expect(timerSwitchState(rows, TIMER_ID)).toBe("off");
		expect(timerSwitchState(rows, OTHER_ID)).toBe("on");
	});

	it("compares as text, so a numeric identifier is still found", () => {
		expect(timerSwitchState([[1498595904821, "on", -1]], TIMER_ID)).toBe("on");
	});

	it("unwraps the envelope and the single-element wrapper the request layer adds", () => {
		expect(timerSwitchState({ data: [row(TIMER_ID, "on")] }, TIMER_ID)).toBe("on");
		expect(timerSwitchState({ data: [[row(TIMER_ID, "off")]] }, TIMER_ID)).toBe("off");
	});

	it("says nothing when the list does not name the identifier", () => {
		// Not "off": the schedule may have been deleted meanwhile, and one silent answer is no proof
		// of anything about a switch.
		expect(timerSwitchState([row(OTHER_ID, "on")], TIMER_ID)).toBeNull();
		expect(timerSwitchState([], TIMER_ID)).toBeNull();
	});

	it("says nothing when the answer is not a list at all", () => {
		for (const answer of [null, undefined, "unknown_method", 0, { result: [] }]) {
			expect(timerSwitchState(answer, TIMER_ID)).toBeNull();
		}
	});

	it("reports an empty state field rather than null when the row carries none", () => {
		// The row exists, so the caller knows the schedule is still there - which is the difference
		// that decides between "ineffective" and "accepted".
		expect(timerSwitchState([[TIMER_ID]], TIMER_ID)).toBe("");
		expect(timerSwitchState([[TIMER_ID, 1, []]], TIMER_ID)).toBe("");
	});
});

describe("deviceTimers - unwrapping the answer", () => {
	it("keeps an empty list apart from an unreadable answer", () => {
		// `[]` is a statement: this robot keeps no schedules of its own.
		expect(unwrapTimerRows([])).toEqual([]);
		expect(unwrapTimerRows("unknown_method")).toBeNull();
	});

	it("leaves a genuine one-timer answer alone", () => {
		const rows = [row(TIMER_ID, "on")];
		expect(unwrapTimerRows(rows)).toEqual(rows);
	});
});
