import { describe, expect, it, vi } from "vitest";
import {
	CLOSE_DND_TIMER,
	GET_DND_TIMER,
	SET_CHILD_LOCK_STATUS,
	SET_DND_TIMER,
	V1RobotSettingsService,
	dndTimerParams,
	formatDndTime,
	formatDndWindow,
	parseChildLockResponse,
	parseDndTimerResponse,
	parseDndWindow,
	windowFromNumbers
} from "../../src/lib/features/vacuum/services/V1RobotSettingsService";
import { expectationFor } from "../../src/lib/features/vacuum/commandVerification";

/**
 * Do Not Disturb and the child lock.
 *
 * Everything asserted here has a proof in the decompiled a65 control plugin; the service module
 * carries the line numbers. What the tests are for is the one thing the proof cannot guarantee -
 * that the implementation still does what the proof says, in particular the **order** of the four
 * unnamed numbers `set_dnd_timer` carries. Hours and minutes swapped would be a window the robot
 * accepts and the user never asked for.
 */

/** A minimal `FeatureDependencies` double: it records writes instead of performing them. */
function createDeps() {
	const states = new Map<string, unknown>();
	const objects = new Map<string, unknown>();

	const deps = {
		adapter: {
			namespace: "roborock.0",
			translationManager: { get: (_key: string, fallback: string) => fallback },
			setStateChanged: vi.fn(async (id: string, value: { val: unknown }) => {
				states.set(id, value.val);
			}),
			setState: vi.fn(async (id: string, value: { val: unknown }) => {
				states.set(id, value.val);
			}),
			rLog: vi.fn(),
			errorMessage: (e: unknown) => String(e)
		},
		ensureState: vi.fn(async (id: string, common: unknown) => {
			objects.set(id, common);
		}),
		ensureFolder: vi.fn(async () => undefined),
		log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
	};

	return { deps: deps as any, states, objects };
}

/** The service with its commands already registered, which is what makes it answer for them. */
function createService() {
	const { deps, states, objects } = createDeps();
	const service = new V1RobotSettingsService(deps, "duid-test");
	const registered: { name: string; spec: Record<string, unknown>; group?: string }[] = [];
	const add = (name: string, spec: Record<string, unknown>, group?: string): void => {
		registered.push({ name, spec, group });
	};

	service.registerDoNotDisturbCommands(add);
	service.registerChildLockCommand(add);
	return { service, deps, states, objects, registered };
}

describe("reading a window out of the state value", () => {
	it("accepts the human spelling", () => {
		expect(parseDndWindow("22:00-07:00")).toEqual({ startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 });
		expect(parseDndWindow(" 9:30 - 18:05 ")).toEqual({ startHour: 9, startMinute: 30, endHour: 18, endMinute: 5 });
	});

	it("accepts the four numbers that really go on the wire", () => {
		expect(parseDndWindow([22, 0, 7, 0])).toEqual({ startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 });
	});

	it("refuses everything else rather than reading it generously", () => {
		// Each of these would otherwise become a valid window at the wrong time of day.
		expect(parseDndWindow("24:00-07:00")).toBeNull();
		expect(parseDndWindow("22:60-07:00")).toBeNull();
		expect(parseDndWindow("22:00")).toBeNull();
		expect(parseDndWindow("22-07")).toBeNull();
		expect(parseDndWindow("22:0-07:00")).toBeNull();
		expect(parseDndWindow("")).toBeNull();
		expect(parseDndWindow(null)).toBeNull();
		expect(parseDndWindow([22, 0, 7])).toBeNull();
		expect(parseDndWindow([22, 0, 7, 0, 0])).toBeNull();
	});

	it("keeps a window that spans midnight, which is the normal case", () => {
		expect(parseDndWindow("22:00-07:00")).not.toBeNull();
	});

	it("rejects fractional numbers", () => {
		expect(windowFromNumbers([22.5, 0, 7, 0])).toBeNull();
	});
});

