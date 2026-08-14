import React from "react";
import { Box, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { I18n } from "@iobroker/adapter-react-v5";
import type { ModeModel } from "../engine/types";
import { modeIconUrl, type IconThemeType } from "../engine/modeIcons";
import { ModeIcon } from "./ModeIcon";

interface ModeBarProps {
	modes: ModeModel[];
	/**
	 * Folder the current robot's Roborock graphics live in, or null while it is unknown. Null and
	 * "the file is not there" lead to the same result: the option shows its text and no icon.
	 */
	assetBase: string | null;
	onChange: (command: string, value: string) => void;
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
 * The groups sit next to each other rather than stacked, because this bar floats above the map and
 * a tall block would cover what it is meant to control. On a narrow window they wrap instead.
 *
 * The light or dark icon variant follows the admin theme, read from the live theme object, so
 * switching the admin to dark swaps the icons on the spot rather than on the next reload.
 */
export function ModeBar({ modes, assetBase, onChange }: ModeBarProps): React.JSX.Element | null {
	const theme = useTheme();
	const themeType: IconThemeType = theme.palette.mode === "dark" ? "dark" : "light";

	if (!modes.length) {
		return null;
	}

	return (
		<Stack
			direction="row"
			spacing={2.5}
			sx={{ px: 1.5, py: 1, flexWrap: "wrap", rowGap: 1.5 }}
		>
			{modes.map(mode => {
				const label = I18n.t(mode.labelKey);
				const current = mode.options.find(option => option.value === mode.value);

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
							{current ? (
								<Typography
									variant="caption"
									sx={{ color: "primary.main", fontWeight: 600, lineHeight: 1 }}
								>
									{current.label}
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
	);
}
