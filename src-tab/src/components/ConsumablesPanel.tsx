import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import BuildIcon from "@mui/icons-material/Build";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
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
					))}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