describe("the four numbers on the wire", () => {
	it("sends hour, minute, hour, minute in the order saveDoNotDisturbData uses", () => {
		// A65:849331-849341 - setDndTimer(beginHour, beginMinute, endHour, endMinute).
		expect(dndTimerParams({ startHour: 22, startMinute: 15, endHour: 7, endMinute: 45 })).toEqual([22, 15, 7, 45]);
	});

	it("formats a time and a window back for a human", () => {
		expect(formatDndTime(7, 5)).toBe("07:05");
		expect(formatDndWindow({ startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 })).toBe("22:00-07:00");
	});
});

describe("building the request", () => {
	it("turns a window into the four numbers", () => {
		const { service } = createService();
		expect(service.buildCommandParams(SET_DND_TIMER, "22:00-07:00")).toEqual({
			method: SET_DND_TIMER,
			params: [22, 0, 7, 0]
		});
	});

	it("refuses to send anything at all for an unreadable window", () => {
		const { service } = createService();
		expect(() => service.buildCommandParams(SET_DND_TIMER, "quarter past eight")).toThrow(/22:00-07:00/);
	});

	it("sends the two argument-less methods with an empty list", () => {
		const { service } = createService();
		expect(service.buildCommandParams(CLOSE_DND_TIMER, true)).toEqual({ method: CLOSE_DND_TIMER, params: [] });
		expect(service.buildCommandParams(GET_DND_TIMER, undefined)).toEqual({ method: GET_DND_TIMER, params: [] });
	});

	it("names the child lock payload lock_status and sends 1 for locked", () => {
		// A65:230080-230091 for the key, A65:851729-851737 for the two values.
		const { service } = createService();
		expect(service.buildCommandParams(SET_CHILD_LOCK_STATUS, true)).toEqual({
			method: SET_CHILD_LOCK_STATUS,
			params: { lock_status: 1 }
		});
		expect(service.buildCommandParams(SET_CHILD_LOCK_STATUS, false)).toEqual({
			method: SET_CHILD_LOCK_STATUS,
			params: { lock_status: 0 }
		});
	});

	it("answers only for the methods it registered itself", () => {
		const { deps } = createDeps();
		const bare = new V1RobotSettingsService(deps, "duid-test");
		// Nothing registered: a model class that brings its own child lock keeps it.
		expect(bare.handles(SET_CHILD_LOCK_STATUS)).toBe(false);

		const { service } = createService();
		expect(service.handles(SET_CHILD_LOCK_STATUS)).toBe(true);
		expect(service.handles(SET_DND_TIMER)).toBe(true);
		expect(service.handles("app_start")).toBe(false);
	});
});

describe("where the objects are put", () => {
	it("puts the two settings into settings and the read into queries", () => {
		const { registered } = createService();
		const byName = new Map(registered.map(entry => [entry.name, entry]));

		expect(byName.get(SET_DND_TIMER)?.group).toBe("settings");
		expect(byName.get(CLOSE_DND_TIMER)?.group).toBe("settings");
		expect(byName.get(SET_CHILD_LOCK_STATUS)?.group).toBe("settings");
		expect(byName.get(GET_DND_TIMER)?.group).toBe("queries");
	});

	it("declares the child lock as a switch, not as a button", () => {
		// A button could only ever be pressed, and the child lock has to be releasable again.
		const { registered } = createService();
		const spec = registered.find(entry => entry.name === SET_CHILD_LOCK_STATUS)?.spec;
		expect(spec?.type).toBe("boolean");
		expect(String(spec?.role).startsWith("switch")).toBe(true);
	});

	it("declares the window as text, because the robot has no writable enabled flag", () => {
		const { registered } = createService();
		const spec = registered.find(entry => entry.name === SET_DND_TIMER)?.spec;
		expect(spec?.type).toBe("string");
	});
});

