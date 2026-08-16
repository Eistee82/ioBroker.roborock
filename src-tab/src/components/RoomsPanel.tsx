import React, { useState } from "react";
import { Box, Button, Chip, Collapse, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import DoorFrontIcon from "@mui/icons-material/DoorFront";
import EditIcon from "@mui/icons-material/Edit";
import MergeIcon from "@mui/icons-material/Merge";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import type { RoomListModel } from "../engine/types";

interface RoomsPanelProps {
	rooms: RoomListModel;
	/** Sends the new name for one room; the engine refuses an empty or over-long one. */
	onRename: (segmentId: number, name: string) => void;
	/**
	 * Asks to combine the rooms picked on the map.
	 *
	 * Only asks: combining renumbers the robot's segments, so the shell puts the confirmation
	 * dialog in between. This panel never sends it.
	 */
	onMergeRequest: () => void;
	/** Sets the cleaning order to the rooms picked on the map, in the order they were picked. */
	onSetCleanOrder: () => void;
	/** Clears it, so the robot picks its own order again. */
	onClearCleanOrder: () => void;
	/** Whether this map can be divided at all - false hides the button rather than greying it out. */
	canSplit: boolean;
	/** Why the picked room cannot be divided, or null when it can. Shown on the disabled button. */
	splitRefusal: string | null;
	/** Lays a dividing line across the picked room. Sends nothing. */
	onSplitStart: () => void;
	/** The division in progress, or null. */
	split: SplitPanelState | null;
	/** Asks to send the line - the shell puts the confirmation dialog in between. */
	onSplitRequest: () => void;
	/** Drops the line without sending anything. */
	onSplitCancel: () => void;
}

/** The part of the engine's split state this panel shows. */
export interface SplitPanelState {
	/** Whether the line as it stands could be sent. */
	valid: boolean;
	/** Roborock's own wording for why it could not, or null. */
	hint: string | null;
	/** The two areas the line would leave behind, in square metres. */
	halves: { a: number; b: number } | null;
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
export function RoomsPanel({
	rooms,
	onRename,
	onMergeRequest,
	onSetCleanOrder,
	onClearCleanOrder,
	canSplit,
	splitRefusal,
	onSplitStart,
	split,
	onSplitRequest,
	onSplitCancel,
}: RoomsPanelProps): React.JSX.Element | null {
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
					{/*
					 * Combining is offered from the selection, because that is the thing the user
					 * can see on the map. Below two rooms it is greyed out rather than hidden: the
					 * app refuses the same case, and a button that appears only once the right
					 * number is picked is a button nobody finds.
					 */}
					<Tooltip
						title={
							selectedCount < 2 ? I18n.t("ui_rooms_merge_needs_two").replace("%s", "2") : I18n.t("ui_map_room_merge")
						}
					>
						<span>
							<Button
								fullWidth
								size="small"
								variant="outlined"
								startIcon={<MergeIcon />}
								disabled={selectedCount < 2}
								onClick={onMergeRequest}
							>
								{I18n.t("ui_map_room_merge")}
							</Button>
						</span>
					</Tooltip>

					{/*
					 * Dividing. Hidden entirely on a map that publishes no grid - a B01/Q10 device, or
					 * one whose grid did not compress - because there is nothing to draw a line on and
					 * a permanently dead button explains nothing.
					 *
					 * While a division runs, the button turns into the two that end it. The panel does
					 * not send: `onSplitRequest` only asks, and the shell puts the warning in between.
					 */}
					{canSplit && !split ? (
						<Tooltip title={splitRefusal ?? (selectedCount === 1 ? I18n.t("ui_map_room_split") : I18n.t("ui_split_pick_one"))}>
							<span>
								<Button
									fullWidth
									size="small"
									variant="outlined"
									startIcon={<CallSplitIcon />}
									disabled={selectedCount !== 1 || splitRefusal !== null}
									onClick={onSplitStart}
								>
									{I18n.t("ui_map_room_split")}
								</Button>
							</span>
						</Tooltip>
					) : null}

					{canSplit && split ? (
						<Stack spacing={1}>
							{/*
							 * The hint is Roborock's own wording for the two states the line can be in
							 * that cannot be sent. It appears and disappears while the line is dragged,
							 * so it explains a state the user can already see on the map - dashed
							 * against solid - rather than arriving after a click.
							 */}
							<Typography
								variant="caption"
								color={split.valid ? "text.secondary" : "warning.main"}
							>
								{split.hint ?? I18n.t("ui_split_ready")}
							</Typography>

							{/*
							 * The two areas. The app shows nothing of the kind, and this is the question
							 * the user actually has - "am I cutting the kitchen in the right place".
							 * Shown, not enforced: the app has no rule about the halves, and inventing
							 * one here would refuse divisions the robot would accept.
							 */}
							{split.halves ? (
								<Typography variant="caption">
									{I18n.t("ui_split_halves")
										.replace("%s", split.halves.a.toFixed(1))
										.replace("%s", split.halves.b.toFixed(1))}
								</Typography>
							) : null}

							<Stack
								direction="row"
								spacing={1}
							>
								<Button
									fullWidth
									size="small"
									variant="contained"
									onClick={onSplitCancel}
								>
									{I18n.t("ui_cancel")}
								</Button>
								<Button
									fullWidth
									size="small"
									color="warning"
									disabled={!split.valid}
									onClick={onSplitRequest}
								>
									{I18n.t("ui_map_room_split")}
								</Button>
							</Stack>
						</Stack>
					) : null}

					{/*
					 * The cleaning order, from the same selection as combining - one selection, two
					 * uses, rather than a second way of picking rooms.
					 *
					 * The current order is shown first because `set_clean_sequence` replaces the
					 * whole thing: an interface that set one without displaying the existing one
					 * would overwrite an order the user never saw. What it cannot say is whether the
					 * robot actually cleans in that order - accepting is not applying, and only a
					 * real segment run shows the difference.
					 */}
					<Box>
						<Typography
							variant="caption"
							color="text.secondary"
							sx={{ display: "block" }}
						>
							{I18n.t("ui_clean_order")}
						</Typography>
						<Typography
							variant="body2"
							sx={{ mb: 1, overflowWrap: "anywhere" }}
						>
							{rooms.cleanOrder.length ? rooms.cleanOrder.join(" → ") : I18n.t("ui_clean_order_none")}
						</Typography>
						<Stack
							direction="row"
							spacing={1}
						>
							<Tooltip title={selectedCount ? I18n.t("ui_clean_order_set") : I18n.t("ui_clean_order_needs_rooms")}>
								<span>
									<Button
										size="small"
										variant="outlined"
										disabled={selectedCount === 0}
										onClick={onSetCleanOrder}
									>
										{I18n.t("ui_clean_order_set")}
									</Button>
								</span>
							</Tooltip>
							<Button
								size="small"
								disabled={rooms.cleanOrder.length === 0}
								onClick={onClearCleanOrder}
							>
								{I18n.t("ui_clean_order_clear")}
							</Button>
						</Stack>
					</Box>

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
