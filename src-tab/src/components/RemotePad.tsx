import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Collapse, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import GamepadIcon from "@mui/icons-material/Gamepad";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import RotateLeftIcon from "@mui/icons-material/RotateLeft";
import RotateRightIcon from "@mui/icons-material/RotateRight";
import NorthWestIcon from "@mui/icons-material/NorthWest";
import NorthEastIcon from "@mui/icons-material/NorthEast";
import SouthWestIcon from "@mui/icons-material/SouthWest";
import SouthEastIcon from "@mui/icons-material/SouthEast";
import { I18n } from "@iobroker/adapter-react-v5";
import { FloatingSurface } from "./FloatingSurface";
import type { RemoteDriverModel } from "../remote/remoteDriver";

interface RemotePadProps {
	remote: RemoteDriverModel;
	onStart: (confirmed?: boolean) => void;
	onCancelConfirmation: () => void;
	onPress: (direction: number) => void;
	onRelease: () => void;
	onEnd: () => void;
}

/**
 * One cell of the three by three grid.
 *
 * `direction` is the app's own `pressState` (1 forward, 2 back, 3 left, 4 right, 5-8 the diagonals);
 * a null cell is the hole in the middle.
 */
interface PadCell {
	direction: number | null;
	icon: React.JSX.Element | null;
	labelKey: string;
	fallback: string;
}

/** The pad, read left to right and top to bottom. */
const PAD_CELLS: ReadonlyArray<PadCell> = [
	{ direction: 6, icon: <NorthWestIcon fontSize="small" />, labelKey: "ui_remote_forward_left", fallback: "Forward left" },
	{ direction: 1, icon: <ArrowUpwardIcon fontSize="small" />, labelKey: "ui_remote_forward", fallback: "Forward" },
	{ direction: 8, icon: <NorthEastIcon fontSize="small" />, labelKey: "ui_remote_forward_right", fallback: "Forward right" },
	{ direction: 3, icon: <RotateLeftIcon fontSize="small" />, labelKey: "ui_remote_left", fallback: "Turn left" },
	{ direction: null, icon: null, labelKey: "", fallback: "" },
	{ direction: 4, icon: <RotateRightIcon fontSize="small" />, labelKey: "ui_remote_right", fallback: "Turn right" },
	{ direction: 5, icon: <SouthWestIcon fontSize="small" />, labelKey: "ui_remote_back_left", fallback: "Back left" },
	{ direction: 2, icon: <ArrowDownwardIcon fontSize="small" />, labelKey: "ui_remote_back", fallback: "Backward" },
	{ direction: 7, icon: <SouthEastIcon fontSize="small" />, labelKey: "ui_remote_back_right", fallback: "Back right" }
];

/**
 * Which direction a key stands for.
 *
 * Only the four cardinal keys, deliberately: a keyboard cannot express two directions at once
 * without tracking chords, and a chord that half-registers would send a diagonal the user did not
 * ask for. The diagonals stay on the pad, where a press is unambiguous.
 */
const KEY_DIRECTIONS: Readonly<Record<string, number>> = {
	ArrowUp: 1,
	ArrowDown: 2,
	ArrowLeft: 3,
	ArrowRight: 4,
	w: 1,
	s: 2,
	a: 3,
	d: 4
};

/**
 * The steering pad: it drives only while a button is held.
 *
 * ## Why every button carries four handlers
 *
 * A press has more ways to end than to begin. `onPointerUp` is the ordinary one; `onPointerCancel`
 * fires when the browser takes the pointer away (a scroll gesture, a system dialog); `onPointerLeave`
 * catches the finger sliding off the button, which produces no up on that element at all. Missing
 * any of them leaves a button that is visually released and still driving - which is the one failure
 * with real damage attached, so the handlers are deliberately redundant rather than minimal.
 *
 * `onPointerDown` also captures the pointer, so a finger that slides *between* two buttons keeps
 * belonging to the first one instead of silently starting a second direction.
 *
 * ## Why the robot is not shown while it is driven
 *
 * It is not shown here because it cannot be: the robot writes its position about every three
 * seconds (`PROJECT_STATE.md`, "Positionstakt des Geräts gemessen"), so a marker during remote
 * control would be up to three seconds behind the machine in the room. The app draws no map on its
 * remote page for exactly that reason (`_appanalysis/20-positionsquellen.md` §1.4). The map behind
 * this panel keeps doing what it always does; the panel says plainly that it is not a rear-view
 * mirror.
 */
