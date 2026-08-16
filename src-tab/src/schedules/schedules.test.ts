import { describe, expect, it } from "vitest";
import {
	buildSchedules,
	describeRepetition,
	parseTimerCron,
	parseWeekList,
	schedulesRoot,
	weekdayNames,
} from "./schedules";
import type { ScheduleStateDefinition, ScheduleStateValue } from "./schedules";

const ROOT = schedulesRoot("roborock.0", "duid1");

/** Shorthand for one state object below the schedules folder. */
function object(id: string, common: ScheduleStateDefinition["common"]): ScheduleStateDefinition {
	return { id: `${ROOT}.${id}`, common };
}

/** The objects a V1 device timer consists of. */
function deviceTimer(id: string): ScheduleStateDefinition[] {
	return [
		object(`${id}.enabled`, { type: "boolean", role: "switch", write: true }),
		object(`${id}.cron`, { type: "string", role: "text", write: false }),
		object(`${id}.source`, { type: "string", role: "text", write: false }),
		object(`${id}.delete`, { type: "boolean", role: "button", write: true }),
	];
}

/** The objects a server-side schedule consists of; its switch is read-only. */
function serverTimer(id: string): ScheduleStateDefinition[] {
	return [
		object(`${id}.enabled`, { type: "boolean", role: "indicator", write: false }),
		object(`${id}.raw`, { type: "string", role: "json", write: false }),
		object(`${id}.source`, { type: "string", role: "text", write: false }),
		object(`${id}.delete`, { type: "boolean", role: "button", write: true }),
	];
}

function values(entries: Record<string, unknown>): Record<string, ScheduleStateValue> {
	const result: Record<string, ScheduleStateValue> = {};
	for (const [id, val] of Object.entries(entries)) result[`${ROOT}.${id}`] = { val };
	return result;
}

describe("reading a Roborock timer cron", () => {
	it("takes minute, hour and the weekday list in the app's own field order", () => {
		expect(parseTimerCron("30 7 * * 1,3,5")).toEqual({
			time: "07:30",
			weekdays: [1, 3, 5],
			dayOfMonth: null,
			month: null,
		});
	});

	it("counts weekdays from Sunday", () => {
		// `cronRepeatToTimerRepeat` fills its seven element array with `arr[getDay()] = 1`, and
		// `ConvertToCronStr` writes out the indices of that array. Index 0 is therefore Sunday, which
		// is also what its named sets say: weekends are [1,0,0,0,0,0,1].
		expect(parseTimerCron("0 9 * * 0,6")?.weekdays).toEqual([0, 6]);
	});

	it("reads a one-off schedule as its date with no weekday", () => {
		expect(parseTimerCron("0 14 24 12 *")).toEqual({
			time: "14:00",
			weekdays: [],
			dayOfMonth: 24,
			month: 12,
		});
	});

	it("pads the time so a single digit hour is not shown as such", () => {
		expect(parseTimerCron("5 7 * * *")?.time).toBe("07:05");
	});

	it("sorts the weekdays and drops a repeated one", () => {
		expect(parseTimerCron("0 8 * * 5,1,1")?.weekdays).toEqual([1, 5]);
	});

	it.each([
		["", "the empty string"],
		["0 8 * *", "four fields"],
		["0 8 * * 1 2", "six fields"],
		["0 24 * * 1", "an hour out of range"],
		["60 8 * * 1", "a minute out of range"],
		["0 8 * * 7", "a weekday out of range"],
		["0 8 * * 1-3", "a range instead of a list"],
		["*/15 8 * * 1", "a step"],
		["0 8 * * mon", "a name instead of a number"],
		["0 8 32 1 *", "a day of month out of range"],
	])("refuses %s (%s) instead of reading part of it", (cron) => {
		// `parseInt` would turn "1-3" into 1 and show the schedule on a Monday it does not run on.
		// An unreadable expression has to stay unreadable so the raw text is shown instead.
		expect(parseTimerCron(cron)).toBeNull();
	});
});

describe("reading the B01 weekday list", () => {
	it("takes a JSON array of weekdays", () => {
		expect(parseWeekList("[1,2,3]")).toEqual([1, 2, 3]);
	});

	it.each(["", "not json", "{}", "[7]", "[-1]", "[\"1\"]", "[1.5]"])("refuses %s", (raw) => {
		expect(parseWeekList(raw)).toBeNull();
	});
});

