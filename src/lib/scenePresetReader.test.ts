import { describe, expect, it } from "vitest";
import type { Scene } from "./httpApi";
import type { ScenePresetEntry } from "../common/scenePresets";
import { applySceneValidity, parseSceneValidTids, readScenePreset, readSceneSteps } from "./scenePresetReader";

/**
 * Reading a Roborock scene.
 *
 * Everything below is fed the **measured** payload of `_appanalysis/szenen-roh.json` rather than a
 * hand-written one, because the shape is the whole difficulty: three levels of JSON, two of them
 * arriving as strings, and a `params` that is an object for two of the three RPCs and a bare array
 * for the third.
 *
 * The two traps this file exists for, both measured:
 *
 *  - `action.items[].name` is **empty** for a zone scene, so the name must come from the outer level;
 *  - a scene can address more than one robot, so the duid belongs to the step, not to the scene.
 */

/** "Kamin" - a zone scene. Note the empty inner name. */
const KAMIN: Scene = {
	id: 12101885,
	name: "Kamin",
	enabled: true,
	param: JSON.stringify({
		triggers: [],
		action: {
			type: "S",
			items: [{
				id: 1,
				type: "CMD",
				name: "",
				entityId: "67KzM8ybBHWgoNCEydAQW2",
				param: JSON.stringify({
					id: 1,
					method: "do_scenes_zones",
					params: {
						data: [{
							tid: "1767377550650", zones: [{ zid: 1, repeat: 1 }], map_flag: 0,
							fan_power: 108, water_box_mode: 200, mop_mode: 300, mop_template_id: 300,
							repeat: 1, clean_order_mode: 1, auto_dry: 1, auto_dustCollection: 1, region_num: 0
						}],
						source: 101
					}
				}),
				finishDpIds: [130]
			}]
		},
		matchType: "NONE",
		tagId: "1002"
	})
};

/** "Küche" - a segment scene, whose inner name happens to be filled. */
const KUECHE: Scene = {
	id: 7085747,
	name: "Küche",
	enabled: true,
	param: JSON.stringify({
		triggers: [],
		action: {
			type: "S",
			items: [{
				id: 1, type: "CMD", name: "Küche", entityId: "67KzM8ybBHWgoNCEydAQW2",
				param: JSON.stringify({
					id: 1,
					method: "do_scenes_segments",
					params: { data: [{ tid: "1745006632377", segs: [{ sid: 18 }], map_flag: 0, fan_power: 104, water_box_mode: 203, mop_mode: 300, repeat: 1 }], source: 101 }
				}),
				finishDpIds: [130]
			}]
		}
	})
};

/** "Saugen, dann Wischen" - two steps on a second robot, and `params` as a bare array. */
const ZWEISTUFIG: Scene = {
	id: 4841021,
	name: "Saugen, dann Wischen",
	enabled: true,
	param: JSON.stringify({
		triggers: [],
		action: {
			type: "S",
			items: [
				{
					id: 1, type: "CMD", name: "", entityId: "4mEMuyGdTP28bruRytBmAM",
					param: JSON.stringify({ id: 1, method: "do_scenes_app_start", params: [{ fan_power: 108, water_box_mode: 200, mop_mode: 300, repeat: 1, source: 101 }] })
				},
				{
					id: 2, type: "CMD", name: "", entityId: "4mEMuyGdTP28bruRytBmAM",
					param: JSON.stringify({ id: 2, method: "do_scenes_app_start", params: [{ fan_power: 105, water_box_mode: 203, mop_mode: 300, repeat: 1, source: 101 }] })
				}
			]
		}
	})
};

