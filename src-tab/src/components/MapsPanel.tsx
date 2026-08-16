import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import LayersIcon from "@mui/icons-material/Layers";
import EditIcon from "@mui/icons-material/Edit";
import BackupIcon from "@mui/icons-material/Backup";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import { MAP_NAME_BYTE_LIMIT, checkMapRename, mapNameBytes } from "../map/mapListSource";
import type { MapListModel, MapRenameRefusal } from "../map/mapListSource";
// The same formatter the history list uses. It takes a Unix timestamp in seconds and an admin
// language and returns the moment in that language, which is exactly what `addTime` needs; a second
// date formatter beside it would be a second set of locale bugs.
import { formatRunStart } from "../history/historyFormat";

interface MapsPanelProps {
	/** The robot's stored maps, and whether renaming is offered. */
	maps: MapListModel;
	/** Slot the robot itself has loaded, or null when it does not say. */
	activeMapFlag: number | null;
	/** Admin language, for the dates. */
	language: string;
	/** Sends a new name for one slot. Only called with a name this panel already accepted. */
	onRename: (mapFlag: number, name: string) => void;
}

/**
 * The robot's stored maps: what they are called, when they were last saved, what backups exist.
 *
 * ## Why this is not the floor selector
 *
 * The selector in the top bar answers "which map am I looking at" and switches it. This panel
 * answers "which maps does the robot have" and manages them. They read from different places on
 * purpose, and only this one can carry a rename:
 *
 * - the selector is filled from `commands.load_multi_map`, which the adapter creates **only when
 *   `max_multi_map > 1`**, and it hides itself below two entries - so on a robot with exactly one
 *   map there is nothing to hang a rename on;
 * - its labels are read once, when the device is chosen, so a name changed afterwards would stay
 *   wrong until the tab is reloaded.
 *
 * This panel reads `mapInventory.maps`, which the adapter re-writes whenever it reads the map list -
 * including the read that judges a rename. See `map/mapListSource.ts`.
 *
 * ## What it will not grow into
 *
 * Backing up, restoring and deleting a map are established and deliberately absent; the payloads and
 * the reasons are in `src/lib/features/vacuum/v1MapInventory.ts`. The short version: the test device
 * keeps **one** backup per map, so `manual_bak_map` replaces the only one there is, `recover_multi_map`
 * overwrites the map that is loaded, and `del_map` cannot be undone. The backup line here reports
 * what the robot holds and offers nothing.
 */
