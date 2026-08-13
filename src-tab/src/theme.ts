import { createTheme } from "@mui/material/styles";
import type { IobTheme } from "@iobroker/adapter-react-v5";

/**
 * Colours taken from the Roborock app assets, so map and controls read as one family.
 *
 * `MAP_BLUE` and `TURQUOISE` are the two tints of the app's own map themes
 * (`map_bg_1_light` / `map_bg_3_light`); `ACCENT` is the blue the adapter already draws with.
 */
export const ROBOROCK_COLORS = {
	/** Map ground of the app's light theme. */
	mapBlue: "#a9c9f0",
	/** Second map tint of the app; used for "everything is fine" accents. */
	turquoise: "#2ec4c0",
	/** The accent the adapter has been drawing with all along. */
	accent: "#2d9cdb",
	accentDark: "#1f7fb5",
	warning: "#f2a63b",
	error: "#e5544b",
} as const;

/**
 * Layers the Roborock palette onto the theme the admin handed us.
 *
 * The admin decides light or dark; this only replaces the colours that carry the product's
 * identity and leaves everything else - including `palette.mode` - untouched, so a switch to
 * dark mode keeps working.
 *
 * @param base Theme provided by `GenericApp`.
 */
export function createRoborockTheme(base: IobTheme): IobTheme {
	const dark = base.palette.mode === "dark";

	// Neutrals carry a slight blue bias instead of pure grey, matching the map ground.
	const surface = dark ? "#141d2b" : "#ffffff";
	const surfaceSunken = dark ? "#0d1420" : "#eef3fa";

	return createTheme(base, {
		palette: {
			primary: { main: ROBOROCK_COLORS.accent, dark: ROBOROCK_COLORS.accentDark, contrastText: "#ffffff" },
			secondary: { main: ROBOROCK_COLORS.turquoise, contrastText: "#03302f" },
			error: { main: ROBOROCK_COLORS.error },
			warning: { main: ROBOROCK_COLORS.warning },
			background: { default: surfaceSunken, paper: surface },
		},
		shape: { borderRadius: 14 },
		typography: {
			fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
			button: { textTransform: "none", fontWeight: 600 },
		},
		components: {
			MuiButton: { defaultProps: { disableElevation: true } },
			MuiTooltip: { defaultProps: { arrow: true } },
		},
	}) as IobTheme;
}

/**
 * CSS custom properties the imperative map surface and the floating panels read.
 *
 * Keeping them in one place means the engine's SVG never hard-codes a colour and therefore
 * follows the admin's light/dark choice without a second theme of its own.
 *
 * @param theme The already Roborock-tinted theme.
 */
export function themeCssVariables(theme: IobTheme): Record<string, string> {
	const dark = theme.palette.mode === "dark";
	return {
		"--rr-accent": ROBOROCK_COLORS.accent,
		"--rr-turquoise": ROBOROCK_COLORS.turquoise,
		"--rr-map-blue": ROBOROCK_COLORS.mapBlue,
		"--rr-error": ROBOROCK_COLORS.error,
		"--rr-text": theme.palette.text.primary,
		"--rr-text-dim": theme.palette.text.secondary,
		"--rr-surface": theme.palette.background.paper,
		// The floating controls sit on top of the map, so they need a translucent ground.
		"--rr-surface-float": dark ? "rgba(20, 29, 43, 0.86)" : "rgba(255, 255, 255, 0.86)",
		"--rr-map-ground": dark ? "#0b111b" : "#dfe9f7",
		"--rr-border": dark ? "rgba(169, 201, 240, 0.18)" : "rgba(45, 156, 219, 0.22)",
		// The fine grid of the app's map themes, used as a very quiet texture.
		"--rr-grid": dark ? "rgba(169, 201, 240, 0.07)" : "rgba(45, 156, 219, 0.07)",
		"--rr-shadow": dark ? "0 10px 30px rgba(0, 0, 0, 0.55)" : "0 10px 30px rgba(31, 71, 112, 0.16)",
	};
}
