import { describe, expect, it } from "vitest";

import { ConnectionStatusManager } from "../../src/lib/connectionStatus";
import { http_api } from "../../src/lib/httpApi";
import { local_api } from "../../src/lib/localApi";
import {
	LOCAL_KEY_LENGTH,
	MANUAL_DEFAULT_CATEGORY,
	MANUAL_DEFAULT_MODEL,
	isLocalOnlyMode,
	parseManualDevices,
} from "../../src/lib/manualDevices";
import { MockAdapter } from "../../src/lib/mock/MockAdapter";
import { buildMqttClientId } from "../../src/lib/mqttApi";
import { socketHandler } from "../../src/lib/socketHandler";

// Fictitious values only - real duids and localKeys are device secrets.
const DUID_A = "0test0duid0aaaa";
const DUID_B = "0test0duid0bbbb";
const KEY_A = "aaaaaaaaaaaaaaaa"; // 16 chars, like the real format
const KEY_B = "bbbbbbbbbbbbbbbb";

function createAdapter(config: Record<string, unknown> = {}): any {
	const adapter = new MockAdapter() as any;
	adapter.config = { ...config };
	adapter.logLevel = "error";
	return adapter;
}

describe("manual device configuration", () => {
	it("parses a JSON string with all optional fields", () => {
		const raw = JSON.stringify([
			{ duid: DUID_A, localKey: KEY_A, ip: "192.0.2.10", pv: "L01", name: "Robot", model: "roborock.vacuum.a65", category: "robot.vacuum.cleaner", sn: "SN1" },
		]);

		const result = parseManualDevices(raw);

		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.devices).toHaveLength(1);
		expect(result.devices[0]).toEqual({
			duid: DUID_A,
			localKey: KEY_A,
			ip: "192.0.2.10",
			pv: "L01",
			name: "Robot",
			model: "roborock.vacuum.a65",
			category: "robot.vacuum.cleaner",
			sn: "SN1",
		});
	});

	it("applies defaults for the optional fields", () => {
		const result = parseManualDevices(`[{"duid":"${DUID_A}","localKey":"${KEY_A}"}]`);

		expect(result.errors).toEqual([]);
		expect(result.devices[0].pv).toBe("1.0");
		expect(result.devices[0].name).toBe(DUID_A);
		expect(result.devices[0].model).toBe(MANUAL_DEFAULT_MODEL);
		expect(result.devices[0].category).toBe(MANUAL_DEFAULT_CATEGORY);
		expect(result.devices[0].ip).toBeUndefined();
	});

	it("accepts an already parsed array", () => {
		const result = parseManualDevices([{ duid: DUID_A, local_key: KEY_A }]);
		expect(result.errors).toEqual([]);
		expect(result.devices[0].localKey).toBe(KEY_A);
	});

	it("treats empty and missing values as no devices", () => {
		expect(parseManualDevices("").devices).toEqual([]);
		expect(parseManualDevices("   ").devices).toEqual([]);
		expect(parseManualDevices(undefined).devices).toEqual([]);
		expect(parseManualDevices(null).devices).toEqual([]);
	});

	it("reports invalid JSON instead of throwing", () => {
		const result = parseManualDevices("[{duid:");
		expect(result.devices).toEqual([]);
		expect(result.errors[0]).toContain("not valid JSON");
	});

	it("rejects a non array payload", () => {
		const result = parseManualDevices(`{"duid":"${DUID_A}"}`);
		expect(result.devices).toEqual([]);
		expect(result.errors).toEqual(["Manual device list must be a JSON array."]);
	});

	it("collects entry level problems and keeps the valid entries", () => {
		const result = parseManualDevices(JSON.stringify([
			{ localKey: KEY_A },
			{ duid: DUID_A },
			{ duid: DUID_A, localKey: KEY_A },
			{ duid: DUID_A, localKey: KEY_B },
			{ duid: DUID_B, localKey: KEY_B, ip: "not-an-ip" },
			"nonsense",
		]));

		expect(result.devices.map((device) => device.duid)).toEqual([DUID_A, DUID_B]);
		expect(result.errors).toHaveLength(5);
		expect(result.errors.some((error) => error.includes("not an object"))).toBe(true);
		expect(result.errors.some((error) => error.includes("\"duid\" is missing"))).toBe(true);
		expect(result.errors.some((error) => error.includes("\"localKey\" is missing"))).toBe(true);
		expect(result.errors.some((error) => error.includes("duplicate duid"))).toBe(true);
		expect(result.errors.some((error) => error.includes("not a valid IP address"))).toBe(true);
		// The invalid IP must not be adopted silently.
		expect(result.devices[1].ip).toBeUndefined();
	});

	it("warns about a wrong localKey length without dropping the device", () => {
		const result = parseManualDevices(`[{"duid":"${DUID_A}","localKey":"tooshort"}]`);
		expect(result.devices).toHaveLength(1);
		expect(result.warnings[0]).toContain(`expected ${LOCAL_KEY_LENGTH}`);
	});

	it("never echoes the localKey in errors or warnings", () => {
		const result = parseManualDevices(JSON.stringify([
			{ duid: DUID_A, localKey: "shortkey" },
			{ duid: DUID_A, localKey: KEY_A },
			{ duid: DUID_B, localKey: KEY_B, ip: "999.1.1.1" },
		]));
		const messages = [...result.errors, ...result.warnings].join(" ");
		expect(messages).not.toContain(KEY_A);
		expect(messages).not.toContain(KEY_B);
		expect(messages).not.toContain("shortkey");
	});

	it("normalizes the protocol version and warns about unknown values", () => {
		expect(parseManualDevices(`[{"duid":"${DUID_A}","localKey":"${KEY_A}","pv":"b01"}]`).devices[0].pv).toBe("B01");

		const unknown = parseManualDevices(`[{"duid":"${DUID_A}","localKey":"${KEY_A}","pv":"X99"}]`);
		expect(unknown.devices[0].pv).toBe("1.0");
		expect(unknown.warnings[0]).toContain("unknown protocol version");
	});

	it("detects the local only mode", () => {
		expect(isLocalOnlyMode({ connectionMode: "local" })).toBe(true);
		expect(isLocalOnlyMode({ connectionMode: "cloud" })).toBe(false);
		expect(isLocalOnlyMode({})).toBe(false);
		expect(isLocalOnlyMode(undefined)).toBe(false);
	});
});

