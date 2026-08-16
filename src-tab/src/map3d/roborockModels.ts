/**
 * Roborock's own furniture models, loaded on demand.
 *
 * ## Whose geometry this is
 *
 * **The models belong to Roborock.** They are extracted from `assets/models_g3db/` of the Roborock
 * app and are used here to draw the same furniture their app draws. They are not this project's
 * work and are not covered by its licence - the data file carries that notice in its first field,
 * and `scripts/convert_g3db_models.js` records how it was produced.
 *
 * ## Why it is loaded rather than bundled
 *
 * The 22 models are about 6 MiB. Bundled, every admin session would download them to open a tab
 * that is mostly a 2D map; imported dynamically, Vite puts them in a chunk of their own that is
 * fetched the first time somebody switches to 3D and cached afterwards.
 *
 * A failure to load is not an error: the view falls back to the shapes in `furnitureShapes.ts`,
 * which is what it drew before the models existed. A missing model costs detail, never the piece.
 */

/** One model's buffers, as they sit in the data file. */
interface EncodedModel {
	position: string;
	normal: string;
	index: string;
	indexBits: number;
	min: [number, number, number];
	max: [number, number, number];
}

/** One model, ready for three.js. */
export interface RoborockModel {
	position: Float32Array;
	normal: Float32Array;
	index: Uint16Array | Uint32Array;
	/** Size of the model's own bounding box, so it can be scaled onto the measured footprint. */
	size: { x: number; y: number; z: number };
	/** Centre of that box - the models are not centred on their own origin. */
	centre: { x: number; y: number; z: number };
}

/** Decodes base64 into bytes without pulling in a dependency. */
function bytesOf(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out.buffer;
}

function decode(model: EncodedModel): RoborockModel {
	const index = model.indexBits === 32 ? new Uint32Array(bytesOf(model.index)) : new Uint16Array(bytesOf(model.index));
	return {
		position: new Float32Array(bytesOf(model.position)),
		normal: new Float32Array(bytesOf(model.normal)),
		index,
		size: {
			x: model.max[0] - model.min[0],
			y: model.max[1] - model.min[1],
			z: model.max[2] - model.min[2]
		},
		centre: {
			x: (model.max[0] + model.min[0]) / 2,
			y: (model.max[1] + model.min[1]) / 2,
			z: (model.max[2] + model.min[2]) / 2
		}
	};
}

/** Decoded models, kept so a redraw does not decode six megabytes again. */
let cache: Record<string, RoborockModel> | null = null;
/** The in-flight load, so two redraws in the same second fetch the chunk once. */
let pending: Promise<Record<string, RoborockModel> | null> | null = null;

/**
 * Loads and decodes the models.
 *
 * @returns The models by name, or null when they could not be loaded.
 */
export async function loadRoborockModels(): Promise<Record<string, RoborockModel> | null> {
	if (cache) return cache;
	if (pending) return pending;

	pending = (async () => {
		try {
			const data = (await import("./roborockModels.json")) as unknown as {
				default?: { models?: Record<string, EncodedModel> };
				models?: Record<string, EncodedModel>;
			};
			const models = data.models ?? data.default?.models;
			if (!models) return null;

			const decoded: Record<string, RoborockModel> = {};
			for (const [name, encoded] of Object.entries(models)) decoded[name] = decode(encoded);
			cache = decoded;
			return decoded;
		} catch {
			// Deliberately quiet and deliberately not fatal: the view has its own shapes.
			return null;
		} finally {
			pending = null;
		}
	})();

	return pending;
}

/** The models already in memory, or null while they are still on their way. */
export function roborockModels(): Record<string, RoborockModel> | null {
	return cache;
}
