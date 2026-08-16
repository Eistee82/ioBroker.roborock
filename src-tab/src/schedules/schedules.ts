/**
 * The schedules of one robot, built out of the objects the adapter published.
 *
 * ## Why a robot has two kinds of schedule, and why the panel has to carry both
 *
 * A robot keeps its schedules either in its own memory or on Roborock's server, and which one it
 * does is not a property of the model: the app computes a flag out of a bit of `local_info.featureset`
 * and branches on it (`_appanalysis/20-zeitplaene.md` §1). On the only robot measured here that bit is
 * set, `get_timer` answers `[]` and every schedule comes out of `get_server_timer`. A panel written
 * around device timers would therefore be empty on the very robot it was written for.
 *
 * The adapter records which of the two lists produced an entry as `schedules.<id>.source`, and this
 * module reads that rather than deriving it again - see `src/lib/features/vacuum/timerDeletion.ts`
 * for the proof chain behind both delete commands.
 *
 * ## What decides whether a control is offered
 *
 * The objects, never a model table. A switch appears where the adapter published a **writable**
 * `enabled`, a delete appears where it published the `delete` button, and both additionally require a
 * recorded `source`. That second condition is not decoration: `schedules.<id>` is written by two
 * unrelated code paths, and the B01/Q10 one builds it out of Tuya data points that neither
 * `upd_timer` nor `del_timer` reaches. `main.ts` refuses to delete such a schedule for exactly this
 * reason; offering a control the adapter would refuse is the dead control this project keeps removing.
 *
 * ## What is deliberately not here
 *
 * A way to create or edit a schedule. The adapter has none: `set_timer` is not implemented anywhere,
 * and for a server-side schedule the times, rooms and modes do not even live in the robot - they are
 * held in the Roborock account and are not readable over the local channel. A "new schedule" button
 * would be a promise nothing behind it can keep, so the panel says so in words instead.
 */

/** Folder the schedules of a device live in. */
export const SCHEDULES_FOLDER = "schedules";

/** Where a schedule is kept, as the adapter recorded it beside the entry. */
export type ScheduleSource = "device" | "server" | "unknown";

/** When a schedule runs, as far as it could be read. */
export interface ScheduleTiming {
	/** Start time as `HH:MM`. */
	time: string;
	/**
	 * Weekdays it repeats on, ascending, **0 = Sunday**.
	 *
	 * Empty means the schedule names no weekday at all, which together with a date means "once" and
	 * without one means "every day" - see {@link parseTimerCron}.
	 */
	weekdays: number[];
	/** Day of the month for a one-off schedule, or null. */
	dayOfMonth: number | null;
	/** Month (1-12) for a one-off schedule, or null. */
	month: number | null;
}

/** One schedule of one robot. */
export interface ScheduleEntry {
	/** Identifier the robot reported, which is also the folder it sits in. */
	id: string;
	source: ScheduleSource;
	/** Whether it is switched on, or null while nothing has been read. */
	enabled: boolean | null;
	/** Whether this build may offer a switch for it. */
	canToggle: boolean;
	/** Whether this build may offer to delete it. */
	canDelete: boolean;
	/** When it runs, or null when that could not be read. */
	timing: ScheduleTiming | null;
	/**
	 * What the robot published about its time when {@link timing} could not be made of it.
	 *
	 * Shown verbatim rather than interpreted. A schedule whose cron this build does not understand is
	 * still a schedule the user has, and printing the robot's own text is the one thing that cannot be
	 * wrong about it.
	 */
	rawTime: string | null;
}

/** Everything the schedules panel shows for one robot. */
export interface SchedulesModel {
	entries: ScheduleEntry[];
	/** True when at least one entry can be neither switched nor deleted from here. */
	hasReadOnly: boolean;
}

/** The slice of an ioBroker state value this branch reads. */
export interface ScheduleStateValue {
	val: unknown;
}

/** The slice of an ioBroker state object this branch reads. */
export interface ScheduleStateDefinition {
	id: string;
	common?: {
		type?: unknown;
		role?: unknown;
		write?: unknown;
	};
}

/**
 * Root of the schedules branch of one device.
 * @param instanceId Adapter instance, e.g. `roborock.0`.
 * @param duid Device id.
 * @returns Full object id of the folder.
 */
export function schedulesRoot(instanceId: string, duid: string): string {
	return `${instanceId}.Devices.${duid}.${SCHEDULES_FOLDER}`;
}

/** Reads an integer written out in full; a step, a range or anything else is rejected rather than truncated. */
function strictInt(text: string, min: number, max: number): number | null {
	if (!/^\d{1,2}$/.test(text)) return null;
	const value = Number(text);
	return value >= min && value <= max ? value : null;
}

