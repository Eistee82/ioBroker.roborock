import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import { APP_RC_END, APP_RC_MOVE, APP_RC_START, APP_RC_STOP } from "../../src/lib/features/vacuum/remoteControl";
import { socketHandler } from "../../src/lib/socketHandler";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * Who is offered the remote control, and what the tab's four messages are allowed to do.
 *
 * The rule this file pins is the one the whole feature hangs on: **only a robot whose own firmware
 * reports feature 125 gets the commands.** Not a model class, and not "every V1 robot" - the app
 * itself asks the same question (`isRemoteSupported()`, A65:232713-232720). A robot without it must
 * end up with no object, so that the messages have nothing to reach.
 *
 * The feature list of the test device is the measured one:
 * `_appanalysis/geraetefaehigkeiten-1786790619395.json` answers `get_fw_features` with
 * `[111…125]`.
 */

/** What the a65 really answers (`get_fw_features`, measured). */
const A65_FEATURES = [111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125];

/** The same robot without the remote control bit. */
const WITHOUT_REMOTE = A65_FEATURES.filter((id) => id !== 125);

describe("which robot is offered the remote control", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;
	let firmwareFeatures: unknown;

	beforeEach(() => {
		firmwareFeatures = A65_FEATURES;
		sendRequest = vi.fn(async (_duid: string, method: string) => {
			if (method === "get_fw_features") return firmwareFeatures;
			// Everything else is a probe of another capability; a bare string is how the robot says
			// it does not know a method, which keeps this test to the one question it is about.
			return "unknown_method";
		});

		adapterMock = {
			namespace: "roborock.0",
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
			setStateChanged: vi.fn().mockResolvedValue(undefined),
			setState: vi.fn().mockResolvedValue(undefined),
			getObjectAsync: vi.fn().mockResolvedValue({ common: {} }),
			getStateAsync: vi.fn().mockResolvedValue(null),
			requestsHandler: { sendRequest },
			rLog: vi.fn(),
			errorMessage: (e: unknown) => String(e),
			translationManager: { get: (_key: string, fallback: string) => fallback },
			http_api: {
				getRobotModel: vi.fn().mockReturnValue("roborock.vacuum.a65"),
				getDevices: vi.fn().mockReturnValue([]),
				getFwFeaturesResult: vi.fn().mockReturnValue(undefined),
				storeFwFeaturesResult: vi.fn()
			}
		};

		depsMock = {
			adapter: adapterMock,
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
		public folderOf(command: string): string | null {
			for (const folder of this.getCommandFolders()) {
				if (this.getCommandSpec(folder, command)) return folder;
			}
			return null;
		}
		public specOf(folder: string, command: string): any {
			return this.getCommandSpec(folder, command);
		}
	}

	function createVacuum(): TestVacuum {
		return new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
	}

	it("publishes all four calls for a robot that reports feature 125", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		for (const command of [APP_RC_START, APP_RC_MOVE, APP_RC_STOP, APP_RC_END]) {
			expect(vacuum.folderOf(command)).toBe("remoteControl");
		}
	});

	it("publishes nothing for a robot without it", async () => {
		firmwareFeatures = WITHOUT_REMOTE;
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(APP_RC_START)).toBeNull();
		expect(vacuum.folderOf(APP_RC_MOVE)).toBeNull();
	});

	it("publishes nothing when the robot does not answer at all", async () => {
		// The same direction of error the capability probe takes: no answer is not evidence in
		// favour, and this control moves a machine.
		sendRequest.mockRejectedValue(new Error("timeout"));
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(vacuum.folderOf(APP_RC_START)).toBeNull();
	});

	it("offers the direction as a picker of the nine values the app can express", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const spec = vacuum.specOf("remoteControl", APP_RC_MOVE);
		expect(spec.type).toBe("number");
		expect(Object.keys(spec.states)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
	});

	it("remembers the firmware list so a second reader does not ask again", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(adapterMock.http_api.storeFwFeaturesResult).toHaveBeenCalledWith("duid-test", A65_FEATURES);
	});

	it("closes a session the previous adapter run left open", async () => {
		// The fourth defence. `sessionOpen` is what the adapter wrote down before it went away.
		adapterMock.getStateAsync.mockImplementation(async (id: string) =>
			id.endsWith("remoteControl.sessionOpen") ? { val: true } : null
		);
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const sentAfterDetection = sendRequest.mock.calls.map((call) => call[1]);
		expect(sentAfterDetection).toContain(APP_RC_STOP);
		expect(sentAfterDetection).toContain(APP_RC_END);
	});

	it("leaves a robot alone when no session was left open", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		const sent = sendRequest.mock.calls.map((call) => call[1]);
		expect(sent).not.toContain(APP_RC_END);
	});
});

