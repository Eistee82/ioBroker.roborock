/**
 * Driving the robot by hand from the tab.
 *
 * ## The one rule this file exists to keep
 *
 * **A move is sent only while a finger is on a button.** The repeat timer lives here, next to the
 * thing that knows whether the button is still down, and it is cleared by every path that can end a
 * press - pointer up, pointer cancel, the pointer leaving the pad, the key going up, the window
 * losing focus, the page being hidden, the component unmounting. Nothing in the adapter repeats
 * anything on its own (`src/lib/features/vacuum/remoteControl.ts`), so a timer that stops here is a
 * robot that stops there.
 *
 * The robot's own guarantee sits underneath all of that: every `app_rc_move` carries
 * `duration: 1500`, and the app refreshes it every 400 ms - so even a browser that freezes mid-press
 * leaves a robot that rolls for at most another 1.5 s. This driver keeps the same 400 ms cadence and
 * therefore inherits the same margin.
 *
 * ## Why the mode is ended so eagerly
 *
 * Stopping the motion and leaving the mode are two different calls, and only the second one gets the
 * robot out of state 4. A tab that is closed, hidden or reloaded therefore sends `remote_end`, not
 * just `remote_stop`. `pagehide` is the event that fires reliably on all of those - `beforeunload`
 * does not fire on mobile and `unload` is being removed from browsers - and `visibilitychange` picks
 * up the case where the tab merely goes to the background, where timers get throttled to a point
 * where a 400 ms cadence is no longer honest.
 *
 * If every one of those fails, the adapter's lease still ends the mode after two seconds of silence.
 */

import type { EngineConnection } from "../engine/types";

/** How often a held direction is repeated, in ms; the app's own cadence (A65:790975). */
export const REMOTE_REFRESH_MS = 400;

/** What the pad shows and what it lets the user do. */
export interface RemoteDriverModel {
	/** True once the adapter published the remote control commands for this robot. */
	supported: boolean;
	/** True between a confirmed start and the end of the session. */
	active: boolean;
	/** True while the robot is still standing up after the start and ignores directions. */
	launching: boolean;
	/** Whole seconds still to wait; only meaningful while `launching`. */
	launchSecondsLeft: number;
	/** Direction currently held, 0 for none. */
	direction: number;
	/** True while a start is waiting for the user to confirm interrupting a running job. */
	confirming: boolean;
	/** True while a start or end request is in flight. */
	busy: boolean;
	/** Why the robot cannot be driven right now, already worded; null when it can. */
	refusal: string | null;
}

/** The empty model: no robot, nothing offered. */
export const EMPTY_REMOTE: RemoteDriverModel = {
	supported: false,
	active: false,
	launching: false,
	launchSecondsLeft: 0,
	direction: 0,
	confirming: false,
	busy: false,
	refusal: null
};

interface RemoteDriverHost {
	/** The model whenever anything about it changed. */
	onChange: (model: RemoteDriverModel) => void;
	/** Something the tab could not do, already worded for the user. */
	onError: (message: string) => void;
	/** Translator, so this module carries no English of its own. */
	t: (key: string, fallback: string) => string;
}

/** The answer of `remote_start`. */
interface RemoteStartAnswer {
	result?: "accepted" | "confirm" | "refused";
	stateCode?: number | null;
	launchMs?: number;
	error?: string;
}

export class RemoteDriver {
	private instanceId = "";
	private duid = "";
	private destroyed = false;

	/** Handle of the repeat timer, or null while nothing is held. */
	private repeat: ReturnType<typeof setInterval> | null = null;

	/** Handle of the run-up countdown, or null while there is none. */
	private countdown: ReturnType<typeof setInterval> | null = null;

	/** When the run-up ends, as a timestamp; 0 while there is none. */
	private launchUntil = 0;

