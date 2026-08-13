import React, { useEffect, useState } from "react";
import { Box } from "@mui/material";

/**
 * One Roborock mode icon - or nothing at all.
 *
 * The graphics come from the ioBroker file store, where they only exist if the adapter ever ran
 * against a cloud account and unpacked the device control plugin. A purely local installation may
 * have none of them, and a model may ship a different subset than the next one. So the image is
 * **verified before it is rendered**: an off-DOM `Image` loads the URL first and the `<img>` is
 * only mounted once that succeeded. A missing file therefore produces no element at all, instead
 * of the browser's broken-image glyph or a blank gap where the label should be - the exact failure
 * the obstacle icons showed before they were given the same treatment.
 *
 * Results are cached per URL for the lifetime of the page, so scrolling a select list open and
 * shut does not re-request anything.
 */

/** URL -> settled result, or the in-flight probe so parallel callers share one request. */
const probeCache = new Map<string, boolean | Promise<boolean>>();

/**
 * Loads a URL off-DOM to find out whether it exists.
 *
 * @param url Image to check.
 * @returns True once the image decoded, false on any failure.
 */
function probe(url: string): boolean | Promise<boolean> {
	const cached = probeCache.get(url);
	if (cached !== undefined) {
		return cached;
	}
	const pending = new Promise<boolean>(resolve => {
		const image = new Image();
		image.onload = () => resolve(true);
		image.onerror = () => resolve(false);
		image.src = url;
	}).then(ok => {
		probeCache.set(url, ok);
		return ok;
	});
	probeCache.set(url, pending);
	return pending;
}

interface ModeIconProps {
	/** Icon URL, or null when no icon is known for this value. */
	src: string | null;
	/** Edge length in pixels. */
	size?: number;
	/** Read by assistive technology; the visible label always stays next to the icon. */
	alt?: string;
}

export function ModeIcon({ src, size = 20, alt = "" }: ModeIconProps): React.JSX.Element | null {
	// Starting from the cache keeps an already known icon from flickering on re-render.
	const [ready, setReady] = useState<string | null>(() => (src && probeCache.get(src) === true ? src : null));

	useEffect(() => {
		if (!src) {
			setReady(null);
			return;
		}
		const result = probe(src);
		if (typeof result === "boolean") {
			setReady(result ? src : null);
			return;
		}
		// The theme can switch while a probe is running, so a late answer for the previous URL
		// must not put that icon back on screen.
		let active = true;
		setReady(probeCache.get(src) === true ? src : null);
		void result.then(ok => {
			if (active) {
				setReady(ok ? src : null);
			}
		});
		return () => {
			active = false;
		};
	}, [src]);

	if (!ready) {
		return null;
	}

	return (
		<Box
			component="img"
			src={ready}
			alt={alt}
			sx={{
				width: size,
				height: size,
				flexShrink: 0,
				objectFit: "contain",
				display: "block"
			}}
		/>
	);
}
