import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import {
	STATUS_TOGGLES,
	V1ProbedCapabilityService,
	parseStatusToggleResponse,
	statusToggleFor,
	statusToggleGetterParams,
	toggleShape
} from "../../src/lib/features/vacuum/v1ProbedCapabilities";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * The five on/off settings that share one shape: a `get_*`/`set_*` pair around a `status` field.
 *
 * What each one *is* is proven in the table of `v1ProbedCapabilities.ts`, with the line of the
 * decompiled plugin beside it. This file pins the three things that can silently drift away from
 * that proof: the payload that goes on the wire, who is offered a switch at all, and whether the
 * label really exists in every language it claims to.
 */

/** The five getters, in the order the module lists them. */
const GETTERS = STATUS_TOGGLES.map((toggle) => toggle.getter);

describe("the shape of an on/off setting", () => {
	it("asks with a reading command, so the capability probe will accept it", () => {
		// `capabilityProbe.ts:107` refuses anything that is not a `get_*`/`app_get_*`, and refusing
		// counts as "the robot cannot do it" - a typo here would silently hide a switch for ever.
		for (const getter of GETTERS) {
			expect(getter).toMatch(/^(get_|app_get_)[a-z0-9_]+$/);
		}
	});

	it("pairs each getter with the setter of the same name", () => {
		for (const toggle of STATUS_TOGGLES) {
			expect(toggle.setter).toBe(toggle.getter.replace(/^get_/, "set_"));
		}
	});

	it("names every command exactly once", () => {
		const names = STATUS_TOGGLES.flatMap((toggle) => [toggle.getter, toggle.setter]);
		expect(new Set(names).size).toBe(names.length);
	});

	it("finds a toggle by either of its names", () => {
		expect(statusToggleFor("set_optimize_battery_status")?.getter).toBe("get_optimize_battery_status");
		expect(statusToggleFor("get_optimize_battery_status")?.setter).toBe("set_optimize_battery_status");
		expect(statusToggleFor("set_dnd_timer")).toBeUndefined();
	});

	/**
	 * The labels are Roborock's own, so they only reach a user in their language if Roborock really
	 * has them there. A key that exists in English alone would leave ten languages showing English
	 * without anybody noticing.
	 */
	it("uses label keys Roborock has in all eleven adapter languages", () => {
		const catalogue = JSON.parse(
			fs.readFileSync(path.join(__dirname, "../../lib/protocols/roborock_strings.json"), "utf8")
		) as Record<string, Record<string, string>>;
		const languages = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

		for (const toggle of STATUS_TOGGLES) {
			for (const key of [toggle.labelKey, toggle.descKey]) {
				const missing = languages.filter((language) => !catalogue[language]?.[key]);
				expect(missing, `${key} missing in ${missing.join(", ")}`).toEqual([]);
			}
		}
	});
});

/**
 * The seam to the tab.
 *
 * A switch the adapter publishes and the tab never lists is invisible: the object exists, the
 * panel simply has no entry for it, and nothing anywhere says so. That is the failure this
 * assertion exists for, and it can only be checked across the two projects.
 *
 * The check is deliberately a text search rather than an import. `robotSettings.ts` lives in the
 * tab's own npm project and its list is not exported; pulling the adapter's feature module into a
 * jsdom test would drag the whole device graph with it. A command name is a unique literal, so
 * finding it in the file is enough to prove it is listed - and if somebody moves the list somewhere
 * else, this fails and says to look.
 */
describe("the switches the tab knows about", () => {
	it("lists every switch the adapter can publish", () => {
		const source = fs.readFileSync(
			path.join(__dirname, "../../src-tab/src/settings/robotSettings.ts"),
			"utf8"
		);

		for (const toggle of STATUS_TOGGLES) {
			expect(source, `${toggle.setter} is not in the tab's KNOWN_SETTINGS`).toContain(`"${toggle.setter}"`);
		}
	});
});

/** A service with just enough adapter around it to build parameters. */
function createService(): V1ProbedCapabilityService {
	const deps = {
		adapter: {
			translationManager: { get: (_key: string, fallback: string) => fallback },
			setStateChanged: vi.fn().mockResolvedValue(undefined),
			rLog: vi.fn()
		},
		ensureState: vi.fn().mockResolvedValue(undefined),
		ensureFolder: vi.fn().mockResolvedValue(undefined)
	} as unknown as FeatureDependencies;
	return new V1ProbedCapabilityService(deps, "duid-test");
}

