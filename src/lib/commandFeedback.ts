/**
 * What became of a command, written onto the command state itself.
 *
 * ## Why there is no channel of its own
 *
 * ioBroker already has the vocabulary. A state carries `ack` (`false` = somebody wants this,
 * `true` = this is how it is), a quality `q` and a comment `c`; a command state that was written and
 * then failed is exactly "an unfulfilled desired value, and here is why". Inventing a second state
 * beside it would duplicate a model that js-controller, the admin and every script already share.
 *
 * So the command state says everything:
 *
 * | | meaning |
 * | --- | --- |
 * | `ack: false`, `q = 0` | somebody wants this; nothing is known yet |
 * | `ack: true`, `q = 0` | the robot took it - what the status mirror and `commandVerification` write |
 * | `ack: false`, `q != 0`, `c` set | it was tried and did not work; `c` says why |
 *
 * ## Why the failure keeps `ack: false`
 *
 * Because `ack: true` means "this is how it is", and a command that failed has no such value. The
 * quality is the honest place for the failure, and it is enough to raise an event:
 * `_setStateChangedHelper` compares `q` and `c` alongside the value
 * (`@iobroker/js-controller-adapter/build/cjs/lib/adapter/adapter.js:5399-5415`), and a plain
 * `setState` publishes unconditionally.
 *
 * One thing had to be added for that to be safe: `onStateChange` treats every unacknowledged write
 * as a command, so a mark written this way would be read back as a new command and sent again,
 * forever. `main.ts` therefore ignores an unacknowledged write that already carries a quality - see
 * the guard there. Nothing else can be caught by it: the states database resets `q` to 0 on any
 * write that does not name one (`@iobroker/db-states-redis/.../statesInRedisClient.js:513-517`), so
 * a genuine command always arrives with `q = 0`.
 *
 * ## Who can read it
 *
 * The whole state object is published to the subscribers, `q` and `c` included
 * (`statesInRedisClient.js:535-539`), and the socket hands it on unchanged
 * (`@iobroker/socket-classes/build/lib/socketCommands.js:252-266`) - so the admin tab sees the
 * quality and the reason.
 *
 * With one limitation worth knowing: **`ioBroker.javascript` drops state changes with `q != 0`**
 * unless the trigger says otherwise (`sandbox.ts:1745-1747`, `patternCompareFunctions.ts:91-94`).
 * A script listening to a command state is therefore not woken by a failure. That is not a
 * regression - today nothing is written at all in that case - but it means the quality is something
 * to look at, not something that notifies.
 *
 * Path notes: the js-controller line numbers above were read in 7.2.2 and the socket classes in
 * 2.3.6; the user runs 7.2.3. These code paths are old and stable, but the versions differ.
 */

/**
 * What is known about a command.
 *
 * | value | how it is recognised | what it claims |
 * | --- | --- | --- |
 * | `not_sent` | `getCommandParams`/`buildRequest` threw, before anything was sent | nothing went out - certain |
 * | `unreachable` | `ChannelUnavailableError`, whose own documentation says the request never touched the wire | nothing went out - certain |
 * | `no_answer` | the request was in flight and timed out or was aborted | **unknown** whether the robot got it |
 * | `error` | any other failure on the way out | **unknown** at which point it broke |
 * | `rejected` | a `set_*` method answered something other than `["ok"]` | the robot refused |
 * | `accepted` | the robot answered, and a `set_*` answered `["ok"]` | accepted - no more than that |
 * | `sent` | published on a channel that has no answer (the Q10 data points) | out of the door, unconfirmable on this device |
 * | `confirmed` | the status later reported the value that was asked for | it took effect |
 * | `ineffective` | the status still reports something else after the grace window | it did not take effect |
 */
export type CommandOutcome =
	| "not_sent"
	| "unreachable"
	| "no_answer"
	| "error"
	| "rejected"
	| "accepted"
	| "sent"
	| "confirmed"
	| "ineffective";

/** The literal union `ioBroker.State.q` accepts. */
type StateQuality = ioBroker.STATE_QUALITY[keyof ioBroker.STATE_QUALITY];

/**
 * The quality each outcome leaves on the command state.
 *
 * Four of them have an exact counterpart in `@iobroker/types/build/shared.d.ts:25-56`; two do not,
 * and that is said here rather than hidden behind a plausible-looking constant:
 *
 * | outcome | quality | why |
 * | --- | --- | --- |
 * | `unreachable` | `DEVICE_NOT_CONNECTED 0x42` | exact - the channel said the request never went out |
 * | `not_sent` | `GENERAL_INSTANCE_PROBLEM 0x11` | the adapter refused to build the request; the device was never involved |
 * | `rejected` | `DEVICE_ERROR_REPORT 0x44` | the robot answered, and its answer was a refusal |
 * | `ineffective` | `GENERAL_DEVICE_PROBLEM 0x41` | the robot said `["ok"]` and did something else |
 * | `no_answer` | `BAD 0x01` | **no honest value exists.** There is no "did not answer" quality |
 * | `error` | `BAD 0x01` | **same.** `CONNECTION_PROBLEM 0x02` would claim to know where it broke |
 *
 * The two that fall on `BAD` are told apart by the comment, which names the outcome's own
 * translation key. That is why the comment is not decoration.
 */
