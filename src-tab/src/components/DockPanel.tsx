import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, MenuItem, Stack, TextField, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DockIcon from "@mui/icons-material/Dock";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import type { DockModel } from "../engine/types";

interface DockPanelProps {
	dock: DockModel;
	/** `value` is a boolean for switches and buttons, a string for selects. */
	onCommand: (command: string, value: unknown) => void;
}

/**
 * The dock: its actions, its modes and its station states.
 *
 * Nothing here is a model list - an entry only exists because the device handler published
 * that command object, and the object's shape decided whether it became a button, a switch
 * or a value selector.
 */
export function DockPanel({ dock, onCommand }: DockPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);

	if (!dock.controls.length && !dock.status.length) {
		return null;
	}
	const buttons = dock.controls.filter(control => control.kind === "button");
	const selectors = dock.controls.filter(control => control.kind !== "button");

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<DockIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_dock_panel")}
				</Typography>
				{/* A collapsed panel would hide a dock fault, so it is flagged on the summary line. */}
				{dock.faulty ? (
					<Chip
						size="small"
						color="error"
						label={I18n.t("ui_error")}
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
					{buttons.length ? (
						<Stack
							direction="row"
							spacing={1}
							flexWrap="wrap"
							useFlexGap
						>
							{buttons.map(control => (
								<Button
									key={control.command}
									size="small"
									variant="outlined"
									onClick={() => onCommand(control.command, true)}
								>
									{control.label}
								</Button>
							))}
						</Stack>
					) : null}

					{selectors.map(control => (
						<TextField
							key={control.command}
							select
							size="small"
							label={control.label}
							value={control.value ?? ""}
							onChange={event =>
								onCommand(
									control.command,
									control.kind === "switch" ? event.target.value === "true" : event.target.value
								)
							}
						>
							{control.options.map(option => (
								<MenuItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</MenuItem>
							))}
						</TextField>
					))}

					{dock.status.length ? (
						<Box>
							{dock.status.map(row => (
								<Stack
									key={row.stateId}
									direction="row"
									justifyContent="space-between"
									spacing={1.5}
									sx={{ py: 0.25 }}
								>
									<Typography
										variant="caption"
										color="text.secondary"
										sx={{ overflowWrap: "anywhere" }}
									>
										{row.name}
									</Typography>
									<Typography
										variant="caption"
										className="rr-numeric"
										sx={{ fontWeight: 600, textAlign: "right" }}
									>
										{row.text}
									</Typography>
								</Stack>
							))}
						</Box>
					) : (
						<Typography
							variant="caption"
							color="text.secondary"
						>
							{I18n.t("ui_dock_no_status")}
						</Typography>
					)}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
