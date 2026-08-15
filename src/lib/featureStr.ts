/**
 * Reading `new_feature_info_str`, one of the robot's two independent feature bitfields.
 *
 * ## The two bitfields are not one value in two encodings
 *
 * This is the point to get right, because getting it wrong looks harmless and is not. The robot
 * announces **two** bitfields, and they are separate spaces with separate meanings:
 *
 * | Field | Type | Read through | Filled at |
 * | --- | --- | --- | --- |
 * | `new_feature_info` | number, bits 0…51 observed | `robotNewFeatures` | A65:5794-5795 |
 * | `new_feature_info_str` | hex string, bits 0…87 named | `newFeatureInfoStr` | A65:5804-5805 |
 *
 * `new_feature_info_str` is **not** the continuation of `new_feature_info` above bit 31, and
 * `new_feature_info` does **not** stop at bit 31 - the app reaches its high bits by dividing
 * (`(robotNewFeatures / Math.pow(2, 32)) >> s & m`, e.g. `isSupportFurniture` = bit 36 at
 * A65:234000-234037), precisely because JavaScript's bit operators would truncate there.
 *
 * The same bit index means different things in the two fields. Measured on the test device
 * (`_appanalysis/24-faehigkeitsmerkmale.md` §7.1), where the two carry genuinely different values:
 *
 * | Bit | in `new_feature_info` | in `new_feature_info_str` |
 * | --- | --- | --- |
 * | 45 | `isSupportedValleyElectricity` - **set** | `MopShakeWaterMax` - **clear** |
 * | 31 | `isCustomWaterBoxDistanceSupported` | `isCornerCleanModeSupported` |
 *
 * So bit 45 decides two unrelated things, and on the reference robot it decides them in opposite
 * directions. Reading the water level *Extreme* out of `new_feature_info` instead of the string
 * would offer a level the robot drops - the exact dead control that gate was built to prevent.
 * **Never treat one field as a source for the other, and never merge them.**
 *
 * Roborock names the string's bits from 32 upwards in one table, `NewFeatureStrBit`
 * (A65:231849); its bits 0…31 carry a further, unnamed set that the app only reaches through
 * predicate functions. `new_feature_info` has no name table at all.
 *
 * ## How the app tests a bit of the string
 *
 * It copies the field verbatim (`DM.newFeatureInfoStr = result[…].new_feature_info_str`, control
 * plugin `a65_control_v5208` line 5804) and tests single bits through
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
 * ## Where the value has to come from - and where it does not
 *
 * Both fields are answered by **`app_get_init_status`** (A65:5765-5805), together with
 * `feature_info` and `local_info.featureset`. On the reference robot they are **not** part of
 * `get_status`: its status packet has 51 fields and carries neither, measured twice nearly five
 * hours apart (`_appanalysis/geraetefaehigkeiten-1786790619395.json` and `…-1786807834553.json`).
 *
 * Callers that read them out of `Devices.<duid>.deviceStatus.*` therefore find nothing on that
 * robot, because `processResultKey` only ever creates those states out of a `get_status` answer.
 * That is a live defect, tracked separately; it is recorded here so the next reader does not spend
 * the same afternoon on it. It is **not** a reason to fall back to `new_feature_info` for a bit of
 * the string - see the table above.
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
