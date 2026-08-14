import type { CommandSpec, FeatureDependencies } from "../../baseDeviceFeatures";

/**
 * The map editor commands that are safe to expose.
 *
 * Everything in here is either differential (it carries an operation code and an id, so the robot
 * only touches what was named) or it replaces a list the adapter rebuilds in full before sending.
 * The destructive editor methods - `save_map`, `split_segment`, `merge_segment` and the carpet
 * calls - are deliberately absent: `save_map` drops every zone that is not part of the payload and
 * splitting or merging invalidates the settings and schedules attached to a room.
 *
 * Payload formats, module and line references come from `_appanalysis/14-editor-methoden.md`
 * (sections 1.1, 1.2, 1.5, 1.8, 1.9) and `lib/protocols/roborock_map_edit.json`, both read out of
 * Roborock's decompiled control plugin.
 */

/**
 * Bit 26 of `new_feature_info`. With the bit set the firmware understands the retry envelope, and
 * the app then wraps the payload of every method in {@link RETRY_METHODS}.
 *
 * Report section 1.2: `isRPCRetrySupported()` is `robotNewFeatures & 0x4000000`.
 */
export const RPC_RETRY_FEATURE_BIT = 0x4000000;

/** Poll interval of `retry_request` in the app (report section 1.2). */
export const RETRY_POLL_INTERVAL_MS = 2000;

/** The app gives up after this many `retry_request` polls (report section 1.2). */
export const RETRY_MAX_ATTEMPTS = 8;

/**
 * The 13 methods the app wraps when the firmware supports the retry envelope.
 *
 * Kept complete on purpose even though this service only sends two of them - the list is the
 * documented one, and a later package that adds more editor methods should not have to rediscover
 * which of them need the envelope.
 */
export const RETRY_METHODS: ReadonlySet<string> = new Set([
	"save_map",
	"merge_segment",
	"split_segment",
	"name_segment",
	"set_customize_clean_mode",
	"load_multi_map",
	"save_as_multi_map",
	"set_clean_sequence",
	"set_lab_status",
	"set_timer",
	"set_ignore_identify_area",
	"set_ignore_carpet_zone",
	"set_server_timer",
]);

/** Payload wrapped for a firmware that supports the retry envelope. */
export interface RetryEnvelope {
	data: unknown;
	need_retry: 1;
}

/**
 * Turns a payload into the shape the firmware expects.
 *
 * Report section 1.2: an object payload gets `need_retry = 1` added, an array payload is wrapped
 * as `{data: <array>, need_retry: 1}`. Without the feature bit the bare parameters are sent.
 * @param params Payload as the method itself defines it.
 * @param retrySupported Whether bit 26 of `new_feature_info` is set.
 * @returns The payload to put on the wire.
 */
export function applyRetryEnvelope(params: unknown, retrySupported: boolean): unknown {
	if (!retrySupported) return params;

	if (Array.isArray(params)) {
		return { data: params, need_retry: 1 } satisfies RetryEnvelope;
	}
	if (params !== null && typeof params === "object") {
		return { ...(params as Record<string, unknown>), need_retry: 1 };
	}
	return params;
}

/**
 * Recognises the "not finished yet" answer described in report section 1.2.
 * @param response Whatever the robot answered.
 * @returns `null` when this is an ordinary result, the retry id when the robot deferred the call,
 * and `undefined` when it deferred without naming an id (`retry_id_invalid`).
 */
export function readRetryId(response: unknown): number | undefined | null {
	// The transport hands results back either bare or inside a `data` envelope.
	let body: unknown = response;
	if (body !== null && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
		body = (body as Record<string, unknown>).data;
	}
	while (Array.isArray(body) && body.length === 1) {
		body = body[0];
	}

	if (body === null || typeof body !== "object") return null;

	const record = body as Record<string, unknown>;
	if (record.result !== "retry") return null;

	const id = typeof record.id === "number" ? record.id : Number(record.id);
	return Number.isFinite(id) ? id : undefined;
}

/**
 * Reads the cleaning sequence a user wrote into the command state.
 *
 * Report section 1.9: the parameter is the ordered array of segment ids, the same shape
 * `get_clean_sequence` returns. An empty array clears the sequence and lets the robot pick its own
 * order again.
 * @param raw Value of the command state, already JSON-parsed by the adapter where possible.
 * @returns The validated list of segment ids.
 * @throws If the value is not an array of non-negative integers.
 */
export function parseCleanSequence(raw: unknown): number[] {
	if (!Array.isArray(raw)) {
		throw new Error("set_clean_sequence expects a JSON array of segment ids, for example [16,17,18]. An empty array [] clears the order.");
	}

	return raw.map((entry, index) => {
		const id = typeof entry === "number" ? entry : Number(entry);
		if (!Number.isInteger(id) || id < 0) {
			throw new Error(`set_clean_sequence entry ${index} is not a segment id: ${JSON.stringify(entry)}`);
		}
		return id;
	});
}

/**
 * The map editor methods this adapter sends, and the payload building around them.
 *
 * The service owns the payload shapes and the retry envelope; the device feature class only routes
 * its command states here. Written as its own unit so a later package can add editor methods
 * without touching `v1VacuumFeatures.ts` again.
 */
