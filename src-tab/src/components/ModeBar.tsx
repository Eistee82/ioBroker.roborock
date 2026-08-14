import React from "react";
import { Box, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CheckIcon from "@mui/icons-material/Check";
import { I18n } from "@iobroker/adapter-react-v5";
import type { CleaningModeTabsModel, ModeModel } from "../engine/types";
import { ROUTE_COMMAND, SUCTION_COMMAND, WATER_COMMAND, cleaningModeLabelKey, cleaningModeOptions } from "../engine/cleaningModes";
import { modeIconUrl, type IconThemeType } from "../engine/modeIcons";
import { ModeIcon } from "./ModeIcon";
import { PANEL_PADDING_PX } from "./FloatingSurface";

interface ModeBarProps {
	modes: ModeModel[];
	/** The cleaning modes this robot can be switched into, and the one it is in. */
	cleaningModes: CleaningModeTabsModel;
	/**
	 * Folder the current robot's Roborock graphics live in, or null while it is unknown. Null and
	 * "the file is not there" lead to the same result: the option shows its text and no icon.
	 */
	assetBase: string | null;
	/** How often the next zoned run repeats each zone; 1 or 2, nothing else. */
	cleanCount: number;
	onChange: (command: string, value: string) => void;
	/** Switches the cleaning mode by writing one of the ready-made payloads. */
	onSelectCleaningMode: (payload: string) => void;
	onCleanCountChange: (count: number) => void;
}

/** Edge length of an icon inside the switch bar. Large enough to read the pictogram at a glance. */
const BAR_ICON_SIZE = 34;

/**
 * The rows in the order the robot's own app lists them: suction, water, passes, route.
 *
 * The adapter publishes them in a different order (`set_custom_mode`, `set_mop_mode`,
 * `set_water_box_custom_mode`), which put the route between suction and water. The passes belong
 * between water and route, so the two have to be the way round the app has them - otherwise
 * "between water and route" is not a position at all.
 *
 * A command this list does not mention keeps working and is appended; a model profile may publish
 * one, and dropping a row would take away a control that used to be there.
 */
const ROW_ORDER = [SUCTION_COMMAND, WATER_COMMAND, ROUTE_COMMAND];

/** Where the passes row goes: right before the route, as in the app. */
const PASSES_RANK = ROW_ORDER.indexOf(ROUTE_COMMAND);

/**
 * @param command Command object of one mode row.
 * @returns Its place in {@link ROW_ORDER}; unknown commands sort last.
 */
function rowRank(command: string): number {
	const index = ROW_ORDER.indexOf(command);
	return index === -1 ? ROW_ORDER.length : index;
}

interface ModeRowProps {
	/** Caption of the row, e.g. "Suction power". */
	label: string;
	/** The step in effect, shown next to the caption, or null while nothing matches. */
	valueLabel: string | null;
	children: React.ReactNode;
}

/**
 * One line of the panel: what it is, what it is set to, and the switch bar underneath.
 *
 * @param props
 */
function ModeRow({ label, valueLabel, children }: ModeRowProps): React.JSX.Element {
	return (
		<Box>
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
				{valueLabel ? (
					<Typography
						variant="caption"
						sx={{ color: "primary.main", fontWeight: 600, lineHeight: 1 }}
					>
						{valueLabel}
					</Typography>
				) : null}
			</Stack>

			{children}
		</Box>
	);
}

/**
 * Suction, water, passes and mop route, drawn the way the robot's own app draws them: a window of
 * its own in the bottom left corner, every step visible as a picture, the one in effect standing
 * out.
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
 * ## The rows are stacked, not side by side
 *
 * They used to sit next to each other across the full width of the map, so that a tall block would
 * not cover what it is meant to control. As a window in the corner that no longer applies, and
 * stacked is the arrangement the user knows from the app.
 *
 * ## The passes row is not one of the robot's commands
 *
 * `×1 / ×2` is a property of the *next zoned run*, held in the tab and sent along with the zones -
 * the robot has no state for it. So it stays even on a device that publishes no mode commands at
 * all, which is precisely where it still works: drawing a zone needs no `set_custom_mode`.
 *
 * The light or dark icon variant follows the admin theme, read from the live theme object, so
 * switching the admin to dark swaps the icons on the spot rather than on the next reload.
 */
export function ModeBar({
	modes,
	cleaningModes,
	assetBase,
	cleanCount,
	onChange,
	onSelectCleaningMode,
	onCleanCountChange,
}: ModeBarProps): React.JSX.Element {
	const theme = useTheme();
	const themeType: IconThemeType = theme.palette.mode === "dark" ? "dark" : "light";

	const { tabs, current } = cleaningModes;
	// Without a tab row nothing is filtered - a device that has no cleaning modes has no mode whose
	// rules could apply, and hiding a step on a guess takes away a control that used to work.
	const visibleModes = (
		tabs.length
			? modes
					.map(mode => ({ ...mode, options: cleaningModeOptions(current, mode.command, mode.options) }))
					.filter(mode => mode.options.length > 0)
			: modes
	)
		.slice()
		.sort((left, right) => rowRank(left.command) - rowRank(right.command));

	// A mode the robot reports but no tab stands for - Customize, for one - highlights nothing. The
	// caption still names it, so the empty row reads as "not one of these" instead of as a fault.
	const currentTab = tabs.find(tab => tab.mode === current) ?? null;
	const currentModeKey = cleaningModeLabelKey(current);

	const routeAt = visibleModes.findIndex(mode => rowRank(mode.command) >= PASSES_RANK);
	const passesAt = routeAt === -1 ? visibleModes.length : routeAt;
	const passesLabel = I18n.t("ui_repeat");
	const passesValueKey = cleanCount === 2 ? "ui_repeat_twice" : "ui_repeat_once";

	const renderMode = (mode: ModeModel): React.JSX.Element => {
		const label = I18n.t(mode.labelKey);
		const currentOption = mode.options.find(option => option.value === mode.value);

		return (
			<ModeRow
				key={mode.command}
				label={label}
				valueLabel={currentOption?.label ?? null}
			>
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
										lineHeight: 1,
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
			</ModeRow>
		);
	};

	return (
		<Stack sx={{ p: `${PANEL_PADDING_PX}px`, gap: 1.5 }}>
			{tabs.length ? (
				<ModeRow
					label={I18n.t("clean_mode_tab")}
					valueLabel={currentModeKey ? I18n.t(currentModeKey) : null}
				>
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
				</ModeRow>
			) : null}

			{visibleModes.slice(0, passesAt).map(renderMode)}

			{/* Two passes at most: the adapter command `set_clean_repeat_times` allows no more. */}
			<ModeRow
				label={passesLabel}
				valueLabel={I18n.t(passesValueKey)}
			>
				<ToggleButtonGroup
					exclusive
					size="small"
					value={String(cleanCount)}
					onChange={(_event, value) => {
						// Clicking the active count again reports null; there is no "no passes".
						if (typeof value === "string") onCleanCountChange(Number(value));
					}}
					aria-label={passesLabel}
				>
					{[1, 2].map(count => (
						<ToggleButton
							key={count}
							value={String(count)}
							// The button itself is the shortest thing that can carry a count, and "×2"
							// needs no translation. The spoken name is the full wording, so a screen
							// reader says "2 passes" rather than "times two".
							aria-label={I18n.t(count === 2 ? "ui_repeat_twice" : "ui_repeat_once")}
							sx={{ px: 1.25, py: 0.5, minWidth: BAR_ICON_SIZE + 12, textTransform: "none", lineHeight: 1 }}
						>
							<Typography
								className="rr-numeric"
								variant="body2"
								sx={{ lineHeight: 1 }}
							>
								{`×${count}`}
							</Typography>
						</ToggleButton>
					))}
				</ToggleButtonGroup>
			</ModeRow>

			{visibleModes.slice(passesAt).map(renderMode)}
		</Stack>
	);
}
