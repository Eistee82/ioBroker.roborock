import type { FeatureDependencies } from "../../baseDeviceFeatures";
import { DeviceStateWriter } from "../../deviceStateWriter";
import { VACUUM_CONSTANTS } from "../vacuumConstants";

export class StationService {
	private readonly stateWriter: DeviceStateWriter;

	constructor(
		private deps: FeatureDependencies,
		duid: string
	) {
		this.stateWriter = new DeviceStateWriter(deps, duid);
	}

	public async initDockingStationStatus(): Promise<void> {
		await this.stateWriter.ensureFolder("dockingStationStatus");

		// Define status definitions with their respective translation keys for "Error/Maintenance" state (value 1)
		const statusDefinitions: Record<string, string> = {
			"cleanFluidStatus": "dock_info_clean_fluid_exception",
			"waterBoxFilterStatus": "dock_info_item_gone_exception",
			"dustBagStatus": "dock_info_dust_bag_exception",
			"dirtyWaterBoxStatus": "dock_info_dirty_water_box_exception1",
			"clearWaterBoxStatus": "dock_info_clear_water_box_exception1",
			"isUpdownWaterReady": "inner_error_name_152"
		};

		// Common states for 0 (Not Supported), 2 (OK), 3 (Unknown)
		const txtNotSupported = this.deps.adapter.translationManager.get("localization_strings_Setting_General_index_0", "Not supported");
		const txtOK = this.deps.adapter.translationManager.get("localization_strings_Main_Error_ErrorDetailPage_3", "OK");
		const txtUnknown = this.deps.adapter.translationManager.get("localization_strings_Setting_General_index_0", "Unknown");

		for (const [name, errorKey] of Object.entries(statusDefinitions)) {
			// If errorKey itself is not in translation, we use a generic native Roborock key as fallback.
			const commonFallbackKey = errorKey.includes("error_") ? "localization_strings_Main_Error_ErrorDetailPage_3" : "dust_collection_life12";
			const txtMaintenance = this.deps.adapter.translationManager.get(errorKey, this.deps.adapter.translationManager.get(commonFallbackKey));

			const states = {
				"0": txtNotSupported,
				"1": txtMaintenance,
				"2": txtOK,
				"3": txtUnknown
			};

			// Fetch localized name for the state itself
			const nameKey = VACUUM_CONSTANTS.dockingStationTranslationKeys[name as keyof typeof VACUUM_CONSTANTS.dockingStationTranslationKeys];
			const localizedName = nameKey ? this.deps.adapter.translationManager.get(nameKey, name) : name;

			await this.stateWriter.ensureState(`dockingStationStatus.${name}`, {
				name: localizedName,
				type: "number",
				role: "value",
				read: true,
				write: false,
				states: states
			});
		}
	}

	public async updateDockingStationStatus(dss: number): Promise<void> {
		const status = {
			cleanFluidStatus: ((dss >> 10) & 0b11),
			waterBoxFilterStatus: ((dss >> 8) & 0b11),
			dustBagStatus: ((dss >> 6) & 0b11),
			dirtyWaterBoxStatus: ((dss >> 4) & 0b11),
			clearWaterBoxStatus: ((dss >> 2) & 0b11),
			isUpdownWaterReady: (dss & 0b11),
		};

		for (const [name, val] of Object.entries(status)) {
			await this.stateWriter.setState(`dockingStationStatus.${name}`, val);
		}
	}

