import { describe, expect, it, vi } from "vitest";
import { Q10ShadowDataService } from "../../src/lib/features/vacuum/b01/q10/Q10ShadowDataService";

/**
 * Regression guard for a switch that moved and did nothing.
 *
 * A Q10 publishes its schedules as `schedules.<id>.enabled`, and that state used to be created
 * writable. `Devices.*.schedules.*` is subscribed, so a write did **not** fall through - it reached
 * `handleScheduleToggle` in `main.ts` and sent `upd_timer`, a V1 JSON-RPC command. A Q10 is a B01
 * device and speaks Tuya data points; it never sees that method. Worse than a dropped write, because
 * something was sent and the log looked busy.
 *
 * The Tuya counterpart is not established (see the note on `applyQ10TimersFromDpResult`), so the
 * state is read-only and says so through its role. This test pins both.
 */

/** One row as DP 69 answers it: `[id, "on"|"off", [cron, …]]`. */
const DP69_ANSWER = [
	["1749184337669", "on", ["0 14 * * 5", ["start_clean", []], 1234567890]],
	["1749184337670", "off", ["0 8 * * 1", ["start_clean", []], 1234567891]]
];

interface EnsuredState {
	id: string;
	common: Partial<ioBroker.StateCommon>;
}

function createService(): { service: Q10ShadowDataService; ensured: EnsuredState[] } {
	const ensured: EnsuredState[] = [];

	const deps = {
		adapter: {
			setStateChanged: vi.fn().mockResolvedValue(undefined),
			rLog: vi.fn(),
			errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e))
		},
		ensureState: vi.fn(async (id: string, common: Partial<ioBroker.StateCommon>) => {
			ensured.push({ id, common });
		}),
		ensureFolder: vi.fn().mockResolvedValue(undefined)
	} as unknown as ConstructorParameters<typeof Q10ShadowDataService>[0];

	const host = {
		applyCleanRecordList: vi.fn(),
		applyConsumables: vi.fn(),
		applyStatusSnapshot: vi.fn(),
		cleanupFloorMetadata: vi.fn(),
		processStatusProperty: vi.fn(),
		requestTimerRefresh: vi.fn()
	} as unknown as ConstructorParameters<typeof Q10ShadowDataService>[2];

	return { service: new Q10ShadowDataService(deps, "duid1", host), ensured };
}

function enabledStates(ensured: EnsuredState[]): EnsuredState[] {
	return ensured.filter((entry) => entry.id.endsWith(".enabled"));
}

describe("Q10 schedule switch is not writable", () => {
	it("publishes both schedules and their cron", async () => {
		const { service, ensured } = createService();

		await service.applyQ10TimersFromDpResult(DP69_ANSWER);

		expect(ensured.map((entry) => entry.id)).toEqual([
			"Devices.duid1.schedules.1749184337669.enabled",
			"Devices.duid1.schedules.1749184337669.cron",
			"Devices.duid1.schedules.1749184337670.enabled",
			"Devices.duid1.schedules.1749184337670.cron"
		]);
	});

	it("never declares enabled writable", async () => {
		const { service, ensured } = createService();

		await service.applyQ10TimersFromDpResult(DP69_ANSWER);

		const switches = enabledStates(ensured);
		expect(switches).toHaveLength(2);
		for (const entry of switches) {
			// A write here would reach handleScheduleToggle and send upd_timer to a Tuya device.
			expect(entry.common.write).toBe(false);
		}
	});

	it("carries the role of something that can only be read", async () => {
		const { service, ensured } = createService();

		await service.applyQ10TimersFromDpResult(DP69_ANSWER);

		for (const entry of enabledStates(ensured)) {
			// `switch` looks operable in every UI that renders by role, so it would keep the lie
			// alive even with write:false.
			expect(entry.common.role).toBe("indicator");
			expect(entry.common.role).not.toBe("switch");
		}
	});

	it("keeps cron read-only as well", async () => {
		const { service, ensured } = createService();

		await service.applyQ10TimersFromDpResult(DP69_ANSWER);

		for (const entry of ensured.filter((e) => e.id.endsWith(".cron"))) {
			expect(entry.common.write).toBe(false);
		}
	});

	it("ignores an answer that is not a list of rows", async () => {
		const { service, ensured } = createService();

		await service.applyQ10TimersFromDpResult({ result: "unknown" });
		await service.applyQ10TimersFromDpResult(["not-a-row", ["too", "short"]]);

		expect(ensured).toEqual([]);
	});
});
