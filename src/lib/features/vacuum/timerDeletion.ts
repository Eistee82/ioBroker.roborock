/**
 * Removing a schedule, rather than only switching it off.
 *
 * ## Why this exists
 *
 * The adapter publishes every schedule a robot reports and can switch it on and off, but there was
 * no way to get rid of one. A user sitting in front of a schedule they no longer want could only
 * disable it, for ever. `_appanalysis/29-abgleich-plugin-adapter.md` §3.1 lists the three methods
 * that close this gap; two of them are built here, and section 4 below says why the third is not.
 *
 * ## The two places a schedule can live
 *
 * A robot keeps its schedules either in its own memory or on Roborock's server, and which one is
 * not a matter of model or firmware: the app computes `FCCState = 1 & local_info.featureset`
 * (A65:5784-5788) and branches on it (A65:895347-895368). The proof chain is in `serverTimers.ts`;
 * what matters here is that the two have **different delete commands**, and sending the wrong one
 * would be a control that looks like it works.
 *
 * The adapter does not have to compute that branch. It knows which of its two reads produced an
 * entry - `get_timer` or `get_server_timer` - and that is the same answer, arrived at from the
 * robot's own behaviour instead of from a bit whose other values nobody has seen.
 *
 * ## 1. `del_timer` - the schedules the robot keeps itself
 *
 * ```
 * {"method":"del_timer","params":["1498595904821"]}
 * ```
 *
 * | step | where |
 * | --- | --- |
 * | wrapper: `Methods.DelTimer`, `params = new Array(1); params[0] = a0` | A65:228155-228172 |
 * | `Methods.DelTimer` -> `del_timer` | A65:238179 |
 * | caller `deleteRobotTimer(index)`: `<523>.deleteTimer(robotTimerList[index].name)` | A65:582570-582583 |
 * | `_closure1_slot7` of that store is dependency 5 = module 523 | A65:579805-579809, deps A65:583698 |
 * | `.name` **is** `get_timer[i][0]`: `_slicedToArray(row, 3)` -> `r18 = row[0]`, then `entry['name'] = r18` | A65:582263-582272, A65:582378 |
 *
 * The last row is the one that matters. The app's own model calls the field `name`, but it holds the
 * identifier, not a label: the same mapping reads `enabled` from `row[1] === 'on'` and `disable` from
 * `row[1] === 'disable'` (A65:582384-582389), which is the state field of the very same row. So the
 * argument of `del_timer` is exactly the identifier the adapter already publishes as the folder name
 * of `schedules.<id>`. No translation, no lookup.
 *
 * Two method tables exist and only one of them prefixes with `user.` (`'DelTimer': 'user.del_timer'`
 * at A65:238176). The prefixed table is chosen only when `deviceModel` is `rubys` or `saphire`
 * (A65:238160-238176) - two legacy Xiaomi models. Every other robot, the test device included, uses
 * the plain table, which is also why the adapter's `upd_timer` works today.
 *
 * ## 2. `del_server_timer` - the schedules the robot keeps on the server
 *
 * ```
 * {"method":"del_server_timer","params":["1743140136890"]}
 * ```
 *
 * | step | where |
 * | --- | --- |
 * | wrapper: `Methods.DeleteServerTimer`, `params = [a0]` | A65:228137-228154 |
 * | `Methods.DeleteServerTimer` -> `del_server_timer`, **identical in both method tables** | A65:238176, A65:238179 |
 * | caller: `RobotApi.deleteServerTimer(entry.timerId, entry.name)` | A65:582516-582518, again A65:581154-581156 |
 * | that wrapper sends its **second** argument to the robot and the first to the cloud | A65:446228-446231 / A65:446256-446259 |
 * | its dependency 3 is module 523 and its dependency 8 the cloud module 439 | A65:447248 |
 * | `entry.name` comes from `parseServerTimerParas(cloud.params.params).name` | A65:580937-580938, A65:581537-581539 |
 * | and that value is what the app matches against `get_server_timer[i][0]` | `getServerTimerDisable`, A65:581101-581103 and A65:581588-581604 |
 *
 * The last row closes the circle: the app looks its own `name` up in the robot's list by comparing it
 * with index 0 of each row. So the identifier that reaches `del_server_timer` is the identifier the
 * robot reports at index 0 - once more exactly what the adapter publishes as `schedules.<id>`.
 *
 * ### What this does **not** do, and it has to be said
 *
 * The app deletes a server schedule in **two** places, and only one of them is the robot. The other
 * is Roborock's cloud (`delServerTimer`, A65:446256-446259), which reaches it through a native SDK
 * function (`removeTimer`, A65:180957) whose HTTP endpoint is not readable in this bundle. The
 * adapter therefore removes the robot's half and leaves the cloud's.
 *
 * The consequence is provable and is told to the user rather than hidden: the app builds its schedule
 * list from the cloud and asks the robot only whether an entry is switched off
 * (`fetchTimerListFromServer`, A65:580178-580245). An entry whose identifier is no longer in the
 * robot's list makes `getServerTimerDisable` return `false` (A65:581604) - so the phone app will keep
 * showing the deleted schedule, and will show it as **on**.
 *
 * Wiring the cloud half was considered and rejected. `user/devices/{duid}/jobs/{jobId}` is a
 * documented endpoint (`_appanalysis/01-cloud-auth.md` §5.3), but nothing read so far says that
 * `jobId` is the identifier the robot reports - that correspondence is exactly what made this project
 * reject the cloud path for the schedule switch in round 2. A delete sent to a guessed identifier
 * would remove a schedule nobody asked about.
 *
 * ## 3. How a deletion is confirmed
 *
 * By reading the list again, not by reading the answer.
 *
 * The app never looks at what `del_timer` or `del_server_timer` answers - both call sites take the
 * result, log it and carry on (A65:582583-582600, A65:446232-446250). So there is no documented
 * answer to compare against, and inventing one would produce the very failure this project keeps
 * removing: a command reported as done because the robot said something.
 *
 * What is not a guess is the list. If the identifier is gone from `get_timer` resp.
 * `get_server_timer`, the schedule is gone; if it is still there, it is not. That is the same test
 * the app itself performs against `get_server_timer`, and the same reasoning that replaced the false
 * `set_dnd_timer` confirmation with the robot's own `get_dnd_timer`.
 *
 * ## 4. `get_timer_detail` is **not** built - its argument is unproven
 *
 * The wrapper is plain enough (`params = [a0]`, A65:229127-229138), but `a0` is opaque. Both call
 * sites take one element of what `get_timer_summary` answers and hand it straight on without ever
 * touching a property of it (A65:581883-581890 and A65:808542-808561). Nothing in the bundle says
 * whether that element is a bare identifier, an object or a row. The test device answers
 * `get_timer_summary` with `[]` (`_appanalysis/19-geraetefaehigkeiten.md` §5.5), so there is no
 * sample either.
 *
 * `_appanalysis/18-funktionsluecken.md` line 460 writes it as `get_timer_detail [id]`. That is the
 * wrapper's arity, not its argument type, and this module deliberately does not repeat it as fact.
 * Nothing is lost by leaving it out: deleting needs the identifier, and both lists already carry it.
 */