describe("http_api with manually configured devices", () => {
	function createApi(): http_api {
		const api = new http_api(createAdapter());
		api.applyManualDevices(parseManualDevices(JSON.stringify([
			{ duid: DUID_A, localKey: KEY_A, ip: "192.0.2.10", pv: "1.0", name: "Living room", model: "roborock.vacuum.a65" },
		])).devices);
		return api;
	}

	it("serves devices without any cloud session", () => {
		const api = createApi();

		expect(api.hasCloudSession()).toBe(false);
		const devices = api.getDevices();
		expect(devices).toHaveLength(1);
		expect(devices[0].duid).toBe(DUID_A);
		expect(devices[0].pv).toBe("1.0");
		expect(devices[0].online).toBe(true);
		expect(api.getMatchedLocalKeys().get(DUID_A)).toBe(KEY_A);
		expect(api.getRobotModel(DUID_A)).toBe("roborock.vacuum.a65");
		expect(api.getProductCategory(DUID_A)).toBe(MANUAL_DEFAULT_CATEGORY);
		expect(api.isSharedDevice(DUID_A)).toBe(false);
	});

	it("keeps cloud devices and lets a manual entry win for the same duid", () => {
		const api = createApi();
		(api as any).homeData = {
			rrHomeId: 1,
			products: [],
			rooms: [],
			receivedDevices: [],
			devices: [
				{ duid: DUID_A, localKey: "cloudkeycloudkey", productId: "p1", online: false, deviceStatus: {}, pv: "L01" },
				{ duid: DUID_B, localKey: KEY_B, productId: "p1", online: true, deviceStatus: {}, pv: "1.0" },
			],
		};

		const devices = api.getDevices();
		expect(devices.map((device) => device.duid).sort()).toEqual([DUID_A, DUID_B].sort());
		expect(devices.filter((device) => device.duid === DUID_A)).toHaveLength(1);
		expect(api.getMatchedLocalKeys().get(DUID_A)).toBe(KEY_A);
		expect(api.getMatchedLocalKeys().get(DUID_B)).toBe(KEY_B);
	});

	it("reports an existing cloud session once realApi and userData are set", () => {
		const api = createApi();
		(api as any).realApi = {};
		(api as any).userData = { token: "t", rriot: {} };
		expect(api.hasCloudSession()).toBe(true);
	});
});

