import React from "react";
import { Button, Divider, IconButton, Stack, Tooltip } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import HomeIcon from "@mui/icons-material/Home";
import PlaceIcon from "@mui/icons-material/Place";
import CloseIcon from "@mui/icons-material/Close";
import AddIcon from "@mui/icons-material/Add";
import BackspaceIcon from "@mui/icons-material/Backspace";
import { I18n } from "@iobroker/adapter-react-v5";
import type { RobotPhase, RoomSelectionModel, ZoneModel } from "../engine/types";
import { PANEL_PADDING_PX } from "./FloatingSurface";

interface ActionDockProps {
	/** What the robot is doing; decides which of Start / Resume / Pause / Stop / Dock is shown. */
	phase: RobotPhase;
	goToActive: boolean;
	rooms: RoomSelectionModel;
	zones: ZoneModel;
	onStart: () => void;
	onPause: () => void;
	onStop: () => void;
	onDock: () => void;
	onToggleGoTo: () => void;
	onAddZone: () => void;
	/** Starts a segment run for the rooms picked in the map. */
	onCleanRooms: () => void;
	onClearRooms: () => void;
}

/**
 * What pressing Start would actually do, and therefore what it has to be called.
 *
 * The button used to say "Start" no matter what was drawn or picked on the map, while a second
 * button next to it cleaned the selected rooms. Two buttons for one intent is one too many, so the
 * run button now names its job.
 *
 * ## Zones win over rooms when both exist
 *
 * There is one RPC per run - `app_zoned_clean` and `app_segment_clean` are alternatives, not a
 * pair - so with zones drawn *and* rooms picked something has to give. It is the rooms, for two
 * reasons:
 *
 *  - The engine already resolves it that way: {@link MapEngine.start} sends `app_zoned_clean`
 *    whenever a zone exists. A label that promised room cleaning while the engine cleaned zones
 *    would be a lie, and a second, contradictory rule in the shell is worse than one rule in
 *    one place.
 *  - A zone is a rectangle the user drew a moment ago and can still see on the map; a room
 *    highlight survives longer and is the likelier leftover. Cleaning the smaller, freshly drawn
 *    thing is also the cheaper mistake to correct.
 *
 * The app never gets into this situation - drawing a zone and picking rooms are two different
 * bottom-menu modes there - which is why there is no app behaviour to copy here.
 *
 * @param rooms Room selection of the current map.
 * @param zones Zones drawn on the current map.
 * @returns Translation key of the label, and which callback the button belongs to.
 */
export function startIntent(rooms: RoomSelectionModel, zones: ZoneModel): { labelKey: string; target: "zones" | "rooms" | "all" } {
	if (zones.count > 0) {
		return { labelKey: "ui_start_zones", target: "zones" };
	}
	if (rooms.selected > 0) {
		return { labelKey: "ui_start_rooms", target: "rooms" };
	}
	return { labelKey: "ui_start", target: "all" };
}

/**
 * The primary controls, floating over the map rather than sitting in a side column.
 *
 * The run controls are one slot on purpose: the engine derives the robot's phase from the
 * state it reports (`deviceStatus.state` for V1, `deviceStatus.status` for B01/Q10), so a run
 * started from the phone app shows up here too - and only the action that actually applies is
 * offered. Showing Start and Stop side by side always left one of them meaningless.
 *
 * Which phase covers which reported state code is the table in `engine/robotStates.ts`:
 *
 *   cleaning  5 Cleaning, 11 Spot Cleaning, 16 Go To, 17 Zone Clean, 18 Room Clean,
 *             29 Mapping, 30 Egg attack, 32 Patrol, 38 Tidy-up, 39 Remote pick-up
 *             → Pause (primary) and Stop; Dock stays, sending it home is a real choice here.
 *   paused    10 Paused
 *             → Resume (primary) and Stop; Dock stays for the same reason.
 *   returning 6 Returning Dock, 15 Docking, 26 Going to wash the mop
 *             → Stop only. Start would fight the drive home, Dock is already happening.
 *   docked    8 Charging, 9 Charging Error, 22 Emptying dust container, 23 Washing the mop,
 *             25 Washing duster, 33/34 Setting up / Removing the mop, 41 Arm resetting,
 *             100 Fully Charged
 *             → Start only. There is nothing to stop and nowhere to send it.
 *   idle      1 Initiating, 2 Sleeping, 3 Idle, 4 Remote Control, 7 Manual Mode, 12 In Error,
 *             13 Shutting Down, 14 Updating, 28 In call, 36 Exhibition, 37 Dance,
 *             40 Emergency stop, 42 Program mode
 *             → Start and Dock. The robot stands somewhere in the flat.
 *   unknown   0 / 102 Unknown, 101 Offline, no value yet, or a code the table does not list
 *             → Start and Dock, deliberately: an empty control bar is worse than one button
 *               too many, and guessing must never take a working control away.
 *
 * Resume is deliberately *not* renamed after zones or rooms: it continues the run the robot is
 * already in, and that run was started with whatever was drawn back then. See {@link startIntent}
 * for the naming of Start itself.
 *
 * @param props
 */