describe("readSceneSteps", () => {
	it("walks all three levels of the measured zone scene", () => {
		expect(readSceneSteps(KAMIN)).toEqual([{
			duid: "67KzM8ybBHWgoNCEydAQW2",
			step: {
				method: "do_scenes_zones", tid: "1767377550650", target: "zone", targetIds: [1],
				mapFlag: 0, fanPower: 108, waterBoxMode: 200, mopMode: 300, repeat: 1, mode: "vacuum"
			}
		}]);
	});

	it("reads the segment ids of a segment scene", () => {
		expect(readSceneSteps(KUECHE)[0].step).toMatchObject({ target: "segment", targetIds: [18], mode: "vacmop" });
	});

	it("reads a bare-array params, which only do_scenes_app_start uses", () => {
		// The shape differs from the other two RPCs, and unwrapping by structure rather than by method
		// name is what makes this work without a special case.
		const steps = readSceneSteps(ZWEISTUFIG);
		expect(steps).toHaveLength(2);
		expect(steps[0].step).toMatchObject({ target: "all", targetIds: [], tid: null, mode: "vacuum" });
		expect(steps[1].step).toMatchObject({ target: "all", mode: "mop" });
	});

	it("reads every entry of data, not only the first", () => {
		// The measured scenes carry one, but `data` is an array in the payload. Reading only `[0]` is
		// the mistake the map block readers had to be repaired from.
		const scene: Pick<Scene, "param"> = {
			param: JSON.stringify({
				action: {
					items: [{
						type: "CMD", entityId: "d1",
						param: JSON.stringify({ method: "do_scenes_segments", params: { data: [{ tid: "a", segs: [{ sid: 1 }] }, { tid: "b", segs: [{ sid: 2 }] }] } })
					}]
				}
			})
		};
		expect(readSceneSteps(scene).map(entry => entry.step.tid)).toEqual(["a", "b"]);
	});

	it("survives every level being unreadable", () => {
		expect(readSceneSteps({ param: "" })).toEqual([]);
		expect(readSceneSteps({ param: "not json" })).toEqual([]);
		expect(readSceneSteps({ param: JSON.stringify({ action: { items: "no" } }) })).toEqual([]);
		// An item whose inner payload cannot be decoded is skipped, not published as an empty command.
		expect(readSceneSteps({ param: JSON.stringify({ action: { items: [{ type: "CMD", param: "broken" }] } }) })).toEqual([]);
		// An item without a method has nothing to send.
		expect(readSceneSteps({ param: JSON.stringify({ action: { items: [{ type: "CMD", param: JSON.stringify({ params: {} }) }] } }) })).toEqual([]);
	});

	it("ignores an item that is not a command", () => {
		const scene: Pick<Scene, "param"> = {
			param: JSON.stringify({ action: { items: [{ type: "DELAY", param: JSON.stringify({ method: "wait" }) }] } })
		};
		expect(readSceneSteps(scene)).toEqual([]);
	});
});

describe("readScenePreset", () => {
	it("takes the name from the outer level, where a zone scene also has one", () => {
		// The inner `name` of "Kamin" is the empty string. Reading that one is the measured trap.
		const rows = readScenePreset(KAMIN);
		expect(rows.get("67KzM8ybBHWgoNCEydAQW2")?.name).toBe("Kamin");
	});

	it("keys the row by the device the step names, not by the first item of the scene", () => {
		const rows = readScenePreset(ZWEISTUFIG);
		expect([...rows.keys()]).toEqual(["4mEMuyGdTP28bruRytBmAM"]);
		expect(rows.get("4mEMuyGdTP28bruRytBmAM")?.steps).toHaveLength(2);
	});

	it("splits a scene that addresses two robots into one row each", () => {
		const scene: Scene = {
			id: 5, name: "Beide", enabled: true,
			param: JSON.stringify({
				action: {
					items: [
						{ type: "CMD", entityId: "d1", param: JSON.stringify({ method: "do_scenes_app_start", params: [{ fan_power: 104, water_box_mode: 203 }] }) },
						{ type: "CMD", entityId: "d2", param: JSON.stringify({ method: "do_scenes_app_start", params: [{ fan_power: 104, water_box_mode: 203 }] }) }
					]
				}
			})
		};
		const rows = readScenePreset(scene);
		expect([...rows.keys()].sort()).toEqual(["d1", "d2"]);
		expect(rows.get("d1")?.steps).toHaveLength(1);
	});

	it("uses the fallback device for a step that names none", () => {
		const scene: Scene = {
			id: 6, name: "Ohne", enabled: false,
			param: JSON.stringify({ action: { items: [{ type: "CMD", param: JSON.stringify({ method: "do_scenes_app_start", params: [{}] }) }] } })
		};
		expect([...readScenePreset(scene, "fallback").keys()]).toEqual(["fallback"]);
		// Without one there is no row at all, rather than a row attributed to a guess.
		expect(readScenePreset(scene).size).toBe(0);
	});

	it("carries enabled through and starts every row unchecked", () => {
		const rows = readScenePreset(KUECHE);
		expect(rows.get("67KzM8ybBHWgoNCEydAQW2")).toMatchObject({ enabled: true, valid: null });
	});

	it("drops a scene without an id", () => {
		expect(readScenePreset({ id: null as unknown as number, name: "x", enabled: true, param: KAMIN.param }).size).toBe(0);
	});
});

