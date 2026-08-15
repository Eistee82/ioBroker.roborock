/**
 * Asks a robot whether it knows a command, instead of deciding it from its model name.
 *
 * ## Why this exists
 *
 * `a179_features.ts` registers about 141 commands with no capability test at all - membership of
 * one model class is the only criterion. For the test device and 32 other models those commands
 * therefore do not exist. A read-only measurement showed that this is wrong in **both** directions
 * (`_appanalysis/19-geraetefaehigkeiten.md` §4): of 20 a179-only getters the a65 answers nine and
 * rejects eleven. It can `get_wash_towel_mode` but not `get_wash_towel_params` - two commands of the
 * same function group in the same model class, with different answers. So "unlock them for every
 * model" would be exactly as wrong as binding them to a class. Only the device knows, and it says so
 * when asked.
 *
 * ## What the robot answers
 *
 * Measured over 66 read-only calls at `roborock.vacuum.a65`, firmware V02.26.80 / `A.03.0309`:
 *
 * ```
 * 43 answered      27 arrays, 16 objects
 * 23 rejected      every single one exactly {"result": "unknown_method"}
 *  0 timeouts      rejections came back in 50-70 ms, as fast as an answer
 * ```
 *
 * Not one successful answer was a bare string, and not one rejection was anything else. That is
 * what {@link classifyProbeAnswer} is built on.
 *
 * ## The rule, and which way it errs
 *
 * **Only an array or an object counts as "the device has this".** A string - including but not
 * limited to `unknown_method` - a number, a boolean, `null`, and every transport failure count as
 * "it does not". There is no third answer and no error path.
 *
 * That asymmetry is deliberate. This was measured on **one device with one firmware**; a robot that
 * rejects differently is not covered by it. Erring towards "cannot" means such a robot keeps
 * exactly what it has today - a function may be missing that it could in fact perform. Erring the
 * other way would give it a control that writes into the void, which is the fault this project has
 * been removing since the eight dead switches of round 2. A missing function is visible and can be
 * reported; a dead switch looks like it works.
 *
 * The measurement covers this device. For every other robot the rule is a **reasoned assumption**,
 * and the consequence of it being wrong is stated above.
 */

/** What a probe concluded about one command. */
export type ProbeVerdict = "capable" | "unsupported";

/**
 * Reads one answer as a verdict.
 *
 * @param result The `result` member of the robot's reply, unwrapped by the caller.
 * @returns `capable` only for an array or a plain object; see the module comment for why.
 */
export function classifyProbeAnswer(result: unknown): ProbeVerdict {
	if (Array.isArray(result)) return "capable";
	if (result !== null && typeof result === "object") return "capable";
	return "unsupported";
}

/** The literal the test device rejects with; used for the log line, never as the only test. */
export const UNKNOWN_METHOD_ANSWER = "unknown_method";

/** How the probe reaches the robot. Kept to one method so tests need no adapter. */
export interface ProbeTransport {
	sendRequest(duid: string, method: string, params: unknown, options?: { priority?: number }): Promise<unknown>;
}

/** Where the probe says what it found. */
export interface ProbeLogger {
	(message: string, level: "debug" | "info"): void;
}

/**
 * Probes commands once per adapter run and remembers the verdicts.
 *
 * Deliberately without persistence. A firmware update can add a capability, so a verdict stored
 * across restarts would be wrong until somebody cleared it - and re-asking costs one request per
 * capability per adapter start, which is nothing against being wrong for months. The cache exists
 * only so that one run does not ask twice.
 *
 * Holds no timers and no subscriptions; there is nothing for `onUnload` to clean up.
 */
export class CapabilityProbe {
	private readonly verdicts = new Map<string, ProbeVerdict>();

	constructor(
		private readonly transport: ProbeTransport,
		private readonly duid: string,
		private readonly log: ProbeLogger,
		/** Queue rank; the probe must never overtake a status poll or a user command. */
		private readonly priority = -10
	) {}

	/**
	 * Asks the robot whether it knows a **reading** command.
	 *
	 * @param getter Method to ask with. Must be a `get_*`/`app_get_*` name: a probe may never
	 *               change anything on the device, and the caller cannot be trusted to remember
	 *               that - so it is checked here.
	 * @param params Exactly what the app's own wrapper sends, `[]` or `{}`.
	 * @returns The verdict, from cache after the first call.
	 */
	public async probe(getter: string, params: unknown): Promise<ProbeVerdict> {
		const cached = this.verdicts.get(getter);
		if (cached) return cached;

		if (!/^(get_|app_get_)[a-z0-9_]+$/.test(getter)) {
			// Not a warning about the robot but about the caller; refusing is the only safe answer.
			this.log(`Refusing to probe with '${getter}': a capability probe may only ask a get_* command.`, "info");
			this.verdicts.set(getter, "unsupported");
			return "unsupported";
		}

		let verdict: ProbeVerdict;
		try {
			const answer = await this.transport.sendRequest(this.duid, getter, params, { priority: this.priority });
			const result = unwrapResult(answer);
			verdict = classifyProbeAnswer(result);
			this.log(
				verdict === "capable"
					? `Capability probe: ${getter} answered, the robot has it.`
					: `Capability probe: ${getter} answered ${JSON.stringify(result)}, treating it as not supported.`,
				"debug"
			);
		} catch (error: unknown) {
			// A request that never got an answer says nothing about the robot's abilities - but it
			// says nothing in favour of them either, and offering a control on a maybe is what this
			// whole mechanism exists to stop. It stays "not supported" for this run and is asked
			// again on the next adapter start.
			verdict = "unsupported";
			this.log(`Capability probe: ${getter} did not answer (${errorText(error)}); not offering it this run.`, "debug");
		}

		this.verdicts.set(getter, verdict);
		return verdict;
	}

	/** Verdict already reached for a command, or undefined while it was never probed. */
	public verdictFor(getter: string): ProbeVerdict | undefined {
		return this.verdicts.get(getter);
	}

	/** How many commands were probed; diagnostics and tests. */
	public get probedCount(): number {
		return this.verdicts.size;
	}
}

/** Digs the `result` out of the shapes the request layer hands back. */
function unwrapResult(answer: unknown): unknown {
	if (answer && typeof answer === "object" && !Array.isArray(answer)) {
		const record = answer as Record<string, unknown>;
		if ("data" in record) return record.data;
		if ("result" in record) return record.result;
	}
	return answer;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