/**
 * The second wire shape.
 *
 * Six of the seven settings send `{status: 1|0}` and read `{"status":1}` back. The status light
 * sends `[1|0]` and reads `[1]`, and both sides of that were read in the app (A65:230545-230561,
 * A65:849705-849712, A65:849620-849627). A single discriminator in the table carries the
 * difference; these tests are what keep the two apart.
 */
describe("the status light, which speaks the other shape", () => {
	const led = STATUS_TOGGLES.find((entry) => entry.setter === "set_led_status")!;

	it("is the only entry that declares a shape", () => {
		// If a second one ever appears, this fails and the comment in the table gets read again.
		const withShape = STATUS_TOGGLES.filter((entry) => entry.shape !== undefined);
		expect(withShape.map((entry) => entry.setter)).toEqual(["set_led_status"]);
		expect(toggleShape(led)).toBe("bare-array");
	});

	it("every other entry falls back to the object shape without saying so", () => {
		for (const entry of STATUS_TOGGLES) {
			if (entry.setter === "set_led_status") continue;
			expect(toggleShape(entry), entry.setter).toBe("status-object");
		}
	});

	it("sends a bare array, not a status object", () => {
		const service = createService();
		expect(service.buildCommandParams("set_led_status", true)).toEqual({ method: "set_led_status", params: [1] });
		expect(service.buildCommandParams("set_led_status", false)).toEqual({ method: "set_led_status", params: [0] });
	});

	it("still asks with an empty array, like every other getter", () => {
		expect(createService().buildCommandParams("get_led_status", undefined)).toEqual({ method: "get_led_status", params: [] });
	});

	it("reads the bare array back", () => {
		expect(parseStatusToggleResponse([1], "bare-array")).toBe(true);
		expect(parseStatusToggleResponse([0], "bare-array")).toBe(false);
		expect(parseStatusToggleResponse({ data: [1] }, "bare-array")).toBe(true);
	});

	it("refuses a loose value, because that is how a robot says it knows no such method", () => {
		// Without the array, `unknown_method` would have to be read as a switch position.
		expect(parseStatusToggleResponse("unknown_method", "bare-array")).toBeNull();
		expect(parseStatusToggleResponse(1, "bare-array")).toBeNull();
		expect(parseStatusToggleResponse([], "bare-array")).toBeNull();
		expect(parseStatusToggleResponse([1, 0], "bare-array")).toBeNull();
	});

	it("does not read one shape as the other", () => {
		// The failure this discriminator exists to prevent: a light that reports itself off because
		// its answer was searched for a field it does not have.
		expect(parseStatusToggleResponse([1], "status-object")).toBeNull();
		expect(parseStatusToggleResponse({ status: 1 }, "bare-array")).toBeNull();
	});
});

describe("reading the position back", () => {
	it("reads 1 as on and 0 as off", () => {
		expect(parseStatusToggleResponse({ status: 1 })).toBe(true);
		expect(parseStatusToggleResponse({ status: 0 })).toBe(false);
	});

	it("reads the answer through the request layer's own wrapper", () => {
		expect(parseStatusToggleResponse({ data: { status: 1 } })).toBe(true);
	});

	it("reads anything other than 1 as off, exactly as the app does", () => {
		// A65:847523 and A65:859824-859826 both compute `1 == status`; a 2 is therefore not "on" in
		// the app either, and this must not be more generous than what was read.
		expect(parseStatusToggleResponse({ status: 2 })).toBe(false);
	});

	it("says nothing when the answer carries no status", () => {
		expect(parseStatusToggleResponse({})).toBeNull();
		expect(parseStatusToggleResponse("unknown_method")).toBeNull();
		expect(parseStatusToggleResponse(null)).toBeNull();
		expect(parseStatusToggleResponse([1])).toBeNull();
	});
});

