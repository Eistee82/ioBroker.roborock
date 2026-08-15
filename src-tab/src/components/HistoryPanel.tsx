import React, { useState } from "react";
import { Box, ButtonBase, Chip, Collapse, IconButton, Stack, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import HistoryIcon from "@mui/icons-material/History";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import { CLEAN_TYPE_LABEL_KEYS } from "../history/cleaningHistory";
import { formatFieldValue, formatMeasure, formatRunStartShort } from "../history/historyFormat";
import type { CleaningHistoryModel, CleaningRunModel } from "../history/historyTypes";

interface HistoryPanelProps {
	/** The model, or null while no device is selected or nothing has been read yet. */
	history: CleaningHistoryModel | null;
	/** Admin language, for dates, numbers and units. */
	language: string;
	onSelectRun: (run: CleaningRunModel) => void;
}

/**
 * Wording of the three lifetime totals.
 *
 * The object names the adapter publishes for them are the raw field names (`clean_area`,
 * `clean_time`, `clean_count`), so unlike the consumables the panel cannot take the caption from
 * the object. The three keys carry the Roborock app's own wording instead - see the i18n files.
 */
const SUMMARY_LABEL_KEYS: Record<string, string> = {
	clean_area: "ui_history_total_area",
	clean_time: "ui_history_total_time",
	clean_count: "ui_history_total_runs",
};

/**
 * One run as a single row: when it ran, how long, how much, and how it ended.
 *
 * The whole row is a button because the interesting part - the map of that run - lives one click
 * away, and a row that only looks clickable in one corner is a row nobody clicks.
 */
function HistoryRow({ run, language, onSelect }: { run: CleaningRunModel; language: string; onSelect: () => void }): React.JSX.Element {
	const started = formatRunStartShort(run.startedAt, language);
	const duration = formatMeasure(run.duration, language);
	const area = formatMeasure(run.area, language);
	const typeKey = run.cleanType !== null ? CLEAN_TYPE_LABEL_KEYS[run.cleanType] : undefined;
	const type = typeKey ? I18n.t(typeKey) : run.cleanType !== null ? formatFieldValue(run.cleanType, "", language) : null;

	// Only the runs that were cut short are marked. A tick on every one of the twenty normal rows
	// would be twenty ticks saying nothing; the exception is what the user is looking for.
	const interrupted = run.finished === false;

	return (
		<ButtonBase
			onClick={onSelect}
			sx={{
				display: "block",
				width: "100%",
				textAlign: "left",
				borderRadius: 2,
				px: 1,
				py: 0.75,
				"&:hover": { backgroundColor: "action.hover" },
			}}
		>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
			>
				<Typography
					variant="body2"
					className="rr-numeric"
					sx={{ fontWeight: 600, flex: 1 }}
				>
					{started ?? `#${run.index}`}
				</Typography>
				{type ? (
					<Typography
						variant="caption"
						color="text.secondary"
						sx={{ overflowWrap: "anywhere" }}
					>
						{type}
					</Typography>
				) : null}
				{interrupted ? (
					<Chip
						size="small"
						color="warning"
						variant="outlined"
						label={I18n.t("ui_history_interrupted_short")}
					/>
				) : null}
			</Stack>

			<Stack
				direction="row"
				spacing={1.5}
				flexWrap="wrap"
				useFlexGap
			>
				{area ? (
					<Typography
						variant="caption"
						color="text.secondary"
						className="rr-numeric"
					>
						{area}
					</Typography>
				) : null}
				{duration ? (
					<Typography
						variant="caption"
						color="text.secondary"
						className="rr-numeric"
					>
						{duration}
					</Typography>
				) : null}
			</Stack>
		</ButtonBase>
	);
}

/**
 * The cleaning history, collapsed by default like the panels beside it.
 *
 * Everything shown is already in the object tree - the adapter fetches `get_clean_summary` and one
 * `get_clean_record` per run whenever the robot parks (`src/lib/deviceManager.ts:530-541`). This
 * panel is purely a reader: it sends the robot nothing at all.
 *
 * The panel stays away entirely while the device has published no history. A device that has never
 * cleaned, or one whose pipeline does not fill this branch, would otherwise get an empty box that
 * looks like a failure.
 */
export function HistoryPanel({ history, language, onSelectRun }: HistoryPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);

	if (!history || (!history.runs.length && !history.summary.length)) {
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
				<HistoryIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_history")}
				</Typography>
				{history.runs.length ? (
					<Chip
						size="small"
						variant="outlined"
						label={<span className="rr-numeric">{history.runs.length}</span>}
					/>
				) : null}
				<IconButton size="small">
					<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
				</IconButton>
			</Stack>

			<Collapse in={open}>
				<Stack
					spacing={1}
					sx={{ px: 1.5, pb: 1.5, maxHeight: "44vh", overflowY: "auto" }}
				>
					{/*
					 * The lifetime totals. Each entry carries the name and the unit of its own
					 * object, so a device that publishes no unit shows a bare number instead of a
					 * made-up one - the same rule the consumables panel follows.
					 */}
					{history.summary.length ? (
						<Box>
							{history.summary.map(entry => (
								<Stack
									key={entry.key}
									direction="row"
									justifyContent="space-between"
									spacing={1.5}
									sx={{ py: 0.25 }}
								>
									<Typography
										variant="caption"
										color="text.secondary"
									>
										{I18n.t(SUMMARY_LABEL_KEYS[entry.key] ?? entry.key)}
									</Typography>
									<Typography
										variant="caption"
										className="rr-numeric"
										sx={{ fontWeight: 600, textAlign: "right" }}
									>
										{typeof entry.value === "number"
											? formatMeasure({ value: entry.value, unit: entry.unit }, language)
											: formatFieldValue(entry.value, entry.unit, language)}
									</Typography>
								</Stack>
							))}
						</Box>
					) : null}

					{history.runs.length ? (
						<Stack sx={{ mx: -1 }}>
							{history.runs.map(run => (
								<HistoryRow
									key={run.index}
									run={run}
									language={language}
									onSelect={() => onSelectRun(run)}
								/>
							))}
						</Stack>
					) : (
						<Typography
							variant="caption"
							color="text.secondary"
						>
							{I18n.t("ui_history_empty")}
						</Typography>
					)}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
