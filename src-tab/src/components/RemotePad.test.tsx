import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RemotePad } from "./RemotePad";
import { EMPTY_REMOTE } from "../remote/remoteDriver";
import type { RemoteDriverModel } from "../remote/remoteDriver";

/**
 * The steering pad.
 *
 * The repeat timer and everything that ends a press live in `remote/remoteDriver.ts` and are pinned
 * there. What this file is about is the wiring in between - that a button really reports its press
 * and, above all, that it reports its **release** through every route a release can take. A button
 * that reads as released and never calls `onRelease` is a robot that keeps driving.
 */

function model(over: Partial<RemoteDriverModel> = {}): RemoteDriverModel {
	return { ...EMPTY_REMOTE, supported: true, ...over };
}

function renderPad(over: Partial<RemoteDriverModel> = {}) {
	const handlers = {
		onStart: vi.fn(),
		onCancelConfirmation: vi.fn(),
		onPress: vi.fn(),
		onRelease: vi.fn(),
		onEnd: vi.fn()
	};
	const result = render(
		<RemotePad
			remote={model(over)}
			{...handlers}
		/>
	);
	return { ...result, ...handlers };
}

/** Opens the collapsed panel by clicking its header. */
function openPanel(): void {
	fireEvent.click(screen.getByText("Remote control"));
}

describe("RemotePad", () => {
	it("is not rendered at all for a robot that cannot be driven", () => {
		const { container } = render(
			<RemotePad
				remote={model({ supported: false })}
				onStart={vi.fn()}
				onCancelConfirmation={vi.fn()}
				onPress={vi.fn()}
				onRelease={vi.fn()}
				onEnd={vi.fn()}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it("offers the start button while no session is open", () => {
		const { onStart } = renderPad();
		openPanel();

		fireEvent.click(screen.getByText("Start remote control"));
		expect(onStart).toHaveBeenCalledWith(false);
	});

	it("asks before interrupting a running job and only then starts", () => {
		const { onStart, onCancelConfirmation } = renderPad({ confirming: true });
		openPanel();

		expect(screen.getByText("Starting \"Remote Control\" will pause the current clean")).toBeTruthy();
		fireEvent.click(screen.getByText("OK"));
		expect(onStart).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByText("Cancel"));
		expect(onCancelConfirmation).toHaveBeenCalled();
	});

	it("shows why the robot refuses, instead of a button that would do nothing", () => {
		renderPad({ refusal: "Update in progress." });
		openPanel();

		expect(screen.getByText("Update in progress.")).toBeTruthy();
	});

	it("keeps the pad disabled during the six second run-up", () => {
		renderPad({ active: true, launching: true, launchSecondsLeft: 4 });
		openPanel();

		expect((screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("reports a press and its release", () => {
		const { onPress, onRelease } = renderPad({ active: true });
		openPanel();

		const forward = screen.getByRole("button", { name: "Forward" });
		fireEvent.pointerDown(forward);
		expect(onPress).toHaveBeenCalledWith(1);

		fireEvent.pointerUp(forward);
		expect(onRelease).toHaveBeenCalled();
	});

	it.each([
		["pointerUp", (element: Element) => fireEvent.pointerUp(element)],
		["pointerCancel", (element: Element) => fireEvent.pointerCancel(element)],
		["pointerLeave", (element: Element) => fireEvent.pointerLeave(element)]
	])("releases on %s", (_name, act) => {
		// Deliberately redundant handlers: a finger sliding off a button produces no pointerup on it
		// at all, and a browser that takes the pointer away produces only a cancel.
		const { onRelease } = renderPad({ active: true });
		openPanel();

		const forward = screen.getByRole("button", { name: "Forward" });
		fireEvent.pointerDown(forward);
		act(forward);
		expect(onRelease).toHaveBeenCalled();
	});

	it("offers all eight of the app's directions", () => {
		renderPad({ active: true });
		openPanel();

		for (const label of [
			"Forward", "Backward", "Turn left", "Turn right",
			"Forward left", "Forward right", "Back left", "Back right"
		]) {
			expect(screen.getByRole("button", { name: label })).toBeTruthy();
		}
	});

	it("drives on the arrow keys and stops when they come up", () => {
		const { onPress, onRelease } = renderPad({ active: true });
		openPanel();

		fireEvent.keyDown(window, { key: "ArrowUp" });
		expect(onPress).toHaveBeenCalledWith(1);

		// A held key repeats; the driver's own cadence does the repeating, not the keyboard's.
		fireEvent.keyDown(window, { key: "ArrowUp" });
		expect(onPress).toHaveBeenCalledTimes(1);

		fireEvent.keyUp(window, { key: "ArrowUp" });
		expect(onRelease).toHaveBeenCalled();
	});

	it("leaves the arrow keys alone while nothing is running", () => {
		const { onPress } = renderPad({ active: false });
		openPanel();

		fireEvent.keyDown(window, { key: "ArrowUp" });
		expect(onPress).not.toHaveBeenCalled();
	});

	it("offers a way out of the mode", () => {
		const { onEnd } = renderPad({ active: true });
		openPanel();

		fireEvent.click(screen.getByText("End remote control"));
		expect(onEnd).toHaveBeenCalled();
	});
});