describe("the payload that goes on the wire", () => {
	it.each(STATUS_TOGGLES.map((toggle) => [toggle.getter]))("sends %s exactly what its own wrapper sends", (getter) => {
		// Not "an empty array for all of them", which is what this used to assert. Five wrappers build
		// `new Array(0)` and two build `r1 = {}` (A65:228871 and A65:228523) - a generalisation from
		// the first five that the next two disproved. The expectation therefore comes from the entry.
		const toggle = STATUS_TOGGLES.find((entry) => entry.getter === getter)!;
		expect(createService().buildCommandParams(getter, undefined)).toEqual({ method: getter, params: statusToggleGetterParams(toggle) });
	});

	it("tells the two empty shapes apart, because a robot does", () => {
		expect(statusToggleGetterParams(STATUS_TOGGLES.find((entry) => entry.getter === "get_led_status")!)).toEqual([]);
		expect(statusToggleGetterParams(STATUS_TOGGLES.find((entry) => entry.getter === "get_pet_supplies_deep_clean_status")!)).toEqual({});
		expect(statusToggleGetterParams(STATUS_TOGGLES.find((entry) => entry.getter === "get_dirty_object_detect_status")!)).toEqual({});
	});

	it.each(STATUS_TOGGLES.map((toggle) => [toggle.setter, toggleShape(toggle)]))("sends %s a 1 or a 0 in its own shape (%s)", (setter, shape) => {
		// One assertion for both shapes rather than two lists: what must hold for every setting is
		// that it carries exactly the flag and nothing else, whichever wrapper it goes through.
		const wrap = (flag: number): unknown => (shape === "bare-array" ? [flag] : { status: flag });
		const service = createService();
		expect(service.buildCommandParams(setter, true)).toEqual({ method: setter, params: wrap(1) });
		expect(service.buildCommandParams(setter, false)).toEqual({ method: setter, params: wrap(0) });
	});

	it("reads the strings a text field produces as the positions they name", () => {
		// `"false"` and `"0"` are truthy strings in JavaScript. Taking them as "on" would switch
		// something on that the user switched off - and a script writing a state is a real caller.
		const service = createService();
		const statusOf = (value: unknown): unknown =>
			(service.buildCommandParams("set_optimize_battery_status", value).params as { status: number }).status;

		for (const off of [false, 0, "0", "false", "off", "no", "", "   ", null, undefined]) {
			expect(statusOf(off), `${JSON.stringify(off)} should be off`).toBe(0);
		}
		for (const on of [true, 1, "1", "true", "on"]) {
			expect(statusOf(on), `${JSON.stringify(on)} should be on`).toBe(1);
		}
	});
});