/** The four messages the admin tab sends, and the boundary they have to pass. */
describe("the remote control messages of the tab", () => {
	function createAdapter(options: { remote?: boolean; stateCode?: number } = {}) {
		const folders = options.remote === false ? ["commands"] : ["commands", "remoteControl"];
		const handler = {
			hasCommandFolder: (folder: string) => folders.includes(folder),
			getCommandSpec: () => ({ type: "number" })
		};

		return {
			namespace: "roborock.0",
			deviceFeatureHandlers: new Map<string, unknown>([["duid1", handler]]),
			requestsHandler: { command: vi.fn().mockResolvedValue(undefined) },
			getStateAsync: vi.fn().mockResolvedValue(options.stateCode === undefined ? null : { val: options.stateCode }),
			setTimeout: (fn: () => void) => setTimeout(fn, 0),
			sendTo: vi.fn(),
			rLog: vi.fn(),
			catchError: vi.fn(),
			errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
		};
	}

	async function send(adapter: ReturnType<typeof createAdapter>, command: string, message: unknown): Promise<any> {
		const instance = new socketHandler(adapter as any);
		await instance.handleMessage({ command, message, from: "system.adapter.admin.0", callback: { id: 1 } } as any);
		return adapter.sendTo.mock.calls.at(-1)?.[2];
	}

	it("starts the mode on a robot that is idle", async () => {
		const adapter = createAdapter({ stateCode: 8 }); // Charging
		const answer = await send(adapter, "remote_start", { duid: "duid1" });

		expect(answer.result).toBe("accepted");
		expect(answer.launchMs).toBe(6000);
		expect(adapter.requestsHandler.command).toHaveBeenCalledWith(expect.anything(), "duid1", APP_RC_START, undefined, "1");
	});

	it("asks before interrupting a running clean, and does not start", async () => {
		const adapter = createAdapter({ stateCode: 5 }); // CLEAN
		const answer = await send(adapter, "remote_start", { duid: "duid1" });

		expect(answer.result).toBe("confirm");
		expect(adapter.requestsHandler.command).not.toHaveBeenCalled();
	});

	it("pauses first when the interruption was confirmed", async () => {
		// The app's own order, and its own 800 ms in between (A65:785931-785939).
		const adapter = createAdapter({ stateCode: 5 });
		const answer = await send(adapter, "remote_start", { duid: "duid1", confirmed: true });

		expect(answer.result).toBe("accepted");
		const sent = adapter.requestsHandler.command.mock.calls.map((call) => call[2]);
		expect(sent).toEqual(["app_pause", APP_RC_START]);
	});

	it("refuses while the firmware is updating", async () => {
		const adapter = createAdapter({ stateCode: 14 }); // UPDATING
		const answer = await send(adapter, "remote_start", { duid: "duid1", confirmed: true });

		expect(answer.result).toBe("refused");
		expect(adapter.requestsHandler.command).not.toHaveBeenCalled();
	});

	it("forwards one direction per message and nothing more", async () => {
		const adapter = createAdapter();
		const answer = await send(adapter, "remote_move", { duid: "duid1", direction: 6 });

		expect(answer).toEqual({ result: "accepted" });
		expect(adapter.requestsHandler.command).toHaveBeenCalledTimes(1);
		expect(adapter.requestsHandler.command).toHaveBeenCalledWith(expect.anything(), "duid1", APP_RC_MOVE, 6, "1");
	});

	it("rejects a direction the app cannot express", async () => {
		const adapter = createAdapter();
		const answer = await send(adapter, "remote_move", { duid: "duid1", direction: 42 });

		expect(answer.error).toMatch(/'direction' must be 0 to 8/);
		expect(adapter.requestsHandler.command).not.toHaveBeenCalled();
	});

	it("keeps the stop and the end apart", async () => {
		const adapter = createAdapter();
		await send(adapter, "remote_stop", { duid: "duid1" });
		await send(adapter, "remote_end", { duid: "duid1" });

		const sent = adapter.requestsHandler.command.mock.calls.map((call) => call[2]);
		expect(sent).toEqual([APP_RC_STOP, APP_RC_END]);
	});

	it("refuses every one of them on a robot that has no remote control folder", async () => {
		const adapter = createAdapter({ remote: false });

		for (const command of ["remote_start", "remote_move", "remote_stop", "remote_end"]) {
			const answer = await send(adapter, command, { duid: "duid1", direction: 1 });
			expect(answer.error).toMatch(/does not offer remote control/);
		}
		expect(adapter.requestsHandler.command).not.toHaveBeenCalled();
	});

	it("refuses a duid that could escape the object path", async () => {
		const adapter = createAdapter();
		const answer = await send(adapter, "remote_move", { duid: "../../system.adapter.admin.0", direction: 1 });

		expect(answer.error).toMatch(/valid 'duid'/);
	});
});
