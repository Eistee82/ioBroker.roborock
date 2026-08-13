import React from "react";
import { Box, Chip, Stack, Typography } from "@mui/material";
import BatteryFullIcon from "@mui/icons-material/BatteryFull";
import CropFreeIcon from "@mui/icons-material/CropFree";
import ScheduleIcon from "@mui/icons-material/Schedule";
import LanIcon from "@mui/icons-material/Lan";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { I18n } from "@iobroker/adapter-react-v5";
import type { StatusModel } from "../engine/types";

interface StatusStripProps {
	status: StatusModel;
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
 */
export function StatusStrip({ status }: StatusStripProps): React.JSX.Element {
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
