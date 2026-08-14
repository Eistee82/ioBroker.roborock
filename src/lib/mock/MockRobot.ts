import { MOCK_ROBOT_DATA } from "./mockData";

export class MockRobot {
	public duid: string;
	public model: string;
	public state: Record<string, any>;
	public features: number[];
	public consumables: any;
	public cleanSummary: any;
	public cleanRecords: any[];
	public cleanRecordsMap: Map<number, any>;
	public multiMaps: any;
	public roomMapping: any[];
	public timers: any[];

	/** Ordered segment ids of the cleaning sequence; empty means "robot decides". */
	public cleanSequence: number[] = [];

	/**
	 * Makes the robot defer the next call to one of these methods with `{result: "retry", id}`,
	 * the way firmware with feature bit 26 does. The entry is consumed on the first call.
	 */
	public deferOnce = new Set<string>();
	/** Retry ids handed out by {@link deferOnce}, and how many polls each still needs. */
	private pendingRetries = new Map<number, number>();
	private nextRetryId = 1000;
	/** How many `retry_request` polls a deferred call needs before it reports success. */
	public retryPollsNeeded = 1;
	/** Every request the robot saw, for payload assertions. */
	public readonly seen: { method: string; params: any }[] = [];

	constructor(duid: string = MOCK_ROBOT_DATA.duid, model: string = MOCK_ROBOT_DATA.model) {
		this.duid = duid;
		this.model = model;
		this.state = JSON.parse(JSON.stringify(MOCK_ROBOT_DATA.properties)); // Deep copy
		this.features = [...MOCK_ROBOT_DATA.firmwareFeatures];
		this.consumables = JSON.parse(JSON.stringify(MOCK_ROBOT_DATA.consumables));
		this.cleanSummary = JSON.parse(JSON.stringify(MOCK_ROBOT_DATA.cleanSummary));
		this.cleanRecords = JSON.parse(JSON.stringify(MOCK_ROBOT_DATA.cleanRecords));
		this.multiMaps = JSON.parse(JSON.stringify(MOCK_ROBOT_DATA.multiMaps));
		this.roomMapping = JSON.parse(JSON.stringify(MOCK_ROBOT_DATA.roomMapping));
		this.timers = JSON.parse(JSON.stringify(MOCK_ROBOT_DATA.timers));

		this.cleanRecordsMap = new Map();
		for (const record of this.cleanRecords) {
			this.cleanRecordsMap.set(record.begin, record);
		}
	}

	public handleRequest(method: string, params: any = []): any {
		this.seen.push({ method, params });

		if (method === "retry_request") {
			return this.handleRetryRequest(params);
		}

		if (this.deferOnce.has(method)) {
			this.deferOnce.delete(method);
			const retryId = this.nextRetryId++;
			this.pendingRetries.set(retryId, this.retryPollsNeeded);
			return { result: "retry", id: retryId };
		}

		switch (method) {
			case "get_clean_sequence":
				return this.cleanSequence;
			case "set_clean_sequence":
				this.cleanSequence = MockRobot.unwrapRetryEnvelope(params) as number[];
				return ["ok"];
			case "get_prop":
				return this.handleGetProp(params);
			case "get_status":
				return [this.state];
			case "get_fw_features":
				return this.features;
			case "get_consumable":
				return [this.consumables];
			case "get_network_info":
				return MOCK_ROBOT_DATA.networkInfo;
			case "get_clean_summary":
				return this.cleanSummary;
			case "get_clean_record":
				return this.handleGetCleanRecord(params[0]);
			case "get_multi_maps_list":
				return [this.multiMaps];
			case "get_room_mapping":
				return this.roomMapping;
			case "get_timer":
				return this.timers;
			case "upd_timer":
				return this.handleUpdTimer(params);
			case "app_start":
				this.updateState({ state: 5, in_cleaning: 1 }); // 5 = Cleaning
				return ["ok"];
			case "app_stop":
			case "app_pause":
				this.updateState({ state: 10, in_cleaning: 1 }); // 10 = Paused
				return ["ok"];
			case "app_charge":
				this.updateState({ state: 6, in_returning: 1, in_cleaning: 0 }); // 6 = Returning to dock
				return ["ok"];
			case "set_custom_mode":
				this.updateState({ fan_power: params[0] });
				return ["ok"];
			case "reset_consumable":
			{
				const consumable = params[0] as string;
				if (consumable in this.consumables) {
					this.consumables[consumable] = 0;
				}
				return ["ok"];
			}
			default:
				// Return generic success for unknown commands to prevent crashes
				return ["ok"];
		}
	}

