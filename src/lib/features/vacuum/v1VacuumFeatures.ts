import PQueue from "p-queue";
import { BaseDeviceFeatures, DeviceModelConfig, FeatureDependencies } from "../baseDeviceFeatures";
import { Feature } from "../features.enum";
import { MapEditService } from "./services/MapEditService";
import { StationService } from "./services/StationService";
import { V1ConsumableService } from "./services/V1ConsumableService";
import { V1MapService } from "./services/V1MapService";
import { CapabilityProbe } from "../capabilityProbe";
import { GET_SERVER_TIMER, parseServerTimerList } from "./serverTimers";
import {
	CLOSE_DND_TIMER,
	DND_ENABLED_FIELD,
	GET_DND_TIMER,
	LOCK_STATUS_FIELD,
	GET_COLLISION_AVOID_STATUS,
	SET_CHILD_LOCK_STATUS,
	SET_COLLISION_AVOID_STATUS,
	SET_DND_TIMER,
	V1RobotSettingsService
} from "./services/V1RobotSettingsService";
import { getLocalizedErrorStates } from "./adapterErrorMapping";
import {
	VACUUM_CONSTANTS,
	WATER_BOX_MODE_EXTREME_LABEL,
	WATER_BOX_MODE_LABELS_SHAKE_MOP,
	WATER_BOX_MODE_LABELS_STANDARD,
	usesShakeMopWaterLabels
} from "./vacuumConstants";
import {
	CLEANING_MODE_STATES,
	CLEANING_MODE_STATE_VALUES,
	FAN_POWER_MAX_PLUS,
	FAN_POWER_SMART,
	MOP_MODE_SMART,
	MOP_SHAKE_WATER_MAX_BIT,
	WATER_BOX_MODE_MAX,
	WATER_BOX_MODE_SMART,
	WATER_BOX_MODE_VACUUM_ONLY,
	buildCleanMotorModePresets,
	deriveCleaningMode,
	supportsCleanModeMaxPlus,
	supportsPureCleanMop
} from "./cleaningModes";
import type { CleaningModeCapabilities } from "./cleaningModes";
import { readFeatureStr } from "../../featureStr";
import { floorFolderId, groupSelectedRoomsByMapFlag, normalizeMapFlag, sortRoomIds } from "../../map/roomKey";
import { CommandVerifier, VERIFIABLE_SET_COMMANDS } from "./commandVerification";
import type { CommandVerificationResult } from "./commandVerification";

// --- Shared Constants ---
// These are the *selectable* levels: what a model profile offers in its pickers. The markers the
// robot may report but nobody can pick (fan_power 106/110, mop_mode 302/306, water_box_mode
// 204/209) are documented in vacuumConstants.ts and stay out of here on purpose.
export const BASE_FAN: Record<number, string> = { 101: "Quiet", 102: "Balanced", 103: "Turbo", 104: "Max" };

/**
 * Water levels in the wording the app uses for robots without a vibrating mop module.
 *
 * Robots that have one get Mild / Standard / Intense instead - see
 * {@link V1VacuumFeatures.applyShakeMopWaterLabels}. The adapter used to hand every robot a mix of
 * the two ("Mild / Moderate / Intense"), and "Moderate" is a word the app uses in neither set.
 */
export const BASE_WATER: Record<number, string> = { ...WATER_BOX_MODE_LABELS_STANDARD };
/**
 * Mop routes in the app's own order: Fast first, then Standard, Deep, Deep+.
 *
 * `MopMethods()` lists them as 304, 300, 301, 303 (report 16 §5.3), and the modes that are not
 * mop-only cut that list to its first two - so **without 304 the Vac & Mop tab is left with a
 * single route**, which is what it looked like: only "Standard". The value was in
 * `MOP_MODE_LABELS` all along and simply never offered.
 */
export const BASE_MOP: Record<number, string> = { 304: "Fast", 300: "Standard", 301: "Deep", 303: "Deep+" };

// --- Profile Interface ---
export interface VacuumProfile {
	mappings: {
		fan_power: Record<number, string>;
		mop_mode?: Record<number, string>;
		water_box_mode?: Record<number, string>;
		error_code?: Record<number, string>;
		state?: Record<number, string>;
	};
	name?: string;
	features?: Record<string, any>;
	cleanMotorModePresets?: Record<string, string>;
	consumableLifeHours?: Record<string, number>;
}

export const DEFAULT_PROFILE: VacuumProfile = {
	mappings: {
		fan_power: BASE_FAN,
		mop_mode: BASE_MOP,
		water_box_mode: BASE_WATER,
	},
};

export class V1VacuumFeatures extends BaseDeviceFeatures {
	private static readonly autoEmptyDockStartCommand = "app_start_collect_dust";

	protected profile: VacuumProfile;
	protected consumableService: V1ConsumableService;
	protected stationService: StationService;
	protected lastMapUpdate = 0;
	protected detectionComplete = false;

	protected mapService: V1MapService;
	protected mapEditService: MapEditService;
	protected settingsService: V1RobotSettingsService;

	/**
	 * Asks the robot which commands it knows, once per adapter run.
	 *
	 * Holds no timers and nothing persistent - see `capabilityProbe.ts` for why a verdict is
	 * deliberately not remembered across restarts.
	 */
	protected readonly capabilityProbe = new CapabilityProbe(
		{ sendRequest: (duid, method, params, options) => this.deps.adapter.requestsHandler.sendRequest(duid, method, params, options) },
		this.duid,
		(message, level) => this.deps.adapter.rLog("System", this.duid, level === "info" ? "Info" : "Debug", "1.0", undefined, message, level)
	);

	/**
	 * Watches acknowledged `set_*` commands until the status shows their effect - or does not.
	 *
	 * Fed in {@link V1VacuumFeatures.onCommandResult}, questioned in
	 * {@link V1VacuumFeatures.processStatus}. Holds no timers, so `onUnload` has nothing to clean up.
	 */
	protected readonly commandVerifier = new CommandVerifier();

	constructor(dependencies: FeatureDependencies, duid: string, robotModel: string, config: DeviceModelConfig = { staticFeatures: [] }, profile: VacuumProfile = DEFAULT_PROFILE) {
		super(dependencies, duid, robotModel, config);

		// Deep clone profile to avoid mutating shared static objects
		this.profile = structuredClone(profile);
		this.applyShakeMopWaterLabels();
		this.applyPureModeWaterLevels();
		this.applyMaxPlusFanLevel();
		this.consumableService = new V1ConsumableService(this.deps, this.duid, this.profile);
		this.stationService = new StationService(this.deps, this.duid);
		this.mapService = new V1MapService(this.deps, this.duid);
		this.settingsService = new V1RobotSettingsService(this.deps, this.duid);
		// Splitting or merging rooms renumbers the segments, so everything the adapter holds about
		// them is stale the moment the robot confirms; the service asks for a refresh at that point.
		this.mapEditService = new MapEditService(this.deps, this.duid, () => this.getCurrentMapIndex(), async () => {
			await this.updateRoomMapping();
			await this.updateMap();
		});
	}

	/**
	 * Gives robots with a vibrating mop module the water wording their own app uses.
	 *
	 * The app words `water_box_mode` 201/202/203 as Mild / Standard / Intense on those robots and
	 * as Low / Medium / High on all others, and it decides purely by model - the distinction is in
	 * a table compiled into the control plugin, not in anything the robot reports. The model string
	 * is all the adapter needs, so the same 18-model list the admin tab uses for the artwork is
	 * used here for the words (see `usesShakeMopWaterLabels`).
	 *
	 * Only levels that still carry the standard label are renamed, so a model profile that
	 * deliberately words a level differently (or uses a different value range altogether, like the
	 * Qrevo Edge 2) keeps what it declared.
	 *
	 * **208 (Extreme)** is added for those robots too, but only provisionally. The app's gate is the
	 * vibrating mop *and* bit 45 of `new_feature_info_str` (`MopShakeWaterMax`, see
	 * {@link MOP_SHAKE_WATER_MAX_BIT}). Only the first half is knowable here - the second arrives
	 * with the robot's first status, and {@link V1VacuumFeatures.applyShakeMopWaterMaxBit} takes the
	 * level away again if the bit is missing. Adding it first and withdrawing it is the right way
	 * round: a level that appears for one poll and then disappears costs nothing, while a level
	 * withheld from a robot that has it is simply gone.
	 */
	private applyShakeMopWaterLabels(): void {
		const water = this.profile.mappings.water_box_mode;
		if (!water || !usesShakeMopWaterLabels(this.robotModel)) {
			return;
		}

		for (const [value, shakeLabel] of Object.entries(WATER_BOX_MODE_LABELS_SHAKE_MOP)) {
			const level = Number(value);
			if (water[level] !== undefined && water[level] === WATER_BOX_MODE_LABELS_STANDARD[level]) {
				water[level] = shakeLabel;
			}
		}

		// Only meaningful next to the regular levels; never invent it for a custom value range.
		if (water[203] !== undefined && water[WATER_BOX_MODE_MAX] === undefined) {
			water[WATER_BOX_MODE_MAX] = WATER_BOX_MODE_EXTREME_LABEL;
		}
	}