export function ActionDock(props: ActionDockProps): React.JSX.Element {
	const { phase, rooms, zones } = props;

	const showPause = phase === "cleaning";
	const showResume = phase === "paused";
	// Start covers every phase in which no job is under way - including the unknown one.
	const showStart = !showPause && !showResume && phase !== "returning";
	const showStop = phase === "cleaning" || phase === "paused" || phase === "returning";
	const showDock = phase !== "docked" && phase !== "returning";

	const intent = startIntent(rooms, zones);
	// The engine turns Start into a zoned run by itself; only the segment run is a separate call.
	const onStartClick = intent.target === "rooms" ? props.onCleanRooms : props.onStart;

	return (
		<Stack
			direction="row"
			spacing={1}
			alignItems="center"
			flexWrap="wrap"
			useFlexGap
			sx={{ p: `${PANEL_PADDING_PX}px` }}
		>
			{showPause ? (
				<Button
					variant="contained"
					color="primary"
					startIcon={<PauseIcon />}
					onClick={props.onPause}
				>
					{I18n.t("ui_pause")}
				</Button>
			) : null}
			{showResume ? (
				<Button
					variant="contained"
					color="primary"
					startIcon={<PlayArrowIcon />}
					onClick={props.onStart}
				>
					{I18n.t("ui_resume")}
				</Button>
			) : null}
			{showStart ? (
				<Button
					variant="contained"
					color="primary"
					startIcon={<PlayArrowIcon />}
					onClick={onStartClick}
				>
					{I18n.t(intent.labelKey)}
				</Button>
			) : null}

			{showStop ? (
				<Tooltip title={I18n.t("ui_stop")}>
					<IconButton
						aria-label={I18n.t("ui_stop")}
						onClick={props.onStop}
					>
						<StopIcon />
					</IconButton>
				</Tooltip>
			) : null}
			{showDock ? (
				<Tooltip title={I18n.t("ui_dock")}>
					<IconButton
						aria-label={I18n.t("ui_dock")}
						onClick={props.onDock}
					>
						<HomeIcon />
					</IconButton>
				</Tooltip>
			) : null}
			<Tooltip title={props.goToActive ? I18n.t("ui_cancel") : I18n.t("ui_goto")}>
				<IconButton
					aria-label={props.goToActive ? I18n.t("ui_cancel") : I18n.t("ui_goto")}
					color={props.goToActive ? "primary" : "default"}
					onClick={props.onToggleGoTo}
				>
					{props.goToActive ? <CloseIcon /> : <PlaceIcon />}
				</IconButton>
			</Tooltip>

			<Divider
				orientation="vertical"
				flexItem
			/>

			{/* Zones */}
			<Tooltip
				title={zones.atLimit ? I18n.t("ui_zone_limit").replace("%s", String(zones.max)) : I18n.t("ui_add_zone")}
			>
				<span>
					<IconButton
						aria-label={I18n.t("ui_add_zone")}
						onClick={props.onAddZone}
						disabled={zones.atLimit}
					>
						<AddIcon />
					</IconButton>
				</span>
			</Tooltip>
			{/*
			 * No "remove zone" button here any more. Every zone carries its own delete handle now,
			 * and that one removes the zone it sits on - while this button always removed the one
			 * added last, which is a different action wearing the same name. Two ways to delete,
			 * one of them unable to say which zone it means, is one too many.
			 */}

			<Divider
				orientation="vertical"
				flexItem
			/>

			{/* Rooms. The run button starts them; this only drops the selection again. */}
			<Tooltip title={I18n.t("ui_clear_selection")}>
				<span>
					<IconButton
						aria-label={I18n.t("ui_clear_selection")}
						onClick={props.onClearRooms}
						disabled={rooms.selected === 0}
					>
						<BackspaceIcon />
					</IconButton>
				</span>
			</Tooltip>
		</Stack>
	);
}
