import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import {
	GET_CLEAN_ESTIMATE_INFO,
	GET_DRYER_SETTING,
	GET_DUST_COLLECTION_MODE,
	GET_TIMEZONE,
	SET_DRYER_SETTING,
	SET_DUST_COLLECTION_MODE
} from "../../src/lib/features/vacuum/v1ProbedCapabilities";
import { GET_COLLISION_AVOID_STATUS, SET_COLLISION_AVOID_STATUS } from "../../src/lib/features/vacuum/services/V1RobotSettingsService";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * How the five probed capabilities reach the object tree.
 *
 * What the payload of each command is, and which values it may carry, is proven and tested in
 * `probed_capabilities.test.ts`. This file is about the step in between: which of them a given robot
 * is asked about at all, and what happens to a robot that already has one of them from its model
 * class.
 *
 * **The test this file exists for is the third one.** Until the second capability arrived, the
 * detection began with a plain `if (this.folderOfCommand(SET_COLLISION_AVOID_STATUS)) return;`. That
 * reads like a guard for obstacle avoidance and is a guard for the whole method: on a robot whose
 * model class already declares that one command - which is exactly what `A179Features` does - the
 * method would have left before asking about anything else, and four capabilities would have gone
 * missing with nothing in the log to say so. The guard is now per capability, and this pins it.
 */

/** The answers of the test device, keyed by the command that asks for them. */
const DEVICE_ANSWERS: Record<string, unknown> = {
	[GET_TIMEZONE]: ["Europe/Berlin"],
	[GET_CLEAN_ESTIMATE_INFO]: { clean_estimate: { total_area: 27070000, remaining_time: 200 } },
	[GET_COLLISION_AVOID_STATUS]: { status: 1 },
	[GET_DUST_COLLECTION_MODE]: { mode: 0 },
	[GET_DRYER_SETTING]: { status: 1, on: { dry_time: 7200 } }
};

/** How the robot rejects a method it does not know (`_appanalysis/19-geraetefaehigkeiten.md` §0). */
const UNKNOWN_METHOD = "unknown_method";