	/**
	 * Takes the water level *Extreme* back off robots that do not announce it.
	 *
	 * This is the second half of the app's predicate for `water_box_mode = 208`, the half that only
	 * the robot can answer: bit 45 of `new_feature_info_str`. The proof for the whole gate, down to
	 * the line in the control plugin, is at {@link MOP_SHAKE_WATER_MAX_BIT}.
	 *
	 * Reported from the field as "Wassermenge Extreme gibt es in der App nicht" - and it does not,
	 * on that robot: `firmwareFeatures` is a different structure entirely (it carries values like
	 * 111-125) and says nothing about this bit, so the level was simply offered to everyone with a
	 * vibrating mop.
	 *
	 * The follow-up report settles what kind of fault this is: "ich kann Extreme nicht anwählen, da
	 * kommt keine Reaktion vom Roboter". The entry was not merely superfluous, it was a **dead
	 * control** - the user picks a level, the robot drops it, and nothing in the interface says so.
	 * The adapter does catch the mismatch afterwards, but only in the log and only in some of the
	 * cases (see `requestsHandler.command`), so the picker is where it has to be prevented.
	 *
	 * Three cases, and the tie always goes to the user:
	 *
	 * | `new_feature_info_str`        | Result   |
	 * | ----------------------------- | -------- |
	 * | absent, or not a hex string   | level stays - an unreadable field must not take anything away |
	 * | present, bit 45 set           | level stays |
	 * | present, bit 45 clear         | level removed |
	 *
	 * Only the entry this class added itself is removed - it has to still carry the label from
	 * {@link V1VacuumFeatures.applyShakeMopWaterLabels}. A model profile that words 208 its own way
	 * meant something by it, the same restraint the wording pass applies.
	 *
	 * @param status The robot's `get_status` result.
	 * @returns True when the level was removed just now, so the caller can republish the objects.
	 */
	private applyShakeMopWaterMaxBit(status: Record<string, any>): boolean {
		const water = this.profile.mappings.water_box_mode;
		if (!water || water[WATER_BOX_MODE_MAX] !== WATER_BOX_MODE_EXTREME_LABEL) {
			return false;
		}

		const announced = readFeatureStr(status?.new_feature_info_str);
		if (announced === null || ((announced >> MOP_SHAKE_WATER_MAX_BIT) & 1n) === 1n) {
			return false;
		}

		delete water[WATER_BOX_MODE_MAX];
		this.deps.adapter.rLog("System", this.duid, "Info", undefined, undefined,
			`Water level ${WATER_BOX_MODE_MAX} (Extreme) removed: the robot does not announce MopShakeWaterMax (bit ${MOP_SHAKE_WATER_MAX_BIT} of new_feature_info_str).`, "info");
		return true;
	}

	/**
	 * Rewrites the water picker after {@link V1VacuumFeatures.applyShakeMopWaterMaxBit} shortened it.
	 *
	 * `commands.set_water_box_custom_mode` is built in `setupProtocolFeatures` and written once, at
	 * the start of `initialize()` - long before the robot has said anything. The status handler is
	 * therefore the only place that can correct it, and the write has to happen here because
	 * nothing re-runs `createCommandObjects()` afterwards.
	 *
	 * The in-memory command spec is corrected as well. Today that assignment changes nothing - the
	 * spec holds the very object the profile does, because `addCommand` stored the mapping by
	 * reference - and no test can tell the two apart. It is written out anyway because the spec is
	 * what `getCommandSpec` hands `socketHandler.handleSetState`, whose `coerceCommandValue`
	 * rejects a value that is not in `spec.states` (`socketHandler.ts:584-587`). A level gone from
	 * the picker has to be refused there too, and that must not rest on an alias nobody would think
	 * to preserve.
	 */
	private async republishWaterBoxModeCommand(): Promise<void> {
		const water = this.profile.mappings.water_box_mode;
		if (!water) return;

		const spec = this.commands["set_water_box_custom_mode"];
		if (spec?.states) {
			spec.states = { ...water };
		}

		const path = `Devices.${this.duid}.commands.set_water_box_custom_mode`;
		const existing = await this.deps.adapter.getObjectAsync(path);
		if (!existing) return;

		await this.deps.adapter.applyCommonUpdate(path, existing, { states: { ...water } });
	}

	/**
	 * Drops the water level "Off" on robots that have the pure cleaning modes.
	 *
	 * `water_box_mode = 200` is not a level: it *is* vacuum-only mode. The app knows that and its
	 * picker drops the entry with a `shift()` as soon as the robot has the pure modes (report 17,
	 * §6.3) - leaving it in offers a second, hidden way to switch the mode, disguised as a level.
	 *
	 * Reported from the field as "Saugkraft Off und Wassermenge Extreme gibt es in der App nicht".
	 * The tab already filtered it out of its picker, but the value stayed in `common.states`, so it
	 * remained visible in the object tree and to every script and VIS widget reading that state.
	 *
	 * Robots without the pure modes keep it: there the entry is the only way to stop mopping.
	 */
	private applyPureModeWaterLevels(): void {
		const water = this.profile.mappings.water_box_mode;
		if (!water || !supportsPureCleanMop(this.robotModel)) {
			return;
		}
		// Only on the standard scale. A model that declares its own range - the Qrevo Edge 2 runs
		// 221..250 - may well mean 200 as a level of that range, and the claim above is proven for
		// the standard one only. Same restraint as in `applyShakeMopWaterLabels`.
		if (water[201] === undefined || water[203] === undefined) {
			return;
		}
		delete water[WATER_BOX_MODE_VACUUM_ONLY];
	}

	/**
	 * Gives robots whose model table proves MAX+ the fifth suction level.
	 *
	 * `fan_power = 108` is the level the app labels MAX+. Whether a robot has it is decided by
	 * `DM.support(MF.CleanMode_MaxPlus)` against a table compiled into the control plugin, not by
	 * anything the robot reports - see {@link supportsCleanModeMaxPlus} for how that table has to be
	 * read. Most model classes in this folder already declare the level themselves; what this adds
	 * it to are the ~24 proven models that have no class of their own and therefore run on the
	 * generic profile.
	 *
	 * Three guards keep it from doing harm:
	 *
	 * - It only fires next to the regular levels (`104` present), never on a model that declares its
	 *   own value range.
	 * - It never overwrites and never removes. A profile that already declares 108, or that maps
	 *   MAX+ onto another value the way the Saros models map it onto 110, is left exactly as it is -
	 *   including the profiles whose 108 the plugin table does not confirm. Withholding a level a
	 *   robot has is the worse error of the two: the robot rejects a level it does not have, but a
	 *   level the adapter hides is gone.
	 */
	private applyMaxPlusFanLevel(): void {
		const fan = this.profile.mappings.fan_power;
		if (!fan || !supportsCleanModeMaxPlus(this.robotModel)) {
			return;
		}
		if (fan[104] === undefined || fan[FAN_POWER_MAX_PLUS] !== undefined) {
			return;
		}
		if (Object.values(fan).includes("Max+")) {
			return;
		}
		fan[FAN_POWER_MAX_PLUS] = "Max+";
	}

	/**
	 * What the mode logic may assume about this robot.
	 *
	 * `smartPlan` is the interesting one. 110 / 209 / 306 are SmartPlan in the control plugin, but
	 * several newer model profiles in this folder give those very values a different meaning - the
	 * Saros 10 profile calls `fan_power = 110` "Max+". Where a profile claims the value, the profile
	 * wins: it was written for that device, while the plugin table is a snapshot of one bundle.
	 */
	protected getCleaningModeCapabilities(): CleaningModeCapabilities {
		const mappings = this.profile.mappings;
		const claimsSmartValues =
			mappings.fan_power?.[FAN_POWER_SMART] !== undefined ||
			mappings.water_box_mode?.[WATER_BOX_MODE_SMART] !== undefined ||
			mappings.mop_mode?.[MOP_MODE_SMART] !== undefined;

		return {
			pureCleanMop: supportsPureCleanMop(this.robotModel),
			smartPlan: !claimsSmartValues,
			mopRoutes: mappings.mop_mode !== undefined
		};
	}

