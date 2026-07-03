import { LifeGame } from "./LifeGame";

const canvas = document.getElementById("life") as HTMLCanvasElement;
const maybeCtx = canvas.getContext("2d");
if (!maybeCtx) throw new Error("Canvas 2D context not supported");
const ctx: CanvasRenderingContext2D = maybeCtx;

// One cell per CSS pixel: the field always matches the viewport size.
const game = new LifeGame(window.innerWidth, window.innerHeight);

function paint() {
	const style = getComputedStyle(document.body);
	const ripple = style.getPropertyValue("--ripple").trim() || "green";
	game.print(ctx, style.backgroundColor, style.color, ripple);
}

function resize() {
	canvas.width = window.innerWidth;
	canvas.height = window.innerHeight;
	game.resize(canvas.width, canvas.height);
	// setting canvas.width/height clears the canvas; repaint the preserved field
	paint();
	// restart the wanderer inside the new bounds
	if (god.enabled) initGod();
}

// Debounced: live window-dragging fires a resize event per pixel, which would
// splice in sliver-thin soup strips (too narrow to survive) and reallocate
// the buffers on every event. Until it fires, CSS stretches the old frame.
let resizeTimer = 0;
function scheduleResize() {
	clearTimeout(resizeTimer);
	resizeTimer = window.setTimeout(resize, 200);
}

// --- click ripples: three staggered wavefronts expanding from the click ---

interface Ripple { x: number; y: number; r: number }
const ripples: Ripple[] = [];
const RIPPLE_WAVES = 3;
const RIPPLE_SPACING = 20;  // cells between wavefronts
const RIPPLE_SPEED = 1.25;  // cells per frame
const RIPPLE_MAX_R = 120;
const RIPPLE_THICKNESS = 2; // thicker fronts leave a longer-lived wake

function dropRipples(x: number, y: number) {
	for (let wave = 0; wave < RIPPLE_WAVES; wave++) {
		ripples.push({ x, y, r: -wave * RIPPLE_SPACING });
	}
}

canvas.addEventListener("click", (e) => {
	dropRipples(e.offsetX, e.offsetY);
});

// --- god's touch: an invisible point wandering along a random spline,
// dropping ripples as it goes ---

interface Pt { x: number; y: number }

const GOD_SPEED = 7;            // px per frame along the path
const GOD_TRAIL_FRAMES = 90;    // how long a trail point stays visible
const GOD_DROP_MIN = 60;        // frames between ripple drops (random range)
const GOD_DROP_MAX = 200;
const GOD_POINT_RADIUS = 5;
const GOD_SHARP_TURN_DEG = 50;  // heading change that counts as a sharp bend
const GOD_SHARP_COOLDOWN = 45;  // frames before another bend may drop

const god = {
	enabled: false,
	pts: [] as Pt[],  // rolling Catmull-Rom control points p0..p3
	t: 0,             // parameter within the p1->p2 segment
	trail: [] as { x: number; y: number; age: number }[],
	untilDrop: 0,
	sharpCooldown: 0,
};

function randomWaypoint(prev: Pt): Pt {
	const margin = 30;
	// Retry short hops: edge clamping can otherwise put two control points
	// almost on top of each other, and the near-zero segment breaks the
	// constant-speed stepping in advanceGod().
	for (let attempt = 0; ; attempt++) {
		// longer hops keep the curves sweeping rather than twitchy at high speed
		const len = 250 + Math.random() * 350;
		const a = Math.random() * 2 * Math.PI;
		const wp = {
			x: Math.min(Math.max(prev.x + len * Math.cos(a), margin), canvas.width - margin),
			y: Math.min(Math.max(prev.y + len * Math.sin(a), margin), canvas.height - margin),
		};
		if (attempt >= 9 || Math.hypot(wp.x - prev.x, wp.y - prev.y) >= 80) return wp;
	}
}

function initGod() {
	const start = {
		x: canvas.width * (0.2 + Math.random() * 0.6),
		y: canvas.height * (0.2 + Math.random() * 0.6),
	};
	god.pts = [start];
	while (god.pts.length < 4) god.pts.push(randomWaypoint(god.pts[god.pts.length - 1]));
	god.t = 0;
	god.trail.length = 0;
	god.untilDrop = GOD_DROP_MIN;
	god.sharpCooldown = 0;
}

