/**
 * Learns how often **this** robot advances its position, and paces the live channel accordingly.
 *
 * ## Why
 *
 * The default pause of 1500 ms is half the update period measured at one robot - a
 * `roborock.vacuum.a65` that advances its position every 3014 ms (median)
 * (`_appanalysis/positionstakt-fahrt-d.log`). The adapter serves 34 model classes and four protocol
 * versions. A robot that updates three times as fast is held back by that number, and its owner
 * never learns that there is a setting to change. So the number is a starting point, not a truth,
 * and the adapter can find the truth itself: it already sees, on every pass, whether the position
 * changed.
 *
 * ## What is actually being measured - and what is not
 *
 * The adapter sees **that** a value differs from the one before, never **when** the robot wrote it.
 * What this module measures is therefore the distance between two *observations of a change*, not
 * the robot's update period, and it can never resolve anything finer than its own polling pause.
 * Both are stated here rather than papered over, and one of them is corrected for:
 *
 * A change is noticed on the first poll after it happened, so an observed interval carries, on
 * average, half a polling pause of extra delay. Left uncorrected that is a **runaway**: a longer
 * pause makes intervals look longer, which lengthens the pause again, until the cap stops it. So
 * every sample records the pause that was in force when it was taken, and
 * {@link estimateUpdatePeriodMs} subtracts half of it again. That makes the estimate converge from
 * both directions - a robot that is faster than the current pause is discovered step by step,
 * because each shorter pause resolves a little more.
 *
 * ## Why the median and not an average
 *
 * The measured intervals ran from 79 ms to 6267 ms around a median of 3014. A mean would chase
 * every outlier and the pause would never settle; the median ignores them. Together with
 * {@link MIN_RELATIVE_CHANGE} - a new pause has to differ by a fifth before it is adopted - that is
 * what makes this settle instead of oscillate.
 */

/** One observed gap between two position changes, with the pause that was in force. */
export interface CadenceSample {
	/** Milliseconds between the two observations that saw the change. */
	observedMs: number;
	/** Pause the cycle was running at while this gap was measured. */
	pauseMs: number;
}

/**
 * How many samples are kept and how many are needed.
 *
 * Eight is roughly half a minute of driving at the measured rate - long enough for the median to
 * mean something, short enough to follow a robot whose behaviour really changes.
 */
export const CADENCE_WINDOW = 8;

/** Below this many samples nothing is applied; the configured pause stands. */
export const CADENCE_MIN_SAMPLES = 4;

/**
 * How much a newly derived pause must differ before it replaces the running one.
 *
 * Without this the pause would be rewritten on every single sample, and a value that moves by
 * 30 ms every three seconds is exactly the "swinging" this is meant to avoid.
 */
export const MIN_RELATIVE_CHANGE = 0.2;

/**
 * Longest gap that is taken as a sample at all.
 *
 * A robot that stands still never changes its position, and the first movement after a long pause
 * would otherwise arrive as a gap of minutes and drag the estimate to the ceiling. The measured
 * maximum while driving was 6267 ms; anything well beyond that is not a slow robot, it is a robot
 * that was not driving, and such a gap says nothing about its update rate.
 */
export const MAX_PLAUSIBLE_GAP_MS = 15_000;

/** Shortest gap that is taken as a sample; below this it is noise, not a period. */
export const MIN_PLAUSIBLE_GAP_MS = 50;

/**
 * Estimates the robot's update period from the samples.
 *
 * @param samples Observations, oldest first.
 * @returns The estimated period in ms, or null while there is not enough to say.
 */
export function estimateUpdatePeriodMs(samples: readonly CadenceSample[]): number | null {
	if (samples.length < CADENCE_MIN_SAMPLES) return null;

	// Each observation is late by up to one pause; on average by half of it. Taking that off again
	// is what keeps a long pause from justifying itself - see the module comment.
	const corrected = samples
		.map((sample) => sample.observedMs - sample.pauseMs / 2)
		.filter((value) => value > 0)
		.sort((a, b) => a - b);

	if (corrected.length < CADENCE_MIN_SAMPLES) return null;

	const middle = Math.floor(corrected.length / 2);
	return corrected.length % 2 === 0
		? Math.round((corrected[middle - 1] + corrected[middle]) / 2)
		: Math.round(corrected[middle]);
}