	public override async initializeDeviceData(): Promise<void> {
		await this.updateMultiMapsList(); // 1. Load Floor List first (for names/metadata)
		await this.updateStatus();        // 2. Get Status (triggers Room sync via first floor detection)
		await this.updateMap();           // 3. Get Map Image

		// These can still be parallel as they don't depend on each other as much
		await Promise.all([
			this.updateFirmwareFeatures(),
			this.updateConsumables(),
			this.updateNetworkInfo(),
			this.updateTimers(),
		]);
	}

	/**
	 * Configures the standard command set for Protocol V1 devices.
	 * @see test/unit/features_specification.test.ts for the core vacuum command list.
	 */
	public override async setupProtocolFeatures(): Promise<void> {
		await super.setupProtocolFeatures();

		// Add Standard V1 Commands
		const translations = this.deps.adapter.translations;

		this.addCommand("app_start", { type: "boolean", role: "button", name: translations["app_start"] || "Start", def: false });
		this.addCommand("app_stop", { type: "boolean", role: "button", name: translations["app_stop"] || "Stop", def: false });
		this.addCommand("app_pause", { type: "boolean", role: "button", name: translations["app_pause"] || "Pause", def: false });
		this.addCommand("app_charge", { type: "boolean", role: "button", name: translations["app_charge"] || "Charge", def: false });
		this.addCommand("find_me", { type: "boolean", role: "button", name: translations["find_me"] || "Find Me", def: false });
		this.addCommand("app_spot", { type: "boolean", role: "button", name: translations["app_spot"] || "Spot Cleaning", def: false });
		this.addCommand("app_segment_clean", { type: "boolean", role: "button", name: "Segment Cleaning", def: false });

		// Restore missing standard V1 commands
		this.addCommand("app_zoned_clean", { type: "json", role: "json", name: "Zone Clean" }); // No default for JSON usually, or "[]"
		this.addCommand("resume_zoned_clean", { type: "boolean", role: "button", name: "Resume Zone Clean", def: false });
		this.addCommand("stop_zoned_clean", { type: "boolean", role: "button", name: "Stop Zone Clean", def: false });

		this.addCommand("resume_segment_clean", { type: "boolean", role: "button", name: "Resume Segment Clean", def: false });
		this.addCommand("stop_segment_clean", { type: "boolean", role: "button", name: "Stop Segment Clean", def: false });

		this.addCommand("app_goto_target", { type: "json", role: "json", name: "Go To Target" });

		this.addCommand("load_multi_map", { type: "number", role: "level", name: "Load Map", def: 0 });

		this.addCommand("set_custom_mode", {
			type: "number",
			role: "level",
			name: translations["fan_power"] || "Fan Power",
			states: this.profile.mappings.fan_power,
			def: Number(Object.keys(this.profile.mappings.fan_power)[0])
		});

		// One call sets all three values at once, which is also the only way to switch cleaning mode:
		// the mode is a derivation from the triple, not a command of its own (see cleaningModes.ts).
		// A model profile may bring its own presets; otherwise they are generated from the mode logic.
		const cleanMotorModePresets =
			this.profile.cleanMotorModePresets ||
			buildCleanMotorModePresets(this.robotModel, {}, this.getCleaningModeCapabilities());

		this.addCommand("set_clean_motor_mode", {
			type: "string",
			role: "value", // changed from json to value to support dropdown
			name: translations["set_clean_motor_mode"] || "Set Cleaning Mode",
			def: Object.keys(cleanMotorModePresets)[0],
			states: cleanMotorModePresets
		});

		if (this.profile.mappings.water_box_mode) {
			this.addCommand("set_water_box_custom_mode", {
				type: "number",
				role: "level",
				name: translations["water_box_mode"] || "Water Box Mode",
				states: this.profile.mappings.water_box_mode,
				def: Number(Object.keys(this.profile.mappings.water_box_mode)[0])
			});
		}

		if (this.profile.mappings.mop_mode) {
			this.addCommand("set_mop_mode", {
				type: "number",
				role: "level",
				name: translations["mop_mode"] || "Mop Mode",
				states: this.profile.mappings.mop_mode,
				def: Number(Object.keys(this.profile.mappings.mop_mode)[0])
			});
		}

		// A101 Specific: Water Box Distance Off (1-30 -> 230-85)
		if (this.profile.features?.hasDistanceOff) {
			this.addCommand("set_water_box_distance_off", {
				type: "number",
				role: "level",
				name: translations["water_box_distance_off"] || "Water Box Distance Off (1-30)",
				min: 1,
				max: 30,
				unit: "",
				def: 1
			});
		}

		this.addCommand("set_clean_repeat_times", {
			type: "number",
			role: "value",
			name: "Clean Repeat Times",
			min: 1,
			max: 2,
			def: 1,
			states: { 1: "1x", 2: "2x" }
		});

		this.mapEditService.registerCommands((name, spec) => this.addCommand(name, spec));
	}

	public async detectAndApplyRuntimeFeatures(statusData: Readonly<Record<string, any>>): Promise<boolean> {
		let changed = false;

		// Detect features based on status keys
		if (("clean_area" in statusData || "clean_time" in statusData) && await this.applyFeature(Feature.CleaningRecords)) {
			changed = true;
		}

		if (("map_status" in statusData) && await this.applyFeature(Feature.Map)) {
			changed = true;
		}

		if (statusData["water_shortage_status"] !== undefined && await this.applyFeature(Feature.WaterShortage)) {
			changed = true;
		}

		// A station that dries the mop reports `dry_status`; one without a dryer does not. That is
		// the same test `ProductHelper.detectFeatures()` already applies to the product card, and it
		// is what gives models such as the a65 - which lists neither MopWash nor MopDry statically -
		// its drying buttons. Devices without the field keep the folder as it was.
		if (statusData["dry_status"] !== undefined && await this.applyFeature(Feature.MopDry)) {
			changed = true;
		}

		// The two persistent settings, detected the same way the drying buttons above are: a robot
		// that has the function reports its field in every status packet, one without it never
		// does. That is the most dependable of the three tests report 18 lists for binding a
		// command to a capability, and the only one that needs neither a model table nor a
		// firmware bit. The live capture of the test device carries both fields
		// (`_appanalysis/local-mitschnitt.log:15`).
		if (statusData[DND_ENABLED_FIELD] !== undefined && await this.applyFeature(Feature.DoNotDisturb)) {
			changed = true;
		}

		if (statusData[LOCK_STATUS_FIELD] !== undefined && await this.applyFeature(Feature.ChildLock)) {
			changed = true;
		}

		// Consumables detection (usually static, but can check for keys)
		if (await this.applyFeature(Feature.Consumables)) changed = true;

		if (statusData["dss"] !== undefined) {
			const dss = Number(statusData["dss"]);
			// DockingStationStatus: no applyFeature – folder/states created lazily in updateDockingStationStatus()

			// Bits 6-7: Dust bag status (0=not supported/missing)
			if (((dss >> 6) & 0b11) > 0) {
				await this.applyFeature(Feature.AutoEmptyDock);
			}
			// Bits 4-5: Dirty water tank status (0=not supported/missing)
			// Bits 10-11: Clean water tank status
			if (((dss >> 4) & 0b11) > 0 || ((dss >> 10) & 0b11) > 0) {
				await this.applyFeature(Feature.MopWash);
			}
		}

		if (!this.runtimeDetectionComplete) {
			this.runtimeDetectionComplete = true;
			changed = true;
		}
		return changed;
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.Consumables)
	public async updateConsumables(): Promise<void> {
		await this.consumableService.updateConsumables();
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.Map)
	public async updateMap(): Promise<void> {
		await this.mapService.updateMap();
	}

	public async getCleaningRecordMap(startTime: number) {
		return this.mapService.getCleaningRecordMap(startTime);
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.DockingStationStatus)
	protected async initDockingStationStatus(): Promise<void> {
		await this.stationService.initDockingStationStatus();
	}