function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
	const t2 = t * t, t3 = t2 * t;
	return {
		x: 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
		y: 0.5 * (2 * p1.y + (p2.y - p0.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3),
	};
}

function advanceGod() {
	// Walk the remaining travel distance across as many segments as needed,
	// so t always stays inside [0,1) — evaluating the cubic outside its
	// domain extrapolates and teleports the dot.
	let travel = GOD_SPEED;
	for (;;) {
		const p1 = god.pts[1], p2 = god.pts[2];
		const segment = Math.max(Math.hypot(p2.x - p1.x, p2.y - p1.y), 1);
		const remaining = (1 - god.t) * segment;
		if (travel < remaining) {
			god.t += travel / segment;
			break;
		}
		// the path is extended forward with a fresh random waypoint
		travel -= remaining;
		god.t = 0;
		god.pts.shift();
		god.pts.push(randomWaypoint(god.pts[god.pts.length - 1]));
	}
	const pos = catmullRom(god.pts[0], god.pts[1], god.pts[2], god.pts[3], god.t);
	for (const p of god.trail) p.age++;
	while (god.trail.length && god.trail[0].age > GOD_TRAIL_FRAMES) god.trail.shift();
	god.trail.push({ x: pos.x, y: pos.y, age: 0 });
	if (--god.untilDrop <= 0) {
		dropRipples(Math.round(pos.x), Math.round(pos.y));
		god.untilDrop = GOD_DROP_MIN + Math.random() * (GOD_DROP_MAX - GOD_DROP_MIN);
	}
	// deterministic ripple when the path bends sharply: compare the heading
	// of the last two ~5-frame arcs and drop at the corner point
	if (god.sharpCooldown > 0) god.sharpCooldown--;
	const n = god.trail.length;
	if (god.sharpCooldown === 0 && n > 10) {
		const a = god.trail[n - 11], b = god.trail[n - 6], head = god.trail[n - 1];
		const h1 = Math.atan2(b.y - a.y, b.x - a.x);
		const h2 = Math.atan2(head.y - b.y, head.x - b.x);
		let turn = Math.abs(h2 - h1);
		if (turn > Math.PI) turn = 2 * Math.PI - turn;
		if (turn > (GOD_SHARP_TURN_DEG * Math.PI) / 180) {
			dropRipples(Math.round(b.x), Math.round(b.y));
			god.sharpCooldown = GOD_SHARP_COOLDOWN;
		}
	}
}

// Overlay on top of the blitted field: putImageData replaces every pixel each
// frame, so the trail and point are redrawn (and old ones erased) for free.
// Drawn in the ripple accent color; the tail fades out with age.
function drawGod() {
	if (god.trail.length < 2) return;
	const color = getComputedStyle(document.body).getPropertyValue("--ripple").trim() || "green";
	ctx.save();
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = 1.5;
	ctx.lineCap = "round";
	for (let k = 1; k < god.trail.length; k++) {
		const seg = god.trail[k];
		ctx.globalAlpha = 0.5 * (1 - seg.age / GOD_TRAIL_FRAMES);
		ctx.beginPath();
		ctx.moveTo(god.trail[k - 1].x, god.trail[k - 1].y);
		ctx.lineTo(seg.x, seg.y);
		ctx.stroke();
	}
	const head = god.trail[god.trail.length - 1];
	ctx.globalAlpha = 0.5;
	ctx.beginPath();
	ctx.arc(head.x, head.y, GOD_POINT_RADIUS, 0, 2 * Math.PI);
	ctx.fill();
	ctx.restore();
}

// Stamps the wavefront from the real center plus image-source reflections:
// centers mirrored across each wall (and corner). A mirrored ring reaches
// the field exactly when the real wave would hit that edge, so ripples
// bounce back with correct timing and curvature.
function stampWave(x: number, y: number, r: number) {
	const w = canvas.width, h = canvas.height;
	const xs = [x, -x, 2 * (w - 1) - x];
	const ys = [y, -y, 2 * (h - 1) - y];
	for (const mx of xs) {
		for (const my of ys) {
			if (mx + r <= 0 || mx - r >= w - 1 || my + r <= 0 || my - r >= h - 1) continue;
			game.stampRing(mx, my, r, RIPPLE_THICKNESS);
		}
	}
}

