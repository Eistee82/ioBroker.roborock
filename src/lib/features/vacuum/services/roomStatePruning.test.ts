import { describe, expect, it } from "vitest";
import { decideRoomPruning, ROOM_ABSENCE_THRESHOLD } from "./roomStatePruning";

/**
 * The rule that decides whether a user's room switch is deleted.
 *
 * This is the only operation in the adapter that removes objects people build on - scripts, vis
 * widgets, scenes all point at `floors.<mapFlag>.<roomId>`. So most of what is worth testing here
 * is the set of situations in which **nothing may happen**, not the one in which something does:
 *
 *  - a reading that carried no segments at all,
 *  - a room that reappeared before the evidence was complete,
 *  - a room that has been missing, but not often enough yet.
 *
 * Each of those is a case where an eager cleaner destroys something the user cannot get back, and
 * where the cost of doing nothing is a stale switch for a few more minutes - the state the adapter
 * has been in for its whole existence.
 */

describe("a reading that carries no segments", () => {
	it("removes nothing, however long the rooms have been missing", () => {
		// An empty list cannot tell a robot that lost its rooms from a fetch that came back thin.
		const decision = decideRoomPruning({
			present: [],
			existing: [16, 17],
			absences: { 16: 99, 17: 99 },
		});

		expect(decision.remove).toEqual([]);
	});

	it("forgets the evidence rather than adding to it", () => {
		// Otherwise three unusable readings in a row would delete every switch on the floor.
		const decision = decideRoomPruning({
			present: [],
			existing: [16],
			absences: { 16: ROOM_ABSENCE_THRESHOLD - 1 },
		});

		expect(decision.absences).toEqual({});
	});
});

describe("a room that is still on the map", () => {
	it("is never removed", () => {
		expect(decideRoomPruning({ present: [16, 17], existing: [16, 17], absences: {} }).remove).toEqual([]);
	});

	it("has its evidence wiped when it comes back", () => {
		// A segment that reappeared is not two thirds of the way to being deleted.
		const decision = decideRoomPruning({
			present: [16],
			existing: [16],
			absences: { 16: ROOM_ABSENCE_THRESHOLD - 1 },
		});

		expect(decision.remove).toEqual([]);
		expect(decision.absences[16]).toBeUndefined();
	});
});

describe("a room that has gone", () => {
	it("survives the first readings that miss it", () => {
		let absences = {};
		for (let reading = 1; reading < ROOM_ABSENCE_THRESHOLD; reading++) {
			const decision = decideRoomPruning({ present: [16], existing: [16, 17], absences });
			expect(decision.remove).toEqual([]);
			expect(decision.absences[17]).toBe(reading);
			absences = decision.absences;
		}
	});

	it("is removed once the evidence is complete", () => {
		let absences = {};
		let removed: number[] = [];
		for (let reading = 1; reading <= ROOM_ABSENCE_THRESHOLD; reading++) {
			const decision = decideRoomPruning({ present: [16], existing: [16, 17], absences });
			absences = decision.absences;
			removed = decision.remove;
		}

		expect(removed).toEqual([17]);
	});

	it("starts over when it reappears in between", () => {
		// Two readings missing it, one that has it, then two more: not enough. This is the case a
		// counter without a reset would get wrong - and a map fetched mid-run really does come and
		// go like this.
		let absences = decideRoomPruning({ present: [16], existing: [16, 17], absences: {} }).absences;
		absences = decideRoomPruning({ present: [16], existing: [16, 17], absences }).absences;
		expect(absences[17]).toBe(2);

		absences = decideRoomPruning({ present: [16, 17], existing: [16, 17], absences }).absences;
		expect(absences[17]).toBeUndefined();

		const decision = decideRoomPruning({ present: [16], existing: [16, 17], absences });
		expect(decision.remove).toEqual([]);
		expect(decision.absences[17]).toBe(1);
	});

	it("drops its counter once it is removed, so the evidence does not pile up", () => {
		const decision = decideRoomPruning({
			present: [16],
			existing: [16, 17],
			absences: { 17: ROOM_ABSENCE_THRESHOLD - 1 },
		});

		expect(decision.remove).toEqual([17]);
		expect(decision.absences[17]).toBeUndefined();
	});
});

describe("the threshold", () => {
	it("is more than one, because a single reading is not evidence", () => {
		// A map fetched while the robot is still driving can legitimately carry fewer segments than
		// the finished one; deleting on the first miss would act on exactly that.
		expect(ROOM_ABSENCE_THRESHOLD).toBeGreaterThan(1);
	});

	it("can be tightened for a test without changing the shipped rule", () => {
		const decision = decideRoomPruning({ present: [16], existing: [16, 17], absences: {}, threshold: 1 });
		expect(decision.remove).toEqual([17]);
	});
});

describe("rooms this adapter does not know", () => {
	it("leaves a floor without any states alone", () => {
		expect(decideRoomPruning({ present: [16, 17], existing: [], absences: {} })).toEqual({
			remove: [],
			absences: {},
		});
	});

	it("removes several at once when a merge took several", () => {
		const decision = decideRoomPruning({
			present: [16],
			existing: [16, 17, 18],
			absences: { 17: ROOM_ABSENCE_THRESHOLD - 1, 18: ROOM_ABSENCE_THRESHOLD - 1 },
		});

		expect(decision.remove.sort()).toEqual([17, 18]);
	});
});
