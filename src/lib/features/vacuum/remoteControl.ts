import type { FeatureDependencies } from "../baseDeviceFeatures";

/**
 * Driving the robot by hand - the four `app_rc_*` calls, the motion parameter, and the dead man's
 * switch that has to end the mode when nobody is steering any more.
 *
 * ## Where every value here comes from
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`. Every one of them
 * was re-read for this module rather than copied out of the report; two claims in
 * `_appanalysis/20-positionsquellen.md` did not survive that and are corrected below.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `remoteStart` | `Methods.AppRemoteControlStart` = `app_rc_start` | `new Array(0)`, i.e. `[]` | A65:229609-229624 |
 * | `remoteMove` | `Methods.AppRemoteControlMove` = `app_rc_move` | `new Array(1)`, the motion object | A65:229591-229608 |
 * | `remoteStop` | `'app_rc_stop'` (string literal) | `[]` | A65:229625-229634 |
 * | `remoteEnd` | `Methods.AppRemoteControlEnd` = `app_rc_end` | `[]` | A65:229575-229590 |
 *
 * The three `Methods.*` constants resolve in the non-Mi branch of the method table at A65:238179
 * (`'AppRemoteControlMove': 'app_rc_move'`, `…Start': 'app_rc_start'`, `…End': 'app_rc_end'`).
 *
 * ## The motion parameter
 *
 * The joystick (module 2639) starts from `{omega: 0, velocity: 0, seqnum: 0, duration: 1500}`
 * (A65:789659) and sends that whole object, with `seqnum` raised by one before every send
 * (A65:790647-790660 inside `move()`). `updateMotionParam(velocity, omega)` writes only those two
 * fields onto a clone (A65:790648-790652), so the shape never changes.
 *
 * The eight directions come from `_handlePressEvent` (A65:791481-791535), which ends in
 * `updateMotionParam(r10, r8)` at A65:791616-791617 - r10 is the velocity, r8 the turn rate:
 *
 * | Direction | `pressState` | `velocity` | `omega` | Fundstelle |
 * | --- | --- | --- | --- | --- |
 * | forward | 1 | +0.2 | 0 | A65:791535 |
 * | back | 2 | -0.2 | 0 | A65:791525 |
 * | left | 3 | 0 | +Ω | A65:791531 |
 * | right | 4 | 0 | -Ω | A65:791519 |
 * | left-back | 5 | -0.2 | +Ω | A65:791514 |
 * | left-forward | 6 | +0.2 | +Ω | A65:791509 |
 * | right-back | 7 | -0.2 | -Ω | A65:791503 |
 * | right-forward | 8 | +0.2 | -Ω | A65:791497 |
 *
 * **Ω = 0.525**, computed once at A65:789647-789657 as `Math.round(Math.PI / 3 * 100) / 200`; the
 * divisor 3 is the register set at A65:789509 and is not touched in between (checked over the whole
 * range). `round(104.7197) / 200 = 105 / 200`.
 *
 * The analog ring of the same component quantises its angle into exactly these four cardinal cases
 * and emits the very same numbers (A65:791608-791640) - it never produces an intermediate value. So
 * the set is closed: `velocity ∈ {-0.2, 0, +0.2}`, `omega ∈ {-0.525, 0, +0.525}`. **Nothing here is
 * interpolated**, because nothing in the app is.
 *
 * The unit is not stated anywhere in the bundle. `velocity 0.2` sits next to 179-216 mm/s measured
 * at the robot (`_appanalysis/fahrt.log`), which suggests m/s - that is plausibility, not proof, and
 * nothing in this module depends on it.
 *
 * ## The watchdog is the firmware's, not ours
 *
 * `duration: 1500` travels with every move, and the app repeats the move every **400 ms**
 * (`setInterval(() => this.move(), 400)`, A65:790975). That factor of nearly four is the whole
 * safety design: if the sender goes away, the robot carries on for at most 1.5 s and then stops by
 * itself. This module keeps it exactly that way - **it never repeats a move on its own.** Every
 * `app_rc_move` that leaves the adapter was caused by a message that arrived from a live caller;
 * a control that kept driving because a "stop" was lost is the one failure with real damage
 * attached.
 *
 * What the adapter adds on top is a dead man's switch for the *mode*, not for the motion: after
 * {@link REMOTE_LEASE_MS} without any remote message the session is closed with `app_rc_stop` and
 * `app_rc_end`. It is deliberately longer than the firmware's 1500 ms, so the wheels have always
 * stopped by themselves before it fires; its job is only that the robot does not sit in state 4
 * forever because a browser tab was closed.
 *
 * ## Six seconds of run-up
 *
 * After a successful `app_rc_start` the app sets `isRemoteLaunching` and clears it from a single
 * `setTimeout(…, 6000)` (A65:790960-790965); `move()` returns early the whole time (A65:790722ff).
 * So the app sends **no** `app_rc_move` for six seconds after starting. All seven places that touch
 * that flag were checked; nothing else clears it. This module mirrors the wait rather than firing
 * moves into a robot that is still standing up.
 *
 * ## What the app checks before it starts
 *
 * `_checkRemoteControlCondition(callback)` (A65:785665-785840):
 *
 *  - `UPDATING` (14): refused outright with a toast, `localization_strings_Setting_RemoteControlPage_13`
 *    (A65:785772-785783).
 *  - `SPOT_CLEAN` (11), `CLEAN` (5), `SEGMENT_CLEAN` (18), `BACK_TO_DOCK` (6), `GOTO_TARGET` (16),
 *    `ZONED_CLEAN` (17): an alert `localization_strings_abort_current_task_and_start_remote`, whose
 *    confirm button sends `app_pause` first and only then goes on (A65:785813-785832).
 *  - `REMOTE` (4): straight through, the robot is already there (A65:785784).
 *  - anything else: straight through (A65:785773-785777).
 *
 * The numbers are the `RobotState` enum at A65:378897, which agrees value for value with
 * `VACUUM_CONSTANTS.stateCodes`.
 *
 * A second, narrower gate sits on the joystick itself: `askShouldStartOrMove`
 * (A65:790476-790590) asks the same question again for `BACK_TO_DOCK`, `isCleanTaskShouldResume()`,
 * `isCleaning()` and `GOTO_TARGET` before the first move.
 *
 * ## Two corrections to `_appanalysis/20-positionsquellen.md`
 *
 * 1. §1.1 attributes the capability to `get_fw_features`. The app reads it from `robotFeatures`,
 *    which is filled from `app_get_init_status().result[0].feature_info` (A65:5773) - a different
 *    call. On the test device both answer the identical list `[111…125]`
 *    (`_appanalysis/geraetefaehigkeiten-1786790619395.json`), so the conclusion holds, but the
 *    source named there is not the one the app uses. The definition itself is now proven:
 *    `isRemoteSupported() { return isSupportFeature(125); }` at A65:232713-232720, and
 *    `isSupportFeature(x)` is `robotFeatures.findIndex(f => f == x) != -1` (A65:234799-234825).
 * 2. §1.3 puts `clearInterval(loopTimer)` **and** `remoteEnd()` at A65:791159-791175. That range is
 *    `componentWillUnmount`, and it only clears the interval (A65:791159-791173). The `remoteEnd`
 *    lives in `stop()` at A65:791093-791096, which also sets `shouldMove = false` and
 *    `isRemoteStarted = false`. The difference matters: unmounting the joystick alone does **not**
 *    leave the mode, which is precisely why this module never relies on a component going away.
 */