	/**
	 * Publishes what the station is doing with the mop: washing, drying, and whether a wash could
	 * start right away.
	 *
	 * The robot reports four raw fields in every status packet - `wash_status`, `wash_phase`,
	 * `wash_ready` and `dry_status` - and they stay in `deviceStatus` untouched. What this method
	 * adds is the reading the Roborock app itself applies to them. Every rule below is taken from
	 * the decompiled app, not from a guess; the line numbers refer to
	 * `_appanalysis/plugins/<plugin>/index.android.bundle.decompiled.js`:
	 *
	 * | Derived                | Rule                          | Proof |
	 * | ---------------------- | ----------------------------- | ----- |
	 * | `washingTaskStatus`    | `wash_status & 0xFF`          | a65 control plugin Z. 223610-223616 |
	 * | `washingMode`          | `wash_status >> 8`            | a65 control plugin Z. 223617-223620 |
	 * | `isWashing`            | `washingTaskStatus !== 0`     | a65 control plugin Z. 682044-682051 |
	 * | `isWashReady`          | `wash_ready === 1`            | a65 control plugin Z. 223792-223795 |
	 * | `isDrying`             | `dry_status === 1`            | a65 control plugin Z. 222777-222779 |
	 * | `dryRemainTime`        | `rdt / 60`, rounded           | a65 control plugin Z. 223789-223792 and 224252-224256 |
	 *
	 * `isWashReady` is not a synonym for "the mop is dirty": pressing Wash in the app leads
	 * straight into `WASHING_DUSTER` when the flag is set and into `BACK_TO_DOCK_WASHING_DUSTER`
	 * when it is not (Z. 423374-423380). It means the station can wash right now, without the
	 * robot driving back first.
	 *
	 * The shift is written exactly as the app writes it: `>> 8`, without masking the result.
	 *
	 * The four wash modes are the only ones any plugin gives a text to. 6, 7 and 9 come from the
	 * a65's own control plugin (Z. 682057-682101), 12 additionally from the model-independent tile
	 * plugin `robot.vacuum.cleaner` (Z. 192514-192530), which serves the a65 as well. Every other
	 * mode value keeps the plain number: the app leaves the state text unchanged for those, and
	 * inventing a label would be worse than showing the raw value.
	 *
	 * The low byte's own value range is enumerated nowhere - not in the control plugin and not in
	 * the tile plugin. It is therefore published as a number without a value list; only "not zero"
	 * has a proven meaning.
	 *
	 * `isDrying` is published without the app's extra `state === 8` guard. That guard belongs to
	 * the app's home screen, not to the field: pressing the dryer button optimistically writes
	 * `dry_status` back as 1 or 0 (Z. 422922-422925), which pins the value's meaning on its own.
	 *
	 * `rdt` is in seconds - the app divides it by 60 for the "finishes in ${minute}" text and by
	 * 3600 for the hour variant (Z. 224252-224275). It is republished here in minutes, the unit
	 * the app shows, while `deviceStatus.rdt` keeps the raw seconds.
	 *
	 * `wash_phase` gets no derived state here. The a65 control plugin never reads that field
	 * (0 hits in 1,018,258 lines); the tile plugin knows exactly two values, 11 RUNNING and
	 * 17 PUMPING, and those already sit in the value list of `deviceStatus.wash_phase`.
	 *
	 * @param status Raw `get_status` result. Fields the device does not report are skipped.
	 */
	public async updateWashAndDryStatus(status: Record<string, unknown>): Promise<void> {
		const washStatus = this.readNumber(status.wash_status);
		const washReady = this.readNumber(status.wash_ready);
		const dryStatus = this.readNumber(status.dry_status);
		const dryRemainSeconds = this.readNumber(status.rdt);

		if (washStatus === null && washReady === null && dryStatus === null && dryRemainSeconds === null) {
			return;
		}

		await this.stateWriter.ensureFolder("dockingStationStatus");

		// No `name` is passed anywhere below on purpose: `ensureState` then resolves the state id
		// through `admin/i18n/<lang>.json`, which carries all eleven adapter languages. The value
		// lists are a different matter - those texts are Roborock's own and come from their string
		// table, which knows more languages than the adapter does.
		if (washStatus !== null) {
			const washingTaskStatus = washStatus & 0xff;

			await this.stateWriter.ensureAndSetValueState(`dockingStationStatus.washingTaskStatus`, {
				type: "number"
			}, washingTaskStatus);

			// Published raw. The app reads the mode only while the task status is non-zero, so a
			// consumer has to gate on `isWashing` rather than trust a mode on an idle station.
			await this.stateWriter.ensureAndSetValueState(`dockingStationStatus.washingMode`, {
				type: "number",
				states: this.getWashingModeStates()
			}, washStatus >> 8);

			await this.stateWriter.ensureAndSetValueState(`dockingStationStatus.isWashing`, {
				type: "boolean"
			}, washingTaskStatus !== 0);
		}

		if (washReady !== null) {
			await this.stateWriter.ensureAndSetValueState(`dockingStationStatus.isWashReady`, {
				type: "boolean"
			}, washReady === 1);
		}

		if (dryStatus !== null) {
			await this.stateWriter.ensureAndSetValueState(`dockingStationStatus.isDrying`, {
				type: "boolean"
			}, dryStatus === 1);
		}

		if (dryRemainSeconds !== null) {
			await this.stateWriter.ensureAndSetValueState(`dockingStationStatus.dryRemainTime`, {
				type: "number",
				unit: "min"
			}, Math.round(dryRemainSeconds / 60));
		}
	}

	/**
	 * Value list of `washingMode`. Only the four modes the app gives a text to are listed; the
	 * texts are Roborock's own, so they follow the admin language wherever Roborock translated
	 * them and fall back to the English wording of the string table otherwise.
	 */
	private getWashingModeStates(): Record<number, string> {
		const t = this.deps.adapter.translationManager;
		return {
			6: t.get("washing_mode_updown_water_selfcleaning", "Self-cleaning"),
			7: t.get("washing_mode_updown_water_drain", "Fill & drain element draining"),
			9: t.get("left_water_is_draining", "The robot is draining"),
			12: t.get("washing_mode_sewage_box_draining", "Sewage box draining")
		};
	}

	/** Reads a numeric status field, treating an absent or unparsable one as "not reported". */
	private readNumber(value: unknown): number | null {
		if (typeof value === "number") {
			return Number.isFinite(value) ? value : null;
		}
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}
}
