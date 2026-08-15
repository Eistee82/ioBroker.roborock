/**
 * Reads what became of a command off the command state itself, and decides what the user is told.
 *
 * There is no separate result channel. ioBroker's own state model carries it: `ack` says whether a
 * value is wanted or real, `q` says whether something went wrong, and `c` says what. The adapter
 * writes those three onto the very state the tab wrote to; this module reads them back.
 *
 * The counterpart is `src/lib/commandFeedback.ts`, where the vocabulary and the quality mapping are
 * defined and argued. Only what this side has to act on is repeated here.
 */

/**
 * The state folders the tab can set a command going in.
 *
 * Deliberately a short fixed list rather than a subscription to the whole device: `Devices.<duid>.*`
 * would also pull every map state, and the map data of a large flat is measured in megabytes -
 * `subscribeState` fetches the current value of everything a wildcard matches
 * (`@iobroker/socket-client/.../Connection.js:776-793`).
 *
 * `floors` is narrowed to the load button for the same reason: the room selection lives beside it
 * and is written on every click.
 *
 * A command in some other folder is not watched, which costs nothing: this is about the commands
 * *this page* sends, and it sends to exactly these.
 */
export const WATCHED_COMMAND_PATTERNS: readonly string[] = ["commands.*", "settings.*", "resetConsumables.*", "floors.*.load"];

/**
 * Builds the state patterns to watch for one device.
 * @param instanceId Adapter instance, e.g. `roborock.0`.
 * @param duid       Device id.
 * @returns One pattern per watched folder.
 */
export function commandStatePatterns(instanceId: string, duid: string): string[] {
	return WATCHED_COMMAND_PATTERNS.map((pattern) => `${instanceId}.Devices.${duid}.${pattern}`);
}

/** How a message is presented. */
export type CommandFeedbackSeverity = "error" | "warning";

/**
 * The quality that means "something went wrong, but nobody can say what".
 *
 * `BAD` is what the adapter falls back to for the two outcomes with no honest quality of their own -
 * the robot did not answer, or the send broke somewhere unnamed. Both leave open whether the robot
 * carried the command out, so they are shown as a warning; every other non-zero quality names a
 * definite failure and is shown as an error. See `src/lib/commandFeedback.ts` for the full table.
 */
const QUALITY_BAD = 0x01;

/** The reason as the adapter packed it into the comment field. */
export interface CommandFeedbackReason {
	/** Translation key of the message. */
	messageKey: string;
	/** Arguments of the message, in order. */
	messageArgs: string[];
	/** The adapter's own English wording, used when the key is not translated. */
	fallback: string;
}

/** A failed command turned into something the page can show. */
export interface CommandFeedbackNotice extends CommandFeedbackReason {
	severity: CommandFeedbackSeverity;
	/** State the command was written to. */
	stateId: string;
	/** Quality the adapter left on it. */
	quality: number;
	/** When it was written. */
	ts: number;
}

/** The shape of one state, as far as this module cares. */
export interface CommandStateLike {
	val?: unknown;
	ack?: boolean;
	q?: number;
	c?: string;
	ts?: number;
}

/**
 * Reads the reason out of a comment.
 *
 * The comment is JSON because it has to carry three things at once: the key and its arguments,
 * because only this side knows which of eleven languages to show, and the English sentence, so the
 * state still says something to anyone reading it without the tab.
 *
 * Anything that is not such a comment returns null rather than a half-filled object - a comment
 * written by hand, by an older adapter or by something else entirely are all the same case here.
 *
 * @param raw Value of the state's comment field.
 * @returns The reason, or null.
 */
export function parseCommandComment(raw: unknown): CommandFeedbackReason | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const source = parsed as Record<string, unknown>;

	const key = source.k;
	if (typeof key !== "string" || key === "") return null;

	const args = Array.isArray(source.a) ? source.a.filter((entry): entry is string => typeof entry === "string") : [];

	return {
		messageKey: key,
		messageArgs: args,
		fallback: typeof source.m === "string" ? source.m : "",
	};
}

/**
 * Decides whether a state change is worth showing, and how.
 *
 * Success is deliberately silent. A control that was moved shows its new position from the status,
 * and a message per working command would teach the user to look away from the one channel that has
 * to be read when something breaks.
 *
 * @param stateId Id of the state that changed.
 * @param state   The state.
 * @returns The notice, or null when nothing went wrong.
 */
export function toCommandFeedbackNotice(stateId: string, state: CommandStateLike | null | undefined): CommandFeedbackNotice | null {
	if (!state) return null;

	const quality = typeof state.q === "number" ? state.q : 0;
	if (quality === 0) return null;

	const reason = parseCommandComment(state.c);
	if (!reason) return null;

	return {
		severity: quality === QUALITY_BAD ? "warning" : "error",
		messageKey: reason.messageKey,
		messageArgs: reason.messageArgs,
		fallback: reason.fallback,
		stateId,
		quality,
		ts: typeof state.ts === "number" && Number.isFinite(state.ts) ? state.ts : 0,
	};
}

/**
 * Turns a notice into the sentence the user reads.
 *
 * Falls back to the adapter's English wording when the key is not translated, which is what an
 * untranslated key looks like coming out of `I18n.t`: it returns the key itself. Showing the key
 * would be worse than showing an English sentence that at least says what happened.
 *
 * @param notice    The notice.
 * @param translate Lookup of a translation key, e.g. `I18n.t`.
 * @returns The finished text.
 */
export function formatFeedbackMessage(notice: CommandFeedbackNotice, translate: (key: string) => string): string {
	const translated = translate(notice.messageKey);
	let text = translated && translated !== notice.messageKey ? translated : notice.fallback;
	if (!text) text = notice.messageKey;

	for (const arg of notice.messageArgs) {
		text = text.replace("%s", arg);
	}
	return text;
}

/**
 * How old a mark may be before it is treated as history rather than as news.
 *
 * Generous enough to cover the slowest path a command can take: `commandVerification` needs its
 * 10 s grace window plus a status read, and the floor switch may verify for 20 s before it reports.
 * A minute clears both without turning yesterday's failure into today's message.
 */
export const MAX_NOTICE_AGE_MS = 60_000;

/**
 * Whether a mark is new enough to be worth a message.
 *
 * A failure mark stays on the state until the next attempt clears it, so a subscription delivers
 * whatever went wrong last - possibly hours ago. Announcing that as if it had just happened would be
 * wrong twice: the user did nothing, and the message would describe a robot that has long since
 * moved on.
 *
 * @param notice   The notice.
 * @param now      Current time.
 * @param maxAgeMs How old a mark may be; defaults to {@link MAX_NOTICE_AGE_MS}.
 * @returns True when the mark describes something that just happened.
 */
export function isFreshNotice(notice: CommandFeedbackNotice, now: number, maxAgeMs: number = MAX_NOTICE_AGE_MS): boolean {
	if (notice.ts <= 0) return false;
	// A clock that runs ahead of the browser's is not a reason to swallow the message; only age is.
	return now - notice.ts <= maxAgeMs;
}