export class MapEditService {
	/** Commands this service registers and handles. */
	public static readonly COMMANDS: readonly string[] = ["set_clean_sequence"];

	constructor(
		private readonly deps: FeatureDependencies,
		private readonly duid: string
	) {}

	/**
	 * Declares the command states for the editor methods.
	 * @param addCommand The feature class' own `addCommand`, so the states land in the usual place.
	 */
	public registerCommands(addCommand: (name: string, spec: CommandSpec, group?: string) => void): void {
		const translations = this.deps.adapter.translations;

		addCommand("set_clean_sequence", {
			type: "json",
			role: "json",
			def: "[]",
			name: translations["set_clean_sequence"] || "Cleaning order (segment IDs, [] resets)",
		} as CommandSpec);
	}

	/** Whether the given command is handled by this service. */
	public handles(method: string): boolean {
		return MapEditService.COMMANDS.includes(method);
	}

	/**
	 * Builds the wire payload for one of {@link MapEditService.COMMANDS}.
	 * @param method The command being sent.
	 * @param params Raw value from the command state.
	 * @returns Method and payload for `requestsHandler`.
	 */
	public async buildRequest(method: string, params: unknown): Promise<{ method: string; params: unknown }> {
		if (method === "set_clean_sequence") {
			const sequence = parseCleanSequence(params);
			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
				sequence.length === 0
					? "Clearing the cleaning order; the robot will pick its own order again."
					: `Setting the cleaning order to ${sequence.join(", ")}.`,
				"info");
			return { method, params: await this.wrap(method, sequence) };
		}

		throw new Error(`MapEditService cannot build a request for '${method}'.`);
	}

	/**
	 * Finishes a call the robot deferred.
	 *
	 * Report section 1.2: a robot that answers `{result: 'retry', id: <n>}` has accepted the call but
	 * not finished it. The app then polls `retry_request {retry_id, method, retry_count}` every two
	 * seconds, at most eight times, and reports `reach_max_retry_count` afterwards. A response
	 * without an `id` is `retry_id_invalid`.
	 *
	 * Without this the call would simply be left hanging, so the outcome is logged either way.
	 * @param method The command that was deferred.
	 * @param response Whatever the robot answered.
	 */
	public async resolveDeferredResult(method: string, response: unknown): Promise<void> {
		const retryId = readRetryId(response);
		if (retryId === null) return;

		if (retryId === undefined) {
			this.deps.adapter.rLog("Requests", this.duid, "Error", "1.0", undefined, `${method}: the robot answered 'retry' without an id (retry_id_invalid).`, "error");
			return;
		}

		for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
			await this.delay(RETRY_POLL_INTERVAL_MS);

			let result: unknown;
			try {
				result = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "retry_request", {
					retry_id: retryId,
					method,
					retry_count: attempt,
				});
			} catch (e: unknown) {
				this.deps.adapter.rLog("Requests", this.duid, "Error", "1.0", undefined, `${method}: retry_request ${attempt} failed: ${this.deps.adapter.errorMessage(e)}`, "error");
				return;
			}

			if (readRetryId(result) === null) {
				this.deps.adapter.rLog("Requests", this.duid, "Info", "1.0", undefined, `${method} confirmed after ${attempt} retry poll(s).`, "info");
				return;
			}
		}

		this.deps.adapter.rLog("Requests", this.duid, "Error", "1.0", undefined, `${method}: still unconfirmed after ${RETRY_MAX_ATTEMPTS} retry polls (reach_max_retry_count).`, "error");
	}

	/**
	 * Waits through an adapter-owned timer, so a pending poll cannot outlive the adapter.
	 * @param ms Delay in milliseconds.
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = this.deps.adapter.setTimeout(() => resolve(), ms);
			// setTimeout returns undefined once the adapter is shutting down; do not hang in that case.
			if (!timer) resolve();
		});
	}

	/**
	 * Applies the retry envelope when the method needs it and the firmware supports it.
	 * @param method The command being sent.
	 * @param params Payload as the method defines it.
	 * @returns The payload to put on the wire.
	 */
	private async wrap(method: string, params: unknown): Promise<unknown> {
		if (!RETRY_METHODS.has(method)) return params;
		return applyRetryEnvelope(params, await this.isRetrySupported());
	}

	/**
	 * Whether the robot understands the retry envelope.
	 *
	 * `new_feature_info` reaches the adapter as a plain `deviceStatus` state, because `processStatus`
	 * turns every unhandled `get_status` key into one. A robot that does not report the field, or
	 * reports something unreadable, is treated as not supporting the envelope - which is the
	 * documented fallback: send the bare parameters.
	 * @returns True when bit 26 is set.
	 */
	private async isRetrySupported(): Promise<boolean> {
		try {
			const state = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.deviceStatus.new_feature_info`);
			const raw = state?.val;
			if (raw === undefined || raw === null || raw === "") return false;

			const value = typeof raw === "number" ? raw : Number(raw);
			if (!Number.isFinite(value)) return false;

			return (value & RPC_RETRY_FEATURE_BIT) !== 0;
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined, `Could not read new_feature_info, sending bare parameters: ${this.deps.adapter.errorMessage(e)}`, "debug");
			return false;
		}
	}
}