	private model: RemoteDriverModel = { ...EMPTY_REMOTE };

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: RemoteDriverHost
	) {
		window.addEventListener("pagehide", this.onPageHide);
		window.addEventListener("visibilitychange", this.onVisibilityChange);
		window.addEventListener("blur", this.onWindowBlur);
	}

	/**
	 * Points the driver at a device, or at nothing.
	 *
	 * Switching robots ends any session on the old one first: leaving a mode open on a robot the tab
	 * no longer shows is exactly the state this whole file is built to avoid.
	 *
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device to drive; an empty value clears the pad.
	 */
	public async setDevice(instanceId: string, duid: string): Promise<void> {
		if (this.destroyed) return;

		await this.end();

		this.instanceId = instanceId;
		this.duid = duid;
		this.update({ ...EMPTY_REMOTE });

		if (!duid) return;

		// The adapter only publishes this object for a robot whose firmware reported feature 125, so
		// its presence is the whole capability test - the same object the `remote_*` messages are
		// gated on at the other end.
		try {
			const object = await this.connection.getObject(`${instanceId}.Devices.${duid}.remoteControl.app_rc_start`);
			this.update({ supported: Boolean(object) });
		} catch {
			// A robot without the folder answers with nothing or an error; both mean "not offered",
			// and neither is worth a message to the user.
			this.update({ supported: false });
		}
	}

	/**
	 * Opens the mode.
	 *
	 * The adapter decides whether a running job has to be interrupted first and says so; this only
	 * relays the question. Calling again with `confirmed` is what answers it.
	 *
	 * @param confirmed Whether the user agreed to interrupt what the robot is doing.
	 */
	public async start(confirmed = false): Promise<void> {
		if (this.destroyed || !this.duid || !this.model.supported || this.model.busy) return;

		this.update({ busy: true, refusal: null });
		try {
			const answer = (await this.connection.sendTo(this.instanceId, "remote_start", {
				duid: this.duid,
				confirmed
			})) as RemoteStartAnswer | undefined;

			if (answer?.error) {
				this.update({ busy: false });
				this.host.onError(answer.error);
				return;
			}

			if (answer?.result === "refused") {
				this.update({ busy: false, confirming: false, refusal: this.host.t("ui_remote_refused_updating", "The robot is installing firmware and cannot be driven right now.") });
				return;
			}

			if (answer?.result === "confirm") {
				this.update({ busy: false, confirming: true });
				return;
			}

			const launchMs = typeof answer?.launchMs === "number" ? answer.launchMs : 6000;
			this.launchUntil = Date.now() + launchMs;
			this.update({ busy: false, confirming: false, active: true, launching: launchMs > 0, launchSecondsLeft: Math.ceil(launchMs / 1000) });
			this.startCountdown();
		} catch (error: unknown) {
			this.update({ busy: false });
			this.host.onError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Drops the confirmation question without starting anything. */
	public cancelConfirmation(): void {
		this.update({ confirming: false });
	}

	/**
	 * Takes a direction and keeps sending it until it is released.
	 *
	 * Sends once immediately so the robot reacts to the press rather than to the first tick, then on
	 * the app's 400 ms cadence. A press during the run-up is ignored rather than queued: the robot
	 * would drop it, and a button that appears to do nothing for six seconds is better than one that
	 * fires a move the moment the user has stopped looking.
	 *
	 * @param direction One of the app's eight `pressState` values.
	 */
	public press(direction: number): void {
		if (this.destroyed || !this.model.active || this.model.launching) return;
		if (!Number.isInteger(direction) || direction < 1 || direction > 8) return;
		if (this.model.direction === direction) return;

		this.clearRepeat();
		this.update({ direction });
		void this.sendMove(direction);
		this.repeat = setInterval(() => {
			// Re-read rather than closing over the value: a press that ended between two ticks must
			// not get one more move out of a stale closure.
			if (this.model.direction === 0) {
				this.clearRepeat();
				return;
			}
			void this.sendMove(this.model.direction);
		}, REMOTE_REFRESH_MS);
	}

	/**
	 * Ends the press and stops the motion, keeping the mode open.
	 *
	 * The timer is cleared **before** the stop is sent, not after: if the message fails, the robot
	 * has still stopped receiving moves, and the firmware halts it within 1.5 s. The other order
	 * would leave a repeat running on a failed stop.
	 */
	public release(): void {
		if (this.model.direction === 0) return;

		this.clearRepeat();
		this.update({ direction: 0 });
		void this.sendSimple("remote_stop");
	}

	/** Leaves the mode entirely. */
	public async end(): Promise<void> {
		this.clearRepeat();
		this.clearCountdown();

		const wasActive = this.model.active;
		this.update({ direction: 0, active: false, launching: false, launchSecondsLeft: 0, confirming: false });
		if (!wasActive || !this.duid) return;

		await this.sendSimple("remote_end");
	}

	/** Drops every listener and timer and closes an open session. */
	public destroy(): void {
		this.destroyed = true;
		window.removeEventListener("pagehide", this.onPageHide);
		window.removeEventListener("visibilitychange", this.onVisibilityChange);
		window.removeEventListener("blur", this.onWindowBlur);
		this.clearRepeat();
		this.clearCountdown();

		if (this.model.active && this.duid) {
			// Not awaited: `destroy` runs from React's unmount, which cannot wait. The adapter's
			// lease closes the mode two seconds later if this message does not make it.
			void this.connection.sendTo(this.instanceId, "remote_end", { duid: this.duid }).catch(() => undefined);
		}
		this.model = { ...EMPTY_REMOTE };
	}

	/** The page is going away - hidden, reloaded, navigated off. */
	private readonly onPageHide = (): void => {
		this.clearRepeat();
		void this.end();
	};

	/**
	 * The tab moved to the background.
	 *
	 * Ends the whole mode rather than only the motion. A background tab has its timers throttled, so
	 * the 400 ms cadence stops being a cadence - and a mode that stays open on a robot nobody is
	 * watching is the thing to avoid, not a session that has to be started again.
	 */
	private readonly onVisibilityChange = (): void => {
		if (document.visibilityState === "hidden") {
			this.clearRepeat();
			void this.end();
		}
	};

	/** The window lost focus; the key that is held may never produce a keyup. */
	private readonly onWindowBlur = (): void => {
		this.release();
	};

	/** Sends one move and reports a failure once, without stopping the repeat. */
	private async sendMove(direction: number): Promise<void> {
		if (!this.duid) return;
		try {
			await this.connection.sendTo(this.instanceId, "remote_move", { duid: this.duid, direction });
		} catch (error: unknown) {
			// One failed move is survivable - the next tick is 400 ms away and the robot stops by
			// itself meanwhile. What is not survivable is carrying on blind, so the press is dropped.
			this.clearRepeat();
			this.update({ direction: 0 });
			this.host.onError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Sends one of the parameterless messages and swallows the answer. */
	private async sendSimple(command: string): Promise<void> {
		if (!this.duid) return;
		try {
			await this.connection.sendTo(this.instanceId, command, { duid: this.duid });
		} catch (error: unknown) {
			this.host.onError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Counts the run-up down so the pad can say how long it still is. */
	private startCountdown(): void {
		this.clearCountdown();
		this.countdown = setInterval(() => {
			const left = this.launchUntil - Date.now();
			if (left <= 0) {
				this.clearCountdown();
				this.update({ launching: false, launchSecondsLeft: 0 });
				return;
			}
			this.update({ launchSecondsLeft: Math.ceil(left / 1000) });
		}, 250);
	}

	private clearRepeat(): void {
		if (this.repeat !== null) {
			clearInterval(this.repeat);
			this.repeat = null;
		}
	}

	private clearCountdown(): void {
		if (this.countdown !== null) {
			clearInterval(this.countdown);
			this.countdown = null;
		}
	}

	/** Merges a change into the model and reports it. */
	private update(patch: Partial<RemoteDriverModel>): void {
		this.model = { ...this.model, ...patch };
		if (!this.destroyed) this.host.onChange(this.model);
	}
}
