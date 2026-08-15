import { describe, expect, it, vi } from "vitest";

import { CapabilityProbe, classifyProbeAnswer } from "../../src/lib/features/capabilityProbe";

/**
 * Asking the robot what it can, instead of deciding it from its model name.
 *
 * The rule under test is asymmetric on purpose, and the asymmetry is the whole point: only an
 * array or an object counts as "the robot has this". Everything else - a string, a number, `null`,
 * a transport failure - counts as "it does not.
 *
 * That is because the evidence is **one device with one firmware**
 * (`_appanalysis/19-geraetefaehigkeiten.md`): 43 answers, all arrays or objects; 23 rejections, all
 * exactly `"unknown_method"`; no bare string among the successes and nothing but strings among the
 * rejections. A robot that rejects differently is not covered, so the rule errs towards leaving it
 * as it is today - a function may be missing, but no control exists that writes into the void.
 */

/** Builds a probe over a transport that answers with whatever is handed in. */
function probeWith(answer: unknown | (() => Promise<unknown>)) {
	const lines: string[] = [];
	const sendRequest = vi.fn(async () => (typeof answer === "function" ? (answer as () => Promise<unknown>)() : answer));
	const probe = new CapabilityProbe({ sendRequest }, "duid-test", (message) => lines.push(message));
	return { probe, sendRequest, lines };
}

describe("reading one answer as a verdict", () => {
	it("counts the shapes a real answer had", () => {
		// The 43 successes were 27 arrays and 16 objects.
		expect(classifyProbeAnswer([{ status: 1 }])).toBe("capable");
		expect(classifyProbeAnswer({ status: 1 })).toBe("capable");
		expect(classifyProbeAnswer([])).toBe("capable");
		expect(classifyProbeAnswer([0])).toBe("capable");
		expect(classifyProbeAnswer(["Europe/Berlin"])).toBe("capable");
	});

	it("counts the rejection the device really sends", () => {
		expect(classifyProbeAnswer("unknown_method")).toBe("unsupported");
	});

	it("counts every other bare string as a rejection too", () => {
		// Stricter than comparing against the literal, so a robot that words its refusal
		// differently is not handed a control it cannot serve. The cost is stated in the module:
		// a robot that answers a getter with a bare string loses that function here.
		expect(classifyProbeAnswer("ok")).toBe("unsupported");
		expect(classifyProbeAnswer("error")).toBe("unsupported");
		expect(classifyProbeAnswer("")).toBe("unsupported");
	});

	it("refuses everything that is neither array nor object", () => {
		expect(classifyProbeAnswer(null)).toBe("unsupported");
		expect(classifyProbeAnswer(undefined)).toBe("unsupported");
		expect(classifyProbeAnswer(0)).toBe("unsupported");
		expect(classifyProbeAnswer(1)).toBe("unsupported");
		expect(classifyProbeAnswer(true)).toBe("unsupported");
	});
});

describe("probing a command", () => {
	it("asks with the payload the app's own wrapper sends", async () => {
		const { probe, sendRequest } = probeWith([{ status: 1 }]);
		await probe.probe("get_collision_avoid_status", {});

		expect(sendRequest).toHaveBeenCalledWith("duid-test", "get_collision_avoid_status", {}, { priority: -10 });
	});

	it("goes in below normal priority, so it cannot overtake a poll or a user command", async () => {
		const { probe, sendRequest } = probeWith([{}]);
		await probe.probe("get_led_status", []);

		expect(sendRequest.mock.calls[0][3]).toEqual({ priority: -10 });
	});

	it("asks once and remembers the verdict for the rest of the run", async () => {
		const { probe, sendRequest } = probeWith([{ status: 1 }]);

		await expect(probe.probe("get_collision_avoid_status", {})).resolves.toBe("capable");
		await expect(probe.probe("get_collision_avoid_status", {})).resolves.toBe("capable");
		await expect(probe.probe("get_collision_avoid_status", {})).resolves.toBe("capable");

		expect(sendRequest).toHaveBeenCalledTimes(1);
		expect(probe.probedCount).toBe(1);
	});

	it("reads the rejection of the real device", async () => {
		const { probe } = probeWith("unknown_method");
		await expect(probe.probe("get_dock_info", {})).resolves.toBe("unsupported");
	});

	it("unwraps the shapes the request layer hands back", async () => {
		await expect(probeWith({ result: [{ status: 1 }] }).probe.probe("get_collision_avoid_status", {})).resolves.toBe("capable");
		await expect(probeWith({ data: "unknown_method" }).probe.probe("get_dock_info", {})).resolves.toBe("unsupported");
	});

	it("treats a request that never answered as 'not supported', not as an error", async () => {
		// A timeout says nothing about the robot - but nothing in favour of it either, and a
		// control offered on a maybe is the fault this whole mechanism exists to stop.
		const { probe, lines } = probeWith(() => Promise.reject(new Error("timeout")));

		await expect(probe.probe("get_collision_avoid_status", {})).resolves.toBe("unsupported");
		expect(lines.some((line) => line.includes("did not answer"))).toBe(true);
	});

	it("never probes with anything but a reading command", async () => {
		// The second barrier: the caller decides what to probe, and a probe must not change
		// anything on the device. A set command is refused without a request going out.
		const { probe, sendRequest, lines } = probeWith([{}]);

		await expect(probe.probe("set_collision_avoid_status", {})).resolves.toBe("unsupported");
		await expect(probe.probe("app_start", [])).resolves.toBe("unsupported");
		await expect(probe.probe("save_map", [])).resolves.toBe("unsupported");

		expect(sendRequest).not.toHaveBeenCalled();
		expect(lines.filter((line) => line.includes("Refusing to probe")).length).toBe(3);
	});

	it("says in the log what it concluded and why", async () => {
		const { probe, lines } = probeWith("unknown_method");
		await probe.probe("get_dock_info", {});

		expect(lines.some((line) => line.includes("get_dock_info") && line.includes("not supported"))).toBe(true);
	});

	it("reports a verdict it already has, and nothing for one it never asked", async () => {
		const { probe } = probeWith([{ status: 1 }]);
		expect(probe.verdictFor("get_collision_avoid_status")).toBeUndefined();

		await probe.probe("get_collision_avoid_status", {});
		expect(probe.verdictFor("get_collision_avoid_status")).toBe("capable");
		expect(probe.verdictFor("get_led_status")).toBeUndefined();
	});
});
