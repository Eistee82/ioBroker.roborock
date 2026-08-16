/**
 * Reading the list of schedules a robot keeps in its own memory.
 *
 * `get_timer` answers with one row per schedule. Index 0 is the identifier and index 1 the switch
 * state; that is not read off a sample but off the app's own mapping of the very same rows -
 * `entry['name'] = row[0]`, `enabled = row[1] === 'on'`, `disable = row[1] === 'disable'`
 * (A65:582263-582272, A65:582378-582389). The chain is written up in `timerDeletion.ts` section 1,
 * which needs the same two fields for `del_timer`.
 *
 * Everything that reads that shape lives here, so the transport envelope is unwrapped in one place
 * for both of its users: whether a schedule is still listed at all (`del_timer`, `timerDeletion.ts`)
 * and what the list says about its switch (`upd_timer`, `main.handleScheduleToggle`).
 */

/**
 * Digs the list of rows out of an answer, or reports that there is none.
 *
 * `null` means the answer is not a list of rows - a shape nobody recognises. It is deliberately kept
 * apart from an empty list: a robot that keeps no schedules of its own answers `[]`, and that is a
 * statement, while an unreadable answer is not.
 *
 * @param response Raw answer of `get_timer` or `get_server_timer`.
 * @returns The rows, or `null` when the answer is not a list.
 */
export function unwrapTimerRows(response: unknown): unknown[] | null {
	let payload: unknown = response;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
		payload = (payload as Record<string, unknown>).data;
	}
	if (!Array.isArray(payload)) return null;

	// A single-element wrapper around the list, as several answers of this robot carry. Unwrapped only
	// when the inner element is itself a list of rows, so a genuine one-timer answer is left alone.
	if (payload.length === 1 && Array.isArray(payload[0]) && Array.isArray(payload[0][0])) {
		return payload[0];
	}
	return payload;
}

/**
 * What a timer list says about the switch of one schedule.
 *
 * The state field is handed back **as it was reported**, not as a boolean. Which spellings mean
 * "off" is a question of its own - `serverTimers.ts` lists the two that are in evidence and says why
 * they are asked for the other way round - and it is not this reader's to answer.
 *
 * `null` is returned for both "the answer is not a readable list" and "the list does not mention this
 * identifier", because neither says anything about the switch. A caller must not read it as "off":
 * the schedule may have been deleted meanwhile, and one silent answer is not proof that it was.
 * `timerIsGone` in `timerDeletion.ts` draws the line differently on purpose - for a deletion, an
 * unreadable answer counts as "still there", because claiming a deletion that did not happen is the
 * more expensive mistake there.
 *
 * @param response Raw answer of `get_timer`.
 * @param timerId  Identifier as it appears under `schedules.`.
 * @returns The state field of that row, `""` when the row carries none, or `null` when the list does
 *          not mention the identifier.
 */
export function timerSwitchState(response: unknown, timerId: string): string | null {
	const rows = unwrapTimerRows(response);
	if (rows === null) return null;

	for (const row of rows) {
		if (!Array.isArray(row) || row.length === 0) continue;
		if (String(row[0]) !== timerId) continue;
		return typeof row[1] === "string" ? row[1] : "";
	}
	return null;
}
