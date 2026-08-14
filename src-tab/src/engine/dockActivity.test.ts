import { describe, expect, it } from "vitest";
import { DOCK_ACTIVITY_STATES, EMPTY_DOCK_ACTIVITY, readDockActivity } from "./dockActivity";
import type { DockStatusValueRow } from "./dockActivity";

/**
 * Reading the station's wash and dry activity.
 *
 * The dangerous mistake here is not a wrong label but a **claim about a silent device**: a station
 * that publishes nothing looks exactly like an idle one from this side, and the panel would say
 * "not drying" about a robot that never mentioned drying at all. Every value therefore has to come
 * back as null unless the device really published it.
 */

const FOLDER = "dockingStationStatus";
const ROOT = `roborock.0.Devices.abc.${FOLDER}`;

/** One station row as `MapEngine` builds it from the object definition. */
function row(name: string, states: Record<string, string> | null = null): DockStatusValueRow {
	return { stateId: `${ROOT}.${name}`, states };
}

/** Every activity row a device with a full station publishes. */
const ALL_ROWS: DockStatusValueRow[] = [
	row(DOCK_ACTIVITY_STATES.washing),
	row(DOCK_ACTIVITY_STATES.washingMode, { "6": "Self-cleaning", "7": "Draining", "9": "Robot draining", "12": "Sewage box draining" }),
	row(DOCK_ACTIVITY_STATES.drying),
	row(DOCK_ACTIVITY_STATES.dryRemainTime),
];

/** Values keyed the way `MapEngine` keeps them: by full state id. */
function values(entries: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(entries).map(([name, value]) => [`${ROOT}.${name}`, value]));
}

describe("readDockActivity", () => {
	it("reports unknown for a device that publishes no station states at all", () => {
		expect(readDockActivity([], {}, FOLDER)).toEqual(EMPTY_DOCK_ACTIVITY);
	});

	it("reports unknown, not 'no', while a published state has no value yet", () => {
		// The row exists but nothing has arrived - that is silence, not a negative answer.
		const activity = readDockActivity(ALL_ROWS, {}, FOLDER);
		expect(activity.washing).toBeNull();
		expect(activity.drying).toBeNull();
		expect(activity.washingModeText).toBeNull();
		expect(activity.dryRemainMinutes).toBeNull();
	});

	it("never turns a missing remaining time into zero minutes", () => {
		// `Number(null)` is 0, and 0 would read as "drying is done" instead of "not reported".
		expect(readDockActivity(ALL_ROWS, values({ isDrying: true }), FOLDER).dryRemainMinutes).toBeNull();
	});

	it("reads the flags the adapter publishes", () => {
		const activity = readDockActivity(
			ALL_ROWS,
			values({ isWashing: true, isDrying: false, dryRemainTime: 42 }),
			FOLDER,
		);
		expect(activity.washing).toBe(true);
		expect(activity.drying).toBe(false);
		expect(activity.dryRemainMinutes).toBe(42);
	});

	it("accepts the shapes a state can carry a flag in", () => {
		expect(readDockActivity(ALL_ROWS, values({ isDrying: 1 }), FOLDER).drying).toBe(true);
		expect(readDockActivity(ALL_ROWS, values({ isDrying: "true" }), FOLDER).drying).toBe(true);
		expect(readDockActivity(ALL_ROWS, values({ isDrying: 0 }), FOLDER).drying).toBe(false);
	});

	it("words the wash mode with the adapter's own value list", () => {
		const activity = readDockActivity(ALL_ROWS, values({ isWashing: true, washingMode: 6 }), FOLDER);
		expect(activity.washingModeText).toBe("Self-cleaning");
	});

	it("says nothing about a mode the adapter left unlabelled", () => {
		// Only four modes have a proven wording; a bare number must not pass as a mode name.
		const activity = readDockActivity(ALL_ROWS, values({ isWashing: true, washingMode: 11 }), FOLDER);
		expect(activity.washingModeText).toBeNull();
	});

	it("ignores a mode left over from the last cycle while nothing is washing", () => {
		// The adapter publishes the mode raw; the app reads it only while a task runs.
		const activity = readDockActivity(ALL_ROWS, values({ isWashing: false, washingMode: 6 }), FOLDER);
		expect(activity.washing).toBe(false);
		expect(activity.washingModeText).toBeNull();
	});

	it("keeps the fields a device publishes only in part", () => {
		// A station that reports drying but no wash states must not answer for the wash ones.
		const rows = [row(DOCK_ACTIVITY_STATES.drying)];
		const activity = readDockActivity(rows, values({ isDrying: true }), FOLDER);
		expect(activity.drying).toBe(true);
		expect(activity.washing).toBeNull();
		expect(activity.dryRemainMinutes).toBeNull();
	});

	it("does not confuse a state of the same name in another folder", () => {
		const foreign: DockStatusValueRow[] = [{ stateId: "roborock.0.Devices.abc.deviceStatus.isDrying", states: null }];
		const activity = readDockActivity(foreign, { "roborock.0.Devices.abc.deviceStatus.isDrying": true }, FOLDER);
		expect(activity.drying).toBeNull();
	});
});
