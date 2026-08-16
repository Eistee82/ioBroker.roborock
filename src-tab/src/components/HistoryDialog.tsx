import React, { useEffect, useState } from "react";
import { Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { I18n } from "@iobroker/adapter-react-v5";
import { CLEAN_TYPE_LABEL_KEYS, resolveFinishReasonKey } from "../history/cleaningHistory";
import { formatFieldValue, formatMeasure, formatRunStart } from "../history/historyFormat";
import type { CleaningRunModel } from "../history/historyTypes";
import type { MapColorScheme } from "../engine/mapOverlayColors";

interface HistoryDialogProps {
	/** Run to show, or null to keep the dialog closed. */
	run: CleaningRunModel | null;
	/** Admin language, for dates, numbers and units. */
	language: string;
	/**
	 * Scheme the **adapter** painted the stored map in, which is not the tab's own theme.
	 * See `engine/mapOverlayColors.ts`; here it only decides the backing behind the picture.
	 */
	mapColorScheme: MapColorScheme;
	/** Fetches the image on demand; the list never carries it. */
	loadMap: (stateId: string) => Promise<string | null>;
	/**
	 * Whether this robot published the delete command; absent means it cannot, not "not yet".
	 * The button is hidden rather than greyed for that reason - see `SchedulesPanel` for the same
	 * decision, and `history/cleaningHistory.ts` for where the answer comes from.
	 */
	canDelete: boolean;
	/** Deletes the run on the robot. Only ever called with a run that has a start timestamp. */
	onDelete: (startedAt: number) => void;
	onClose: () => void;
}

/** One labelled value of the detail list. */
function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
	return (
		<Stack
			direction="row"
			justifyContent="space-between"
			spacing={2}
			sx={{ py: 0.25 }}
		>
			<Typography
				variant="caption"
				color="text.secondary"
				sx={{ overflowWrap: "anywhere" }}
			>
				{label}
			</Typography>
			<Typography
				variant="caption"
				className="rr-numeric"
				sx={{ fontWeight: 600, textAlign: "right" }}
			>
				{value}
			</Typography>
		</Stack>
	);
}

/**
 * One recorded run in full: its map, its measured values and everything else the device published.
 *
 * The map is the part no other Roborock integration offers. The adapter has been rendering it all
 * along - `V1MapService.getCleaningRecordMap()` fetches `get_clean_record_map`, unzips it, parses
 * it with `isHistoryMap: true` and paints a PNG - and until now nothing displayed the result.
 *
 * It is fetched when the dialog opens rather than with the list, because twenty runs of a few
 * hundred kilobytes each would be several megabytes for a list of twenty lines.
 */