describe("who is offered one of these switches", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let sendRequest: ReturnType<typeof vi.fn>;

	/** Getters this robot pretends not to know. */
	let rejected: Set<string>;

	beforeEach(() => {
		rejected = new Set();
		sendRequest = vi.fn(async (_duid: string, method: string) => {
			if (rejected.has(method)) return "unknown_method";
			if (GETTERS.includes(method)) return { status: 1 };
			if (method === "get_fw_features") return [];
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
		public async runDetection(): Promise<void> {
			await this.detectProbedCapabilities();
		}
		public registeredCommands(): string[] {
			return [...Object.keys(this.commands), ...Object.values(this.extraCommandGroups).flatMap((group) => Object.keys(group))];
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
		/** Stands in for a model class that declared a command before the detection runs. */
		public declareOwnedCommand(name: string): void {
			this.addCommand(name, { type: "boolean", role: "switch.enable", def: false }, "settings");
		}
	}

	function createVacuum(): TestVacuum {
		return new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
	}

	it("offers every switch to a robot that answers every getter", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		for (const toggle of STATUS_TOGGLES) {
			expect(vacuum.folderOf(toggle.setter)).toBe("settings");
			expect(vacuum.folderOf(toggle.getter)).toBe("queries");
		}
	});

	it("offers exactly the one the test device really has", async () => {
		// The measured answers of the a65: one getter answers, four come back `unknown_method`
		// (`_appanalysis/geraetefaehigkeiten-1786790619395.json`). This is the case that matters,
		// because it is the only one anybody has hardware for.
		for (const getter of GETTERS) {
			if (getter !== "get_clean_follow_ground_material_status") rejected.add(getter);
		}

		const vacuum = createVacuum();
		await vacuum.runDetection();

		const registered = vacuum.registeredCommands();
		expect(registered).toContain("set_clean_follow_ground_material_status");
		for (const toggle of STATUS_TOGGLES) {
			if (toggle.setter === "set_clean_follow_ground_material_status") continue;
			expect(registered).not.toContain(toggle.setter);
			expect(registered).not.toContain(toggle.getter);
		}
	});

	it("offers nothing at all to a robot that answers none of them", async () => {
		for (const getter of GETTERS) rejected.add(getter);

		const vacuum = createVacuum();
		await vacuum.runDetection();

		for (const toggle of STATUS_TOGGLES) {
			expect(vacuum.folderOf(toggle.setter)).toBeNull();
		}
	});

	it("registers them as switches, not as buttons", async () => {
		// A boolean without a switch role is treated as a button by `main.ts`: it fires on `true`,
		// springs back a second later and never sends the off position. That is the fault nineteen
		// commands had, and it is invisible until somebody tries to switch one off.
		const vacuum = createVacuum();
		await vacuum.runDetection();

		for (const toggle of STATUS_TOGGLES) {
			const spec = vacuum.specOf("settings", toggle.setter);
			expect(spec.type).toBe("boolean");
			expect(spec.role).toBe("switch.enable");
			expect(spec.write).toBe(true);
		}
	});

	it("reads every switch it published, because none of them is in the status packet", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		// Twice per switch: once as the probe, once to seed the position.
		for (const getter of GETTERS) {
			expect(sendRequest.mock.calls.filter((call) => call[1] === getter).length).toBe(2);
		}
	});

	it("publishes the position onto the switch itself", async () => {
		const vacuum = createVacuum();
		await vacuum.runDetection();

		expect(adapterMock.setStateChanged).toHaveBeenCalledWith(
			"Devices.duid-test.settings.set_optimize_battery_status",
			{ val: true, ack: true }
		);
	});

	/**
	 * The two settings the app holds back while the robot is out.
	 *
	 * The app wraps both in `if (RSM.isRunning) → abort` before anything goes out (A65:858688,
	 * A65:858390, and the second dirt-detection call site A65:946370). What the firmware would do is
	 * therefore **not observable from the app**, which is exactly why the guard is copied rather than
	 * tried: a switch that quietly does nothing during a clean and reports success is the failure
	 * this project keeps removing.
	 *
	 * `RSM.isRunning = (1 != status.in_fresh_state)`, A65:223255-223259.
	 */
	describe("the two settings that are not sent while the robot is out", () => {
		const GUARDED = STATUS_TOGGLES.filter((toggle) => toggle.refuseWhileRunning).map((toggle) => toggle.setter);

		it("guards exactly the two the app guards", () => {
			expect(GUARDED).toEqual(["set_pet_supplies_deep_clean_status", "set_dirty_object_detect_status"]);
		});

		it.each(GUARDED)("refuses %s while the robot reports it is running", async (setter) => {
			const vacuum = createVacuum();
			await vacuum.runDetection();
			await vacuum.processStatus({ state: 5, in_fresh_state: 0 });

			await expect(vacuum.getCommandParams(setter, true)).rejects.toThrow(/not sent while the robot is cleaning/);
		});

		it.each(GUARDED)("sends %s once the robot is back", async (setter) => {
			const vacuum = createVacuum();
			await vacuum.runDetection();
			await vacuum.processStatus({ state: 5, in_fresh_state: 0 });
			await vacuum.processStatus({ state: 8, in_fresh_state: 1 });

			await expect(vacuum.getCommandParams(setter, true)).resolves.toEqual({ method: setter, params: { status: 1 } });
		});

		it("does not refuse on a robot that never reported the field", async () => {
			// Erring towards refusal here would disable both switches on every device that does not
			// carry `in_fresh_state` - a guess in the expensive direction.
			const vacuum = createVacuum();
			await vacuum.runDetection();
			await vacuum.processStatus({ state: 8 });

			await expect(vacuum.getCommandParams(GUARDED[0], true)).resolves.toBeTruthy();
		});

		it("leaves the reading side alone, and the unguarded switches too", async () => {
			const vacuum = createVacuum();
			await vacuum.runDetection();
			await vacuum.processStatus({ state: 5, in_fresh_state: 0 });

			await expect(vacuum.getCommandParams("get_pet_supplies_deep_clean_status", undefined)).resolves.toBeTruthy();
			await expect(vacuum.getCommandParams("set_optimize_battery_status", true)).resolves.toBeTruthy();
		});
	});

	it("does not ask about a switch a model class already declared", async () => {
		const vacuum = createVacuum();
		vacuum.declareOwnedCommand("set_gap_deep_clean_status");
		await vacuum.runDetection();

		expect(sendRequest.mock.calls.map((call) => call[1])).not.toContain("get_gap_deep_clean_status");
	});
});
