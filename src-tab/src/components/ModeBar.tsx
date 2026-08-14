import React from "react";
import { Box, MenuItem, Stack, TextField } from "@mui/material";
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

/**
 * Suction, mop and water selectors. Their options come from the command objects the device
 * handler published, so a device that does not offer a mode simply has no selector here.
 *
 * Each option carries the Roborock app's own icon where the value is proven to belong to one
 * (see `engine/modeIcons.ts`); everything else stays text. The light or dark variant follows the
 * admin theme, and because it is read from the live theme object here, switching the admin to dark
 * mode swaps the icons on the spot rather than on the next reload.
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
			spacing={1}
			sx={{ px: 1.5, py: 1.25 }}
		>
			{modes.map(mode => {
				// The app draws the level in effect differently from the rest, and the picker assets
				// come as that very pair, so the select mirrors it instead of inventing a highlight.
				const iconFor = (value: string): string | null =>
					modeIconUrl(assetBase, mode.command, value, themeType, value === mode.value ? "selected" : "normal");
				// Only reserve room for the closed field's icon when this selector has icons at all,
				// so a device without artwork keeps the compact width it has today.
				const hasIcons = mode.options.some(option => iconFor(option.value) !== null);

				return (
					<TextField
						key={mode.command}
						select
						size="small"
						label={I18n.t(mode.labelKey)}
						// An unknown value must not silently pick the first option.
						value={mode.value ?? ""}
						onChange={event => onChange(mode.command, event.target.value)}
						// Wider with icons than without: the icon now takes 32px plus its gap, and the
						// longest label of the eleven languages ("2 Durchgänge") must still fit
						// beside it rather than being cut off.
						sx={{ minWidth: hasIcons ? 176 : 132 }}
						slotProps={{
							select: {
								// The closed field renders the same icon + label pair as the open list.
								renderValue: value => {
									const selected = mode.options.find(option => option.value === String(value));
									if (!selected) {
										return null;
									}
									return (
										<Stack
											direction="row"
											spacing={1}
											alignItems="center"
										>
											<ModeIcon
												src={iconFor(selected.value)}
												alt=""
											/>
											<Box component="span">{selected.label}</Box>
										</Stack>
									);
								}
							}
						}}
					>
						{mode.options.map(option => (
							<MenuItem
								key={option.value}
								value={option.value}
							>
								<Stack
									direction="row"
									spacing={1}
									alignItems="center"
								>
									<ModeIcon
										src={iconFor(option.value)}
										alt=""
									/>
									<Box component="span">{option.label}</Box>
								</Stack>
							</MenuItem>
						))}
					</TextField>
				);
			})}
		</Stack>
	);
}
