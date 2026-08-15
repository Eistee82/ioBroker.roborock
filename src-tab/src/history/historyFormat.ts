/**
 * Turns the raw numbers of the history model into text in the user's language.
 *
 * Everything here goes through `Intl`, which is the only way to get "18 Min." in German and
 * "18 min" in English without keeping a second translation table of unit abbreviations. The
 * **values** are never converted: a duration is shown in the unit the adapter declared on the
 * object, because that declaration is the only proof of what the number means (see the module
 * comment of `cleaningHistory.ts`).
 *
 * The one composition this module does perform is splitting a minute count into hours and minutes
 * at 60. That mirrors the Roborock app, whose history row switches its own time unit between `min`
 * and `h` at the same threshold (decompiled a65 control plugin,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`, A65:874395-874410).
 */

import type { HistoryMeasure } from "./historyTypes";

/** Unit the adapter declares on a duration it has already converted to minutes. */
const MINUTE_UNIT = "min";

/** Unit the adapter declares on a lifetime total it has already converted to hours. */
const HOUR_UNIT = "h";

/**
 * Guards every `Intl` call against a language tag the browser rejects.
 *
 * A tab must not go blank over a locale, and `I18n.getLanguage()` is whatever the admin was
 * configured with. An unusable tag falls back to the runtime default, which is still far better
 * than a raw number.
 * @param language Language tag to try.
 * @param build Factory that constructs the formatter for a tag.
 */
function withLocale<T>(language: string, build: (locale: string | undefined) => T): T {
	try {
		return build(language || undefined);
	} catch {
		return build(undefined);
	}
}

/**
 * Formats a plain number in the user's language.
 * @param value Number to format.
 * @param language Admin language.
 * @param maximumFractionDigits Digits to keep; the adapter's own values are already rounded.
 */
export function formatNumber(value: number, language: string, maximumFractionDigits = 2): string {
	return withLocale(language, locale => new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value));
}

/**
 * Formats a value with a localised unit name.
 * @param value Number to format.
 * @param unit A CLDR unit identifier such as `minute` or `hour`.
 * @param language Admin language.
 */
function formatUnit(value: number, unit: string, language: string): string {
	return withLocale(language, locale => {
		try {
			return new Intl.NumberFormat(locale, {
				style: "unit",
				unit,
				unitDisplay: "short",
				maximumFractionDigits: 0,
			}).format(value);
		} catch {
			// A runtime built without the unit data still has to say something sensible.
			return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)} ${unit}`;
		}
	});
}

/**
 * Formats a duration given in minutes, splitting into hours above the hour.
 * @param minutes Whole or fractional minutes.
 * @param language Admin language.
 */
export function formatMinutes(minutes: number, language: string): string {
	const total = Math.max(0, Math.round(minutes));
	if (total < 60) return formatUnit(total, "minute", language);

	const hours = Math.floor(total / 60);
	const rest = total % 60;
	if (rest === 0) return formatUnit(hours, "hour", language);
	return `${formatUnit(hours, "hour", language)} ${formatUnit(rest, "minute", language)}`;
}

/**
 * Formats a measured value together with whatever unit the adapter declared for it.
 *
 * A measure without a declared unit is shown as a bare number. That is deliberate: the B01 and
 * Q10 record fields are the device's raw numbers, and appending a unit to them would be an
 * invention, not a translation.
 * @param measure Value and declared unit.
 * @param language Admin language.
 * @returns The formatted text, or null when nothing was published.
 */
export function formatMeasure(measure: HistoryMeasure, language: string): string | null {
	if (measure.value === null) return null;

	if (measure.unit === MINUTE_UNIT) return formatMinutes(measure.value, language);
	if (measure.unit === HOUR_UNIT) return formatUnit(measure.value, "hour", language);

	const number = formatNumber(measure.value, language);
	return measure.unit ? `${number} ${measure.unit}` : number;
}

/**
 * Formats a field value, which unlike a measure may also be text or a flag.
 * @param value Published value.
 * @param unit Declared unit, possibly empty.
 * @param language Admin language.
 */
export function formatFieldValue(value: string | number | boolean, unit: string, language: string): string {
	if (typeof value === "number") {
		const number = formatNumber(value, language);
		return unit ? `${number} ${unit}` : number;
	}
	if (typeof value === "boolean") return String(value);
	return unit ? `${value} ${unit}` : value;
}

/**
 * Formats the start of a run as date and time of day.
 * @param seconds Unix timestamp in seconds, as the robot reports it.
 * @param language Admin language.
 * @returns The formatted moment, or null when nothing was published.
 */
export function formatRunStart(seconds: number | null, language: string): string | null {
	if (seconds === null) return null;
	return withLocale(language, locale =>
		new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(seconds * 1000)),
	);
}

/**
 * Formats the start of a run for the narrow list row: the day, then the time.
 *
 * Separate from {@link formatRunStart} because a list of twenty rows in a 320 px panel cannot
 * carry a full medium date per row, and because the app's own list shows exactly this - day and
 * time, no year (A65:874437-874470 builds `MM/DD  HH:mm`). The order and the separators are left
 * to `Intl` rather than hard-coded to Roborock's American form.
 * @param seconds Unix timestamp in seconds.
 * @param language Admin language.
 */
export function formatRunStartShort(seconds: number | null, language: string): string | null {
	if (seconds === null) return null;
	const date = new Date(seconds * 1000);
	return withLocale(language, locale => {
		const day = new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit" }).format(date);
		const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
		return `${day} ${time}`;
	});
}