import { unwrapTimerRows } from "./deviceTimers";
import type { CommandOutcome } from "../../commandFeedback";

/** Deletes a schedule the robot keeps in its own memory. See section 1. */
export const DEL_TIMER = "del_timer";

/** Deletes a schedule the robot keeps on Roborock's server. See section 2. */
export const DEL_SERVER_TIMER = "del_server_timer";

/**
 * Where a schedule lives, and therefore which command removes it.
 *
 * Written next to every schedule as `schedules.<id>.source` so the branch is visible in the object
 * tree rather than known only inside the adapter.
 */
export type TimerSource = "device" | "server";

/** A schedule the robot keeps in its own memory, read with `get_timer`. */
export const TIMER_SOURCE_DEVICE: TimerSource = "device";

/** A schedule the robot keeps on Roborock's server, read with `get_server_timer`. */
export const TIMER_SOURCE_SERVER: TimerSource = "server";

/**
 * Reads a `source` state into the branch it names.
 *
 * Deliberately strict: anything that is not one of the two known words yields `null`, and the caller
 * refuses to send. A schedule published by another code path - the B01 shadow service writes
 * `schedules.<id>` too, out of Tuya data points that have nothing to do with these two commands -
 * must not fall through to a default.
 *
 * @param value Value of `schedules.<id>.source`.
 * @returns The branch, or `null` when the value names none.
 */
