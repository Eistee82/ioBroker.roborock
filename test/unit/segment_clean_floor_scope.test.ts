import { beforeEach, describe, expect, it } from "vitest";
import { Feature } from "../../src/lib/features/features.enum";
import { V1VacuumFeatures } from "../../src/lib/features/vacuum/v1VacuumFeatures";
import { MockAdapter } from "../../src/lib/mock/MockAdapter";
import { MockRobot } from "../../src/lib/mock/MockRobot";

/**
 * Regression guard for room switches being collected across floors.
 *
 * Room ids are only unique within one stored map. Collecting the selected rooms over
 * `floors.*.*` therefore mixed rooms of different floors into one `app_segment_clean` job,
 * which made the robot clean whichever rooms of the *loaded* map happened to share those ids.
 */
class TestVacuum extends V1VacuumFeatures {
	private mapIndex = -1;

	protected getDynamicFeatures(): Set<Feature> {
		return new Set();
	}

	public async detectAndApplyRuntimeFeatures(): Promise<boolean> {
		return false;
	}

	public setCurrentMapIndex(index: number): void {
		this.mapIndex = index;
	}

	public override getCurrentMapIndex(): number {
		return this.mapIndex;
	}
}

describe("app_segment_clean room collection is scoped to the active floor", () => {
	let mockAdapter: MockAdapter;
	let mockRobot: MockRobot;
	let vacuum: TestVacuum;

	/** Sets a room switch, using the fully qualified id the adapter queries with. */
	function selectRoom(mapFlag: number, roomId: number, selected = true): Promise<void> {
		return mockAdapter.setStateAsync(`${mockAdapter.namespace}.Devices.${mockRobot.duid}.floors.${mapFlag}.${roomId}`, { val: selected });
	}

	async function segments(): Promise<number[]> {
		const params = await vacuum.getCommandParams("app_segment_clean") as Array<{ segments: number[] }>;
		return params.length > 0 ? params[0].segments : [];
	}

	beforeEach(async () => {
		mockAdapter = new MockAdapter();
		mockRobot = new MockRobot();

		const deps: any = {
			adapter: mockAdapter,
			log: mockAdapter.log,
			ensureState: async (id: string, common: any) => mockAdapter.setObjectNotExistsAsync(id, { type: "state", common }),
			ensureFolder: async (id: string) => mockAdapter.setObjectNotExistsAsync(id, { type: "folder", common: { name: id } }),
			config: { staticFeatures: [] },
			http_api: {
				getFwFeaturesResult: () => mockRobot.features,
				storeFwFeaturesResult: () => {},
				getRobotModel: () => mockRobot.model
			},
			requestsHandler: {
				sendRequest: async (duid: string, method: string, params: any[]) => duid === mockRobot.duid ? mockRobot.handleRequest(method, params) : [],
				command: async () => {}
			}
		};
		mockAdapter.requestsHandler = deps.requestsHandler;
		mockAdapter.http_api = deps.http_api;

		vacuum = new TestVacuum(deps, mockRobot.duid, mockRobot.model, { staticFeatures: [] });
		await vacuum.initialize();
	});

	it("sends only the rooms of the active map when both floors have rooms selected", async () => {
		// Two stored maps, both with a room 16 and a room 17 selected by the user.
		await selectRoom(0, 16);
		await selectRoom(0, 17);
		await selectRoom(1, 16);
		await selectRoom(1, 18);

		vacuum.setCurrentMapIndex(1);
		expect(await segments()).toEqual([16, 18]);

		vacuum.setCurrentMapIndex(0);
		expect(await segments()).toEqual([16, 17]);
	});

	it("ignores rooms of another floor even when the active floor has a single selection", async () => {
		await selectRoom(0, 21);
		await selectRoom(1, 22);
		await selectRoom(2, 23);

		vacuum.setCurrentMapIndex(1);
		expect(await segments()).toEqual([22]);
	});

	it("returns nothing when no room of the active floor is selected", async () => {
		await selectRoom(0, 16);
		vacuum.setCurrentMapIndex(1);

		expect(await vacuum.getCommandParams("app_segment_clean")).toEqual([]);
	});

	it("skips floor metadata states that are not room switches", async () => {
		// `mapFlag` carries the number 1, which used to look like a selected switch.
		await mockAdapter.setStateAsync(`${mockAdapter.namespace}.Devices.${mockRobot.duid}.floors.1.mapFlag`, { val: 1 });
		await mockAdapter.setStateAsync(`${mockAdapter.namespace}.Devices.${mockRobot.duid}.floors.1.name`, { val: "Upstairs" });
		await mockAdapter.setStateAsync(`${mockAdapter.namespace}.Devices.${mockRobot.duid}.floors.1.load`, { val: true });
		await selectRoom(1, 19);

		vacuum.setCurrentMapIndex(1);
		expect(await segments()).toEqual([19]);
	});

	it("refuses to mix floors while the active map slot is still unknown", async () => {
		await selectRoom(0, 16);
		await selectRoom(1, 17);

		// -1 is the V1 pipeline's "map slot unknown" value.
		vacuum.setCurrentMapIndex(-1);
		expect(await vacuum.getCommandParams("app_segment_clean")).toEqual([]);
	});

	it("uses the only floor with a selection while the active map slot is unknown", async () => {
		await selectRoom(2, 16);
		await selectRoom(2, 17);
		await selectRoom(0, 18, false);

		vacuum.setCurrentMapIndex(-1);
		expect(await segments()).toEqual([16, 17]);
	});

	it("keeps honouring explicitly passed room ids", async () => {
		await selectRoom(0, 16);
		vacuum.setCurrentMapIndex(0);

		const params = await vacuum.getCommandParams("app_segment_clean", [5, 6]) as Array<{ segments: number[] }>;
		expect(params[0].segments).toEqual([5, 6]);
	});
});
