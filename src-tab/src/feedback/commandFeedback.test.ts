import { describe, expect, it } from "vitest";

import {
	MAX_NOTICE_AGE_MS,
	commandStatePatterns,
	formatFeedbackMessage,
	isFreshNotice,
	parseCommandComment,
	toCommandFeedbackNotice
} from "./commandFeedback";
import type { CommandStateLike } from "./commandFeedback";

/**
 * Reading a command outcome off the command state.
 *
 * The tests below guard three promises: nothing half-parsed reaches the page, a success is never
 * announced, and an open question is never coloured as a failure.
 */

const STATE_ID = "roborock.0.Devices.duid1.commands.set_custom_mode";

function comment(key: string, args: string[], message: string): string {
	return JSON.stringify({ m: message, k: key, a: args });
}

function state(overrides: Partial<CommandStateLike> = {}): CommandStateLike {
	return {
		val: 102,
		ack: false,
		q: 0x44,
		c: comment("ui_cmdres_rejected", ["set_custom_mode", "[\"nope\"]"], "The robot rejected set_custom_mode and answered [\"nope\"]."),
		ts: 5000,
		...overrides
	};
}

describe("the watched patterns", () => {
	it("name the four folders the tab writes commands to", () => {
		expect(commandStatePatterns("roborock.0", "duid1")).toEqual([
			"roborock.0.Devices.duid1.commands.*",
			"roborock.0.Devices.duid1.settings.*",
			"roborock.0.Devices.duid1.resetConsumables.*",
			"roborock.0.Devices.duid1.floors.*.load"
		]);
	});

	it("narrow the floors branch to the load button", () => {
		// `floors.*` would also match every room selection state, which is written on every click.
		const patterns = commandStatePatterns("roborock.0", "duid1");
		expect(patterns).not.toContain("roborock.0.Devices.duid1.floors.*");
	});
});

describe("parsing the comment", () => {
	it("reads key, arguments and the English sentence", () => {
		expect(parseCommandComment(comment("ui_cmdres_unreachable", ["app_start"], "app_start was not sent."))).toEqual({
			messageKey: "ui_cmdres_unreachable",
			messageArgs: ["app_start"],
			fallback: "app_start was not sent."
		});
	});

	it("refuses everything that is not one of ours", () => {
		expect(parseCommandComment(undefined)).toBeNull();
		expect(parseCommandComment("")).toBeNull();
		expect(parseCommandComment("   ")).toBeNull();
		expect(parseCommandComment("a hand written note")).toBeNull();
		expect(parseCommandComment("[1,2,3]")).toBeNull();
		expect(parseCommandComment(JSON.stringify({ m: "no key" }))).toBeNull();
		expect(parseCommandComment(JSON.stringify({ k: "" }))).toBeNull();
		expect(parseCommandComment(42)).toBeNull();
	});

	it("drops arguments that are not text instead of failing over them", () => {
		expect(parseCommandComment(JSON.stringify({ k: "ui_cmdres_error", a: ["ok", 5, null] }))).toEqual({
			messageKey: "ui_cmdres_error",
			messageArgs: ["ok"],
			fallback: ""
		});
	});
});

describe("deciding what to show", () => {
	it("announces a failure", () => {
		const notice = toCommandFeedbackNotice(STATE_ID, state());
		expect(notice).toMatchObject({ severity: "error", messageKey: "ui_cmdres_rejected", stateId: STATE_ID, quality: 0x44, ts: 5000 });
	});

	it("says nothing about a state with a good quality", () => {
		expect(toCommandFeedbackNotice(STATE_ID, state({ q: 0 }))).toBeNull();
		expect(toCommandFeedbackNotice(STATE_ID, state({ q: undefined }))).toBeNull();
	});

	it("says nothing about a missing state", () => {
		expect(toCommandFeedbackNotice(STATE_ID, null)).toBeNull();
		expect(toCommandFeedbackNotice(STATE_ID, undefined)).toBeNull();
	});

	it("says nothing when the quality has no reason beside it", () => {
		// A quality from somewhere else entirely is not this adapter's business to interpret.
		expect(toCommandFeedbackNotice(STATE_ID, state({ c: undefined }))).toBeNull();
		expect(toCommandFeedbackNotice(STATE_ID, state({ c: "written by hand" }))).toBeNull();
	});

	it("colours an open question as a warning, not as a failure", () => {
		// `BAD` is what the adapter falls back to when it cannot tell whether the robot acted.
		const notice = toCommandFeedbackNotice(STATE_ID, state({ q: 0x01, c: comment("ui_cmdres_no_answer", ["app_start"], "No answer.") }));
		expect(notice?.severity).toBe("warning");
	});

	it("colours every named failure as an error", () => {
		for (const quality of [0x11, 0x41, 0x42, 0x44]) {
			expect(toCommandFeedbackNotice(STATE_ID, state({ q: quality }))?.severity, `q=${quality}`).toBe("error");
		}
	});
});

describe("the sentence the user reads", () => {
	const notice = toCommandFeedbackNotice(STATE_ID, state())!;

	it("fills the translation with the arguments", () => {
		const text = formatFeedbackMessage(notice, () => "Der Roboter hat %s abgelehnt und mit %s geantwortet.");
		expect(text).toBe("Der Roboter hat set_custom_mode abgelehnt und mit [\"nope\"] geantwortet.");
	});

	it("falls back to the adapter's English when the key is not translated", () => {
		// An untranslated key comes back out of `I18n.t` as the key itself.
		const text = formatFeedbackMessage(notice, key => key);
		expect(text).toBe("The robot rejected set_custom_mode and answered [\"nope\"].");
	});

	it("shows the key rather than nothing when there is no wording at all", () => {
		const bare = toCommandFeedbackNotice(STATE_ID, state({ c: JSON.stringify({ k: "ui_cmdres_error", a: [] }) }))!;
		expect(formatFeedbackMessage(bare, key => key)).toBe("ui_cmdres_error");
	});
});

describe("how old a mark may be", () => {
	const notice = toCommandFeedbackNotice(STATE_ID, state())!;

	it("takes what just happened", () => {
		expect(isFreshNotice(notice, 5000)).toBe(true);
		expect(isFreshNotice(notice, 5000 + MAX_NOTICE_AGE_MS)).toBe(true);
	});

	it("leaves history alone", () => {
		expect(isFreshNotice(notice, 5001 + MAX_NOTICE_AGE_MS)).toBe(false);
	});

	it("does not swallow a mark from a clock that runs ahead", () => {
		expect(isFreshNotice(notice, 4000)).toBe(true);
	});

	it("refuses a mark without a timestamp", () => {
		expect(isFreshNotice({ ...notice, ts: 0 }, 5000)).toBe(false);
	});
});
