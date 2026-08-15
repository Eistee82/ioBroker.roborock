/**
 * Watches the command states of the selected device and hands the page what it should say.
 *
 * Its own module rather than part of the map engine, for the same reason the history and the
 * settings are: it reads states, draws nothing and needs neither the map nor D3.
 *
 * ## Why what is already there is not announced
 *
 * A failure mark stays on the command state until the next attempt clears it, and `subscribeState`
 * hands the current value of everything a wildcard matches to the handler right away
 * (`@iobroker/socket-client/.../Connection.js:776-793`). Subscribing would therefore announce
 * whatever went wrong last, which may be hours old and was very probably not caused by the person
 * who just opened the tab.
 *
 * Two things keep that out. Every mark that arrives while the subscription is being set up is only
 * noted, never announced; and even afterwards a mark has to be fresh - see `isFreshNotice`.
 */

import type { EngineConnection } from "../engine/types";
import type { CommandFeedbackNotice, CommandStateLike } from "./commandFeedback";
import { commandStatePatterns, isFreshNotice, toCommandFeedbackNotice } from "./commandFeedback";

interface CommandFeedbackSourceHost {
	/** Called for every command that did not simply work. */
	onNotice: (notice: CommandFeedbackNotice) => void;
}

export class CommandFeedbackSource {
	private patterns: string[] = [];
	private destroyed = false;
	/** True while the subscription is delivering what was already there. */
	private priming = false;
	/** Timestamp of the newest mark seen per state, so the same one is not announced twice. */
	private readonly seen = new Map<string, number>();
	/** Raised on every device change, so a late priming of an old device does not lower the flag. */
	private generation = 0;

	public constructor(
		private readonly connection: EngineConnection,
		private readonly host: CommandFeedbackSourceHost,
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * Points the source at a device, or at nothing.
	 * @param instanceId Adapter instance, e.g. `roborock.0`.
	 * @param duid Device to watch; an empty value stops watching.
	 */
	public setDevice(instanceId: string, duid: string): void {
		if (this.destroyed) return;

		this.dropSubscriptions();
		this.seen.clear();
		this.generation++;

		if (!instanceId || !duid) return;

		this.patterns = commandStatePatterns(instanceId, duid);

		// `subscribeState` fetches the current values with an awaited request and only then calls the
		// handler, so the flag is lowered once all of those have run - not after the loop. The
		// generation keeps a late one from lowering the flag of a device that has since been replaced.
		const generation = this.generation;
		this.priming = true;
		const settled = this.patterns.map((pattern) => Promise.resolve(this.connection.subscribeState(pattern, this.stateHandler)).catch(() => undefined));
		void Promise.all(settled).then(() => {
			if (this.destroyed || generation !== this.generation) return;
			this.priming = false;
		});
	}

	private readonly stateHandler = (id: string, state: CommandStateLike | null | undefined): void => {
		if (this.destroyed) return;

		const notice = toCommandFeedbackNotice(id, state);
		if (!notice) {
			// A cleared mark is not news, but it has to be forgotten - otherwise the next failure on
			// the same state would be dropped for having an older timestamp than the clearing write.
			this.seen.delete(id);
			return;
		}

		// The same mark delivered twice - a reconnect re-sends the current value - says nothing new.
		const previous = this.seen.get(id) ?? 0;
		if (notice.ts <= previous) return;
		this.seen.set(id, notice.ts);

		if (this.priming) return;
		if (!isFreshNotice(notice, this.now())) return;

		this.host.onNotice(notice);
	};

	private dropSubscriptions(): void {
		for (const pattern of this.patterns) this.connection.unsubscribeState(pattern, this.stateHandler);
		this.patterns = [];
		this.priming = false;
	}

	/** Drops the subscriptions the source created. */
	public destroy(): void {
		this.destroyed = true;
		this.generation++;
		this.dropSubscriptions();
	}
}
