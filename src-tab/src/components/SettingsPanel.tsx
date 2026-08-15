import React, { useEffect, useState } from "react";
import { Box, Collapse, IconButton, Stack, Switch, TextField, Tooltip, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TuneIcon from "@mui/icons-material/Tune";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import { composeWindow, isValidTimeOfDay, planSwitchWrite, planTimeWindowWrite } from "../settings/robotSettings";
import type { RobotSettingsModel, SettingWrite, SwitchSetting, TimeWindowSetting } from "../settings/robotSettings";

interface SettingsPanelProps {
	/** The model, or null while no device is selected or nothing has been read yet. */
	settings: RobotSettingsModel | null;
	onWrite: (write: SettingWrite) => void;
}

/** One two-position setting: a label and a switch. */
function SwitchRow({ setting, onWrite }: { setting: SwitchSetting; onWrite: (write: SettingWrite) => void }): React.JSX.Element {
	return (
		<Stack
			direction="row"
			alignItems="center"
			spacing={1}
		>
			<Tooltip title={setting.description}>
				<Typography
					variant="body2"
					sx={{ flex: 1, overflowWrap: "anywhere" }}
				>
					{setting.label}
				</Typography>
			</Tooltip>
			<Switch
				size="small"
				checked={setting.value === true}
				inputProps={{ "aria-label": setting.label }}
				onChange={event => onWrite(planSwitchWrite(setting, event.target.checked))}
			/>
		</Stack>
	);
}

/**
 * A window of the day plus its on/off.
 *
 * The two time fields keep their own draft while the user types, because every keystroke in a
 * `time` input produces a value and half of them are incomplete. Nothing is sent until the field is
 * left or the switch is used - and, per `planTimeWindowWrite`, editing a time while the window is
 * off sends nothing at all: in this protocol writing a window switches the mode on, and nobody
 * edits a time in order to activate a mode.
 */
function TimeWindowRow({ setting, onWrite }: { setting: TimeWindowSetting; onWrite: (write: SettingWrite) => void }): React.JSX.Element {
	const [start, setStart] = useState(setting.start ?? "");
	const [end, setEnd] = useState(setting.end ?? "");

	// The robot is the authority: whenever it reports a window, the drafts follow it.
	useEffect(() => {
		setStart(setting.start ?? "");
	}, [setting.start]);
	useEffect(() => {
		setEnd(setting.end ?? "");
	}, [setting.end]);

	const enabled = setting.enabled === true;
	const complete = isValidTimeOfDay(start) && isValidTimeOfDay(end);

	const commit = (nextStart: string, nextEnd: string, nextEnabled: boolean): void => {
		const write = planTimeWindowWrite(setting, { start: nextStart, end: nextEnd, enabled: nextEnabled });
		if (write) onWrite(write);
	};

	return (
		<Box>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
			>
				<Tooltip title={setting.description}>
					<Typography
						variant="body2"
						sx={{ flex: 1, overflowWrap: "anywhere" }}
					>
						{setting.label}
					</Typography>
				</Tooltip>
				<Switch
					size="small"
					checked={enabled}
					// Switching on means sending the window, so there has to be one.
					disabled={!enabled && !complete}
					inputProps={{ "aria-label": setting.label }}
					onChange={event => commit(start, end, event.target.checked)}
				/>
			</Stack>

			<Stack
				direction="row"
				spacing={1}
				sx={{ mt: 1 }}
			>
				<TextField
					type="time"
					size="small"
					label={I18n.t("ui_settings_from")}
					value={start}
					error={start !== "" && !isValidTimeOfDay(start)}
					onChange={event => setStart(event.target.value)}
					onBlur={() => {
						if (enabled && composeWindow(start, end)) commit(start, end, true);
					}}
					sx={{ flex: 1 }}
					InputLabelProps={{ shrink: true }}
				/>
				<TextField
					type="time"
					size="small"
					label={I18n.t("ui_settings_to")}
					value={end}
					error={end !== "" && !isValidTimeOfDay(end)}
					onChange={event => setEnd(event.target.value)}
					onBlur={() => {
						if (enabled && composeWindow(start, end)) commit(start, end, true);
					}}
					sx={{ flex: 1 }}
					InputLabelProps={{ shrink: true }}
				/>
			</Stack>

			{/*
			 * Said plainly rather than left to be discovered: a time changed while the window is off
			 * is kept here and reaches the robot when the switch is turned on.
			 */}
			{!enabled ? (
				<Typography
					variant="caption"
					color="text.secondary"
					sx={{ display: "block", mt: 0.5 }}
				>
					{I18n.t("ui_settings_dnd_off_hint")}
				</Typography>
			) : null}
		</Box>
	);
}

/**
 * The persistent robot settings, collapsed by default like the panels beside it.
 *
 * This is the place the remaining settings of the analysis are meant to land in - the LED, the mop
 * wash parameters, the drying, the carpet behaviour. Which settings appear is decided by
 * `settings/robotSettings.ts` out of the objects the adapter published, so a robot that does not
 * have a setting never shows a control for it, and the panel stays away entirely when a robot has
 * none of them.
 */
export function SettingsPanel({ settings, onWrite }: SettingsPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);

	if (!settings || !settings.entries.length) {
		return null;
	}

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<TuneIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_settings")}
				</Typography>
				<IconButton size="small">
					<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
				</IconButton>
			</Stack>

			<Collapse in={open}>
				<Stack
					spacing={1.5}
					sx={{ px: 1.5, pb: 1.5, maxHeight: "44vh", overflowY: "auto" }}
				>
					{settings.entries.map(entry =>
						entry.kind === "switch" ? (
							<SwitchRow
								key={entry.command}
								setting={entry}
								onWrite={onWrite}
							/>
						) : (
							<TimeWindowRow
								key={entry.command}
								setting={entry}
								onWrite={onWrite}
							/>
						),
					)}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