function tick() {
	if (god.enabled) advanceGod();
	for (let k = ripples.length - 1; k >= 0; k--) {
		const ripple = ripples[k];
		ripple.r += RIPPLE_SPEED;
		if (ripple.r > 0) stampWave(ripple.x, ripple.y, ripple.r);
		if (ripple.r >= RIPPLE_MAX_R) {
			ripples.splice(k, 1);
		}
	}
	paint();
	if (god.enabled && !godHideBox.checked) drawGod();
	game.makeStage();
	requestAnimationFrame(tick);
}

// --- control panel ---

const born = new Set([3]);
const survive = new Set([2, 3]);
const bornBoxes: HTMLInputElement[] = [];
const surviveBoxes: HTMLInputElement[] = [];

const rules = document.getElementById("rules")!;
rules.appendChild(document.createElement("span"));
for (let n = 0; n <= 8; n++) {
	const digit = document.createElement("span");
	digit.textContent = String(n);
	rules.appendChild(digit);
}
function addRuleRow(name: string, hint: string, set: Set<number>, boxes: HTMLInputElement[]) {
	const label = document.createElement("span");
	label.className = "rowlabel";
	label.textContent = name;
	label.title = hint;
	rules.appendChild(label);
	for (let n = 0; n <= 8; n++) {
		const box = document.createElement("input");
		box.type = "checkbox";
		box.checked = set.has(n);
		box.title = `${name}${n}`;
		box.addEventListener("change", () => {
			if (box.checked) set.add(n); else set.delete(n);
			game.setRules(born, survive);
			refreshPresets();
		});
		boxes.push(box);
		rules.appendChild(box);
	}
}
addRuleRow("B", "Born: a dead cell comes alive with this many neighbours", born, bornBoxes);
addRuleRow("S", "Survive: a live cell stays alive with this many neighbours", survive, surviveBoxes);

// --- rule presets: the three configs from the README ---

const PRESETS = [
	{ name: "Conway", born: [3], survive: [2, 3] },
	{ name: "HighLife", born: [3, 6], survive: [2, 3] },
	{ name: "Maze", born: [3], survive: [1, 2, 3, 4, 5] },
];
const presetButtons: HTMLButtonElement[] = [];
const presets = document.getElementById("presets")!;
for (const preset of PRESETS) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = preset.name;
	btn.title = `B${preset.born.join("")}/S${preset.survive.join("")}`;
	btn.addEventListener("click", () => {
		born.clear();
		for (const n of preset.born) born.add(n);
		survive.clear();
		for (const n of preset.survive) survive.add(n);
		for (let n = 0; n <= 8; n++) {
			bornBoxes[n].checked = born.has(n);
			surviveBoxes[n].checked = survive.has(n);
		}
		game.setRules(born, survive);
		refreshPresets();
	});
	presetButtons.push(btn);
	presets.appendChild(btn);
}

function sameSet(set: Set<number>, arr: number[]): boolean {
	return set.size === arr.length && arr.every(n => set.has(n));
}
function refreshPresets() {
	PRESETS.forEach((preset, i) => {
		presetButtons[i].classList.toggle("active",
			sameSet(born, preset.born) && sameSet(survive, preset.survive));
	});
}
refreshPresets();

document.getElementById("restart")!.addEventListener("click", () => {
	game.fillField();
});

const godBox = document.getElementById("god") as HTMLInputElement;
const godHideBox = document.getElementById("god-hide") as HTMLInputElement;
godBox.addEventListener("change", () => {
	god.enabled = godBox.checked;
	if (god.enabled) initGod();
	else god.trail.length = 0;
});
god.enabled = godBox.checked; // checked by default; initGod() runs in resize()

window.addEventListener("resize", scheduleResize);
resize();
requestAnimationFrame(tick);
