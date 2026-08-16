import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { BaseDeviceFeatures } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { UNKNOWN_METHOD_ANSWER, isUnknownMethodAnswer } from "../../src/lib/commandFeedback";

/**
 * What happens to a control the robot says it does not have.
 *
 * ## The case this comes from
 *
 * The reference device reports `dry_status`, so the adapter offered it `app_start_mop_drying`. The
 * robot answered `unknown_method` - every press, forever, because the command does not exist in its
 * firmware at all: the name has zero hits in the 44 MB control-plugin decompilate and zero in
 * `strings.txt` (`_appanalysis/32-presets.md` §8).
 *
 * The answer check made that visible, which is what it is for. What was missing is the consequence:
 * a control that can never work has to go, or it is a dead switch with a red mark beside it - the
 * fault this project has been removing since the eight dead switches of round 2.
 *
 * ## Why the tests below are mostly about what is *not* removed
 *
 * Removing a control is the destructive direction, so the narrow test matters more than the wide
 * one. `classifyRobotAnswer` reads **any** bare string as a refusal, on purpose; this may only act
 * on the one literal that means "I do not have this method". A robot that answers `"busy"` keeps
 * everything it has.
 */

/** Minimal feature class: it registers a few commands and nothing else. */
class TestFeatures extends BaseDeviceFeatures {
	public async setupProtocolFeatures(): Promise<void> {
		this.commands = {};
		this.extraCommandGroups = {};
	}
	public declare(name: string, group = "commands"): void {
		this.addCommand(name, { type: "boolean", role: "button", def: false }, group);
	}
	public getCommonConsumable(): undefined {
		return undefined;
	}
	public isResetableConsumable(): boolean {
		return false;
	}
	public getCommonDeviceStates(): undefined {
		return undefined;
	}
	public getCommonCleaningRecords(): undefined {
		return undefined;
	}
	public getFirmwareFeatureName(id: string | number): string {
		return String(id);
	}
	public getCommonCleaningInfo(): undefined {
		return undefined;
	}
	protected getDynamicFeatures(): Set<Feature> {
		return new Set();
	}
	public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
		return false;
	}
}

describe("recognising the one answer that means 'I do not have this'", () => {
	it("accepts the literal, bare and inside a data envelope", () => {
		expect(isUnknownMethodAnswer(UNKNOWN_METHOD_ANSWER)).toBe(true);
		expect(isUnknownMethodAnswer({ data: UNKNOWN_METHOD_ANSWER })).toBe(true);
	});

	it("rejects every other refusal, however plausible", () => {
		// All of these are refusals to `classifyRobotAnswer` and none of them says the method is
		// missing. Taking a control away on one of them would be a guess with a consequence.
		expect(isUnknownMethodAnswer("busy")).toBe(false);
		expect(isUnknownMethodAnswer("in_cleaning")).toBe(false);
		expect(isUnknownMethodAnswer(["retry"])).toBe(false);
		expect(isUnknownMethodAnswer(["unknown_method"])).toBe(false);
		expect(isUnknownMethodAnswer(["ok"])).toBe(false);
		expect(isUnknownMethodAnswer(null)).toBe(false);
		expect(isUnknownMethodAnswer(undefined)).toBe(false);
		expect(isUnknownMethodAnswer({ status: 1 })).toBe(false);
	});
});

describe("retiring a command the robot rejected as unknown", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let features: TestFeatures;

	beforeEach(async () => {
		adapterMock = {
			namespace: "roborock.0",
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() },
			rLog: vi.fn(),
			errorMessage: (e: unknown) => String(e),
			delObjectAsync: vi.fn().mockResolvedValue(undefined),
			translations: {}
		};
		depsMock = {
			adapter: adapterMock,
			http_api: {},
			ensureState: vi.fn().mockResolvedValue(undefined),
			ensureFolder: vi.fn().mockResolvedValue(undefined),
			log: adapterMock.log,
			config: { staticFeatures: [] }
		} as unknown as FeatureDependencies;

		features = new TestFeatures(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
		await features.setupProtocolFeatures();
		features.declare("app_start_mop_drying");
		features.declare("app_stop_mop_drying");
		features.declare("get_dust_collection_mode", "queries");
	});

	it("removes the spec, so nothing can build the request again", async () => {
		expect(await features.retireUnsupportedCommand("app_start_mop_drying")).toBe("commands");
		expect(features.getCommandSpec("commands", "app_start_mop_drying")).toBeUndefined();
	});

	it("removes the object, so the tab stops offering it", async () => {
		// The dock panel builds itself from the objects that exist. A spec removed without its object
		// only moves the failure: the button stays, and the next press says `Unregistered command`.
		await features.retireUnsupportedCommand("app_start_mop_drying");
		expect(adapterMock.delObjectAsync).toHaveBeenCalledWith("Devices.duid-test.commands.app_start_mop_drying");
	});

	it("leaves every other command alone", async () => {
		await features.retireUnsupportedCommand("app_start_mop_drying");

		expect(features.getCommandSpec("commands", "app_stop_mop_drying")).toBeDefined();
		expect(features.getCommandSpec("queries", "get_dust_collection_mode")).toBeDefined();
		expect(adapterMock.delObjectAsync).toHaveBeenCalledTimes(1);
	});

	it("finds a command in an extra folder too", async () => {
		expect(await features.retireUnsupportedCommand("get_dust_collection_mode")).toBe("queries");
		expect(adapterMock.delObjectAsync).toHaveBeenCalledWith("Devices.duid-test.queries.get_dust_collection_mode");
	});

	it("reports that there was nothing to retire", async () => {
		expect(await features.retireUnsupportedCommand("app_start_wash")).toBeNull();
		expect(adapterMock.delObjectAsync).not.toHaveBeenCalled();
	});

	it("still drops the spec when the object cannot be deleted", async () => {
		// The spec is what decides whether a request can be built at all. A leftover object is
		// cosmetic next to a command that keeps going out.
		adapterMock.delObjectAsync.mockRejectedValueOnce(new Error("object database is away"));

		expect(await features.retireUnsupportedCommand("app_start_mop_drying")).toBe("commands");
		expect(features.getCommandSpec("commands", "app_start_mop_drying")).toBeUndefined();
	});

	it("says in the log why the control disappeared", async () => {
		// A control that vanishes without a word is its own kind of silent failure.
		await features.retireUnsupportedCommand("app_start_mop_drying");

		const messages = adapterMock.rLog.mock.calls.map((call: unknown[]) => String(call[5]));
		expect(messages.some((message: string) => message.includes("app_start_mop_drying") && message.includes(UNKNOWN_METHOD_ANSWER))).toBe(true);
	});
});