describe("which probed capabilities a robot is offered", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;

	/** Commands the robot pretends not to know. */
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set();
		sendRequest = vi.fn(async (_duid: string, method: string) => {
			if (rejected.has(method)) return UNKNOWN_METHOD;
			return DEVICE_ANSWERS[method] ?? {};
		});

		adapterMock = {
			namespace: "roborock.0",
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
			setStateChanged: vi.fn().mockResolvedValue(undefined),
			setState: vi.fn().mockResolvedValue(undefined),
			getObjectAsync: vi.fn().mockResolvedValue({ common: {} }),
			requestsHandler: { sendRequest },
			rLog: vi.fn(),
			errorMessage: (e: unknown) => String(e),
			translationManager: { get: (_key: string, fallback: string) => fallback },
			http_api: { getRobotModel: vi.fn().mockReturnValue("roborock.vacuum.a65"), getDevices: vi.fn().mockReturnValue([]) }
		};

		depsMock = {
			adapter: adapterMock,
			// Required by `FeatureDependencies` and left out until the remote control detection
			// became the first thing here to read it. The robot answers `get_fw_features` with `{}`
			// through the mock above, so it is offered nothing - which is what this file wants.
			http_api: adapterMock.http_api,
			ensureState: vi.fn().mockResolvedValue(undefined),
			ensureFolder: vi.fn().mockResolvedValue(undefined),
			log: adapterMock.log,
			config: { staticFeatures: [] }
		} as unknown as FeatureDependencies;
	});

	class TestVacuum extends V1VacuumFeatures {
		protected getDynamicFeatures(): Set<Feature> {
			return new Set();
		}
		public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
			return false;
		}
		/** Runs the detection the way `initialize()` does for an online device. */
		public async runDetection(): Promise<void> {
			await this.detectProbedCapabilities();
		}
		/** Stands in for a model class that declared a command before the detection runs. */
		public declareCommand(name: string, group: string): void {
			this.addCommand(name, { type: "boolean", role: "button", def: false }, group);
		}
		/** Every command name registered in any folder. */
		public registeredCommands(): string[] {
			return [...Object.keys(this.commands), ...Object.values(this.extraCommandGroups).flatMap((group) => Object.keys(group))];
		}
	}

	function createVacuum(): TestVacuum {
		return new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
	}

	it("offers all five to a robot that answers all five getters", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const registered = vacuum.registeredCommands();
		for (const command of [SET_COLLISION_AVOID_STATUS, SET_DUST_COLLECTION_MODE, SET_DRYER_SETTING, GET_TIMEZONE, GET_CLEAN_ESTIMATE_INFO]) {
			expect(registered).toContain(command);
		}
	});

	it("offers nothing it was rejected on, and everything else", async () => {
		rejected.add(GET_DRYER_SETTING).add(GET_COLLISION_AVOID_STATUS);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const registered = vacuum.registeredCommands();
		expect(registered).not.toContain(SET_DRYER_SETTING);
		expect(registered).not.toContain(SET_COLLISION_AVOID_STATUS);
		expect(registered).toContain(SET_DUST_COLLECTION_MODE);
		expect(registered).toContain(GET_TIMEZONE);
	});

	it("keeps asking about the rest when a model class already declared one of them", async () => {
		// Exactly the a179 situation. With the old whole-method guard this test fails: nothing but
		// the pre-declared command is registered, and not one further probe goes out.
		const vacuum = createVacuum();
		vacuum.declareCommand(SET_COLLISION_AVOID_STATUS, "settings");
		await vacuum.runDetection();

		const registered = vacuum.registeredCommands();
		expect(registered).toContain(SET_DUST_COLLECTION_MODE);
		expect(registered).toContain(SET_DRYER_SETTING);
		expect(registered).toContain(GET_TIMEZONE);
		expect(registered).toContain(GET_CLEAN_ESTIMATE_INFO);
	});

	it("does not ask about a capability whose command a model class owns", async () => {
		// The point of the guard: no second owner for one command, and no request wasted on a
		// question that is already answered.
		const vacuum = createVacuum();
		vacuum.declareCommand(SET_DRYER_SETTING, "commands");
		vacuum.declareCommand(GET_CLEAN_ESTIMATE_INFO, "commands");
		await vacuum.runDetection();

		const asked = sendRequest.mock.calls.map((call) => call[1]);
		expect(asked).not.toContain(GET_DRYER_SETTING);
		expect(asked).not.toContain(GET_CLEAN_ESTIMATE_INFO);
		expect(asked).toContain(GET_DUST_COLLECTION_MODE);
	});

	it("sends each probe the payload the app's own wrapper builds", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const payloadOf = (method: string): unknown => sendRequest.mock.calls.find((call) => call[1] === method)?.[2];
		// The estimate getter is the one that builds an object where its neighbours build an array
		// (A65:228341 against A65:228560 and A65:229104).
		expect(payloadOf(GET_CLEAN_ESTIMATE_INFO)).toEqual({});
		expect(payloadOf(GET_TIMEZONE)).toEqual([]);
		expect(payloadOf(GET_DUST_COLLECTION_MODE)).toEqual([]);
		expect(payloadOf(GET_DRYER_SETTING)).toEqual([]);
	});

	it("asks the two read-only capabilities before the three that can write", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const asked = sendRequest.mock.calls.map((call) => call[1]);
		expect(asked.indexOf(GET_TIMEZONE)).toBeLessThan(asked.indexOf(GET_DUST_COLLECTION_MODE));
		expect(asked.indexOf(GET_CLEAN_ESTIMATE_INFO)).toBeLessThan(asked.indexOf(GET_DRYER_SETTING));
	});

	it("reads the drying setting at start-up, because switching off needs its duration", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		// Asked twice: once as the probe, once to seed the duration the off position has to carry.
		expect(sendRequest.mock.calls.filter((call) => call[1] === GET_DRYER_SETTING).length).toBe(2);
	});

	it("does not read the estimate at start-up, because the robot is in its dock then", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		// Only the probe. Reading it here would publish the last finished run as if it were current.
		expect(sendRequest.mock.calls.filter((call) => call[1] === GET_CLEAN_ESTIMATE_INFO).length).toBe(1);
	});

	it("survives a robot that answers nothing at all", async () => {
		sendRequest.mockRejectedValue(new Error("EHOSTUNREACH"));
		const vacuum = createVacuum();
		await expect(vacuum.runDetection()).resolves.toBeUndefined();

		const registered = vacuum.registeredCommands();
		for (const command of [SET_COLLISION_AVOID_STATUS, SET_DUST_COLLECTION_MODE, SET_DRYER_SETTING, GET_TIMEZONE]) {
			expect(registered).not.toContain(command);
		}
	});
});
