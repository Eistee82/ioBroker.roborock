import React from "react";
import { Box, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CheckIcon from "@mui/icons-material/Check";
import { I18n } from "@iobroker/adapter-react-v5";
import type { CleaningModeTabsModel, ModeModel } from "../engine/types";
import { cleaningModeLabelKey, cleaningModeOptions } from "../engine/cleaningModes";
import { modeIconUrl, type IconThemeType } from "../engine/modeIcons";
import { ModeIcon } from "./ModeIcon";

interface ModeBarProps {
	modes: ModeModel[];
	/** The cleaning modes this robot can be switched into, and the one it is in. */
	cleaningModes: CleaningModeTabsModel;
	/**
	 * Folder the current robot's Roborock graphics live in, or null while it is unknown. Null and
	 * "the file is not there" lead to the same result: the option shows its text and no icon.
	 */
	assetBase: string | null;
	onChange: (command: string, value: string) => void;
	/** Switches the cleaning mode by writing one of the ready-made payloads. */
	onSelectCleaningMode: (payload: string) => void;
}

/** Edge length of an icon inside the switch bar. Large enough to read the pictogram at a glance. */
const BAR_ICON_SIZE = 34;

/**
 * Suction, mop route and water level, drawn the way the robot's own app draws them: every step
 * visible side by side as a picture, with the one in effect standing out.
 *
 * They used to be dropdowns with a 20px icon, which hid the choice behind a click and shrank the
 * pictogram to a speck - although these settings are picked *by* their picture. Showing all steps
 * at once also makes it obvious how many there are, which differs per robot and, in the app, per
 * cleaning mode.
 *
 * ## The row on top is the cleaning mode, and it governs the rows below it
 *
 * The app puts a tab bar above these steps - Vac & Mop, Mop, Vacuum - and changes the steps with it:
 * mop-only shows no suction at all, vacuum-only shows no water and hides MAX+ nowhere else, and only
 * mop-only offers the thorough routes. That is not decoration. `fan_power = 105` *is* mop-only and
 * `water_box_mode = 200` *is* vacuum-only, so a bar that offered every value on every mode would
 * hand the user two ways of switching the mode, one of them looking like a level. Which values a
 * mode may show is in `engine/cleaningModes.ts`, quoted from the decompiled control plugin.
 *
 * A robot the adapter published no modes for keeps exactly the view it had: no tab row, no filtering
 * of the steps. One tab that switches nothing would be worse than none.
 *
 * The groups sit next to each other rather than stacked, because this bar floats above the map and
 * a tall block would cover what it is meant to control. On a narrow window they wrap instead.
 *
 * The light or dark icon variant follows the admin theme, read from the live theme object, so
 * switching the admin to dark swaps the icons on the spot rather than on the next reload.
 */
export function ModeBar({ modes, cleaningModes, assetBase, onChange, onSelectCleaningMode }: ModeBarProps): React.JSX.Element | null {
	const theme = useTheme();
	const themeType: IconThemeType = theme.palette.mode === "dark" ? "dark" : "light";

	const { tabs, current } = cleaningModes;
	// Without a tab row nothing is filtered - a device that has no cleaning modes has no mode whose
	// rules could apply, and hiding a step on a guess takes away a control that used to work.
	const visibleModes = tabs.length
		? modes
			.map(mode => ({ ...mode, options: cleaningModeOptions(current, mode.command, mode.options) }))
			.filter(mode => mode.options.length > 0)
		: modes;

	if (!tabs.length && !visibleModes.length) {
		return null;
	}

	// A mode the robot reports but no tab stands for - Customize, for one - highlights nothing. The
	// caption still names it, so the empty row reads as "not one of these" instead of as a fault.
	const currentTab = tabs.find(tab => tab.mode === current) ?? null;
	const currentModeKey = cleaningModeLabelKey(current);

	return (
		<Stack sx={{ px: 1.5, py: 1 }}>
			{tabs.length ? (
				<Box sx={{ mb: 1.5 }}>
					<Stack
						direction="row"
						spacing={0.75}
						alignItems="baseline"
						sx={{ mb: 0.5, minHeight: 20 }}
					>
						{/* The adapter's own caption for the derived state, so both name it alike. */}
						<Typography
							variant="caption"
							sx={{ color: "text.secondary", lineHeight: 1 }}
						>
							{I18n.t("clean_mode_tab")}
						</Typography>
						{currentModeKey ? (
							<Typography
								variant="caption"
								sx={{ color: "primary.main", fontWeight: 600, lineHeight: 1 }}
							>
								{I18n.t(currentModeKey)}
							</Typography>
						) : null}
					</Stack>

					<ToggleButtonGroup
						exclusive
						size="small"
						value={currentTab ? String(currentTab.mode) : null}
						onChange={(_event, value) => {
							// Null arrives when the active tab is clicked again; the robot is in that
							// mode already, so re-sending the triple would be a command for nothing.
							if (typeof value !== "string") return;
							const tab = tabs.find(entry => String(entry.mode) === value);
							if (tab) onSelectCleaningMode(tab.payload);
						}}
						aria-label={I18n.t("clean_mode_tab")}
					>
						{tabs.map(tab => {
							const label = I18n.t(tab.labelKey);
							const selected = currentTab?.mode === tab.mode;

							return (
								<ToggleButton
									key={tab.mode}
									value={String(tab.mode)}
									aria-label={label}
									sx={{ px: 1.25, py: 0.5, textTransform: "none", lineHeight: 1, gap: 0.5 }}
								>
									{/* The app marks the active tab with a tick; the highlight alone is
									    easy to miss on a bar that floats above a coloured map. */}
									{selected ? <CheckIcon sx={{ fontSize: 16 }} /> : null}
									<Typography
										variant="body2"
										sx={{ lineHeight: 1 }}
									>
										{label}
									</Typography>
								</ToggleButton>
							);
						})}
					</ToggleButtonGroup>
				</Box>
			) : null}

			<Stack
				direction="row"
				spacing={2.5}
				sx={{ flexWrap: "wrap", rowGap: 1.5 }}
			>
				{visibleModes.map(mode => {
					const label = I18n.t(mode.labelKey);
					const currentOption = mode.options.find(option => option.value === mode.value);

					return (
						<Box key={mode.command}>
							{/* Name and the step in effect, as in the app: the value is what one looks for. */}
							<Stack
								direction="row"
								spacing={0.75}
								alignItems="baseline"
								sx={{ mb: 0.5, minHeight: 20 }}
							>
								<Typography
									variant="caption"
									sx={{ color: "text.secondary", lineHeight: 1 }}
								>
									{label}
								</Typography>
								{currentOption ? (
									<Typography
										variant="caption"
										sx={{ color: "primary.main", fontWeight: 600, lineHeight: 1 }}
									>
										{currentOption.label}
									</Typography>
								) : null}
							</Stack>

							<ToggleButtonGroup
								exclusive
								size="small"
								// An unknown value must not light up the first step as if it were selected.
								value={mode.value ?? null}
								onChange={(_event, value) => {
									// Null arrives when the active button is clicked again; the robot has no
									// "no mode", so that is a no-op rather than a command.
									if (typeof value === "string") onChange(mode.command, value);
								}}
								aria-label={label}
							>
								{mode.options.map(option => {
									const selected = option.value === mode.value;
									const icon = modeIconUrl(assetBase, mode.command, option.value, themeType, selected ? "selected" : "normal");

									return (
										<Tooltip
											key={option.value}
											title={option.label}
										>
											<ToggleButton
												value={option.value}
												aria-label={option.label}
												sx={{
													px: icon ? 0.75 : 1.25,
													py: 0.5,
													// Without an icon the text carries the meaning and needs room;
													// with one, a square keeps the row of pictograms even.
													minWidth: icon ? BAR_ICON_SIZE + 12 : 0,
													textTransform: "none",
													lineHeight: 1
												}}
											>
												{icon ? (
													<ModeIcon
														src={icon}
														size={BAR_ICON_SIZE}
														alt={option.label}
													/>
												) : (
													<Typography
														variant="body2"
														sx={{ lineHeight: 1 }}
													>
														{option.label}
													</Typography>
												)}
											</ToggleButton>
										</Tooltip>
									);
								})}
							</ToggleButtonGroup>
						</Box>
					);
				})}
			</Stack>
		</Stack>
	);
}
