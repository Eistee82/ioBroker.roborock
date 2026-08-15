import { describe, expect, it } from "vitest";

import {
	CADENCE_MIN_SAMPLES,
	CADENCE_WINDOW,
	LiveTrackCadenceLearner,
	MAX_PLAUSIBLE_GAP_MS,
	estimateUpdatePeriodMs,
	isWorthAdopting,
	pauseForPeriod
} from "../../src/lib/map/liveTrackCadence";

/**
 * Learning how fast a robot really reports, instead of applying the number one robot produced.
 *
 * The four properties that matter are all failure modes rather than features: it must settle
 * instead of swinging, a hand-set value must win, a standing robot must not drag it to a crawl,
 * and it must not talk itself into ever longer pauses.
 */

const BOUNDS = { minMs: 250, maxMs: 2000 };

/** Feeds a learner a robot that changes its position every `periodMs`, sampled every `pauseMs`. */
function driveRobot(learner: LiveTrackCadenceLearner, options: { periodMs: number; pauseMs: number; forMs: number; startAt?: number }): number {
	const { periodMs, pauseMs, forMs } = options;
	let now = options.startAt ?? 1_000_000;
	const end = now + forMs;
	let x = 0;
	let nextChangeAt = now + periodMs;

	while (now < end) {
		if (now >= nextChangeAt) {
			x += 100;
			nextChangeAt += periodMs;
		}
		learner.observe({ x, y: 0 }, pauseMs, true, now);
		now += pauseMs;
	}
	return now;
}

describe("estimating the update period", () => {
	it("says nothing until it has enough to say", () => {
		expect(estimateUpdatePeriodMs([])).toBeNull();
		expect(estimateUpdatePeriodMs([{ observedMs: 3000, pauseMs: 1500 }])).toBeNull();
		expect(estimateUpdatePeriodMs(Array(CADENCE_MIN_SAMPLES - 1).fill({ observedMs: 3000, pauseMs: 1500 }))).toBeNull();
	});

	it("takes an interval as measured, without subtracting a polling delay", () => {
		// The tempting mistake: each detection is late by up to one pause, so subtract half a
		// pause. Wrong - an interval is bounded by two detections, both late by the same kind of
		// amount, so the delays cancel. Subtracting anyway under-estimates systematically; that
		// version failed the "lands near the pause measured for the test device" test below.
		const samples = Array(CADENCE_WINDOW).fill({ observedMs: 3000, pauseMs: 1500 });
		expect(estimateUpdatePeriodMs(samples)).toBe(3000);
	});

	it("ignores the outliers instead of chasing them", () => {
		// The real measurement ran from 79 ms to 6267 ms around a median of 3014.
		const samples = [
			{ observedMs: 3000, pauseMs: 0 },
			{ observedMs: 79, pauseMs: 0 },
			{ observedMs: 3100, pauseMs: 0 },
			{ observedMs: 6267, pauseMs: 0 },
			{ observedMs: 2950, pauseMs: 0 },
			{ observedMs: 3050, pauseMs: 0 }
		];
		const estimate = estimateUpdatePeriodMs(samples) as number;
		expect(estimate).toBeGreaterThan(2900);
		expect(estimate).toBeLessThan(3200);
	});
});

describe("turning a period into a pause", () => {
	it("samples about twice per update", () => {
		expect(pauseForPeriod(3014, BOUNDS)).toBe(1507);
	});

	it("never goes below the floor or above the idle pause", () => {
		expect(pauseForPeriod(100, BOUNDS)).toBe(BOUNDS.minMs);
		expect(pauseForPeriod(60_000, BOUNDS)).toBe(BOUNDS.maxMs);
	});
});

describe("settling instead of swinging", () => {
	it("keeps the pause until the suggestion really differs", () => {
		expect(isWorthAdopting(1500, 1530)).toBe(false);
		expect(isWorthAdopting(1500, 1400)).toBe(false);
		expect(isWorthAdopting(1500, 1200)).toBe(true);
		expect(isWorthAdopting(1500, 1900)).toBe(true);
	});

	it("adopts once and then stays put on a steady robot", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		driveRobot(learner, { periodMs: 3014, pauseMs: 1500, forMs: 120_000 });

		const first = learner.adopt();
		expect(first).not.toBeNull();

		// Everything that follows is the same robot; nothing should move again.
		for (let round = 0; round < 20; round++) {
			expect(learner.adopt()).toBeNull();
		}
	});
});

