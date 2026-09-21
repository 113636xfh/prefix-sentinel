// docs/probe-pixels.mjs — sample rendered pixel colors at expected element
// centers; guards against elements silently missing from the render.
// Rendered image is 1px per viewBox unit (no scale), so (x,y) maps directly
// into the RGBA buffer.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map();
function image(name) {
	if (!cache.has(name)) {
		const svg = readFileSync(join("docs/src", `${name}.svg`), "utf-8");
		cache.set(name, new Resvg(svg, { background: "#ffffff", fonts: { loadSystemFonts: true } }).render());
	}
	return cache.get(name);
}

function sample(name, x, y, r = 2) {
	const img = image(name);
	const W = img.width;
	const H = img.height;
	const d = img.pixels;
	const px = [];
	for (let dy = -r; dy <= r; dy++) {
		for (let dx = -r; dx <= r; dx++) {
			const i = ((Math.round(y) + dy) * W + Math.round(x) + dx) * 4;
			if (i >= 0 && i + 3 < d.length) px.push([d[i], d[i + 1], d[i + 2]]);
        }
    }
	const counts = new Map();
	for (const [cr, cg, cb] of px) {
		const key = `${cr},${cg},${cb}`;
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	const n = px.filter((p) => {
		const [er, eg, eb] = modal.split(",").map(Number);
		return Math.abs(p[0] - er) + Math.abs(p[1] - eg) + Math.abs(p[2] - eb) <= 24;
	}).length;
	return { modal, coverage: `${n}/${px.length}` };
}

let failed = false;
function expect(name, x, y, hex, label, opts = {}) {
	const solid = opts.solid !== false; // thin strokes: modal-only
	const s = sample(name, x, y);
	const target = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	const [mr, mg, mb] = s.modal.split(",").map(Number);
	const colorOk = Math.abs(mr - target[0]) + Math.abs(mg - target[1]) + Math.abs(mb - target[2]) <= 24;
	const [n, total] = s.coverage.split("/").map(Number);
	const solidOk = !solid || n / total >= 0.6; // allow text/AA pixels inside
	const ok = colorOk && solidOk;
	if (!ok) failed = true;
	console.log(`${ok ? "ok  " : "FAIL"} ${label} @(${x},${y}) expect ${hex} got modal ${s.modal} cov ${s.coverage}`);
}

// sample sets are layout-defined; zh and en figures share the same geometry
const loopChecks = (name) => {
	expect(name, 160, 184, "#f7f9fb", "node1 gray  fill");
	expect(name, 480, 184, "#eefaf3", "node2 green fill");
	expect(name, 800, 184, "#fdeacc", "node3 orange fill");
	expect(name, 1120, 184, "#eef3fb", "node4 blue  fill");
	const dashC = [0x94, 0xa3, 0xb8];
	let dash = 0;
	for (const x of [300, 400, 500, 600, 700, 800, 900, 1000]) {
		const s = sample(name, x, 300, 1);
		const [r, g, b] = s.modal.split(",").map(Number);
		if (Math.abs(r - dashC[0]) + Math.abs(g - dashC[1]) + Math.abs(b - dashC[2]) <= 24) dash++;
	}
	console.log(`${dash >= 3 ? "ok  " : "FAIL"} ${name} loop dash presence: ${dash}/8`);
	if (dash < 3) failed = true;
	expect(name, 20, 20, "#ffffff", "background");
};
const verdictChecks = (name) => {
	expect(name, 390, 130, "#f7f9fb", "trigger gray fill");
	expect(name, 480, 224, "#eefaf3", "gate A green fill");
	expect(name, 980, 224, "#eef3fb", "non-inference blue fill");
	expect(name, 480, 330, "#eefaf3", "step B green fill");
	expect(name, 480, 436, "#eefaf3", "gate C green fill");
	expect(name, 480, 542, "#eefaf3", "result A green fill");
	expect(name, 980, 436, "#f7f9fb", "result B gray fill");
	expect(name, 730, 224, "#d64545", "rail A red shaft", { solid: false });
	expect(name, 730, 436, "#d64545", "rail C red shaft", { solid: false });
	expect(name, 1260, 640, "#ffffff", "background");
};

for (const name of process.argv.slice(2)) {
	console.log(`\n=== ${name} ===`);
	name.includes("loop") ? loopChecks(name) : verdictChecks(name);
}
console.log(failed ? "PIXEL PROBE FAILED" : "PIXEL PROBE PASSED");
process.exit(failed ? 1 : 0);
