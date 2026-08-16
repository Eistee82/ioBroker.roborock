import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, Stack, Switch, Tooltip, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ScheduleIcon from "@mui/icons-material/Schedule";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import { describeRepetition } from "../schedules/schedules";
import type { ScheduleEntry, SchedulesModel } from "../schedules/schedules";

interface SchedulesPanelProps {
	/** The model, or null while no device is selected or nothing has been read yet. */
	schedules: SchedulesModel | null;
	/** Admin language, used for the weekday and month names. */
	language: string;
	onToggle: (timerId: string, enabled: boolean) => void;
	onDelete: (timerId: string) => void;
}

interface ScheduleRowProps {
	entry: ScheduleEntry;
	language: string;
	/** Schedule whose delete question is currently open, so only one can be open at a time. */
	pending: string | null;
	setPending: React.Dispatch<React.SetStateAction<string | null>>;
	onToggle: (timerId: string, enabled: boolean) => void;
	onDelete: (timerId: string) => void;
}

/** Where a schedule is kept, in one word; an entry the adapter could not place carries no chip. */
function sourceLabel(entry: ScheduleEntry): string | null {
	if (entry.source === "device") return I18n.t("ui_schedules_source_device");
	if (entry.source === "server") return I18n.t("ui_schedules_source_server");
	return null;
}

/**
 * One schedule: when it runs, where it is kept, its switch and its delete.
 *
 * The time is the heading of the row rather than a field in it, because it is the one thing a person
 * looks for in a list of schedules. What could not be read is shown as the robot's own text instead of
 * being left out - a schedule this build does not understand is still a schedule the user has.
 */
function ScheduleRow({ entry, language, pending, setPending, onToggle, onDelete }: ScheduleRowProps): React.JSX.Element {
	const source = sourceLabel(entry);
	const repetition = entry.timing ? describeRepetition(entry.timing, language, key => I18n.t(key)) : null;
	const open = pending === entry.id;

	return (
		<Box>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
			>
				<Box sx={{ flex: 1, minWidth: 0 }}>
					<Typography
						variant="body2"
						className={entry.timing ? "rr-numeric" : undefined}
						sx={{ fontWeight: 600, overflowWrap: "anywhere" }}
					>
						{entry.timing ? entry.timing.time : (entry.rawTime ?? entry.id)}
					</Typography>
					{repetition ? (
						<Typography
							variant="caption"
							color="text.secondary"
							sx={{ display: "block" }}
						>
							{repetition}
						</Typography>
					) : null}
					{!entry.timing && entry.rawTime ? (
						<Typography
							variant="caption"
							color="text.secondary"
							sx={{ display: "block" }}
						>
							{I18n.t("ui_schedules_time_unreadable")}
						</Typography>
					) : null}
					{/*
					 * A server-side schedule publishes no time at all, so the row is headed by its
					 * identifier and would otherwise leave the reader to work out why. The reason is
					 * not a shortcoming of this panel: the robot only reports which schedules exist and
					 * whether they are on, while the times, rooms and modes are held in the Roborock
					 * account - proven in the app's own merge function, which fetches the two halves
					 * separately and even deletes an entry that has no cloud part.
					 */}
					{!entry.timing && !entry.rawTime && entry.source === "server" ? (
						<Typography
							variant="caption"
							color="text.secondary"
							sx={{ display: "block" }}
						>
							{I18n.t("ui_schedules_content_in_cloud")}
						</Typography>
					) : null}
				</Box>

				{source ? (
					<Chip
						size="small"
						variant="outlined"
						label={source}
						sx={{ flexShrink: 0 }}
					/>
				) : null}

				{/*
				 * A schedule that cannot be switched from here shows what it is doing and no control at
				 * all. A disabled switch would still read as "this is operable, just not now", which is
				 * the opposite of the truth: the command behind it is not one this robot understands.
				 */}
				{entry.canToggle ? (
					<Switch
						size="small"
						checked={entry.enabled === true}
						inputProps={{ "aria-label": `${I18n.t("ui_schedules_enabled")}: ${entry.timing?.time ?? entry.id}` }}
						onChange={event => onToggle(entry.id, event.target.checked)}
					/>
				) : (
					<Typography
						variant="caption"
						color="text.secondary"
						sx={{ flexShrink: 0 }}
					>
						{entry.enabled === null ? "—" : I18n.t(entry.enabled ? "ui_schedules_on" : "ui_schedules_off")}
					</Typography>
				)}

				{entry.canDelete ? (
					<Tooltip title={I18n.t("schedule_delete")}>
						<IconButton
							size="small"
							aria-label={`${I18n.t("schedule_delete")}: ${entry.timing?.time ?? entry.id}`}
							aria-expanded={open}
							color={open ? "error" : "default"}
							sx={{ mr: -0.5, flexShrink: 0 }}
							onClick={() => setPending(current => (current === entry.id ? null : entry.id))}
						>
							<DeleteOutlineIcon fontSize="small" />
						</IconButton>
					</Tooltip>
				) : null}
			</Stack>

			{/*
			 * The warning stands **before** the deletion, not after it, and the server half of it is the
			 * whole reason this confirmation is not a one-line "are you sure": the adapter deletes the
			 * robot's half of a server-side schedule and cannot reach the copy in the Roborock account,
			 * so the phone app goes on listing it and shows it as switched on. Finding that out on the
			 * phone afterwards is exactly what this text prevents.
			 *
			 * The wording is the adapter's own, the same sentence that stands on the button in the
			 * object tree and in the documentation - one source, eleven languages, no second phrasing
			 * that can drift away from it.
			 */}
			{entry.canDelete && open ? (
				<Box sx={{ mt: 1 }}>
					<Typography
						variant="caption"
						color="text.secondary"
						sx={{ display: "block" }}
					>
						{I18n.t("schedule_delete_hint")}
						{entry.source === "server" ? ` ${I18n.t("schedule_delete_server_hint")}` : ""}
					</Typography>
					<Stack
						direction="row"
						spacing={1}
						sx={{ mt: 0.75 }}
					>
						<Button
							size="small"
							variant="contained"
							color="error"
							onClick={() => {
								setPending(null);
								onDelete(entry.id);
							}}
						>
							{I18n.t("ui_schedules_delete_yes")}
						</Button>
						<Button
							size="small"
							onClick={() => setPending(null)}
						>
							{I18n.t("ui_cancel")}
						</Button>
					</Stack>
				</Box>
			) : null}
		</Box>
	);
}