export const OUTCOME_QUALITY: Readonly<Record<CommandOutcome, StateQuality>> = Object.freeze({
	accepted: 0x00,
	sent: 0x00,
	confirmed: 0x00,
	not_sent: 0x11,
	unreachable: 0x42,
	no_answer: 0x01,
	error: 0x01,
	rejected: 0x44,
	ineffective: 0x41
});

/**
 * Whether an outcome means something went wrong.
 *
 * Derived from the quality rather than kept as a second list, so the two can never disagree.
 * @param outcome The outcome.
 * @returns True for everything that did not simply work.
 */
export function isProblemOutcome(outcome: CommandOutcome): boolean {
	return OUTCOME_QUALITY[outcome] !== 0x00;
}

/**
 * How long a single argument of the reason may be.
 *
 * Three arguments plus the sentence and the key have to fit into {@link MAX_COMMENT_LENGTH}
 * together, and the map editor produces error texts of several hundred characters on its own.
 */
export const MAX_ARG_LENGTH = 80;

/**
 * How long the whole comment may be.
 *
 * Not a preference: the states database cuts a comment at 512 characters
 * (`@iobroker/db-states-redis/.../statesInRedisClient.js:518-520`), and a cut in the middle of the
 * JSON would leave something nobody can parse. So it is kept short here, where the cutting can be
 * done at a place that survives.
 */
export const MAX_COMMENT_LENGTH = 512;

/**
 * Shortens a text and marks that it was shortened.
 * @param text      Raw text.
 * @param maxLength Longest result, ellipsis excluded.
 * @returns The text, at most `maxLength` characters plus an ellipsis.
 */
