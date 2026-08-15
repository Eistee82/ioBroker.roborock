/**
 * Checks whether a `set_*` command the robot answered with `["ok"]` actually took effect.
 *
 * ## Why this exists
 *
 * The robot answers `["ok"]` to a setting it silently drops. That is not a guess: the Roborock app
 * itself never looks at the answer. `handleWaterModeWillChange` in the a65 control plugin
 * (`_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`, Z. 252345-252512)
 * awaits `setWaterBoxMode(value)`, and on the resolved path (Z. 252381-252428) it never reads the
 * resolved value - it writes the **requested** value straight into its own model
 * (`RSM.waterBoxMode = <requested>`, Z. 252426-252428). Only a thrown transport error reaches
 * `handleSettingFail()` (Z. 252482-252511). So the app shows the level it asked for and lets the
 * next status push correct it; it cannot tell "accepted" from "silently dropped" either.
 *
 * The adapter already checks the answer against `["ok"]`
 * (`src/lib/requestsHandler.ts:727-733`) and already re-reads the status after every non-poll
 * request (`src/lib/requestsHandler.ts:824-832`). What was missing is the comparison between the
 * two: when the robot keeps reporting the old value, nothing said so, and the user saw a control
 * that snapped back without a word in the log.
 *
 * ## What is claimed here, and what is not
 *
 * This module states a **fact**, not a firmware verdict: "the robot still reports X seconds after
 * the command was acknowledged". Whether the firmware rejected the value, needs longer, or changed
 * it again on its own (a carpet raises `fan_power`, a removed mop drops `water_box_mode`) is not
 * decidable from outside, and the log line says so. Nothing here sends an extra request - the
 * comparison rides on the status reads that happen anyway.
 *
 * The command-to-status pairing is not invented either: it is the same pairing the adapter has
 * always used when it mirrors a status field back into a command state
 * (`v1VacuumFeatures.ts:1158-1179`).
 */

/**
 * Which status field carries the value a command sets.
 *
 * Only commands whose effect is visible in `get_status` can be verified at all. Everything else
 * (`set_clean_repeat_times`, `set_water_box_distance_off`, `app_*`, the map editor) is out of
 * scope on purpose - a check that cannot observe its subject would only produce noise.
 */
export const VERIFIABLE_SET_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	set_custom_mode: Object.freeze(["fan_power"]),
	set_mop_mode: Object.freeze(["mop_mode"]),
	set_water_box_custom_mode: Object.freeze(["water_box_mode"]),
	// Carries the whole triple in one payload; its keys are named exactly like the status fields.
	set_clean_motor_mode: Object.freeze(["fan_power", "water_box_mode", "mop_mode"]),
	// `{lock_status: 0|1}` on the wire, `lock_status` in the status - the same name on both sides,
	// so the payload is read by field name like the triple above.
	set_child_lock_status: Object.freeze(["lock_status"])
});

/**
 * ## Why the two Do Not Disturb commands are **not** in the table above
 *
 * They were, briefly, against the status field `dnd_enabled` - `set_dnd_timer` was expected to
 * make it 1 and `close_dnd_timer` to make it 0. A read-only measurement at the device took that
 * apart (`_appanalysis/19-geraetefaehigkeiten.md` §6.1):
 *
 * ```
 * 12:43 Uhr   get_status.dnd_enabled = 0
 * 12:43 Uhr   get_dnd_timer          = {start 22:00, end 08:00, enabled: 1}
 * ```
 *
 * The status said off while the robot held an enabled window. The earlier live capture
 * (`_appanalysis/local-mitschnitt.log:15`) shows `dnd_enabled: 1` at 23:44 - inside that same
 * window, where 12:43 is outside it.
 *
 * **Both samples fit one reading: `dnd_enabled` says whether the quiet period is running right
 * now, not whether one is configured.** Two agreeing samples are a strong hint and not a proof -
 * this was not read back in the plugin, and the alternative (the user toggled the mode between the
 * two measurements, coincidentally matching the window) is not excluded. Whoever reads it in the
 * plugin later should see what the decision rested on.
 *
 * Either way the consequence is certain: a window set during the day is followed by
 * `dnd_enabled: 0`, so the check would have announced after ten seconds that the command had not
 * taken effect. That is precisely the false alarm this module exists to avoid, and a check that
 * cries wolf is worse than no check.
 *
 * The honest test for these two is the robot's own answer to `get_dnd_timer`, which
 * `V1VacuumFeatures.onCommandResult` already fetches after every set and every close.
 */

/**
 * How long a mismatch is tolerated before it is reported.
 *
 * Two known delays have to fit inside it. The status read that `resolvePendingRequest` fires right
 * after the command may still carry the pre-command state, and it has 5 s of its own to arrive
 * (`get_prop` in `METHOD_TIMEOUTS_MS`). The next scheduled poll follows no earlier than
 * `POLL_POLICY.minIntervalSeconds` = 5 s. Ten seconds clears both, so the first observation that is
 * allowed to raise a warning is a genuinely later one - never the immediate echo.
 *
 * This is a tolerance, not a measurement: how fast the firmware applies a setting was not measured
 * (that would mean sending commands to the real robot). The window is therefore deliberately
 * generous in the direction of staying quiet.
 */
export const COMMAND_VERIFY_GRACE_MS = 10_000;