	/**
	 * Updates docking station status from dss bitfield. Fully dynamic: if the device
	 * sends dss in get_status, we ensure folder/states exist (lazy init) and update.
	 * No per-model or feature-guard – presence of dss means the robot supports it.
	 */
	public async updateDockingStationStatus(dss: number): Promise<void> {
		await this.stationService.initDockingStationStatus(); // idempotent: ensure folder + states
		await this.stationService.updateDockingStationStatus(dss);
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.MultiMap)
	public async updateMultiMapsList(): Promise<void> {
		const mapList = await this.mapService.updateMultiMapsList();
		if (mapList && Array.isArray(mapList)) {
			// Update the load_multi_map command states to populate dropdown
			const states: Record<string, string> = {};
			for (const map of mapList) {
				states[String(map.mapFlag)] = map.name || `Map ${map.mapFlag}`;
			}

			await this.deps.adapter.extendObject(`Devices.${this.duid}.commands.load_multi_map`, {
				common: {
					type: "number",
					role: "value",
					states: states
				}
			});
		} else {
			await super.updateMultiMapsList();
		}
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.RoomMapping)
	public async updateRoomMapping(): Promise<void> {
		await this.mapService.updateRoomMapping();
	}

	public override async onCommandResult(requestedMethod: string, finalMethod: string, response: unknown, params?: unknown): Promise<void> {
		await super.onCommandResult(requestedMethod, finalMethod, response, params);
		if (this.mapEditService.handles(requestedMethod)) {
			await this.mapEditService.resolveDeferredResult(finalMethod, response);
		}

		if (finalMethod === GET_DND_TIMER) {
			await this.settingsService.applyDndTimerResponse(response);
		} else if (finalMethod === SET_DND_TIMER || finalMethod === CLOSE_DND_TIMER) {
			// The robot is the authority on its own window: it may clamp or reorder what was sent,
			// and `close_dnd_timer` says nothing about which window it just switched off. Reading
			// it back is one cheap request and keeps the published window from drifting away from
			// the robot's.
			await this.readDoNotDisturbWindow();
		}

		this.noteCommandForVerification(finalMethod, response, params);
	}

	/**
	 * Starts watching a command that the robot just answered with `["ok"]`.
	 *
	 * Only that answer is watched. Anything else is already reported by
	 * `requestsHandler.command` (`requestsHandler.ts:727-733`), and a second line about the same
	 * request would only make the log harder to read. The `["ok"]` case is precisely the one nobody
	 * reported so far: the robot confirms and does nothing.
	 *
	 * @param finalMethod The method that actually went on the wire.
	 * @param response    The robot's answer.
	 * @param params      The parameters that went with it.
	 */
	private noteCommandForVerification(finalMethod: string, response: unknown, params: unknown): void {
		if (!VERIFIABLE_SET_COMMANDS[finalMethod]) return;

		const data = (response && typeof response === "object" && "data" in response)
			? (response as Record<string, unknown>).data
			: response;
		if (!Array.isArray(data) || data.length !== 1 || data[0] !== "ok") return;

		this.commandVerifier.record(finalMethod, params);
	}

	/**
	 * Says out loud what the status makes of the commands that are still waiting.
	 *
	 * A confirmation additionally marks the command state acknowledged. `processStatus` mirrors the
	 * reported value into that state with `setStateChanged`, which writes nothing when the value did
	 * not change - so a user who picks the level the robot already has would leave the state sitting
	 * at `ack: false` forever, indistinguishable from a command that never arrived. One write per
	 * user command settles that.
	 *
	 * @param status The robot's `get_status` result.
	 */
	private async reportCommandVerification(status: Record<string, any>): Promise<void> {
		const results = this.commandVerifier.evaluate(status);
		for (const result of results) {
			if (result.kind === "confirmed") {
				await this.acknowledgeCommandState(result);
				continue;
			}

			if (result.kind === "unobservable") {
				this.deps.adapter.rLog("Requests", this.duid, "Debug", this.protocolVersion || undefined, undefined,
					`[Command check] ${result.command} was acknowledged, but the status never reported the fields it sets - not verifiable on this robot.`, "debug");
				continue;
			}

			const detail = result.mismatches
				.map((m) => `${m.field}=${JSON.stringify(m.actual)} (requested ${m.expected})`)
				.join(", ");
			this.deps.adapter.rLog("Requests", this.duid, "Warn", this.protocolVersion || undefined, undefined,
				`[Command check] ${result.command} was answered with ["ok"], but ${Math.round(result.elapsedMs / 1000)}s later the robot still reports ${detail}. The requested value is not in effect - the robot may not support it in its current configuration, or it changed the setting again on its own.`, "warn");
		}
	}

	/**
	 * Marks the command state of a confirmed command acknowledged, with the value the robot reports.
	 *
	 * `set_clean_motor_mode` is left alone on purpose: its state holds one of the generated preset
	 * JSON strings, and rebuilding that string from three numbers would have to guess the exact
	 * preset spelling. The three single-value commands map one to one onto a state.
	 *
	 * @param result The confirmed verification result.
	 */
	private async acknowledgeCommandState(result: CommandVerificationResult): Promise<void> {
		const fields = VERIFIABLE_SET_COMMANDS[result.command];
		if (!fields || fields.length !== 1) return;

		const value = result.reported[fields[0]];
		if (typeof value !== "number") return;

		// The command no longer necessarily lives in `commands`: the two persistent settings sit in
		// `settings`, and writing their acknowledgement to the old fixed path would create a state
		// nobody reads while leaving the real one unacknowledged. A command no folder declares
		// keeps the old path - that is the case in which nothing has changed at all.
		const folder = this.folderOfCommand(result.command) ?? "commands";
		const type = this.getCommandSpec(folder, result.command)?.type;
		const path = `Devices.${this.duid}.${folder}.${result.command}`;

		// A switch holds true/false where the status reports 1/0.
		if (type === "boolean") {
			await this.deps.adapter.setState(path, { val: value === 1, ack: true });
			return;
		}

		// Anything that is not a number state is left alone. No verified command has a text state
		// today - `set_dnd_timer` had one and was removed from the check, see
		// `commandVerification.ts` - but the settings folder is where text states live, and writing
		// a status number into one would replace something like "22:00-07:00" with a 1.
		if (type !== undefined && type !== "number") return;

		await this.deps.adapter.setState(path, { val: value, ack: true });
	}

	/**
	 * Finds the command folder a registered command lives in.
	 * @param command Command name.
	 * @returns The folder, or null when no folder declares it.
	 */
	private folderOfCommand(command: string): string | null {
		for (const folder of this.getCommandFolders()) {
			if (this.getCommandSpec(folder, command)) return folder;
		}
		return null;
	}

