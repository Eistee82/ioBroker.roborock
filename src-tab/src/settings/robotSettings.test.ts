import { describe, expect, it } from "vitest";
import {
	buildRobotSettings,
	composeWindow,
	isValidTimeOfDay,
	planSwitchWrite,
	planTimeWindowWrite,
	settingsRoot,
	settingsStateIds,
} from "./robotSettings";
import type { SettingStateDefinition, SettingStateValue, SwitchSetting, TimeWindowSetting } from "./robotSettings";

/**
 * Which settings the panel offers, and what a change to one of them writes.
 *
 * The riskiest part is the last one: unlike the cleaning history, these controls send commands to
 * the robot. The two rules that must not drift are that switching Do Not Disturb **on** is the same
 * act as sending its window - the protocol has no separate flag - and that editing a time while the
 * mode is off sends nothing at all. Both come from the app's own switch handler; the proofs are in
 * `src/lib/features/vacuum/services/V1RobotSettingsService.ts`.
 */

const ROOT = settingsRoot("roborock.0", "duid1");

/** Builds the two maps out of a flat description of the branch. */
function branch(entries: Record<string, { val?: unknown; name?: unknown; desc?: string }>): {
	definitions: SettingStateDefinition[];
	values: Record<string, SettingStateValue | null>;
} {
	const definitions: SettingStateDefinition[] = [];
	const values: Record<string, SettingStateValue | null> = {};
	for (const [key, entry] of Object.entries(entries)) {
		const id = `${ROOT}.${key}`;
		definitions.push({ id, common: { name: entry.name, desc: entry.desc } });
		if ("val" in entry) values[id] = { val: entry.val };
	}
	return { definitions, values };
}

function build(entries: Record<string, { val?: unknown; name?: unknown; desc?: string }>, language = "en") {
	return buildRobotSettings({ root: ROOT, language, ...branch(entries) });
}

/** The full branch of a robot that has both settings. */
const FULL = {
	"settings.set_dnd_timer": { val: "22:00-07:00", name: "Do Not Disturb Mode", desc: "Window as HH:MM-HH:MM" },
	"settings.close_dnd_timer": { val: false, name: "Do Not Disturb Mode off" },
	"settings.set_child_lock_status": { val: true, name: "Child Lock" },
	"deviceStatus.dnd_enabled": { val: 1 },
	"deviceStatus.dnd_start": { val: "22:00" },
	"deviceStatus.dnd_end": { val: "07:00" },
};

describe("which settings are offered", () => {
	it("offers both when the adapter published both", () => {
		const model = build(FULL);
		expect(model.entries.map(entry => entry.command)).toEqual(["set_dnd_timer", "set_child_lock_status"]);
	});

	it("offers nothing for a robot whose objects the adapter never created", () => {
		expect(build({}).entries).toEqual([]);
	});

	it("skips a setting whose own object is missing", () => {
		const entries = { ...FULL };
		delete (entries as Record<string, unknown>)["settings.set_child_lock_status"];
		expect(build(entries).entries.map(entry => entry.command)).toEqual(["set_dnd_timer"]);
	});

	it("skips the window when only half of it exists, because the switch would be one-way", () => {
		const entries = { ...FULL };
		delete (entries as Record<string, unknown>)["settings.close_dnd_timer"];
		expect(build(entries).entries.map(entry => entry.command)).toEqual(["set_child_lock_status"]);
	});

	it("takes the label from the object rather than from a table of its own", () => {
		const model = build({ ...FULL, "settings.set_child_lock_status": { val: false, name: "Kindersicherung" } });
		const lock = model.entries.find(entry => entry.command === "set_child_lock_status");
		expect(lock?.label).toBe("Kindersicherung");
	});

	it("resolves a per-language object name", () => {
		const model = build({ ...FULL, "settings.set_child_lock_status": { val: false, name: { en: "Child Lock", de: "Kindersicherung" } } }, "de");
		expect(model.entries.find(entry => entry.command === "set_child_lock_status")?.label).toBe("Kindersicherung");
	});
});

