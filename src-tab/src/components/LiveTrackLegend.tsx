import React from "react";
import { Box, Stack, Typography } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";
import { LIVE_TRACK_COLORS } from "../engine/liveTrack";

interface LiveTrackLegendProps {
	/** False hides the key entirely; a key without a track on the map explains nothing. */
	present: boolean;
}

/**
 * The colour key of the live track.
 *
 * Two colours on a map are a riddle unless something names them, and naming them is the whole
 * point of this overlay: the user asked to see *where it mopped*, not just that something moved.
 *
 * The swatches take their colours from {@link LIVE_TRACK_COLORS}, the same constant the renderer
 * paints with, so the key cannot drift away from the map. They are also the reason this is not a
 * plain list of translated words: a legend whose colours were typed a second time would keep
 * looking right long after the map changed.
 */
export function LiveTrackLegend({ present }: LiveTrackLegendProps): React.JSX.Element | null {
	if (!present) return null;

	return (
		<Stack
			direction="row"
			spacing={1.5}
			alignItems="center"
			sx={{ px: 1.5, py: 1.25 }}
		>
			<Typography
				variant="caption"
				color="text.secondary"
			>
				{I18n.t("ui_live_track")}
			</Typography>
			<LegendEntry
				color={LIVE_TRACK_COLORS.driven}
				label={I18n.t("ui_live_track_driven")}
			/>
			<LegendEntry
				color={LIVE_TRACK_COLORS.mopped}
				label={I18n.t("ui_live_track_mopped")}
			/>
		</Stack>
	);
}

interface LegendEntryProps {
	color: string;
	label: string;
}

/** One swatch and its caption. The swatch carries the same dark casing the map draws. */
function LegendEntry({ color, label }: LegendEntryProps): React.JSX.Element {
	return (
		<Stack
			direction="row"
			spacing={0.75}
			alignItems="center"
		>
			<Box
				aria-hidden
				// The colour is data, not design: it comes from the renderer's own constant, so it
				// is set inline rather than through the theme's style pipeline.
				style={{ backgroundColor: color, outline: `1px solid ${LIVE_TRACK_COLORS.casing}` }}
				sx={{ width: 18, height: 5, borderRadius: 3 }}
			/>
			<Typography variant="caption">{label}</Typography>
		</Stack>
	);
}
