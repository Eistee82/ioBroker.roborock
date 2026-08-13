import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, MenuItem, Stack, TextField, Tooltip, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DockIcon from "@mui/icons-material/Dock";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import { DOCK_COMMAND_PAIRS } from "../engine/robotStates";
import type { DockActivity, DockModel, RobotPhase } from "../engine/types";

interface DockPanelProps {
	dock: DockModel;
	/** What the robot is doing; station actions need it standing in the dock. */
	phase: RobotPhase;
	/** Station job under way, so its Stop button replaces the Start one. */
	dockActivity: DockActivity;
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
export function DockPanel({ dock, phase, dockActivity, onCommand }: DockPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);

	if (!dock.controls.length && !dock.status.length) {
		return null;
	}
	const selectors = dock.controls.filter(control => control.kind !== "button");

	// Mop washing and dust collection each publish a Start and a Stop command as two separate
	// buttons, and one of the two is always pointless. The robot state says which job is
	// running (`23`/`25` washing, `22` emptying), so only the matching half is offered.
	//
	// Buttons outside a known pair - drying, for instance - are left untouched: guessing a
	// pairing from the command name would break the moment a model publishes something new.
	const suppressed = new Set<string>();
	for (const [job, pair] of Object.entries(DOCK_COMMAND_PAIRS)) {
		suppressed.add(dockActivity === job ? pair.start : pair.stop);
	}
	const buttons = dock.controls.filter(control => control.kind === "button" && !suppressed.has(control.command));

	// Washing, drying and dust collection all need the robot standing in its station. While it
	// is out cleaning, paused somewhere in the flat or still on its way back, the robot answers
	// such a command without any usable feedback, so the button is disabled and says why.
	// An unknown phase leaves them enabled on purpose: a guess must not take a working control
	// away, and the robot rejecting a command is the smaller harm than a dead panel.
	const robotAway = phase === "cleaning" || phase === "paused" || phase === "returning";
	const buttonHint = robotAway ? I18n.t("ui_dock_needs_robot") : "";

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
								<Tooltip
									key={control.command}
									title={buttonHint}
								>
									{/* A disabled button fires no events, so the tooltip needs a live wrapper. */}
									<span>
										<Button
											size="small"
											variant="outlined"
											disabled={robotAway}
											onClick={() => onCommand(control.command, true)}
										>
											{control.label}
										</Button>
									</span>
								</Tooltip>
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