/** Starts the remote control mode; the robot answers before it is ready to drive. */
export const APP_RC_START = "app_rc_start";

/** Carries one motion for at most `duration` milliseconds. */
export const APP_RC_MOVE = "app_rc_move";

/** Ends the motion but stays in the mode (A65:790648-790690). */
export const APP_RC_STOP = "app_rc_stop";

/** Leaves the mode. */
export const APP_RC_END = "app_rc_end";

/** Firmware feature id that says the robot can be driven by hand (A65:232713-232720). */
export const REMOTE_FIRMWARE_FEATURE = 125;

/** Forward and reverse speed the app sends; see the module comment for the unit question. */
export const REMOTE_VELOCITY = 0.2;

/** Turn rate the app sends: `Math.round(Math.PI / 3 * 100) / 200` (A65:789647-789657). */
export const REMOTE_OMEGA = 0.525;

/** How long the robot acts on one move before it stops by itself, in ms (A65:789659). */
export const REMOTE_DURATION_MS = 1500;

/** How often the app repeats the move while a direction is held, in ms (A65:790975). */
export const REMOTE_REFRESH_MS = 400;

/** How long the app waits after `app_rc_start` before its first move, in ms (A65:790965). */
export const REMOTE_LAUNCH_MS = 6000;

/**
 * How long a session survives without a message before the adapter closes it, in ms.
 *
 * Longer than {@link REMOTE_DURATION_MS} on purpose: the wheels are already stopped by the firmware
 * when this fires, so it never has to be the thing that halts the robot - it only makes sure the
 * mode does not outlive the person who opened it. Long enough that a single dropped refresh at the
 * app's own 400 ms cadence cannot end a session that is still being steered.
 */
