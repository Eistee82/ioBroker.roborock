import { beforeAll, describe, expect, it, vi } from "vitest";
import { VACUUM_CONSTANTS } from "../../src/lib/features/vacuum/vacuumConstants";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

/**
 * Guards that every writable state is actually watched.
 *
 * Two writable states used to be created without a matching subscription:
 * `schedules.<timerId>.enabled` and `floors.<mapFlag>.load`. Both looked operable in the UI and
 * silently did nothing, because their writes never reached `onStateChange`.
 */

/** Mirrors the ioBroker pattern semantics: `*` matches any characters, dots included. */
function matchesPattern(stateId: string, pattern: string): boolean {
	const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
	return regex.test(stateId);
}

/** Asks the adapter for the very patterns onReady subscribes to. */
let subscriptionPatterns: (commandFolders: string[]) => string[];

function isWatched(stateId: string, commandFolders: string[] = ["commands"]): boolean {
	return subscriptionPatterns(commandFolders).some((pattern) => matchesPattern(stateId, pattern));
}

describe("state subscriptions cover every writable state", () => {
	beforeAll(async () => {
		const { Roborock } = await import("../../src/main");
		const adapter = Object.create(Roborock.prototype);
		subscriptionPatterns = (commandFolders: string[]): string[] => adapter.getSubscriptionPatterns(commandFolders);
	});

	it("watches the nested writable states that were silently unsubscribed", () => {
		expect(isWatched("Devices.duid1.schedules.1749184337669.enabled")).toBe(true);
		expect(isWatched("Devices.duid1.floors.0.load")).toBe(true);
	});

	it("watches the already working write surfaces", () => {
		expect(isWatched("Devices.duid1.commands.app_start")).toBe(true);
		expect(isWatched("Devices.duid1.resetConsumables.reset_main_brush")).toBe(true);
		expect(isWatched("Devices.duid1.programs.startProgram")).toBe(true);
		expect(isWatched("loginCode")).toBe(true);
		// a179 registers extra command groups; they are derived from the handlers at runtime.
		expect(isWatched("Devices.duid1.settings.some_setting", ["commands", "queries", "settings"])).toBe(true);
	});

	it("watches the room switches and floor metadata of every stored map", () => {
		expect(isWatched("Devices.duid1.floors.1.16")).toBe(true);
		expect(isWatched("Devices.duid1.floors.cleanCount")).toBe(true);
	});

	it("does not accidentally watch unrelated read-only trees", () => {
		expect(isWatched("Devices.duid1.cleaningInfo.records.0.startTime")).toBe(false);
		expect(isWatched("Devices.duid1.consumables.main_brush_work_time")).toBe(false);
	});

	it("keeps the deviceStatus mirrors read-only", () => {
		// deviceStatus only reports what the robot sent; the write surface is the commands folder.
		// A writable mirror here would be unwatched and therefore dead.
		for (const [key, common] of Object.entries(VACUUM_CONSTANTS.deviceStates as Record<string, { write?: boolean }>)) {
			expect(common.write, `deviceStatus.${key}`).not.toBe(true);
		}
	});
});
