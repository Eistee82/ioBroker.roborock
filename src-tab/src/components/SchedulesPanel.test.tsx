import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import { SchedulesPanel } from "./SchedulesPanel";
import type { ScheduleEntry, SchedulesModel } from "../schedules/schedules";

/**
 * What the schedules panel offers, and above all what it refuses to offer.
 *
 * The three cases it has to keep apart are not cosmetic. A server-side schedule may be deleted but
 * not switched; a schedule the adapter could not place may be neither; and deleting a server-side one
 * leaves a copy in the Roborock account that the phone app goes on showing as switched on - which has
 * to be read **before** the deletion, not discovered on the phone afterwards.
 *
 * No translations are loaded in the test environment, so `I18n.t` answers with the key. That is what
 * the assertions look for.
 */

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
	return {
		id: "1498595904821",
		source: "device",
		enabled: true,
		canToggle: true,
		canDelete: true,
		timing: { time: "14:00", weekdays: [5], dayOfMonth: null, month: null },
		rawTime: null,
		...overrides,
	};
}

function model(entries: ScheduleEntry[]): SchedulesModel {
	return { entries, hasReadOnly: entries.some(item => !item.canToggle && !item.canDelete) };
}

/** Renders the panel and expands it, since everything under test lives in the collapsed part. */
function renderPanel(schedules: SchedulesModel | null) {
	const onToggle = vi.fn();
	const onDelete = vi.fn();
	const view = render(
		<SchedulesPanel
			schedules={schedules}
			language="en"
			onToggle={onToggle}
			onDelete={onDelete}
		/>,
	);
	const header = screen.queryByText(I18n.t("ui_schedules"));
	if (header) fireEvent.click(header);
	return { onToggle, onDelete, view };
}

describe("when the panel appears at all", () => {
	it("stays away while nothing has been read", () => {
		renderPanel(null);
		expect(screen.queryByText(I18n.t("ui_schedules"))).toBeNull();
	});

	it("stays away when the robot has no schedule", () => {
		// There is nothing to offer: the adapter cannot write a schedule, so an empty panel would only
		// hold a plus that leads nowhere.
		renderPanel(model([]));
		expect(screen.queryByText(I18n.t("ui_schedules"))).toBeNull();
	});

	it("says where new schedules come from, for the person looking for the plus", () => {
		renderPanel(model([entry()]));
		expect(screen.getByText(new RegExp(I18n.t("ui_schedules_no_create_hint")))).toBeTruthy();
	});

	it("says that the times are the robot's own", () => {
		renderPanel(model([entry()]));
		expect(screen.getByText(new RegExp(I18n.t("ui_schedules_timezone_hint")))).toBeTruthy();
	});
});

describe("a device timer", () => {
	it("shows its time and the day it repeats on", () => {
		renderPanel(model([entry()]));
		expect(screen.getByText("14:00")).toBeTruthy();
		expect(screen.getByText("Fri")).toBeTruthy();
	});

	it("switches through the callback with the identifier the robot uses", () => {
		const { onToggle } = renderPanel(model([entry({ enabled: true })]));
		fireEvent.click(screen.getByRole("checkbox"));
		expect(onToggle).toHaveBeenCalledWith("1498595904821", false);
	});

	it("names where it is kept", () => {
		renderPanel(model([entry()]));
		expect(screen.getByText(I18n.t("ui_schedules_source_device"))).toBeTruthy();
	});
});

