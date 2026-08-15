import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../src/lib/features/baseDeviceFeatures";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import { STATUS_FIELD_TOGGLES, V1ProbedCapabilityService, statusFieldToggleFor } from "../../src/lib/features/vacuum/v1ProbedCapabilities";

vi.mock("../../src/lib/map/MapManager", () => ({
	MapManager: class {
		processMap = vi.fn().mockResolvedValue({ mapBase64: "" });
	}
}));

/**
 * The on/off settings that have no getter, and are unlocked by the status packet instead.
 *
 * ## Why this file is separate from `status_toggles.test.ts`
 *
 * Those seven are unlocked by asking the robot a `get_*` and reading `unknown_method` as a no.
 * These have nothing to ask. The capability answer is whether the field turns up in `get_status`,
 * which means the decision is made on a different schedule (every poll, not once at start-up) and
 * has a different failure mode. Testing them in one file would mean a harness that does both.
 *
 * ## What the test device says, and why it is the interesting case
 *
 * The a65 does **not** send `corner_clean_mode`: its status packet has 51 fields and that is not
 * one of them, measured twice nearly five hours apart
 * (`_appanalysis/geraetefaehigkeiten-1786790619395.json`, `…-1786807834553.json`). Independently it
 * does not announce the feature either - bit 31 of `new_feature_info_str` is clear, and that is the
 * bit the app's own `isCornerCleanModeSupported` reads (A65:236944-236972).
 *
 * So the first test below is the one that matters: **the reference robot must be offered nothing.**
 * A regression that unlocks the switch unconditionally would put a dead control on every device -
 * the exact fault this mechanism exists to prevent, and the reason the setting was held back until
 * a way to ask was found.
 */

/** Status packet of the test device, shortened to the fields this file cares about. */
const A65_STATUS = Object.freeze({
	state: 2,
	battery: 100,
	fan_power: 101,
	water_box_mode: 203,
	mop_mode: 300,
	lab_status: 3
});

describe("the settings the robot carries in its status packet", () => {
	let adapterMock: any;
	let depsMock: FeatureDependencies;
	let setStateChanged: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setStateChanged = vi.fn().mockResolvedValue(undefined);
		adapterMock = {
			namespace: "roborock.0",
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() },
			setStateChanged,
			setState: vi.fn().mockResolvedValue(undefined),
			getObjectAsync: vi.fn().mockResolvedValue({ common: {} }),
			getStateAsync: vi.fn().mockResolvedValue(null),
			requestsHandler: { sendRequest: vi.fn().mockResolvedValue({}) },
			rLog: vi.fn(),
			errorMessage: (e: unknown) => String(e),
			translationManager: { get: (_key: string, fallback: string) => fallback },
			// `processStatus` reaches for this directly when it publishes the cleaning mode tab.
			translations: {},
			http_api: { getRobotModel: vi.fn().mockReturnValue("roborock.vacuum.a65"), getDevices: vi.fn().mockReturnValue([]) }
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
		/** Hands a status packet to the detection the way `processStatus` does. */
		public async feedStatus(status: Record<string, unknown>): Promise<void> {
			await (this as any).applyStatusFieldToggles(status);
		}
		/** Stands in for a model class that declared the setter before any status arrived. */
		public declareCommand(name: string, group: string): void {
			this.addCommand(name, { type: "boolean", role: "switch.enable", def: false }, group);
		}
		/** Every command name registered in any folder. */
		public registeredCommands(): string[] {
			return [...Object.keys(this.commands), ...Object.values(this.extraCommandGroups).flatMap((group) => Object.keys(group))];
		}
		/** The spec a command was registered with, whichever folder it landed in. */
		public specOf(name: string): any {
			if (this.commands[name]) return this.commands[name];
			for (const group of Object.values(this.extraCommandGroups)) {
				if (group[name]) return group[name];
			}
			return undefined;
		}
	}

	function createVacuum(): TestVacuum {
		return new TestVacuum(depsMock, "duid-test", "roborock.vacuum.a65", { staticFeatures: [] });
	}

	/** The one entry, so the tests read as prose rather than as index lookups. */
	const CORNER = STATUS_FIELD_TOGGLES[0];

	it("offers nothing to the test device, which does not report the field", async () => {
		const vacuum = createVacuum();
		await vacuum.feedStatus({ ...A65_STATUS });

		expect(vacuum.registeredCommands()).not.toContain(CORNER.setter);
		expect(setStateChanged).not.toHaveBeenCalled();
	});

	it("offers the switch to a robot that does report the field", async () => {
		const vacuum = createVacuum();
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 0 });

		expect(vacuum.registeredCommands()).toContain(CORNER.setter);
		expect(vacuum.specOf(CORNER.setter)).toMatchObject({ type: "boolean", role: "switch.enable", write: true });
	});

	it("registers no read button, because there is nothing to read", async () => {
		const vacuum = createVacuum();
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 1 });

		// The seven probed toggles each get a `Read …` button beside them. These must not: the value
		// arrives with the next status packet whether anyone presses anything or not.
		expect(vacuum.registeredCommands().filter((name) => name.includes("corner_clean"))).toEqual([CORNER.setter]);
	});

	it("mirrors the reported position onto the switch", async () => {
		const vacuum = createVacuum();
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 1 });

		expect(setStateChanged).toHaveBeenCalledWith(
			`Devices.duid-test.settings.${CORNER.setter}`,
			{ val: true, ack: true }
		);
	});

	it("follows the robot when it clears the flag by itself", async () => {
		// Roborock calls this a single-use mode, so the robot is expected to drop it after a run. A
		// switch that only ever learnt the first value would keep claiming "on".
		const vacuum = createVacuum();
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 1 });
		setStateChanged.mockClear();
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 0 });

		expect(setStateChanged).toHaveBeenCalledWith(
			`Devices.duid-test.settings.${CORNER.setter}`,
			{ val: false, ack: true }
		);
	});

	it("registers the switch once, however many packets arrive", async () => {
		const vacuum = createVacuum();
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 1 });
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 0 });
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 1 });

		expect(vacuum.registeredCommands().filter((name) => name === CORNER.setter)).toHaveLength(1);
	});

	it("leaves the command alone when a model class already owns it", async () => {
		// Same guard as the probed toggles: one command must not end up with two owners in two
		// folders. The pre-declared spec has to survive untouched.
		const vacuum = createVacuum();
		vacuum.declareCommand(CORNER.setter, "commands");
		await vacuum.feedStatus({ ...A65_STATUS, [CORNER.statusField]: 1 });

		expect(vacuum.specOf(CORNER.setter)).not.toHaveProperty("desc");
		expect(setStateChanged).not.toHaveBeenCalled();
	});

	it("is reached from processStatus, not only from the test hook", async () => {
		// The detection is worthless if nothing calls it on a real poll. This is the same path the
		// adapter takes; everything else in `processStatus` is allowed to do whatever it does.
		const vacuum = createVacuum();
		await vacuum.processStatus({ ...A65_STATUS, [CORNER.statusField]: 1 });

		expect(vacuum.registeredCommands()).toContain(CORNER.setter);
	});
});

