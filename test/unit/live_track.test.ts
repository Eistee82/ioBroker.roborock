import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_TRACK_STATE, LiveMapPoller } from "../../src/lib/map/LiveMapPoller";
import { DYNAMIC_DATA_METHOD } from "../../src/lib/map/dynamicData";
import { MapManager } from "../../src/lib/map/MapManager";

const DUID = "test-duid";
const NONCE = 4711;

/** Builds one block of the dynamic payload: 8 byte header, then the body. */
function block(type: number, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt16LE(type, 0);
	header.writeUInt16LE(8, 2);
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

/** Position block as the robot sends it: x, y and angle as little-endian int32, in millimetres. */
function positionBlock(x: number, y: number, angle: number): Buffer {
	const body = Buffer.alloc(12);
	body.writeInt32LE(x, 0);
	body.writeInt32LE(y, 4);
	body.writeInt32LE(angle, 8);
	return block(8, body);
}

/** Path block: two int16 per point. */
function pathBlock(points: [number, number][]): Buffer {
	const body = Buffer.alloc(points.length * 4);
	points.forEach(([x, y], i) => {
		body.writeInt16LE(x, i * 4);
		body.writeInt16LE(y, i * 4 + 2);
	});
	return block(3, body);
}

/** Mop block: one byte per path point. */
function mopBlock(flags: number[]): Buffer {
	return block(18, Buffer.from(flags));
}

function createEnv(options: { pathNonce?: number; payload?: Buffer } = {}) {
	const payload =
		options.payload ??
		Buffer.concat([positionBlock(32587, 22591, -137), pathBlock([[100, 200], [104, 208]]), mopBlock([12, 12])]);

	const sendRequest = vi.fn(async (_duid: string, method: string) => {
		if (method === "get_dynamic_map_diff") {
			return [{ diff: { "3": { max_len: 2, nonce: options.pathNonce ?? NONCE, count: 0 } } }];
		}
		if (method === DYNAMIC_DATA_METHOD) {
			return [{ nonce: NONCE, data_id: 3, start: 0, len: 2, max_len: 2, result: 0, data: payload.toString("base64") }];
		}
		throw new Error(`unexpected method ${method}`);
	});

	const adapter: any = {
		config: { liveMapInterval: 1 },
		requestsHandler: { sendRequest },
		getStateAsync: vi.fn(async () => ({ val: 0 })),
		ensureState: vi.fn(async () => undefined),
		setStateChangedAsync: vi.fn(async () => undefined),
		rLog: vi.fn(),
		errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e))
	};

	return { adapter, sendRequest, poller: new LiveMapPoller(adapter) };
}

/** Runs the private track refresh; it is only reachable through the diff cycle otherwise. */
async function refresh(poller: LiveMapPoller, rawDiff: unknown, state: any): Promise<void> {
	await (poller as any).refreshDynamicTrack(DUID, rawDiff, state);
}

function freshState(): any {
	return {
		nextDueAt: 0,
		inFlight: false,
		diffFailures: 0,
		diffGaveUp: false,
		owned: false,
		loggedBranch: null,
		lastDynamicChannel: null,
		dynamicUnsupported: false
	};
}

const diffAnswer = (nonce: number, maxLen: number): unknown => [{ diff: { "3": { max_len: maxLen, nonce, count: 0 } } }];

describe("live track", () => {
	it("writes position, path and mop flags into the state", async () => {
		const { adapter, poller } = createEnv();
		const state = freshState();

		await refresh(poller, diffAnswer(NONCE, 2), state);

		expect(adapter.ensureState).toHaveBeenCalledWith(`Devices.${DUID}.${LIVE_TRACK_STATE}`, expect.objectContaining({ role: "json" }));
		const [, written] = adapter.setStateChangedAsync.mock.calls[0];
		const snapshot = JSON.parse(written.val);
		expect(snapshot.position).to.deep.equal({ x: 32587, y: 22591, angle: -137 });
		expect(snapshot.path).to.have.length(2);
		expect(snapshot.mopFlags).to.deep.equal([12, 12]);
	});

	it("fetches again when the nonce changed", async () => {
		const { sendRequest, poller } = createEnv();
		const state = freshState();

		await refresh(poller, diffAnswer(NONCE, 2), state);
		const afterFirst = sendRequest.mock.calls.filter((c) => c[1] === DYNAMIC_DATA_METHOD).length;
		await refresh(poller, diffAnswer(NONCE + 1, 2), state);

		expect(sendRequest.mock.calls.filter((c) => c[1] === DYNAMIC_DATA_METHOD).length).toBe(afterFirst + 1);
	});

	it("does not fetch again while nonce and length are unchanged", async () => {
		const { sendRequest, poller } = createEnv();
		const state = freshState();

		await refresh(poller, diffAnswer(NONCE, 2), state);
		await refresh(poller, diffAnswer(NONCE, 2), state);

		expect(sendRequest.mock.calls.filter((c) => c[1] === DYNAMIC_DATA_METHOD).length).toBe(1);
	});

	it("fetches when only the length grew, although count stays zero", async () => {
		// Measured on the real robot: `count` stayed 0 for a whole run while `max_len` grew from
		// 47 to 71. A poller that waits for `count` never sees the robot move.
		const { sendRequest, poller } = createEnv();
		const state = freshState();

		await refresh(poller, diffAnswer(NONCE, 2), state);
		await refresh(poller, diffAnswer(NONCE, 9), state);

		expect(sendRequest.mock.calls.filter((c) => c[1] === DYNAMIC_DATA_METHOD).length).toBe(2);
	});

	it("keeps quiet and stops asking when the robot does not know the method", async () => {
		const { adapter, poller } = createEnv();
		adapter.requestsHandler.sendRequest = vi.fn(async (_d: string, method: string) => {
			if (method === "get_dynamic_map_diff") return diffAnswer(NONCE, 2);
			throw new Error("unknown method");
		});
		const state = freshState();

		await refresh(poller, diffAnswer(NONCE, 2), state);
		expect(state.dynamicUnsupported).toBe(true);
		expect(adapter.setStateChangedAsync).not.toHaveBeenCalled();

		await refresh(poller, diffAnswer(NONCE + 1, 5), state);
		expect(adapter.requestsHandler.sendRequest.mock.calls.filter((c: any[]) => c[1] === DYNAMIC_DATA_METHOD)).toHaveLength(1);
	});

	it("ignores an answer whose result code is not zero", async () => {
		const { adapter, poller } = createEnv();
		adapter.requestsHandler.sendRequest = vi.fn(async (_d: string, method: string) => {
			if (method === "get_dynamic_map_diff") return diffAnswer(NONCE, 2);
			return [{ nonce: NONCE, data_id: 3, start: 0, len: 0, max_len: 2, result: 2, data: "" }];
		});
		const state = freshState();

		await refresh(poller, diffAnswer(NONCE, 2), state);

		expect(adapter.setStateChangedAsync).not.toHaveBeenCalled();
		// A result code is an answer, not a failure: the robot stays eligible for the next round.
		expect(state.dynamicUnsupported).toBe(false);
	});

	it("does nothing when the robot reports an empty channel", async () => {
		const { adapter, poller } = createEnv();
		const state = freshState();

		await refresh(poller, diffAnswer(NONCE, 0), state);

		expect(adapter.setStateChangedAsync).not.toHaveBeenCalled();
	});

	afterEach(() => {
		MapManager.forgetMapNonce(DUID);
	});
});
