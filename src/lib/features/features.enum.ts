// src/lib/features/features.enum.ts

export enum Feature {
	// --- Actions primarily adding Commands ---
	FanMaxPlus = "FanMaxPlus", // Adds 'Max+' fan speed
	SmartModeCommand = "SmartModeCommand", // Adds 'app_set_clean_sequence_type' command
	MopWash = "MopWash", // Adds mop washing commands (start/stop/mode/params)
	AutoEmptyDock = "AutoEmptyDock", // Adds dust collection commands (start/stop/status/mode)
	MopDry = "MopDry", // Adds mop drying commands (status/setting)
	WaterBox = "WaterBox", // Adds basic water box & mop mode commands (set_mop_mode, set_water_box_custom_mode)
	CleanRouteFastMode = "CleanRouteFastMode", // Adds 'Fast' to mop modes
	SmartPlan = "SmartPlan", // Adds 'SmartPlan' (306) to mop modes
	CustomWaterBoxDistance = "CustomWaterBoxDistance", // Creates the special distance command state
	// Both are detected from the ordinary status: a robot that reports `dnd_enabled` has a Do Not
	// Disturb window, one that reports `lock_status` has a child lock. See V1RobotSettingsService.
	DoNotDisturb = "DoNotDisturb", // Adds the Do Not Disturb window and its off button
	ChildLock = "ChildLock", // Adds the child lock switch
	// Not detected from the status but by asking the robot: `get_collision_avoid_status` either
	// answers or comes back `unknown_method`. See lib/features/capabilityProbe.ts.
	CollisionAvoid = "CollisionAvoid", // Adds the obstacle avoidance switch
	// The same probe, for the four functions of v1ProbedCapabilities.ts. Each is unlocked by its own
	// getter, never by a model class - the measurement showed the test device answers all four while
	// the adapter offered them to a different model class only.
	DustCollectionMode = "DustCollectionMode", // Adds the dock's empty mode selector
	DryerSetting = "DryerSetting", // Adds the drying selector
	RobotTimezone = "RobotTimezone", // Adds the robot time zone state and its read button
	CleanEstimate = "CleanEstimate", // Adds the estimate of the running clean
	// One feature for the five on/off settings of v1ProbedCapabilities.ts that share a shape: a
	// `get_*`/`set_*` pair around a `status` field. Each is unlocked by its own getter; the feature
	// is applied when at least one of them survived, and registers exactly those.
	StatusToggles = "StatusToggles", // Adds the probed on/off settings
	// The other kind of on/off setting: no getter at all, the robot carries it in the status packet.
	// Unlocked by the field turning up there rather than by a probe, so this one is applied from
	// `processStatus` and not from `detectProbedCapabilities`. See STATUS_FIELD_TOGGLES.
	StatusFieldToggles = "StatusFieldToggles", // Adds the on/off settings the status packet carries
	SoundVolume = "SoundVolume", // Adds the speaking volume and the sound test
	DeviceIdentity = "DeviceIdentity", // Adds the serial number and the locale block, read-only
	MapInventory = "MapInventory", // Adds which map is loaded and what backups exist, read-only
	OffPeakCharging = "OffPeakCharging", // Adds the window in which the robot may fully charge
	// Not a probe: the four `app_rc_*` calls are all actions, and a capability probe may only send a
	// `get_*` (capabilityProbe.ts). The robot reports this one itself, as firmware feature 125 - the
	// same number the app reads in `isRemoteSupported()`. See lib/features/vacuum/remoteControl.ts.
	RemoteControl = "RemoteControl", // Adds the four remote control commands

	// --- Actions primarily creating States (non-command) ---
	LiveVideo = "LiveVideo", // Creates camera stream URL states
	MultiFloor = "MultiFloor", // Creates multi-floor management states (max_map, etc.)
    Consumables = "Consumables", // Creates consumables states
    ResetConsumables = "ResetConsumables", // Creates reset consumables buttons
    DockingStationStatus = "DockingStationStatus", // Creates docking station status states
    CleaningRecords = "CleaningRecords", // Creates cleaning records states
    WaterShortage = "WaterShortage", // Handle water shortage notification

    NetworkInfo = "NetworkInfo",
    UpdateStatus = "UpdateStatus",
    Timers = "Timers",
    FirmwareInfo = "FirmwareInfo",
    MultiMap = "MultiMap",
    RoomMapping = "RoomMapping",
    Map = "Map",
    CleanSummary = "CleanSummary",