describe("what goes on the wire for a status-carried setting", () => {
	let service: V1ProbedCapabilityService;

	beforeEach(() => {
		const adapter: any = {
			setStateChanged: vi.fn().mockResolvedValue(undefined),
			rLog: vi.fn(),
			translationManager: { get: (_key: string, fallback: string) => fallback }
		};
		service = new V1ProbedCapabilityService({ adapter } as unknown as FeatureDependencies, "duid-test");
	});

	const CORNER = STATUS_FIELD_TOGGLES[0];

	it("sends the object the app's own wrapper composes", () => {
		// A65:230201-230212 builds `{status: a0 ? 1 : 0}` inside the wrapper, so the payload is the
		// wrapper's output and not its argument.
		service.registerStatusFieldToggle(CORNER, () => undefined);
		expect(service.buildCommandParams(CORNER.setter, true)).toEqual({ method: CORNER.setter, params: { status: 1 } });
		expect(service.buildCommandParams(CORNER.setter, false)).toEqual({ method: CORNER.setter, params: { status: 0 } });
	});

	it("reads the strings a text field produces the way the rest of the module does", () => {
		service.registerStatusFieldToggle(CORNER, () => undefined);
		expect(service.buildCommandParams(CORNER.setter, "false")).toEqual({ method: CORNER.setter, params: { status: 0 } });
		expect(service.buildCommandParams(CORNER.setter, "0")).toEqual({ method: CORNER.setter, params: { status: 0 } });
		expect(service.buildCommandParams(CORNER.setter, "on")).toEqual({ method: CORNER.setter, params: { status: 1 } });
	});

	it("claims the setter so the feature class routes it here", () => {
		expect(service.handles(CORNER.setter)).toBe(false);
		service.registerStatusFieldToggle(CORNER, () => undefined);
		expect(service.handles(CORNER.setter)).toBe(true);
	});

	it("finds a toggle by its command and by its status field", () => {
		expect(statusFieldToggleFor(CORNER.setter)).toBe(CORNER);
		expect(statusFieldToggleFor(CORNER.statusField)).toBe(CORNER);
		expect(statusFieldToggleFor("set_led_status")).toBeUndefined();
	});

	it("labels the switch from Roborock's own catalogue, in all eleven adapter languages", async () => {
		// The wording travels through `common.name`/`desc`, so no new admin i18n key is needed - but
		// only as long as the key really is in the catalogue for every language the adapter ships.
		const strings = (await import("../../lib/protocols/roborock_strings.json")).default as Record<string, Record<string, string>>;
		const languages = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

		for (const toggle of STATUS_FIELD_TOGGLES) {
			for (const language of languages) {
				expect(strings[language]?.[toggle.labelKey], `${toggle.labelKey} in ${language}`).toBeTruthy();
				expect(strings[language]?.[toggle.descKey], `${toggle.descKey} in ${language}`).toBeTruthy();
			}
		}
	});
});