export const REMOTE_LEASE_MS = 2000;

/** Robot state code that means the remote control mode is running (`RobotState.REMOTE`, A65:378897). */
export const ROBOT_STATE_REMOTE = 4;

/** Robot state code the app refuses to leave for the remote mode (`RobotState.UPDATING`). */
export const ROBOT_STATE_UPDATING = 14;

/**
 * States the app interrupts with `app_pause` after asking, rather than entering remote mode
 * directly (A65:785732-785766, values from A65:378897).
 */
export const ROBOT_STATES_NEEDING_CONFIRMATION: ReadonlyArray<number> = [
	5, // CLEAN
	6, // BACK_TO_DOCK
	11, // SPOT_CLEAN
	16, // GOTO_TARGET
	17, // ZONED_CLEAN
	18 // SEGMENT_CLEAN
];

/**
 * The eight directions of the app's pad, plus the value that means "stand still".
 *
 * The numbers are the app's own `pressState` (A65:791481-791535), not an invention of this module,
 * so a log line here and a log line in the app name the same thing.
 *
 * The labels stay English. Roborock's own string table has wordings for the remote page but **none
 * for the eight directions** (checked across `lib/protocols/roborock_strings.json`), and inventing a
 * key that resolves to nothing would only look like a translation. The admin tab carries its own,
 * translated labels for the pad; these are the names of the ioBroker state values.
 */
export const REMOTE_DIRECTIONS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: 0, label: "Stop" },
	{ value: 1, label: "Forward" },
	{ value: 2, label: "Backward" },
	{ value: 3, label: "Turn left" },
	{ value: 4, label: "Turn right" },
	{ value: 5, label: "Back left" },
	{ value: 6, label: "Forward left" },
	{ value: 7, label: "Back right" },
	{ value: 8, label: "Forward right" }
];

/** One `app_rc_move` payload, in the field order the app builds it in (A65:789659). */
export interface RemoteMotion {
	omega: number;
	velocity: number;
	seqnum: number;
	duration: number;
}

/** What the robot's current state means for a request to start driving it. */
export type RemoteStartVerdict = "go" | "confirm" | "refuse";

/**
 * Reads a robot state code as a verdict on starting the remote mode.
 *
 * Mirrors `_checkRemoteControlCondition` and nothing beyond it. An unknown or missing state is
 * `"go"`, because that is what the app does with everything it does not list - erring the other way
 * would block the function on every robot whose state the adapter has not read yet.
 *
 * @param stateCode Value of `deviceStatus.state`, or null when none was read.
 * @returns `refuse` while the firmware is updating, `confirm` for a running job, `go` otherwise.
 */
export function remoteStartVerdict(stateCode: number | null | undefined): RemoteStartVerdict {
	if (stateCode === null || stateCode === undefined || !Number.isFinite(stateCode)) return "go";
	if (stateCode === ROBOT_STATE_UPDATING) return "refuse";
	if (ROBOT_STATES_NEEDING_CONFIRMATION.includes(stateCode)) return "confirm";
	return "go";
}

/** True for a value the direction state may be set to. */
export function isKnownRemoteDirection(value: number): boolean {
	return REMOTE_DIRECTIONS.some((direction) => direction.value === value);
}

/**
 * Builds the motion of one direction.
 *
 * @param direction One of {@link REMOTE_DIRECTIONS}; 0 has no motion and returns null.
 * @param seqnum Sequence number to send, already raised by the caller.
 * @returns The payload, or null for "stand still" - which the app sends as `app_rc_stop`.
 */
export function motionForDirection(direction: number, seqnum: number): RemoteMotion | null {
	const forward = REMOTE_VELOCITY;
	const back = -REMOTE_VELOCITY;
	const left = REMOTE_OMEGA;
	const right = -REMOTE_OMEGA;

	switch (direction) {
		case 1:
			return { omega: 0, velocity: forward, seqnum, duration: REMOTE_DURATION_MS };
		case 2:
			return { omega: 0, velocity: back, seqnum, duration: REMOTE_DURATION_MS };
		case 3:
			return { omega: left, velocity: 0, seqnum, duration: REMOTE_DURATION_MS };
		case 4:
			return { omega: right, velocity: 0, seqnum, duration: REMOTE_DURATION_MS };
		case 5:
			return { omega: left, velocity: back, seqnum, duration: REMOTE_DURATION_MS };
		case 6:
			return { omega: left, velocity: forward, seqnum, duration: REMOTE_DURATION_MS };
		case 7:
			return { omega: right, velocity: back, seqnum, duration: REMOTE_DURATION_MS };
		case 8:
			return { omega: right, velocity: forward, seqnum, duration: REMOTE_DURATION_MS };
		default:
			return null;
	}
}

