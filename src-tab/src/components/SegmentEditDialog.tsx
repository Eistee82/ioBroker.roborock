import React from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, ListItemText, Typography } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";

/** Which of the two segment edits is being confirmed. */
export type SegmentEditKind = "split" | "merge";

interface SegmentEditDialogProps {
	/** The pending edit, or null while nothing is being asked. */
	pending: SegmentEditKind | null;
	/** Names of the rooms the edit touches, for the sentence that says what is being changed. */
	roomNames: string[];
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * The question asked before rooms are divided or combined.
 *
 * ## Why this exists at all
 *
 * Both calls **renumber the robot's segments** (`_appanalysis/14-editor-methoden.md` section 2.2,
 * event `RoomIdDidChanged`). Everything that referred to a room by its old number then refers to a
 * different room - and the numbers are invisible, so the damage shows up as the robot cleaning the
 * wrong room rather than as an error.
 *
 * The adapter has warned about this from the start, in the log and in the `desc` of the command
 * state. Neither reaches the person pressing a button in this tab, which made the tab the one place
 * where the warning was missing and the action was easiest.
 *
 * ## Why the wording is Roborock's
 *
 * The first sentence is `map_edit_segment_prompt` - the app's own warning, in all eleven languages
 * the tab speaks. A rewrite would be a second, slightly different claim about the same firmware
 * behaviour; the app's own wording is the one the user may already know from their phone.
 *
 * ## Why it lists three things and not one
 *
 * "All related settings become invalid" is true and unhelpfully vague. The three items name what
 * that means here, and the first one is the uncomfortable one: **room-bound cleaning modes live on
 * the robot and the adapter does not have them at all** (`set_customize_clean_mode` is registered
 * nowhere). It cannot warn about them specifically, cannot save them, and cannot put them back. The
 * other two it can at least handle - the cleaning order is cleared automatically, and the room
 * switches are rebuilt - but anything the user hung on those switches themselves is theirs to fix.
 *
 * ## Why the confirm button is not the default one
 *
 * Nothing here can be undone from the tab. The dialog opens with neither button focused and the
 * confirming one is the plain, non-primary one, so a stray Enter does not divide a room.
 */
export function SegmentEditDialog({ pending, roomNames, onConfirm, onCancel }: SegmentEditDialogProps): React.JSX.Element {
	const titleKey = pending === "merge" ? "ui_map_room_merge" : "ui_map_room_split";

	return (
		<Dialog
			open={pending !== null}
			onClose={onCancel}
			maxWidth="sm"
			fullWidth
		>
			<DialogTitle>{I18n.t(titleKey)}</DialogTitle>
			<DialogContent>
				{roomNames.length ? (
					<Typography
						variant="body2"
						sx={{ mb: 2 }}
					>
						{roomNames.join(", ")}
					</Typography>
				) : null}

				{/* Roborock's own sentence, first, because it is the claim about the firmware. */}
				<Alert severity="warning">{I18n.t("ui_segment_edit_warning")}</Alert>

				<Typography
					variant="body2"
					sx={{ mt: 2 }}
				>
					{I18n.t("ui_segment_edit_intro")}
				</Typography>
				<List dense>
					<ListItem disableGutters>
						<ListItemText primary={I18n.t("ui_segment_edit_loses_modes")} />
					</ListItem>
					<ListItem disableGutters>
						<ListItemText primary={I18n.t("ui_segment_edit_loses_sequence")} />
					</ListItem>
					<ListItem disableGutters>
						<ListItemText primary={I18n.t("ui_segment_edit_loses_switches")} />
					</ListItem>
				</List>
			</DialogContent>
			<DialogActions>
				{/*
				 * Cancel is the prominent one. Dividing a room cannot be undone from here, and the
				 * safe choice should be the one the hand reaches for.
				 */}
				<Button
					variant="contained"
					onClick={onCancel}
				>
					{I18n.t("ui_cancel")}
				</Button>
				<Button
					color="warning"
					onClick={onConfirm}
				>
					{I18n.t(titleKey)}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
