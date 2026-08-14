/**
 * Turning a network interface name into an address to bind to.
 *
 * The UDP bind address exists because discovery misbehaves on hosts with several NICs, which is
 * exactly where people run ioBroker in a container. On such a host the obvious thing to enter is
 * `eth0`, not an IP: the interface name is stable while the address can change with the lease.
 * Rejecting the name and silently binding to all interfaces defeats the purpose of the setting.
 */

import { networkInterfaces } from "node:os";

/** What `os.networkInterfaces()` reports per entry, reduced to what matters here. */
type InterfaceEntry = {
	address?: unknown;
	family?: unknown;
	internal?: unknown;
};

/**
 * Whether an entry describes IPv4.
 *
 * Node reported `family` as the string "IPv4" up to v18 and as the number 4 from then on, and
 * both shapes are still in the wild across the Node versions ioBroker runs on.
 * @param entry One entry of `os.networkInterfaces()`.
 * @returns True for IPv4 entries.
 */
function isIPv4(entry: InterfaceEntry): boolean {
	return entry.family === "IPv4" || entry.family === 4;
}

/**
 * Resolves a network interface name to the address a socket can bind to.
 *
 * @param name Interface name as configured, e.g. `eth0`, `ens18`, `enp3s0`.
 * @param interfaces Injectable for tests; defaults to the real interfaces.
 * @returns The IPv4 address of that interface, or `undefined` when there is none. External
 *          addresses win over internal ones: binding discovery to a loopback would find nothing.
 */
export function resolveInterfaceAddress(
	name: string,
	interfaces: NodeJS.Dict<InterfaceEntry[]> = networkInterfaces()
): string | undefined {
	const entries = interfaces[name];
	if (!Array.isArray(entries)) return undefined;

	const usable = entries.filter((entry) => isIPv4(entry) && typeof entry.address === "string" && entry.address.length > 0);
	const external = usable.find((entry) => entry.internal !== true);
	const chosen = external ?? usable[0];
	return chosen ? (chosen.address as string) : undefined;
}

/**
 * Lists the interface names that carry an IPv4 address, for a helpful log line.
 *
 * @param interfaces Injectable for tests; defaults to the real interfaces.
 * @returns Interface names, external ones first, so the log names the plausible choices first.
 */
export function listBindableInterfaces(interfaces: NodeJS.Dict<InterfaceEntry[]> = networkInterfaces()): string[] {
	const external: string[] = [];
	const internal: string[] = [];

	for (const [name, entries] of Object.entries(interfaces)) {
		if (!Array.isArray(entries)) continue;
		const ipv4 = entries.filter((entry) => isIPv4(entry));
		if (!ipv4.length) continue;
		if (ipv4.some((entry) => entry.internal !== true)) {
			external.push(name);
		} else {
			internal.push(name);
		}
	}

	return [...external, ...internal];
}