describe("what it learns about a real robot", () => {
	it("lands near the pause that was measured for the test device", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		driveRobot(learner, { periodMs: 3014, pauseMs: 1500, forMs: 120_000 });

		const pause = learner.adopt() as number;
		// Half of 3014 is 1507; the sampling grid makes it a little coarse either way.
		expect(pause).toBeGreaterThan(1200);
		expect(pause).toBeLessThan(1800);
	});

	it("discovers a robot that is faster than the pause it started with", () => {
		// The case the whole feature exists for: a robot that updates three times as fast as the
		// one that produced the shipped default. It cannot be seen at once - nothing can be
		// resolved finer than the current pause - so it is approached in steps.
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		let pause = 1500;

		for (let round = 0; round < 6; round++) {
			driveRobot(learner, { periodMs: 1000, pauseMs: pause, forMs: 60_000 });
			const adopted = learner.adopt();
			if (adopted !== null) pause = adopted;
		}

		expect(pause).toBeLessThan(900);
		expect(pause).toBeGreaterThanOrEqual(BOUNDS.minMs);
	});

	it("slows down for a robot that reports more rarely, and stops at the idle pause", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		let pause = 1500;

		for (let round = 0; round < 6; round++) {
			driveRobot(learner, { periodMs: 6000, pauseMs: pause, forMs: 180_000 });
			const adopted = learner.adopt();
			if (adopted !== null) pause = adopted;
		}

		expect(pause).toBeGreaterThan(1800);
		expect(pause).toBeLessThanOrEqual(BOUNDS.maxMs);
	});
});

describe("not sliding into a crawl", () => {
	it("drops every observation of a robot that is not working", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		for (let i = 0; i < 50; i++) {
			learner.observe({ x: 0, y: 0 }, 1500, false, 1_000_000 + i * 1500);
		}

		expect(learner.sampleCount).toBe(0);
		expect(learner.adopt()).toBeNull();
	});

	it("does not count the gap across a standstill as a period", () => {
		// Drive, stop for ten minutes, drive again. The first change after the break must not be
		// read as "this robot updates every ten minutes".
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		let now = driveRobot(learner, { periodMs: 3000, pauseMs: 1500, forMs: 60_000 });
		const samplesBefore = learner.sampleCount;

		for (let i = 0; i < 400; i++) {
			learner.observe({ x: 9999, y: 0 }, 1500, false, now);
			now += 1500;
		}

		driveRobot(learner, { periodMs: 3000, pauseMs: 1500, forMs: 30_000, startAt: now });

		expect(learner.sampleCount).toBeGreaterThanOrEqual(samplesBefore);
		const period = learner.estimatedPeriodMs as number;
		expect(period).toBeLessThan(6000);
	});

	it("refuses an implausibly long gap even while the robot counts as active", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		learner.observe({ x: 0, y: 0 }, 1500, true, 0);
		const accepted = learner.observe({ x: 100, y: 0 }, 1500, true, MAX_PLAUSIBLE_GAP_MS + 1000);

		expect(accepted).toBe(false);
		expect(learner.sampleCount).toBe(0);
	});

	it("ignores a repeat of the same position", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		learner.observe({ x: 5, y: 5 }, 1500, true, 0);
		for (let i = 1; i <= 10; i++) learner.observe({ x: 5, y: 5 }, 1500, true, i * 1500);

		expect(learner.sampleCount).toBe(0);
	});

	it("ignores an answer that carried no position at all", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		learner.observe({ x: 1, y: 1 }, 1500, true, 0);
		learner.observe(null, 1500, true, 1500);
		learner.observe(null, 1500, true, 3000);

		expect(learner.sampleCount).toBe(0);
	});
});

describe("forgetting", () => {
	it("starts over on reset", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		driveRobot(learner, { periodMs: 3000, pauseMs: 1500, forMs: 60_000 });
		expect(learner.adopt()).not.toBeNull();

		learner.reset();

		expect(learner.sampleCount).toBe(0);
		expect(learner.learnedPauseMs).toBeNull();
		expect(learner.adopt()).toBeNull();
	});

	it("keeps only the newest window of samples", () => {
		const learner = new LiveTrackCadenceLearner(BOUNDS);
		driveRobot(learner, { periodMs: 3000, pauseMs: 1500, forMs: 600_000 });

		expect(learner.sampleCount).toBe(CADENCE_WINDOW);
	});
});
