import { describe, expect, it } from "vitest";
import {
	UNKNOWN_MAP_FLAG,
	enrichSegmentNamesFromRoomStates,
	floorFolderId,
	floorScopeKey,
	normalizeMapFlag,
	normalizeRoomId,
	roomNameCacheKey,
	roomStateId,
	toDisplayName
} from "./roomKey";

describe("roomKey: composite (mapFlag, roomId)", () => {
	it("builds object ids from both parts", () => {
		expect(floorFolderId("duid1", 1)).to.equal("Devices.duid1.floors.1");
		expect(roomStateId("duid1", 1, 16)).to.equal("Devices.duid1.floors.1.16");
	});

	it("keeps identical room ids on different maps apart (object ids)", () => {
		expect(roomStateId("duid1", 0, 16)).to.not.equal(roomStateId("duid1", 1, 16));
	});

	it("keeps identical room ids on different maps apart (cache keys)", () => {
		expect(roomNameCacheKey("duid1", 0, 16)).to.equal("duid1.0.16");
		expect(roomNameCacheKey("duid1", 1, 16)).to.equal("duid1.1.16");
		expect(roomNameCacheKey("duid1", 0, 16)).to.not.equal(roomNameCacheKey("duid1", 1, 16));
	});

	it("scopes the request guard per (device, map)", () => {
		expect(floorScopeKey("duid1", 0)).to.not.equal(floorScopeKey("duid1", 1));
		expect(floorScopeKey("duid1", 2)).to.not.equal(floorScopeKey("duid2", 2));
	});

	it("does not collide when different maps use the same room name", () => {
		// Names are display data only - the key must stay independent of them.
		const upstairs = roomNameCacheKey("duid1", 1, 3);
		const ground = roomNameCacheKey("duid1", 0, 3);
		expect(new Set([upstairs, ground]).size).to.equal(2);
	});
});

describe("roomKey: normalization", () => {
	it("accepts non-negative integer map flags", () => {
		expect(normalizeMapFlag(0)).to.equal(0);
		expect(normalizeMapFlag(3)).to.equal(3);
		expect(normalizeMapFlag("2")).to.equal(2);
	});

	it("rejects unknown or invalid map flags", () => {
		expect(normalizeMapFlag(UNKNOWN_MAP_FLAG)).to.equal(null);
		expect(normalizeMapFlag(-2)).to.equal(null);
		expect(normalizeMapFlag(undefined)).to.equal(null);
		expect(normalizeMapFlag(null)).to.equal(null);
		expect(normalizeMapFlag("")).to.equal(null);
		expect(normalizeMapFlag("abc")).to.equal(null);
		expect(normalizeMapFlag(1.5)).to.equal(null);
	});

	it("normalizes room ids the same way", () => {
		expect(normalizeRoomId(16)).to.equal(16);
		expect(normalizeRoomId("17")).to.equal(17);
		expect(normalizeRoomId(-1)).to.equal(null);
		expect(normalizeRoomId(undefined)).to.equal(null);
	});

	it("reads display names from strings and translation objects", () => {
		expect(toDisplayName("  Kitchen  ")).to.equal("Kitchen");
		expect(toDisplayName({ en: "Kitchen", de: "Küche" })).to.equal("Kitchen");
		expect(toDisplayName({ de: "Küche" })).to.equal("Küche");
		expect(toDisplayName(42)).to.equal("");
		expect(toDisplayName(undefined)).to.equal("");
	});
});

describe("roomKey: enrichSegmentNamesFromRoomStates (multi floor)", () => {
	// Two stored maps, identical room ids, partly identical room names.
	const roomStates: Record<string, string> = {
		"Devices.duid1.floors.0.16": "Kitchen",
		"Devices.duid1.floors.0.17": "Hallway",
		"Devices.duid1.floors.1.16": "Bedroom",
		"Devices.duid1.floors.1.17": "Hallway"
	};

	function makeReader(requested: string[]): (stateId: string) => Promise<unknown> {
		return async (stateId: string) => {
			requested.push(stateId);
			return roomStates[stateId];
		};
	}

	it("reads names of the ground floor map", async () => {
		const segments = [{ id: 16, name: "" }, { id: 17, name: "" }];
		const requested: string[] = [];

		const applied = await enrichSegmentNamesFromRoomStates(segments, "duid1", 0, makeReader(requested));

		expect(applied).to.equal(2);
		expect(segments.map((s) => s.name)).to.deep.equal(["Kitchen", "Hallway"]);
		expect(requested).to.deep.equal(["Devices.duid1.floors.0.16", "Devices.duid1.floors.0.17"]);
	});

	it("reads names of the second map even though the room ids repeat", async () => {
		const segments = [{ id: 16, name: "" }, { id: 17, name: "" }];
		const requested: string[] = [];

		const applied = await enrichSegmentNamesFromRoomStates(segments, "duid1", 1, makeReader(requested));

		expect(applied).to.equal(2);
		// Must NOT be the ground floor names ("Kitchen").
		expect(segments.map((s) => s.name)).to.deep.equal(["Bedroom", "Hallway"]);
		expect(requested.every((id) => id.startsWith("Devices.duid1.floors.1."))).to.equal(true);
	});

	it("never falls back to another floor when the map flag is unknown", async () => {
		const segments = [{ id: 16, name: "" }, { id: 17, name: "" }];
		const requested: string[] = [];

		const applied = await enrichSegmentNamesFromRoomStates(segments, "duid1", UNKNOWN_MAP_FLAG, makeReader(requested));

		expect(applied).to.equal(0);
		expect(requested).to.deep.equal([]);
		expect(segments.map((s) => s.name)).to.deep.equal(["", ""]);
	});

	it("keeps names that the parser already resolved", async () => {
		const segments = [{ id: 16, name: "Studio" }, { id: 17, name: "" }];
		const requested: string[] = [];

		const applied = await enrichSegmentNamesFromRoomStates(segments, "duid1", 0, makeReader(requested));

		expect(applied).to.equal(1);
		expect(segments[0].name).to.equal("Studio");
		expect(segments[1].name).to.equal("Hallway");
		expect(requested).to.deep.equal(["Devices.duid1.floors.0.17"]);
	});

	it("ignores segments without a usable room id", async () => {
		const segments = [{ id: null, name: "" }, { id: undefined, name: "" }, { id: 16, name: "" }];
		const requested: string[] = [];

		const applied = await enrichSegmentNamesFromRoomStates(segments, "duid1", 0, makeReader(requested));

		expect(applied).to.equal(1);
		expect(requested).to.deep.equal(["Devices.duid1.floors.0.16"]);
	});
});