/** Two digits, so `7:5` never reaches the panel as a time. */
function pad(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/**
 * Reads the weekday field of a Roborock cron expression.
 *
 * The app's own reader splits it on `,` and runs `parseInt` over each part (`_closure1_slot6`,
 * A65:445258-445292); `*` yields an empty list there. This one is stricter on purpose: `parseInt`
 * turns `1-3` into 1, and a schedule shown on the wrong day is worse than one shown as unreadable.
 *
 * @param field The fifth field of the expression.
 * @returns The weekdays, ascending and without duplicates, or null when the field is not a plain list.
 */
function parseWeekdayField(field: string): number[] | null {
	const parts = field.split(",");
	const days = new Set<number>();
	for (const part of parts) {
		const day = strictInt(part, 0, 6);
		if (day === null) return null;
		days.add(day);
	}
	return [...days].sort((left, right) => left - right);
}

/**
 * Reads a Roborock timer cron expression.
 *
 * The field order is not guessed. `ConvertToReadableFormat` (A65:445626-445686) splits the string on
 * spaces and takes `minute`, `hour`, `dateofmonth`, `month` and the repeat from indices 0 to 4, with
 * `*` standing for "not set" in the two date fields. The weekday numbering comes from the other
 * direction of the same conversion: `ConvertToCronStr` writes out the indices of a seven element
 * array (A65:445525-445560), and that array is filled by `arr[getDay()] = 1`
 * (`cronRepeatToTimerRepeat`, A65:446606-446660) - JavaScript's `getDay`, so **index 0 is Sunday**.
 * Its named sets agree: weekends are `[1,0,0,0,0,0,1]`, weekdays `[0,1,1,1,1,1,0]`.
 *
 * @param cron The expression as the robot published it.
 * @returns What it says, or null when it is not an expression of this shape.
 */
export function parseTimerCron(cron: string): ScheduleTiming | null {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return null;

	const minute = strictInt(parts[0]!, 0, 59);
	const hour = strictInt(parts[1]!, 0, 23);
	if (minute === null || hour === null) return null;

	const dayOfMonth = parts[2] === "*" ? null : strictInt(parts[2]!, 1, 31);
	if (parts[2] !== "*" && dayOfMonth === null) return null;

	const month = parts[3] === "*" ? null : strictInt(parts[3]!, 1, 12);
	if (parts[3] !== "*" && month === null) return null;

	const weekdays = parts[4] === "*" ? [] : parseWeekdayField(parts[4]!);
	if (weekdays === null) return null;

	return { time: `${pad(hour)}:${pad(minute)}`, weekdays, dayOfMonth, month };
}

/**
 * Reads the weekday list a B01/Q10 schedule carries as JSON.
 *
 * Same numbering as the cron field above, and that is the adapter's own doing rather than a
 * coincidence: `Q10ShadowDataService.q10WeekDataToWeekArray` maps bit 6 to 0 and bits 0 to 5 to 1
 * through 6, so both kinds of schedule reach this module counting from Sunday.
 *
 * @param raw Value of the `weeks` state.
 * @returns The weekdays, or null when the value is not such a list.
 */
export function parseWeekList(raw: unknown): number[] | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;

	const days = new Set<number>();
	for (const entry of parsed) {
		if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 6) return null;
		days.add(entry);
	}
	return [...days].sort((left, right) => left - right);
}