	/**
	 * Strips the `{data, need_retry}` envelope firmware with feature bit 26 expects, so payload
	 * assertions can look at the parameters the method itself defines.
	 * @param params Raw parameters as received.
	 * @returns The unwrapped payload.
	 */
	public static unwrapRetryEnvelope(params: any): any {
		if (params && typeof params === "object" && !Array.isArray(params) && "need_retry" in params) {
			return "data" in params ? params.data : params;
		}
		return params;
	}

	/**
	 * Answers a `retry_request` poll: still `retry` until the configured number of polls is reached,
	 * then `["ok"]`.
	 * @param params `{retry_id, method, retry_count}`.
	 * @returns The poll answer.
	 */
	private handleRetryRequest(params: any): any {
		const retryId = params?.retry_id;
		const remaining = this.pendingRetries.get(retryId);
		if (remaining === undefined) return ["unknown_id"];

		if (remaining <= 1) {
			this.pendingRetries.delete(retryId);
			return ["ok"];
		}
		this.pendingRetries.set(retryId, remaining - 1);
		return { result: "retry", id: retryId };
	}

	/**
	 * `upd_timer` flips an existing timer on/off: params are `[timerId, "on"|"off"]`, answer `["ok"]`.
	 * @param params Raw request params.
	 */
	private handleUpdTimer(params: any[]): any[] {
		const [timerId, mode] = params;
		if (mode !== "on" && mode !== "off") return ["invalid_params"];

		const timer = this.timers.find((entry) => Array.isArray(entry) && entry[0] === timerId);
		if (!timer) return ["unknown_id"];

		timer[1] = mode;
		return ["ok"];
	}

	private handleGetProp(keys: string[]): any[] {
		if (keys.length === 1 && keys[0] === "get_status") {
			return [this.state];
		}

		const result: any[] = [];
		for (const key of keys) {
			if (key in this.state) {
				result.push(this.state[key]);
			} else {
				result.push(null);
			}
		}
		return result;
	}

	private handleGetCleanRecord(recordId: number): any[] {
		const record = this.cleanRecordsMap.get(recordId);
		if (record) {
			return [record];
		} else if (this.cleanRecords.length > 0) {
			// Return first available record if specific ID not found (mock behavior)
			return [this.cleanRecords[0]];
		}
		return [];
	}

	public updateState(updates: Record<string, any>): void {
		this.state = { ...this.state, ...updates };
	}

	public setDss(bits: {
        cleanFluid?: number,
        waterFilter?: number,
        dustBag?: number,
        dirtyTank?: number,
        cleanTank?: number,
        updownWater?: number
    }): void {
		const current = this.state.dss || 0;
		let next = current;
		if (bits.cleanFluid !== undefined) next = (next & ~(0b11 << 10)) | (bits.cleanFluid << 10);
		if (bits.waterFilter !== undefined) next = (next & ~(0b11 << 8)) | (bits.waterFilter << 8);
		if (bits.dustBag !== undefined) next = (next & ~(0b11 << 6)) | (bits.dustBag << 6);
		if (bits.dirtyTank !== undefined) next = (next & ~(0b11 << 4)) | (bits.dirtyTank << 4);
		if (bits.cleanTank !== undefined) next = (next & ~(0b11 << 2)) | (bits.cleanTank << 2);
		if (bits.updownWater !== undefined) next = (next & ~(0b11)) | (bits.updownWater);

		this.updateState({ dss: next });
	}
}
