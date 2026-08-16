/**
 * How long a **map** name may be, and how the app measures it.
 *
 * Here rather than beside `name_multi_map` for the same reason `MAX_ROOM_NAME_LENGTH` is here: the
 * admin tab has to refuse at exactly the place the adapter refuses, and it cannot import a feature
 * service. The rest of the rename - payload, validation against the map list, the verdict - lives
 * in `src/lib/features/vacuum/v1MapRename.ts`, and its file comment carries the derivation.
 *
 * **This is not the room-name rule, although both numbers are 30.** Rooms: 30 *characters*,
 * inclusive. Maps: fewer than 30 *bytes* as counted below. Testing with ASCII would never tell the
 * two apart, which is why they are two constants in the same folder rather than one shared by
 * both.
 *
 * Line numbers marked A65 refer to the decompiled control plugin of the test device,
 * `_appanalysis/plugins/a65_control_v5208/index.android.bundle.decompiled.js`.
 */

/**
 * Longest map name the app lets through, in the units {@link mapNameLength} counts - **exclusive**.
 *
 * `if (len < 30)` at A65:920030-920036, and the same test again in the second naming dialog at
 * A65:722930-722934; both jump to the `floor_map_name_too_long` toast when it fails. A `<=` here
 * would let through the one length the app stops at.
 */
export const MAX_MAP_NAME_LENGTH = 30;

/**
 * The app's own byte count for a name, ported instruction by instruction from `getRealLength`.
 *
 * The original walks UTF-16 code units and adds per unit (A65:418603-418660):
 *
 * | code unit | adds |
 * | --- | --- |
 * | `<= 128` | 1 |
 * | `< 2048` | 2 |
 * | `< 0xD800` | 3 |
 * | `< 0xDC00` (high surrogate) | 4 |
 * | otherwise | 3 |
 *
 * **Close to UTF-8, not equal to it, and the difference is kept on purpose.** A real UTF-8 encoder
 * needs two bytes for U+0080 where this adds one, and four bytes for a whole surrogate pair where
 * this adds 4 + 3 = 7. The robot echoes this very number back - `get_multi_maps_list` on the test
 * device answers `{"name":"Erdgeschoss","length":11}` and `{"name":"Keller","length":6}`, which is
 * what this computes - and the firmware limit was written against this counter. So
 * `Buffer.byteLength(name, "utf8")` would be the *more correct* function and the *wrong* one.
 *
 * @param text The name.
 * @returns The length the app would send alongside it.
 */
export function mapNameLength(text: string): number {
	let total = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit <= 128) total += 1;
		else if (unit < 2048) total += 2;
		else if (unit < 0xd800) total += 3;
		else if (unit < 0xdc00) total += 4;
		else total += 3;
	}
	return total;
}

/**
 * Whether a name may be sent as a map name.
 *
 * @param text The name, already trimmed.
 * @returns True when it is neither empty nor at or past the limit.
 */
export function isMapNameAcceptable(text: string): boolean {
	return text.length > 0 && mapNameLength(text) < MAX_MAP_NAME_LENGTH;
}
