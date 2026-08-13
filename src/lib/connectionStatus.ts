// src/lib/connectionStatus.ts
//
// Makes the transport channel visible per device. Until now the user could not tell
// whether a command travelled over the local TCP session or over the Roborock cloud.

import type { Roborock } from "../main";
import { isLocalOnlyMode } from "./manualDevices";

export type PreferredChannel = "local" | "cloud" | "none";

export interface DeviceConnectionSnapshot {
	local: boolean;
	cloud: boolean;
	preferred: PreferredChannel;
	ip: string;
}

export class ConnectionStatusManager {
	private readonly adapter: Roborock;
	private readonly ensuredDevices = new Set<string>();
	private refreshInterval: ioBroker.Interval | undefined = undefined;
	private static readonly REFRESH_MS = 5000;

	constructor(adapter: Roborock) {
		this.adapter = adapter;
	}

	/** True when the adapter is configured to never talk to the Roborock cloud. */
	public isLocalOnly(): boolean {
		return isLocalOnlyMode(this.adapter.config);
	}

	public async ensureStates(duid: string): Promise<void> {
		if (this.ensuredDevices.has(duid)) return;

		await this.adapter.ensureFolder(`Devices.${duid}.connection`);
		await this.adapter.ensureState(`Devices.${duid}.connection.local`, {
			name: "Local connection established",
			type: "boolean",
			role: "indicator.connected",
			read: true,
			write: false,
			def: false,
		});
		await this.adapter.ensureState(`Devices.${duid}.connection.cloud`, {
			name: "Cloud connection established",
			type: "boolean",
			role: "indicator.connected",
			read: true,
			write: false,
			def: false,
		});
		await this.adapter.ensureState(`Devices.${duid}.connection.preferred`, {
			name: "Preferred channel",
			type: "string",
			role: "text",
			read: true,
			write: false,
			states: { local: "local", cloud: "cloud", none: "none" },
		});
		await this.adapter.ensureState(`Devices.${duid}.connection.ip`, {
			name: "Local IP address",
			type: "string",
			role: "info.ip",
			read: true,
			write: false,
		});

		this.ensuredDevices.add(duid);
	}

	/** Current channel situation for a device; pure, no side effects. */
	public getSnapshot(duid: string): DeviceConnectionSnapshot {
		const local = this.adapter.local_api?.isConnected(duid) === true;
		const cloud = !this.isLocalOnly() && this.adapter.mqtt_api?.isConnected?.() === true;
		const preferred: PreferredChannel = local ? "local" : cloud ? "cloud" : "none";
		return {
			local,
			cloud,
			preferred,
			ip: this.adapter.local_api?.getIpForDuid(duid) ?? "",
		};
	}

	public async update(duid: string): Promise<void> {
		await this.ensureStates(duid);
		const snapshot = this.getSnapshot(duid);
		await Promise.all([
			this.adapter.setStateChanged(`Devices.${duid}.connection.local`, { val: snapshot.local, ack: true }),
			this.adapter.setStateChanged(`Devices.${duid}.connection.cloud`, { val: snapshot.cloud, ack: true }),
			this.adapter.setStateChanged(`Devices.${duid}.connection.preferred`, { val: snapshot.preferred, ack: true }),
			this.adapter.setStateChanged(`Devices.${duid}.connection.ip`, { val: snapshot.ip, ack: true }),
		]);
	}

	public async updateAll(): Promise<void> {
		const duids = (this.adapter.http_api?.getDevices() ?? []).map((device) => device.duid).filter((duid) => typeof duid === "string" && duid !== "");

		let anyLocal = false;
		for (const duid of duids) {
			const snapshot = this.getSnapshot(duid);
			if (snapshot.local) anyLocal = true;
			await this.update(duid);
		}

		// Without the cloud nothing else reports adapter connectivity, so derive it locally.
		if (this.isLocalOnly()) {
			await this.adapter.setStateChanged("info.connection", { val: anyLocal, ack: true });
		}
	}

	/** Fire-and-forget refresh, used from socket callbacks where awaiting is not possible. */
	public schedule(duid: string): void {
		this.update(duid).catch((e: unknown) => {
			this.adapter.rLog("System", duid, "Debug", undefined, undefined, `Could not update connection states: ${this.adapter.errorMessage(e)}`, "debug");
		});
	}

	public start(): void {
		if (this.refreshInterval) return;
		const interval = this.adapter.setInterval(() => {
			this.updateAll().catch((e: unknown) => {
				this.adapter.rLog("System", null, "Debug", undefined, undefined, `Connection state refresh failed: ${this.adapter.errorMessage(e)}`, "debug");
			});
		}, ConnectionStatusManager.REFRESH_MS);
		if (interval) this.refreshInterval = interval;
	}

	public stop(): void {
		if (this.refreshInterval) {
			this.adapter.clearInterval(this.refreshInterval);
			this.refreshInterval = undefined;
		}
	}
}
