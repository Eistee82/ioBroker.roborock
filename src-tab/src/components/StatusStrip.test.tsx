import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { StatusStrip } from "./StatusStrip";
import type { StatusModel } from "../engine/types";

/**
 * The top right strip, checked for the one control that lives in it.
 *
 * The view reset moved up here from the run controls: it changes what is *shown*, not what the
 * robot does, and it used to sit between Start, Stop and Dock as the only harmless button among
 * them. A reset that quietly disappeared in the move would be a control the user cannot reach.
 */

const STATUS: StatusModel = {
	stateText: "Charging",
	battery: 87,
	cleanArea: 42,
	cleanTime: 61,
	errorText: null,
	connectionChannel: "local",
	phase: "docked",
	dockActivity: null,
};

function renderStrip(overrides: Partial<StatusModel> = {}): { onResetZoom: ReturnType<typeof vi.fn> } {
	const onResetZoom = vi.fn();
	render(
		<StatusStrip
			status={{ ...STATUS, ...overrides }}
			onResetZoom={onResetZoom}
		/>,
	);
	return { onResetZoom };
}

describe("StatusStrip", () => {
	it("offers the view reset and wires it to its callback", () => {
		const { onResetZoom } = renderStrip();

		fireEvent.click(screen.getByRole("button", { name: I18n.t("ui_reset_view") }));

		expect(onResetZoom).toHaveBeenCalledTimes(1);
	});

	it("takes the reset away when there is no 2D map to reset", () => {
		// Null is what the shell passes while the 3D view is showing. The button resets the **2D**
		// map's zoom, so leaving it there meant pressing "reset the view" and watching the view one is
		// actually looking at not move - the same silent no-op the go-to button had. See
		// `map3d/zoneEditingView.ts` for the rule that hides this one instead of redirecting it.
		render(
			<StatusStrip
				status={STATUS}
				onResetZoom={null}
			/>,
		);

		expect(screen.queryByRole("button", { name: I18n.t("ui_reset_view") })).toBeNull();
	});

	it("keeps the reset reachable while the device publishes no transport channel", () => {
		// The connection reading is conditional; the button next to it must not be.
		renderStrip({ connectionChannel: "" });

		expect(screen.getByRole("button", { name: I18n.t("ui_reset_view") })).toBeTruthy();
	});

	it("keeps the reset reachable while the robot reports an error", () => {
		renderStrip({ errorText: "Dustbin missing" });

		expect(screen.getByRole("button", { name: I18n.t("ui_reset_view") })).toBeTruthy();
	});

	it("names the reset in words rather than with a raw translation key", () => {
		renderStrip();

		const label = screen.getByRole("button", { name: I18n.t("ui_reset_view") }).getAttribute("aria-label");
		expect(label).not.toMatch(/^ui_/);
		expect((label ?? "").trim().length).toBeGreaterThan(0);
	});

	it("shows the readings the engine resolved, without touching a state code", () => {
		renderStrip();

		expect(screen.getByText("Charging")).toBeTruthy();
		expect(screen.getByText("87 %")).toBeTruthy();
		expect(screen.getByText("local")).toBeTruthy();
	});
});