describe("what the model says about the current state", () => {
	it("reads the window and its flag", () => {
		const window = build(FULL).entries[0] as TimeWindowSetting;
		expect(window.kind).toBe("timeWindow");
		expect(window.enabled).toBe(true);
		expect(window.start).toBe("22:00");
		expect(window.end).toBe("07:00");
		expect(window.offCommand).toBe("close_dnd_timer");
	});

	it("reads the number the status reports as a flag", () => {
		const off = build({ ...FULL, "deviceStatus.dnd_enabled": { val: 0 } }).entries[0] as TimeWindowSetting;
		expect(off.enabled).toBe(false);
	});

	it("says unknown rather than off while the robot has not reported", () => {
		const entries = { ...FULL };
		delete (entries as Record<string, unknown>)["deviceStatus.dnd_enabled"];
		const window = build(entries).entries[0] as TimeWindowSetting;
		expect(window.enabled).toBeNull();

		const noWindow = build({ ...FULL, "deviceStatus.dnd_start": { val: "" } }).entries[0] as TimeWindowSetting;
		expect(noWindow.start).toBeNull();
	});

	it("reads the child lock switch", () => {
		const lock = build(FULL).entries[1] as SwitchSetting;
		expect(lock.kind).toBe("switch");
		expect(lock.value).toBe(true);
	});
});

describe("the state ids the source has to read", () => {
	it("names every state the model consumes and nothing else", () => {
		expect(settingsStateIds(ROOT).sort()).toEqual([
			`${ROOT}.deviceStatus.dnd_enabled`,
			`${ROOT}.deviceStatus.dnd_end`,
			`${ROOT}.deviceStatus.dnd_start`,
			`${ROOT}.settings.close_dnd_timer`,
			`${ROOT}.settings.set_child_lock_status`,
			`${ROOT}.settings.set_collision_avoid_status`,
			`${ROOT}.settings.set_dnd_timer`,
		].sort());
	});
});

describe("checking a time of day", () => {
	it("accepts the times a robot can hold", () => {
		expect(isValidTimeOfDay("00:00")).toBe(true);
		expect(isValidTimeOfDay("23:59")).toBe(true);
		expect(isValidTimeOfDay("9:30")).toBe(true);
	});

	it("refuses everything outside them", () => {
		expect(isValidTimeOfDay("24:00")).toBe(false);
		expect(isValidTimeOfDay("22:60")).toBe(false);
		expect(isValidTimeOfDay("22")).toBe(false);
		expect(isValidTimeOfDay("")).toBe(false);
		expect(isValidTimeOfDay("22:0")).toBe(false);
	});

	it("pads a single-digit hour to what the adapter publishes back", () => {
		expect(composeWindow("9:30", "18:05")).toBe("09:30-18:05");
	});

	it("composes nothing out of an unusable time", () => {
		expect(composeWindow("25:00", "07:00")).toBeNull();
	});
});

describe("what a change writes", () => {
	const window = build(FULL).entries[0] as TimeWindowSetting;
	const offWindow = build({ ...FULL, "deviceStatus.dnd_enabled": { val: 0 } }).entries[0] as TimeWindowSetting;

	it("switching on sends the window, because that is what switching on is", () => {
		expect(planTimeWindowWrite(offWindow, { start: "22:00", end: "07:00", enabled: true })).toEqual({
			folder: "settings",
			command: "set_dnd_timer",
			value: "22:00-07:00",
		});
	});

	it("switching off presses the off command and carries no window", () => {
		expect(planTimeWindowWrite(window, { start: "22:00", end: "07:00", enabled: false })).toEqual({
			folder: "settings",
			command: "close_dnd_timer",
			value: true,
		});
	});

	it("retiming while it is on rewrites the window", () => {
		expect(planTimeWindowWrite(window, { start: "23:15", end: "06:45", enabled: true })).toEqual({
			folder: "settings",
			command: "set_dnd_timer",
			value: "23:15-06:45",
		});
	});

	it("sends nothing at all when a time is unusable", () => {
		expect(planTimeWindowWrite(window, { start: "25:00", end: "07:00", enabled: true })).toBeNull();
	});

	it("does not press off on a window that is already off", () => {
		expect(planTimeWindowWrite(offWindow, { start: "22:00", end: "07:00", enabled: false })).toBeNull();
	});

	it("presses off on a window whose state is unknown, rather than assuming it is already off", () => {
		const entries = { ...FULL };
		delete (entries as Record<string, unknown>)["deviceStatus.dnd_enabled"];
		const unknown = build(entries).entries[0] as TimeWindowSetting;
		expect(planTimeWindowWrite(unknown, { start: "22:00", end: "07:00", enabled: false })?.command).toBe("close_dnd_timer");
	});

	it("writes both positions of a switch", () => {
		const lock = build(FULL).entries[1] as SwitchSetting;
		expect(planSwitchWrite(lock, false)).toEqual({ folder: "settings", command: "set_child_lock_status", value: false });
		expect(planSwitchWrite(lock, true)).toEqual({ folder: "settings", command: "set_child_lock_status", value: true });
	});
});
