/**
 * The two lengths the whole 3D view is measured in.
 *
 * A module of its own, and it imports nothing - which is the point. `map3dModel` pulls in
 * `walls`, `furniture3d` and `zones3d`, and each of those needs a unit back from it. That is a
 * cycle, and a cycle is harmless only as long as nothing reads across it **while the modules are
 * still being evaluated**.
 *
 * `zones3d` did exactly that: `export const ZONE_HEIGHT = WALL_HEIGHT_CELLS` runs at import time,
 * and with the cycle in place the constant was still in its temporal dead zone. The zones came out
 * with a height of `undefined`, which three.js turns into a box of no height at all - invisible,
 * with no error anywhere. Functions that read the same constant *when called* were unaffected,
 * which is why only one of the three modules broke and why it would have been easy to blame the
 * renderer.
 */

/** Millimetres one map cell covers. */
export const MM_PER_CELL = 50;

/**
 * Wall height in cells; the app's own constant.
 *
 * `com/roborock/smart/react/mapv2/view/C4192OooO0oo.java:174` extrudes every wall to 10 world units
 * at one unit per cell, so 500 mm. Zones and virtual walls use the same height, which is what makes
 * a zone read as a barrier rather than as a rug.
 */
export const WALL_HEIGHT_CELLS = 10;