describe("parseSceneValidTids", () => {
	/** The answer of the test device, identical across the two measured runs. */
	const MEASURED = [
		{ tid: "1745006530591", map_flag: 0, zones: [{ zid: 0 }] },
		{ tid: "1745006747490", map_flag: 0, segs: [{ sid: 19 }] },
		{ tid: "1745006632377", map_flag: 0, segs: [{ sid: 18 }] },
		{ tid: "1767377550650", map_flag: 0, zones: [{ zid: 1 }] }
	];

	it("reads the measured answer", () => {
		expect(parseSceneValidTids(MEASURED)).toEqual(["1745006530591", "1745006747490", "1745006632377", "1767377550650"]);
	});

	it("unwraps the two shapes the transports produce", () => {
		expect(parseSceneValidTids({ data: MEASURED })).toHaveLength(4);
		expect(parseSceneValidTids([MEASURED])).toHaveLength(4);
	});

	it("tells 'no scene targets' from 'no answer'", () => {
		// The empty list is the robot speaking and may mark programs invalid. Everything else is
		// silence and must not.
		expect(parseSceneValidTids([])).toEqual([]);
		expect(parseSceneValidTids("unknown_method")).toBeNull();
		expect(parseSceneValidTids(null)).toBeNull();
		expect(parseSceneValidTids(undefined)).toBeNull();
		expect(parseSceneValidTids({ error: "timeout" })).toBeNull();
	});

	it("accepts a numeric tid but keeps it as text", () => {
		expect(parseSceneValidTids([{ tid: 1767377550650 }])).toEqual(["1767377550650"]);
	});
});

describe("applySceneValidity", () => {
	/** One row with the given tids, and nothing else that matters here. */
	const rowWith = (tids: Array<string | null>): ScenePresetEntry => ({
		id: "1", name: "x", enabled: true, valid: null,
		steps: tids.map(tid => ({
			method: "do_scenes_zones", tid, target: "zone" as const, targetIds: [], mapFlag: null,
			fanPower: null, waterBoxMode: null, mopMode: null, repeat: null, mode: null
		}))
	});

	it("marks a program the robot still knows", () => {
		const rows = [rowWith(["1767377550650"])];
		applySceneValidity(rows, ["1767377550650", "1745006632377"]);
		expect(rows[0].valid).toBe(true);
	});

	it("marks a program whose target the robot has forgotten", () => {
		const rows = [rowWith(["1767377550650"])];
		applySceneValidity(rows, ["1745006632377"]);
		expect(rows[0].valid).toBe(false);
	});

	it("needs every step, not any", () => {
		// A two-step program whose second target is gone runs half way and stops. Calling that valid
		// would put a green row on a program that cannot finish.
		const rows = [rowWith(["a", "b"])];
		applySceneValidity(rows, ["a"]);
		expect(rows[0].valid).toBe(false);
	});

	it("leaves a program of unverifiable steps unchecked", () => {
		// `do_scenes_app_start` names no tid, so there is nothing to compare - and "nothing was
		// checked" is not "the robot said no".
		const rows = [rowWith([null, null])];
		applySceneValidity(rows, ["a"]);
		expect(rows[0].valid).toBeNull();
	});

	it("touches nothing when the robot did not answer", () => {
		const rows = [rowWith(["a"])];
		applySceneValidity(rows, null);
		expect(rows[0].valid).toBeNull();
	});
});
