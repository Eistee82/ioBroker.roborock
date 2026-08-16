import { describe, expect, it } from "vitest";
import { parseMapList } from "./mapList";

/**
 * Reading `mapInventory.maps` back.
 *
 * The value crosses to the browser as a JSON string, so everything here is about surviving what a
 * state can hold rather than about the happy path. The failure worth preventing is not a missing
 * list - the panel simply stays away then - but a **wrong slot**: the flag is what a rename is
 * addressed to, and a row that kept a broken one would rename the other floor.
 */

/** What the adapter writes for the test device: two floors, one backup each. */
const MEASURED = JSON.stringify([
	{ mapFlag: 0, name: "Erdgeschoss", addTime: 1786788440, backupCount: 1, lastBackupTime: 1786781087 },
	{ mapFlag: 1, name: "Keller", addTime: 1733229641, backupCount: 1, lastBackupTime: 1733229675 }
]);

describe("parseMapList", () => {
	it("reads the list the adapter writes", () => {
		expect(parseMapList(MEASURED)).toEqual([
			{ mapFlag: 0, name: "Erdgeschoss", addTime: 1786788440, backupCount: 1, lastBackupTime: 1786781087 },
			{ mapFlag: 1, name: "Keller", addTime: 1733229641, backupCount: 1, lastBackupTime: 1733229675 }
		]);
	});

	it("takes the already parsed array as well", () => {
		expect(parseMapList(JSON.parse(MEASURED))).toHaveLength(2);
	});

	it("keeps the order the robot listed the slots in", () => {
		const reversed = JSON.stringify([{ mapFlag: 3, name: "Dach" }, { mapFlag: 0, name: "EG" }]);
		expect(parseMapList(reversed).map((entry) => entry.mapFlag)).toEqual([3, 0]);
	});

	it("answers with an empty list for everything that is not one", () => {
		// Each of these is a state a real installation can hold: before the first read, on an adapter
		// that never wrote it, or after somebody edited the value by hand.
		for (const value of ["", "   ", null, undefined, "not json", "{}", 42, {}]) {
			expect(parseMapList(value), `${JSON.stringify(value)} is not a list`).toEqual([]);
		}
	});

	it("drops a row whose slot cannot be read rather than inventing one", () => {
		const raw = JSON.stringify([{ name: "No flag" }, { mapFlag: -1, name: "Negative" }, { mapFlag: 1.5 }, { mapFlag: 2, name: "Real" }]);
		expect(parseMapList(raw).map((entry) => entry.mapFlag)).toEqual([2]);
	});

	it("keeps an unnamed slot unnamed", () => {
		// Whoever shows the list may put "Map 2" on the screen; the data must not, or a rename dialog
		// would pre-fill a name the robot never stored.
		const raw = JSON.stringify([{ mapFlag: 2 }, { mapFlag: 3, name: "   " }, { mapFlag: 4, name: 7 }]);
		expect(parseMapList(raw).map((entry) => entry.name)).toEqual([null, null, null]);
	});

	it("fills in the fields a shorter row leaves out", () => {
		expect(parseMapList(JSON.stringify([{ mapFlag: 0, name: "EG" }]))).toEqual([
			{ mapFlag: 0, name: "EG", addTime: null, backupCount: 0, lastBackupTime: null }
		]);
	});

	it("reads numbers that arrived as text", () => {
		// ioBroker states carry whatever was written, and a script writing this state by hand is a
		// thing that happens.
		const raw = JSON.stringify([{ mapFlag: "1", name: "Keller", addTime: "1733229641", backupCount: "2" }]);
		expect(parseMapList(raw)[0]).toEqual({ mapFlag: 1, name: "Keller", addTime: 1733229641, backupCount: 2, lastBackupTime: null });
	});

	it("never reports a negative backup count", () => {
		const raw = JSON.stringify([{ mapFlag: 0, backupCount: -3 }, { mapFlag: 1, backupCount: "many" }]);
		expect(parseMapList(raw).map((entry) => entry.backupCount)).toEqual([0, 0]);
	});
});
