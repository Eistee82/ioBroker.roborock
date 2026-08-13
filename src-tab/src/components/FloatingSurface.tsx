import React from "react";
import { Box, type SxProps, type Theme } from "@mui/material";

interface FloatingSurfaceProps {
	children: React.ReactNode;
	sx?: SxProps<Theme>;
	className?: string;
}

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
				borderRadius: 3,
				boxShadow: "var(--rr-shadow)",
				pointerEvents: "auto",
				...sx
			}}
		>
			{children}
		</Box>
	);
}
