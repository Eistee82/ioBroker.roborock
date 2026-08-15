import { describe, expect, it, vi } from "vitest";
import {
	APP_RC_END,
	APP_RC_MOVE,
	APP_RC_START,
	APP_RC_STOP,
	REMOTE_DIRECTIONS,
	REMOTE_DURATION_MS,
	REMOTE_LAUNCH_MS,
	REMOTE_LEASE_MS,
	REMOTE_OMEGA,
	REMOTE_REFRESH_MS,
	REMOTE_VELOCITY,
	RemoteControlService,
	isKnownRemoteDirection,
	motionForDirection,
	remoteStartVerdict
} from "../../src/lib/features/vacuum/remoteControl";
import type { RemoteClock } from "../../src/lib/features/vacuum/remoteControl";

/**
 * What the adapter is allowed to send when somebody drives the robot by hand.
 *
 * Every expectation in the first block is a number read out of the decompiled control plugin, not a
 * value that seemed reasonable - the whole point of pinning them is that a later edit which "rounds"
 * 0.525 or drops `duration` fails here instead of at a skirting board. The Fundstellen are in the
 * module comment of `remoteControl.ts`; the table below repeats the line numbers so a failing
 * assertion says where to look.
 */
describe("the motion parameter the app sends", () => {
	it("uses the app's own two magnitudes and its 1.5 s duration", () => {
		// A65:791535 (velocity), A65:789647-789657 (omega), A65:789659 (duration).
		expect(REMOTE_VELOCITY).toBe(0.2);
		expect(REMOTE_OMEGA).toBe(0.525);
		expect(REMOTE_DURATION_MS).toBe(1500);
	});

	it("computes omega exactly as the app does", () => {
		// The app does not write 0.525 down; it computes it. If the divisor ever changes, this is
		// the assertion that notices.
		expect(REMOTE_OMEGA).toBe(Math.round((Math.PI / 3) * 100) / 200);
	});

	it("repeats far more often than the robot keeps driving", () => {
		// This ratio *is* the safety design (A65:790975 against A65:789659): a sender that goes away
		// leaves at most one duration of travel behind.
		expect(REMOTE_REFRESH_MS).toBe(400);
		expect(REMOTE_DURATION_MS).toBeGreaterThan(REMOTE_REFRESH_MS * 3);
	});

	it("closes the mode later than the firmware stops the wheels", () => {
		// The lease must never be the thing that halts the robot - by the time it fires, the
		// firmware has stopped it already.
		expect(REMOTE_LEASE_MS).toBeGreaterThan(REMOTE_DURATION_MS);
	});

	it("waits as long as the app before the first move", () => {
		expect(REMOTE_LAUNCH_MS).toBe(6000); // A65:790965
	});

	/**
	 * The eight directions, exactly as `_handlePressEvent` builds them.
	 *
	 * Read as: pressState, velocity, omega. A sign flip here is a robot reversing into something.
	 */
	const CASES: ReadonlyArray<[number, number, number]> = [
		[1, +REMOTE_VELOCITY, 0], // A65:791535
		[2, -REMOTE_VELOCITY, 0], // A65:791525
		[3, 0, +REMOTE_OMEGA], // A65:791531
		[4, 0, -REMOTE_OMEGA], // A65:791519
		[5, -REMOTE_VELOCITY, +REMOTE_OMEGA], // A65:791514
		[6, +REMOTE_VELOCITY, +REMOTE_OMEGA], // A65:791509
		[7, -REMOTE_VELOCITY, -REMOTE_OMEGA], // A65:791503
		[8, +REMOTE_VELOCITY, -REMOTE_OMEGA] // A65:791497
	];

	it.each(CASES)("direction %i drives at %f and turns at %f", (direction, velocity, omega) => {
		expect(motionForDirection(direction, 7)).toEqual({ omega, velocity, seqnum: 7, duration: REMOTE_DURATION_MS });
	});

	it("has no motion for 'stand still'", () => {
		// Not a zero motion: the app sends `app_rc_stop` instead (A65:790666-790690).
		expect(motionForDirection(0, 1)).toBeNull();
	});

	it("knows exactly the nine values the app can express", () => {
		expect(REMOTE_DIRECTIONS.map((entry) => entry.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(isKnownRemoteDirection(9)).toBe(false);
		expect(isKnownRemoteDirection(-1)).toBe(false);
	});
});

describe("what the robot's state means for starting", () => {
	it("refuses only while the firmware is updating", () => {
		// A65:785772-785783 - the one state the app turns down outright.
		expect(remoteStartVerdict(14)).toBe("refuse");
	});

	it.each([5, 6, 11, 16, 17, 18])("asks before interrupting state %i", (stateCode) => {
		expect(remoteStartVerdict(stateCode)).toBe("confirm");
	});

	it.each([2, 3, 8, 10, 100])("goes straight through in state %i", (stateCode) => {
		expect(remoteStartVerdict(stateCode)).toBe("go");
	});

	it("already being in remote control is not an obstacle", () => {
		// A65:785784 - the app goes straight through when the robot is already in state 4.
		expect(remoteStartVerdict(4)).toBe("go");
	});

	it("treats an unknown state the way the app treats everything it does not list", () => {
		expect(remoteStartVerdict(null)).toBe("go");
		expect(remoteStartVerdict(undefined)).toBe("go");
		expect(remoteStartVerdict(Number.NaN)).toBe("go");
	});
});

/** A clock whose only timer can be fired on demand, so a two second lease costs no waiting. */
function createClock(): RemoteClock & { fire: () => void; armed: () => boolean } {
	let pending: (() => void) | null = null;
	let handle = 0;
	return {
		setTimeout: (handler) => {
			pending = handler;
			return ++handle;
		},
		clearTimeout: () => {
			pending = null;
		},
		fire: () => {
			const handler = pending;
			pending = null;
			handler?.();
		},
		armed: () => pending !== null
	};
}

function createService(): {
	service: RemoteControlService;
	sent: Array<{ method: string; params: unknown }>;
	clock: ReturnType<typeof createClock>;
	activeLog: boolean[];
} {
	const sent: Array<{ method: string; params: unknown }> = [];
	const clock = createClock();
	const activeLog: boolean[] = [];
	const service = new RemoteControlService(
		{
			sendRequest: async (_duid, method, params) => {
				sent.push({ method, params });
				return ["ok"];
			}
		},
		clock,
		"duid-test",
		() => undefined,
		(active) => activeLog.push(active)
	);
	return { service, sent, clock, activeLog };
}

describe("the remote control session", () => {
	it("sends the three parameterless calls with an empty array", () => {
		// A65:229609-229624, A65:229625-229634, A65:229575-229590 - all three build `new Array(0)`.
		const { service } = createService();
		for (const method of [APP_RC_START, APP_RC_STOP, APP_RC_END]) {
			expect(service.buildCommandParams(method, undefined)).toEqual({ method, params: [] });
		}
	});

	it("wraps the motion in a one element array, as the wrapper does", () => {
		// A65:229591-229608: `new Array(1)` with the argument at index 0.
		const { service } = createService();
		const built = service.buildCommandParams(APP_RC_MOVE, 1);
		expect(built.method).toBe(APP_RC_MOVE);
		expect(built.params).toEqual([{ omega: 0, velocity: REMOTE_VELOCITY, seqnum: 1, duration: REMOTE_DURATION_MS }]);
	});

	it("raises the sequence number before every move", () => {
		// A65:790647-790660 - the app raises it on the clone it is about to send.
		const { service } = createService();
		const seqnums = [1, 2, 3].map(() => {
			const built = service.buildCommandParams(APP_RC_MOVE, 1);
			return (built.params as Array<{ seqnum: number }>)[0].seqnum;
		});
		expect(seqnums).toEqual([1, 2, 3]);
	});

	it("turns 'stand still' into the stop call rather than a zero motion", () => {
		const { service } = createService();
		expect(service.buildCommandParams(APP_RC_MOVE, 0)).toEqual({ method: APP_RC_STOP, params: [] });
	});

	it("refuses a direction the app cannot express", () => {
		// The whole reason the direction is a number with `states` and not a free motion parameter:
		// a value nobody proved must not reach a machine that moves.
		const { service } = createService();
		expect(() => service.buildCommandParams(APP_RC_MOVE, 9)).toThrow(/accepts the directions/);
		expect(() => service.buildCommandParams(APP_RC_MOVE, "sideways")).toThrow(/accepts the directions/);
	});

	it("refuses an empty value instead of reading it as 'stand still'", () => {
		// Found by this test: `Number(null)`, `Number(false)`, `Number("")` and `Number([])` are all
		// 0, which is a valid direction. That fails in the harmless direction but hides a caller
		// error behind a stop nobody asked for, so these are rejected outright.
		const { service } = createService();
		for (const value of [null, undefined, false, "", "   ", []]) {
			expect(() => service.buildCommandParams(APP_RC_MOVE, value)).toThrow(/accepts the directions/);
		}
	});

	it("arms the lease when a session opens and drops it when it closes", () => {
		const { service, clock } = createService();
		expect(clock.armed()).toBe(false);

		service.noteStarted();
		expect(clock.armed()).toBe(true);
		expect(service.isActive).toBe(true);

		service.noteEnded();
		expect(clock.armed()).toBe(false);
		expect(service.isActive).toBe(false);
	});

	it("ends the mode when nothing has been heard for a whole lease", async () => {
		// The failure this exists for: the tab is closed mid-session. The wheels are already stopped
		// by then (the firmware's own duration), but the mode would otherwise stay open forever.
		const { service, sent, clock } = createService();
		service.noteStarted();
		clock.fire();
		await vi.waitFor(() => expect(sent.map((entry) => entry.method)).toEqual([APP_RC_STOP, APP_RC_END]));
		expect(service.isActive).toBe(false);
	});

	it("does not end a session that is still being steered", () => {
		const { service, sent, clock } = createService();
		service.noteStarted();
		service.noteActivity();
		service.noteActivity();
		expect(clock.armed()).toBe(true);
		expect(sent).toEqual([]);
	});

	it("never repeats a move by itself", async () => {
		// The rule with damage attached. Building the parameters of a move must not schedule
		// anything; only a caller that comes back sends another one.
		const { service, sent, clock } = createService();
		service.noteStarted();
		service.buildCommandParams(APP_RC_MOVE, 1);
		service.noteActivity();
		clock.fire();
		await vi.waitFor(() => expect(sent.length).toBe(2));
		expect(sent.map((entry) => entry.method)).toEqual([APP_RC_STOP, APP_RC_END]);
	});

	it("ignores activity on a session that was never opened", () => {
		// A stray move without a start must not arm a lease - the adapter would otherwise send
		// `app_rc_end` to a robot it never put into the mode.
		const { service, clock } = createService();
		service.noteActivity();
		expect(clock.armed()).toBe(false);
	});

	it("reports the run-up and lets it run out", () => {
		const { service } = createService();
		expect(service.launchRemainingMs).toBe(0);

		const times = [0, 1000, REMOTE_LAUNCH_MS + 1];
		let index = 0;
		const timed = new RemoteControlService(
			{ sendRequest: async () => ["ok"] },
			createClock(),
			"duid-test",
			() => undefined,
			() => undefined,
			() => times[Math.min(index++, times.length - 1)]
		);
		timed.noteStarted(); // reads times[0] = 0
		expect(timed.launchRemainingMs).toBe(REMOTE_LAUNCH_MS - 1000);
		expect(timed.launchRemainingMs).toBe(0);
	});

	it("tells the caller whenever a session opens or closes", async () => {
		// What makes the restart recovery possible: the caller writes this down.
		const { service, activeLog, clock } = createService();
		service.noteStarted();
		clock.fire();
		await vi.waitFor(() => expect(activeLog).toEqual([true, false]));
	});

	it("says nothing twice when a closed session is closed again", () => {
		const { service, activeLog } = createService();
		service.noteStarted();
		service.noteEnded();
		service.noteEnded();
		expect(activeLog).toEqual([true, false]);
	});

	it("closes a session an earlier run left behind, and only then", async () => {
		const { service, sent } = createService();

		await service.recoverLeftoverSession(false);
		expect(sent).toEqual([]);

		await service.recoverLeftoverSession(true);
		expect(sent.map((entry) => entry.method)).toEqual([APP_RC_STOP, APP_RC_END]);
	});

	it("starts the closing calls on shutdown", async () => {
		const { service, sent } = createService();
		service.noteStarted();
		service.shutdown();
		await vi.waitFor(() => expect(sent.map((entry) => entry.method)).toEqual([APP_RC_STOP, APP_RC_END]));
	});

	it("sends nothing on shutdown when no session is open", () => {
		const { service, sent } = createService();
		service.shutdown();
		expect(sent).toEqual([]);
	});

	it("survives a robot that refuses the closing calls", async () => {
		// `closeSession` runs from a lease expiry and from the shutdown; there is nobody to report a
		// failure to and nothing useful to do with it, so it must not escape.
		const failing = new RemoteControlService(
			{ sendRequest: async () => { throw new Error("no route to host"); } },
			createClock(),
			"duid-test",
			() => undefined
		);
		failing.noteStarted();
		await expect(failing.closeSession("test")).resolves.toBeUndefined();
		expect(failing.isActive).toBe(false);
	});
});