export function truncateDetail(text: string, maxLength: number = MAX_ARG_LENGTH): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength)}…`;
}

/** Translation key and English wording of one outcome. */
interface OutcomeText {
	key: string;
	/** `%s` per argument, in the order the caller passes them. */
	english: string;
}

/**
 * The wording of every outcome that is written down.
 *
 * The three good outcomes have no wording: they clear the mark instead of leaving one, and a state
 * that says `ack: true, q = 0` needs no sentence to explain itself.
 *
 * The keys live in `admin/i18n/<lang>.json` like every other string of the admin tab, and the
 * English text is kept here as well so the comment says something where nobody translates it - a
 * script, the object view, a log.
 */
const OUTCOME_TEXTS: Readonly<Record<string, OutcomeText>> = Object.freeze({
	not_sent: { key: "ui_cmdres_not_sent", english: "%s was not sent: %s" },
	unreachable: { key: "ui_cmdres_unreachable", english: "%s was not sent: there is no connection to the robot." },
	no_answer: { key: "ui_cmdres_no_answer", english: "The robot did not answer %s. Whether it was carried out is unknown." },
	error: { key: "ui_cmdres_error", english: "%s failed: %s. Whether the robot carried it out is unknown." },
	rejected: { key: "ui_cmdres_rejected", english: "The robot rejected %s and answered %s." },
	ineffective: { key: "ui_cmdres_ineffective", english: "The robot acknowledged %s, but %s later it still reports %s. The requested value is not in effect." }
});

/**
 * Fills the English wording of an outcome.
 * @param outcome The outcome.
 * @param args    Arguments, in the order the wording expects them.
 * @returns Key, arguments and the filled English sentence; empty for an outcome with no wording.
 */
export function describeOutcome(outcome: CommandOutcome, args: string[] = []): { messageKey: string; messageArgs: string[]; message: string } {
	const text = OUTCOME_TEXTS[outcome];
	if (!text) return { messageKey: "", messageArgs: args, message: "" };

	let message = text.english;
	for (const arg of args) {
		message = message.replace("%s", arg);
	}
	return { messageKey: text.key, messageArgs: args, message };
}

/**
 * Packs the reason into the state's comment field.
 *
 * The comment is JSON because it has to carry three things at once and the adapter cannot merge
 * them into one: the **key** and its **arguments**, because only the reader knows which of eleven
 * languages to show; and the **English sentence**, so the comment still says something in the object
 * view, in a log and to anyone reading the state without the tab.
 *
 * The English sentence comes first so that is what a human sees at the start of the line.
 *
 * @param outcome The outcome.
 * @param args    Arguments of the wording, in order.
 * @returns The comment, never longer than {@link MAX_COMMENT_LENGTH}.
 */
export function buildCommandComment(outcome: CommandOutcome, args: string[] = []): string {
	const shortArgs = args.map((arg) => truncateDetail(arg));
	const described = describeOutcome(outcome, shortArgs);
	if (described.messageKey === "") return "";

	let message = described.message;
	let comment = encodeComment(message, described.messageKey, shortArgs);

	// The key and its arguments are what the tab translates from; the English sentence repeats what
	// they already say, so that is the part that gives way first. Each pass removes at least as many
	// characters as it is over, so this ends after two at the most.
	while (comment.length > MAX_COMMENT_LENGTH && message.length > 0) {
		message = message.slice(0, Math.max(0, message.length - (comment.length - MAX_COMMENT_LENGTH)));
		comment = encodeComment(message, described.messageKey, shortArgs);
	}

	if (comment.length <= MAX_COMMENT_LENGTH) return comment;

	// Everything but the key had to go. A key on its own still names what happened.
	return encodeComment("", described.messageKey, []);
}

/**
 * Writes one comment.
 * @param message English sentence.
 * @param key     Translation key.
 * @param args    Arguments of the translation.
 * @returns The JSON text.
 */
function encodeComment(message: string, key: string, args: string[]): string {
	return JSON.stringify({ m: message, k: key, a: args });
}

/**
 * Classifies a failure on the way out.
 *
 * The branches are the ones `requestsHandler._processResult` already tells apart when it logs, so
 * the state and the log can never contradict each other.
 *
 * @param errorMessage       The message of the thrown error.
 * @param channelUnavailable Whether the error is a `ChannelUnavailableError`.
 * @returns The outcome.
 */
export function classifyRequestFailure(errorMessage: string, channelUnavailable: boolean): CommandOutcome {
	if (channelUnavailable) return "unreachable";
	if (/Timeout|timed out|Aborted|CANCELLED/.test(errorMessage)) return "no_answer";
	return "error";
}

/**
 * Whether a failure only means the adapter is stopping.
 *
 * Such a failure says nothing about the robot and nothing about the command, and it happens while
 * the adapter is tearing its states down - so it is not written down.
 * @param errorMessage The message of the thrown error.
 * @returns True when the request was cancelled by the shutdown.
 */
export function isShutdownFailure(errorMessage: string): boolean {
	return errorMessage.includes("ADAPTER_STOPPED");
}

/**
 * Reads the robot's answer.
 *
 * This is the very check `requestsHandler.command` performs before it logs an unexpected answer
 * (`requestsHandler.ts:727-733`), pulled out so the log line and the state agree by construction.
 * Only `set_*` is judged: those are the methods with a defined answer, and a `get_*` or `app_*` that
 * answered at all has answered as much as it ever will.
 *
 * @param method Method as it was requested.
 * @param result The robot's answer.
 * @returns `accepted` or `rejected`.
 */
export function classifyRobotAnswer(method: string, result: unknown): CommandOutcome {
	if (!method.startsWith("set_")) return "accepted";

	const data = result && typeof result === "object" && "data" in result
		? (result as Record<string, unknown>).data
		: result;

	const isOk = Array.isArray(data) && data.length === 1 && data[0] === "ok";
	return isOk ? "accepted" : "rejected";
}

/**
 * Where a command came from, as far as its sender could say.
 *
 * Both fields are optional because the sender is not always the same. A write that came through
 * `onStateChange` knows the exact state id it arrived on - including the two nested cases,
 * `floors.<mapFlag>.load` and `resetConsumables.<part>`, which no folder-plus-command rule would
 * reconstruct. A command sent straight down a socket message never touched a state at all, and the
 * adapter looks up where its command object lives.
 */
export interface CommandOrigin {
	/** Exact state id the command arrived on, when it arrived on one. */
	stateId?: string | null;
	/** Command folder, when the caller knows it. */
	folder?: string | null;
}

/** Everything the caller knows about a command when it reports its fate. */
export interface CommandOutcomeReport {
	/** Command as it is registered, i.e. what the user pressed. */
	command: string;
	outcome: CommandOutcome;
	/** Exact state id, when the caller has it. */
	stateId?: string | null;
	/** Command folder, when the caller knows it. */
	folder?: string | null;
	/** Extra text for the outcomes whose wording has a second `%s`. */
	detail?: string;
	/** Further arguments for `ineffective`, which names a delay and a reported value. */
	extraArgs?: string[];
}

/**
 * Collects the arguments of the reason in the order the wording expects them.
 * @param report The report.
 * @returns The arguments, starting with the command name.
 */
export function outcomeArgs(report: CommandOutcomeReport): string[] {
	const args: string[] = [report.command];
	if (report.detail !== undefined) args.push(report.detail);
	for (const extra of report.extraArgs ?? []) args.push(extra);
	return args;
}
