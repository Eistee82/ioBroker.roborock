import React, { useLayoutEffect, useRef, useState } from "react";
import { Box, Dialog, DialogContent } from "@mui/material";
import type { ObstaclePhotoModel } from "../engine/types";

interface ObstacleDialogProps {
	photo: ObstaclePhotoModel | null;
	onClose: () => void;
}

/**
 * The full obstacle photo, with the detection box the robot reported drawn on top.
 */
export function ObstacleDialog({ photo, onClose }: ObstacleDialogProps): React.JSX.Element {
	const imageRef = useRef<HTMLImageElement | null>(null);
	const [box, setBox] = useState<React.CSSProperties | null>(null);
	// Bumped once the image finished decoding, because only then does it have a layout size.
	const [loaded, setLoaded] = useState(0);

	// The box is reported in the source image's pixels, so it has to be rescaled to whatever
	// size the dialog gives the image. Measuring after layout keeps the two in step.
	useLayoutEffect(() => {
		const measure = (): void => {
			const image = imageRef.current;
			const bbox = photo?.bbox;
			if (!image || !bbox || !image.clientWidth || !image.clientHeight) {
				setBox(null);
				return;
			}
			const scaleX = image.clientWidth / bbox.imageWidth;
			const scaleY = image.clientHeight / bbox.imageHeight;
			setBox({
				left: bbox.x * scaleX,
				top: bbox.y * scaleY,
				width: bbox.w * scaleX,
				height: bbox.h * scaleY
			});
		};

		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [photo, loaded]);

	return (
		<Dialog
			open={!!photo}
			onClose={onClose}
			maxWidth="md"
		>
			<DialogContent sx={{ p: 1 }}>
				<Box sx={{ position: "relative", lineHeight: 0 }}>
					{photo ? (
						<img
							ref={imageRef}
							src={photo.image}
							alt=""
							onLoad={() => setLoaded(value => value + 1)}
							style={{ display: "block", maxWidth: "100%", maxHeight: "78vh", borderRadius: 10 }}
						/>
					) : null}
					{box ? (
						<Box
							sx={{
								position: "absolute",
								border: "2px solid",
								borderColor: "secondary.main",
								borderRadius: 1,
								pointerEvents: "none"
							}}
							style={box}
						/>
					) : null}
				</Box>
			</DialogContent>
		</Dialog>
	);
}
