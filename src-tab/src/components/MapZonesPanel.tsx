import React, { useState } from "react";
import { Alert, Box, Button, Chip, Collapse, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import BlockIcon from "@mui/icons-material/Block";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import type { MapZonesModel } from "../engine/types";

interface MapZonesPanelProps {
	zones: MapZonesModel;
	/** Starts placing one; nothing is sent until it is confirmed. */
	onAdd: (kind: "no_go" | "no_mop" | "wall") => void;
	/** Sends the one being placed. */
	onSave: () => void;
	/** Drops the one being placed. */
	onCancel: () => void;
}

/**
 * The three kinds, in the order the app's own editor lists them.
 *
 * Each carries its own count and its own limit of ten - `MAX_COUNT_WALL_OR_FBZ` is per kind, not a
 * shared budget, so a map full of no-go zones still has room for ten walls.
 */
const KINDS: { kind: "no_go" | "no_mop" | "wall"; labelKey: string; fallback: string }[] = [
	{ kind: "no_go", labelKey: "ui_map_zone_no_go", fallback: "No-go zone" },
	{ kind: "no_mop", labelKey: "ui_map_zone_no_mop", fallback: "No-mop zone" },
	{ kind: "wall", labelKey: "ui_map_zone_wall", fallback: "Invisible wall" },
];

/**
 * The walls and zones stored on the robot itself.
 *
 * ## Why placing is a two-step action
 *
 * Every change to these rewrites the **complete** set on the robot: `save_map` keeps only what it
 * is sent, with no operation code and no zone id (`_appanalysis/14-editor-methoden.md` section
 * 2.1). The adapter makes that safe by reading the robot's own map first and writing everything
 * back, but each save is still one full rewrite.
 *
 * So a new zone is placed in the browser first. It can be dragged, resized and turned as often as
 * the user likes, and only "Save" sends anything - one write for one zone, instead of one write per
 * nudge. It also means a mis-drawn zone can simply be dropped, which is the difference between a
 * mistake and a boundary the user has to reconstruct by hand.
 *
 * ## Why an existing zone can only be deleted here
 *
 * Moving one would be "remove, then add": two rewrites with a fresh read of the robot's map in
 * between, and whether that second read already reflects the first write is not decidable from
 * outside the firmware. If it does not, the removed zone comes back and the moved one is added
 * beside it. Deleting and placing anew is one rewrite each and cannot end in that state, so that is
 * what is offered until the adapter can do both in a single cycle.
 */
export function MapZonesPanel({ zones, onAdd, onSave, onCancel }: MapZonesPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);

	// A map that carries none of these blocks at all - every non-V1 pipeline - gets no controls
	// rather than controls that cannot work.
	if (!zones.supported) return null;

	const total = zones.counts.no_go + zones.counts.no_mop + zones.counts.wall;
	const blocked = zones.refusalText !== null;

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<BlockIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_map_zones")}
				</Typography>
				{total > 0 ? (
					<Chip
						size="small"
						label={<span className="rr-numeric">{total}</span>}
					/>
				) : null}
				<IconButton size="small">
					<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
				</IconButton>
			</Stack>

			<Collapse in={open}>
				<Stack
					spacing={1.5}
					sx={{ px: 1.5, pb: 1.5 }}
				>
					{blocked ? <Alert severity="warning">{zones.refusalText}</Alert> : null}

					{zones.drafting ? (
						<Box>
							<Typography
								variant="body2"
								sx={{ mb: 1 }}
							>
								{I18n.t("ui_map_zone_draft_hint")}
							</Typography>
							<Stack
								direction="row"
								spacing={1}
							>
								<Button
									variant="contained"
									size="small"
									startIcon={<CheckIcon />}
									onClick={onSave}
								>
									{I18n.t("ui_map_zone_save")}
								</Button>
								<Button
									size="small"
									startIcon={<CloseIcon />}
									onClick={onCancel}
								>
									{I18n.t("ui_cancel")}
								</Button>
							</Stack>
						</Box>
					) : (
						<>
							<Typography
								variant="caption"
								color="text.secondary"
							>
								{I18n.t("ui_map_zones_hint")}
							</Typography>
							{KINDS.map(entry => {
								const count = zones.counts[entry.kind];
								const atLimit = count >= zones.limit;
								return (
									<Stack
										key={entry.kind}
										direction="row"
										alignItems="center"
										spacing={1}
									>
										<Typography
											variant="body2"
											sx={{ flex: 1 }}
										>
											{I18n.t(entry.labelKey)}
										</Typography>
										<Typography
											variant="caption"
											color="text.secondary"
											className="rr-numeric"
										>
											{count} / {zones.limit}
										</Typography>
										<Tooltip
											title={
												atLimit
													? I18n.t("ui_map_zone_limit").replace("%s", String(zones.limit))
													: I18n.t("ui_map_zone_add")
											}
										>
											{/* The span keeps the tooltip alive over a disabled button. */}
											<span>
												<Button
													size="small"
													variant="outlined"
													disabled={atLimit || blocked}
													aria-label={`${I18n.t("ui_map_zone_add")}: ${I18n.t(entry.labelKey)}`}
													onClick={() => onAdd(entry.kind)}
												>
													{I18n.t("ui_map_zone_add")}
												</Button>
											</span>
										</Tooltip>
									</Stack>
								);
							})}
						</>
					)}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