/**
 * The schedules of the robot, collapsed by default like the panels beside it.
 *
 * The panel stays away entirely when a robot has no schedule, which is the rule every other panel
 * here follows - and it is the honest one in this case rather than merely the consistent one: there
 * is no "new schedule" to offer. The adapter cannot write one. `set_timer` is implemented nowhere,
 * and a server-side schedule does not even keep its times, rooms and modes in the robot; they live in
 * the Roborock account and cannot be read over the local channel. An empty panel with a greyed-out
 * plus would promise a way in that does not exist.
 *
 * What it does say, for the person who has schedules and wonders where the plus is, is the footnote:
 * new schedules are made in the Roborock app, and the times shown here are the robot's own - it runs
 * them in its time zone, which is the one the app writes beside every schedule it saves
 * (A65:750384-750393).
 */
export function SchedulesPanel({ schedules, language, onToggle, onDelete }: SchedulesPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	// Only one open question at a time, so a pending confirmation cannot be overlooked.
	const [pending, setPending] = useState<string | null>(null);

	if (!schedules || !schedules.entries.length) {
		return null;
	}

	const activeCount = schedules.entries.filter(entry => entry.enabled === true).length;

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<ScheduleIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_schedules")}
				</Typography>
				{activeCount > 0 ? (
					<Chip
						size="small"
						color="primary"
						label={<span className="rr-numeric">{activeCount}</span>}
					/>
				) : null}
				<IconButton size="small">
					<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
				</IconButton>
			</Stack>

			<Collapse in={open}>
				<Stack
					spacing={1.5}
					sx={{ px: 1.5, pb: 1.5, maxHeight: "44vh", overflowY: "auto" }}
				>
					{schedules.entries.map(entry => (
						<ScheduleRow
							key={entry.id}
							entry={entry}
							language={language}
							pending={pending}
							setPending={setPending}
							onToggle={onToggle}
							onDelete={onDelete}
						/>
					))}

					{schedules.hasReadOnly ? (
						<Typography
							variant="caption"
							color="text.secondary"
						>
							{I18n.t("ui_schedules_readonly_hint")}
						</Typography>
					) : null}

					<Typography
						variant="caption"
						color="text.secondary"
					>
						{I18n.t("ui_schedules_no_create_hint")} {I18n.t("ui_schedules_timezone_hint")}
					</Typography>
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
