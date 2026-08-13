import React from "react";
import { Button, Divider, IconButton, MenuItem, Stack, TextField, Tooltip, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import HomeIcon from "@mui/icons-material/Home";
import PlaceIcon from "@mui/icons-material/Place";
import CloseIcon from "@mui/icons-material/Close";
import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import CenterFocusStrongIcon from "@mui/icons-material/CenterFocusStrong";
import CleaningServicesIcon from "@mui/icons-material/CleaningServices";
import BackspaceIcon from "@mui/icons-material/Backspace";
import { I18n } from "@iobroker/adapter-react-v5";
import type { RobotPhase, RoomSelectionModel, ZoneModel } from "../engine/types";

interface ActionDockProps {
	/** What the robot is doing; decides which of Start / Resume / Pause / Stop / Dock is shown. */
	phase: RobotPhase;
	goToActive: boolean;
	rooms: RoomSelectionModel;
	zones: ZoneModel;
	cleanCount: number;
	onStart: () => void;
	onPause: () => void;
	onStop: () => void;
	onDock: () => void;
	onToggleGoTo: () => void;
	onAddZone: () => void;
	onRemoveZone: () => void;
	onCleanCountChange: (count: number) => void;
	onCleanRooms: () => void;
	onClearRooms: () => void;
	onResetZoom: () => void;
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

	return (
		<Stack
			direction="row"
			spacing={1}
			alignItems="center"
			flexWrap="wrap"
			useFlexGap
			sx={{ px: 1.5, py: 1.25 }}
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
					onClick={props.onStart}
				>
					{I18n.t("ui_start")}
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
			<Tooltip title={I18n.t("ui_reset_view")}>
				<IconButton
					aria-label={I18n.t("ui_reset_view")}
					onClick={props.onResetZoom}
				>
					<CenterFocusStrongIcon />
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
			<Tooltip title={I18n.t("ui_remove_zone")}>
				<span>
					<IconButton
						aria-label={I18n.t("ui_remove_zone")}
						onClick={props.onRemoveZone}
						disabled={zones.count === 0}
					>
						<RemoveIcon />
					</IconButton>
				</span>
			</Tooltip>
			{/* Two passes at most: the adapter command `set_clean_repeat_times` allows no more. */}
			<TextField
				select
				size="small"
				label={I18n.t("ui_repeat")}
				value={String(props.cleanCount)}
				onChange={event => props.onCleanCountChange(Number(event.target.value))}
				// The longest translation is the German "2 Durchgänge". A fixed width truncated it,
				// and the surrounding flex row shrank the field further, so give it a floor and
				// keep it out of the shrinking.
				sx={{ minWidth: 168, flexShrink: 0 }}
			>
				<MenuItem value="1">{I18n.t("ui_repeat_once")}</MenuItem>
				<MenuItem value="2">{I18n.t("ui_repeat_twice")}</MenuItem>
			</TextField>

			<Divider
				orientation="vertical"
				flexItem
			/>

			{/* Rooms */}
			<Button
				variant="outlined"
				color="secondary"
				startIcon={<CleaningServicesIcon />}
				disabled={rooms.selected === 0}
				onClick={props.onCleanRooms}
			>
				{I18n.t("ui_clean_rooms")}
				{rooms.selected > 0 ? <span className="rr-numeric">&nbsp;({rooms.selected})</span> : null}
			</Button>
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

			<Typography
				variant="caption"
				color="text.secondary"
				sx={{ maxWidth: 260 }}
			>
				{rooms.selected > 0
					? I18n.t("ui_selected_rooms").replace("%s", String(rooms.selected))
					: rooms.available === 0
						? I18n.t("ui_no_rooms")
						: I18n.t("ui_rooms_hint")}
			</Typography>
		</Stack>
	);
}
