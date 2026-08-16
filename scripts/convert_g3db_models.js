/**
 * Converts Roborock's own furniture models out of the app package into something the 3D map can
 * draw.
 *
 * ## Whose models these are
 *
 * **The geometry is Roborock's.** It comes out of their app package and is used here to draw the
 * same furniture their app draws. It is not this project's work, it is not covered by this
 * adapter's licence, and the file this script writes says so in its own first field. Roborock
 * holds the rights; the adapter only reads what is already on the user's own device family.
 *
 * Same footing as the 2D furniture icons, which the adapter takes from the control plugin the
 * user's own account downloads rather than shipping copies of them.
 *
 * ## What this reads
 *
 * `assets/models_g3db/*.g3db` inside the Roborock APK - 35 files, libGDX's `.g3db`, which is
 * UBJSON with libGDX's own dialect. Nothing here guesses at the format; the reader below ends on
 * the file's last byte or throws, and all 35 files end exactly there.
 *
 * The dialect, established by reading files rather than by looking it up:
 *
 * | Marker | Meaning |
 * | --- | --- |
 * | `{` … `}` | object; every key is `s` + length + bytes |
 * | `[` … `]` | array of mixed values |
 * | `s` | string; the length is one plain byte below 128, a typed integer above |
 * | `a` T n | typed array, count in **one** byte |
 * | `A` T nnnn | typed array, count in **four** bytes, big-endian |
 * | `i` | int16 - **not** the int8 plain UBJSON gives it |
 * | `l` `d` `D` | int32, float32, float64, all big-endian |
 *
 * ## What it writes
 *
 * One JSON file for the tab, with per-model position, normal and index buffers base64-encoded, and
 * the model's bounding box so the view can scale it onto the footprint the robot measured.
 *
 * **Texture coordinates are dropped.** Every material in these files is a plain colour - no
 * texture is referenced anywhere in the 35 - so the UVs would be three megabytes of numbers that
 * nothing reads.
 *
 * ## Why this is a script and not a build step
 *
 * It needs the APK, which is not part of this repository and is not something a user has. The
 * output is committed instead, and this file records exactly how it was produced.
 *
 * Usage: `node scripts/convert_g3db_models.js <directory with .g3db files> <output .json>`
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** Reads libGDX's UBJSON dialect. See the module comment for the marker table. */
class Reader {
	constructor(buf) {
		this.b = buf;
		this.p = 0;
	}

	u8() {
		return this.b[this.p++];
	}

	/** Reads one number of the type the marker names. */
	int(marker) {
		switch (marker) {
			case 0x69: {
				const v = this.b.readInt16BE(this.p);
				this.p += 2;
				return v;
			}
			case 0x55:
				return this.b.readUInt8(this.p++);
			case 0x49: {
				const v = this.b.readInt16BE(this.p);
				this.p += 2;
				return v;
			}
			case 0x6c: {
				const v = this.b.readInt32BE(this.p);
				this.p += 4;
				return v;
			}
			case 0x4c: {
				const v = Number(this.b.readBigInt64BE(this.p));
				this.p += 8;
				return v;
			}
			case 0x64: {
				const v = this.b.readFloatBE(this.p);
				this.p += 4;
				return v;
			}
			case 0x44: {
				const v = this.b.readDoubleBE(this.p);
				this.p += 8;
				return v;
			}
			default:
				throw new Error(`unknown number marker ${String.fromCharCode(marker)} at ${this.p}`);
		}
	}

	str() {
		let len = this.u8();
		if (len & 0x80) {
			this.p--;
			len = this.int(this.u8());
		}
		const s = this.b.toString("utf8", this.p, this.p + len);
		this.p += len;
		return s;
	}

	value(marker) {
		switch (marker) {
			case 0x7b:
				return this.object();
			case 0x5b:
				return this.array();
			case 0x73:
				return this.str();
			case 0x61:
			case 0x41: {
				const type = this.u8();
				let count;
				if (marker === 0x61) {
					count = this.u8();
				} else {
					count = this.b.readInt32BE(this.p);
					this.p += 4;
				}
				const out = new Array(count);
				for (let i = 0; i < count; i++) out[i] = this.int(type);
				return out;
			}
			case 0x54:
				return true;
			case 0x46:
				return false;
			case 0x5a:
				return null;
			default:
				return this.int(marker);
		}
	}

	object() {
		const o = {};
		for (;;) {
			const m = this.u8();
			if (m === 0x7d) return o;
			if (m !== 0x73) throw new Error(`expected a key at ${this.p - 1}, found ${m}`);
			const k = this.str();
			o[k] = this.value(this.u8());
		}
	}

	array() {
		const a = [];
		for (;;) {
			const m = this.u8();
			if (m === 0x5d) return a;
			a.push(this.value(m));
		}
	}
}

/**
 * Reads one `.g3db`.
 *
 * @param file Path to the file.
 * @returns The parsed model.
 */
function parseG3db(file) {
	const buf = fs.readFileSync(file);
	const r = new Reader(buf);
	if (r.u8() !== 0x7b) throw new Error(`${file}: does not start with an object`);
	const model = r.object();
	// The real check that the dialect was read right: a wrong width or count drifts, and the
	// reader then stops somewhere other than the end.
	if (r.p !== buf.length) throw new Error(`${file}: read ${r.p} of ${buf.length} bytes`);
	return model;
}

