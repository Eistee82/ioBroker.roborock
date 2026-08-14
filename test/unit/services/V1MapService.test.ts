import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureDependencies } from "../../../src/lib/features/baseDeviceFeatures";
import { V1MapService } from "../../../src/lib/features/vacuum/services/V1MapService";

const DUID = "test_duid";
const LEGACY_STATE_ID = `Devices.${DUID}.floors.cleanCount`;

type MapServiceEnv = {
	service: V1MapService;
	adapter: any;
	deps: FeatureDependencies;
};

function createEnv(options: { legacyStateExists?: boolean } = {}): MapServiceEnv {
	const adapter: any = {
		rLog: vi.fn(),
		log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
		errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e)),
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		ensureState: vi.fn().mockResolvedValue(undefined),
		setStateChanged: vi.fn().mockResolvedValue(undefined),
		extendObject: vi.fn().mockResolvedValue(undefined),
		getObjectAsync: vi.fn(async (id: string) =>
			options.legacyStateExists && id === LEGACY_STATE_ID ? { _id: id, common: {}, type: "state" } : null
		),
		delObjectAsync: vi.fn().mockResolvedValue(undefined),
		getDeviceProtocolVersion: vi.fn().mockResolvedValue("1.0"),
		http_api: { getRobotModel: (): string => "roborock.vacuum.a27" },
		requestsHandler: { sendRequest: vi.fn().mockResolvedValue([[16, 1, "1"]]) }
	};

	const deps = {
		adapter,
		log: adapter.log,
		ensureFolder: adapter.ensureFolder,
		ensureState: adapter.ensureState
	} as unknown as FeatureDependencies;

	return { service: new V1MapService(deps, DUID), adapter, deps };
}

describe("V1MapService: legacy floors.cleanCount", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("never creates the state again", async () => {
		const { service, adapter } = createEnv();

		await service.updateRoomMapping();

		const createdIds = adapter.ensureState.mock.calls.map((call: unknown[]) => call[0]);
		expect(createdIds).not.toContain(LEGACY_STATE_ID);
	});

	it("removes the leftover state from older adapter versions on the first run", async () => {
		const { service, adapter } = createEnv({ legacyStateExists: true });

		await service.updateRoomMapping();

		expect(adapter.delObjectAsync).toHaveBeenCalledWith(LEGACY_STATE_ID);
	});

	it("checks and deletes only once per adapter run", async () => {
		const { service, adapter } = createEnv({ legacyStateExists: true });

		await service.updateRoomMapping();
		await service.updateRoomMapping();
		await service.updateRoomMapping();

		expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
		expect(adapter.getObjectAsync.mock.calls.filter((call: unknown[]) => call[0] === LEGACY_STATE_ID)).toHaveLength(1);
	});

	it("deletes nothing when the state was never created", async () => {
		const { service, adapter } = createEnv();

		await service.updateRoomMapping();

		expect(adapter.delObjectAsync).not.toHaveBeenCalled();
	});

	it("still cleans up when the room mapping request fails", async () => {
		const { service, adapter } = createEnv({ legacyStateExists: true });
		adapter.requestsHandler.sendRequest.mockRejectedValue(new Error("device unreachable"));

		await expect(service.updateRoomMapping()).resolves.toBe(false);
		expect(adapter.delObjectAsync).toHaveBeenCalledWith(LEGACY_STATE_ID);
	});

	it("survives a failing deletion without throwing", async () => {
		const { service, adapter } = createEnv({ legacyStateExists: true });
		adapter.delObjectAsync.mockRejectedValue(new Error("object db down"));

		await expect(service.updateRoomMapping()).resolves.not.toThrow();
	});
});