	// --- Static Flags (Defined by Model Class Config) ---
	Camera = "Camera", // Model has a camera (static)
	MopForbidden = "MopForbidden", // Model supports mop forbidden zones (static)
	AvoidCarpet = "AvoidCarpet", // Model supports avoid carpet mode (static)
	VoiceControl = "VoiceControl", // Model supports voice control (static)
	ShakeMopStrength = "ShakeMopStrength", // Alias for WaterBox logic (static)
	ElectronicWaterBox = "ElectronicWaterBox", // Alias for WaterBox logic (static)
    GetPhoto = "GetPhoto", // Feature to enable the get_photo command

	// --- Dynamic Bitfield/Firmware Features (Keys used in _getDynamicFeatures) ---
	// These might map to Action Features above or just be flags themselves
	isWashThenChargeCmdSupported = "isWashThenChargeCmdSupported", // Will map to MopWash action
	isDustCollectionSettingSupported = "isDustCollectionSettingSupported", // Will map to AutoEmptyDock action
	isSupportedDrying = "isSupportedDrying", // Will map to MopDry action
	isShakeMopSetSupported = "isShakeMopSetSupported", // Placeholder/Flag
	isVideoMonitorSupported = "isVideoMonitorSupported", // Placeholder/Flag
	isVideoSettingSupported = "isVideoSettingSupported", // Placeholder/Flag
	isCarpetSupported = "isCarpetSupported", // Placeholder/Flag
	isPhotoUploadSupported = "isPhotoUploadSupported", // Placeholder/Flag
	isAvoidCollisionSupported = "isAvoidCollisionSupported", // Placeholder/Flag
	isCornerCleanModeSupported = "isCornerCleanModeSupported", // Placeholder/Flag
	isSupportSetSwitchMapMode = "isSupportSetSwitchMapMode", // Placeholder/Flag
	isCustomWaterBoxDistanceSupported = "isCustomWaterBoxDistanceSupported", // Will map to CustomWaterBoxDistance action
	isBackChargeAutoWashSupported = "isBackChargeAutoWashSupported", // Placeholder/Flag
	isCleanRouteFastModeSupported = "isCleanRouteFastModeSupported", // Will map to CleanRouteFastMode action
	isVideoLiveCallSupported = "isVideoLiveCallSupported", // Will map to LiveVideo action

	isSupportFDSEndPoint = "isSupportFDSEndPoint", // Placeholder/Flag
	isSupportAutoSplitSegments = "isSupportAutoSplitSegments", // Placeholder/Flag
	isSupportOrderSegmentClean = "isSupportOrderSegmentClean", // Placeholder/Flag
	isMapSegmentSupported = "isMapSegmentSupported", // Placeholder/Flag
	isSupportLedStatusSwitch = "isSupportLedStatusSwitch", // Placeholder/Flag
	isMultiFloorSupported = "isMultiFloorSupported", // Will map to MultiFloor action
	isSupportFetchTimerSummary = "isSupportFetchTimerSummary", // Placeholder/Flag
	isOrderCleanSupported = "isOrderCleanSupported", // Placeholder/Flag
	isRemoteSupported = "isRemoteSupported", // Placeholder/Flag
	isSupportTaskId = "isSupportTaskId", // Placeholder/Flag

	CommonStatus = "isSupportCommonStatus",
    DockStatus = "isSupportDockStatus",
    RobotStatus = "isSupportRobotStatus",
    CleanTime = "isSupportCleanTime",
    CleanArea = "isSupportCleanArea",
    MapFlag = "isSupportMapFlag",
    BackType = "isSupportBackType",
    SwitchStatus = "isSupportSwitchStatus",
    MonitorStatus = "isSupportMonitorStatus",
    CleanPercent = "isSupportCleanPercent",
    InWarmup = "isSupportInWarmup",
    ExitDock = "isSupportExitDock",
    ExtraTime = "isSupportExtraTime",
    LastCleanTime = "isSupportLastCleanTime",
    ChargeStatus = "isSupportChargeStatus",
    TaskId = "isSupportTaskId",
    CleaningInfo = "isSupportCleaningInfo",
	CleanRepeat = "isSupportCleanRepeat",
    Dss = "isSupportDss",
    Rss = "isSupportRss",
    Kct = "isSupportKct",
    CleanFluid = "isSupportCleanFluid",
    Rdt = "isSupportRdt",
    ReplenishMode = "isSupportReplenishMode",
    CleanedArea = "isSupportCleanedArea",
    CleanTimes = "isSupportCleanTimes"

	// --- Action Placeholders (if an action doesn't map 1:1 to a bitfield/fw feature) ---
	// Add more if needed, otherwise rely on mapping the is... keys above
}