/** How many floats one vertex takes, and where position and normal sit inside it. */
function layout(attributes) {
	const sizes = { POSITION: 3, NORMAL: 3, TEXCOORD0: 2, TEXCOORD1: 2, COLOR: 4, COLORPACKED: 1, TANGENT: 3, BINORMAL: 3, BLENDWEIGHT0: 2 };
	let stride = 0;
	let positionAt = -1;
	let normalAt = -1;
	for (const a of attributes) {
		const size = sizes[a] ?? (a.startsWith("BLENDWEIGHT") ? 2 : null);
		if (size === null) throw new Error(`unknown vertex attribute ${a}`);
		if (a === "POSITION") positionAt = stride;
		if (a === "NORMAL") normalAt = stride;
		stride += size;
	}
	if (positionAt < 0) throw new Error("a mesh without positions");
	return { stride, positionAt, normalAt };
}

/**
 * Turns one model into flat buffers.
 *
 * All meshes and all their parts are merged into one buffer set: the map draws a piece of
 * furniture as one object, and the parts carry no separate material - every file here has exactly
 * one.
 *
 * @param model Parsed `.g3db`.
 * @returns Positions, normals, indices and the bounding box.
 */
function flatten(model) {
	const position = [];
	const normal = [];
	const index = [];
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];

	for (const mesh of model.meshes ?? []) {
		const { stride, positionAt, normalAt } = layout(mesh.attributes ?? []);
		const verts = mesh.vertices ?? [];
		const base = position.length / 3;
		const count = Math.floor(verts.length / stride);

		for (let v = 0; v < count; v++) {
			const at = v * stride + positionAt;
			const x = verts[at];
			const y = verts[at + 1];
			const z = verts[at + 2];
			position.push(x, y, z);
			if (x < min[0]) min[0] = x;
			if (y < min[1]) min[1] = y;
			if (z < min[2]) min[2] = z;
			if (x > max[0]) max[0] = x;
			if (y > max[1]) max[1] = y;
			if (z > max[2]) max[2] = z;

			if (normalAt >= 0) {
				const n = v * stride + normalAt;
				normal.push(verts[n], verts[n + 1], verts[n + 2]);
			} else {
				normal.push(0, 1, 0);
			}
		}

		for (const part of mesh.parts ?? []) {
			if (part.type && part.type !== "TRIANGLES") continue;
			for (const i of part.indices ?? []) index.push(base + i);
		}
	}

	return { position, normal, index, min, max };
}

/** Base64 of a typed array's bytes. */
function b64(typed) {
	return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
}

/**
 * The models the map actually draws - the ones the app's own `(type, subType)` table names, plus
 * the robot and the dock.
 *
 * The package holds 35 and converting all of them costs 8 MiB, most of it in models for obstacle
 * types this adapter does not place: a shoe, a cat, a dog, a plant. Those can be added when
 * something draws them; carrying them now would be four megabytes nobody loads.
 */
const WANTED = new Set([
	"bed1",
	"bed2",
	"bedCabinet",
	"cat_bed",
	"cat_cage",
	"cat_plate",
	"chaji",
	"chajiRect",
	"charger",
	"close_toilet",
	"clothesCabinet",
	"open_toilet",
	"robot",
	"shoesCabinet",
	"sofa1",
	"sofa2",
	"sofa3",
	"sofaLL",
	"sofaLR",
	"table",
	"tall_mirror",
	"tvCabinet"
]);

function main() {
	const [dir, out] = process.argv.slice(2);
	if (!dir || !out) {
		console.error("usage: node scripts/convert_g3db_models.js <g3db directory> <output .json>");
		process.exit(2);
	}

	const models = {};
	let bytes = 0;
	for (const file of fs
		.readdirSync(dir)
		.filter((n) => n.endsWith(".g3db") && WANTED.has(path.basename(n, ".g3db")))
		.sort()) {
		const name = path.basename(file, ".g3db");
		const { position, normal, index, min, max } = flatten(parseG3db(path.join(dir, file)));
		if (position.length === 0 || index.length === 0) {
			console.error(`${name}: empty, skipped`);
			continue;
		}

		const pos = Float32Array.from(position);
		const nor = Float32Array.from(normal);
		// 16-bit indices where they fit, which is every model here but one; the reader picks the
		// type from the field rather than assuming.
		const wide = position.length / 3 > 65535;
		const idx = wide ? Uint32Array.from(index) : Uint16Array.from(index);

		models[name] = {
			position: b64(pos),
			normal: b64(nor),
			index: b64(idx),
			indexBits: wide ? 32 : 16,
			min,
			max
		};
		bytes += pos.byteLength + nor.byteLength + idx.byteLength;
		console.log(`${name.padEnd(16)} ${String(position.length / 3).padStart(7)} vertices ${String(index.length / 3).padStart(7)} triangles${wide ? " (32-bit indices)" : ""}`);
	}

	const payload = {
		_copyright: "The geometry in this file is Roborock's. It is extracted from assets/models_g3db/*.g3db of the Roborock app (4.72.02) and is used here to draw the same furniture the app draws. Roborock holds the rights to it; it is not covered by this adapter's licence and must not be redistributed as if it were.",
		_source: "converted by scripts/convert_g3db_models.js - see that file for the format and for how to reproduce this",
		models
	};
	fs.writeFileSync(out, JSON.stringify(payload));
	console.log(`\n${Object.keys(models).length} models, ${(bytes / 1048576).toFixed(2)} MiB of buffers, ${(fs.statSync(out).size / 1048576).toFixed(2)} MiB written`);
}

if (require.main === module) main();

module.exports = { parseG3db, flatten };