/** How the service reaches the robot; kept to one method so the tests need no adapter. */
export interface RemoteTransport {
	sendRequest(duid: string, method: string, params: unknown, options?: { priority?: number }): Promise<unknown>;
}

/** The two timer functions, so a test can drive them without waiting two seconds. */
export interface RemoteClock {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/**
 * Holds one robot's remote control session and guarantees it ends.
 *
 * Owns exactly one timer, the lease. It is taken from the adapter's own `setTimeout`, so
 * `clearTimersAndIntervals()` in `onUnload` disposes of it along with every other adapter timer -
 * and {@link shutdown} additionally sends the two closing calls before the connection goes down.
 */
export class RemoteControlService {
	/** Rises by one before every move, exactly as `move()` does (A65:790647-790660). */
	private seqnum = 0;

	/** True between a confirmed `app_rc_start` and the `app_rc_end` that closes it. */
	private active = false;

	/** When the last `app_rc_start` was answered; the six second run-up counts from here. */
	private startedAt = 0;

	/** Handle of the lease timer, or null while no session is open. */
	private lease: unknown = null;

	/** Names this service builds parameters for. */
	private static readonly CLAIMED: ReadonlySet<string> = new Set([APP_RC_START, APP_RC_MOVE, APP_RC_STOP, APP_RC_END]);

	public constructor(
		private readonly transport: RemoteTransport,
		private readonly clock: RemoteClock,
		private readonly duid: string,
		private readonly log: (message: string, level: "debug" | "info" | "warn") => void,
		/**
		 * Told whenever a session opens or closes, so the caller can write it down somewhere that
		 * survives a restart. See {@link recoverLeftoverSession} for what that is for.
		 */
		private readonly onActiveChanged: (active: boolean) => void = () => undefined,
		private readonly now: () => number = () => Date.now()
	) {}

	/** Methods this service is responsible for. */
	public handles(method: string): boolean {
		return RemoteControlService.CLAIMED.has(method);
	}

	/** Whether a session is currently open. */
	public get isActive(): boolean {
		return this.active;
	}

	/** Milliseconds still to wait before the robot accepts a move, 0 once the run-up is over. */
	public get launchRemainingMs(): number {
		if (!this.active) return 0;
		const elapsed = this.now() - this.startedAt;
		return elapsed >= REMOTE_LAUNCH_MS ? 0 : REMOTE_LAUNCH_MS - elapsed;
	}

	/**
	 * Builds the parameters of one of the four calls.
	 *
	 * `app_rc_move` with direction 0 turns into `app_rc_stop`, which is what the app does when both
	 * components fall to zero (A65:790666-790690). Refusing an unknown direction rather than sending
	 * something else is the same rule the rest of the adapter follows: a rejected write is visible,
	 * an invented motion parameter drives a real robot into a real wall.
	 *
	 * @param method One of the four remote calls.
	 * @param value Raw value written into the state, only read for `app_rc_move`.
	 * @returns Method and parameters to send.
	 */
	public buildCommandParams(method: string, value: unknown): { method: string; params: unknown } {
		if (method === APP_RC_START || method === APP_RC_END || method === APP_RC_STOP) {
			return { method, params: [] };
		}

		// `Number(value)` alone is not enough here. `null`, `false`, `""` and `[]` all convert to 0,
		// which is a valid direction - "stand still". That fails in the harmless direction, but it
		// turns a caller's mistake into a silent stop instead of a visible refusal, and this is the
		// one command surface where a caller's mistake is worth hearing about.
		const direction = typeof value === "number" || (typeof value === "string" && value.trim() !== "")
			? Number(value)
			: Number.NaN;
		if (!Number.isFinite(direction) || !isKnownRemoteDirection(direction)) {
			throw new Error(
				`${APP_RC_MOVE} accepts the directions ${REMOTE_DIRECTIONS.map((entry) => entry.value).join(", ")}; received ${JSON.stringify(value)}`
			);
		}

		const motion = motionForDirection(direction, this.seqnum + 1);
		if (!motion) {
			return { method: APP_RC_STOP, params: [] };
		}

		this.seqnum = motion.seqnum;
		return { method: APP_RC_MOVE, params: [motion] };
	}