/**
 * Turns an estimated update period into the pause the cycle should run at.
 *
 * Half the period, so the robot is sampled about twice per update - the same reasoning the fixed
 * default rests on, applied to a measured rather than an assumed period. The bounds are the
 * caller's: the configurable floor below, and the idle pause above, because a channel that polls a
 * *driving* robot more slowly than a standing one would make no sense.
 *
 * @param periodMs Estimated update period.
 * @param bounds Shortest and longest pause that may be produced.
 */
export function pauseForPeriod(periodMs: number, bounds: { minMs: number; maxMs: number }): number {
	const half = Math.round(periodMs / 2);
	return Math.min(Math.max(half, bounds.minMs), bounds.maxMs);
}

/**
 * Decides whether a newly derived pause is different enough to be worth adopting.
 * @param current Pause in force.
 * @param next Pause the estimate suggests.
 */
export function isWorthAdopting(current: number, next: number): boolean {
	if (current <= 0) return true;
	return Math.abs(next - current) / current >= MIN_RELATIVE_CHANGE;
}

/**
 * Collects the observations of one device and hands out the pause to use.
 *
 * Holds no timers and nothing persistent: what it learned is worth one adapter run, exactly like
 * the capability probe, and for the same reason - the cheap thing is to learn it again.
 */
export class LiveTrackCadenceLearner {
	private readonly samples: CadenceSample[] = [];
	private lastChangeAt: number | null = null;
	private lastPosition: string | null = null;
	private adopted: number | null = null;

	/**
	 * @param bounds Shortest and longest pause this learner may ever produce.
	 */
	constructor(private readonly bounds: { minMs: number; maxMs: number }) {}

	/**
	 * Notes one observation of the robot's position.
	 *
	 * @param position The position as reported, or null when the answer carried none.
	 * @param pauseMs The pause the cycle is currently running at.
	 * @param active Whether the robot is working. Observations of a standing robot are dropped -
	 *               it does not move, so the gap until it does says nothing about its update rate.
	 * @param now Current time, injectable for tests.
	 * @returns True when this observation produced a new sample.
	 */
	public observe(position: { x: number; y: number } | null, pauseMs: number, active: boolean, now: number = Date.now()): boolean {
		if (!active) {
			// Drop the anchor as well: the gap across a standstill is not a period.
			this.lastChangeAt = null;
			this.lastPosition = null;
			return false;
		}
		if (!position) return false;

		const fingerprint = `${position.x},${position.y}`;
		if (this.lastPosition === null) {
			this.lastPosition = fingerprint;
			this.lastChangeAt = now;
			return false;
		}
		if (fingerprint === this.lastPosition) return false;

		const previousChangeAt = this.lastChangeAt;
		this.lastPosition = fingerprint;
		this.lastChangeAt = now;
		if (previousChangeAt === null) return false;

		const observedMs = now - previousChangeAt;
		if (observedMs < MIN_PLAUSIBLE_GAP_MS || observedMs > MAX_PLAUSIBLE_GAP_MS) return false;

		this.samples.push({ observedMs, pauseMs });
		if (this.samples.length > CADENCE_WINDOW) this.samples.shift();
		return true;
	}

	/** The estimated update period of this robot, or null while too little is known. */
	public get estimatedPeriodMs(): number | null {
		return estimateUpdatePeriodMs(this.samples);
	}

	/** How many usable samples have been collected. */
	public get sampleCount(): number {
		return this.samples.length;
	}

	/** The pause this learner currently stands by, or null while it has nothing to say. */
	public get learnedPauseMs(): number | null {
		return this.adopted;
	}

	/**
	 * Works out whether the pause should change, and remembers it if so.
	 *
	 * @returns The new pause when it was adopted, otherwise null. A null means "keep what you have".
	 */
	public adopt(): number | null {
		const period = this.estimatedPeriodMs;
		if (period === null) return null;

		const candidate = pauseForPeriod(period, this.bounds);
		if (this.adopted !== null && !isWorthAdopting(this.adopted, candidate)) return null;

		this.adopted = candidate;
		return candidate;
	}

	/** Forgets everything; used when a device reconnects and its identity may have changed. */
	public reset(): void {
		this.samples.length = 0;
		this.lastChangeAt = null;
		this.lastPosition = null;
		this.adopted = null;
	}
}