export function MapsPanel({ maps, activeMapFlag, language, onRename }: MapsPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	/** Slot whose name is being edited, or null. One at a time, as in the rooms panel. */
	const [editing, setEditing] = useState<number | null>(null);
	const [draft, setDraft] = useState("");

	// A robot that never published a map list gets no panel rather than an empty one - the same rule
	// every other panel on this page follows.
	if (!maps.maps.length) return null;

	const startEditing = (mapFlag: number, name: string): void => {
		setEditing(mapFlag);
		setDraft(name);
	};

	const refusal: MapRenameRefusal | null = editing === null ? null : checkMapRename(draft, editing, maps.maps);
	const bytes = mapNameBytes(draft.trim());

	const commit = (mapFlag: number): void => {
		if (checkMapRename(draft, mapFlag, maps.maps)) return;
		setEditing(null);
		onRename(mapFlag, draft.trim());
	};

	/** The wording for a refusal, or the byte count while the name is fine. */
	const helperText = (): string => {
		if (refusal === "too_long") return I18n.t("ui_map_name_too_long").replace("%s", String(MAP_NAME_BYTE_LIMIT));
		if (refusal === "duplicate") return I18n.t("ui_map_name_duplicate");
		if (refusal === "unchanged") return I18n.t("ui_map_name_unchanged");
		if (refusal === "unavailable") return I18n.t("ui_map_rename_unavailable");
		// Shown even while the name is fine, because the rule is not the one anybody expects: the
		// limit is in the app's own bytes, so a German name runs out sooner than its length suggests.
		return I18n.t("ui_map_name_bytes").replace("%s", String(bytes)).replace("%s", String(MAP_NAME_BYTE_LIMIT));
	};

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<LayersIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_maps")}
				</Typography>
				<Chip
					size="small"
					label={<span className="rr-numeric">{maps.maps.length}</span>}
				/>
				<IconButton size="small">
					<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
				</IconButton>
			</Stack>

			<Collapse in={open}>
				<Stack
					spacing={1.25}
					sx={{ px: 1.5, pb: 1.5, maxHeight: "44vh", overflowY: "auto" }}
				>
					{/*
					 * Said once, at the top, rather than as a disabled button per row: this panel does
					 * not switch maps and never backs one up. A user who came looking for either would
					 * otherwise conclude the adapter forgot them.
					 */}
					<Typography
						variant="caption"
						color="text.secondary"
					>
						{I18n.t("ui_maps_hint")}
					</Typography>

					{maps.maps.map(entry => {
						const label = entry.name ?? I18n.t("ui_map_unnamed").replace("%s", String(entry.mapFlag));
						const saved = formatRunStart(entry.addTime, language);
						const backup = formatRunStart(entry.lastBackupTime, language);

						return editing === entry.mapFlag ? (
							<Box key={entry.mapFlag}>
								<TextField
									fullWidth
									autoFocus
									size="small"
									variant="outlined"
									value={draft}
									label={I18n.t("ui_map_rename")}
									// Only the two the user did something about are red. An empty field is
									// the state the dialog opens in for an unnamed map, and a name that
									// has not been changed yet is every field's first moment - painting
									// either of them as a mistake would greet the user with an error.
									error={refusal === "too_long" || refusal === "duplicate"}
									helperText={helperText()}
									onChange={event => setDraft(event.target.value)}
									onKeyDown={event => {
										if (event.key === "Enter") commit(entry.mapFlag);
										if (event.key === "Escape") setEditing(null);
									}}
								/>
								<Stack
									direction="row"
									spacing={1}
									sx={{ mt: 1 }}
								>
									<Button
										variant="contained"
										size="small"
										disabled={refusal !== null}
										onClick={() => commit(entry.mapFlag)}
									>
										{I18n.t("ui_map_zone_save")}
									</Button>
									<Button
										size="small"
										onClick={() => setEditing(null)}
									>
										{I18n.t("ui_cancel")}
									</Button>
								</Stack>
							</Box>
						) : (
							<Stack
								key={entry.mapFlag}
								direction="row"
								alignItems="flex-start"
								spacing={1}
							>
								<Box sx={{ flex: 1, minWidth: 0 }}>
									<Typography
										variant="body2"
										sx={{ overflowWrap: "anywhere", fontWeight: entry.mapFlag === activeMapFlag ? 700 : 400 }}
									>
										{/*
										 * The same marker the floor selector uses, and deliberately the same
										 * wording: on a two-floor robot "which one is the machine on" is the
										 * question both controls are asked, and two phrasings for it would
										 * read as two different facts.
										 */}
										{entry.mapFlag === activeMapFlag ? `${label} ● ${I18n.t("ui_floor_active")}` : label}
									</Typography>
									{saved ? (
										<Typography
											variant="caption"
											color="text.secondary"
											sx={{ display: "block" }}
										>
											{I18n.t("ui_map_saved").replace("%s", saved)}
										</Typography>
									) : null}
									{entry.backupCount > 0 ? (
										<Tooltip title={I18n.t("ui_map_backup_hint")}>
											<Stack
												direction="row"
												alignItems="center"
												spacing={0.5}
												sx={{ color: "text.secondary" }}
											>
												<BackupIcon sx={{ fontSize: 14 }} />
												<Typography variant="caption">
													{`${I18n.t("ui_map_backup_count").replace("%s", String(entry.backupCount))}${backup ? ` · ${backup}` : ""}`}
												</Typography>
											</Stack>
										</Tooltip>
									) : null}
								</Box>

								{/*
								 * Absent, not greyed out, when the adapter did not publish the command. A
								 * robot whose firmware cannot list its maps has no slot to rename, and a
								 * permanently dead pencil explains nothing.
								 */}
								{maps.renameSupported ? (
									<Tooltip title={I18n.t("ui_map_rename")}>
										<IconButton
											size="small"
											sx={{ mr: -0.5 }}
											aria-label={`${I18n.t("ui_map_rename")}: ${label}`}
											onClick={() => startEditing(entry.mapFlag, entry.name ?? "")}
										>
											<EditIcon fontSize="small" />
										</IconButton>
									</Tooltip>
								) : null}
							</Stack>
						);
					})}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
