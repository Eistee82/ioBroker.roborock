/**
 * Deciding which room switches no longer belong to a map.
 *
 * ## Why this needs its own module and this much care
 *
 * Splitting or merging rooms **renumbers the robot's segments** (report section 2.2, event
 * `RoomIdDidChanged`). The adapter creates a switch per segment under
 * `Devices.<duid>.floors.<mapFlag>.<roomId>` and has never removed one, so after a split the object
 * tree keeps switches for numbers the robot no longer has - carrying the name the old room had. A
 * switch labelled "Kitchen" pointing at a segment that is now the bathroom is exactly the kind of
 * fault nobody notices until the robot mops the wrong room.
 *
 * But the cure is more dangerous than the disease if it fires once too often: **this is the only
 * operation in the adapter that deletes objects a user has built things on** - scripts, vis
 * widgets, scenes. So the rule is not "this room is missing from the map I just read" but "this
 * room has been provably absent from several clean readings of this very map".
 *
 * ## What the caller has to guarantee
 *
 * {@link decideRoomPruning} decides nothing on its own; it is fed a reading and answers what that
 * reading justifies. The caller must only ever pass a reading it considers **clean** - a map that
 * parsed, that belongs to a known map slot, and that carries a non-empty segment list. Everything
 * else is not a reading of "no rooms", it is the absence of a reading, and this module answers such
 * a case by forgetting what it thought it knew rather than by acting on it.
 *
 * The counters live in memory only. An adapter restart therefore starts the evidence over, which is
 * the safe direction: it delays a deletion, it never causes one.
 */

/** A room state's evidence of absence, per map slot and room id. */
export type RoomAbsenceCounters = Readonly<Record<number, number>>;

/** What one clean reading of a map justifies. */
export interface RoomPruningDecision {
	/** Room ids whose state may be deleted now. */
	remove: number[];
	/** Counters to keep for the next reading of this map. */
	absences: RoomAbsenceCounters;
}

/**
 * How many consecutive clean readings must miss a room before its switch is removed.
 *
 * Three, not one. A single reading that omits a segment is not proof that the segment is gone: the
 * robot rebuilds its map while it drives, and a map fetched mid-run can legitimately carry fewer
 * segments than the finished one. Three readings of the same map slot, all clean and all missing
 * the same room, is evidence; one is a coincidence waiting to delete somebody's switch.
 *
 * The cost of being wrong in the other direction is a stale switch for a few more minutes, which is
 * the state the adapter has been in for its whole existence.
 */
export const ROOM_ABSENCE_THRESHOLD = 3;

/** What {@link decideRoomPruning} needs to judge one reading. */
export interface RoomPruningInput {
	/**
	 * Segment ids the freshly read map carries.
	 *
	 * **Empty means "no usable reading", never "this map has no rooms".** A map without segments
	 * cannot distinguish a robot that lost its rooms from a fetch that came back thin, so an empty
	 * list resets the evidence instead of building it.
	 */
	present: readonly number[];
	/** Room ids that currently have a state under this map slot. */
	existing: readonly number[];
	/** Evidence gathered from previous clean readings of this same map slot. */
	absences: RoomAbsenceCounters;
	/** Readings needed before a removal; {@link ROOM_ABSENCE_THRESHOLD} unless a test varies it. */
	threshold?: number;
}

/**
 * Works out which room states one clean reading justifies removing.
 *
 * Deliberately pure: it touches no objects and knows no adapter, so the rule that decides a deletion
 * can be tested without a single object being at risk.
 * @param input The reading, the states that exist, and the evidence so far.
 * @returns What to delete now, and the evidence to carry forward.
 */
export function decideRoomPruning(input: RoomPruningInput): RoomPruningDecision {
	const threshold = input.threshold ?? ROOM_ABSENCE_THRESHOLD;

	// No usable reading: forget the evidence rather than add to it. Counting an unusable reading
	// towards a deletion is precisely how a hiccup in three polls would remove a user's switches.
	if (input.present.length === 0) {
		return { remove: [], absences: {} };
	}

	const present = new Set(input.present);
	const absences: Record<number, number> = {};
	const remove: number[] = [];

	for (const roomId of input.existing) {
		// A room the map carries is not absent, and any evidence against it is void: a segment that
		// came back is not two thirds of the way to being deleted.
		if (present.has(roomId)) continue;

		const seen = (input.absences[roomId] ?? 0) + 1;
		if (seen >= threshold) remove.push(roomId);
		else absences[roomId] = seen;
	}

	return { remove, absences };
}