export function HistoryDialog({ run, language, mapColorScheme, loadMap, canDelete, onDelete, onClose }: HistoryDialogProps): React.JSX.Element {
	const [image, setImage] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	/**
	 * Whether the second, confirming press is the one that counts.
	 *
	 * A deleted run is gone from the robot for good - the adapter cannot write one back - so this
	 * asks first, the same two-step the schedule list uses. Reset whenever the dialog changes runs,
	 * because a pending confirmation belongs to the run it was armed on and to no other.
	 */
	const [confirming, setConfirming] = useState(false);

	useEffect(() => {
		setConfirming(false);
	}, [run]);

	useEffect(() => {
		const stateId = run?.mapStateId ?? null;
		setImage(null);
		if (!stateId) {
			setLoading(false);
			return;
		}

		// Guards against the answer of a run the user has already navigated away from.
		let current = true;
		setLoading(true);
		void loadMap(stateId)
			.then(value => {
				if (current) setImage(value);
			})
			.catch(() => {
				if (current) setImage(null);
			})
			.finally(() => {
				if (current) setLoading(false);
			});

		return () => {
			current = false;
		};
	}, [run, loadMap]);

	const started = run ? formatRunStart(run.startedAt, language) : null;
	const duration = run ? formatMeasure(run.duration, language) : null;
	const area = run ? formatMeasure(run.area, language) : null;
	const typeKey = run?.cleanType !== null && run?.cleanType !== undefined ? CLEAN_TYPE_LABEL_KEYS[run.cleanType] : undefined;
	const reasonKey = run ? resolveFinishReasonKey(run.finishReason, run.finished) : null;

	return (
		<Dialog
			open={!!run}
			onClose={onClose}
			maxWidth="sm"
			fullWidth
		>
			<DialogTitle sx={{ pb: 1 }}>
				<Stack
					direction="row"
					alignItems="center"
					spacing={1.5}
					flexWrap="wrap"
					useFlexGap
				>
					<Typography
						variant="subtitle1"
						sx={{ fontWeight: 700 }}
					>
						{started ?? I18n.t("ui_history_details")}
					</Typography>
					{run?.finished !== null && run?.finished !== undefined ? (
						<Chip
							size="small"
							color={run.finished ? "success" : "warning"}
							variant="outlined"
							label={I18n.t(run.finished ? "ui_history_result_finished" : "ui_history_result_interrupted")}
						/>
					) : null}
				</Stack>
			</DialogTitle>

			<DialogContent sx={{ pb: 2.5 }}>
				<Box
					sx={{
						// The picture carries the adapter's own light/dark decision, so the frame
						// behind it follows that and not the admin theme - otherwise a dark map
						// sits on a white card in a light admin, and the other way round.
						backgroundColor: mapColorScheme === "dark" ? "#1a1a1a" : "#f2f2f2",
						borderRadius: 2,
						minHeight: 140,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						p: 1,
						mb: 2,
					}}
				>
					{loading ? (
						<CircularProgress size={24} />
					) : image ? (
						<img
							src={image}
							alt=""
							style={{ display: "block", maxWidth: "100%", maxHeight: "52vh", borderRadius: 8 }}
						/>
					) : (
						<Typography
							variant="caption"
							color="text.secondary"
							sx={{ textAlign: "center", px: 2 }}
						>
							{I18n.t("ui_history_no_map")}
						</Typography>
					)}
				</Box>

				<Stack spacing={0.25}>
					{started ? (
						<DetailRow
							label={I18n.t("ui_history_started")}
							value={started}
						/>
					) : null}
					{duration ? (
						<DetailRow
							label={I18n.t("ui_duration")}
							value={duration}
						/>
					) : null}
					{area ? (
						<DetailRow
							label={I18n.t("ui_area")}
							value={area}
						/>
					) : null}
					{run?.cleanType !== null && run?.cleanType !== undefined ? (
						<DetailRow
							label={I18n.t("ui_history_type")}
							value={typeKey ? I18n.t(typeKey) : String(run.cleanType)}
						/>
					) : null}
					{reasonKey ? (
						<DetailRow
							label={I18n.t("ui_history_result")}
							value={I18n.t(reasonKey)}
						/>
					) : null}
					{run?.washCount !== null && run?.washCount !== undefined ? (
						<DetailRow
							label={I18n.t("ui_history_mop_washes")}
							value={formatFieldValue(run.washCount, "", language)}
						/>
					) : null}
				</Stack>

				{/*
				 * Everything the device published that this tab has no proven meaning for. Shown
				 * with the object's own name and unit rather than dropped: a B01 record carries
				 * fields no analysis has covered yet, and hiding them would hide data the user
				 * already has in the object tree.
				 */}
				{run?.extras.length ? (
					<>
						<Divider sx={{ my: 1.5 }} />
						<Typography
							variant="overline"
							color="text.secondary"
							sx={{ lineHeight: 1.6, letterSpacing: ".08em" }}
						>
							{I18n.t("ui_history_more_values")}
						</Typography>
						<Stack sx={{ mt: 0.5 }}>
							{run.extras.map(field => (
								<DetailRow
									key={field.key}
									label={field.name}
									value={formatFieldValue(field.value, field.unit, language)}
								/>
							))}
						</Stack>
					</>
				) : null}
			</DialogContent>

			{/*
			  * Offered only for a run that has a start timestamp, because that timestamp *is* the
			  * argument - `del_clean_record` names the run by when it began and by nothing else.
			  */}
			{canDelete && run?.startedAt ? (
				<DialogActions sx={{ px: 3, pb: 2, pt: 0, justifyContent: "flex-start" }}>
					{confirming ? (
						<Stack
							direction="row"
							spacing={1}
							alignItems="center"
							flexWrap="wrap"
							useFlexGap
						>
							<Typography
								variant="caption"
								color="text.secondary"
							>
								{I18n.t("ui_history_delete_confirm")}
							</Typography>
							<Button
								size="small"
								color="error"
								variant="contained"
								onClick={() => {
									setConfirming(false);
									onDelete(run.startedAt as number);
								}}
							>
								{I18n.t("ui_history_delete_yes")}
							</Button>
							<Button
								size="small"
								onClick={() => setConfirming(false)}
							>
								{I18n.t("ui_cancel")}
							</Button>
						</Stack>
					) : (
						<Button
							size="small"
							color="error"
							startIcon={<DeleteOutlineIcon />}
							onClick={() => setConfirming(true)}
						>
							{I18n.t("ui_history_delete")}
						</Button>
					)}
				</DialogActions>
			) : null}
		</Dialog>
	);
}