	public override async getCommandParams(method: string, params?: unknown, id?: string): Promise<unknown> {
		if (this.mapEditService.handles(method)) {
			return this.mapEditService.buildRequest(method, params);
		}

		if (this.settingsService.handles(method)) {
			return this.settingsService.buildCommandParams(method, params);
		}

		if (method === "reset_consumable" && id) {
			const obj = await this.deps.adapter.getObjectAsync(id);
			if (obj && obj.native && obj.native.resetParam) {
				const resetParam = obj.native.resetParam;
				this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `Resetting consumable: ${resetParam} (via native param)`, "info");
				return [resetParam];
			}
			// Fallback if no native param (should not happen with new setup)
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `Reset consumable called without native param for ${id}`, "warn");
		}

		if (method === "set_clean_motor_mode") {
			// Log shows "set_clean_motor_mode" works, but expects params as array: [{...}]
			let finalParams = params;

			// If input is a string (e.g. from Dropdown/Presets), parse it first
			if (typeof finalParams === "string") {
				try {
					finalParams = JSON.parse(finalParams);
				} catch (e: any) {
					this.deps.adapter.rLog("Requests", this.duid, "Warn", this.protocolVersion || undefined, undefined, `[getCommandParams] Failed to parse set_clean_motor_mode params: ${finalParams} - Error: ${e.message}`, "warn");
				}
			}

			if (finalParams && !Array.isArray(finalParams)) {
				finalParams = [finalParams];
			}
			return {
				method: "set_clean_motor_mode",
				params: finalParams
			};
		}

		if (method === "load_multi_map") {
			// Reset current map index -> Next status update triggers room refresh
			this.mapService.resetCurrentMapIndex();

			// User request: active fetch status after map load to ensure trigger
			// We trigger these in the background immediately
			(async () => {
				await new Promise(resolve => {
					const timeout = this.deps.adapter.setTimeout(() => resolve(undefined), 2000);
					if (!timeout) resolve(undefined);
				});
				await this.updateStatus().catch(() => {});
				await this.mapService.updateMap().catch(() => {});
				await this.mapService.updateRoomMapping().catch(() => {});
			})();

			// V1 protocol (0.6.19) expects [number] for load_multi_map
			return [params];
		}

		if (method === "app_segment_clean") {
			const repeat = await this.getCleanRepeatTimes();

			// If params are explicitly provided (e.g. from single room button), use them.
			if (params && (Array.isArray(params) || typeof params === "object")) {
				// If it's just a room ID or array of IDs, wrap it in the correct payload structure
				if (Array.isArray(params) && typeof params[0] === "number") {
					const roomIds = params as number[];
					this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `Starting segment cleaning for specific rooms: ${roomIds.join(", ")} with repeat ${repeat}`, "info");
					return [{
						segments: roomIds,
						repeat,
						clean_order_mode: 0,
						clean_mop: 0
					}];
				}
				return params;
			}

			// Gather selected rooms – restricted to the currently loaded map (see collectSelectedRoomIds).
			const roomIds = await this.collectSelectedRoomIds();

			if (roomIds.length > 0) {
				this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `Starting segment cleaning for rooms: ${roomIds.join(", ")} with repeat ${repeat}`, "info");

				// Params:
				// params: [{"clean_mop":0,"clean_order_mode":0,"repeat":2,"segments":[2,1]}]
				const payload = [{
					segments: roomIds,
					repeat,
					clean_order_mode: 0,
					clean_mop: 0
				}];

				return payload;
			} else {
				this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `No rooms selected for segment cleaning!`, "warn");
				return [];
			}
		}

		if (method === "set_custom_mode") {
			return [Number(params)];
		}

		if (method === "set_mop_mode") {
			return [Number(params)];
		}

		if (method === "set_water_box_custom_mode") {
			return [Number(params)];
		}

		if (method === "set_water_box_distance_off") {
			// Convert 1-30 slider to 230-85 robot value
			// Formula: 230 - ((val - 1) * 5)
			let val = Number(params);
			if (isNaN(val)) val = 1;
			if (val < 1) val = 1;
			if (val > 30) val = 30;

			const distance_off = 230 - ((val - 1) * 5);
			return { distance_off };
		}

		if (method === "set_clean_repeat_times") {
			let repeat = Number(params);
			if (isNaN(repeat)) repeat = 1;
			return { repeat };
		}

		if (method === V1VacuumFeatures.autoEmptyDockStartCommand) {
			return [];
		}

		return params;
	}

	/**
	 * Collects the room switches the user has turned on, restricted to the currently loaded map.
	 *
	 * Room ids are only unique **within one stored map**: robots that keep several maps (floors)
	 * reuse the same segment ids across them (see src/lib/map/roomKey.ts). Collecting over
	 * `floors.*.*` therefore mixes rooms of different floors into one cleaning job, which makes
	 * the robot clean arbitrary rooms of the map that happens to be loaded. Only the rooms of the
	 * active map may be sent to `app_segment_clean`.
	 * @returns Ascending, duplicate-free room ids of the active map; empty when nothing is selected.
	 */
	private async collectSelectedRoomIds(): Promise<number[]> {
		const activeMapFlag = normalizeMapFlag(this.getCurrentMapIndex());
		const namespace = this.deps.adapter.namespace;
		// Structure: Devices.<duid>.floors.<mapFlag>.<roomID>
		const pattern = activeMapFlag !== null
			? `${namespace}.${floorFolderId(this.duid, activeMapFlag)}.*`
			: `${namespace}.Devices.${this.duid}.floors.*.*`;

		const states = await this.deps.adapter.getStatesAsync(pattern);
		if (!states) return [];

		// Same reader the map renderer uses to decide which rooms it must not fade, so a room that
		// gets cleaned is exactly a room that looks selected.
		const selectedByMapFlag = groupSelectedRoomsByMapFlag(states);

		if (selectedByMapFlag.size === 0) return [];

		if (activeMapFlag !== null) {
			return sortRoomIds(selectedByMapFlag.get(activeMapFlag));
		}

		// The active map slot is not known yet (no map_status seen so far). Falling back to all
		// floors would be exactly the bug described above, so only an unambiguous selection is used.
		if (selectedByMapFlag.size > 1) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `Rooms of ${selectedByMapFlag.size} different floors are selected while the active map is unknown – refusing to mix floors into one cleaning job`, "warn");
			return [];
		}

		const [onlyMapFlag, onlyRooms] = [...selectedByMapFlag.entries()][0];
		this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined, `Active map unknown; using floor ${onlyMapFlag} as it is the only one with selected rooms`, "debug");
		return sortRoomIds(onlyRooms);
	}

	private normalizeCleanRepeat(value: unknown): number | null {
		const repeat = Number(value);
		return Number.isInteger(repeat) && repeat > 0 ? repeat : null;
	}

	private async getCleanRepeatTimes(): Promise<number> {
		const commandState = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.commands.set_clean_repeat_times`);
		const commandRepeat = this.normalizeCleanRepeat(commandState?.val);
		if (commandRepeat !== null) return commandRepeat;

		const statusState = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.deviceStatus.repeat`);
		return this.normalizeCleanRepeat(statusState?.val) ?? 1;
	}

	public async updateCleanSummary(): Promise<void> {
		try {
			const result = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_clean_summary", []);
			const summary = this.normalizeV1CleanSummary(result);

			if (!summary) {
				this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, "Invalid V1 clean summary format", "warn");
				return;
			}

			await this.processV1CleanSummary(summary);
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to update cleaningInfo (method: get_clean_summary): ${this.deps.adapter.errorMessage(e)}`, "warn");
		}
	}

	private normalizeV1CleanSummary(result: unknown): Record<string, unknown> | null {
		const unwrapped = this.unwrapSingleElementArrays(result);

		if (Array.isArray(unwrapped)) {
			const numericEntries = this.getIndexedNumbers(unwrapped);
			if (numericEntries.length === 0) return null;

			const records = this.findRecordStartTimes(unwrapped);
			const summary = this.inferV1CleanSummaryFields(numericEntries, records.length);
			for (const { index, value } of numericEntries) {
				summary[`field_${index}`] = value;
			}
			summary.records = records;
			return summary;
		}

		if (this.isPlainObject(unwrapped)) {
			const summary = { ...unwrapped };
			if (Array.isArray(summary.records)) {
				summary.records = this.normalizeRecordStartTimes(summary.records);
			}
			return summary;
		}

		return null;
	}

	private inferV1CleanSummaryFields(entries: Array<{ index: number; value: number }>, recordCount: number): Record<string, unknown> {
		const summary: Record<string, unknown> = {};
		const used = new Set<number>();

		const area = entries
			.filter(entry => entry.value >= 1_000_000)
			.sort((a, b) => b.value - a.value)[0];
		if (area) {
			summary.clean_area = area.value;
			used.add(area.index);
		}

		const count = entries
			.filter(entry => !used.has(entry.index) && entry.value >= recordCount && entry.value < 1_000_000)
			.sort((a, b) => a.value - b.value)[0];
		if (count) {
			summary.clean_count = count.value;
			used.add(count.index);
		}

		const time = entries
			.filter(entry => !used.has(entry.index))
			.sort((a, b) => b.value - a.value)[0];
		if (time) {
			summary.clean_time = time.value;
		}

		return summary;
	}

	private async processV1CleanSummary(summary: Record<string, unknown>): Promise<void> {
		const records = Array.isArray(summary.records) ? this.normalizeRecordStartTimes(summary.records).sort((a, b) => b - a) : [];
		const recordPayloads = await this.fetchV1CleanRecordPayloads(records);
		const rest = { ...summary };
		delete rest.records;

		await this.deps.ensureFolder(`Devices.${this.duid}.cleaningInfo`);
		for (const key in rest) {
			await this.processResultKey("cleaningInfo", key, rest[key]);
		}

		await this.writeV1CleaningInfoJson(records, recordPayloads);
		await this.syncV1CleanRecords(records, recordPayloads);
	}

	private async fetchV1CleanRecordPayloads(records: number[]): Promise<Map<number, unknown>> {
		const payloads = new Map<number, unknown>();

		for (const startTime of records) {
			try {
				const rawRecord = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_clean_record", [startTime]);
				const payload = this.unwrapSingleElementArrays(rawRecord);
				if (!(Array.isArray(payload) && payload.length === 0)) {
					payloads.set(startTime, payload);
				}
			} catch (e: unknown) {
				this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `Failed to fetch clean record ${startTime} for cleaningInfo.JSON: ${this.deps.adapter.errorMessage(e)}`, "warn");
			}
		}

		return payloads;
	}

	private async writeV1CleaningInfoJson(records: number[], recordPayloads: Map<number, unknown>): Promise<void> {
		const jsonRecords = records.map(startTime => recordPayloads.get(startTime) ?? null);

		await this.deps.ensureState(`Devices.${this.duid}.cleaningInfo.JSON`, {
			name: "cleaningInfoJSON",
			type: "string",
			role: "json",
			read: true,
			write: false
		});
		await this.deps.adapter.setStateChanged(`Devices.${this.duid}.cleaningInfo.JSON`, {
			val: JSON.stringify(jsonRecords),
			ack: true
		});
	}

	private async syncV1CleanRecords(records: number[], recordPayloads: Map<number, unknown> = new Map()): Promise<void> {
		if (records.length === 0) return;

		const mapQueue = new PQueue({ concurrency: 1 });
		const existingStartTimes: Record<string, number> = {};
		const namespace = this.deps.adapter.namespace;
		const recordIds = records.map((_, i) => `${namespace}.Devices.${this.duid}.cleaningInfo.records.${i}.startTime`);
		const states = await this.deps.adapter.getForeignStatesAsync(recordIds);

		if (states) {
			for (const id in states) {
				if (states[id] && states[id].val) {
					const parts = id.split(".");
					const index = parseInt(parts[parts.length - 2]);
					if (!isNaN(index)) {
						existingStartTimes[String(states[id].val)] = index;
					}
				}
			}
		}

		const sortedRecords = [...records].sort((a, b) => b - a);
		const moves: { old: number, new: number }[] = [];
		const newRecs: { index: number, time: number }[] = [];

		for (let i = 0; i < sortedRecords.length; i++) {
			const time = sortedRecords[i];
			const oldIndex = existingStartTimes[time];

			if (oldIndex !== undefined && oldIndex !== i) {
				moves.push({ old: oldIndex, new: i });
			} else if (oldIndex === undefined) {
				newRecs.push({ index: i, time });
			}
		}

		const leftShifts = moves.filter(m => m.old > m.new).sort((a, b) => a.new - b.new);
		for (const m of leftShifts) {
			await this.copyRecordStates(m.old, m.new);
		}

		const rightShifts = moves.filter(m => m.old < m.new).sort((a, b) => b.new - a.new);
		for (const m of rightShifts) {
			await this.copyRecordStates(m.old, m.new);
		}

		for (const { index, time } of newRecs) {
			await this.fetchAndSaveRecord(time, index, index < 3 ? 10 : 0, mapQueue, recordPayloads.get(time));
		}

		await mapQueue.onIdle();
	}

	private async copyRecordStates(from: number, to: number): Promise<void> {
		const prefix = `Devices.${this.duid}.cleaningInfo.records`;
		const states = await this.deps.adapter.getStatesAsync(`${prefix}.${from}.*`);
		if (!states) return;

		await Promise.all(Object.entries(states).map(async ([id, state]) => {
			if (!state || state.val === null) return;
			const obj = await this.deps.adapter.getObjectAsync(id);
			if (!obj?.common) return;

			// Replace index in path (roborock.0.Devices...records.5... -> ...records.6...)
			const destRel = id.substring(this.deps.adapter.namespace.length + 1).replace(`.records.${from}.`, `.records.${to}.`);
			await this.deps.ensureState(destRel, obj.common as Partial<ioBroker.StateCommon>);
			await this.deps.adapter.setStateChanged(destRel, { val: state.val, ack: true });
		}));
	}

	private async fetchAndSaveRecord(startTime: number, index: number, priority: number, queue: PQueue, prefetchedRecord?: unknown): Promise<void> {
		queue.add(async () => {
			try {
				const fullRecordPath = `cleaningInfo.records.${index}`;

				// 1. Set Timestamp
				await this.deps.ensureState(`Devices.${this.duid}.${fullRecordPath}.startTime`, { name: "Start Time", type: "number", role: "value.time", write: false });
				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.${fullRecordPath}.startTime`, { val: startTime, ack: true });

				// 2. Fetch Metadata
				const recordsDetails = prefetchedRecord !== undefined
					? prefetchedRecord
					: await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_clean_record", [startTime]);
				const record = this.normalizeV1CleanRecord(recordsDetails);
				if (record) {
					for (const key in record) {
						let val = record[key];
						if (key === "area" || key === "cleaned_area") val = Math.round(Number(val) / 1000000);
						else if (key === "duration") val = Math.round(Number(val) / 60);
						await this.processResultKey(fullRecordPath, key, val);
					}
				}

				// 3. Fetch Map only when map creation is enabled (records metadata is always saved above)
				if (this.deps.config.enable_map_creation) {
					const mapResult = await this.mapService.getCleaningRecordMap(startTime);
					if (mapResult) {
						const mapFolder = `records.${index}.map`;
						await this.deps.ensureFolder(`Devices.${this.duid}.cleaningInfo.${mapFolder}`);

						const saveMap = async (suffix: string, name: string, val: string, role = "text.png") => {
							await this.deps.ensureState(`Devices.${this.duid}.cleaningInfo.${mapFolder}.${suffix}`, { name, type: "string", role });
							await this.deps.adapter.setStateChanged(`Devices.${this.duid}.cleaningInfo.${mapFolder}.${suffix}`, { val, ack: true });
						};

						await saveMap("mapBase64", "Map Image", mapResult.mapBase64);

						await saveMap("mapData", "Map Data", mapResult.mapData, "json");
					} else {
						this.deps.adapter.rLog("MapManager", this.duid, "Warn", "1.0", undefined, `No map found for record ${startTime}`, "warn");
					}
				}
			} catch (e: any) {
				this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined, `Background fetch for record ${startTime} failed: ${e.message}`, "warn");
			}
		}, { priority });
	}

	private normalizeV1CleanRecord(result: unknown): Record<string, unknown> | null {
		const unwrapped = this.unwrapSingleElementArrays(result);

		if (Array.isArray(unwrapped)) {
			const record = this.inferV1CleanRecordFields(unwrapped);
			unwrapped.forEach((value, index) => {
				if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
					record[`field_${index}`] = value;
				}
			});
			return Object.keys(record).length > 0 ? record : null;
		}

		if (this.isPlainObject(unwrapped)) {
			return { ...unwrapped };
		}

		return null;
	}

	private inferV1CleanRecordFields(values: unknown[]): Record<string, unknown> {
		const record: Record<string, unknown> = {};
		const timestampPairIndex = this.findAdjacentTimestampPairIndex(values);
		if (timestampPairIndex === -1) return record;

		record.begin = values[timestampPairIndex];
		record.end = values[timestampPairIndex + 1];

		const duration = values[timestampPairIndex + 2];
		if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
			record.duration = duration;
		}

		const area = values[timestampPairIndex + 3];
		if (typeof area === "number" && Number.isFinite(area) && area >= 0) {
			record.area = area;
		}

		return record;
	}

	private findAdjacentTimestampPairIndex(values: unknown[]): number {
		for (let i = 0; i < values.length - 1; i++) {
			const begin = values[i];
			const end = values[i + 1];
			if (this.isUnixTimestamp(begin) && this.isUnixTimestamp(end) && begin <= end) {
				return i;
			}
		}
		return -1;
	}

	private isUnixTimestamp(value: unknown): value is number {
		return typeof value === "number" && Number.isFinite(value) && value > 946684800 && value < 4102444800;
	}

	private getIndexedNumbers(values: unknown[]): Array<{ index: number; value: number }> {
		const result: Array<{ index: number; value: number }> = [];
		values.forEach((value, index) => {
			if (typeof value === "number" && Number.isFinite(value)) {
				result.push({ index, value });
			}
		});
		return result;
	}

	private findRecordStartTimes(values: unknown[]): number[] {
		for (const value of values) {
			if (Array.isArray(value)) {
				const records = this.normalizeRecordStartTimes(value);
				if (records.length > 0) return records;
			}
		}
		return [];
	}

	private normalizeRecordStartTimes(records: unknown): number[] {
		if (!Array.isArray(records)) return [];
		return records.map(record => Number(record)).filter(Number.isFinite);
	}

	private unwrapSingleElementArrays(value: unknown): unknown {
		let unwrapped = value;
		while (Array.isArray(unwrapped) && unwrapped.length === 1) {
			unwrapped = unwrapped[0];
		}
		return unwrapped;
	}

	private isPlainObject(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
	}

	public override async updateStatus(): Promise<void> {
		try {
			const result = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_prop", ["get_status"]);
			const statusData = Array.isArray(result) ? result[0] : result;

			if (statusData && typeof statusData === "object") {
				await this.applyRuntimeFeatureDetection(statusData);
				await this.processStatus(statusData);
				const c = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.cleaningInfo.clean_count`);
				this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined, `status=${statusData.state ?? "?"}, clean_count=${c?.val ?? "?"}`, "debug");
			}
		} catch (e: any) {
			this.deps.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to update status: ${e.message}`, "warn");
			throw e;
		}
	}

	/**
	 * Publishes the robot schedules as `schedules.<timerId>.{enabled,cron}`.
	 *
	 * `enabled` is writable; writes are picked up in main.ts (`handleScheduleToggle`) and sent to
	 * the robot as `upd_timer [timerId, "on"|"off"]`. `cron` stays read-only – changing a
	 * schedule's time needs `set_timer`, which rewrites the whole timer and is not implemented.
	 */
	public async updateTimers(): Promise<void> {
		try {
			const timers = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_timer", []);
			if (Array.isArray(timers)) {
				await this.deps.ensureFolder(`Devices.${this.duid}.schedules`);
				await Promise.all(timers.map(async (timer) => {
					// timer structure: [id, enabled, [cron, [cmd, params], createTime]]
					if (Array.isArray(timer) && timer.length >= 3) {
						const id = timer[0];
						const enabled = timer[1] === "on";
						const segments = timer[2];
						const cron = Array.isArray(segments) ? segments[0] : "";

						await this.deps.ensureFolder(`Devices.${this.duid}.schedules.${id}`);

						await this.deps.ensureState(`Devices.${this.duid}.schedules.${id}.enabled`, { name: "Enabled", type: "boolean", role: "switch", write: true });
						await this.deps.adapter.setStateChanged(`Devices.${this.duid}.schedules.${id}.enabled`, { val: enabled, ack: true });

						await this.deps.ensureState(`Devices.${this.duid}.schedules.${id}.cron`, { name: "CRON", type: "string", role: "text", write: false });
						await this.deps.adapter.setStateChanged(`Devices.${this.duid}.schedules.${id}.cron`, { val: cron, ack: true });
					}
				}));
			}
		} catch (e: any) {
			this.deps.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to update timers: ${e.message}`, "warn");
		}

		await this.updateServerTimers();
	}

	/**
	 * Publishes the schedules the robot keeps on Roborock's server.
	 *
	 * Runs after the device timers because on a robot that uses the server path the device list is
	 * empty - measured at the test device, which showed a running schedule in the app and nothing
	 * at all in ioBroker (`_appanalysis/20-zeitplaene.md`). Which path a robot uses is decided by a
	 * bit of `local_info.featureset`, not by its model; the proof chain is in `serverTimers.ts`.
	 *
	 * **`enabled` is read-only here, unlike its device-timer namesake.** The device switch works
	 * through `upd_timer`, and that is a device-timer command; whether `upd_server_timer` takes the
	 * same arguments has not been read. A writable switch wired to the wrong command is precisely
	 * the dead control this project keeps removing, so the switch is not offered until its command
	 * is proven.
	 */
	private async updateServerTimers(): Promise<void> {
		try {
			const answer = await this.deps.adapter.requestsHandler.sendRequest(this.duid, GET_SERVER_TIMER, []);
			const entries = parseServerTimerList(answer);
			if (entries.length === 0) return;

			await this.deps.ensureFolder(`Devices.${this.duid}.schedules`);
			for (const entry of entries) {
				const folder = `Devices.${this.duid}.schedules.${entry.id}`;
				await this.deps.ensureFolder(folder);

				await this.deps.ensureState(`${folder}.enabled`, { name: "Enabled", type: "boolean", role: "indicator", write: false });
				await this.deps.adapter.setStateChanged(`${folder}.enabled`, { val: entry.active, ack: true });

				await this.deps.ensureState(`${folder}.source`, { name: "Where this schedule lives", type: "string", role: "text", write: false });
				await this.deps.adapter.setStateChanged(`${folder}.source`, { val: "server", ack: true });

				await this.deps.ensureState(`${folder}.raw`, { name: "Entry as reported", type: "string", role: "json", write: false });
				await this.deps.adapter.setStateChanged(`${folder}.raw`, { val: entry.raw, ack: true });
			}

			this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
				`${entries.length} schedule(s) of this robot live on the Roborock server, not in the robot. `
				+ "Their identifiers and on/off state are published; their times, rooms and modes are held in the Roborock account and are not readable over the local channel.",
				"info");
		} catch (e: unknown) {
			// A robot that does not know the method is not a fault - it simply keeps its schedules
			// itself, which is the other half of the same branch.
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined,
				`No server-side schedules read: ${this.deps.adapter.errorMessage(e)}`, "debug");
		}
	}

	public async processStatus(status: any): Promise<void> {
    	const validStatus = status || {};
		const localizedErrorStates = getLocalizedErrorStates(this.deps.adapter.translationManager);

		// Before anything is published: the status carries `new_feature_info_str`, and that is the
		// only place the robot says whether it has the Extreme water level. Runs on every poll but
		// only does something once - afterwards the entry is gone and the guard trips immediately.
		if (this.applyShakeMopWaterMaxBit(validStatus)) {
			await this.republishWaterBoxModeCommand();
		}

		if (validStatus.dss !== undefined) {
			await this.updateDockingStationStatus(Number(validStatus.dss));
			delete validStatus.dss;
		}

		// The station's mop wash and mop drying. The raw fields stay in `deviceStatus` below; this
		// adds the reading the Roborock app applies to them, see StationService for the proofs.
		await this.stationService.updateWashAndDryStatus(validStatus);

    	// Define property processing map
    	const processors: Record<string, (val: any) => Promise<void>> = {
    		state: async (val) => {
    			await this.deps.ensureState(`Devices.${this.duid}.deviceStatus.state`, { type: "number", states: this.profile.mappings.state || VACUUM_CONSTANTS.stateCodes });
    			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.state`, { val, ack: true });
    		},
    		error_code: async (val) => {
				await this.deps.ensureState(`Devices.${this.duid}.deviceStatus.error_code`, { type: "number", states: this.profile.mappings.error_code || localizedErrorStates });
    			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.error_code`, { val, ack: true });
    		},
			dock_error_status: async (val) => {
				await this.deps.ensureState(`Devices.${this.duid}.deviceStatus.dock_error_status`, { type: "number", states: localizedErrorStates });
				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.dock_error_status`, { val, ack: true });
				await this.afterDockErrorStatusUpdated(val);
			},
    		fan_power: async (val) => {
    			await this.deps.ensureState(`Devices.${this.duid}.deviceStatus.fan_power`, { type: "number", states: this.profile.mappings.fan_power });
    			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.fan_power`, { val, ack: true });
				// Sync to command state
				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.commands.set_custom_mode`, { val, ack: true });
    		},
    		mop_mode: async (val) => {
    			if (this.profile.mappings.mop_mode) {
    				await this.deps.ensureState(`Devices.${this.duid}.deviceStatus.mop_mode`, { type: "number", states: this.profile.mappings.mop_mode });
    				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.mop_mode`, { val, ack: true });
					// Sync to command state
					await this.deps.adapter.setStateChanged(`Devices.${this.duid}.commands.set_mop_mode`, { val, ack: true });
    			}
    		},
			// The child lock is the one setting whose switch can be kept in step without a request:
			// the status carries it in every packet. `lock_status` keeps its own read-only entry in
			// `deviceStatus` as before; the extra write only reaches the writable switch, and only
			// on a robot that got one.
			lock_status: async (val) => {
				await this.processResultKey("deviceStatus", LOCK_STATUS_FIELD, val);
				if (this.hasFeature(Feature.ChildLock)) {
					await this.settingsService.mirrorStatusField(LOCK_STATUS_FIELD, val);
				}
			},
    		water_box_mode: async (val) => {
    			if (this.profile.mappings.water_box_mode) {
    				await this.deps.ensureState(`Devices.${this.duid}.deviceStatus.water_box_mode`, { type: "number", states: this.profile.mappings.water_box_mode });
    				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.water_box_mode`, { val, ack: true });
					// Sync to command state
					await this.deps.adapter.setStateChanged(`Devices.${this.duid}.commands.set_water_box_custom_mode`, { val, ack: true });
    			}
    		}
    	};

    	// Parallel processing of remaining status properties
    	const promises: Promise<void>[] = [];
    	for (const key in validStatus) {
    		if (processors[key]) {
    			promises.push(processors[key](validStatus[key]));
    		} else {
    			// Default handler for generic properties
    			promises.push(this.processResultKey("deviceStatus", key, validStatus[key]));
    		}
    	}

		await Promise.all(promises);
		await this.publishCleaningMode(validStatus);
		// Last, so the states already carry what the robot reports when the check speaks about them.
		await this.reportCommandVerification(validStatus);
	}

	/**
	 * Publishes the cleaning mode the app would show for the reported values.
	 *
	 * The robot has no field for it - the mode is what `fan_power`, `water_box_mode` and `mop_mode`
	 * mean together (`_appanalysis/16-reinigungsmodi.md` §1.4). Deriving it here rather than in the
	 * user interface keeps the rules in one place, and a rule that reads `water_box_mode = 200` as
	 * "vacuum only" instead of "water off" is not something every consumer should have to know.
	 *
	 * Read-only on purpose. The write path is `commands.set_clean_motor_mode`, which carries the
	 * whole triple in one call; a second, writable copy of the same thing would let the two disagree.
	 */
	private async publishCleaningMode(status: Record<string, any>): Promise<void> {
		const mode = deriveCleaningMode(
			{
				fan_power: status.fan_power,
				water_box_mode: status.water_box_mode,
				mop_mode: status.mop_mode
			},
			this.getCleaningModeCapabilities()
		);

		if (mode === null) {
			return;
		}

		const path = `Devices.${this.duid}.deviceStatus.clean_mode_tab`;
		await this.deps.ensureState(path, {
			name: this.deps.adapter.translations["clean_mode_tab"] || "Cleaning mode",
			type: "number",
			role: "value",
			read: true,
			write: false,
			states: CLEANING_MODE_STATES
		} as ioBroker.StateCommon);
		await this.deps.adapter.setStateChanged(path, { val: CLEANING_MODE_STATE_VALUES[mode], ack: true });
	}

	/** Allows device-specific profiles to derive states from dock_error_status. */
	protected async afterDockErrorStatusUpdated(_dockErrorStatus: unknown): Promise<void> {
		// Default profiles do not derive additional states.
	}

	protected getDynamicFeatures(): Set<Feature> {
		// v1 dynamic features
		const features = new Set<Feature>();
		if (this.config.staticFeatures) {
			this.config.staticFeatures.forEach(f => features.add(f));
		}
		return features;
	}

	// --- Abstract Method Implementations ---

	public getCommonConsumable(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.consumables as any)[attribute];
	}

	public isResetableConsumable(consumable: string): boolean {
		return VACUUM_CONSTANTS.resetConsumables.has(consumable);
	}

	public getCommonDeviceStates(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.deviceStates as any)[attribute];
	}

	public getCommonCleaningRecords(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.cleaningRecords as any)[attribute];
	}

	public getFirmwareFeatureName(featureID: string | number): string {
		return (VACUUM_CONSTANTS.firmwareFeatures as any)[featureID] || `Feature ${featureID}`;
	}

	public getCommonCleaningInfo(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.cleaningInfo as any)[attribute];
	}

	/**
	 * Publishes the Do Not Disturb window and its off button.
	 *
	 * The window itself is not in the status, so it is asked for once here. That read is
	 * deliberately **not** awaited: this method runs from `processStatus`, and letting a request
	 * with an eight second timeout sit in front of every status update would stall the poll - and a
	 * failing read would keep the feature unapplied and repeat the stall on the next poll. The
	 * request goes into the same queue as every other one and is torn down with it; nothing is
	 * scheduled here that `onUnload` would have to know about.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.DoNotDisturb)
	public async initDoNotDisturb(): Promise<void> {
		if (this.folderOfCommand(SET_DND_TIMER)) return;
		this.settingsService.registerDoNotDisturbCommands((name, spec, group) => this.addCommand(name, spec, group));
		await this.settingsService.ensureDndStates();
		void this.readDoNotDisturbWindow();
	}

	/**
	 * Publishes the child lock switch, unless the model class already declared one.
	 *
	 * `A179Features` brings its own `set_child_lock_status` together with its own parameter
	 * building, and it calls `super.getCommandParams` before its own branch runs
	 * (`a179_features.ts:1303-1330`). Registering a second definition here would leave that model
	 * with two owners for one command; see {@link V1RobotSettingsService} for the whole reasoning.
	 */
	/**
	 * Asks the robot which of the probeable commands it has.
	 *
	 * Exactly one entry today, and that is deliberate: every probe costs a request at start-up, and
	 * a capability only belongs here once its **write** side is proven too. Obstacle avoidance is:
	 * the wrapper builds `{status}` (a65 control plugin, A65:230180-230192) and its switch handler
	 * computes `status = on ? 1 : 0` (`onToggleAvoidCollision`, A65:837660-837680). The measurement
	 * showed the a65 answers the getter although the adapter only ever offered the command to the
	 * a179 (`_appanalysis/19-geraetefaehigkeiten.md` §4).
	 *
	 * Deliberately **not** here yet, although the a65 answers their getters: the carpet deep clean
	 * status, the dryer setting, the smart wash parameters and the mop wash mode. Their setters pass
	 * their argument straight through in the app, so the payload is unread - and a probe that proves
	 * a robot can *read* something proves nothing about how to write it. `get_wash_towel_mode` yes /
	 * `get_wash_towel_params` no is the standing warning that even neighbours differ.
	 */
	protected override async detectProbedCapabilities(): Promise<void> {
		if (this.folderOfCommand(SET_COLLISION_AVOID_STATUS)) return;

		const verdict = await this.capabilityProbe.probe(GET_COLLISION_AVOID_STATUS, {});
		if (verdict !== "capable") return;

		await this.applyFeature(Feature.CollisionAvoid);
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.CollisionAvoid)
	public async initCollisionAvoid(): Promise<void> {
		this.settingsService.registerCollisionAvoidCommand((name, spec, group) => this.addCommand(name, spec, group));
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.ChildLock)
	public async initChildLock(): Promise<void> {
		if (this.folderOfCommand(SET_CHILD_LOCK_STATUS)) return;
		this.settingsService.registerChildLockCommand((name, spec, group) => this.addCommand(name, spec, group));
	}

	/**
	 * Asks the robot for its Do Not Disturb window and publishes it.
	 *
	 * Failure is logged and swallowed on purpose - the window is a convenience, and a robot that
	 * does not answer must not take the rest of the status handling down with it.
	 */
	private async readDoNotDisturbWindow(): Promise<void> {
		try {
			const response = await this.deps.adapter.requestsHandler.sendRequest(this.duid, GET_DND_TIMER, [], { priority: -5 });
			await this.settingsService.applyDndTimerResponse(response);
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Failed to read the Do Not Disturb window: ${this.deps.adapter.errorMessage(e)}`, "warn");
		}
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.AutoEmptyDock)
	public async initAutoEmptyDock(): Promise<void> {
		this.addCommand(V1VacuumFeatures.autoEmptyDockStartCommand, {
			type: "boolean",
			role: "button",
			name: "Start Collect Dust",
			def: false
		});
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.MopWash)
	public async initMopWash(): Promise<void> {
		this.addCommand("app_start_wash", {
			type: "boolean",
			role: "button",
			name: "Start Mop Wash",
			def: false
		});
		this.addCommand("app_stop_wash", {
			type: "boolean",
			role: "button",
			name: "Stop Mop Wash",
			def: false
		});
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.MopDry)
	public async initMopDry(): Promise<void> {
		this.addCommand("app_start_mop_drying", {
			type: "boolean",
			role: "button",
			name: "Start Mop Drying",
			def: false
		});
		this.addCommand("app_stop_mop_drying", {
			type: "boolean",
			role: "button",
			name: "Stop Mop Drying",
			def: false
		});
	}

	protected override async processResultKey(folder: string, key: string, val: unknown): Promise<void> {
		if (key === "map_status") {
			const mapIdxChanged = this.mapService.updateCurrentMapIndex(Number(val));

			if (mapIdxChanged) {
				this.deps.adapter.rLog("MapManager", this.duid, "Info", "1.0", undefined, `[MapSync] Map changed to index ${this.mapService.currentIndex}. Updating room mapping.`, "info");
				await this.updateRoomMapping();
			}
		} else if (key === "clean_time") {
			// cleaningInfo (Total) = Hours, deviceStatus (Current) = Minutes
			const divisor = folder.includes("cleaningInfo") ? 3600 : 60;
			val = Math.round(Number(val) / divisor);
		} else if (key === "clean_area") {
			val = Math.round(Number(val) / 1000000); // mm² -> m²
		}

		await super.processResultKey(folder, key, val);
	}

	public override getCurrentMapIndex(): number {
		return this.mapService.currentIndex;
	}
}
