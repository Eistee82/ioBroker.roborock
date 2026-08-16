import React, { useState } from "react";
import { Box, Chip, Collapse, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import BookmarksIcon from "@mui/icons-material/Bookmarks";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import { ModeIcon } from "./ModeIcon";
import { sceneModeIconUrl } from "../engine/modeIcons";
import type { IconThemeType } from "../engine/modeIcons";
import { presetLevelLabel, presetModeLabels, presetTarget } from "../scenes/presetLabels";
import type { ScenePresetModel } from "../scenes/presetSource";
import type { ModeModel, RoomListModel } from "../engine/types";

/** Command objects the two levels are labelled from; the same ones the mode bar is built from. */
const SUCTION_COMMAND = "set_custom_mode";
const WATER_COMMAND = "set_water_box_custom_mode";

interface PresetsPanelProps {
	/** The programs of this robot, and why there may be none. */
	presets: ScenePresetModel;
	/** The rooms of the loaded map, so a segment id can be shown as a name. */
	rooms: RoomListModel;
	/** The mode selectors, so a suction value can be shown as the robot's own label. */
	modes: ModeModel[];
	/** Folder of the Roborock graphics, or null when there are none. */
	assetBase: string | null;
	/** Light or dark, as the admin decided. */
	themeType: IconThemeType;
	/** Runs one program. */
	onStart: (sceneId: string) => void;
}

/**
 * The saved programs of the robot - the tiles the Roborock app shows above its map.
 *
 * ## What these are
 *
 * **Scenes**, held in the Roborock account. Established from both ends in
 * `_appanalysis/32-presets.md` §1: the cloud lists them with their names and their full payload, and
 * the robot's own `get_scenes_valid_tids` answers with exactly the matching identifiers and targets.
 * The two other candidates - mop templates and custom cleaning modes - are ruled out on the measured
 * device, which answers `unknown_method` to the first and `[]` to the second.
 *
 * ## Why the panel appears with nothing in it, once
 *
 * Every other panel on this page hides itself when it has nothing to show, and this one does too -
 * with a single exception. A program's **name lives only in the account**; the robot knows a `tid`
 * and a geometry. So an instance running cloud-free has no programs and never will, and an empty
 * panel would say "you have none" where the truth is "they cannot be read from here". In that one
 * case the panel appears in order to say the sentence. See `scenes/presetSource.ts`.
 *
 * ## What it deliberately does not do
 *
 * **It does not create, rename, edit or delete a program.** Two of those are established and two are
 * not, and the two that are still do not add up to a complete control:
 *
 * - The **device** side of a program is readable and writable - `set_scenes_segments` /
 *   `set_scenes_zones`, payload `{data:[{tid, segs|zones}]}`, with the robot returning the `tid` it
 *   assigned (`_appanalysis/32-presets.md` §6.1). But the `range` of a zone is taken from the app's
 *   own map view and its format is **not** established. Writing a guessed rectangle would move a
 *   zone the user drew.
 * - The **name** is not on the device at all. Creating or renaming a program means writing a cloud
 *   scene, and the endpoint for that has not been read - only reading (`user/scene/home/<id>`) and
 *   executing (`user/scene/<id>/execute`) are known.
 *
 * A partial editor would therefore be able to change a program's geometry but not its name, and only
 * for zones whose format it would have to invent. That is not a smaller version of the feature; it
 * is a control that damages what it touches. The button that **is** here - start - runs a program
 * exactly as the app does.
 */
export function PresetsPanel({ presets, rooms, modes, assetBase, themeType, onStart }: PresetsPanelProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);

	// Nothing published and no reason to explain: no panel, the rule this page follows everywhere.
	if (!presets.cloudRequired && (!presets.published || presets.presets.length === 0)) return null;

	const roomNames = new Map<number, string>();
	for (const room of rooms.rooms) roomNames.set(room.segmentId, room.name);

	const t = (key: string): string => I18n.t(key);

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<BookmarksIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_presets")}
				</Typography>
				<Chip
					size="small"
					label={<span className="rr-numeric">{presets.presets.length}</span>}
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
					 * Said once, at the top, rather than as a disabled button per row: this panel never
					 * creates, renames or edits a program. Somebody who came looking for that would
					 * otherwise conclude the adapter forgot it - see the component comment for why it is
					 * absent and what exactly is missing.
					 */}
					<Typography
						variant="caption"
						color="text.secondary"
					>
						{presets.cloudRequired ? I18n.t("ui_presets_cloud_required") : I18n.t("ui_presets_hint")}
					</Typography>

					{presets.presets.map(entry => {
						const label = entry.name ?? I18n.t("ui_preset_unnamed").replace("%s", entry.id);
						const target = presetTarget(entry, roomNames, t);
						const suction = presetLevelLabel(modes, SUCTION_COMMAND, entry.steps[0]?.fanPower ?? null);
						const water = presetLevelLabel(modes, WATER_COMMAND, entry.steps[0]?.waterBoxMode ?? null);
						const levels = [suction, water].filter((value): value is string => value !== null).join(" · ");
						const modeLabels = presetModeLabels(entry, t);

						return (
							<Stack
								key={entry.id}
								direction="row"
								alignItems="flex-start"
								spacing={1}
							>
								{/*
								 * One icon per mode the program uses, in the order it uses them. A two-step
								 * program that vacuums and then mops therefore shows two - collapsing them
								 * into one would name a mode the program does not have.
								 *
								 * Each may render as nothing: the graphics are downloaded per account and a
								 * purely local install has none. The caption below carries the mode in words
								 * for exactly that case, so the row never loses the information.
								 */}
								<Stack
									direction="row"
									spacing={0.25}
									sx={{ pt: 0.25 }}
								>
									{modeLabels.map(item => (
										<ModeIcon
											key={item.mode}
											src={sceneModeIconUrl(assetBase, item.mode, themeType)}
											size={24}
											alt={item.label}
										/>
									))}
								</Stack>

								<Box sx={{ flex: 1, minWidth: 0 }}>
									<Stack
										direction="row"
										alignItems="center"
										spacing={0.5}
									>
										<Typography
											variant="body2"
											sx={{ overflowWrap: "anywhere", fontWeight: 600 }}
										>
											{label}
										</Typography>
										{/*
										 * Only `false` warns. `valid` is null whenever the robot was not asked
										 * or did not answer, and putting a warning on that would mark every
										 * program of every device whose firmware lacks the getter.
										 */}
										{entry.valid === false ? (
											<Tooltip title={I18n.t("ui_preset_stale_hint")}>
												<WarningAmberIcon
													color="warning"
													sx={{ fontSize: 16 }}
													aria-label={I18n.t("ui_preset_stale_hint")}
												/>
											</Tooltip>
										) : null}
									</Stack>

									{target ? (
										<Typography
											variant="caption"
											color="text.secondary"
											sx={{ display: "block", overflowWrap: "anywhere" }}
										>
											{target}
										</Typography>
									) : null}

									<Typography
										variant="caption"
										color="text.secondary"
										sx={{ display: "block" }}
									>
										{[modeLabels.map(item => item.label).join(" → "), levels].filter(value => value !== "").join(" · ")}
									</Typography>

									{/*
									 * A program switched off in the app is still listed and can still be
									 * started from here - `do_scenes_*` does not consult the flag. Saying so
									 * is better than hiding the row, which would make a program the user can
									 * see in the app disappear here without explanation.
									 */}
									{!entry.enabled ? (
										<Typography
											variant="caption"
											color="text.secondary"
											sx={{ display: "block", fontStyle: "italic" }}
										>
											{I18n.t("ui_preset_disabled")}
										</Typography>
									) : null}
								</Box>

								<Tooltip title={I18n.t("ui_preset_start")}>
									<IconButton
										size="small"
										sx={{ mr: -0.5 }}
										aria-label={`${I18n.t("ui_preset_start")}: ${label}`}
										onClick={() => onStart(entry.id)}
									>
										<PlayArrowIcon fontSize="small" />
									</IconButton>
								</Tooltip>
							</Stack>
						);
					})}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