describe("mqtt client id", () => {
	it("appends a random suffix so adapter and phone app can coexist", () => {
		expect(buildMqttClientId("abcd1234", "deadbeef")).toBe("abcd1234_deadbeef");

		const first = buildMqttClientId("abcd1234");
		const second = buildMqttClientId("abcd1234");
		expect(first.startsWith("abcd1234_")).toBe(true);
		expect(first).not.toBe("abcd1234");
		expect(first).not.toBe(second);
	});
});

describe("connection status states", () => {
	function createManager(config: Record<string, unknown>, local: boolean, cloud: boolean): { adapter: any; manager: ConnectionStatusManager } {
		const adapter = createAdapter(config);
		adapter.local_api = {
			isConnected: (duid: string) => local && duid === DUID_A,
			getIpForDuid: (duid: string) => (duid === DUID_A ? "192.0.2.10" : null),
		};
		adapter.mqtt_api = { isConnected: () => cloud };
		adapter.http_api = { getDevices: () => [{ duid: DUID_A }, { duid: DUID_B }] };
		return { adapter, manager: new ConnectionStatusManager(adapter) };
	}

	it("creates indicator states with the correct roles and types", async () => {
		const { adapter, manager } = createManager({}, true, true);
		await manager.ensureStates(DUID_A);

		const local = adapter.objects[`Devices.${DUID_A}.connection.local`];
		expect(local.common.type).toBe("boolean");
		expect(local.common.role).toBe("indicator.connected");
		expect(local.common.write).toBe(false);
		expect(adapter.objects[`Devices.${DUID_A}.connection.cloud`].common.role).toBe("indicator.connected");
		expect(adapter.objects[`Devices.${DUID_A}.connection.preferred`].common.role).toBe("text");
		expect(adapter.objects[`Devices.${DUID_A}.connection.ip`].common.role).toBe("info.ip");
		expect(adapter.objects[`Devices.${DUID_A}.connection`].type).toBe("folder");
	});

	it("prefers the local channel when the TCP session is up", async () => {
		const { adapter, manager } = createManager({}, true, true);
		await manager.update(DUID_A);

		expect(adapter.states[`Devices.${DUID_A}.connection.local`]).toBe(true);
		expect(adapter.states[`Devices.${DUID_A}.connection.cloud`]).toBe(true);
		expect(adapter.states[`Devices.${DUID_A}.connection.preferred`]).toBe("local");
		expect(adapter.states[`Devices.${DUID_A}.connection.ip`]).toBe("192.0.2.10");
	});

	it("falls back to the cloud channel and to none", async () => {
		const { adapter, manager } = createManager({}, false, true);
		await manager.update(DUID_A);
		expect(adapter.states[`Devices.${DUID_A}.connection.preferred`]).toBe("cloud");

		const offline = createManager({}, false, false);
		await offline.manager.update(DUID_A);
		expect(offline.adapter.states[`Devices.${DUID_A}.connection.preferred`]).toBe("none");
	});

	it("never reports a cloud channel in local only mode", async () => {
		const { adapter, manager } = createManager({ connectionMode: "local" }, true, true);
		expect(manager.isLocalOnly()).toBe(true);

		await manager.updateAll();

		expect(adapter.states[`Devices.${DUID_A}.connection.cloud`]).toBe(false);
		expect(adapter.states[`Devices.${DUID_A}.connection.preferred`]).toBe("local");
		expect(adapter.states[`Devices.${DUID_B}.connection.preferred`]).toBe("none");
		// Without the cloud nothing else would ever set info.connection.
		expect(adapter.states["info.connection"]).toBe(true);
	});

	it("leaves info.connection untouched when the cloud is in charge", async () => {
		const { adapter, manager } = createManager({ connectionMode: "cloud" }, true, true);
		await manager.updateAll();
		expect(adapter.states["info.connection"]).toBeUndefined();
	});
});