/** One field the robot reports differently from what was sent. */
export interface CommandFieldMismatch {
	field: string;
	expected: number;
	actual: unknown;
}

/** What a single status observation says about one pending command. */
export interface CommandVerificationResult {
	command: string;
	/**
	 * `confirmed`   - the robot reports every value that was sent.
	 * `mismatch`    - the grace window is over and at least one value is still different.
	 * `unobservable`- the grace window is over and the status never carried the fields at all.
	 */
	kind: "confirmed" | "mismatch" | "unobservable";
	/** Empty unless `kind` is `mismatch`. */
	mismatches: CommandFieldMismatch[];
	/** Values the robot reports for the checked fields, as far as it reports them. */
	reported: Record<string, number>;
	/** Time between the acknowledgement and this observation. */
	elapsedMs: number;
}

interface PendingCommand {
	command: string;
	expected: Record<string, number>;
	sentAt: number;
}

/**
 * Reads the values a command asks for out of its final parameters.
 *
 * The parameters are what `getCommandParams` produced, i.e. what really went on the wire:
 * `[105]` for the single-value commands, `[{fan_power, water_box_mode, mop_mode}]` for
 * `set_clean_motor_mode`.
 *
 * @param command Command name as registered in the `commands` folder.
 * @param params  Final parameters handed to the transport.
 * @returns The expected status fields, or `null` if this command cannot be verified.
 */
export function expectationFor(command: string, params: unknown): Record<string, number> | null {
	const fields = VERIFIABLE_SET_COMMANDS[command];
	if (!fields) return null;

	const payload = Array.isArray(params) ? params[0] : params;

	// An object payload names its own fields, and every command that has one names them exactly
	// like the status fields they set (`set_clean_motor_mode`, `set_child_lock_status`). Reading by
	// name rather than by position is what lets a new command join without a case of its own here.
	if (typeof payload === "object" && payload !== null) {
		const source = payload as Record<string, unknown>;
		const expected: Record<string, number> = {};
		for (const field of fields) {
			const value = toFiniteNumber(source[field]);
			if (value !== null) expected[field] = value;
		}
		return Object.keys(expected).length > 0 ? expected : null;
	}

	const value = toFiniteNumber(payload);
	if (value === null) return null;
	return { [fields[0]]: value };
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * Remembers what was asked for and compares it against the status reads that follow.
 *
 * Deliberately free of timers and of any adapter dependency: it is fed from `onCommandResult` and
 * questioned from `processStatus`, both of which the adapter calls anyway. Nothing here has to be
 * torn down in `onUnload`.
 */
export class CommandVerifier {
	private readonly pending = new Map<string, PendingCommand>();

	constructor(private readonly graceMs: number = COMMAND_VERIFY_GRACE_MS) {}

	/**
	 * Notes that a command was acknowledged and is now expected to show up in the status.
	 *
	 * A second write to the same command replaces the older expectation - the newer one is what the
	 * user is waiting for.
	 *
	 * @param command Command name as registered in the `commands` folder.
	 * @param params  Final parameters handed to the transport.
	 * @param now     Current time, injectable for tests.
	 * @returns `true` if the command is being watched from now on.
	 */
	public record(command: string, params: unknown, now: number = Date.now()): boolean {
		const expected = expectationFor(command, params);
		if (!expected) return false;
		this.pending.set(command, { command, expected, sentAt: now });
		return true;
	}

	/** Drops every expectation, e.g. when the device connection was reset. */
	public clear(): void {
		this.pending.clear();
	}

	/** How many commands are currently waiting for confirmation. Test and diagnostics helper. */
	public get pendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Compares a fresh status against everything that is still waiting.
	 *
	 * An observation inside the grace window that does not match yet is not a verdict - the entry
	 * stays and the next status decides.
	 *
	 * @param status Raw `get_status` payload.
	 * @param now    Current time, injectable for tests.
	 * @returns One result per command that reached a verdict with this observation.
	 */
	public evaluate(status: Record<string, unknown> | null | undefined, now: number = Date.now()): CommandVerificationResult[] {
		if (this.pending.size === 0) return [];
		const source: Record<string, unknown> = status && typeof status === "object" ? status : {};
		const results: CommandVerificationResult[] = [];

		for (const entry of Array.from(this.pending.values())) {
			const elapsedMs = Math.max(0, now - entry.sentAt);
			const reported: Record<string, number> = {};
			const mismatches: CommandFieldMismatch[] = [];
			let observedFields = 0;

			for (const [field, expected] of Object.entries(entry.expected)) {
				if (!(field in source)) continue;
				observedFields++;
				const actual = toFiniteNumber(source[field]);
				if (actual !== null) reported[field] = actual;
				if (actual !== expected) {
					mismatches.push({ field, expected, actual: source[field] });
				}
			}

			if (observedFields > 0 && mismatches.length === 0) {
				this.pending.delete(entry.command);
				results.push({ command: entry.command, kind: "confirmed", mismatches: [], reported, elapsedMs });
				continue;
			}

			if (elapsedMs < this.graceMs) continue;

			this.pending.delete(entry.command);
			results.push({
				command: entry.command,
				kind: observedFields === 0 ? "unobservable" : "mismatch",
				mismatches,
				reported,
				elapsedMs
			});
		}

		return results;
	}
}
