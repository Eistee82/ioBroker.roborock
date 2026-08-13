import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
	Adapter: class MockAdapter {}
}));

vi.mock("go2rtc-static", () => ({
	default: ""
}));

describe("deviceInfo.online", () => {
	it("is written exactly from HomeData", async () => {
		const { Roborock } = await import("../../src/main");
		const writes: Array<{ id: string; val: unknown }> = [];
		const ensured: Array<{ id: string; common: Record<string, unknown> }> = [];
		const deleted: string[] = [];
		const adapter = {
			ensureState: vi.fn(async (id: string, common: Record<string, unknown>) => {
				ensured.push({ id, common });
			}),
			setStateChanged: vi.fn(async (id: string, state: { val: unknown }) => {
				writes.push({ id, val: state.val });
			}),
			getObjectAsync: vi.fn(async (id: string) => (id.endsWith(".deviceInfo.localKey") ? { _id: id } : null)),
			delObjectAsync: vi.fn(async (id: string) => {
				deleted.push(id);
			}),
			rLog: vi.fn(),
			errorMessage: Roborock.prototype.errorMessage,
			formatRoborockDate: Roborock.prototype.formatRoborockDate,
			removeLegacyLocalKeyState: (Roborock.prototype as any).removeLegacyLocalKeyState,
		};

		await Roborock.prototype.updateDeviceInfo.call(adapter as any, "duid-1", [
			{ duid: "duid-1", online: false, name: "Test Device", localKey: "aaaaaaaaaaaaaaaa", activeTime: 1775248456, createTime: 1775200000 } as any,
		]);

		expect(writes.find((entry) => entry.id === "Devices.duid-1.deviceInfo.online")?.val).toBe(false);
		expect(ensured.find((entry) => entry.id === "Devices.duid-1.deviceInfo.activeTime")?.common?.name).toBe("Last Activity");
		expect(ensured.find((entry) => entry.id === "Devices.duid-1.deviceInfo.createTime")?.common?.name).toBe("Created At");
		// The localKey is a device secret and must never surface as a state.
		expect(writes.some((entry) => entry.id === "Devices.duid-1.deviceInfo.localKey")).toBe(false);
		expect(ensured.some((entry) => entry.id === "Devices.duid-1.deviceInfo.localKey")).toBe(false);
		expect(deleted).toEqual(["Devices.duid-1.deviceInfo.localKey"]);
	});
});