export function RemotePad({ remote, onStart, onCancelConfirmation, onPress, onRelease, onEnd }: RemotePadProps): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	const heldKey = useRef<string | null>(null);

	const padActive = remote.active && !remote.launching;

	/**
	 * The keyboard, held down.
	 *
	 * `keydown` repeats while a key is held, so only the first one starts a press - the driver's own
	 * 400 ms timer does the repeating, and letting the auto-repeat drive it would tie the cadence to
	 * whatever the operating system happens to be set to.
	 */
	const onKeyDown = useCallback((event: KeyboardEvent) => {
		const direction = KEY_DIRECTIONS[event.key];
		if (!direction) return;
		event.preventDefault();
		if (heldKey.current === event.key) return;
		heldKey.current = event.key;
		onPress(direction);
	}, [onPress]);

	const onKeyUp = useCallback((event: KeyboardEvent) => {
		if (!KEY_DIRECTIONS[event.key]) return;
		event.preventDefault();
		heldKey.current = null;
		onRelease();
	}, [onRelease]);

	// Bound only while the pad can actually drive. A tab that listens for arrow keys when nothing is
	// running would swallow them from the rest of the page for no reason.
	useEffect(() => {
		if (!padActive || !open) {
			heldKey.current = null;
			return;
		}
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			heldKey.current = null;
		};
	}, [padActive, open, onKeyDown, onKeyUp]);

	if (!remote.supported) {
		return null;
	}

	return (
		<FloatingSurface sx={{ width: 300, maxWidth: "100%" }}>
			<Stack
				direction="row"
				alignItems="center"
				spacing={1}
				sx={{ px: 1.5, py: 1, cursor: "pointer" }}
				onClick={() => setOpen(value => !value)}
			>
				<GamepadIcon fontSize="small" />
				<Typography
					variant="subtitle2"
					sx={{ fontWeight: 700, flex: 1 }}
				>
					{I18n.t("ui_remote")}
				</Typography>
				<IconButton size="small">
					<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
				</IconButton>
			</Stack>

			<Collapse
				in={open}
				// Leaving the panel is leaving the mode: a collapsed pad cannot be released, so it
				// must not be able to keep driving either.
				onExited={() => onEnd()}
			>
				<Stack
					spacing={1.25}
					sx={{ px: 1.5, pb: 1.5 }}
				>
					<Typography
						variant="caption"
						color="text.secondary"
					>
						{I18n.t("ui_remote_hint")}
					</Typography>

					{remote.refusal ? (
						<Typography
							variant="caption"
							color="error"
						>
							{remote.refusal}
						</Typography>
					) : null}

					{remote.confirming ? (
						<Stack spacing={1}>
							<Typography variant="caption">{I18n.t("ui_remote_confirm")}</Typography>
							<Stack
								direction="row"
								spacing={1}
							>
								<Button
									size="small"
									variant="contained"
									onClick={() => onStart(true)}
								>
									{I18n.t("ui_remote_confirm_yes")}
								</Button>
								<Button
									size="small"
									onClick={onCancelConfirmation}
								>
									{I18n.t("ui_remote_confirm_no")}
								</Button>
							</Stack>
						</Stack>
					) : null}

					{!remote.active && !remote.confirming ? (
						<Button
							size="small"
							variant="contained"
							disabled={remote.busy}
							onClick={() => onStart(false)}
						>
							{I18n.t("ui_remote_start")}
						</Button>
					) : null}

					{remote.active ? (
						<>
							{remote.launching ? (
								<Typography
									variant="caption"
									color="text.secondary"
								>
									{I18n.t("ui_remote_launching").replace("%s", String(remote.launchSecondsLeft))}
								</Typography>
							) : null}

							<Box
								sx={{
									display: "grid",
									gridTemplateColumns: "repeat(3, 1fr)",
									gap: 0.75,
									// The pad is a touch surface: without this a press-and-hold on a
									// phone starts a text selection or a scroll instead of driving.
									touchAction: "none",
									userSelect: "none"
								}}
							>
								{PAD_CELLS.map((cell, index) => {
									if (cell.direction === null) {
										return <Box key={`gap-${index}`} />;
									}
									const held = remote.direction === cell.direction;
									return (
										<Tooltip
											key={cell.direction}
											title={I18n.t(cell.labelKey)}
										>
											<span>
												<IconButton
													size="small"
													aria-label={I18n.t(cell.labelKey)}
													disabled={!padActive}
													sx={{
														width: "100%",
														borderRadius: 1.5,
														border: "1px solid var(--rr-border)",
														backgroundColor: held ? "primary.main" : "transparent",
														color: held ? "primary.contrastText" : "inherit"
													}}
													onPointerDown={event => {
														event.preventDefault();
														event.currentTarget.setPointerCapture?.(event.pointerId);
														onPress(cell.direction as number);
													}}
													onPointerUp={onRelease}
													onPointerCancel={onRelease}
													onPointerLeave={onRelease}
												>
													{cell.icon}
												</IconButton>
											</span>
										</Tooltip>
									);
								})}
							</Box>

							<Button
								size="small"
								color="warning"
								variant="outlined"
								onClick={onEnd}
							>
								{I18n.t("ui_remote_end")}
							</Button>
						</>
					) : null}
				</Stack>
			</Collapse>
		</FloatingSurface>
	);
}
