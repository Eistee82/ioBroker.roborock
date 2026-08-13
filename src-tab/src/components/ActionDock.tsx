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
import type { RoomSelectionModel, ZoneModel } from "../engine/types";

interface ActionDockProps {
	running: boolean;
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
 * Start and Pause are one slot on purpose: the engine derives which of the two applies from
 * the state the robot reports, so a run started from the phone app shows up here too.
 *
 * @param props
 */
export function ActionDock(props: ActionDockProps): React.JSX.Element {
	const { rooms, zones } = props;

	return (
		<Stack
			direction="row"
			spacing={1}
			alignItems="center"
			flexWrap="wrap"
			useFlexGap
			sx={{ px: 1.5, py: 1.25 }}
		>
			{props.running ? (
				<Button
					variant="contained"
					color="primary"
					startIcon={<PauseIcon />}
					onClick={props.onPause}
				>
					{I18n.t("ui_pause")}
				</Button>
			) : (
				<Button
					variant="contained"
					color="primary"
					startIcon={<PlayArrowIcon />}
					onClick={props.onStart}
				>
					{I18n.t("ui_start")}
				</Button>
			)}

			<Tooltip title={I18n.t("ui_stop")}>
				<IconButton onClick={props.onStop}>
					<StopIcon />
				</IconButton>
			</Tooltip>
			<Tooltip title={I18n.t("ui_dock")}>
				<IconButton onClick={props.onDock}>
					<HomeIcon />
				</IconButton>
			</Tooltip>
			<Tooltip title={props.goToActive ? I18n.t("ui_cancel") : I18n.t("ui_goto")}>
				<IconButton
					color={props.goToActive ? "primary" : "default"}
					onClick={props.onToggleGoTo}
				>
					{props.goToActive ? <CloseIcon /> : <PlaceIcon />}
				</IconButton>
			</Tooltip>
			<Tooltip title={I18n.t("ui_reset_view")}>
				<IconButton onClick={props.onResetZoom}>
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
				sx={{ width: 128 }}
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