/** True for a `HH:MM` a robot published as its start time. */
function isTimeOfDay(value: unknown): value is string {
	return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Reads one string state value, or null. */
function textOf(values: Record<string, ScheduleStateValue | null | undefined>, id: string): string | null {
	const value = values[id]?.val;
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Turns the recorded source into one of the three cases.
 *
 * Anything that is not one of the two words the adapter writes counts as unknown, including a missing
 * state. That is the same reading `main.ts` applies before it deletes anything.
 * @param raw Value of the `source` state.
 */
function readSource(raw: string | null): ScheduleSource {
	if (raw === "device" || raw === "server") return raw;
	return "unknown";
}

/** True for an object the adapter published as a writable boolean button. */
function isWritableButton(definition: ScheduleStateDefinition | undefined): boolean {
	return definition?.common?.type === "boolean" && definition.common.role === "button" && definition.common.write === true;
}

interface BuildSchedulesInput {
	/** Root of the schedules branch, from {@link schedulesRoot}. */
	root: string;
	/** Every state object below that root. */
	definitions: ScheduleStateDefinition[];
	/** Their values. */
	values: Record<string, ScheduleStateValue | null | undefined>;
}

/**
 * Builds what the panel shows out of the objects and their values.
 *
 * Only the two levels the adapter really writes are read - `schedules.<id>.<leaf>` - so a deeper id
 * cannot invent a schedule. Everything else this module knows about a schedule follows from the
 * objects; nothing is inferred from the identifier or the model.
 *
 * @param input Root, objects and values.
 * @returns The model, with the entries sorted by their start time.
 */
export function buildSchedules(input: BuildSchedulesInput): SchedulesModel {
	const { root, definitions, values } = input;
	const prefix = `${root}.`;

	const byId = new Map<string, Map<string, ScheduleStateDefinition>>();
	for (const definition of definitions) {
		if (!definition.id.startsWith(prefix)) continue;
		const rest = definition.id.slice(prefix.length).split(".");
		if (rest.length !== 2) continue;
		const [id, leaf] = rest as [string, string];
		if (!id || !leaf) continue;

		let leaves = byId.get(id);
		if (!leaves) {
			leaves = new Map<string, ScheduleStateDefinition>();
			byId.set(id, leaves);
		}
		leaves.set(leaf, definition);
	}

	const entries: ScheduleEntry[] = [];
	for (const [id, leaves] of byId) {
		const source = readSource(textOf(values, `${prefix}${id}.source`));

		const enabledDefinition = leaves.get("enabled");
		const enabledValue = enabledDefinition ? values[enabledDefinition.id]?.val : undefined;
		const enabled = typeof enabledValue === "boolean" ? enabledValue : null;

		const cron = leaves.has("cron") ? textOf(values, `${prefix}${id}.cron`) : null;
		let timing = cron === null ? null : parseTimerCron(cron);
		let rawTime = timing === null ? cron : null;

		// No cron, but a start time of its own: that is how the B01/Q10 pipeline publishes a
		// schedule. Read rather than converted, because there is nothing to convert.
		if (timing === null) {
			const time = values[`${prefix}${id}.time`]?.val;
			if (isTimeOfDay(time)) {
				timing = { time, weekdays: parseWeekList(values[`${prefix}${id}.weeks`]?.val) ?? [], dayOfMonth: null, month: null };
				rawTime = null;
			}
		}

		// A switch is offered where the adapter made `enabled` writable **and** recorded where the
		// schedule lives. The second half is what keeps the B01/Q10 entries out: their `enabled` is
		// published as writable, but a write there sends `upd_timer` - a V1 command - to a robot that
		// speaks Tuya data points, which is a control that looks alive and does nothing.
		const canToggle = enabledDefinition?.common?.write === true && source !== "unknown";

		entries.push({
			id,
			source,
			enabled,
			canToggle,
			canDelete: isWritableButton(leaves.get("delete")) && source !== "unknown",
			timing,
			rawTime,
		});
	}

	// By the time of day, because that is the order a person reads a list of schedules in. Entries
	// whose time could not be read go last rather than to an invented place in between.
	entries.sort((left, right) => {
		// A code point above anything a `HH:MM` contains, so an unreadable time sorts to the end
		// without a second comparison.
		const leftTime = left.timing?.time ?? "￿";
		const rightTime = right.timing?.time ?? "￿";
		if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
		return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
	});

	return { entries, hasReadOnly: entries.some(entry => !entry.canToggle && !entry.canDelete) };
}

/**
 * Reference week whose 1 January is a Sunday, so `Date.getDay()` and the array index agree.
 *
 * 1 January 2023 was a Sunday. Formatting in UTC keeps it that way in every time zone; a local date
 * would slide by a day west of Greenwich and label Sunday as Saturday.
 */
const WEEKDAY_REFERENCE_YEAR = 2023;

/**
 * The short weekday names of a language, indexed the way this module counts: 0 is Sunday.
 *
 * Taken from the browser rather than from a table of eleven languages, because a table would be a
 * second source of weekday names beside the one every other date on this page already uses.
 *
 * @param language Admin language.
 * @returns Seven names, index 0 being Sunday.
 */
export function weekdayNames(language: string): string[] {
	const format = new Intl.DateTimeFormat(language || "en", { weekday: "short", timeZone: "UTC" });
	return Array.from({ length: 7 }, (_unused, index) => format.format(new Date(Date.UTC(WEEKDAY_REFERENCE_YEAR, 0, 1 + index))));
}

/**
 * Says in words when a schedule runs.
 *
 * The three cases are the app's own, read off the two directions of its cron conversion: a list of
 * weekdays repeats on them, `*` in the weekday field together with a date is the one-off case its
 * `CodeOnce` branch writes (A65:445640-445661), and `*` with no date is the plain cron reading of
 * "every day".
 *
 * @param timing What was read off the schedule.
 * @param language Admin language, for the weekday and month names.
 * @param t Translation lookup.
 * @returns The sentence, or the empty string when there is nothing to say.
 */
export function describeRepetition(timing: ScheduleTiming, language: string, t: (key: string) => string): string {
	if (timing.weekdays.length === 7) return t("ui_schedules_every_day");

	if (timing.weekdays.length > 0) {
		const names = weekdayNames(language);
		return timing.weekdays.map(day => names[day] ?? String(day)).join(", ");
	}

	if (timing.dayOfMonth !== null && timing.month !== null) {
		// The year is not part of the expression, so it is not shown either. A leap year is used so
		// that 29 February formats rather than rolling into March.
		const date = new Date(Date.UTC(2024, timing.month - 1, timing.dayOfMonth));
		const text = new Intl.DateTimeFormat(language || "en", { day: "numeric", month: "long", timeZone: "UTC" }).format(date);
		return t("ui_schedules_once").replace("%s", text);
	}

	if (timing.dayOfMonth !== null || timing.month !== null) {
		// Half a date is not a date. Saying "once" without pretending to know which day is the honest
		// half of what could be read.
		return t("ui_schedules_once").replace("%s", "").trim();
	}

	return t("ui_schedules_every_day");
}
