import { afterEach, describe, expect, it, vi } from "vitest";
import { MapEngine, RESUME_COMMAND_BY_IN_CLEANING } from "./MapEngine";
import type { EngineConnection, MapEngineHost } from "./types";

/**
 * Continuing a paused run.
 *
 * The tab sent `app_start` for every paused run until the app's own dispatch was read. That is
 * right for one case out of three and wrong for the other two: a paused zone run and a paused
 * segment run are continued with `resume_zoned_clean` and `resume_segment_clean`
 * (a65 control plugin, A65:421454-421600). A whole-flat run really is continued with `app_start`
 * (A65:421445-421453), which is why the old behaviour was not simply broken - it was right by
 * accident for the commonest case, and that is the worst kind of wrong to find by hand.
 *
 * Which case applies is the robot's own `in_cleaning`, through the table at A65:222457-222468.
 * These tests pin that mapping and the fallback, because a wrong branch here starts a whole-flat
 * run when the user asked to continue a single room.
 */

let live: MapEngine | null = null;

async function startEngine(): Promise<{ engine: MapEngine; sendTo: ReturnType<typeof vi.fn> }> {
	const sendTo = vi.fn().mockResolvedValue({});
	const connection: EngineConnection = {
		sendTo,
		getObject: vi.fn().mockResolvedValue(null),
		getStates: vi.fn().mockResolvedValue({}),
		subscribeState: vi.fn().mockResolvedValue(undefined),
		unsubscribeState: vi.fn(),
		getObjectViewSystem: vi.fn().mockResolvedValue({}),
	};

	const container = document.createElement("div");
	document.body.appendChild(container);

	const host: MapEngineHost = {
		container,
		t: (_key: string, fallback: string) => fallback,
	};

	const engine = new MapEngine(connection, host);
	live = engine;
	await engine.init("roborock.0");
	(engine as unknown as { currentRobotDuid: string | null }).currentRobotDuid = "duid1";
	return { engine, sendTo };
}

/** Sets the robot's `in_cleaning` as the status subscription would. */
function withInCleaning(engine: MapEngine, value: number | null): void {
	(engine as unknown as { statusValues: { inCleaning: number | null } }).statusValues.inCleaning = value;
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.replaceChildren();
});

describe("the resume dispatch table", () => {
	it("is the app's own, and offers nothing for a robot that has nothing to resume", () => {
		expect(RESUME_COMMAND_BY_IN_CLEANING).toEqual({
			1: "app_start",
			2: "resume_zoned_clean",
			3: "resume_segment_clean",
		});
		// 0 is `None` in the app's table: there is no paused run at all.
		expect(RESUME_COMMAND_BY_IN_CLEANING[0]).toBeUndefined();
	});
});

describe("resume()", () => {
	it("continues a paused whole-flat run with app_start", async () => {
		const { engine, sendTo } = await startEngine();
		withInCleaning(engine, 1);

		engine.resume();
		expect(sendTo).toHaveBeenCalledTimes(1);
		expect(sendTo.mock.calls[0][1]).toBe("app_start");
		expect(sendTo.mock.calls[0][2]).toEqual({ duid: "duid1" });
	});

	it("continues a paused zone run with resume_zoned_clean", async () => {
		const { engine, sendTo } = await startEngine();
		withInCleaning(engine, 2);

		engine.resume();
		expect(sendTo.mock.calls[0][1]).toBe("resume_zoned_clean");
	});

	it("continues a paused segment run with resume_segment_clean", async () => {
		// 3 is Segment and 2 is Zone, not the other way round - a contradiction in Roborock's own
		// comments that three independent bundle paths now settle the same way.
		const { engine, sendTo } = await startEngine();
		withInCleaning(engine, 3);

		engine.resume();
		expect(sendTo.mock.calls[0][1]).toBe("resume_segment_clean");
	});

	it("falls back to app_start when the robot reports nothing useful", async () => {
		// A device that never publishes `in_cleaning`, or publishes 0, keeps exactly the behaviour
		// the tab had before this branch existed. A new dispatch must not take a working button away
		// from a model whose status is thinner than the test device's.
		for (const value of [null, 0, 4, 99]) {
			const { engine, sendTo } = await startEngine();
			withInCleaning(engine, value);

			engine.resume();
			expect(sendTo.mock.calls[0][1]).toBe("app_start");

			live?.destroy();
			live = null;
		}
	});

	it("sends nothing while no robot is selected", async () => {
		const { engine, sendTo } = await startEngine();
		(engine as unknown as { currentRobotDuid: string | null }).currentRobotDuid = null;

		engine.resume();
		expect(sendTo).not.toHaveBeenCalled();
	});

	it("never sends app_resume, whatever the robot reports", async () => {
		// Its only caller in the app is the "robot went back to the dock to handle its mop and now
		// carries on" case (A65:422688-422702) - a state this tab does not represent. Sending it for
		// a paused run would be a guess.
		for (const value of [null, 0, 1, 2, 3, 4]) {
			const { engine, sendTo } = await startEngine();
			withInCleaning(engine, value);

			engine.resume();
			expect(sendTo.mock.calls[0][1]).not.toBe("app_resume");

			live?.destroy();
			live = null;
		}
	});
});