export function parseTimerSource(value: unknown): TimerSource | null {
	if (value === TIMER_SOURCE_DEVICE) return TIMER_SOURCE_DEVICE;
	if (value === TIMER_SOURCE_SERVER) return TIMER_SOURCE_SERVER;
	return null;
}

/**
 * The RPC that removes a schedule of the given kind.
 * @param source Where the schedule lives.
 * @returns The method name.
 */
export function deleteMethodForSource(source: TimerSource): string {
	return source === TIMER_SOURCE_SERVER ? DEL_SERVER_TIMER : DEL_TIMER;
}

/**
 * The read that says whether a schedule of the given kind is still there.
 * @param source Where the schedule lives.
 * @returns The method name.
 */
export function listMethodForSource(source: TimerSource): string {
	return source === TIMER_SOURCE_SERVER ? "get_server_timer" : "get_timer";
}

/** What became of one delete, in the vocabulary of `commandFeedback.ts`. */
export interface ScheduleDeleteResult {
	outcome: CommandOutcome;
	/** Second `%s` of the outcome's wording, where it has one. */
	detail?: string;
	/** Further arguments, for the wordings that take more than two. */
	extraArgs?: string[];
}

/** What a feature class has to offer before a delete button may reach it. */
export interface ScheduleDeleter {
	deleteSchedule(timerId: string, source: TimerSource): Promise<ScheduleDeleteResult>;
}

/**
 * Whether a device's feature handler can delete schedules at all.
 *
 * Asked rather than assumed because `schedules.<id>` is written by two unrelated code paths: the V1
 * classes out of `get_timer`/`get_server_timer`, and the B01 shadow service out of Tuya data points,
 * which these two commands do not reach. Only the first implements this.
 *
 * @param handler The device's feature handler.
 * @returns True when it can.
 */
export function canDeleteSchedules(handler: unknown): handler is ScheduleDeleter {
	return typeof (handler as ScheduleDeleter | null)?.deleteSchedule === "function";
}

/**
 * Whether an identifier may be sent.
 *
 * The identifier reaches the adapter as a path segment of the state that was written, so it is
 * already constrained by what the object tree accepts - but a method argument built from an object id
 * is not a trusted string. Same reasoning as `SAFE_PATH_SEGMENT` on the command handlers.
 *
 * The measured identifiers are millisecond timestamps (`"1743140136890"`); the pattern is kept wider
 * than that because nothing proves they always are.
 *
 * @param timerId Identifier as it appears under `schedules.`.
 * @returns True when it is safe to send.
 */
export function isSendableTimerId(timerId: unknown): timerId is string {
	return typeof timerId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(timerId);
}

/**
 * Whether a timer list still contains the identifier.
 *
 * Reads the shape both lists share - rows whose index 0 is the identifier - possibly wrapped once by
 * the request layer. Anything that is not a list of rows counts as **still there**, because a shape
 * nobody recognises is not evidence of a deletion, and claiming one that did not happen would leave a
 * schedule running while the object tree says it is gone.
 *
 * @param response Raw answer of `get_timer` or `get_server_timer`.
 * @param timerId  Identifier that was asked to be deleted.
 * @returns True only when the answer is a readable list that no longer contains the identifier.
 */
export function timerIsGone(response: unknown, timerId: string): boolean {
	const rows = unwrapTimerRows(response);
	if (rows === null) return false;
	return !rows.some((row) => Array.isArray(row) && row.length > 0 && String(row[0]) === timerId);
}
