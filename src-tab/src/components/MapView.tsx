import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, MenuItem, Snackbar, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography, useTheme } from "@mui/material";
import ViewInArIcon from "@mui/icons-material/ViewInAr";
import MapIcon from "@mui/icons-material/Map";
import { I18n, type AdminConnection } from "@iobroker/adapter-react-v5";
import { MapEngine } from "../engine/MapEngine";
import type { SplitState } from "../engine/MapEngine";
import { EMPTY_DOCK_ACTIVITY } from "../engine/dockActivity";
import type {
	CleaningModeTabsModel,
	ConsumablePartModel,
	DockModel,
	EngineConnection,
	ModeModel,
	ObstaclePhotoModel,
	RobotEntry,
	MapZonesModel,
	RoomListModel,
	RoomSelectionModel,
	SelectOption,
	StatusModel,
	ZoneModel
} from "../engine/types";
import { FloatingSurface } from "./FloatingSurface";
import { StatusStrip } from "./StatusStrip";
import { ActionDock } from "./ActionDock";
import { ModeBar } from "./ModeBar";
import { ConsumablesPanel } from "./ConsumablesPanel";
import { DockPanel } from "./DockPanel";
import { MapZonesPanel } from "./MapZonesPanel";
import { RoomsPanel } from "./RoomsPanel";
import { SegmentEditDialog } from "./SegmentEditDialog";
import type { SegmentEditKind } from "./SegmentEditDialog";
import { ObstacleDialog } from "./ObstacleDialog";
import { HistoryPanel } from "./HistoryPanel";
import { HistoryDialog } from "./HistoryDialog";
import { CleaningHistorySource } from "../history/historySource";
import type { CleaningHistoryModel, CleaningRunModel } from "../history/historyTypes";
import { SettingsPanel } from "./SettingsPanel";
import { RobotSettingsSource } from "../settings/robotSettingsSource";
import type { RobotSettingsModel, SettingWrite } from "../settings/robotSettings";
import { SchedulesPanel } from "./SchedulesPanel";
import { ScheduleSource } from "../schedules/scheduleSource";
import type { SchedulesModel } from "../schedules/schedules";
import { getMapOverlayColors } from "../engine/mapOverlayColors";
import type { MapColorScheme } from "../engine/mapOverlayColors";
import { CommandFeedbackSource } from "../feedback/commandFeedbackSource";
import { formatFeedbackMessage } from "../feedback/commandFeedback";
import type { CommandFeedbackSeverity } from "../feedback/commandFeedback";
import { ActiveFloorSource } from "../map/activeFloorSource";
import { EMPTY_MAP_LIST, MapListSource } from "../map/mapListSource";
import type { MapListModel } from "../map/mapListSource";
import { MapsPanel } from "./MapsPanel";
import { Map3DSource } from "../map3d/map3dSource";
import { Map3DView } from "../map3d/Map3DView";
import { isWebGLAvailable } from "../map3d/webgl";
import type { CellPoint, Map3DModel } from "../map3d/map3dModel";
import type { ScenePalette } from "../map3d/scene";
import { RemotePad } from "./RemotePad";
import { EMPTY_REMOTE, RemoteDriver } from "../remote/remoteDriver";
import type { RemoteDriverModel } from "../remote/remoteDriver";
import { PresetsPanel } from "./PresetsPanel";
import { EMPTY_PRESETS, ScenePresetSource } from "../scenes/presetSource";
import type { ScenePresetModel } from "../scenes/presetSource";

interface MapViewProps {
	socket: AdminConnection;
	/** Adapter instance the tab talks to, e.g. `roborock.0`. */
	instanceId: string;
	/** Admin language, used to resolve per-language object names. */
	language: string;
}

const EMPTY_STATUS: StatusModel = {
	stateText: null,
	battery: null,
	cleanArea: null,
	cleanTime: null,
	errorText: null,
	connectionChannel: "",
	phase: "unknown",
	dockActivity: null
};

/**
 * No robot selected yet, so no map and therefore no editable walls or zones.
 *
 * `supported: false` is the state that keeps the panel away entirely, which is the right starting
 * point: a panel offering to add a no-go zone before any map has been read would promise something
 * that cannot be sent.
 */
const EMPTY_MAP_ZONES: MapZonesModel = {
	counts: { no_go: 0, no_mop: 0, wall: 0 },
	limit: 10,
	selectedKey: null,
	selectedKind: null,
	drafting: false,
	editing: false,
	supported: false,
	refusalText: null
};

