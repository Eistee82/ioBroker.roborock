import React from "react";
import { MenuItem, Stack, TextField } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";
import type { ModeModel } from "../engine/types";

interface ModeBarProps {
	modes: ModeModel[];
	onChange: (command: string, value: string) => void;
}

/**
 * Suction, mop and water selectors. Their options come from the command objects the device
 * handler published, so a device that does not offer a mode simply has no selector here.
 */
export function ModeBar({ modes, onChange }: ModeBarProps): React.JSX.Element | null {
	if (!modes.length) {
		return null;
	}

	return (
		<Stack
			direction="row"
			spacing={1}
			sx={{ px: 1.5, py: 1.25 }}
		>
			{modes.map(mode => (
				<TextField
					key={mode.command}
					select
					size="small"
					label={I18n.t(mode.labelKey)}
					// An unknown value must not silently pick the first option.
					value={mode.value ?? ""}
					onChange={event => onChange(mode.command, event.target.value)}
					sx={{ minWidth: 132 }}
				>
					{mode.options.map(option => (
						<MenuItem
							key={option.value}
							value={option.value}
						>
							{option.label}
						</MenuItem>
					))}
				</TextField>
			))}
		</Stack>
	);
}
