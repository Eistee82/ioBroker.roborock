import type { FeatureDependencies } from "../baseDeviceFeatures";

/**
 * Deletes one run from the robot's cleaning history.
 *
 * ## What the app sends, and how each part of it was read
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`.
 *
 * | Wrapper | RPC | Payload | Fundstelle |
 * | --- | --- | --- | --- |
 * | `deleteCleanRecord(a0)` | `Methods.DelCleanRecord` = `del_clean_record` | `new Array(1)` holding `a0` | A65:228101-228117 |
 * | caller | — | `a0 = record.start` | A65:875841-875846 |
 *
 * So the payload is `[<start timestamp of the run>]` - a bare number in an array, not an object and
 * not an id of its own. The caller settles the question the wrapper leaves open, and it settles it
 * twice over: right after the call it removes the row from its own list by comparing
 * `record.start !== deleted` (A65:875872-875880), so the value sent really is that field.
 *
 * **The name search would have missed this.** `del_clean_record` appears exactly once in the whole
 * bundle, in the method table (A65:238179), because the wrapper reaches it through the constant
 * `Methods.DelCleanRecord`. That is the third time in this round that a negative finding about a
 * method turned out to be a finding about the search.
 *
 * ## Why there is no capability probe for it
 *
 * `CapabilityProbe` may only ask a `get_*` (`capabilityProbe.ts:107`), and rightly so. For a
 * deleting method the probe *is* the deletion, so there is nothing to try. The question is put the
 * only other honest way: **the robot listed runs**. `get_clean_summary` is read on every return to
 * the dock anyway, and a robot that reports no runs has nothing to delete and gets no control - the
 * same construction the schedule switch uses.
 *
 * ## Why the answer is not the confirmation
 *
 * `del_clean_record` is not a `set_*`, so the adapter's answer check treats anything but a bare
 * string as "accepted" - which says the robot replied and no more (`commandFeedback.ts`). For a
 * deletion that is not enough, so the summary is read again afterwards and **the list decides**:
 * gone means confirmed, still there means it did not take, and a summary that cannot be read means
 * unknown rather than either.
 *
 * Holds no timer and no subscription; there is nothing for `onUnload` to clean up.
 */

/** RPC that deletes one run from the robot's history. */
export const DEL_CLEAN_RECORD = "del_clean_record";

/** State the deletion is triggered from, inside the `commands` folder. */
export const DEL_CLEAN_RECORD_COMMAND = DEL_CLEAN_RECORD;

/**
 * Reads a start timestamp out of whatever was written into the state.
 * @param value Raw value.
 * @returns The timestamp, or null when it is not one.
 */
export function parseRecordStartTime(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
	}
	return null;
}

/** Publishes the delete button, builds its payload and judges what became of it. */
export class V1CleanRecordDeleteService {
	/** Methods this service registered, and therefore the only ones it builds parameters for. */
	private readonly claimed = new Set<string>();

	/**
	 * Start timestamps the robot listed the last time the summary was read.
	 *
	 * Both the capability answer and the guard: a value that is not in here is refused rather than
	 * sent. The robot would answer a stranger's timestamp with nothing useful anyway, and refusing
	 * is the difference between "that run does not exist" and a deletion nobody can account for.
	 */
	private knownRecords: number[] = [];

	constructor(
		private readonly deps: FeatureDependencies,
		private readonly duid: string
	) {}

	/** Methods this service registered and is therefore responsible for. */
	public handles(method: string): boolean {
		return this.claimed.has(method);
	}

	/** Runs the robot reported the last time its summary was read. */
	public get records(): ReadonlyArray<number> {
		return this.knownRecords;
	}

	/**
	 * Remembers the run list of the newest summary.
	 * @param records Start timestamps, in whatever order the summary had them.
	 * @returns Whether the robot listed at least one run.
	 */
	public noteRecords(records: ReadonlyArray<number>): boolean {
		this.knownRecords = records.filter((entry) => Number.isFinite(entry) && entry > 0);
		return this.knownRecords.length > 0;
	}

