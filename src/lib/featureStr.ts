/**
 * Reading `new_feature_info_str`, the hex string that carries the robot's feature bits above 31.
 *
 * The robot reports two feature fields in `get_status`. `new_feature_info` is a plain number and
 * therefore stops at bit 31; `new_feature_info_str` is a hex string and carries everything beyond
 * it. The app copies the field verbatim (`DM.newFeatureInfoStr = result[…].new_feature_info_str`,
 * control plugin `a65_control_v5208` line 5804) and tests single bits of it through
 * `isNewFeatureStrSupport(bit)` (line 237242).
 *
 * That function does not shift a big integer - it addresses one hex character:
 *
 * ```js
 * const nibble = Math.floor(bit / 4);                       // counted from the end of the string
 * const chunk  = nibble !== 0 ? str.slice(-nibble - 1, -nibble) : str.slice(-1);
 * return !!((parseInt("0x" + (chunk || "0")) >> (bit % 4)) & 1);
 * ```
 *
 * The two are equivalent, including the short-string case: a nibble index past the start of the
 * string makes `slice` return `""`, which the app reads as `0`, and shifting a correspondingly
 * small integer yields `0` as well. Testing the whole value is used here because it is the
 * shorter expression of the same rule.
 *
 * This module deliberately imports nothing. Both the map code and the vacuum services need the
 * reader, and any home inside one of them would either close an import cycle or force the other
 * side to copy the arithmetic - which is what happened before.
 */

/**
 * Parses `new_feature_info_str` into the number it denotes.
 *
 * @param raw Value of `Devices.<duid>.deviceStatus.new_feature_info_str`.
 * @returns The value, or `null` when the field is absent or not a hex string. `null` means "the
 *          robot did not tell us", which is a different answer from "the bit is not set" - callers
 *          that would take something away from the user have to distinguish the two.
 */
export function readFeatureStr(raw: unknown): bigint | null {
	if (typeof raw !== "string") return null;
	const hex = raw.trim().replace(/^0x/i, "");
	if (hex.length === 0 || !/^[0-9a-f]+$/i.test(hex)) return null;

	try {
		return BigInt(`0x${hex}`);
	} catch {
		return null;
	}
}

/**
 * Tests a single bit of `new_feature_info_str`.
 *
 * @param raw Value of the state, a hex string.
 * @param bit Bit index, counted from the least significant bit.
 * @returns True when the bit is provably set. An absent or unreadable value counts as false, so
 *          this answers "does the robot have it" and not "did the robot say". Use
 *          {@link readFeatureStr} where the difference matters.
 */
export function hasFeatureStrBit(raw: unknown, bit: bigint): boolean {
	const value = readFeatureStr(raw);
	return value !== null && ((value >> bit) & 1n) === 1n;
}
