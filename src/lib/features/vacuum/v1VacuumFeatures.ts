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
import {
	GET_CLEAN_ESTIMATE_INFO,
	GET_DRYER_SETTING,
	GET_DUST_COLLECTION_MODE,
	GET_TIMEZONE,
	SET_DRYER_SETTING,
	SET_DUST_COLLECTION_MODE,
	STATUS_FIELD_TOGGLES,
	STATUS_TOGGLES,
	V1ProbedCapabilityService
} from "./v1ProbedCapabilities";
import type { StatusToggle } from "./v1ProbedCapabilities";
import { CHANGE_SOUND_VOLUME, GET_SOUND_VOLUME, V1SoundVolumeService } from "./v1SoundVolume";
import { APP_GET_LOCALE, GET_SERIAL_NUMBER, V1DeviceIdentityService } from "./v1DeviceIdentity";
import { GET_MULTI_MAPS_LIST, V1MapInventoryService } from "./v1MapInventory";
import { NAME_MULTI_MAP, V1MapRenameService } from "./v1MapRename";
import { CLOSE_VALLEY_TIMER, GET_VALLEY_TIMER, SET_VALLEY_TIMER, V1OffPeakChargingService } from "./v1OffPeakCharging";
import {
	GET_SMART_WASH_PARAMS,
	GET_WASH_TOWEL_MODE,
	SET_SMART_WASH_PARAMS,
	SET_WASH_TOWEL_MODE,
	V1MopWashSettingsService
} from "./v1MopWashSettings";
import {
	APP_GET_CARPET_DEEP_CLEAN_STATUS,
	APP_SET_CARPET_DEEP_CLEAN_STATUS,
	V1CarpetDeepCleanService
} from "./v1CarpetDeepClean";
import {
	APP_RC_END,
	APP_RC_MOVE,
	APP_RC_START,
	APP_RC_STOP,
	REMOTE_DIRECTIONS,
	REMOTE_FIRMWARE_FEATURE,
	RemoteControlService,
	adapterClock
} from "./remoteControl";
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
import { FEATURE_INFO_FIELDS, FEATURE_STR_FIELD, INIT_STATUS_METHOD, readFeatureStr } from "../../featureStr";
import { floorFolderId, groupSelectedRoomsByMapFlag, normalizeMapFlag, sortRoomIds } from "../../map/roomKey";
import { CommandVerifier, VERIFIABLE_SET_COMMANDS } from "./commandVerification";
import type { CommandVerificationResult } from "./commandVerification";
import type { CommandOutcome } from "../../commandFeedback";

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

	/**
	 * `new_feature_info_str` as {@link INIT_STATUS_METHOD} reported it, or null while unasked.
	 *
	 * The status packet is where the rest of the adapter expects this field, and on the reference
	 * robot it is not in there. {@link V1VacuumFeatures.applyShakeMopWaterMaxBit} runs off the status
	 * packet and must not become asynchronous for one field, so the answer is kept here as well as
	 * published. Null keeps its meaning throughout: "the robot has not said", never "the bit is
	 * clear".
	 */
	private initStatusFeatureStr: string | null = null;

	protected mapService: V1MapService;
	protected mapEditService: MapEditService;
	protected settingsService: V1RobotSettingsService;
	protected probedService: V1ProbedCapabilityService;
	protected soundVolumeService: V1SoundVolumeService;
	protected deviceIdentityService: V1DeviceIdentityService;
	protected mapInventoryService: V1MapInventoryService;
	protected mapRenameService: V1MapRenameService;
	protected offPeakService: V1OffPeakChargingService;
	protected mopWashSettingsService: V1MopWashSettingsService;
	protected carpetDeepCleanService: V1CarpetDeepCleanService;

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

	/**
	 * Holds the remote control session and its dead man's switch.
	 *
	 * Built for every V1 robot but only ever used by one whose firmware reports feature 125 - the
	 * commands that reach it are not registered otherwise. Its only timer comes from the adapter's
	 * own `setTimeout`, so `onUnload` disposes of it with the rest; {@link shutdownRemoteControl}
	 * additionally sends the closing calls on the way out.
	 */
	public readonly remoteControl: RemoteControlService = new RemoteControlService(
		{ sendRequest: (duid, method, params, options) => this.deps.adapter.requestsHandler.sendRequest(duid, method, params, options) },
		adapterClock(this.deps),
		this.duid,
		(message, level) => this.deps.adapter.rLog("System", this.duid, level === "warn" ? "Warn" : level === "info" ? "Info" : "Debug", "1.0", undefined, message, level),
		(active) => void this.writeRemoteSessionFlag(active)
	);

	/** State that remembers an open session across an adapter restart; see `recoverLeftoverSession`. */
	private static readonly REMOTE_SESSION_STATE = "remoteControl.sessionOpen";

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
		this.probedService = new V1ProbedCapabilityService(this.deps, this.duid);
		this.soundVolumeService = new V1SoundVolumeService(this.deps, this.duid);
		this.deviceIdentityService = new V1DeviceIdentityService(this.deps, this.duid);
		this.mapInventoryService = new V1MapInventoryService(this.deps, this.duid);
		// The rename reads and re-reads the very list the inventory publishes, so it is handed that
		// service rather than given a list of its own. Two readers of `get_multi_maps_list` that do
		// not share what they read is how a rename would be judged against a stale list.
		this.mapRenameService = new V1MapRenameService(this.deps, this.duid, this.mapInventoryService);
		this.offPeakService = new V1OffPeakChargingService(this.deps, this.duid);
		this.mopWashSettingsService = new V1MopWashSettingsService(this.deps, this.duid);
		this.carpetDeepCleanService = new V1CarpetDeepCleanService(this.deps, this.duid);
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
	 * **The field is not in the status packet of every robot** - on the reference robot it is in
	 * none of them, which is why the gate did nothing there for two days and the dead control stayed
	 * on screen. {@link V1VacuumFeatures.updateInitStatus} fetches it from the one call that answers
	 * it and leaves it in {@link V1VacuumFeatures.initStatusFeatureStr}; the status packet still
	 * wins where it carries the field, because that is the fresher of the two.
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

		const reported = status?.[FEATURE_STR_FIELD];
		const announced = readFeatureStr(reported === undefined ? this.initStatusFeatureStr : reported);
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

	/**
	 * Asks the robot for its two feature bitfields and publishes them as `deviceStatus` states.
	 *
	 * `new_feature_info` and `new_feature_info_str` are answered by {@link INIT_STATUS_METHOD} and,
	 * on the reference robot, by nothing else: its `get_status` has 51 fields and carries neither,
	 * measured twice 4 h 47 min apart. Four places in the adapter read those two states, and every
	 * one of them read an absent state and took the answer "no" - see the table in `featureStr.ts`.
	 *
	 * Published rather than only cached, because three of the four readers sit in other modules and
	 * reach the value through `getStateAsync`. `processResultKey` is the same route a `get_status`
	 * key takes, so the states are indistinguishable from the ones the robots that *do* report the
	 * fields in their status have always produced.
	 *
	 * Failure is not evidence: a robot that does not know the method, or answers something that is
	 * not an object, leaves every reader exactly where it was. That direction is deliberate - the
	 * one bit that takes a control away (45) may only do so on a positive answer.
	 */
	public async updateInitStatus(): Promise<void> {
		let response: unknown;
		try {
			response = await this.deps.adapter.requestsHandler.sendRequest(this.duid, INIT_STATUS_METHOD, [], { priority: -10 });
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined,
				`${INIT_STATUS_METHOD} was not answered; the feature bitfields stay unknown: ${this.deps.adapter.errorMessage(e)}`, "debug");
			return;
		}

		// Same unwrapping as `requestAndProcess`: the answer arrives as `[{…}]`.
		let unwrapped: unknown = response;
		while (Array.isArray(unwrapped) && unwrapped.length === 1) {
			unwrapped = unwrapped[0];
		}
		if (typeof unwrapped !== "object" || unwrapped === null || Array.isArray(unwrapped)) {
			return;
		}

		const result = unwrapped as Record<string, unknown>;
		const featureStr = result[FEATURE_STR_FIELD];
		if (typeof featureStr === "string") {
			this.initStatusFeatureStr = featureStr;
		}

		await this.deps.ensureFolder(`Devices.${this.duid}.deviceStatus`);
		for (const field of FEATURE_INFO_FIELDS) {
			const value = result[field];
			if (value === undefined || value === null) continue;
			await this.processResultKey("deviceStatus", field, value);
		}
	}

	public override async initializeDeviceData(): Promise<void> {
		// 0. The feature bitfields, before anything acts on them. `updateStatus` below runs the
		//    Extreme gate, and the map poller and the map editor read the states this writes.
		await this.updateInitStatus();
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

		if (finalMethod === GET_TIMEZONE) {
			await this.probedService.applyTimezoneResponse(response);
		} else if (finalMethod === GET_CLEAN_ESTIMATE_INFO) {
			await this.probedService.applyCleanEstimateResponse(response);
		} else if (finalMethod === GET_DUST_COLLECTION_MODE) {
			await this.probedService.applyDustCollectionModeResponse(response);
		} else if (finalMethod === GET_DRYER_SETTING) {
			await this.probedService.applyDryerSettingResponse(response);
		} else if (finalMethod === SET_DUST_COLLECTION_MODE) {
			// The robot is the authority on what it really took, and neither setting shows up in the
			// status packet - so reading it back is the only honest check. That is also why neither
			// is in `commandVerification`: an expectation on a status field it never reports would
			// be exactly the false alarm that had to be removed from `set_dnd_timer`.
			void this.readProbedValue(GET_DUST_COLLECTION_MODE, [], (r) => this.probedService.applyDustCollectionModeResponse(r));
		} else if (finalMethod === SET_DRYER_SETTING) {
			void this.readProbedValue(GET_DRYER_SETTING, [], (r) => this.probedService.applyDryerSettingResponse(r));
		}

		await this.noteStatusToggleResult(finalMethod, response);

		if (finalMethod === GET_SOUND_VOLUME) {
			await this.soundVolumeService.applyVolumeResponse(response);
		} else if (finalMethod === CHANGE_SOUND_VOLUME) {
			// Read back for the same reason the two dock settings are: the volume is in no status
			// packet, so the robot is the only authority on what it really took - and the app's own
			// slider is narrower than the range this adapter allows, so a refusal is a real
			// possibility rather than a theoretical one.
			void this.readProbedValue(GET_SOUND_VOLUME, [], (r) => this.soundVolumeService.applyVolumeResponse(r));
		} else if (finalMethod === GET_SERIAL_NUMBER) {
			await this.deviceIdentityService.applySerialNumberResponse(response);
		} else if (finalMethod === APP_GET_LOCALE) {
			await this.deviceIdentityService.applyLocaleResponse(response);
		} else if (finalMethod === GET_VALLEY_TIMER) {
			await this.offPeakService.applyResponse(response);
		} else if (finalMethod === SET_VALLEY_TIMER || finalMethod === CLOSE_VALLEY_TIMER) {
			// Read back for the same reason the Do Not Disturb window is: the robot may clamp or
			// reorder what it was sent, `close_*` says nothing about which window it switched off,
			// and none of it appears in the status packet.
			void this.readProbedValue(GET_VALLEY_TIMER, [], (r) => this.offPeakService.applyResponse(r));
		} else if (finalMethod === GET_WASH_TOWEL_MODE) {
			await this.mopWashSettingsService.applyWashTowelModeResponse(response);
		} else if (finalMethod === SET_WASH_TOWEL_MODE) {
			// Read back for the reason the two dock settings are: neither wash setting appears in the
			// status packet, so the robot is the only authority on what it really took - and the
			// picker offers three of five values, so a robot that holds one of the other two would
			// otherwise keep showing the value that was written rather than the one it has.
			void this.readProbedValue(GET_WASH_TOWEL_MODE, {}, (r) => this.mopWashSettingsService.applyWashTowelModeResponse(r));
		} else if (finalMethod === GET_SMART_WASH_PARAMS) {
			await this.mopWashSettingsService.applySmartWashResponse(response);
		} else if (finalMethod === SET_SMART_WASH_PARAMS) {
			void this.readProbedValue(GET_SMART_WASH_PARAMS, {}, (r) => this.mopWashSettingsService.applySmartWashResponse(r));
		} else if (finalMethod === APP_GET_CARPET_DEEP_CLEAN_STATUS) {
			await this.carpetDeepCleanService.applyResponse(response);
		} else if (finalMethod === APP_SET_CARPET_DEEP_CLEAN_STATUS) {
			void this.readProbedValue(APP_GET_CARPET_DEEP_CLEAN_STATUS, {}, (r) => this.carpetDeepCleanService.applyResponse(r));
		} else if (finalMethod === GET_MULTI_MAPS_LIST && this.hasFeature(Feature.MapInventory)) {
			// Guarded on the feature because `V1MapService` asks for the same list on its own and
			// its answer travels the same path; a robot that was never offered the inventory must
			// not get its states created as a side effect of somebody else's request.
			await this.mapInventoryService.applyMultiMapsList(response);
		} else if (finalMethod === NAME_MULTI_MAP) {
			// The rename is judged by the list, not by this answer. `name_multi_map` has no
			// documented reply, and `classifyRobotAnswer` only tests `set_*` - so whatever arrived
			// here already counts as "accepted", which says nothing about the name. Same reasoning
			// as when a schedule is deleted: only the freshly read list is evidence.
			void this.mapRenameService.confirmPendingRenames();
		}

		this.noteRemoteControlResult(finalMethod);

		this.noteCommandForVerification(finalMethod, response, params);
	}

	/**
	 * Keeps the remote control session in step with what the robot actually answered.
	 *
	 * Deliberately driven from the **answer** and not from the request. A session opened when
	 * `app_rc_start` was merely sent would outlive a start that never arrived, and the adapter would
	 * later close a mode the robot was never in. `onCommandResult` runs only after a reply
	 * (`requestsHandler.ts`, the success branch of `_processResult`), so reaching here means the
	 * robot spoke.
	 *
	 * Both `app_rc_move` and `app_rc_stop` extend the lease: a user who is holding "stop" is still a
	 * user who is there, and ending the mode under them would be surprising.
	 *
	 * @param finalMethod The method that actually went on the wire.
	 */
	private noteRemoteControlResult(finalMethod: string): void {
		if (finalMethod === APP_RC_START) {
			this.remoteControl.noteStarted();
		} else if (finalMethod === APP_RC_MOVE || finalMethod === APP_RC_STOP) {
			this.remoteControl.noteActivity();
		} else if (finalMethod === APP_RC_END) {
			this.remoteControl.noteEnded();
		}
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
				await this.publishVerificationResult(result, "confirmed");
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
			await this.publishVerificationResult(result, "ineffective", detail);
		}
	}

	/**
	 * Marks the command state with the verdict of the status check.
	 *
	 * This is the second stage of one and the same statement: the first said the robot answered
	 * `["ok"]`, this one says whether that meant anything. Both land on the same state, so no
	 * correlation is needed - the state the user wrote is the state that now carries the verdict.
	 *
	 * `confirmed` deliberately writes as well, and not only to say so: it is what clears a failure
	 * mark from an earlier attempt. `processStatus` mirrors the status with `setStateChanged`, which
	 * writes nothing when the value did not change, so a mark left there would otherwise stand for
	 * ever.
	 *
	 * @param result  The verdict.
	 * @param outcome `confirmed` or `ineffective`.
	 * @param detail  What the robot reports instead, for the `ineffective` wording.
	 */
	private async publishVerificationResult(result: CommandVerificationResult, outcome: CommandOutcome, detail?: string): Promise<void> {
		// Guarded for the same reason the funnel is: this runs inside `processStatus`, and a status
		// pass must not be lost because a mark could not be written. The warning is already in the
		// log by the time we get here, so nothing is silently dropped.
		try {
			await this.deps.adapter.markCommandOutcome?.(this.duid, {
				command: result.command,
				outcome,
				folder: this.folderOfCommand(result.command),
				extraArgs: outcome === "ineffective" ? [`${Math.round(result.elapsedMs / 1000)}s`, detail ?? ""] : undefined
			});
		} catch {
			// Nothing to add: whatever this was about has already been said in the log above.
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

		if (this.probedService.handles(method)) {
			return this.probedService.buildCommandParams(method, params);
		}

		if (this.remoteControl.handles(method)) {
			return this.remoteControl.buildCommandParams(method, params);
		}

		if (this.soundVolumeService.handles(method)) {
			return this.soundVolumeService.buildCommandParams(method, params);
		}

		if (this.deviceIdentityService.handles(method)) {
			return this.deviceIdentityService.buildCommandParams(method);
		}

		if (this.offPeakService.handles(method)) {
			return this.offPeakService.buildCommandParams(method, params);
		}

		if (this.mopWashSettingsService.handles(method)) {
			return this.mopWashSettingsService.buildCommandParams(method, params);
		}

		if (this.carpetDeepCleanService.handles(method)) {
			return this.carpetDeepCleanService.buildCommandParams(method, params);
		}

		if (this.mapRenameService.handles(method)) {
			return this.mapRenameService.buildCommandParams(method, params);
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

		// The settings that have no getter: the packet is both the capability answer and the value.
		await this.applyStatusFieldToggles(validStatus);

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
	 * Asks the robot which of the probeable commands it has.
	 *
	 * Every entry here costs one request at start-up, and a capability only belongs here once its
	 * **write** side is proven too - a probe that shows a robot can *read* something proves nothing
	 * about how to write it. The two purely reading entries go first because neither can change
	 * anything on the device, so an unexpected answer costs nothing at all.
	 *
	 * | Capability | Why its write side is proven | Fundstelle |
	 * | --- | --- | --- |
	 * | Obstacle avoidance | wrapper builds `{status}`, switch computes `on ? 1 : 0` | A65:230180-230192, A65:837660-837680 |
	 * | Empty mode | picker keys 0/1/2/**4** reach `{mode}` unchanged | A65:438312-438375, A65:230399-230410 |
	 * | Drying | wrapper composes `{on:{dry_time}, status}`, three call sites agree | A65:230351-230370 |
	 * | Mop wash mode | wrapper builds `{wash_mode}`, picker keys read one by one | A65:231019-231030, A65:438032-438155 |
	 * | Mop wash frequency | wrapper builds `{smart_wash, wash_interval}`, four call sites agree | A65:230757-230770 |
	 * | Deep carpet cleaning | wrapper passes through, **caller** builds `{status: on ? 1 : 0}` | A65:230030-230039, A65:902697-902712 |
	 * | Time zone, estimate | read-only, nothing is written | — |
	 *
	 * The measurement showed the a65 answers all five getters although the adapter offered four of
	 * the commands to the a179 alone and the empty mode to nobody
	 * (`_appanalysis/19-geraetefaehigkeiten.md` §4, `_appanalysis/22-einstellungsblock.md`).
	 *
	 * **A correction, because this comment used to say the opposite.** It claimed the last three were
	 * left out because "their setters pass their argument straight through in the app, so the payload
	 * is unread". That is true of exactly one of them, `app_set_carpet_deep_clean_status`
	 * (A65:230030-230039). The other two build their payload inside the wrapper and always did, and
	 * the reason held both of them back for nothing. What was really missing was the **value range**,
	 * not the payload shape - see `v1MopWashSettings.ts` for the picker each value is read from, and
	 * `v1CarpetDeepClean.ts` for the caller that had to supply what its wrapper does not.
	 *
	 * `get_wash_towel_mode` yes / `get_wash_towel_params` no remains the standing warning that even
	 * neighbours differ, which is why each of the three is unlocked by its own getter.
	 */
	protected override async detectProbedCapabilities(): Promise<void> {
		await this.probeAndApply(GET_TIMEZONE, [], Feature.RobotTimezone, GET_TIMEZONE);
		await this.probeAndApply(GET_CLEAN_ESTIMATE_INFO, {}, Feature.CleanEstimate, GET_CLEAN_ESTIMATE_INFO);
		await this.probeAndApply(GET_COLLISION_AVOID_STATUS, {}, Feature.CollisionAvoid, SET_COLLISION_AVOID_STATUS);
		await this.probeAndApply(GET_DUST_COLLECTION_MODE, [], Feature.DustCollectionMode, SET_DUST_COLLECTION_MODE);
		await this.probeAndApply(GET_DRYER_SETTING, [], Feature.DryerSetting, SET_DRYER_SETTING);
		await this.detectRemoteControl();
		await this.detectStatusToggles();
		await this.probeAndApply(GET_SOUND_VOLUME, [], Feature.SoundVolume, CHANGE_SOUND_VOLUME);
		await this.probeAndApply(GET_SERIAL_NUMBER, [], Feature.DeviceIdentity, GET_SERIAL_NUMBER);
		await this.probeAndApply(GET_MULTI_MAPS_LIST, [], Feature.MapInventory, GET_MULTI_MAPS_LIST);
		await this.probeAndApply(GET_VALLEY_TIMER, [], Feature.OffPeakCharging, SET_VALLEY_TIMER);
		// All three send `{}` rather than `[]`, read off their own wrappers - A65:229273-229282,
		// A65:229016-229025 and A65:228301-228310.
		await this.probeAndApply(GET_WASH_TOWEL_MODE, {}, Feature.WashTowelMode, SET_WASH_TOWEL_MODE);
		await this.probeAndApply(GET_SMART_WASH_PARAMS, {}, Feature.SmartWash, SET_SMART_WASH_PARAMS);
		await this.probeAndApply(APP_GET_CARPET_DEEP_CLEAN_STATUS, {}, Feature.CarpetDeepClean, APP_SET_CARPET_DEEP_CLEAN_STATUS);
	}

	/**
	 * Publishes how thoroughly the dock washes the mop, and reads its current position once.
	 *
	 * Read at start-up because the mode is in no status packet: a picker showing its first entry on
	 * a robot set to something else is the same lie as a dead switch. Which values are offered, and
	 * why two of the five are not, is in `v1MopWashSettings.ts`.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.WashTowelMode)
	public async initWashTowelMode(): Promise<void> {
		this.mopWashSettingsService.registerWashTowelModeCommands((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(GET_WASH_TOWEL_MODE, {}, (response) => this.mopWashSettingsService.applyWashTowelModeResponse(response));
	}

	/**
	 * Publishes how often the robot returns to wash the mop, and reads it once.
	 *
	 * One service holds both wash settings but registers them separately, and that has to stay that
	 * way: `probeAndApply` skips a capability whose command is already registered, so a shared
	 * registration would let the mode's probe swallow this one - the frequency would never be asked
	 * about and would silently never appear. It is also the honest split, since a robot can answer
	 * one of the two getters and not the other.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.SmartWash)
	public async initSmartWash(): Promise<void> {
		this.mopWashSettingsService.registerSmartWashCommands((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(GET_SMART_WASH_PARAMS, {}, (response) => this.mopWashSettingsService.applySmartWashResponse(response));
	}

	/**
	 * Publishes the deep carpet cleaning switch and reads its position once.
	 *
	 * The switch is not in the status packet either, and a switch that shows "off" on a robot that
	 * has it on would invite the user to turn on what is already running.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.CarpetDeepClean)
	public async initCarpetDeepClean(): Promise<void> {
		this.carpetDeepCleanService.registerCommands((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(APP_GET_CARPET_DEEP_CLEAN_STATUS, {}, (response) => this.carpetDeepCleanService.applyResponse(response));
	}

	/**
	 * Publishes the off-peak charging window, its off button and its read button.
	 *
	 * Read once at start-up: the window is in no status packet, and a field left empty would look
	 * like "no window set" on a robot that has one.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.OffPeakCharging)
	public async initOffPeakCharging(): Promise<void> {
		this.offPeakService.registerCommands((name, spec, group) => this.addCommand(name, spec, group));
		await this.offPeakService.ensureStates();
		void this.readProbedValue(GET_VALLEY_TIMER, [], (response) => this.offPeakService.applyResponse(response));
	}

	/**
	 * Publishes which map is loaded, what backups the robot says it keeps, and renames a map.
	 *
	 * Deleting and restoring stay out - see `v1MapInventory.ts` for why `get_map_status` is not used
	 * and for the payloads of the three destructive calls that were established but deliberately not
	 * built.
	 *
	 * Whether those backups would be offered for restoring is published by the service itself, out
	 * of the list plus one firmware bit. It used to be probed here with `get_recover_maps`, and that
	 * was wrong: the app has two restore flows and that call belongs to the other one.
	 *
	 * ## Why the rename hangs off this feature and not off a probe of its own
	 *
	 * `Feature.MapInventory` is granted when the robot **answers `get_multi_maps_list`**
	 * (`detectProbedCapabilities`), and that is exactly the right question for renaming: a robot
	 * that cannot list its maps has no slot to rename and no way to show that a rename took. The
	 * three alternatives were each considered and each is worse here:
	 *
	 * - **`capabilityProbe.ts` would have to call the method it is testing.** It refuses anything
	 *   that is not a `get_*` for that reason (`capabilityProbe.ts:107`), and the reason applies
	 *   with full force to a method that changes a stored name.
	 * - **A feature bit** would need one that means "can rename a map", and none is known. Reading a
	 *   bit that has not been identified is worse than reading nothing, and `new_feature_info` is
	 *   not in the status packet at all - four checks have already mistaken its absence for a
	 *   cleared bit.
	 * - **`STATUS_FIELD_TOGGLES`** answers about fields the status packet carries. Map names are not
	 *   among them.
	 *
	 * The list does the second half of the gating as well, at the moment of use rather than at
	 * start-up: a rename naming a slot the robot never listed is refused before anything is sent.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.MapInventory)
	public async initMapInventory(): Promise<void> {
		this.addCommand(GET_MULTI_MAPS_LIST, {
			type: "boolean",
			role: "button",
			name: "Read the map list and its backups",
			def: false
		}, "queries");

		this.mapRenameService.registerCommands((name, spec, group) => this.addCommand(name, spec, group));

		// `mapInventory.restoreSupported` is published from inside this read, because the backup
		// count is one of the two inputs it is computed from. It used to be a separate probe of
		// `get_recover_maps` here - that call belongs to the app's *other* restore flow and answered
		// for the wrong one; see the file comment of `v1MapInventory.ts`.
		void this.readProbedValue(GET_MULTI_MAPS_LIST, [], (response) => this.mapInventoryService.applyMultiMapsList(response));
	}

	/**
	 * Publishes the speaking volume, its sound test and its read button.
	 *
	 * Read once at start-up, because the volume is not in the status packet and a slider that shows
	 * a default the robot never reported is the same lie as a dead switch.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.SoundVolume)
	public async initSoundVolume(): Promise<void> {
		this.soundVolumeService.registerCommands((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(GET_SOUND_VOLUME, [], (response) => this.soundVolumeService.applyVolumeResponse(response));
	}

	/**
	 * Publishes what the robot says about itself, read-only.
	 *
	 * Unlocked by `get_serial_number` alone although it reads two commands. The alternative would be
	 * a second probe for `app_get_locale`, which costs a request to learn something the first one
	 * already indicates - and if the locale read fails anyway, its states simply do not appear,
	 * which is the same outcome with one request less.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.DeviceIdentity)
	public async initDeviceIdentity(): Promise<void> {
		this.deviceIdentityService.registerCommands((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(GET_SERIAL_NUMBER, [], (response) => this.deviceIdentityService.applySerialNumberResponse(response));
		void this.readProbedValue(APP_GET_LOCALE, [], (response) => this.deviceIdentityService.applyLocaleResponse(response));
	}

	/**
	 * Setters this robot answered the getter for, and which are therefore worth publishing.
	 *
	 * Filled by {@link detectStatusToggles} and read by {@link initStatusToggles}. Kept as a set
	 * rather than as five separate features, because the five differ in nothing but their name -
	 * five enum entries and five near-identical registration methods would be five places for the
	 * next one to drift out of step.
	 */
	private readonly probedStatusToggles = new Set<string>();

	/**
	 * Status-carried settings this robot has shown a field for.
	 *
	 * Grows from `processStatus`, not from the probe: these have no getter to ask (see
	 * {@link STATUS_FIELD_TOGGLES}). A setter stays out of the object tree until the robot has
	 * mentioned its field at least once.
	 */
	private readonly seenStatusFieldToggles = new Set<string>();

	/**
	 * Asks the robot about each of the five on/off settings and remembers the ones it has.
	 *
	 * All five are read-probed, so an unexpected answer costs nothing: `get_*` cannot change the
	 * device. The measurement on the test device is what makes this worth doing rather than
	 * declaring the switches for a model class - of the five, the a65 answers **one**
	 * (`get_clean_follow_ground_material_status` → `{"status":0}`) and rejects the other four with
	 * `unknown_method` (`_appanalysis/geraetefaehigkeiten-1786790619395.json`). A model table would
	 * have had to be right about all five for every robot; the robot is right about itself.
	 *
	 * One feature is applied for the whole group, and only when at least one switch survived - a
	 * robot that has none of them gets no folder entry and no control, which is the point.
	 */
	private async detectStatusToggles(): Promise<void> {
		for (const toggle of STATUS_TOGGLES) {
			if (this.folderOfCommand(toggle.setter)) continue;

			const verdict = await this.capabilityProbe.probe(toggle.getter, []);
			if (verdict !== "capable") continue;

			this.probedStatusToggles.add(toggle.setter);
		}

		if (this.probedStatusToggles.size > 0) await this.applyFeature(Feature.StatusToggles);
	}

	/**
	 * Publishes the on/off settings the robot answered for, and reads each one once.
	 *
	 * The read is not optional comfort here. None of these five appears in the status packet of any
	 * robot measured so far (48 fields on the test device, `_appanalysis/local-mitschnitt.log`), so
	 * without it the switch would sit at its default and claim a position the robot never reported -
	 * a switch showing "off" for a setting that is on is the same lie as a dead switch. It is not
	 * awaited, for the reason `initDoNotDisturb` states.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.StatusToggles)
	public async initStatusToggles(): Promise<void> {
		for (const toggle of STATUS_TOGGLES) {
			if (!this.probedStatusToggles.has(toggle.setter)) continue;

			this.probedService.registerStatusToggle(toggle, (name, spec, group) => this.addCommand(name, spec, group));
			void this.readStatusToggle(toggle);
		}
	}

	/**
	 * Unlocks and updates the settings the robot carries in its status packet.
	 *
	 * Runs on every poll, because that is the only place these appear. A field the robot never
	 * mentions never creates a switch - which is the whole capability decision, and it costs no
	 * request at all.
	 *
	 * The value is written on every packet and not only on the first, deliberately: Roborock calls
	 * corner mopping a single-use mode, so the robot is expected to clear it by itself after a run.
	 * A switch that only ever learnt the first value would then show "on" for a setting the robot
	 * has already dropped.
	 *
	 * @param status The robot's `get_status` result.
	 */
	private async applyStatusFieldToggles(status: Record<string, any>): Promise<void> {
		for (const toggle of STATUS_FIELD_TOGGLES) {
			const raw = status?.[toggle.statusField];
			if (raw === undefined || raw === null) continue;

			if (!this.seenStatusFieldToggles.has(toggle.setter)) {
				// A model class that already declares the setter owns it, mirroring included;
				// unlocking it a second time here would put one command in two folders. Same guard as
				// `detectStatusToggles` - but asked **only before the first registration**, because
				// after ours the command is in a folder too and the guard would then skip every
				// further packet, freezing the switch at the first value it ever saw.
				if (this.folderOfCommand(toggle.setter)) continue;

				this.seenStatusFieldToggles.add(toggle.setter);
				this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined,
					`The robot reports ${toggle.statusField}, so ${toggle.setter} is offered (${toggle.fundstelle}).`, "info");
				await this.applyFeature(Feature.StatusFieldToggles);
			}

			await this.probedService.applyStatusFieldValue(toggle, raw);
		}
	}

	/**
	 * Publishes the status-carried settings the robot has shown a field for.
	 *
	 * Applied from {@link applyStatusFieldToggles}, so by the time this runs at least one field has
	 * arrived. No read is started afterwards, unlike {@link initStatusToggles}: the value came with
	 * the packet that triggered this, and the caller writes it immediately after.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.StatusFieldToggles)
	public async initStatusFieldToggles(): Promise<void> {
		for (const toggle of STATUS_FIELD_TOGGLES) {
			if (!this.seenStatusFieldToggles.has(toggle.setter)) continue;
			this.probedService.registerStatusFieldToggle(toggle, (name, spec, group) => this.addCommand(name, spec, group));
		}
	}

	/**
	 * Keeps an on/off setting in step with the robot after it was read or written.
	 *
	 * The read-back after a write is the same reasoning as for the empty mode and the drying
	 * setting: the robot is the authority on what it really took, none of these five shows up in a
	 * status packet, so asking again is the only honest check. It is also why none of them is in
	 * `commandVerification` - an expectation on a status field the robot never sends would be
	 * exactly the false alarm that had to be removed from `set_dnd_timer`.
	 *
	 * @param finalMethod The method that actually went on the wire.
	 * @param response The robot's answer.
	 */
	private async noteStatusToggleResult(finalMethod: string, response: unknown): Promise<void> {
		const toggle = STATUS_TOGGLES.find((entry) => entry.getter === finalMethod || entry.setter === finalMethod);
		if (!toggle || !this.probedStatusToggles.has(toggle.setter)) return;

		if (finalMethod === toggle.getter) {
			await this.probedService.applyStatusToggleResponse(toggle, response);
			return;
		}
		void this.readStatusToggle(toggle);
	}

	/** Reads one on/off setting and publishes its position, swallowing failure. */
	private async readStatusToggle(toggle: StatusToggle): Promise<void> {
		await this.readProbedValue(toggle.getter, [], (response) => this.probedService.applyStatusToggleResponse(toggle, response));
	}

	/**
	 * Unlocks driving the robot by hand when its firmware says it can be driven.
	 *
	 * **Not a capability probe, and it cannot be one.** `CapabilityProbe` refuses anything that is
	 * not a `get_*`/`app_get_*` (`capabilityProbe.ts:107`), and rightly so - a probe must never
	 * change the device. All four remote calls are actions, and there is no reading counterpart to
	 * ask instead: the whole method catalogue of the test device was swept for one
	 * (`_appanalysis/19-geraetefaehigkeiten.md`, 66 read-only calls) and none exists.
	 *
	 * So the question is put the only other way the device can answer it: `get_fw_features`, and the
	 * presence of **125** in the list. That is still the robot speaking about itself rather than a
	 * model table - the criterion this project asks for - and it is exactly what the app reads:
	 * `isRemoteSupported() { return isSupportFeature(125); }` (A65:232713-232720), with
	 * `isSupportFeature` being a plain membership test on the same list (A65:234799-234825).
	 *
	 * One difference from the app is deliberate. The app fills its list from
	 * `app_get_init_status().result[0].feature_info` (A65:5773); the adapter has `get_fw_features`
	 * and a cache for it already. On the test device both answers are the identical `[111…125]`
	 * (`_appanalysis/geraetefaehigkeiten-1786790619395.json`), so nothing is lost, and the request
	 * the adapter already knows how to make is the cheaper one.
	 *
	 * A robot that does not answer keeps the function switched off for this run - the same direction
	 * of error the probe takes, and the same reason: a control that writes into the void is worse
	 * than a missing one, and this control moves a machine.
	 */
	private async detectRemoteControl(): Promise<void> {
		if (this.folderOfCommand(APP_RC_START)) return;

		const features = await this.readFirmwareFeatureIds();
		if (!features.includes(REMOTE_FIRMWARE_FEATURE)) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined,
				`Firmware feature ${REMOTE_FIRMWARE_FEATURE} is absent, not offering remote control.`, "debug");
			return;
		}

		await this.applyFeature(Feature.RemoteControl);
	}

	/**
	 * Reads the firmware feature list once and remembers it for the rest of the run.
	 *
	 * Goes through the same cache `a179_features.ts` fills, so a robot that has both paths asks the
	 * question once. Failure returns an empty list rather than throwing: every caller treats
	 * "not in the list" as "does not have it", and an unreachable robot is not evidence in favour.
	 *
	 * @returns The feature ids the robot reports, or an empty list.
	 */
	private async readFirmwareFeatureIds(): Promise<number[]> {
		const cached = this.deps.http_api.getFwFeaturesResult?.(this.duid);
		if (Array.isArray(cached) && cached.length > 0) return cached;

		try {
			const response = await this.deps.adapter.requestsHandler.sendRequest(this.duid, "get_fw_features", [], { priority: -10 });
			let payload: unknown = response;
			if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in (payload as Record<string, unknown>)) {
				payload = (payload as Record<string, unknown>).data;
			}
			if (!Array.isArray(payload)) return [];

			const ids = payload.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry));
			this.deps.http_api.storeFwFeaturesResult?.(this.duid, ids);
			return ids;
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined,
				`Failed to read get_fw_features: ${this.deps.adapter.errorMessage(e)}`, "debug");
			return [];
		}
	}

	/**
	 * Publishes the four remote control commands in a folder of their own.
	 *
	 * They are kept out of `commands` on purpose. Everything in there is a single action that stands
	 * on its own; these four are a **session**, and three of them are meaningless without the fourth.
	 * A folder makes that visible in the object tree and lets the tab subscribe to exactly this
	 * branch.
	 *
	 * `app_rc_move` is published as a direction, not as a raw motion parameter. The eight values are
	 * the app's own `pressState` numbers and the service turns each into the proven
	 * `{omega, velocity, seqnum, duration}` - so a script cannot invent a speed, and the one thing it
	 * can express is the one thing the app can express.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.RemoteControl)
	public async initRemoteControl(): Promise<void> {
		const directions: Record<number, string> = {};
		for (const entry of REMOTE_DIRECTIONS) {
			directions[entry.value] = entry.label;
		}

		this.addCommand(APP_RC_START, {
			type: "boolean",
			role: "button",
			name: "Start remote control",
			desc: "The robot needs about six seconds after this before it acts on a direction.",
			def: false
		}, "remoteControl");

		this.addCommand(APP_RC_MOVE, {
			type: "number",
			role: "value.list",
			name: "Drive one step",
			desc: "Drives for at most 1.5 s; repeat about every 400 ms to keep going. 0 stops.",
			states: directions,
			def: 0,
			write: true
		}, "remoteControl");

		this.addCommand(APP_RC_STOP, {
			type: "boolean",
			role: "button",
			name: "Stop moving",
			desc: "Stops the motion but stays in remote control mode.",
			def: false
		}, "remoteControl");

		this.addCommand(APP_RC_END, {
			type: "boolean",
			role: "button",
			name: "Leave remote control",
			def: false
		}, "remoteControl");

		await this.recoverRemoteSession();
	}

	/**
	 * Writes down whether a remote control session is open, so a restart can find one that was not.
	 *
	 * Acknowledged and read-only: this is the adapter reporting what it is doing, not a switch. It
	 * lives in the same folder as the four commands so everything about the mode is in one place.
	 *
	 * @param active Whether a session is open right now.
	 */
	private async writeRemoteSessionFlag(active: boolean): Promise<void> {
		try {
			await this.stateWriter.ensureAndSetState(V1VacuumFeatures.REMOTE_SESSION_STATE, {
				name: "Remote control session open",
				type: "boolean",
				role: "indicator",
				read: true,
				write: false
			}, active);
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Failed to record the remote control session flag: ${this.deps.adapter.errorMessage(e)}`, "warn");
		}
	}

	/**
	 * Closes a session an earlier adapter run left open.
	 *
	 * Runs once, while the commands are being registered. Not awaited any further than this: the
	 * flag is nearly always false, and in the rare case it is not, two calls to a robot that is
	 * standing still are not worth delaying the start-up for.
	 */
	private async recoverRemoteSession(): Promise<void> {
		try {
			const flag = await this.deps.adapter.getStateAsync(`Devices.${this.duid}.${V1VacuumFeatures.REMOTE_SESSION_STATE}`);
			await this.remoteControl.recoverLeftoverSession(flag?.val === true);
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined,
				`Could not check for a leftover remote control session: ${this.deps.adapter.errorMessage(e)}`, "debug");
		}
	}

	/**
	 * Ends an open remote control session on the way out of the adapter.
	 *
	 * Called from `onUnload`, which cannot await anything, so this is best effort by construction -
	 * see {@link RemoteControlService.shutdown}. It is the third of four defences and the only one
	 * that needs the adapter to still be alive.
	 */
	public shutdownRemoteControl(): void {
		this.remoteControl.shutdown();
	}

	/**
	 * Asks for one capability and applies its feature when the robot has it.
	 *
	 * **The guard is per capability, not per method.** Until the second entry arrived this was a
	 * plain `return` at the top of the caller, which read the same and is not: a robot whose model
	 * class already declares obstacle avoidance would have left the whole method before any other
	 * capability was ever asked about. That is the kind of early return that stays correct exactly
	 * as long as there is one thing to do.
	 *
	 * @param getter Reading command that decides the question; also what the probe sends.
	 * @param params Exactly what the app's own wrapper sends, `[]` or `{}`.
	 * @param feature Feature to apply on a positive verdict.
	 * @param declared Command whose presence means a model class already owns this capability. It is
	 *                 not always the getter: for a writable setting the setter is what a model class
	 *                 declares, and two owners for one command would tear its parameter building
	 *                 apart - `A179Features` calls `super.getCommandParams` before its own branch.
	 */
	private async probeAndApply(getter: string, params: unknown, feature: Feature, declared: string): Promise<void> {
		if (this.folderOfCommand(declared)) return;

		const verdict = await this.capabilityProbe.probe(getter, params);
		if (verdict !== "capable") return;

		await this.applyFeature(feature);
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.CollisionAvoid)
	public async initCollisionAvoid(): Promise<void> {
		this.settingsService.registerCollisionAvoidCommand((name, spec, group) => this.addCommand(name, spec, group));
	}

	/**
	 * Publishes the child lock switch, unless the model class already declared one.
	 *
	 * `A179Features` brings its own `set_child_lock_status` together with its own parameter
	 * building, and it calls `super.getCommandParams` before its own branch runs
	 * (`a179_features.ts:1303-1330`). Registering a second definition here would leave that model
	 * with two owners for one command; see {@link V1RobotSettingsService} for the whole reasoning.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.ChildLock)
	public async initChildLock(): Promise<void> {
		if (this.folderOfCommand(SET_CHILD_LOCK_STATUS)) return;
		this.settingsService.registerChildLockCommand((name, spec, group) => this.addCommand(name, spec, group));
	}

	/**
	 * Publishes the robot's time zone and reads it once.
	 *
	 * Worth its own state because the Do Not Disturb window runs in the robot's clock, not the
	 * host's - Roborock says so itself (`setting_timezone_remark_owner`). Read-only: setting the
	 * zone stays in the app.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.RobotTimezone)
	public async initRobotTimezone(): Promise<void> {
		this.probedService.registerTimezoneCommand((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(GET_TIMEZONE, [], (response) => this.probedService.applyTimezoneResponse(response));
	}

	/**
	 * Publishes the read button of the cleaning estimate.
	 *
	 * Deliberately **not** read at start-up, unlike the other three: the estimate only means
	 * something while the robot is cleaning, and at start-up it is in its dock nearly every time.
	 * Asking then would publish the last finished run as if it were current.
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.CleanEstimate)
	public async initCleanEstimate(): Promise<void> {
		this.probedService.registerCleanEstimateCommand((name, spec, group) => this.addCommand(name, spec, group));
	}

	/** Publishes the dock's empty mode selector and reads its current position once. */
	@BaseDeviceFeatures.DeviceFeature(Feature.DustCollectionMode)
	public async initDustCollectionMode(): Promise<void> {
		this.probedService.registerDustCollectionModeCommand((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(GET_DUST_COLLECTION_MODE, [], (response) => this.probedService.applyDustCollectionModeResponse(response));
	}

	/**
	 * Publishes the drying selector and reads its current setting once.
	 *
	 * The read is not optional comfort here: switching drying **off** still has to carry a duration,
	 * and this is what tells the service which one the robot currently holds. Without it the off
	 * position would fall back on the app's own default of 7200 s (A65:968341-968346).
	 */
	@BaseDeviceFeatures.DeviceFeature(Feature.DryerSetting)
	public async initDryerSetting(): Promise<void> {
		this.probedService.registerDryerSettingCommand((name, spec, group) => this.addCommand(name, spec, group));
		void this.readProbedValue(GET_DRYER_SETTING, [], (response) => this.probedService.applyDryerSettingResponse(response));
	}

	/**
	 * Reads one probed value and hands it to its publisher, swallowing failure.
	 *
	 * Never awaited by its callers, for the reason {@link initDoNotDisturb} states: these run from
	 * the initialisation path, and a request with an eight second timeout in front of it would stall
	 * the first poll. Failure is logged and dropped - each of these is a convenience, and the read
	 * button in `queries` remains for a second attempt.
	 *
	 * @param method Reading command to send.
	 * @param params Exactly what the app's own wrapper sends.
	 * @param apply  Publisher for the answer.
	 */
	private async readProbedValue(method: string, params: unknown, apply: (response: unknown) => Promise<unknown>): Promise<void> {
		try {
			const response = await this.deps.adapter.requestsHandler.sendRequest(this.duid, method, params, { priority: -5 });
			await apply(response);
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Warn", "1.0", undefined,
				`Failed to read ${method}: ${this.deps.adapter.errorMessage(e)}`, "warn");
		}
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

			// Written on every poll but only when it really moved; the service guards that itself.
			// This is the one place the active slot is known without asking for anything, which is
			// why the inventory takes it from here rather than calling `get_map_status` - see
			// `v1MapInventory.ts` for why that call is not used at all.
			if (this.hasFeature(Feature.MapInventory)) {
				void this.mapInventoryService.publishActiveMap(this.mapService.currentIndex)
					.catch((e: unknown) => this.deps.adapter.rLog("System", this.duid, "Debug", "1.0", undefined,
						`Could not publish the active map: ${this.deps.adapter.errorMessage(e)}`, "debug"));
			}

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