	/**
	 * Registers the delete button.
	 *
	 * A **number** and not a button, because the command needs to say *which* run - and the value
	 * is the run's own start timestamp, which the adapter already publishes as
	 * `cleaningInfo.records.<index>.startTime`. There is nothing to pick from a list of states here,
	 * so no `states` map is offered: the set changes with every clean, and a picker frozen at
	 * registration time would go stale within the hour.
	 *
	 * @param addCommand Registration callback of the feature class.
	 */
	public registerCommands(addCommand: (name: string, spec: Record<string, unknown>, group?: string) => void): void {
		addCommand(DEL_CLEAN_RECORD_COMMAND, {
			type: "number",
			role: "value",
			name: this.text("delete", "Delete cleaning record"),
			desc: "Write the start timestamp of the run, as published in cleaningInfo.records.<index>.startTime. The run is deleted on the robot and cannot be restored.",
			def: 0,
			write: true
		});

		this.claimed.add(DEL_CLEAN_RECORD_COMMAND);
	}

	/**
	 * Builds the parameters of the deletion.
	 *
	 * Refuses a timestamp the robot did not list. That is not politeness: this is the one command in
	 * the group that destroys something, and a number nobody recognises is far more likely to be a
	 * mistake than a run the summary happened to miss.
	 *
	 * @param _method Method as registered; this service owns exactly one, so it is not branched on.
	 * @param value   Raw value written into the state.
	 * @returns The method and parameters to send.
	 */
	public buildCommandParams(_method: string, value: unknown): { method: string; params: unknown } {
		const startTime = parseRecordStartTime(value);
		if (startTime === null) {
			throw new Error(`${DEL_CLEAN_RECORD} needs the start timestamp of a run; received ${JSON.stringify(value)}`);
		}

		if (!this.knownRecords.includes(startTime)) {
			throw new Error(
				`${DEL_CLEAN_RECORD} refuses ${startTime}: the robot's last summary listed `
				+ (this.knownRecords.length === 0 ? "no runs at all" : `${this.knownRecords.join(", ")}`)
				+ `. Nothing was sent.`
			);
		}

		// `new Array(1)` holding the timestamp - A65:228107-228113.
		return { method: DEL_CLEAN_RECORD, params: [startTime] };
	}

	/**
	 * Decides what became of a deletion, from the run list rather than from the answer.
	 *
	 * @param startTime Run that was to be deleted.
	 * @param records   Run list of the summary read afterwards.
	 * @returns Whether the run is gone.
	 */
	public isDeleted(startTime: number, records: ReadonlyArray<number>): boolean {
		return !records.includes(startTime);
	}

	/** Shorthand for a Roborock wording with an English fallback. */
	private text(key: string, fallback: string): string {
		return this.deps.adapter.translationManager.get(key, fallback);
	}

	/**
	 * Removes the state folders of runs the robot no longer has.
	 *
	 * The history is published as a dense list, `cleaningInfo.records.0…n-1`, and the writer only
	 * ever moves entries towards the front - it has no reason to shorten the list, because until now
	 * the list could only grow. After a deletion it is one shorter, and without this the last folder
	 * would keep showing a run that has been deleted.
	 *
	 * @param remaining How many runs the robot still reports.
	 */
	public async pruneRecordFolders(remaining: number): Promise<void> {
		if (typeof this.deps.adapter.delObjectAsync !== "function") return;

		// Stops at the first index that does not exist. The list is dense, so there is nothing
		// beyond a gap, and an unbounded loop over an object database is not a thing to write.
		for (let index = Math.max(0, remaining); ; index++) {
			const path = `Devices.${this.duid}.cleaningInfo.records.${index}`;
			const existing = await this.deps.adapter.getObjectAsync(path);
			if (!existing) return;

			try {
				await this.deps.adapter.delObjectAsync(path, { recursive: true });
			} catch (e: unknown) {
				this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
					`Could not remove the states of the deleted run at ${path}: ${this.deps.adapter.errorMessage(e)}`, "warn");
				return;
			}
		}
	}
}
