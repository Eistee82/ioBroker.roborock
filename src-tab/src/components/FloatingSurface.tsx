import React from "react";
import { Box, type SxProps, type Theme } from "@mui/material";

interface FloatingSurfaceProps {
	children: React.ReactNode;
	sx?: SxProps<Theme>;
	className?: string;
}

/**
 * Corner radius of every floating panel, in pixels.
 *
 * Spelled out in pixels on purpose. MUI's numeric `borderRadius` shorthand is a *multiple* of
 * `theme.shape.borderRadius`, and this tab raises that to 14 (`theme.ts`) - so the `borderRadius: 3`
 * that used to stand here did not mean the 12px it looks like but **42px**. That is the rounding the
 * first caption of the mode panel was running into: at 42px the straight part of the top edge only
 * begins 42px in, while the caption started 12px in.
 *
 * Panels that place content of their own against this edge keep their padding clear of it; see
 * {@link floatingContentInset}.
 */
export const FLOATING_RADIUS_PX = 18;

/**
 * The smallest padding at which content still stays inside the rounded corner.
 *
 * The top-left corner of the content box sits at `(p, p)`, the corner arc is a circle of radius `r`
 * centred at `(r, r)`. The point is inside the panel while `√2·(r − p) ≤ r`, which resolves to
 * `p ≥ r·(1 − 1/√2)`. Anything below that and the corner of the content pokes out through the round
 * edge - which is what "Saugkraft ragt in die Rundung" was.
 *
 * @param radius Corner radius the panel is drawn with.
 * @returns Minimum inner padding in pixels.
 */
export function floatingContentInset(radius: number = FLOATING_RADIUS_PX): number {
	return radius * (1 - 1 / Math.SQRT2);
}

/**
 * Padding every control panel puts between its content and this edge, in pixels.
 *
 * It clears {@link floatingContentInset} with room to spare, because the corner is only the hard
 * limit: the longest captions ("Потужність всмоктування", "Puissance d'aspiration") run right along
 * the top edge, and at the bare minimum they read as if glued to the border.
 */
export const PANEL_PADDING_PX = 16;

/**
 * The shared material of every control that floats above the map: translucent, softly
 * shadowed and rounded, so the controls and the map read as one family instead of as a page
 * with a sidebar bolted on. The surface stays plain on purpose - a texture behind the
 * controls competes with the map, which is the only thing on this page worth reading.
 */
export function FloatingSurface({ children, sx, className }: FloatingSurfaceProps): React.JSX.Element {
	return (
		<Box
			className={className}
			sx={{
				backgroundColor: "var(--rr-surface-float)",
				backdropFilter: "blur(14px)",
				border: "1px solid var(--rr-border)",
				borderRadius: `${FLOATING_RADIUS_PX}px`,
				boxShadow: "var(--rr-shadow)",
				pointerEvents: "auto",
				...sx
			}}
		>
			{children}
		</Box>
	);
}
