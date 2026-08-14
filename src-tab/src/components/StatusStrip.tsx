import React from "react";
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import BatteryFullIcon from "@mui/icons-material/BatteryFull";
import CropFreeIcon from "@mui/icons-material/CropFree";
import ScheduleIcon from "@mui/icons-material/Schedule";
import LanIcon from "@mui/icons-material/Lan";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import CenterFocusStrongIcon from "@mui/icons-material/CenterFocusStrong";
import { I18n } from "@iobroker/adapter-react-v5";
import type { StatusModel } from "../engine/types";

interface StatusStripProps {
	status: StatusModel;
	/** Returns the map to the fit that was computed for it. */
	onResetZoom: () => void;
}

/**
 * One reading of the strip. Values use tabular figures so they cannot jitter while updating.
 */
function Reading({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.JSX.Element {
	return (
		<Stack
			direction="row"
			spacing={0.75}
			alignItems="center"
			title={label}
		>
			<Box sx={{ display: "flex", color: "text.secondary", "& svg": { fontSize: 18 } }}>{icon}</Box>
			<Typography
				className="rr-numeric"
				variant="body2"
				sx={{ fontWeight: 600, whiteSpace: "nowrap" }}
			>
				{value}
			</Typography>
		</Stack>
	);
}

/**
 * The live readings of the selected robot. Everything is already resolved by the engine, so
 * this component never has to know a state code or a model.
 *
 * The view reset sits at the end of the strip rather than with the run controls: it changes what is
 * *shown*, not what the robot does, and everything else that only looks at the map - which robot,
 * which floor, which channel - is up here as well. In the bottom panel it stood among Start, Stop
 * and Dock, where the only harmless button was the one that looked like the rest of them.
 */
export function StatusStrip({ status, onResetZoom }: StatusStripProps): React.JSX.Element {
	return (
		<Stack
			direction="row"
			spacing={2}
			alignItems="center"
			flexWrap="wrap"
			useFlexGap
			sx={{ px: 2, py: 1.25 }}
		>
			<Typography
				variant="subtitle2"
				sx={{ fontWeight: 700, whiteSpace: "nowrap" }}
			>
				{status.stateText ?? "–"}
			</Typography>

			<Reading
				icon={<BatteryFullIcon />}
				label={I18n.t("ui_battery")}
				value={status.battery === null ? "–" : `${status.battery} %`}
			/>
			<Reading
				icon={<CropFreeIcon />}
				label={I18n.t("ui_area")}
				value={status.cleanArea === null ? "–" : `${status.cleanArea} m²`}
			/>
			<Reading
				icon={<ScheduleIcon />}
				label={I18n.t("ui_duration")}
				value={status.cleanTime === null ? "–" : `${status.cleanTime} min`}
			/>
			{status.connectionChannel ? (
				<Reading
					icon={<LanIcon />}
					label={I18n.t("ui_connection")}
					value={status.connectionChannel}
				/>
			) : null}

			<Tooltip title={I18n.t("ui_reset_view")}>
				<IconButton
					size="small"
					aria-label={I18n.t("ui_reset_view")}
					onClick={onResetZoom}
				>
					<CenterFocusStrongIcon fontSize="small" />
				</IconButton>
			</Tooltip>

			{status.errorText ? (
				<Chip
					size="small"
					color="error"
					icon={<ErrorOutlineIcon />}
					label={`${I18n.t("ui_error")}: ${status.errorText}`}
					sx={{ maxWidth: 320 }}
				/>
			) : null}
		</Stack>
	);
}
