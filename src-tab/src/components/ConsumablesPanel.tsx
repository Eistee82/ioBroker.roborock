import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, LinearProgress, Stack, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import BuildIcon from "@mui/icons-material/Build";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import type { ConsumablePartModel } from "../engine/types";

interface ConsumablesPanelProps {
	parts: ConsumablePartModel[];
	onReset: (command: string) => void;
}

/**
 * The consumables, collapsed by default so they never stand in front of the map.
 *
 * The reset confirmation is inline instead of a `confirm()` dialog: an accidental reset
 * falsifies the maintenance planning for good, and a browser dialog is both easy to click
 * away and impossible to style.
 */
export function ConsumablesPanel({ parts, onReset }: ConsumablesPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	// Only one open question at a time, so a pending confirmation cannot be overlooked.
	const [pending, setPending] = useState<string | null>(null);

	if (!parts.length) {
		return null;
	}
	const dueCount = parts.filter(part => part.due).length;

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
					{parts.map(part => (
						<Box key={part.part}>
							<Stack
								direction="row"
								alignItems="baseline"
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

							{part.resetCommand ? (
								pending === part.part ? (
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
								) : (
									<Button
										size="small"
										sx={{ mt: 0.5 }}
										onClick={() => setPending(part.part)}
									>
										{I18n.t("ui_consumable_reset")}
									</Button>
								)
							) : null}
						</Box>
					))}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
