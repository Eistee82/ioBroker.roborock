import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_REMOTE, REMOTE_REFRESH_MS, RemoteDriver } from "./remoteDriver";
import type { RemoteDriverModel } from "./remoteDriver";
import type { EngineConnection } from "../engine/types";

/**
 * The one thing this component must never get wrong: it drives only while a button is held.
 *
 * The robot stops by itself 1.5 s after the last message it received, so every test here is really
 * about the same question - after the press ends, does anything else go out? A single stray tick is
 * a robot that keeps rolling for another one and a half seconds into whatever is in front of it.
 */

interface Sent {
	command: string;
	data: any;
}

function createDriver(options: { supported?: boolean } = {}): {
	driver: RemoteDriver;
	sent: Sent[];
	model: () => RemoteDriverModel;
	errors: string[];
} {
	const sent: Sent[] = [];
	const errors: string[] = [];
	let model: RemoteDriverModel = { ...EMPTY_REMOTE };

	const connection = {
		sendTo: async (_instance: string, command: string, data: unknown) => {
			sent.push({ command, data });
			if (command === "remote_start") return { result: "accepted", launchMs: 6000 };
			return { result: "accepted" };
		},
		getObject: async () => (options.supported === false ? null : { _id: "x", common: {} }),
		getStates: async () => ({}),
		subscribeState: async () => undefined,
		unsubscribeState: () => undefined,
		getObjectViewSystem: async () => ({})
	} as unknown as EngineConnection;

	const driver = new RemoteDriver(connection, {
		onChange: next => {
			model = next;
		},
		onError: message => errors.push(message),
		t: (_key, fallback) => fallback
	});

	return { driver, sent, model: () => model, errors };
}

/** Brings a driver all the way to "ready to drive". */
async function ready(): Promise<ReturnType<typeof createDriver>> {
	const context = createDriver();
	await context.driver.setDevice("roborock.0", "duid1");
	await context.driver.start();
	// The run-up is six seconds of the app's own; the pad is disabled until it is over.
	await vi.advanceTimersByTimeAsync(6000);
	context.sent.length = 0;
	return context;
}

describe("the remote driver", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stays away entirely on a robot that has no remote control object", async () => {
		const { driver, model } = createDriver({ supported: false });
		await driver.setDevice("roborock.0", "duid1");

		expect(model().supported).toBe(false);
		driver.destroy();
	});

	it("opens the mode and reports the run-up", async () => {
		const { driver, sent, model } = createDriver();
		await driver.setDevice("roborock.0", "duid1");
		await driver.start();

		expect(sent.map(entry => entry.command)).toEqual(["remote_start"]);
		expect(model().active).toBe(true);
		expect(model().launching).toBe(true);

		await vi.advanceTimersByTimeAsync(6000);
		expect(model().launching).toBe(false);
		driver.destroy();
	});

	it("relays the question the adapter asks instead of starting", async () => {
		const { driver, model } = createDriver();
		await driver.setDevice("roborock.0", "duid1");

		// The adapter answers `confirm` for a running job; the driver must not pretend it started.
		(driver as any).connection.sendTo = async () => ({ result: "confirm", stateCode: 5 });
		await driver.start();

		expect(model().confirming).toBe(true);
		expect(model().active).toBe(false);
		driver.destroy();
	});

	it("refuses to drive while the robot is updating", async () => {
		const { driver, model } = createDriver();
		await driver.setDevice("roborock.0", "duid1");

		(driver as any).connection.sendTo = async () => ({ result: "refused", stateCode: 14 });
		await driver.start();

		expect(model().active).toBe(false);
		expect(model().refusal).not.toBeNull();
		driver.destroy();
	});

	it("sends nothing at all until a direction is pressed", async () => {
		const { driver, sent } = await ready();
		await vi.advanceTimersByTimeAsync(5000);

		expect(sent).toEqual([]);
		driver.destroy();
	});

	it("sends the first move immediately and then on the app's cadence", async () => {
		const { driver, sent } = await ready();
		driver.press(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent.length).toBe(1);

		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 3);
		expect(sent.length).toBe(4);
		expect(sent.every(entry => entry.command === "remote_move" && entry.data.direction === 1)).toBe(true);
		driver.destroy();
	});

	it("stops sending the moment the button is released", async () => {
		// The test this file exists for.
		const { driver, sent } = await ready();
		driver.press(1);
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 2);

		driver.release();
		await vi.advanceTimersByTimeAsync(0);
		const afterRelease = sent.length;

		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 10);
		expect(sent.length).toBe(afterRelease);
		expect(sent.at(-1)?.command).toBe("remote_stop");
		driver.destroy();
	});

	it("stops driving and leaves the mode when the page is hidden", async () => {
		// A background tab has its timers throttled, so a 400 ms cadence stops being one. Leaving
		// the mode is the honest answer, not merely stopping the motion.
		const { driver, sent } = await ready();
		driver.press(1);
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS);

		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		const afterHide = sent.length;
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 10);
		expect(sent.length).toBe(afterHide);
		expect(sent.map(entry => entry.command)).toContain("remote_end");
		driver.destroy();
	});

	it("releases the button when the window loses focus", async () => {
		// A key held while the window loses focus never produces a keyup.
		const { driver, sent } = await ready();
		driver.press(1);
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS);

		window.dispatchEvent(new Event("blur"));
		await vi.advanceTimersByTimeAsync(0);
		const afterBlur = sent.length;

		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 5);
		expect(sent.length).toBe(afterBlur);
		driver.destroy();
	});

	it("ends the mode and stops the timer when the page goes away", async () => {
		const { driver, sent } = await ready();
		driver.press(1);
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS);

		window.dispatchEvent(new Event("pagehide"));
		await vi.advanceTimersByTimeAsync(0);
		const afterHide = sent.length;

		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 10);
		expect(sent.length).toBe(afterHide);
		expect(sent.map(entry => entry.command)).toContain("remote_end");
		driver.destroy();
	});

	it("refuses to drive during the run-up", async () => {
		const { driver, sent } = createDriver();
		await driver.setDevice("roborock.0", "duid1");
		await driver.start();
		sent.length = 0;

		driver.press(1);
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 3);
		expect(sent).toEqual([]);
		driver.destroy();
	});

	it("refuses a direction the app cannot express", async () => {
		const { driver, sent } = await ready();
		driver.press(0);
		driver.press(9);
		driver.press(-1);
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 2);

		expect(sent).toEqual([]);
		driver.destroy();
	});

	it("drops the press when a move fails rather than carrying on blind", async () => {
		const context = await ready();
		(context.driver as any).connection.sendTo = async () => {
			throw new Error("socket closed");
		};

		context.driver.press(1);
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 5);

		expect(context.model().direction).toBe(0);
		expect(context.errors.length).toBeGreaterThan(0);
		context.driver.destroy();
	});

	it("ends an open session before it follows a device switch", async () => {
		const { driver, sent } = await ready();
		await driver.setDevice("roborock.0", "duid2");

		expect(sent.map(entry => entry.command)).toContain("remote_end");
		driver.destroy();
	});

	it("ends the session and drops every listener on destroy", async () => {
		const { driver, sent } = await ready();
		driver.press(1);
		driver.destroy();
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 10);

		expect(sent.map(entry => entry.command)).toContain("remote_end");
		const afterDestroy = sent.length;

		// Nothing that used to end a press may still reach a destroyed driver.
		window.dispatchEvent(new Event("pagehide"));
		window.dispatchEvent(new Event("blur"));
		await vi.advanceTimersByTimeAsync(REMOTE_REFRESH_MS * 5);
		expect(sent.length).toBe(afterDestroy);
	});
});
