/**
 * The schedules a robot keeps on Roborock's server rather than in its own memory.
 *
 * ## Why this exists
 *
 * The adapter reads `get_timer` and publishes what it finds under `schedules`. On the test device
 * that list is **empty while a schedule is running**: measured at the robot, `get_timer` → `[]`,
 * `get_timer_summary` → `[]`, but `get_server_timer` → `[["1743140136890","on",-1]]`
 * (`_appanalysis/19-geraetefaehigkeiten.md` §5.5). The user sees a schedule in the app and nothing
 * in ioBroker.
 *
 * Which of the two a robot uses is not a matter of model or firmware. The app computes
 * `FCCState = 1 & local_info.featureset` (a65 control plugin, A65:5784-5788) and branches on it:
 * `FCCState !== 0` writes a **server** timer, `FCCState === 0` a device timer (A65:895347-895368,
 * and the same test on the patrol screen at A65:891831-891887). The test device reports
 * `featureset: 3`, so `1 & 3 = 1` - the server path, which is exactly what the measurement shows.
 *
 * ## What can be read locally, and what cannot
 *
 * Only the identifiers and whether they are switched on. The app assembles its schedule list from
 * **two** sources and merges them (`fetchTimerListFromServer`, A65:580178-580245): the robot
 * answers `get_server_timer` with the bare list, and the **Roborock cloud** answers
 * `getServerTimers()` with the schedules themselves - time, repetition, rooms, modes, all of it
 * (`rrHandleServerTimerList`, A65:580872 ff.; an entry without cloud parameters is even deleted
 * there, A65:580917-580925).
 *
 * So this module publishes what the robot itself knows and says plainly that the rest is in the
 * account. That is little, and it is still better than the present state, in which a running
 * schedule does not appear at all.
 *
 * **Not proven:** whether the cloud also *triggers* the schedule or merely stores it. That it
 * stores it is proven; that the robot would not run without an account is not.
 */

/** RPC that lists the server-side schedules a robot knows about. */
export const GET_SERVER_TIMER = "get_server_timer";

/**
 * Values of the state field that mean "switched off".
 *
 * Deliberately a list of the **off** spellings rather than a comparison against `"on"`. Two
 * spellings are in evidence and they do not agree with each other: the app tests one entry field
 * against the literal `'disable'` (`getServerTimerDisable`, A65:581586-581615), while the test
 * device answered `"on"` for an active schedule. A third spelling nobody has seen is therefore
 * perfectly possible - and if the check asked for equality with `"on"`, such a schedule would be
 * shown as switched off. Asking the other way round means an unknown spelling reads as "on",
 * which is the safer error: a schedule wrongly shown as active is visible and can be questioned,
 * one wrongly shown as off is silently reassuring.
 *
 * `off` is here because that is the vocabulary `upd_timer` uses for the device timers
 * (`PROJECT_STATE.md`, round 2: `params: [timerId, "on"|"off"]`).
 *
 * **Both lists are read with this set**, and that is the point of it. The evidence does not divide
 * along the two lists either: `disable` comes from the app, which reads it out of *device* timer
 * rows as well (`row[1] === 'disable'`, A65:582384-582389), and `on` is what a *server* entry
 * answered on the test device. Splitting the question in two would mean one of the readers asking
 * it the unsafe way round again.
 */
const INACTIVE_STATES = new Set(["disable", "off"]);

/** One schedule the robot reports as living on the server. */
export interface ServerTimerEntry {
	/** Identifier, index 0 of the entry (A65:581590-581596). */
	id: string;
	/** Whether it is switched on; see {@link INACTIVE_STATES} for why this is not `state === "on"`. */
	active: boolean;
	/** The state field as reported, unmodified. */
	state: string;
	/**
	 * The whole entry as the robot sent it, as JSON.
	 *
	 * The third field - `-1` in the only measurement - is **not** interpreted. The app never reads
	 * it: `getServerTimerDisable` looks at index 0 and index 1 and at nothing else. Passing the
	 * entry through unchanged keeps the information without inventing a meaning for it.
	 */
	raw: string;
}

/**
 * True when the state field is not one of the known "off" spellings.
 *
 * Used for both timer lists - see {@link INACTIVE_STATES} for why it asks the question this way
 * round, and why the answer must not differ between them.
 * @param state The state field of a row, as the robot reported it.
 * @returns True unless it is a known "off" spelling.
 */
export function isTimerActive(state: unknown): boolean {
	if (typeof state !== "string") return true;
	return !INACTIVE_STATES.has(state.trim().toLowerCase());
}

/**
 * Reads the answer of `get_server_timer`.
 *
 * @param response Raw robot answer; the request layer may wrap it once.
 * @returns One entry per usable row. A row without a usable identifier is dropped rather than
 *          published under an invented name.
 */
export function parseServerTimerList(response: unknown): ServerTimerEntry[] {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	// A single-element wrapper around the list, as several other answers of this robot carry.
	while (Array.isArray(payload) && payload.length === 1 && Array.isArray(payload[0]) && Array.isArray(payload[0][0])) {
		payload = payload[0];
	}
	if (!Array.isArray(payload)) return [];

	const entries: ServerTimerEntry[] = [];
	for (const row of payload) {
		if (!Array.isArray(row) || row.length === 0) continue;

		const id = row[0];
		if (typeof id !== "string" && typeof id !== "number") continue;
		const identifier = String(id).trim();
		if (!identifier) continue;

		const state = typeof row[1] === "string" ? row[1] : "";
		entries.push({
			id: identifier,
			active: isTimerActive(row[1]),
			state,
			raw: JSON.stringify(row),
		});
	}
	return entries;
}
