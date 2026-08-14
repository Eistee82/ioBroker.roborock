import { describe, expect, it } from "vitest";
import { listBindableInterfaces, resolveInterfaceAddress } from "../../src/lib/networkInterfaces";

/**
 * The UDP bind setting exists for hosts with several NICs - which is where ioBroker usually runs
 * in a container, and where the interface name is the stable answer while the address is not.
 * Entering `eth0` there used to be rejected with a warning, which quietly bound discovery to all
 * interfaces again: the very situation the setting was added to avoid.
 */

/** Shape of a typical container host: loopback plus one external NIC. */
const TYPICAL = {
	lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
	eth0: [
		{ address: "fe80::1", family: "IPv6", internal: false },
		{ address: "192.168.178.42", family: "IPv4", internal: false }
	]
};

describe("resolveInterfaceAddress", () => {
	it("resolves an interface name to its IPv4 address", () => {
		expect(resolveInterfaceAddress("eth0", TYPICAL)).toBe("192.168.178.42");
	});

	it("accepts the numeric family newer Node versions report", () => {
		// Node < 18 said "IPv4", Node >= 18 says 4; both still occur across supported versions.
		const numeric = { ens18: [{ address: "10.0.0.5", family: 4, internal: false }] };
		expect(resolveInterfaceAddress("ens18", numeric)).toBe("10.0.0.5");
	});

	it("prefers an external address over an internal one", () => {
		// Binding discovery to a loopback would find no robot at all.
		const mixed = {
			br0: [
				{ address: "127.0.0.2", family: "IPv4", internal: true },
				{ address: "10.1.1.9", family: "IPv4", internal: false }
			]
		};
		expect(resolveInterfaceAddress("br0", mixed)).toBe("10.1.1.9");
	});

	it("still answers for an interface that only has an internal address", () => {
		expect(resolveInterfaceAddress("lo", TYPICAL)).toBe("127.0.0.1");
	});

	it("answers undefined for an unknown name, so the caller can warn", () => {
		expect(resolveInterfaceAddress("wlan9", TYPICAL)).toBeUndefined();
	});

	it("answers undefined when the interface carries no IPv4 address", () => {
		const v6only = { eth1: [{ address: "fe80::2", family: "IPv6", internal: false }] };
		expect(resolveInterfaceAddress("eth1", v6only)).toBeUndefined();
	});

	it.each([[{}], [{ eth0: undefined }], [{ eth0: "nonsense" as never }], [{ eth0: [] }]])(
		"survives the malformed shape %s",
		(interfaces) => {
			expect(resolveInterfaceAddress("eth0", interfaces as never)).toBeUndefined();
		}
	);
});

describe("listBindableInterfaces", () => {
	it("names the external interfaces first, because those are the plausible choices", () => {
		expect(listBindableInterfaces(TYPICAL)).toEqual(["eth0", "lo"]);
	});

	it("leaves out interfaces without IPv4", () => {
		const withV6 = { ...TYPICAL, eth1: [{ address: "fe80::2", family: "IPv6", internal: false }] };
		expect(listBindableInterfaces(withV6)).not.toContain("eth1");
	});

	it("answers with an empty list rather than throwing", () => {
		expect(listBindableInterfaces({})).toEqual([]);
	});
});