describe("a server-side schedule", () => {
	const serverEntry = entry({ id: "1743140136890", source: "server", canToggle: false, canDelete: true, timing: null });

	it("offers no switch, because switching it is not a proven command", () => {
		renderPanel(model([serverEntry]));
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("still says whether it is on", () => {
		renderPanel(model([serverEntry]));
		expect(screen.getByText(I18n.t("ui_schedules_on"))).toBeTruthy();
	});

	it("names where it is kept", () => {
		renderPanel(model([serverEntry]));
		expect(screen.getByText(I18n.t("ui_schedules_source_server"))).toBeTruthy();
	});

	it("says why it shows no time", () => {
		// The robot reports only which schedules exist and whether they are on; their times, rooms and
		// modes live in the Roborock account. A row with a bare identifier and no reason would read as
		// a fault of this panel.
		renderPanel(model([serverEntry]));
		expect(screen.getByText(I18n.t("ui_schedules_content_in_cloud"))).toBeTruthy();
	});

	it("does not claim that for a device timer whose cron was simply not understood", () => {
		renderPanel(model([entry({ source: "device", timing: null, rawTime: "@weekly" })]));
		expect(screen.queryByText(I18n.t("ui_schedules_content_in_cloud"))).toBeNull();
	});

	it("warns about the copy in the Roborock account before anything is deleted", () => {
		const { onDelete } = renderPanel(model([serverEntry]));
		fireEvent.click(screen.getByRole("button", { name: new RegExp(I18n.t("schedule_delete")) }));

		expect(screen.getByText(new RegExp(I18n.t("schedule_delete_server_hint")))).toBeTruthy();
		// Nothing has been sent yet - the warning is a stop, not a receipt.
		expect(onDelete).not.toHaveBeenCalled();
	});

	it("deletes only after the question was answered", () => {
		const { onDelete } = renderPanel(model([serverEntry]));
		fireEvent.click(screen.getByRole("button", { name: new RegExp(I18n.t("schedule_delete")) }));
		fireEvent.click(screen.getByText(I18n.t("ui_schedules_delete_yes")));

		expect(onDelete).toHaveBeenCalledWith("1743140136890");
	});

	it("sends nothing when the question is answered with cancel", () => {
		const { onDelete } = renderPanel(model([serverEntry]));
		fireEvent.click(screen.getByRole("button", { name: new RegExp(I18n.t("schedule_delete")) }));
		fireEvent.click(screen.getByText(I18n.t("ui_cancel")));

		expect(onDelete).not.toHaveBeenCalled();
		expect(screen.queryByText(new RegExp(I18n.t("schedule_delete_server_hint")))).toBeNull();
	});
});

describe("a device timer's delete question", () => {
	it("carries the general warning but not the server one", () => {
		renderPanel(model([entry()]));
		fireEvent.click(screen.getByRole("button", { name: new RegExp(I18n.t("schedule_delete")) }));

		expect(screen.getByText(new RegExp(I18n.t("schedule_delete_hint")))).toBeTruthy();
		expect(screen.queryByText(new RegExp(I18n.t("schedule_delete_server_hint")))).toBeNull();
	});
});

describe("a schedule the adapter could not place", () => {
	const readOnly = entry({ id: "local_01", source: "unknown", canToggle: false, canDelete: false, enabled: false });

	it("offers neither a switch nor a delete", () => {
		renderPanel(model([readOnly]));
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByRole("button", { name: new RegExp(I18n.t("schedule_delete")) })).toBeNull();
	});

	it("shows what it is doing anyway", () => {
		renderPanel(model([readOnly]));
		expect(screen.getByText(I18n.t("ui_schedules_off"))).toBeTruthy();
	});

	it("says why there is nothing to press", () => {
		renderPanel(model([readOnly]));
		expect(screen.getByText(I18n.t("ui_schedules_readonly_hint"))).toBeTruthy();
	});

	it("carries no source chip, because none was recorded", () => {
		renderPanel(model([readOnly]));
		expect(screen.queryByText(I18n.t("ui_schedules_source_device"))).toBeNull();
		expect(screen.queryByText(I18n.t("ui_schedules_source_server"))).toBeNull();
	});
});

describe("a schedule whose time could not be read", () => {
	it("shows the robot's own text and says that it is that", () => {
		renderPanel(model([entry({ timing: null, rawTime: "@weekly" })]));

		expect(screen.getByText("@weekly")).toBeTruthy();
		expect(screen.getByText(I18n.t("ui_schedules_time_unreadable"))).toBeTruthy();
	});
});

describe("the header", () => {
	it("counts only the schedules that are switched on", () => {
		renderPanel(model([entry({ id: "a", enabled: true }), entry({ id: "b", enabled: false }), entry({ id: "c", enabled: null })]));
		expect(screen.getByText("1")).toBeTruthy();
	});
});
