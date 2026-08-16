import { describe, expect, it } from "vitest";

import {
	MAX_ARG_LENGTH,
	MAX_COMMENT_LENGTH,
	OUTCOME_QUALITY,
	buildCommandComment,
	classifyRequestFailure,
	classifyRobotAnswer,
	describeOutcome,
	isProblemOutcome,
	isShutdownFailure,
	outcomeArgs,
	truncateDetail
} from "../../src/lib/commandFeedback";
import type { CommandOutcome } from "../../src/lib/commandFeedback";

const ALL_OUTCOMES: CommandOutcome[] = [
	"not_sent",
	"unreachable",
	"no_answer",
	"error",
	"rejected",
	"accepted",
	"sent",
	"confirmed",
	"ineffective"
];

/**
 * What a command outcome says, and what it refuses to say.
 *
 * The point of these tests is not that the module computes something, but that it never claims more
 * than the adapter can know. Two outcomes exist purely to say "unknown", and the tests below pin
 * that they cannot silently turn into a quality that names a culprit.
 */
describe("command outcomes", () => {
	describe("the quality each one leaves on the state", () => {
		it("says 'device not connected' only where nothing was sent", () => {
			// ChannelUnavailableError documents itself as "never touched the wire".
			expect(OUTCOME_QUALITY.unreachable).toBe(0x42);
		});

		it("blames the instance where the adapter itself refused to build the request", () => {
			expect(OUTCOME_QUALITY.not_sent).toBe(0x11);
		});

		it("blames the device where the device answered a refusal", () => {
			expect(OUTCOME_QUALITY.rejected).toBe(0x44);
			expect(OUTCOME_QUALITY.ineffective).toBe(0x41);
		});

		it("falls back to plain 'bad' where nobody can say what went wrong", () => {
			// There is no "did not answer" quality, and CONNECTION_PROBLEM would claim to know where
			// it broke. The comment is what tells these two apart.
			expect(OUTCOME_QUALITY.no_answer).toBe(0x01);
			expect(OUTCOME_QUALITY.error).toBe(0x01);
		});

		it("leaves a good quality on everything that worked", () => {
			expect(OUTCOME_QUALITY.accepted).toBe(0x00);
			expect(OUTCOME_QUALITY.sent).toBe(0x00);
			expect(OUTCOME_QUALITY.confirmed).toBe(0x00);
		});

		it("has an entry for every outcome, so none can fall through", () => {
			for (const outcome of ALL_OUTCOMES) {
				expect(OUTCOME_QUALITY[outcome], outcome).toBeTypeOf("number");
			}
		});
	});

	describe("what counts as a problem", () => {
		it("is derived from the quality, so the two cannot disagree", () => {
			for (const outcome of ALL_OUTCOMES) {
				expect(isProblemOutcome(outcome), outcome).toBe(OUTCOME_QUALITY[outcome] !== 0);
			}
		});

		it("leaves the three that worked alone", () => {
			expect(isProblemOutcome("accepted")).toBe(false);
			expect(isProblemOutcome("sent")).toBe(false);
			expect(isProblemOutcome("confirmed")).toBe(false);
		});
	});

	describe("classifying a failure on the way out", () => {
		it("calls a dead channel 'unreachable', because nothing was sent", () => {
			expect(classifyRequestFailure("No connection to robot xy", true)).toBe("unreachable");
		});

		it("calls a timeout 'no_answer', not 'failed'", () => {
			expect(classifyRequestFailure("Request command-set_custom_mode timed out after 15000ms", false)).toBe("no_answer");
			expect(classifyRequestFailure("Task req_1 was cancelled: CANCELLED", false)).toBe("no_answer");
			expect(classifyRequestFailure("Aborted", false)).toBe("no_answer");
		});

		it("keeps everything else an open question", () => {
			expect(classifyRequestFailure("Failed to build B01 DP message", false)).toBe("error");
		});

		it("lets the dead channel win over a timeout in the wording", () => {
			// Both can be true of one error; only one of them says whether anything went out.
			expect(classifyRequestFailure("timed out waiting for a connection", true)).toBe("unreachable");
		});
	});

	describe("reading the robot's answer", () => {
		it("takes ['ok'] on a set_ method as accepted", () => {
			expect(classifyRobotAnswer("set_custom_mode", ["ok"])).toBe("accepted");
			expect(classifyRobotAnswer("set_custom_mode", { data: ["ok"] })).toBe("accepted");
		});

		it("takes anything else on a set_ method as rejected", () => {
			expect(classifyRobotAnswer("set_custom_mode", ["unknown_method"])).toBe("rejected");
			expect(classifyRobotAnswer("set_custom_mode", ["ok", "ok"])).toBe("rejected");
			expect(classifyRobotAnswer("set_custom_mode", null)).toBe("rejected");
		});

		it("does not judge a method with no defined answer", () => {
			expect(classifyRobotAnswer("app_start", ["anything"])).toBe("accepted");
			expect(classifyRobotAnswer("get_status", { battery: 100 })).toBe("accepted");
		});

		/**
		 * The refusals below are the two the adapter can recognise, and both are measured rather
		 * than assumed. Everything else has to stay `accepted`: a false failure mark on a working
		 * command is worse than the silence it replaces.
		 */
		describe("refusals of a method without a defined answer", () => {
			// Every command that is not a setter used to be reported as accepted whatever came
			// back - most of the command surface, the remote control and every cleaning start
			// among it.
			const NOT_A_SETTER = ["app_start", "app_zoned_clean", "app_goto_target", "find_me", "get_multi_maps_list", "resume_segment_clean", "app_rc_move"];

			it("reads a bare string as a refusal, for every method", () => {
				// 23 of 133 real answers from the reference device, every one a bare string.
				for (const method of NOT_A_SETTER) {
					expect(classifyRobotAnswer(method, "unknown_method"), method).toBe("rejected");
					expect(classifyRobotAnswer(method, { data: "unknown_method" }), method).toBe("rejected");
				}
			});

			it("does not depend on the wording, only on the shape", () => {
				// A robot that refuses in different words would otherwise slip through, and the
				// measurement covers one device with one firmware.
				expect(classifyRobotAnswer("app_start", "not_supported")).toBe("rejected");
				expect(classifyRobotAnswer("app_start", "")).toBe("rejected");
			});

			it("reads an exhausted ['retry'] as a refusal", () => {
				// The transport re-sends on this and only hands it up once the retries are spent,
				// so what arrives here means the request was never carried out.
				expect(classifyRobotAnswer("app_start", ["retry"])).toBe("rejected");
				expect(classifyRobotAnswer("set_custom_mode", ["retry"])).toBe("rejected");
			});
		});

		/**
		 * The counter-test, and the one that matters most: these five run every day. If the check
		 * ever calls one of them rejected, the check is wrong, not the command.
		 */
		describe("the commands that are known to work must never be called rejected", () => {
			const DAILY = ["app_start", "app_stop", "app_pause", "app_charge", "find_me"];

			it("accepts every answer shape the reference device produced", () => {
				// The eight shapes measured across 133 answers, minus the bare string.
				const MEASURED_SUCCESS: unknown[] = [
					["ok"],
					[],
					[{ status: 0 }],
					[101],
					["Europe/Berlin"],
					[111, 112, 125],
					[{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }],
					{ status: 0 },
				];

				for (const method of DAILY) {
					for (const answer of MEASURED_SUCCESS) {
						expect(classifyRobotAnswer(method, answer), `${method} <- ${JSON.stringify(answer)}`).toBe("accepted");
					}
				}
			});

			it("accepts an answer shape nobody has measured, rather than guessing", () => {
				// An unrecognised answer is exactly what `accepted` already claims: the robot
				// answered, no more. Turning it into a refusal would be the false alarm.
				for (const method of DAILY) {
					expect(classifyRobotAnswer(method, 0), method).toBe("accepted");
					expect(classifyRobotAnswer(method, true), method).toBe("accepted");
					expect(classifyRobotAnswer(method, null), method).toBe("accepted");
					expect(classifyRobotAnswer(method, undefined), method).toBe("accepted");
					expect(classifyRobotAnswer(method, [["nested"]]), method).toBe("accepted");
				}
			});
		});

		it("leaves the stricter set_ test exactly as it was", () => {
			// Not loosened by the new branches: a setter still has to answer ["ok"].
			expect(classifyRobotAnswer("set_custom_mode", ["ok"])).toBe("accepted");
			expect(classifyRobotAnswer("set_custom_mode", [])).toBe("rejected");
			expect(classifyRobotAnswer("set_custom_mode", { status: 0 })).toBe("rejected");
			expect(classifyRobotAnswer("set_custom_mode", 0)).toBe("rejected");
		});
	});

	describe("the shutdown", () => {
		it("is recognised and says nothing about the robot", () => {
			expect(isShutdownFailure("Task req_1_2 was cancelled: ADAPTER_STOPPED")).toBe(true);
			expect(isShutdownFailure("Request timed out")).toBe(false);
		});
	});

	describe("the wording", () => {
		it("fills the arguments in order", () => {
			const described = describeOutcome("rejected", ["set_custom_mode", "[\"nope\"]"]);
			expect(described.messageKey).toBe("ui_cmdres_rejected");
			expect(described.message).toBe("The robot rejected set_custom_mode and answered [\"nope\"].");
		});

		it("has no wording for the outcomes that worked", () => {
			// They clear the mark instead of leaving one; a good state explains itself.
			for (const outcome of ["accepted", "sent", "confirmed"] as CommandOutcome[]) {
				expect(describeOutcome(outcome, ["app_start"]).messageKey, outcome).toBe("");
			}
		});

		it("collects the arguments a report carries, starting with the command", () => {
			expect(outcomeArgs({ command: "set_custom_mode", outcome: "ineffective", extraArgs: ["12s", "fan_power=101"] }))
				.toEqual(["set_custom_mode", "12s", "fan_power=101"]);
			expect(outcomeArgs({ command: "app_start", outcome: "error", detail: "boom" })).toEqual(["app_start", "boom"]);
		});
	});

	describe("the comment that carries the reason", () => {
		it("carries key, arguments and the English sentence at once", () => {
			const parsed = JSON.parse(buildCommandComment("unreachable", ["app_start"]));
			expect(parsed).toEqual({
				m: "app_start was not sent: there is no connection to the robot.",
				k: "ui_cmdres_unreachable",
				a: ["app_start"]
			});
		});

		it("puts the English sentence first, where a human reading the state sees it", () => {
			expect(buildCommandComment("unreachable", ["app_start"]).startsWith("{\"m\":")).toBe(true);
		});

		it("is empty for an outcome that worked, so nothing has to be invented to clear it", () => {
			expect(buildCommandComment("accepted", ["app_start"])).toBe("");
		});

		it("shortens a single argument that runs away", () => {
			const long = "x".repeat(400);
			const parsed = JSON.parse(buildCommandComment("error", ["app_start", long]));
			expect(parsed.a[1].length).toBeLessThanOrEqual(MAX_ARG_LENGTH + 1);
		});

		it("stays inside what the states database keeps, whatever it is given", () => {
			// The states database cuts a comment at 512 characters, and a cut in the middle of the
			// JSON would leave something nobody can parse.
			const comment = buildCommandComment("ineffective", ["set_custom_mode", "y".repeat(500), "z".repeat(500)]);
			expect(comment.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
			expect(() => JSON.parse(comment)).not.toThrow();
		});

		it("keeps the key and the arguments when the sentence has to give way", () => {
			const parsed = JSON.parse(buildCommandComment("ineffective", ["set_custom_mode", "y".repeat(500), "z".repeat(500)]));
			expect(parsed.k).toBe("ui_cmdres_ineffective");
			expect(parsed.a).toHaveLength(3);
		});
	});

	describe("shortening a text", () => {
		it("leaves a short one alone", () => {
			expect(truncateDetail("short")).toBe("short");
		});

		it("marks that it cut", () => {
			expect(truncateDetail("x".repeat(200))).toBe(`${"x".repeat(MAX_ARG_LENGTH)}…`);
		});
	});
});