describe("local_api network binding", () => {
	it("is enabled by default and can be switched off", () => {
		expect(new local_api(createAdapter()).isUdpDiscoveryEnabled()).toBe(true);
		expect(new local_api(createAdapter({ udpDiscoveryEnabled: true })).isUdpDiscoveryEnabled()).toBe(true);
		expect(new local_api(createAdapter({ udpDiscoveryEnabled: false })).isUdpDiscoveryEnabled()).toBe(false);
	});

	it("resolves the configured bind address and ignores unusable values", () => {
		expect(new local_api(createAdapter({ udpBindAddress: "192.0.2.5" })).getUdpBindAddress()).toBe("192.0.2.5");
		expect(new local_api(createAdapter({ udpBindAddress: "  192.0.2.5 " })).getUdpBindAddress()).toBe("192.0.2.5");
		expect(new local_api(createAdapter()).getUdpBindAddress()).toBeUndefined();
		expect(new local_api(createAdapter({ udpBindAddress: "" })).getUdpBindAddress()).toBeUndefined();
		expect(new local_api(createAdapter({ udpBindAddress: "0.0.0.0" })).getUdpBindAddress()).toBeUndefined();
		expect(new local_api(createAdapter({ udpBindAddress: "eth0" })).getUdpBindAddress()).toBeUndefined();
	});

	it("does not open a discovery socket when discovery is disabled", async () => {
		const api = new local_api(createAdapter({ udpDiscoveryEnabled: false }));
		await api.startUdpDiscovery(5);
		expect((api as any).discoveryServer).toBeNull();
	});

	it("registers static endpoints and connects to them without discovery", async () => {
		const api = new local_api(createAdapter({ udpDiscoveryEnabled: false }));
		const connected: string[] = [];
		(api as any).initiateClient = async (duid: string) => {
			connected.push(duid);
		};

		await api.applyManualEndpoints([
			{ duid: DUID_A, ip: "192.0.2.10", pv: "1.0" },
			{ duid: DUID_B, pv: "L01" },
		]);

		expect(api.getIpForDuid(DUID_A)).toBe("192.0.2.10");
		expect(api.getLocalProtocolVersion(DUID_A)).toBe("1.0");
		expect(api.getIpForDuid(DUID_B)).toBeNull();
		expect(connected).toContain(DUID_A);
	});

	it("keeps a statically configured IP even when discovery reports another one", async () => {
		const api = new local_api(createAdapter());
		(api as any).initiateClient = async () => undefined;

		await api.applyManualEndpoints([{ duid: DUID_A, ip: "192.0.2.10", pv: "1.0" }]);
		const changed = api.updateLocalEndpoint(DUID_A, "192.0.2.99", "1.0", "udp");

		expect(changed).toBe(false);
		expect(api.getIpForDuid(DUID_A)).toBe("192.0.2.10");
	});
});

describe("network scan for the configuration page", () => {
	it("lists observed devices and marks whether a localKey is known", async () => {
		const adapter = createAdapter();
		adapter.local_api = {
			scanForDevices: async () => ({
				devices: [
					{ duid: DUID_A, ip: "192.0.2.10", version: "1.0", lastSeenAt: Date.now(), known: true },
					{ duid: DUID_B, ip: "192.0.2.11", version: "L01", lastSeenAt: Date.now(), known: false },
				],
				discoveryEnabled: true,
				hint: "",
			}),
		};

		const handler = new socketHandler(adapter);
		const response = await (handler as any).handleScanLocalDevices({ timeout: 1000 });

		expect(response.devices).toHaveLength(2);
		expect(response.result).toContain(DUID_A);
		expect(response.result).toContain("192.0.2.11");
		expect(response.result).toContain("localKey known");
		expect(response.result).toContain("localKey missing");
	});

	it("returns the network hint when nothing answered", async () => {
		const adapter = createAdapter();
		adapter.local_api = {
			scanForDevices: async () => ({ devices: [], discoveryEnabled: false, hint: "check the VLAN" }),
		};

		const handler = new socketHandler(adapter);
		const response = await (handler as any).handleScanLocalDevices();

		expect(response.devices).toEqual([]);
		expect(response.result).toContain("No devices found.");
		expect(response.result).toContain("check the VLAN");
		expect(response.result).toContain("Discovery is currently switched off.");
	});
});
