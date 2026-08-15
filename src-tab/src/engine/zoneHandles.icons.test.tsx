import CloseIcon from "@mui/icons-material/Close";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import OpenWithIcon from "@mui/icons-material/OpenWith";
import RotateRightIcon from "@mui/icons-material/RotateRight";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ZONE_HANDLE_GLYPHS, ZONE_HANDLE_KINDS_ROTATABLE, type ZoneHandleKind } from "./zoneHandles";

/**
 * The zone handles draw their glyphs as path data, and this is what keeps that honest.
 *
 * The handles live inside the map's SVG, which d3 builds - a React component cannot be appended
 * there, so the three glyphs are strings in `zoneHandles.ts` rather than MUI components. That
 * buys a copy of something the tab already has, and a copy is exactly what quietly drifts: MUI
 * redraws an icon in some release, every button in the tab follows, and the three handles on the
 * map keep the old picture with nothing to notice it.
 *
 * So the components are rendered here and compared against the pinned strings. The test says
 * "these are the same icons the rest of the tab uses", and it fails on the release that changes
 * that instead of on a user's screenshot.
 *
 * The original artwork cannot be used: `_appanalysis/17-raumauswahl.md` §B.5.2 followed
 * `theme.displayZones.deleteImg` and the other five to resource indices 316-321 whose files are
 * not in the downloaded plugin. Size and position of the handles are proved, their appearance is
 * not - so it comes from the icon set the tab is already built on.
 */

/** The MUI component each glyph is a copy of. */
const SOURCE_ICONS: Record<ZoneHandleKind, () => React.ReactElement> = {
	// The X, not a waste basket: the app marks this handle with a cross on a red disc, and at the
	// size of a corner badge that reads without being recognised as a picture.
	delete: () => <CloseIcon />,
	scale: () => <OpenInFullIcon />,
	move: () => <OpenWithIcon />,
	// The circular arrow turns the way a drag to the right turns the zone, which is the only cue
	// the handle can give: the app's own `rotateImg` is not in the downloaded plugin (§B.5.2).
	rotate: () => <RotateRightIcon />,
};

describe("the pinned glyph paths", () => {
	it.each(ZONE_HANDLE_KINDS_ROTATABLE)("matches the MUI icon the %s handle is taken from", (kind) => {
		const { container } = render(SOURCE_ICONS[kind]());
		const paths = container.querySelectorAll("path");

		// A single path is what the copy assumes: a multi-path icon would need more than a string.
		expect(paths).toHaveLength(1);
		expect(paths[0].getAttribute("d")).toBe(ZONE_HANDLE_GLYPHS[kind]);
	});

	it.each(ZONE_HANDLE_KINDS_ROTATABLE)("is drawn in the 24 × 24 box the handles place it in (%s)", (kind) => {
		// `zoneHandles.ts` shifts the glyph by -12/-12 onto the centre of its group and relies on
		// the path being drawn in Material's own box for that to land right.
		const { container } = render(SOURCE_ICONS[kind]());
		expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
	});
});