describe("building the model", () => {
	it("offers a switch and a delete for a device timer", () => {
		const model = buildSchedules({
			root: ROOT,
			definitions: deviceTimer("1498595904821"),
			values: values({
				"1498595904821.enabled": true,
				"1498595904821.cron": "0 14 * * 5",
				"1498595904821.source": "device",
			}),
		});

		expect(model.entries).toHaveLength(1);
		expect(model.entries[0]).toMatchObject({
			id: "1498595904821",
			source: "device",
			enabled: true,
			canToggle: true,
			canDelete: true,
			timing: { time: "14:00", weekdays: [5] },
		});
		expect(model.hasReadOnly).toBe(false);
	});

	it("offers the delete but no switch for a server-side schedule", () => {
		// The adapter publishes that switch read-only on purpose: switching it needs
		// `upd_server_timer`, and nobody has read that call. Deleting it is proven.
		const model = buildSchedules({
			root: ROOT,
			definitions: serverTimer("1743140136890"),
			values: values({
				"1743140136890.enabled": true,
				"1743140136890.source": "server",
				"1743140136890.raw": "[\"1743140136890\",\"on\",-1]",
			}),
		});

		expect(model.entries[0]).toMatchObject({ source: "server", enabled: true, canToggle: false, canDelete: true });
	});

	it("shows a server-side schedule even though its time cannot be read", () => {
		// The whole reason this panel exists: on the only measured robot `get_timer` is empty and every
		// schedule is a server one, whose times live in the Roborock account.
		const model = buildSchedules({
			root: ROOT,
			definitions: serverTimer("1743140136890"),
			values: values({ "1743140136890.enabled": true, "1743140136890.source": "server" }),
		});

		expect(model.entries).toHaveLength(1);
		expect(model.entries[0]?.timing).toBeNull();
		expect(model.entries[0]?.rawTime).toBeNull();
	});

	it("neither switches nor deletes a schedule whose source was not recorded", () => {
		// This is the B01/Q10 case. Its `enabled` is published writable, but a write there sends
		// `upd_timer` - a V1 command - to a robot that speaks Tuya data points.
		const model = buildSchedules({
			root: ROOT,
			definitions: [
				object("local_01.enabled", { type: "boolean", role: "switch", write: true }),
				object("local_01.time", { type: "string", role: "text", write: false }),
				object("local_01.weeks", { type: "string", role: "json", write: false }),
			],
			values: values({ "local_01.enabled": true, "local_01.time": "08:30", "local_01.weeks": "[1,2]" }),
		});

		expect(model.entries[0]).toMatchObject({
			source: "unknown",
			canToggle: false,
			canDelete: false,
			timing: { time: "08:30", weekdays: [1, 2] },
		});
		expect(model.hasReadOnly).toBe(true);
	});

	it("keeps the robot's own text when the cron cannot be read", () => {
		const model = buildSchedules({
			root: ROOT,
			definitions: deviceTimer("42"),
			values: values({ "42.enabled": false, "42.cron": "@weekly", "42.source": "device" }),
		});

		expect(model.entries[0]?.timing).toBeNull();
		expect(model.entries[0]?.rawTime).toBe("@weekly");
	});

	it("reports an unread switch as null rather than as off", () => {
		const model = buildSchedules({
			root: ROOT,
			definitions: deviceTimer("42"),
			values: values({ "42.cron": "0 8 * * 1", "42.source": "device" }),
		});

		expect(model.entries[0]?.enabled).toBeNull();
	});

	it("sorts by time and puts an unreadable one last", () => {
		const model = buildSchedules({
			root: ROOT,
			definitions: [...deviceTimer("a"), ...deviceTimer("b"), ...deviceTimer("c")],
			values: values({
				"a.cron": "0 22 * * 1",
				"a.source": "device",
				"b.cron": "not a cron",
				"b.source": "device",
				"c.cron": "30 6 * * 1",
				"c.source": "device",
			}),
		});

		expect(model.entries.map(entry => entry.id)).toEqual(["c", "a", "b"]);
	});

	it("ignores a state that is not two levels below the folder", () => {
		const model = buildSchedules({
			root: ROOT,
			definitions: [object("enabled", { type: "boolean", write: true }), object("a.b.c", { type: "string" })],
			values: {},
		});

		expect(model.entries).toEqual([]);
	});

	it("ignores an object of a different device", () => {
		const model = buildSchedules({
			root: ROOT,
			definitions: [{ id: "roborock.0.Devices.other.schedules.1.enabled", common: { type: "boolean", write: true } }],
			values: {},
		});

		expect(model.entries).toEqual([]);
	});
});

describe("saying when a schedule runs", () => {
	const t = (key: string): string => (key === "ui_schedules_every_day" ? "Every day" : "Once on %s");

	it("calls a full week every day", () => {
		expect(describeRepetition({ time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6], dayOfMonth: null, month: null }, "en", t)).toBe("Every day");
	});

	it("calls a bare cron wildcard every day too", () => {
		expect(describeRepetition({ time: "08:00", weekdays: [], dayOfMonth: null, month: null }, "en", t)).toBe("Every day");
	});

	it("names the weekdays it repeats on", () => {
		const names = weekdayNames("en");
		expect(describeRepetition({ time: "08:00", weekdays: [1, 3], dayOfMonth: null, month: null }, "en", t)).toBe(`${names[1]}, ${names[3]}`);
	});

	it("names the date of a one-off schedule", () => {
		expect(describeRepetition({ time: "08:00", weekdays: [], dayOfMonth: 24, month: 12 }, "en", t)).toBe("Once on December 24");
	});

	it("starts the week at Sunday", () => {
		expect(weekdayNames("en")[0]).toMatch(/^Sun/);
		expect(weekdayNames("en")[6]).toMatch(/^Sat/);
	});
});
