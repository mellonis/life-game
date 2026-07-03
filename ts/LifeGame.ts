// Generations to run invisibly after a random fill, so the dense soup
// collapses before it is ever rendered. At ~80% fill the collapse takes
// 1-2 generations (overcrowding kills ~99% of cells in the first step);
// 5 leaves margin.
const SETTLE_GENERATIONS = 5;

export class LifeGame {
	private width: number;
	private height: number;
	private field: Uint8Array;
	// Cells that flipped in the last makeStage. Invariant: print() and
	// makeStage() must alternate strictly (as in the rAF loop) — a second
	// makeStage() without a print() in between would drop pixel updates.
	// changedCount === width*height means "treat every cell as changed"
	// (the list contents are ignored); set after fillField()/resize().
	private changed: Int32Array;
	private changedCount: number;
	private flips: Int32Array;
	private candidates: Int32Array;
	private stamp: Uint32Array;
	private gen = 0;
	private img: ImageData | null = null;
	private pixels: Uint32Array | null = null;
	private needFullPrint = true;
	private colorCache = new Map<string, number>();
	private lastPalette = '';
	// Render-only metadata: cells stamped since the last print() are drawn in
	// the accent color for one frame; the previous frame's batch reverts.
	private stamps: Int32Array;
	private stampCount = 0;
	private prevStamps: Int32Array;
	private prevStampCount = 0;
	// Outer-totalistic rule as bitmasks: bit n set = the transition applies
	// at n live neighbors. Defaults are Conway's B3/S23.
	private bornMask = 1 << 3;
	private surviveMask = (1 << 2) | (1 << 3);

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.field = new Uint8Array(width * height);
		this.changed = new Int32Array(width * height);
		this.flips = new Int32Array(width * height);
		this.candidates = new Int32Array(width * height);
		this.stamp = new Uint32Array(width * height);
		this.stamps = new Int32Array(width * height);
		this.prevStamps = new Int32Array(width * height);
		this.changedCount = 0;
		this.fillField();
	}

	setRules(born: Iterable<number>, survive: Iterable<number>): void {
		let b = 0, s = 0;
		for (const n of born) b |= 1 << n;
		for (const n of survive) s |= 1 << n;
		this.bornMask = b;
		this.surviveMask = s;
		// under new rules any cell may change: force a full sweep
		this.changedCount = this.width * this.height;
	}

	fillField(): void {
		for (let idx = 0; idx < this.field.length; idx++) {
			this.field[idx] = Math.random() * 100 > 20 ? 1 : 0;
		}
		this.changedCount = this.field.length;
		this.stampCount = 0;
		this.prevStampCount = 0;
		for (let g = 0; g < SETTLE_GENERATIONS; g++) this.makeStage();
		this.needFullPrint = true;
	}

	// A standalone random soup evolved past its dense phase, for splicing
	// into resize-added regions without advancing the preserved pattern.
	private settledSoup(width: number, height: number): Uint8Array {
		const bMask = this.bornMask, sMask = this.surviveMask;
		let cur = new Uint8Array(width * height);
		let nxt = new Uint8Array(width * height);
		for (let idx = 0; idx < cur.length; idx++) {
			cur[idx] = Math.random() * 100 > 20 ? 1 : 0;
		}
		for (let g = 0; g < SETTLE_GENERATIONS; g++) {
			for (let j = 1; j < height - 1; j++) {
				for (let i = 1; i < width - 1; i++) {
					const idx = j * width + i;
					const c =
						cur[idx - width - 1] + cur[idx - width] + cur[idx - width + 1] +
						cur[idx - 1] + cur[idx + 1] +
						cur[idx + width - 1] + cur[idx + width] + cur[idx + width + 1];
					nxt[idx] = ((cur[idx] ? sMask : bMask) >> c) & 1;
				}
			}
			const swap = cur; cur = nxt; nxt = swap;
		}
		return cur;
	}

	// Preserves the existing pattern anchored at the top-left corner;
	// cells outside the overlap are cropped, new area is filled randomly.
	resize(width: number, height: number): void {
		if (width === this.width && height === this.height) return;
		const resized = new Uint8Array(width * height);
		const copyW = Math.min(width, this.width);
		const copyH = Math.min(height, this.height);
		for (let j = 0; j < copyH; j++) {
			resized.set(this.field.subarray(j * this.width, j * this.width + copyW), j * width);
		}
		if (width > copyW) {
			const strip = this.settledSoup(width - copyW, copyH);
			for (let j = 0; j < copyH; j++) {
				resized.set(strip.subarray(j * (width - copyW), (j + 1) * (width - copyW)), j * width + copyW);
			}
		}
		if (height > copyH) {
			resized.set(this.settledSoup(width, height - copyH), copyH * width);
		}
		this.width = width;
		this.height = height;
		this.field = resized;
		this.changed = new Int32Array(width * height);
		this.flips = new Int32Array(width * height);
		this.candidates = new Int32Array(width * height);
		this.stamp = new Uint32Array(width * height);
		this.stamps = new Int32Array(width * height);
		this.prevStamps = new Int32Array(width * height);
		this.stampCount = 0;
		this.prevStampCount = 0;
		this.gen = 0;
		this.changedCount = width * height;
		this.img = null;
		this.pixels = null;
		this.needFullPrint = true;
	}

	// Sets live cells along a circle (for click ripples). Stamped cells are
	// appended to the change list so both the renderer and the next
	// generation's candidate scan see them.
	stampRing(cx: number, cy: number, radius: number, thickness = 1): void {
		const w = this.width, h = this.height;
		for (let t = 0; t < thickness; t++) {
			const r = radius - t;
			if (r <= 0) continue;
			const steps = Math.max(8, Math.ceil(2 * Math.PI * r));
			for (let s = 0; s < steps; s++) {
				const a = (2 * Math.PI * s) / steps;
				const i = Math.round(cx + r * Math.cos(a));
				const j = Math.round(cy + r * Math.sin(a));
				if (i <= 0 || i >= w - 1 || j <= 0 || j >= h - 1) continue;
				const idx = j * w + i;
				if (this.field[idx] === 0) {
					this.field[idx] = 1;
					// on overflow changedCount saturates at total = "all changed"
					if (this.changedCount < this.field.length) {
						this.changed[this.changedCount++] = idx;
					}
					if (this.stampCount < this.stamps.length) {
						this.stamps[this.stampCount++] = idx;
					}
				}
			}
		}
	}

	makeStage(): void {
		const w = this.width, h = this.height;
		const field = this.field, flips = this.flips;
		const total = w * h;
		let flipCount = 0;

		// Full sweep when most of the field is active (after fillField()/resize()/
		// setRules(), or under explosive rules): always correct, and cheaper than
		// the candidate bookkeeping once the change list stops being sparse.
		if (this.changedCount * 4 >= total) {
			for (let idx = 0; idx < total; idx++) {
				if (field[idx] !== this.nextState(idx)) flips[flipCount++] = idx;
			}
		} else {
			// A cell can only change if its 3×3 neighborhood contained a change
			// last generation: candidates = changed cells + their neighbors,
			// deduped via a generation stamp (never cleared, just outdated).
			const cand = this.candidates, stamp = this.stamp, changed = this.changed;
			const genMark = ++this.gen;
			let candCount = 0;
			for (let k = 0; k < this.changedCount; k++) {
				const idx = changed[k];
				const i = idx % w, j = (idx - i) / w;
				const iLo = i > 0 ? i - 1 : 0, iHi = i < w - 1 ? i + 1 : w - 1;
				const jLo = j > 0 ? j - 1 : 0, jHi = j < h - 1 ? j + 1 : h - 1;
				for (let nj = jLo; nj <= jHi; nj++) {
					for (let ni = iLo; ni <= iHi; ni++) {
						const nidx = nj * w + ni;
						if (stamp[nidx] !== genMark) {
							stamp[nidx] = genMark;
							cand[candCount++] = nidx;
						}
					}
				}
			}
			for (let k = 0; k < candCount; k++) {
				const idx = cand[k];
				if (field[idx] !== this.nextState(idx)) flips[flipCount++] = idx;
			}
		}

		// deferred flips keep the whole generation update simultaneous
		for (let k = 0; k < flipCount; k++) field[flips[k]] ^= 1;
		this.flips = this.changed;
		this.changed = flips;
		this.changedCount = flipCount;
	}

	private nextState(idx: number): number {
		const w = this.width, field = this.field;
		const i = idx % w, j = (idx - i) / w;
		if (i === 0 || i === w - 1 || j === 0 || j === this.height - 1) return 0;
		const c =
			field[idx - w - 1] + field[idx - w] + field[idx - w + 1] +
			field[idx - 1] + field[idx + 1] +
			field[idx + w - 1] + field[idx + w] + field[idx + w + 1];
		return ((field[idx] ? this.surviveMask : this.bornMask) >> c) & 1;
	}

	print(ctx: CanvasRenderingContext2D, bgColor: string, cellColor: string, stampColor: string): void {
		const palette = bgColor + '|' + cellColor + '|' + stampColor;
		if (palette !== this.lastPalette) {
			this.lastPalette = palette;
			this.needFullPrint = true; // theme changed: every pixel is stale
		}
		const bg = this.asPixel(bgColor);
		const fg = this.asPixel(cellColor);
		const accent = this.asPixel(stampColor);
		if (!this.img || !this.pixels) {
			this.img = ctx.createImageData(this.width, this.height);
			this.pixels = new Uint32Array(this.img.data.buffer);
			this.needFullPrint = true;
		}
		const field = this.field, pixels = this.pixels;
		// last frame's accent cells revert to their true colors
		for (let k = 0; k < this.prevStampCount; k++) {
			const idx = this.prevStamps[k];
			pixels[idx] = field[idx] ? fg : bg;
		}
		if (this.needFullPrint || this.changedCount >= field.length) {
			for (let idx = 0; idx < field.length; idx++) {
				pixels[idx] = field[idx] ? fg : bg;
			}
			this.needFullPrint = false;
		} else {
			const changed = this.changed;
			for (let k = 0; k < this.changedCount; k++) {
				const idx = changed[k];
				pixels[idx] = field[idx] ? fg : bg;
			}
		}
		// this frame's freshly stamped cells draw in the accent color
		for (let k = 0; k < this.stampCount; k++) {
			pixels[this.stamps[k]] = accent;
		}
		const swap = this.prevStamps;
		this.prevStamps = this.stamps;
		this.stamps = swap;
		this.prevStampCount = this.stampCount;
		this.stampCount = 0;
		ctx.putImageData(this.img, 0, 0);
	}

	// Resolves a CSS color to a little-endian ABGR pixel value; cached per input string.
	private asPixel(color: string): number {
		const hit = this.colorCache.get(color);
		if (hit !== undefined) return hit;
		// getComputedStyle yields "rgb(r, g, b)"; anything else (named colors,
		// hex) is normalized through a scratch canvas, whose fillStyle reads
		// back as "#rrggbb" for opaque colors.
		let rgb = LifeGame.parseColor(color);
		if (!rgb) {
			const scratch = document.createElement('canvas').getContext('2d');
			if (scratch) {
				scratch.fillStyle = color;
				rgb = LifeGame.parseColor(String(scratch.fillStyle));
			}
		}
		const { r, g, b } = rgb ?? { r: 128, g: 128, b: 128 };
		const value = (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
		this.colorCache.set(color, value);
		return value;
	}

	private static parseColor(color: string): { r: number; g: number; b: number } | null {
		const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
		if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
		const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
		if (hex) return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16) };
		return null;
	}
}