describe("reading the robot's answers", () => {
	it("reads the window and the flag out of the single-element array", () => {
		// A65:948702-948745 - result[0].{start_hour,start_minute,end_hour,end_minute,enabled}.
		expect(parseDndTimerResponse([{ start_hour: 22, start_minute: 0, end_hour: 7, end_minute: 0, enabled: 1 }])).toEqual({
			window: { startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 },
			enabled: true
		});
	});

	it("reads the same answer without its array wrapping", () => {
		expect(parseDndTimerResponse({ start_hour: 1, start_minute: 2, end_hour: 3, end_minute: 4, enabled: 0 })?.enabled).toBe(false);
	});

	it("ignores the actions block, which this adapter does not implement", () => {
		const parsed = parseDndTimerResponse([
			{ start_hour: 22, start_minute: 0, end_hour: 7, end_minute: 0, enabled: 1, actions: { resume: 1, vol: 1, led: 1, dust: 1, dry: 1 } }
		]);
		expect(parsed?.window).toEqual({ startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 });
	});

	it("says nothing rather than something wrong about an unusable answer", () => {
		expect(parseDndTimerResponse(["ok"])).toBeNull();
		expect(parseDndTimerResponse(null)).toBeNull();
		// An hour out of range makes the whole window unusable; with nothing else readable beside
		// it the answer as a whole is refused.
		expect(parseDndTimerResponse([{ start_hour: 99, start_minute: 0, end_hour: 7, end_minute: 0 }])).toBeNull();
		// The same broken window next to a readable flag keeps the flag and drops only the window.
		expect(parseDndTimerResponse([{ start_hour: 99, start_minute: 0, end_hour: 7, end_minute: 0, enabled: 1 }]))
			.toEqual({ window: null, enabled: true });
	});

	it("reads the child lock answer, where the payload is not wrapped in an array", () => {
		// A65:851815-851822 - r1.result.lock_status, and locked is 1.
		expect(parseChildLockResponse({ lock_status: 1 })).toBe(true);
		expect(parseChildLockResponse({ lock_status: 0 })).toBe(false);
		expect(parseChildLockResponse([{ lock_status: 1 }])).toBe(true);
		expect(parseChildLockResponse({})).toBeNull();
		expect(parseChildLockResponse("ok")).toBeNull();
	});
});

describe("publishing the window", () => {
	it("writes start and end as readable times and mirrors the window into the writable state", async () => {
		const { service, states } = createService();
		await service.applyDndTimerResponse([{ start_hour: 22, start_minute: 0, end_hour: 7, end_minute: 30, enabled: 1 }]);

		expect(states.get("Devices.duid-test.deviceStatus.dnd_start")).toBe("22:00");
		expect(states.get("Devices.duid-test.deviceStatus.dnd_end")).toBe("07:30");
		expect(states.get("Devices.duid-test.settings.set_dnd_timer")).toBe("22:00-07:30");
	});

	it("publishes nothing and logs when the answer carries no window", async () => {
		const { service, states, deps } = createService();
		expect(await service.applyDndTimerResponse("nonsense")).toBe(false);
		expect(states.has("Devices.duid-test.deviceStatus.dnd_start")).toBe(false);
		expect(deps.adapter.rLog).toHaveBeenCalled();
	});

	it("mirrors the child lock out of the status field", async () => {
		const { service, states } = createService();
		await service.mirrorStatusField("lock_status", 1);
		expect(states.get("Devices.duid-test.settings.set_child_lock_status")).toBe(true);

		await service.mirrorStatusField("lock_status", 0);
		expect(states.get("Devices.duid-test.settings.set_child_lock_status")).toBe(false);
	});
});

describe("what the silent-failure check expects of these commands", () => {
	it("expects the child lock payload to show up under its own name", () => {
		expect(expectationFor(SET_CHILD_LOCK_STATUS, { lock_status: 1 })).toEqual({ lock_status: 1 });
		expect(expectationFor(SET_CHILD_LOCK_STATUS, [{ lock_status: 0 }])).toEqual({ lock_status: 0 });
	});

	it("expects the two Do Not Disturb commands to switch dnd_enabled, whatever they carry", () => {
		// A65:851190-851262 - the two are the two positions of one switch.
		expect(expectationFor(SET_DND_TIMER, [22, 0, 7, 0])).toEqual({ dnd_enabled: 1 });
		expect(expectationFor(CLOSE_DND_TIMER, [])).toEqual({ dnd_enabled: 0 });
	});

	it("still derives the old commands from their payload", () => {
		expect(expectationFor("set_custom_mode", [104])).toEqual({ fan_power: 104 });
		expect(expectationFor("set_clean_motor_mode", [{ fan_power: 102, water_box_mode: 201, mop_mode: 300 }]))
			.toEqual({ fan_power: 102, water_box_mode: 201, mop_mode: 300 });
	});
});