	/**
	 * Opens a session and starts the lease.
	 *
	 * Called after `app_rc_start` was sent, not before: a start that never reached the robot must not
	 * leave a session behind that a later `app_rc_end` would have to clean up.
	 */
	public noteStarted(): void {
		this.active = true;
		this.startedAt = this.now();
		this.seqnum = 0;
		this.armLease();
		this.onActiveChanged(true);
	}

	/**
	 * Extends the lease because somebody is still steering.
	 *
	 * Does nothing while no session is open - a stray move without a start is a caller error, and
	 * arming a lease for it would end with the adapter sending `app_rc_end` to a robot it never put
	 * into the mode.
	 */
	public noteActivity(): void {
		if (!this.active) return;
		this.armLease();
	}

	/** Closes the session locally; the caller has already sent (or is sending) `app_rc_end`. */
	public noteEnded(): void {
		const wasActive = this.active;
		this.active = false;
		this.clearLease();
		if (wasActive) this.onActiveChanged(false);
	}

	/**
	 * Ends a session the previous adapter run left open on the robot.
	 *
	 * The fourth and last defence, and the only one that works when the adapter was not around to
	 * run the other three - a crash, a kill, a machine that lost power. The firmware's own
	 * `duration` has long since stopped the wheels by then; what can be left behind is the **mode**.
	 *
	 * **Only a session this adapter opened is closed.** The caller remembers that in a state of its
	 * own, and it is the whole condition: a user driving the robot from the phone app at the moment
	 * the adapter starts must not have that taken away, and the robot's state code alone cannot tell
	 * the two apart.
	 *
	 * @param wasOpen What the caller wrote down before it went away.
	 */
	public async recoverLeftoverSession(wasOpen: boolean): Promise<void> {
		if (!wasOpen) return;

		this.log("Remote control: a session from an earlier adapter run was still open; closing it.", "info");
		await this.sendQuietly(APP_RC_STOP);
		await this.sendQuietly(APP_RC_END);
		this.onActiveChanged(false);
	}

	/**
	 * Ends the mode on the robot and closes the session.
	 *
	 * Sends the stop first and the end second, in the order the app uses when it leaves the page
	 * (A65:791085-791096: clear the timer, drop `shouldMove`, then `remoteEnd`). Failure of either
	 * call is logged and swallowed: this runs from a lease expiry and from `onUnload`, where there is
	 * nobody left to report to and nothing useful to do with the error.
	 *
	 * @param reason Why the session is being closed; goes into the log line.
	 */
	public async closeSession(reason: string): Promise<void> {
		if (!this.active) return;
		this.noteEnded();

		this.log(`Remote control: ending the mode (${reason}).`, "info");
		await this.sendQuietly(APP_RC_STOP);
		await this.sendQuietly(APP_RC_END);
	}

	/**
	 * Last chance to leave the mode, on the way out of the adapter.
	 *
	 * Not awaited by `onUnload` - js-controller calls its callback synchronously and tears the
	 * connections down right after - so this is genuinely best effort. It is the third of four
	 * defences and the weakest; the ones that do not depend on the adapter being alive are the
	 * firmware's own `duration` and the recovery on the next start.
	 */
	public shutdown(): void {
		if (!this.active) {
			this.clearLease();
			return;
		}
		void this.closeSession("adapter shutting down");
	}

	/** Arms or re-arms the lease timer. */
	private armLease(): void {
		this.clearLease();
		this.lease = this.clock.setTimeout(() => {
			this.lease = null;
			void this.closeSession(`no command for ${REMOTE_LEASE_MS} ms`);
		}, REMOTE_LEASE_MS);
	}

	/** Drops the lease timer, if one is armed. */
	private clearLease(): void {
		if (this.lease !== null) {
			this.clock.clearTimeout(this.lease);
			this.lease = null;
		}
	}

	/** Sends one of the parameterless calls and swallows whatever comes back. */
	private async sendQuietly(method: string): Promise<void> {
		try {
			await this.transport.sendRequest(this.duid, method, [], { priority: 1 });
		} catch (error: unknown) {
			this.log(`Remote control: ${method} failed (${error instanceof Error ? error.message : String(error)}).`, "warn");
		}
	}
}

/** Builds a clock backed by the adapter's tracked timers, so `onUnload` disposes of them. */
export function adapterClock(deps: FeatureDependencies): RemoteClock {
	return {
		setTimeout: (handler, ms) => deps.adapter.setTimeout(handler, ms),
		clearTimeout: (handle) => deps.adapter.clearTimeout(handle as Parameters<FeatureDependencies["adapter"]["clearTimeout"]>[0])
	};
}
