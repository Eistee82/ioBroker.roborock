import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import DoorFrontIcon from "@mui/icons-material/DoorFront";
import EditIcon from "@mui/icons-material/Edit";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import type { RoomListModel } from "../engine/types";

interface RoomsPanelProps {
	rooms: RoomListModel;
	/** Sends the new name for one room; the engine refuses an empty or over-long one. */
	onRename: (segmentId: number, name: string) => void;
}

/**
 * The rooms of the map that is currently shown, and their names.
 *
 * ## Why a panel and not a double-click on the label
 *
 * A room label on the map already has a job: clicking it picks the room for the next run. Giving
 * the same target a second meaning on a second kind of click would make the frequent action - the
 * one a user does before every segment run - riskier in order to reach a rare one. The panel also
 * lists rooms that are hard to hit on a small map, and it is where the cleaning order will go.
 *
 * ## What renaming actually does
 *
 * The robot never stores a room name. It keeps a segment id and a cloud room id; the name lives in
 * the Roborock cloud, and `name_segment` points the segment at a cloud room that carries the wanted
 * name (`_appanalysis/14-editor-methoden.md` §1.5). That is the one place in this whole editor that
 * cannot work without the cloud - worth knowing, because everything else here is local.
 *
 * The adapter rebuilds the **entire** room assignment for each call, because a partial list drops
 * the names of every room it leaves out. So one rename is one full rewrite, which is why the field
 * commits on Enter or on the button rather than on every keystroke.
 *
 * Only rooms that already carry a name are listed: an unnamed segment has no label on the map
 * either, and a row showing nothing but a number would invite renaming a room the user cannot
 * identify.
 */
export function RoomsPanel({ rooms, onRename }: RoomsPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	/** Segment id whose name is being edited, or null. Only one at a time. */
	const [editing, setEditing] = useState<number | null>(null);
	const [draft, setDraft] = useState("");

	// A map without named rooms - or no map at all - gets no panel rather than an empty one.
	if (!rooms.rooms.length) return null;

	const selectedCount = rooms.rooms.filter(room => room.selected).length;

	const startEditing = (segmentId: number, name: string): void => {
		setEditing(segmentId);
		setDraft(name);
	};

	const commit = (segmentId: number): void => {
		const name = draft.trim();
		setEditing(null);
		// The engine drops a name that did not change; checking here too keeps the panel from
		// flashing a pending state for a write that never happens.
		if (name) onRename(segmentId, name);
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
				<DoorFrontIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_rooms")}
				</Typography>
				{selectedCount > 0 ? (
					<Chip
						size="small"
						color="primary"
						label={<span className="rr-numeric">{selectedCount}</span>}
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
					{rooms.rooms.map(room =>
						editing === room.segmentId ? (
							<Box key={room.segmentId}>
								<TextField
									fullWidth
									autoFocus
									size="small"
									variant="outlined"
									value={draft}
									// The app stops at the same number, so the field cannot compose a
									// name the adapter would refuse afterwards.
									inputProps={{ maxLength: rooms.maxNameLength }}
									label={I18n.t("ui_room_rename")}
									onChange={event => setDraft(event.target.value)}
									onKeyDown={event => {
										if (event.key === "Enter") commit(room.segmentId);
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
										disabled={draft.trim().length === 0}
										onClick={() => commit(room.segmentId)}
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
								key={room.segmentId}
								direction="row"
								alignItems="center"
								spacing={1}
							>
								<Typography
									variant="body2"
									sx={{ flex: 1, overflowWrap: "anywhere", fontWeight: room.selected ? 700 : 400 }}
								>
									{room.name}
								</Typography>
								<Tooltip title={I18n.t("ui_room_rename")}>
									<IconButton
										size="small"
										sx={{ mr: -0.5 }}
										aria-label={`${I18n.t("ui_room_rename")}: ${room.name}`}
										onClick={() => startEditing(room.segmentId, room.name)}
									>
										<EditIcon fontSize="small" />
									</IconButton>
								</Tooltip>
							</Stack>
						),
					)}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