/**
 * Wraps the admin socket in the small slice the engine needs.
 *
 * This is the whole reason the tab no longer opens a socket of its own: `GenericApp` already
 * holds an authenticated connection, so the engine simply borrows it.
 *
 * @param socket Connection handed down by `GenericApp`.
 */
function createEngineConnection(socket: AdminConnection): EngineConnection {
	return {
		sendTo: (instance, command, data) => socket.sendTo(instance, command, data),
		getObject: id => socket.getObject(id),
		getStates: async ids => {
			if (!ids.length) {
				return {};
			}
			// `getForeignStates` answers with one map for the whole list instead of N round trips.
			return (await socket.getForeignStates(ids)) as Record<string, any>;
		},
		subscribeState: (id, handler) => socket.subscribeState(id, handler as any),
		unsubscribeState: (id, handler) => socket.unsubscribeState(id, handler as any),
		getObjectViewSystem: (type, start, end) =>
			socket.getObjectViewSystem(type as any, start, end) as Promise<Record<string, any>>
	};
}

/**
 * The tab itself: the map fills the whole area and every control floats above it.
 *
 * React owns the layout and the controls; the map is drawn by {@link MapEngine} into a plain
 * DOM element, which keeps the D3 drawing logic exactly as it was.
 */
export function MapView({ socket, instanceId, language }: MapViewProps): React.JSX.Element {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const engineRef = useRef<MapEngine | null>(null);
	const theme = useTheme();

	const [robots, setRobots] = useState<RobotEntry[]>([]);
	const [selectedRobot, setSelectedRobot] = useState<string>("");
	const [floors, setFloors] = useState<SelectOption[]>([]);
	const [selectedFloor, setSelectedFloor] = useState<string>("");
	const [status, setStatus] = useState<StatusModel>(EMPTY_STATUS);
	const [modes, setModes] = useState<ModeModel[]>([]);
	// The cleaning-mode tabs above the steps; an empty list keeps the plain selectors.
	const [cleaningModes, setCleaningModes] = useState<CleaningModeTabsModel>({ tabs: [], current: null });
	// Folder of the Roborock graphics of the selected robot; null means "no icons, text only".
	const [assetBase, setAssetBase] = useState<string | null>(null);
	const [rooms, setRooms] = useState<RoomSelectionModel>({ selected: 0, available: 0 });
	const [zones, setZones] = useState<ZoneModel>({ count: 0, max: 5, atLimit: false });
	const [mapZones, setMapZones] = useState<MapZonesModel>(EMPTY_MAP_ZONES);
	const [roomList, setRoomList] = useState<RoomListModel>({ rooms: [], maxNameLength: 30, cleanOrder: [] });
	/**
	 * The segment edit waiting for a yes, or null.
	 *
	 * Dividing and combining renumber the robot own segments, so neither is sent from the panel
	 * that offers it - the dialog sits in between and this is what holds it open.
	 */
	const [segmentEdit, setSegmentEdit] = useState<SegmentEditKind | null>(null);
	/**
	 * The division in progress, mirrored out of the engine.
	 *
	 * Held here rather than read on every render because the engine changes it while the pointer is
	 * moving: the line is re-snapped on every move, and the panel has to follow so that the hint and
	 * the two areas track what the map already shows.
	 */
	const [split, setSplit] = useState<SplitState | null>(null);
	/**
	 * The room a division would apply to: the one picked on the map, and only when it is the one.
	 *
	 * The app refuses a division of anything but a single room (`map_edit_split_restriction`), and
	 * the same selection already serves combining and the cleaning order.
	 */
	const splitSelectedRoomId = roomList.rooms.filter(room => room.selected).length === 1
		? (roomList.rooms.find(room => room.selected)?.segmentId ?? null)
		: null;
	const [cleanCount, setCleanCount] = useState(1);
	const [consumables, setConsumables] = useState<ConsumablePartModel[]>([]);
	const [dock, setDock] = useState<DockModel>({ controls: [], status: [], faulty: false, activity: EMPTY_DOCK_ACTIVITY });
	const [hasMap, setHasMap] = useState(false);
	const [goToActive, setGoToActive] = useState(false);
	const [error, setError] = useState<string>("");
	/**
	 * How the message in the snackbar is meant.
	 *
	 * Two kinds arrive there now. Something the tab itself could not do is an error. A command whose
	 * fate the adapter cannot determine - the robot did not answer - is a warning, because "no
	 * answer" is not "did not happen", and colouring it red would say more than anybody knows.
	 */
	const [noticeSeverity, setNoticeSeverity] = useState<CommandFeedbackSeverity>("error");
	const [photo, setPhoto] = useState<ObstaclePhotoModel | null>(null);
	const [history, setHistory] = useState<CleaningHistoryModel | null>(null);
	const [historyRun, setHistoryRun] = useState<CleaningRunModel | null>(null);
	// The scheme the **adapter** paints its map bitmaps in, not the admin theme; see
	// `engine/mapOverlayColors.ts` for why the two are separate.
	const [mapColorScheme, setMapColorScheme] = useState<MapColorScheme>("light");

	const [robotSettings, setRobotSettings] = useState<RobotSettingsModel | null>(null);
	// The robot's schedules; null while none have been read, and an empty list keeps the panel away.
	const [schedules, setSchedules] = useState<SchedulesModel | null>(null);
	// Everything about driving the robot by hand; `supported: false` keeps the pad away entirely.
	const [remote, setRemote] = useState<RemoteDriverModel>(EMPTY_REMOTE);
	// Which floor the robot itself is on; null when it does not report one.
	const [activeFloor, setActiveFloor] = useState<number | null>(null);
	// The robot's stored maps, and whether it offers a rename. Empty keeps the panel away.
	const [mapList, setMapList] = useState<MapListModel>(EMPTY_MAP_LIST);
	// The saved programs of the account. Empty keeps the panel away - unless the instance runs
	// cloud-free, which is the one case in which the panel appears to say why it is empty.
	const [presets, setPresets] = useState<ScenePresetModel>(EMPTY_PRESETS);
	// The 3D view: whether it is on, and what it would draw. `null` means nothing drawable yet.
	const [show3D, setShow3D] = useState(false);
	const [map3d, setMap3d] = useState<Map3DModel | null>(null);
	/** Live robot position for the 3D body, kept out of the model so a live tick costs no rebuild. */
	const [map3dLive, setMap3dLive] = useState<CellPoint | null>(null);

	const connection = useMemo(() => createEngineConnection(socket), [socket]);
	const historySourceRef = useRef<CleaningHistorySource | null>(null);
	const settingsSourceRef = useRef<RobotSettingsSource | null>(null);
	const scheduleSourceRef = useRef<ScheduleSource | null>(null);
	const feedbackSourceRef = useRef<CommandFeedbackSource | null>(null);
	const remoteDriverRef = useRef<RemoteDriver | null>(null);
	const activeFloorRef = useRef<ActiveFloorSource | null>(null);
	const mapListRef = useRef<MapListSource | null>(null);
	const presetSourceRef = useRef<ScenePresetSource | null>(null);
	const map3dRef = useRef<Map3DSource | null>(null);

	/** Everything the tab itself could not do; always an error, never an open question. */
	const showError = useCallback((message: string) => {
		setNoticeSeverity("error");
		setError(message);
	}, []);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}

		const engine = new MapEngine(connection, {
			container: host,
			// The admin already loaded admin/i18n/<lang>.json, so I18n is the single source.
			t: (key, fallback, ...args) => {
				const translated = I18n.t(key);
				let text = translated === key ? fallback : translated;
				for (const arg of args) {
					text = text.replace("%s", String(arg));
				}
				return text;
			},
			onRobots: (list, selected) => {
				setRobots(list);
				setSelectedRobot(selected ?? "");
			},
			onStatus: setStatus,
			onModes: setModes,
			onCleaningModes: setCleaningModes,
			onAssetBase: setAssetBase,
			onFloors: (list, selected) => {
				setFloors(list);
				setSelectedFloor(selected ?? "");
			},
			onRooms: setRooms,
			onRoomList: setRoomList,
			// The engine re-snaps the dividing line on every pointer move, so the panel is told each
			// time rather than on a poll: the hint and the two areas have to change with the line.
			onSplitChanged: () => setSplit(engineRef.current?.getSplitState() ?? null),
			onZones: setZones,
			onMapZones: setMapZones,
			onConsumables: setConsumables,
			onDock: setDock,
			onMapPresence: setHasMap,
			onGoToMode: setGoToActive,
			onError: showError,
			onObstaclePhoto: setPhoto
		});
		engine.setLanguage(language);
		engineRef.current = engine;
		void engine.init(instanceId);

		return () => {
			engine.destroy();
			engineRef.current = null;
		};
		// `showError` is stable (useCallback with no dependencies), so listing it does not rebuild
		// the engine - it only keeps the rule honest.
	}, [connection, instanceId, language, showError]);

	/*
	 * The history reads its own branch of the object tree and is deliberately not part of the map
	 * engine: it needs no map, no D3 and no drawing, and the engine already carries enough.
	 */
	useEffect(() => {
		const source = new CleaningHistorySource(connection, {
			onHistory: setHistory,
			onMapColorScheme: setMapColorScheme
		});
		historySourceRef.current = source;

		return () => {
			source.destroy();
			historySourceRef.current = null;
		};
	}, [connection]);

	// `connection` is a dependency although it is not read here: a new connection means the effect
	// above built a new source, and that one has to be pointed at the device as well. Without it a
	// reconnect would leave the panel with a source that was never told which robot to read.
	useEffect(() => {
		// A device switch closes an open run: its map belongs to the robot that was selected.
		setHistoryRun(null);
		historySourceRef.current?.setDevice(instanceId, selectedRobot, language);
	}, [connection, instanceId, selectedRobot, language]);

	const loadHistoryMap = useCallback(
		(stateId: string) => historySourceRef.current?.loadMap(stateId) ?? Promise.resolve(null),
		[]
	);

	/*
	 * The persistent robot settings. Same shape as the history above and for the same reason: they
	 * read their own branch of the object tree and have nothing to do with drawing a map.
	 */
	useEffect(() => {
		const source = new RobotSettingsSource(connection, {
			onSettings: setRobotSettings,
			onError: showError
		});
		settingsSourceRef.current = source;

		return () => {
			source.destroy();
			settingsSourceRef.current = null;
		};
	}, [connection, showError]);

	useEffect(() => {
		settingsSourceRef.current?.setDevice(instanceId, selectedRobot, language);
	}, [connection, instanceId, selectedRobot, language]);

	/*
	 * The schedules. Same shape again, and deliberately not part of the settings: a setting is one
	 * known state the adapter publishes for every robot that has it, while a schedule is an entry
	 * whose identifier the robot chose and which can appear and disappear while the tab is open.
	 */
	useEffect(() => {
		const source = new ScheduleSource(connection, {
			onSchedules: setSchedules,
			onError: showError
		});
		scheduleSourceRef.current = source;

		return () => {
			source.destroy();
			scheduleSourceRef.current = null;
		};
	}, [connection, showError]);

	useEffect(() => {
		scheduleSourceRef.current?.setDevice(instanceId, selectedRobot);
	}, [connection, instanceId, selectedRobot]);

	/*
	 * What became of the commands this page sends.
	 *
	 * The adapter used to confirm a command the moment it had written the state - before the robot
	 * had been asked, and with every later failure going to the log only. It now marks the command
	 * state itself with a quality and a reason, and this is where the page picks that up. Successes
	 * are deliberately silent; see `feedback/commandFeedback.ts`.
	 */
	useEffect(() => {
		const source = new CommandFeedbackSource(connection, {
			onNotice: notice => {
				setNoticeSeverity(notice.severity);
				setError(formatFeedbackMessage(notice, key => I18n.t(key)));
			}
		});
		feedbackSourceRef.current = source;

		return () => {
			source.destroy();
			feedbackSourceRef.current = null;
		};
	}, [connection]);

	useEffect(() => {
		feedbackSourceRef.current?.setDevice(instanceId, selectedRobot);
	}, [connection, instanceId, selectedRobot]);

	/*
	 * Driving the robot by hand.
	 *
	 * Its own object rather than part of the engine, because it is the one control on this page that
	 * has to keep working while nothing is being drawn - and because everything that ends a press
	 * belongs in one place. See `remote/remoteDriver.ts` for the rule it keeps.
	 */
	useEffect(() => {
		const driver = new RemoteDriver(connection, {
			onChange: setRemote,
			onError: showError,
			t: (key, fallback) => {
				const translated = I18n.t(key);
				return translated === key ? fallback : translated;
			}
		});
		remoteDriverRef.current = driver;

		return () => {
			driver.destroy();
			remoteDriverRef.current = null;
		};
	}, [connection, showError]);

	useEffect(() => {
		void remoteDriverRef.current?.setDevice(instanceId, selectedRobot);
	}, [connection, instanceId, selectedRobot]);

	/*
	 * Which floor the robot is on. Its own tiny source rather than part of the engine: the engine
	 * decides what is drawn, this only remarks on what is drawn - see `map/activeFloorSource.ts`.
	 */
	useEffect(() => {
		const source = new ActiveFloorSource(connection, { onActiveFloor: setActiveFloor });
		activeFloorRef.current = source;

		return () => {
			source.destroy();
			activeFloorRef.current = null;
		};
	}, [connection]);

	useEffect(() => {
		void activeFloorRef.current?.setDevice(instanceId, selectedRobot);
	}, [connection, instanceId, selectedRobot]);

	/*
	 * The stored maps. Its own source for the same reason as the marker above, and reading a
	 * different state than the floor selector on purpose - see `map/mapListSource.ts` for why the
	 * selector's source cannot carry a rename.
	 */
	useEffect(() => {
		const source = new MapListSource(connection, { onMapList: setMapList, onError: showError });
		mapListRef.current = source;

		return () => {
			source.destroy();
			mapListRef.current = null;
		};
	}, [connection, showError]);

	useEffect(() => {
		void mapListRef.current?.setDevice(instanceId, selectedRobot);
	}, [connection, instanceId, selectedRobot]);

	/*
	 * The saved programs. Its own source again, and for one reason the others do not have: it needs
	 * to know whether the instance runs cloud-free, because that is the difference between "no
	 * programs" and "programs cannot be read from here" - see `scenes/presetSource.ts`.
	 */
	useEffect(() => {
		const source = new ScenePresetSource(connection, { onPresets: setPresets, onError: showError });
		presetSourceRef.current = source;

		return () => {
			source.destroy();
			presetSourceRef.current = null;
		};
	}, [connection, showError]);

	useEffect(() => {
		void presetSourceRef.current?.setDevice(instanceId, selectedRobot);
	}, [connection, instanceId, selectedRobot]);

	/*
	 * The floor selector's labels, corrected from the list.
	 *
	 * The selector is filled from `commands.load_multi_map.common.states`, which the adapter rewrites
	 * on its polling cycle and which this tab reads once per device. A rename made here would
	 * therefore leave the old name in the selector for as long as the tab stays open. The list is
	 * re-read the moment the rename is judged, so it is the fresher of the two - and only the labels
	 * are taken from it, never which floors exist.
	 */
	useEffect(() => {
		const names: Record<string, string> = {};
		for (const entry of mapList.maps) {
			if (entry.name !== null) names[String(entry.mapFlag)] = entry.name;
		}
		engineRef.current?.setMapNames(names);
	}, [mapList]);

	/*
	 * The 3D view reads the same two map states the engine does; see `map3d/map3dSource.ts`. It runs
	 * whether or not 3D is switched on, which costs one more subscriber and nothing else, and means
	 * the button knows in advance whether it would have anything to show.
	 */
	useEffect(() => {
		const source = new Map3DSource(connection, { onModel: setMap3d, onLiveRobot: setMap3dLive });
		map3dRef.current = source;

		return () => {
			source.destroy();
			map3dRef.current = null;
		};
	}, [connection]);

	useEffect(() => {
		void map3dRef.current?.setDevice(instanceId, selectedRobot);
	}, [connection, instanceId, selectedRobot]);

	/** Back to 2D, with the reason in the snackbar; see `Map3DView` for what can fail. */
	const on3DUnavailable = useCallback((reason: string) => {
		setShow3D(false);
		showError(`${I18n.t("ui_map3d_failed")} ${reason}`);
	}, [showError]);

	/**
	 * Colours for the 3D scene.
	 *
	 * Taken from the same MUI theme the rest of the page uses rather than from the map's own colour
	 * scheme: the floor already carries the map's colours as its texture, and everything around it -
	 * background, walls, markers - belongs to the admin's light or dark mode.
	 */
	const scenePalette = useMemo<ScenePalette>(() => ({
		// The ground around the flat, and it is **the map's** ground rather than the admin page's.
		// `theme.palette.background.default` is the colour of the surrounding admin, which in the
		// dark theme is near-black - so the 3D view came out black around the rooms while the 2D
		// view beside it showed the map's own ground. One surface, one colour: this is the same
		// `--rr-map-ground` that `.rr-root` paints behind the 2D map.
		background: theme.palette.mode === "dark" ? "#0b111b" : "#dfe9f7",
		wall: theme.palette.mode === "dark" ? "#5a6270" : "#b8bec9",
		robot: theme.palette.primary.main,
		charger: theme.palette.mode === "dark" ? "#8f96a3" : "#7c8494",
		// Warmer than the walls, so a sofa reads as a thing in the room rather than as a boundary.
		furniture: theme.palette.mode === "dark" ? "#7a6a5c" : "#c2ab93",
		furnitureUnknown: theme.palette.mode === "dark" ? "#6b6f78" : "#a9aeb8",
		// The zone colours are the 2D view's own, taken from the app's `theme.displayZones`. Two
		// tables for one pair of zones is how the two views end up disagreeing about which red means
		// "do not go here"; the alpha is applied by the material, see `scene.ts`.
		forbiddenZone: getMapOverlayColors(mapColorScheme).noGoStroke,
		noMopZone: getMapOverlayColors(mapColorScheme).noMopStroke,
		virtualWall: getMapOverlayColors(mapColorScheme).wallStroke
	}), [theme, mapColorScheme]);

	const writeSetting = useCallback((write: SettingWrite) => {
		void settingsSourceRef.current?.apply(write);
	}, []);

	const onCleanCountChange = useCallback((count: number) => {
		// The adapter command `set_clean_repeat_times` allows one or two passes, nothing else.
		const clamped = Number.isFinite(count) ? Math.min(2, Math.max(1, Math.trunc(count))) : 1;
		setCleanCount(clamped);
		engineRef.current?.setCleanCount(clamped);
	}, []);

	return (
		<Box className="rr-root">
			<Box
				className="rr-map-host"
				ref={hostRef}
				// Hidden rather than unmounted while 3D is showing: the engine holds the D3 selection,
				// the zoom transform and every subscription, and tearing it down for a view change
				// would rebuild all of it - and lose the zoom - on the way back.
				sx={show3D ? { visibility: "hidden" } : undefined}
			/>

			{show3D && map3d ? (
				<Map3DView
					model={map3d}
					palette={scenePalette}
					livePosition={map3dLive}
					onUnavailable={on3DUnavailable}
				/>
			) : null}

			{!hasMap ? (
				<Box
					sx={{
						position: "absolute",
						inset: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						color: "text.secondary",
						pointerEvents: "none",
						textAlign: "center",
						px: 4
					}}
				>
					<Typography variant="body2">
						{robots.length === 0 ? I18n.t("ui_no_devices") : I18n.t("ui_loading_map")}
					</Typography>
				</Box>
			) : null}

			{/* Top: what is being looked at, and how it is doing. */}
			<Stack
				direction="row"
				spacing={1.5}
				alignItems="flex-start"
				flexWrap="wrap"
				useFlexGap
				sx={{ position: "absolute", top: 12, left: 12, right: 12, pointerEvents: "none" }}
			>
				<FloatingSurface>
					<Stack
						direction="row"
						spacing={1}
						sx={{ px: 1.5, py: 1.25 }}
					>
						<TextField
							select
							size="small"
							label={I18n.t("ui_device")}
							value={selectedRobot}
							onChange={event => {
								setSelectedRobot(event.target.value);
								engineRef.current?.selectRobot(event.target.value);
							}}
							sx={{ minWidth: 168 }}
							disabled={robots.length === 0}
						>
							{robots.map(robot => (
								<MenuItem
									key={robot.duid}
									value={robot.duid}
								>
									{robot.name}
								</MenuItem>
							))}
						</TextField>

						{/* A single floor is not a choice, so the engine reports none and this stays away. */}
						{floors.length ? (
							<TextField
								select
								size="small"
								label={I18n.t("ui_floor")}
								value={selectedFloor}
								onChange={event => {
									setSelectedFloor(event.target.value);
									engineRef.current?.selectFloor(event.target.value);
								}}
								sx={{ minWidth: 148 }}
							>
								{floors.map(floor => {
									// The floor the robot is on is marked rather than named twice: on a
									// robot with two maps the selector shows what is *drawn*, and
									// looking at the cellar while the robot cleans the ground floor
									// used to be indistinguishable from looking at where it is.
									const isActive = activeFloor !== null && Number(floor.value) === activeFloor;
									return (
										<MenuItem
											key={floor.value}
											value={floor.value}
										>
											{isActive ? `${floor.label} ● ${I18n.t("ui_floor_active")}` : floor.label}
										</MenuItem>
									);
								})}
							</TextField>
						) : null}
					</Stack>
				</FloatingSurface>

				{/*
				 * No live-track legend any more. It existed to explain two colours the overlay
				 * invented, and the overlay no longer draws a track at all - the map's own path,
				 * painted by the adapter in the app's palette, is the only one there is. A key
				 * explaining colours nobody can see would be its own kind of wrong.
				 */}
				{/*
				 * Top right, next to the status: 2D or 3D.
				 *
				 * Only offered when there is something to show and the browser can show it. A robot
				 * without a map has no 3D view either, and on a browser without WebGL the button
				 * would lead to a black rectangle - so it is absent rather than disabled, the same
				 * rule every other control on this page follows.
				 */}
				{map3d && isWebGLAvailable() ? (
					<FloatingSurface sx={{ ml: "auto" }}>
						<ToggleButtonGroup
							size="small"
							exclusive
							value={show3D ? "3d" : "2d"}
							onChange={(_event, next) => {
								if (next === "2d" || next === "3d") setShow3D(next === "3d");
							}}
							sx={{ p: 0.5 }}
						>
							<ToggleButton value="2d" aria-label={I18n.t("ui_map2d")}>
								<Tooltip title={I18n.t("ui_map2d")}>
									<MapIcon fontSize="small" />
								</Tooltip>
							</ToggleButton>
							<ToggleButton value="3d" aria-label={I18n.t("ui_map3d")}>
								<Tooltip title={I18n.t("ui_map3d")}>
									<ViewInArIcon fontSize="small" />
								</Tooltip>
							</ToggleButton>
						</ToggleButtonGroup>
					</FloatingSurface>
				) : null}

				<FloatingSurface sx={map3d && isWebGLAvailable() ? undefined : { ml: "auto" }}>
					<StatusStrip
						status={status}
						onResetZoom={() => engineRef.current?.resetZoom()}
					/>
				</FloatingSurface>
			</Stack>

			{/* Right: the two panels, collapsed so they never stand in front of the map. */}
			<Stack
				spacing={1.5}
				sx={{ position: "absolute", top: 88, right: 12, pointerEvents: "none", alignItems: "flex-end" }}
			>
				<ConsumablesPanel
					parts={consumables}
					onReset={command => engineRef.current?.resetConsumable(command)}
				/>
				<DockPanel
					dock={dock}
					phase={status.phase}
					dockActivity={status.dockActivity}
					onCommand={(command, value) => engineRef.current?.sendDockValue(command, value)}
				/>
				{/*
				 * The maps before the rooms: a room belongs to a map, and the list also says which map
				 * the robot is on. Switching maps stays in the selector at the top - see `MapsPanel`.
				 */}
				<MapsPanel
					maps={mapList}
					activeMapFlag={activeFloor}
					language={language}
					onRename={(mapFlag, name) => void mapListRef.current?.rename(mapFlag, name)}
				/>
				<RoomsPanel
					rooms={roomList}
					canSplit={engineRef.current?.canSplitRooms() ?? false}
					splitRefusal={splitSelectedRoomId === null ? null : (engineRef.current?.splitRefusalFor(splitSelectedRoomId) ?? null)}
					onSplitStart={() => {
						if (splitSelectedRoomId === null) return;
						engineRef.current?.beginSplit(splitSelectedRoomId);
						setSplit(engineRef.current?.getSplitState() ?? null);
					}}
					split={split?.active ? split : null}
					onSplitRequest={() => setSegmentEdit("split")}
					onSplitCancel={() => {
						engineRef.current?.cancelSplit();
						setSplit(null);
					}}
					onMergeRequest={() => setSegmentEdit("merge")}
					onSetCleanOrder={() => void engineRef.current?.setCleanOrderFromSelection()}
					onClearCleanOrder={() => void engineRef.current?.clearCleanOrder()}
					onRename={(segmentId, name) => void engineRef.current?.renameRoom(segmentId, name)}
				/>
				<MapZonesPanel
					zones={mapZones}
					onAdd={kind => engineRef.current?.startMapZone(kind)}
					onSave={() => void engineRef.current?.saveMapZone()}
					onCancel={() => engineRef.current?.cancelMapZone()}
				/>
				<RemotePad
					remote={remote}
					onStart={confirmed => void remoteDriverRef.current?.start(confirmed)}
					onCancelConfirmation={() => remoteDriverRef.current?.cancelConfirmation()}
					onPress={direction => remoteDriverRef.current?.press(direction)}
					onRelease={() => remoteDriverRef.current?.release()}
					onEnd={() => void remoteDriverRef.current?.end()}
				/>
				<SettingsPanel
					settings={robotSettings}
					onWrite={writeSetting}
				/>
				{/*
				 * Beside the schedules, because the two are the same kind of thing from the user's
				 * side: something saved that runs a cleaning job. A schedule runs it at a time, a
				 * program runs it on request.
				 */}
				<PresetsPanel
					presets={presets}
					rooms={roomList}
					modes={modes}
					assetBase={assetBase}
					// The admin's own light or dark, not the map's colour scheme: this is an icon on a
					// panel, not something drawn onto the bitmap.
					themeType={theme.palette.mode === "dark" ? "dark" : "light"}
					onStart={sceneId => void presetSourceRef.current?.start(sceneId)}
				/>
				<SchedulesPanel
					schedules={schedules}
					language={language}
					onToggle={(timerId, enabled) => void scheduleSourceRef.current?.setEnabled(timerId, enabled)}
					onDelete={timerId => void scheduleSourceRef.current?.remove(timerId)}
				/>
				<HistoryPanel
					history={history}
					language={language}
					onSelectRun={setHistoryRun}
				/>
			</Stack>

			{/*
			 * Bottom left: the cleaning settings, on their own.
			 *
			 * They used to span the full width of the map, which put a wide band across the very
			 * thing they control. Anchored to the left corner and sized by their content, they leave
			 * the map's centre and right side free; `maxWidth` keeps them inside a narrow window
			 * instead of letting them run past the edge.
			 *
			 * The run controls sit centred below, separately - see there for why they do not share
			 * this column.
			 */}
			<Stack
				alignItems="flex-start"
				sx={{
					position: "absolute",
					left: 12,
					bottom: 12,
					maxWidth: "calc(100% - 24px)",
					pointerEvents: "none"
				}}
			>
				<FloatingSurface sx={{ maxWidth: "100%" }}>
					<ModeBar
						modes={modes}
						cleaningModes={cleaningModes}
						assetBase={assetBase}
						cleanCount={cleanCount}
						onChange={(command, value) => engineRef.current?.setMode(command, value)}
						onSelectCleaningMode={payload => engineRef.current?.setCleaningMode(payload)}
						onCleanCountChange={onCleanCountChange}
					/>
				</FloatingSurface>
			</Stack>

			{/*
			 * Bottom centre: the run controls, deliberately not in the column on the left.
			 *
			 * Start is the one control reached without looking, so it stays where the hand expects
			 * it - centred, as in the app. The settings beside it are chosen deliberately and may
			 * live in the corner; Start may not wander with them.
			 *
			 * Centred by translating half its own width, so the box stays centred whatever its
			 * label says: "Start Zonenreinigung" is far wider than "Start". A full-width flex row
			 * would do the same but would lay an invisible band across the map, and that band
			 * swallows clicks meant for the rooms underneath.
			 */}
			<Box
				sx={{
					position: "absolute",
					left: "50%",
					bottom: 12,
					transform: "translateX(-50%)",
					maxWidth: "calc(100% - 24px)",
					pointerEvents: "none"
				}}
			>
				<FloatingSurface sx={{ maxWidth: "100%" }}>
					<ActionDock
						phase={status.phase}
						goToActive={goToActive}
						rooms={rooms}
						zones={zones}
						onStart={() => engineRef.current?.start()}
						onResume={() => engineRef.current?.resume()}
						onPause={() => engineRef.current?.pause()}
						onStop={() => engineRef.current?.stop()}
						onDock={() => engineRef.current?.dock()}
						onToggleGoTo={() => engineRef.current?.toggleGoTo()}
						onAddZone={() => engineRef.current?.addZone()}
						onCleanRooms={() => engineRef.current?.cleanSelectedRooms()}
						onClearRooms={() => engineRef.current?.clearRooms()}
					/>
				</FloatingSurface>
			</Box>

			<SegmentEditDialog
				pending={segmentEdit}
				roomNames={roomList.rooms.filter(room => room.selected).map(room => room.name)}
				cleanOrderNames={roomList.cleanOrder}
				onConfirm={() => {
					setSegmentEdit(null);
					if (segmentEdit === "merge") void engineRef.current?.mergeSelectedRooms();
					if (segmentEdit === "split") {
						void engineRef.current?.splitCurrentRoom();
						// The engine stays in dividing mode on purpose (see `splitCurrentRoom`), but
						// this division is over: the line and the selection both pointed at a segment
						// id the robot is renumbering.
						setSplit(null);
					}
				}}
				onCancel={() => setSegmentEdit(null)}
			/>

			<ObstacleDialog
				photo={photo}
				onClose={() => setPhoto(null)}
			/>

			<HistoryDialog
				run={historyRun}
				language={language}
				mapColorScheme={mapColorScheme}
				loadMap={loadHistoryMap}
				onClose={() => setHistoryRun(null)}
			/>

			<Snackbar
				open={!!error}
				autoHideDuration={10000}
				onClose={() => setError("")}
				anchorOrigin={{ vertical: "top", horizontal: "center" }}
			>
				<Alert
					severity={noticeSeverity}
					onClose={() => setError("")}
					variant="filled"
				>
					{error}
				</Alert>
			</Snackbar>
		</Box>
	);
}
