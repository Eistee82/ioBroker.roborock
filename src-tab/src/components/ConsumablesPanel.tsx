import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import BuildIcon from "@mui/icons-material/Build";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import type { ConsumableGroup, ConsumablePartModel } from "../engine/types";

interface ConsumablesPanelProps {
	parts: ConsumablePartModel[];
	onReset: (command: string) => void;
}

/**
 * The two groups in the order the Roborock app lists them: everything on the robot first, the
 * station's own wear parts after it.
 *
 * The app splits its supplies page the same way but draws no captions at all - its section header
 * is a 15 px transparent spacer (`_sectionComp`, decompiled a65 control plugin, line 844092). A
 * bare gap is enough on a full-screen page with a photo per part; in a 300 px panel of plain text
 * rows it would read as an accident, so the headings are named here.
 */
const GROUP_ORDER: { group: ConsumableGroup; labelKey: string }[] = [
	{ group: "robot", labelKey: "ui_consumables_group_robot" },
	{ group: "station", labelKey: "ui_consumables_group_station" },
];

interface ConsumableRowProps {
	part: ConsumablePartModel;
	/** Part whose reset question is currently open, so only one can be open at a time. */
	pending: string | null;
	setPending: React.Dispatch<React.SetStateAction<string | null>>;
	onReset: (command: string) => void;
}

/** One part: its name, its published values, its meter and its reset. */
function ConsumableRow({ part, pending, setPending, onReset }: ConsumableRowProps): React.JSX.Element {
	return (
		<Box>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
			>
				<Typography
					variant="body2"
					sx={{ fontWeight: 600, flex: 1, overflowWrap: "anywhere" }}
				>
					{part.name}
				</Typography>
				{part.due ? (
					<Typography
						variant="caption"
						color="error"
						sx={{ fontWeight: 700 }}
					>
						{I18n.t("ui_consumable_due")}
					</Typography>
				) : null}
				{/*
				 * The reset is an icon so the row stays as narrow as the panel; the tooltip
				 * and the aria-label carry the meaning the removed caption used to carry.
				 * `mr: -0.5` pulls the icon's own padding back to the panel edge without
				 * shrinking the hit area, and the focus ring stays MUI's default so the
				 * control remains findable by keyboard.
				 */}
				{part.resetCommand ? (
					<Tooltip title={I18n.t("ui_consumable_reset")}>
						<IconButton
							size="small"
							aria-label={`${I18n.t("ui_consumable_reset")}: ${part.name}`}
							aria-expanded={pending === part.part}
							color={pending === part.part ? "error" : "default"}
							sx={{ mr: -0.5 }}
							onClick={() => setPending(current => (current === part.part ? null : part.part))}
						>
							<RestartAltIcon fontSize="small" />
						</IconButton>
					</Tooltip>
				) : null}
			</Stack>

			<Stack
				direction="row"
				spacing={1.5}
				flexWrap="wrap"
				useFlexGap
			>
				{part.metrics.map(metric => (
					<Typography
						key={metric.name}
						variant="caption"
						color="text.secondary"
						className="rr-numeric"
					>
						{metric.name}: {metric.text}
					</Typography>
				))}
			</Stack>

			{part.percent !== null ? (
				<LinearProgress
					variant="determinate"
					value={part.percent}
					color={part.due ? "error" : "primary"}
					sx={{ mt: 0.75, height: 6, borderRadius: 3 }}
				/>
			) : null}

			{/*
			 * The confirmation keeps its labelled buttons: the icon above may be
			 * compact, but the question of whether a counter is wiped for good has to
			 * be answered in words.
			 */}
			{part.resetCommand && pending === part.part ? (
				<Box sx={{ mt: 1 }}>
					<Typography
						variant="caption"
						color="text.secondary"
					>
						{I18n.t("ui_consumable_reset_confirm").replace("%s", part.name)}
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
								onReset(part.resetCommand!);
							}}
						>
							{I18n.t("ui_consumable_reset_yes")}
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
 * The consumables, collapsed by default so they never stand in front of the map.
 *
 * Parts are listed by unit - robot first, then station - because that is how the app groups them
 * and how a user has to think about them: the robot's brushes and filter are replaced, the
 * station's brush and strainer are washed. A device that reports only robot parts, which is every
 * model without a dock, keeps the plain ungrouped list; a single heading over the whole panel
 * would say nothing.
 *
 * The reset itself is an icon button next to the part it belongs to, so a panel of six parts
 * is not six wide captions. Its confirmation stays inline instead of a `confirm()` dialog: an
 * accidental reset falsifies the maintenance planning for good, and a browser dialog is both
 * easy to click away and impossible to style.
 */
export function ConsumablesPanel({ parts, onReset }: ConsumablesPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	// Only one open question at a time, so a pending confirmation cannot be overlooked.
	const [pending, setPending] = useState<string | null>(null);

	if (!parts.length) {
		return null;
	}
	const dueCount = parts.filter(part => part.due).length;

	// An empty group is dropped rather than shown as a bare heading. Parts keep the order the
	// engine delivered them in; only the grouping moves them.
	const groups = GROUP_ORDER.map(entry => ({ ...entry, parts: parts.filter(part => part.group === entry.group) })).filter(
		entry => entry.parts.length > 0,
	);
	const showHeadings = groups.length > 1;

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<BuildIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_consumables")}
				</Typography>
				{dueCount > 0 ? (
					<Chip
						size="small"
						color="error"
						label={<span className="rr-numeric">{dueCount}</span>}
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
					{groups.map(entry => (
						<React.Fragment key={entry.group}>
							{showHeadings ? (
								<Typography
									variant="overline"
									color="text.secondary"
									sx={{ lineHeight: 1.6, letterSpacing: ".08em" }}
								>
									{I18n.t(entry.labelKey)}
								</Typography>
							) : null}
							{entry.parts.map(part => (
								<ConsumableRow
									key={part.part}
									part={part}
									pending={pending}
									setPending={setPending}
									onReset={onReset}
								/>
							))}
						</React.Fragment>
					))}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
