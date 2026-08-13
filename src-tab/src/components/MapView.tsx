import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, MenuItem, Snackbar, Stack, TextField, Typography } from "@mui/material";
import { I18n, type AdminConnection } from "@iobroker/adapter-react-v5";
import { MapEngine } from "../engine/MapEngine";
import type {
	ConsumablePartModel,
	DockModel,
	EngineConnection,
	ModeModel,
	ObstaclePhotoModel,
	RobotEntry,
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
import { ObstacleDialog } from "./ObstacleDialog";

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
	running: false
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

	const [robots, setRobots] = useState<RobotEntry[]>([]);
	const [selectedRobot, setSelectedRobot] = useState<string>("");
	const [floors, setFloors] = useState<SelectOption[]>([]);
	const [selectedFloor, setSelectedFloor] = useState<string>("");
	const [status, setStatus] = useState<StatusModel>(EMPTY_STATUS);
	const [modes, setModes] = useState<ModeModel[]>([]);
	const [rooms, setRooms] = useState<RoomSelectionModel>({ selected: 0, available: 0 });
	const [zones, setZones] = useState<ZoneModel>({ count: 0, max: 5, atLimit: false });
	const [cleanCount, setCleanCount] = useState(1);
	const [consumables, setConsumables] = useState<ConsumablePartModel[]>([]);
	const [dock, setDock] = useState<DockModel>({ controls: [], status: [], faulty: false });
	const [hasMap, setHasMap] = useState(false);
	const [goToActive, setGoToActive] = useState(false);
	const [error, setError] = useState<string>("");
	const [photo, setPhoto] = useState<ObstaclePhotoModel | null>(null);

	const connection = useMemo(() => createEngineConnection(socket), [socket]);

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
			onFloors: (list, selected) => {
				setFloors(list);
				setSelectedFloor(selected ?? "");
			},
			onRooms: setRooms,
			onZones: setZones,
			onConsumables: setConsumables,
			onDock: setDock,
			onMapPresence: setHasMap,
			onGoToMode: setGoToActive,
			onError: setError,
			onObstaclePhoto: setPhoto
		});
		engine.setLanguage(language);
		engineRef.current = engine;
		void engine.init(instanceId);

		return () => {
			engine.destroy();
			engineRef.current = null;
		};
	}, [connection, instanceId, language]);

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
			/>

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
								{floors.map(floor => (
									<MenuItem
										key={floor.value}
										value={floor.value}
									>
										{floor.label}
									</MenuItem>
								))}
							</TextField>
						) : null}
					</Stack>
				</FloatingSurface>

				<FloatingSurface sx={{ ml: "auto" }}>
					<StatusStrip status={status} />
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
					onCommand={(command, value) => engineRef.current?.sendDockValue(command, value)}
				/>
			</Stack>

			{/* Bottom: the controls, floating over the map instead of in a side column. */}
			<Stack
				spacing={1.5}
				alignItems="center"
				sx={{ position: "absolute", left: 12, right: 12, bottom: 12, pointerEvents: "none" }}
			>
				{modes.length ? (
					<FloatingSurface>
						<ModeBar
							modes={modes}
							onChange={(command, value) => engineRef.current?.setMode(command, value)}
						/>
					</FloatingSurface>
				) : null}

				<FloatingSurface sx={{ maxWidth: "100%" }}>
					<ActionDock
						running={status.running}
						goToActive={goToActive}
						rooms={rooms}
						zones={zones}
						cleanCount={cleanCount}
						onStart={() => engineRef.current?.start()}
						onPause={() => engineRef.current?.pause()}
						onStop={() => engineRef.current?.stop()}
						onDock={() => engineRef.current?.dock()}
						onToggleGoTo={() => engineRef.current?.toggleGoTo()}
						onAddZone={() => engineRef.current?.addZone()}
						onRemoveZone={() => engineRef.current?.removeZone()}
						onCleanCountChange={onCleanCountChange}
						onCleanRooms={() => engineRef.current?.cleanSelectedRooms()}
						onClearRooms={() => engineRef.current?.clearRooms()}
						onResetZoom={() => engineRef.current?.resetZoom()}
					/>
				</FloatingSurface>
			</Stack>

			<ObstacleDialog
				photo={photo}
				onClose={() => setPhoto(null)}
			/>

			<Snackbar
				open={!!error}
				autoHideDuration={10000}
				onClose={() => setError("")}
				anchorOrigin={{ vertical: "top", horizontal: "center" }}
			>
				<Alert
					severity="error"
					onClose={() => setError("")}
					variant="filled"
				>
					{error}
				</Alert>
			</Snackbar>
		</Box>
	);
}
