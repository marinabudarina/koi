import { useEffect, useRef } from "react";

/* ---------------------------------------------------------------------------
 * Skinned koi, WebGL edition.
 *
 * Each painted butterfly-koi sprite (/images/koi*.png, head on the right) is
 * stretched over a COLS x ROWS mesh. Every frame the CPU deforms the mesh:
 *   - the mesh follows a procedural spine (follow-chain + travelling S-wave),
 *   - fins, barbels and the long silk tail get their own slow "fabric" waves
 *     whose amplitude grows with the distance from the spine,
 *   - the thin silk parts are rendered semi-transparent with a shimmering
 *     alpha so they read as translucent cloth drifting in water.
 * Stars and the dropped coins stay on a cheap 2D canvas underneath.
 * ------------------------------------------------------------------------- */

type Vec = { x: number; y: number };

type Mesh = {
  pos: Float32Array;
  alpha: Float32Array;
  posBuf: WebGLBuffer;
  alphaBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  idxCount: number;
};

type Fish = {
  pts: Vec[];
  rp: Vec[];
  nx: Float32Array;
  ny: Float32Array;
  angs: number[];
  heading: number;
  turnVel: number;
  speed: number;
  baseSpeed: number;
  dart: number;
  goal: Vec | null;
  goalT: number;
  phase: number;
  fabric: number; // slow clock for the silk
  length: number; // on-screen length of the whole sprite (nose to tail tip)
  height: number; // on-screen height of the sprite
  segLen: number;
  wander: Vec;
  wanderT: number;
  target: Vec;
  orbitAngle: number;
  orbitRadius: number;
  orbitDir: number;
  seed: number;
  tex: WebGLTexture;
  mesh: Mesh;
  cellMask: Uint8Array;
  bodyStart: number; // sprite x fraction where the body begins (tail root)
  lobeAng: number[]; // lagging headings of the three tail lobes (ribbon physics)
  lobeSwing: number[]; // current swing of each lobe relative to the tail stem (radians)
  blocked: number; // how much another fish's body sat right in front of the nose last step
};

type Star = { x: number; y: number; r: number; phase: number; speed: number };
type Coin = {
  x: number; // where it lands
  y: number;
  t: number; // age in seconds
  fall: number; // seconds spent falling before it hits
  r: number; // radius on screen
  spin: number; // tumble phase while falling
  spinV: number; // tumble speed
  rest: number; // final resting tilt
  splashed: boolean;
};

const BASE = import.meta.env.BASE_URL;
const SPRITES = [
  `${BASE}images/koi.png`,
  `${BASE}images/koi-white.png`,
  `${BASE}images/koi-black.png`,
  `${BASE}images/koi-asagi.png`,
  `${BASE}images/koi-gold.png`,
];
export const MAX_FISH = SPRITES.length;
/** sprite x fraction where the body (not tail) begins, per sprite: the black koi has a longer veil tail */
const SPRITE_BODY_START = [0.3, 0.3, 0.42, 0.38, 0.37];
/** how quickly each tail lobe (upper, lower-outer, lower-inner) catches up with the stem */
const LOBE_RATE = [4.4, 2.4, 6.5, 3.4, 5.2];
const COIN_REST = 6.5; // seconds a dropped coin lies on the bottom before it fades
const COIN_FADE = 1.2;
const COLS = 72; // mesh columns along the body
const ROWS = 28; // mesh rows across the body
const N = COLS + 1; // spine points
const SPINE_Y = 0.465; // spine position in the sprite (fraction of height)
const BODY_HALF = 0.11; // half-width of the solid body (fraction of sprite height)

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ----------------------------- WebGL helpers ----------------------------- */

const VERT = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute float aAlpha;
uniform vec2 uRes;
uniform vec2 uOffset;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec2 p = (aPos + uOffset) / uRes * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  vUv = aUv;
  vAlpha = aAlpha;
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform float uShadow;
uniform float uAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uTex, vUv); // premultiplied
  float a = vAlpha * uAlpha;
  if (uShadow > 0.5) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, t.a * a);
  } else {
    gl_FragColor = t * a;
  }
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn(gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

function createProgram(gl: WebGLRenderingContext) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function createTexture(gl: WebGLRenderingContext, img: HTMLImageElement, isGl2: boolean) {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (isGl2) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  return tex;
}

/** Which mesh cells actually contain paint (so empty sprite corners are never drawn). */
function buildCellMask(img: HTMLImageElement): Uint8Array {
  const mask = new Uint8Array(COLS * ROWS);
  const c = document.createElement("canvas");
  c.width = COLS * 4;
  c.height = ROWS * 4;
  const ctx = c.getContext("2d");
  if (!ctx) return mask.fill(1);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const raw = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 4) raw[Math.floor(y / 4) * COLS + Math.floor(x / 4)] = 1;
    }
  }
  // dilate by one cell so soft edges survive the deformation
  for (let r = 0; r < ROWS; r++) {
    for (let cc = 0; cc < COLS; cc++) {
      let on = 0;
      for (let dr = -1; dr <= 1 && !on; dr++) {
        for (let dc = -1; dc <= 1 && !on; dc++) {
          const rr = r + dr;
          const c2 = cc + dc;
          if (rr >= 0 && rr < ROWS && c2 >= 0 && c2 < COLS && raw[rr * COLS + c2]) on = 1;
        }
      }
      mask[r * COLS + cc] = on;
    }
  }
  return mask;
}

function buildMesh(gl: WebGLRenderingContext, cellMask: Uint8Array): Mesh | null {
  const vcount = (COLS + 1) * (ROWS + 1);
  const uv = new Float32Array(vcount * 2);
  for (let r = 0; r <= ROWS; r++) {
    for (let c = 0; c <= COLS; c++) {
      const k = (r * (COLS + 1) + c) * 2;
      uv[k] = c / COLS;
      uv[k + 1] = r / ROWS;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!cellMask[r * COLS + c]) continue;
      const a = r * (COLS + 1) + c;
      const b = a + 1;
      const d = a + (COLS + 1);
      const e = d + 1;
      idx.push(a, b, e, a, e, d);
    }
  }
  const posBuf = gl.createBuffer();
  const alphaBuf = gl.createBuffer();
  const uvBuf = gl.createBuffer();
  const idxBuf = gl.createBuffer();
  if (!posBuf || !alphaBuf || !uvBuf || !idxBuf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  return {
    pos: new Float32Array(vcount * 2),
    alpha: new Float32Array(vcount),
    posBuf,
    alphaBuf,
    uvBuf,
    idxBuf,
    idxCount: idx.length,
  };
}

/* ------------------------------- the fish -------------------------------- */

function makeFish(
  w: number,
  h: number,
  length: number,
  img: HTMLImageElement,
  tex: WebGLTexture,
  mesh: Mesh,
  cellMask: Uint8Array,
  bodyStart: number,
): Fish {
  const x = rand(w * 0.3, w * 0.7);
  const y = rand(h * 0.3, h * 0.7);
  const heading = rand(-Math.PI, Math.PI);
  const segLen = length / (N - 1);
  const pts: Vec[] = [];
  for (let k = 0; k < N; k++) {
    pts.push({ x: x - Math.cos(heading) * segLen * k, y: y - Math.sin(heading) * segLen * k });
  }
  const baseSpeed = length * 0.1;
  return {
    pts,
    rp: pts.map((p) => ({ ...p })),
    nx: new Float32Array(N),
    ny: new Float32Array(N),
    angs: Array.from({ length: N }, () => heading + Math.PI),
    heading,
    turnVel: 0,
    speed: baseSpeed,
    baseSpeed,
    dart: 0,
    goal: null,
    goalT: 0,
    phase: rand(0, Math.PI * 2),
    fabric: rand(0, 100),
    length,
    height: (length * img.naturalHeight) / img.naturalWidth,
    segLen,
    wander: { x: rand(w * 0.2, w * 0.8), y: rand(h * 0.2, h * 0.8) },
    wanderT: rand(1, 4),
    target: { x, y },
    orbitAngle: rand(0, Math.PI * 2),
    orbitRadius: length * 0.22,
    orbitDir: Math.random() > 0.5 ? 1 : -1,
    seed: rand(0, 10),
    tex,
    mesh,
    cellMask,
    bodyStart,
    lobeAng: [heading + Math.PI, heading + Math.PI, heading + Math.PI],
    lobeSwing: [0, 0, 0],
    blocked: 0,
  };
}

/** place a freshly made fish just outside a random stage edge, nose pointing in, so it swims into view */
function enterFromEdge(f: Fish, w: number, h: number) {
  const side = Math.floor(rand(0, 4));
  const pad = f.length * 0.2;
  let x: number;
  let y: number;
  if (side === 0) {
    x = -pad;
    y = rand(h * 0.25, h * 0.75);
  } else if (side === 1) {
    x = w + pad;
    y = rand(h * 0.25, h * 0.75);
  } else if (side === 2) {
    x = rand(w * 0.25, w * 0.75);
    y = -pad;
  } else {
    x = rand(w * 0.25, w * 0.75);
    y = h + pad;
  }
  const heading = Math.atan2(h / 2 - y, w / 2 - x);
  f.heading = heading;
  for (let k = 0; k < N; k++) {
    f.pts[k].x = x - Math.cos(heading) * f.segLen * k;
    f.pts[k].y = y - Math.sin(heading) * f.segLen * k;
    f.rp[k].x = f.pts[k].x;
    f.rp[k].y = f.pts[k].y;
    f.angs[k] = heading + Math.PI;
  }
  f.lobeAng = [heading + Math.PI, heading + Math.PI, heading + Math.PI];
  f.wander = { x: w / 2 + rand(-w * 0.2, w * 0.2), y: h / 2 + rand(-h * 0.2, h * 0.2) };
  f.wanderT = rand(3, 5);
  f.dart = 2;
}

function updateFish(f: Fish, all: Fish[], dt: number, w: number, h: number, pointer: Vec | null) {
  const head = f.pts[0];
  let target: Vec | null = null;
  let urgency = 1;
  let thrust = 1; // scales the dart burst; eases off when approaching a click
  if (f.goal) {
    // called by a click: swim straight to the point, fast, brake on approach, then orbit it
    const dist = Math.hypot(f.goal.x - head.x, f.goal.y - head.y);
    f.goalT -= dt;
    if (dist < f.length * 0.1 || f.goalT <= 0 || (dist < f.length * 0.5 && f.blocked > 0.35)) {
      // arrived - or another fish already sits on the coin and bars the way: settle for orbiting it
      f.goal = null;
      f.dart = 0;
    } else {
      target = f.goal;
      // rush straight at the coin: full burst as soon as the nose roughly points there,
      // braking only over the last quarter length so the fish does not overshoot
      const align = (1 + Math.cos(norm(Math.atan2(f.goal.y - head.y, f.goal.x - head.x) - f.heading))) / 2;
      // a fish facing the wrong way turns on the spot first (no burst into the wrong direction)
      thrust = clamp(dist / (f.length * 0.25), 0, 1) * Math.pow(align, 1.5);
      urgency = 1 + (1.8 + clamp(dist / f.length, 0, 2)) * thrust;
    }
  }
  if (target) {
    // heading for a click
  } else if (pointer) {
    f.orbitAngle += f.orbitDir * dt * 0.4;
    target = {
      x: pointer.x + Math.cos(f.orbitAngle) * f.orbitRadius,
      y: pointer.y + Math.sin(f.orbitAngle) * f.orbitRadius,
    };
    const dist = Math.hypot(pointer.x - head.x, pointer.y - head.y);
    urgency = 1 + clamp((dist - f.orbitRadius) / (f.length * 0.8), 0, 1.3);
  } else {
    f.wanderT -= dt;
    const dx = f.wander.x - head.x;
    const dy = f.wander.y - head.y;
    if (f.wanderT <= 0 || dx * dx + dy * dy < 120 * 120) {
      f.wander = { x: rand(w * 0.15, w * 0.85), y: rand(h * 0.15, h * 0.85) };
      f.wanderT = rand(4, 9);
    }
    target = f.wander;
  }

  // never aim outside the stage (orbits around a corner click would drag the head off screen)
  const m = f.length * 0.14;
  target = { x: clamp(target.x, m, w - m), y: clamp(target.y, m, h - m) };

  // ease towards the target so pointer jumps never jerk the head
  const ease = Math.min(1, dt * (f.goal ? 6 : pointer ? 2.2 : 1.2));
  f.target.x += (target.x - f.target.x) * ease;
  f.target.y += (target.y - f.target.y) * ease;
  let desired = Math.atan2(f.target.y - head.y, f.target.x - head.x);

  // keep away from the other fishes' bodies: the fish all live on one depth layer and
  // must never swim over one another -> the head steers around every other spine
  let block = 0; // how much another body sits right in front of the nose
  const hx = Math.cos(f.heading);
  const hy = Math.sin(f.heading);
  for (const o of all) {
    if (o === f) continue;
    const minD = (f.length + o.length) * 0.105 + (f.height + o.height) * 0.15;
    // spine points of the other fish; skip the far silk of the tail, it is sheer anyway
    const lastIdx = Math.floor((N - 1) * (1 - f.bodyStart * 0.5));
    for (let i = 0; i <= lastIdx; i += 3) {
      const q = o.pts[i];
      const dx = head.x - q.x;
      const dy = head.y - q.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= minD || dist < 0.01) continue;
      const k = (minD - dist) / minD;
      // push the heading away from the body point; heads repel harder than flanks
      const away = Math.atan2(dy, dx);
      // a fish rushing to a click steers around the others harder (its goal pull is stronger too)
      const strength = (i === 0 ? 1.1 : 0.75) * (f.goal ? 1.7 : 1);
      desired = norm(desired + norm(away - desired) * k * strength);
      // if the body is ahead of us, brake so we never ram through it
      const ahead = (-dx * hx - dy * hy) / dist;
      if (ahead > 0.2) block = Math.max(block, k * ahead);
    }
  }

  f.blocked = clamp(block, 0, 1);

  // keep the head on screen (tail may trail off)
  const over = Math.max(m - head.x, head.x - (w - m), m - head.y, head.y - (h - m), 0);
  let edgeBoost = 1;
  if (over > 0) {
    const toC = Math.atan2(h / 2 - head.y, w / 2 - head.x);
    const k = clamp(over / m, 0, 1);
    desired = norm(desired + norm(toC - desired) * (0.6 + 0.4 * k));
    edgeBoost = 1 + k * 2.5; // the closer to leaving the screen, the sharper the turn back
  }

  // steering with inertia
  const diff = norm(desired - f.heading);
  const maxTurn = (0.55 + (f.dart > 0 ? 1.6 : 0)) * (600 / Math.max(400, f.length)) * edgeBoost;
  const wantVel = clamp(diff * (f.goal ? 3 : 1.1), -maxTurn, maxTurn);
  f.turnVel += (wantVel - f.turnVel) * Math.min(1, dt * (f.goal ? 6 : 1.7));
  f.heading = norm(f.heading + f.turnVel * dt);

  // speed
  f.dart = Math.max(0, f.dart - dt);
  const targetSpeed =
    (f.baseSpeed * urgency + (f.dart > 0 ? f.length * 0.75 * clamp(f.dart / 2.5, 0, 1) * thrust : 0)) *
    (1 - 0.65 * clamp(block, 0, 1));
  // quick to accelerate on a dart, quicker still to brake (water drag), lazy otherwise
  const speedEase = f.speed > targetSpeed ? 3 : f.goal ? 3.5 : 1.1;
  f.speed += (targetSpeed - f.speed) * Math.min(1, dt * speedEase);
  const rel = f.speed / f.baseSpeed;
  // tail-beat frequency rises with speed (slow glide ~0.5 Hz, dart ~1.3 Hz)
  f.phase += dt * (2.2 + rel * 1.5);
  f.fabric += dt * (0.9 + rel * 0.35);
  const pulse = 1 + 0.05 * Math.sin(f.phase * 2);
  // the head itself yaws a little with each stroke -> the chain forms an S instead of one arc
  const moveA = f.heading + Math.sin(f.phase) * 0.1;

  head.x += Math.cos(moveA) * f.speed * pulse * dt;
  head.y += Math.sin(moveA) * f.speed * pulse * dt;

  // follow chain, stiffer along the body, looser in the tail
  for (let i = 1; i < N; i++) {
    const prev = f.pts[i - 1];
    const cur = f.pts[i];
    const t = i / (N - 1);
    const inTail = t >= 1 - f.bodyStart;
    const maxBend = (inTail ? 0.062 : 0.055) * (46 / N);
    const raw = Math.atan2(cur.y - prev.y, cur.x - prev.x);
    const prevAng = i >= 2 ? f.angs[i - 1] : moveA + Math.PI;
    const d = norm(raw - prevAng);
    // the silk tail has no muscle: it slowly straightens out instead of keeping a hook
    const relax = inTail ? 1 - Math.min(0.5, dt * 2.2) : 1;
    f.angs[i] = prevAng + Math.tanh(d / maxBend) * maxBend * relax;
  }
  // tail lobes as ribbons: each hangs off the tail root at its own lagging heading. When the body
  // strokes or the fish turns, the lobes swing out and catch up at different rates, so they peel
  // off one after another instead of swinging as one sheet.
  const rootAng = f.angs[Math.min(N - 1, Math.round((N - 1) * (1 - f.bodyStart)))];
  for (let k = 0; k < 3; k++) {
    const rate = LOBE_RATE[k];
    const a = f.lobeAng[k] + norm(rootAng - f.lobeAng[k]) * Math.min(1, dt * rate);
    f.lobeAng[k] = a;
    f.lobeSwing[k] = clamp(norm(a - rootAng), -0.42, 0.42);
  }
  // light curvature smoothing along the spine
  let prevA = f.angs[1];
  for (let i = 2; i < N - 1; i++) {
    const a0 = prevA;
    const a1 = f.angs[i];
    const a2 = f.angs[i + 1];
    prevA = a1;
    f.angs[i] = a1 + (norm(a0 - a1) + norm(a2 - a1)) * 0.18;
  }
  for (let i = 1; i < N; i++) {
    const prev = f.pts[i - 1];
    f.pts[i].x = prev.x + Math.cos(f.angs[i]) * f.segLen;
    f.pts[i].y = prev.y + Math.sin(f.angs[i]) * f.segLen;
  }

  // render points: travelling S-wave along the body, bigger and slower in the tail
  const swim = clamp(0.55 + rel * 0.45, 0.6, 1.6); // faster -> bigger strokes
  const bodyAmp = f.length * 0.055 * swim;
  const tailAmp = f.length * 0.028 * swim; // the stem only; the lobes add their own motion in deformMesh
  for (let i = 0; i < N; i++) {
    const a = i === 0 ? f.pts[0] : f.pts[i - 1];
    const b = i === 0 ? f.pts[1] : f.pts[i];
    const d = Math.atan2(a.y - b.y, a.x - b.x);
    const t = i / (N - 1);
    const bodyT = clamp(t / (1 - f.bodyStart), 0, 1); // 0 nose .. 1 tail root
    const tailT = clamp((t - (1 - f.bodyStart - 0.08)) / (f.bodyStart + 0.08), 0, 1);
    // envelope: ~12% at the nose, dips behind the head (the body's pivot), then grows quadratically
    const env = 0.12 + 0.88 * bodyT * bodyT - 0.08 * Math.sin(bodyT * Math.PI);
    const amp = bodyAmp * env + tailAmp * Math.pow(tailT, 1.4);
    // one full wavelength over the body, the tail lags behind by a quarter stroke
    const off = Math.sin(f.phase - bodyT * Math.PI * 2 - tailT * 1.6) * amp;
    f.rp[i].x = f.pts[i].x - Math.sin(d) * off;
    f.rp[i].y = f.pts[i].y + Math.cos(d) * off;
  }
  // normals (perpendicular to the local spine direction)
  for (let i = 0; i < N; i++) {
    const a = f.rp[Math.max(0, i - 1)];
    const b = f.rp[Math.min(N - 1, i + 1)];
    const len = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    f.nx[i] = -(a.y - b.y) / len;
    f.ny[i] = (a.x - b.x) / len;
  }
}

/** Deform the mesh: spine + fins/tail/barbel fabric waves + translucency. */
function deformMesh(f: Fish) {
  const { pos, alpha } = f.mesh;
  const L = f.length;
  const H = f.height;
  const T = f.fabric;
  const S = f.seed;
  for (let r = 0; r <= ROWS; r++) {
    const v = r / ROWS;
    const dv = v - SPINE_Y; // signed lateral offset (fraction of sprite height)
    const dAbs = Math.abs(dv);
    const side = dv < 0 ? -1 : 1;
    const finness = smooth(BODY_HALF, BODY_HALF + 0.16, dAbs); // 0 on the body, 1 far out on the silk
    const reach = clamp(dAbs / 0.5, 0, 1); // how far out on the fin we are
    for (let c = 0; c <= COLS; c++) {
      const u = c / COLS; // 0 = tail tip, 1 = nose
      const i = COLS - c; // spine index (0 = head)
      const p = f.rp[i];
      const nx = f.nx[i];
      const ny = f.ny[i];
      const tx = ny; // tangent (towards the head)
      const ty = -nx;

      const tailness = smooth(f.bodyStart + 0.08, 0.02, u);
      const tipness = smooth(f.bodyStart + 0.08, 0, u); // 0 at the tail root .. 1 at the very tip
      const whisker = smooth(0.9, 0.98, u) * smooth(0.05, 0.1, dAbs);

      // --- fins on the body: slow, spatially smooth fabric waves growing away from the spine
      const finAmp = L * (0.0045 + 0.012 * finness) * (0.3 + 0.7 * reach) * (1 - tailness) * (finness > 0 ? 1 : 0);
      const w1 = Math.sin(T * 1.9 - u * 7.5 + dAbs * 4.5 + S);
      const w2 = Math.sin(T * 1.25 + u * 4.2 - dv * 7.0 + S * 1.7 + 1.3);
      let offN = finAmp * (0.65 * w1 + 0.35 * w2);
      let offT = finAmp * 0.55 * Math.sin(T * 1.45 - u * 6 + dv * 5 + S * 0.4);

      // --- fins on the body (pectoral / pelvic / dorsal): a gentle paddling sway
      const finSway = finness * (1 - tailness) * reach;
      offN += L * 0.012 * finSway * Math.sin(T * 2.3 + side * 1.1 + u * 3 + S);
      offT += L * 0.008 * finSway * Math.sin(T * 1.7 + side * 2.4 + S);

      // --- barbels (whiskers) at the nose: flick softly
      offN += L * 0.011 * whisker * Math.sin(T * 3.1 + side * 1.4 + S * 2) * (reach * 4);
      offT += L * 0.004 * whisker * Math.sin(T * 2.2 + S);

      // --- tail: three silk lobes (upper, lower-outer, lower-inner) hanging off a stiff stem.
      // Each lobe has its own fabric clock and its own lag behind the stroke, so they fold and
      // flutter independently instead of swinging as one sheet. The weights blend smoothly,
      // so the mesh never tears between lobes.
      if (tailness > 0) {
        const outer = smooth(0.04, 0.16, dAbs); // 0 on the stem, 1 out on the lobes
        const lowerSplit = smooth(f.bodyStart - 0.03, f.bodyStart - 0.13, u); // lower silk: 1 = tip-ward lobe, 0 = inner lobe
        const lobeA = dv < 0 ? outer : 0;
        const lobeB = dv > 0 ? outer * lowerSplit : 0;
        const lobeC = dv > 0 ? outer * (1 - lowerSplit) : 0;
        const stem = 1 - outer;
        const dist = Math.max(0, f.bodyStart - u) * L; // distance from the tail root along the tail
        // --- each lobe rotates about the tail root: the lag it accumulated behind the stem (ribbon
        // physics, see updateFish) plus its own stroke swing and a slow breathing wobble
        const swingA = f.lobeSwing[0] + 0.15 * Math.sin(f.phase - 1.1) + 0.05 * Math.sin(T * 1.7 + S);
        const swingB = f.lobeSwing[1] + 0.1 * Math.sin(f.phase - 2.7) + 0.07 * Math.sin(T * 1.1 + S + 2);
        const swingC = f.lobeSwing[2] + 0.19 * Math.sin(f.phase - 1.9) + 0.04 * Math.sin(T * 2.4 + S + 4);
        const swing = lobeA * swingA + lobeB * swingB + lobeC * swingC + stem * 0.35 * f.lobeSwing[1];
        offN -= Math.sin(swing) * dist;
        offT -= (1 - Math.cos(swing)) * dist * 0.6;
        // --- fabric ripples inside each lobe: a wave travelling along it plus a fold across it,
        // every lobe on its own clock
        const grow = tailness * (0.2 + 0.8 * tipness) * (0.25 + 0.75 * reach);
        const amp = L * 0.03 * grow;
        const fa = Math.sin(T * 1.7 - u * 6.5 + dv * 3.5 + S) * 0.7 + Math.sin(T * 2.6 + dv * 11 - u * 3 + S * 1.4) * 0.3;
        const fb = Math.sin(T * 1.15 - u * 8 + dv * 5 + S * 1.3 + 2.1) * 0.7 + Math.sin(T * 1.6 + dv * 9 + S * 0.8 + 1) * 0.3;
        const fc = Math.sin(T * 2.4 - u * 5 + dv * 6 + S * 0.7 + 4.0) * 0.7 + Math.sin(T * 2.9 - dv * 8 + u * 4 + S * 2) * 0.3;
        const fs = Math.sin(T * 1.3 - u * 5 + S * 0.5);
        offN += amp * (lobeA * fa + lobeB * fb + lobeC * fc + stem * 0.3 * fs);
        // --- and they slide back and forth along the body as the cloth drags in the water
        offT +=
          L * 0.014 * grow * outer *
          (lobeA * Math.sin(T * 1.5 - u * 5 + S) +
            lobeB * Math.sin(T * 1.9 - u * 6 + S + 1) +
            lobeC * Math.sin(T * 1.2 - u * 4 + S + 2));
      }

      const lateral = dv * H + offN;
      const k = (r * (COLS + 1) + c) * 2;
      pos[k] = p.x + nx * lateral + tx * offT;
      pos[k + 1] = p.y + ny * lateral + ty * offT;

      // --- translucency: body opaque, silk sheer with a slow shimmer
      const sheer = finness * (0.55 + 0.45 * tailness);
      const shimmer = 0.5 + 0.5 * Math.sin(T * 1.3 + u * 5.5 + dv * 6 + S);
      alpha[k / 2] = clamp(1 - sheer * (0.22 + 0.16 * shimmer + 0.12 * reach), 0.45, 1);
    }
  }
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.28;
    ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = `rgba(255,245,235,${a})`;
  ctx.fill();
  ctx.restore();
}

/** A small dark bronze coin seen at an angle; `depth` 0..1 dims it once it rests in the water. */
function drawCoin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  spin: number,
  a: number,
  depth: number,
) {
  if (a <= 0.01) return;
  const squash = Math.max(0.3, Math.abs(Math.cos(spin)));
  const tilt = Math.sin(spin * 0.5) * 0.6;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(1, squash);
  ctx.globalAlpha = a;
  // old bronze: dark, dull, a single soft highlight; `depth` dims it further once it lies in the water
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r * 1.05);
  const mix = (c1: number[], c2: number[]) => c1.map((v, i) => Math.round(v + (c2[i] - v) * depth));
  const hi = mix([150, 104, 44], [96, 62, 30]);
  const lo = mix([74, 44, 18], [46, 26, 12]);
  g.addColorStop(0, `rgb(${hi.join(",")})`);
  g.addColorStop(1, `rgb(${lo.join(",")})`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  // rim
  ctx.lineWidth = Math.max(0.6, r * 0.16);
  ctx.strokeStyle = "rgba(38,20,8,0.85)";
  ctx.stroke();
  // faint inner ring
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(0.5, r * 0.1);
  ctx.strokeStyle = `rgba(190,150,90,${0.35 * (1 - depth * 0.5)})`;
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------ component -------------------------------- */

export function KoiCanvas({
  className,
  layerClassName,
  onSplash,
  count = 3,
}: {
  className?: string;
  /** number of fish on stage, 1..MAX_FISH */
  count?: number;
  /** classes for the 2D layer (stars + coins); it sits below the fish, at the content level */
  layerClassName?: string;
  onSplash?: () => void;
}) {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const onSplashRef = useRef(onSplash);
  onSplashRef.current = onSplash;
  const glRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const countRef = useRef(count);
  const applyCountRef = useRef<() => void>(() => {});

  useEffect(() => {
    countRef.current = count;
    applyCountRef.current();
  }, [count]);

  useEffect(() => {
    const bg = bgRef.current;
    const glCanvas = glRef.current;
    const parent = wrapRef.current;
    if (!bg || !glCanvas || !parent) return;
    const ctx = bg.getContext("2d");
    if (!ctx) return;

    const glAttrs: WebGLContextAttributes = { alpha: true, premultipliedAlpha: true, antialias: true };
    let isGl2 = true;
    let gl = glCanvas.getContext("webgl2", glAttrs) as WebGLRenderingContext | null;
    if (!gl) {
      isGl2 = false;
      gl = glCanvas.getContext("webgl", glAttrs);
    }
    const prog = gl ? createProgram(gl) : null;
    const loc = gl && prog
      ? {
          aPos: gl.getAttribLocation(prog, "aPos"),
          aUv: gl.getAttribLocation(prog, "aUv"),
          aAlpha: gl.getAttribLocation(prog, "aAlpha"),
          uRes: gl.getUniformLocation(prog, "uRes"),
          uOffset: gl.getUniformLocation(prog, "uOffset"),
          uTex: gl.getUniformLocation(prog, "uTex"),
          uShadow: gl.getUniformLocation(prog, "uShadow"),
          uAlpha: gl.getUniformLocation(prog, "uAlpha"),
        }
      : null;
    if (gl && prog) {
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
    }

    const imgs = SPRITES.map((src) => {
      const im = new Image();
      im.src = src;
      return im;
    });
    const texs: (WebGLTexture | null)[] = [];
    const masks: Uint8Array[] = [];
    let loaded = 0;
    let ready = false;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let fish: Fish[] = [];
    let stars: Star[] = [];
    const coins: Coin[] = [];
    let pointer: Vec | null = null;
    let pointerIdle = 0;
    let raf = 0;
    let last = performance.now();
    let time = 0;

    const targetLength = () => clamp(Math.min(w * (w < 640 ? 1.05 : 0.72), h * 1.15), 360, 1250);
    // size of fish i relative to the biggest one (desktop / narrow screens)
    const sizeRatio = (i: number) => (w < 640 ? [1, 0.72, 0.6, 0.66, 0.55] : [1, 0.62, 0.5, 0.56, 0.45])[i] ?? 0.5;

    const buildFish = (i: number, big: number): Fish | null => {
      const im = imgs[i];
      const tex = texs[i];
      if (!gl || !im || !tex) return null;
      const mesh = buildMesh(gl, masks[i]);
      if (!mesh) return null;
      const f = makeFish(w, h, big * sizeRatio(i), im, tex, mesh, masks[i], SPRITE_BODY_START[i] ?? 0.3);
      // staggered orbit radii + alternating directions: the fish circle the pointer in separate lanes
      f.orbitRadius = big * (0.2 + i * 0.13);
      f.orbitDir = i % 2 === 0 ? 1 : -1;
      return f;
    };

    // add / remove fish in place so the ones already swimming don't jump
    const applyCount = () => {
      if (!ready || w === 0) return;
      const n = clamp(countRef.current, 1, MAX_FISH);
      while (fish.length > n) fish.pop();
      const big = targetLength();
      while (fish.length < n) {
        const f = buildFish(fish.length, big);
        if (!f) break;
        enterFromEdge(f, w, h);
        fish.push(f);
      }
    };
    applyCountRef.current = applyCount;

    const spawn = () => {
      const big = targetLength();
      fish = [];
      for (let i = 0; i < clamp(countRef.current, 1, MAX_FISH); i++) {
        const f = buildFish(i, big);
        if (f) fish.push(f);
      }
      stars = Array.from({ length: Math.round(clamp(w / 45, 14, 36)) }, () => ({
        x: rand(0, w),
        y: rand(0, h),
        r: rand(1.2, 4.5),
        phase: rand(0, Math.PI * 2),
        speed: rand(0.6, 1.6),
      }));
    };

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const c of [bg, glCanvas]) {
        c.width = Math.floor(w * dpr);
        c.height = Math.floor(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (gl) gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      if (ready && fish.length === 0) spawn();
      if (fish.length && Math.abs(fish[0].length - targetLength()) / targetLength() > 0.25) spawn();
      for (const f of fish) {
        const head = f.pts[0];
        const dx = clamp(head.x, w * 0.1, w * 0.9) - head.x;
        const dy = clamp(head.y, h * 0.1, h * 0.9) - head.y;
        if (dx || dy)
          for (const p of f.pts) {
            p.x += dx;
            p.y += dy;
          }
      }
    };

    imgs.forEach((im, i) => {
      im.onload = () => {
        if (gl) {
          texs[i] = createTexture(gl, im, isGl2);
          masks[i] = buildCellMask(im);
        }
        loaded++;
        if (loaded < imgs.length) return;
        ready = true;
        if (w > 0 && fish.length === 0) spawn();
      };
    });

    const toLocal = (e: { clientX: number; clientY: number }): Vec => {
      const r = parent.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      pointer = toLocal(e);
      pointerIdle = 0;
    };
    const onLeave = () => {
      pointer = null;
    };
    const onDown = (e: PointerEvent) => {
      // clicks on the UI (buttons, links) are not drops into the water
      if (e.target instanceof Element && e.target.closest("button, a")) return;
      const p = toLocal(e);
      // drop a small coin exactly where the user clicked
      coins.push({
        x: p.x,
        y: p.y,
        t: 0,
        fall: rand(0.32, 0.4),
        r: rand(3.2, 4.6),
        spin: rand(0, Math.PI * 2),
        spinV: rand(6, 10) * (Math.random() > 0.5 ? 1 : -1),
        rest: rand(-0.5, 0.5),
        splashed: false,
      });
      fish.forEach((f, i) => {
        f.dart = 6;
        // every fish rushes at the coin itself; a tiny per-fish offset keeps the noses from
        // meeting in one pixel, the body separation does the rest
        const a = Math.atan2(f.pts[0].y - p.y, f.pts[0].x - p.x) + i * 0.6;
        const o = f.length * 0.05;
        const m = f.length * 0.14; // same stage margin the steering uses, so the goal is reachable
        f.goal = {
          x: clamp(p.x + Math.cos(a) * o, m, w - m),
          y: clamp(p.y + Math.sin(a) * o, m, h - m),
        };
        f.goalT = 9;
        f.orbitAngle = a;
        f.wander = { x: p.x + rand(-60, 60), y: p.y + rand(-60, 60) };
        f.wanderT = rand(5, 8);
      });
      pointer = p;
      pointerIdle = 0;
    };

    const drawMesh = (f: Fish, shadow: boolean, ox: number, oy: number, a: number) => {
      if (!gl || !loc) return;
      const m = f.mesh;
      gl.bindBuffer(gl.ARRAY_BUFFER, m.posBuf);
      gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc.aPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.uvBuf);
      gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc.aUv);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.alphaBuf);
      gl.vertexAttribPointer(loc.aAlpha, 1, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc.aAlpha);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idxBuf);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.uniform1i(loc.uTex, 0);
      gl.uniform2f(loc.uOffset, ox, oy);
      gl.uniform1f(loc.uShadow, shadow ? 1 : 0);
      gl.uniform1f(loc.uAlpha, a);
      gl.drawElements(gl.TRIANGLES, m.idxCount, gl.UNSIGNED_SHORT, 0);
    };

    const STEP = 1 / 90;
    let acc = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      time += dt;
      if (pointer) {
        pointerIdle += dt;
        if (pointerIdle > 2.5) pointer = null;
      }
      // fixed-step physics: motion stays identical whether the display runs at 30 or 144 fps
      acc += dt;
      if (ready) {
        let steps = 0;
        while (acc >= STEP && steps < 60) {
          for (const f of fish) updateFish(f, fish, STEP, w, h, pointer);
          acc -= STEP;
          steps++;
        }
        if (steps === 60) acc = 0;
      }

      // ---- 2D layer: stars + coins
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const tw = 0.5 + 0.5 * Math.sin(time * s.speed + s.phase);
        drawStar(ctx, s.x, s.y, s.r * (0.7 + tw * 0.5), 0.25 + tw * 0.6);
      }
      for (let i = coins.length - 1; i >= 0; i--) {
        const c = coins[i];
        c.t += dt;
        if (!c.splashed && c.t >= c.fall) {
          c.splashed = true;
          onSplashRef.current?.();
        }
        const down = c.t - c.fall; // <0 while falling, >0 lying on the bottom
        if (down > COIN_REST + COIN_FADE) {
          coins.splice(i, 1);
          continue;
        }
        if (down < 0) {
          // falling straight down onto the click point: tumbles, shrinks as it comes closer
          c.spin += c.spinV * dt;
          const k = c.t / c.fall;
          const e = k * k; // gravity
          drawCoin(ctx, c.x, c.y - (1 - e) * 140, c.r * (1.3 - 0.3 * e), c.spin, 1, 0);
        } else {
          // landed: settles flat within a moment, rests a couple of seconds, then fades into the depth
          const settle = smooth(0, 0.25, down);
          const spin = c.spin * (1 - settle) + c.rest * settle;
          const fade = 1 - smooth(COIN_REST, COIN_REST + COIN_FADE, down);
          drawCoin(ctx, c.x, c.y, c.r, spin, fade, Math.min(1, down * 0.6));
        }
      }

      // ---- WebGL layer: fish
      if (gl && loc && ready) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(loc.uRes, w, h);
        const sorted = [...fish].sort((a, b) => a.length - b.length);
        for (const f of sorted) {
          deformMesh(f);
          gl.bindBuffer(gl.ARRAY_BUFFER, f.mesh.posBuf);
          gl.bufferData(gl.ARRAY_BUFFER, f.mesh.pos, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, f.mesh.alphaBuf);
          gl.bufferData(gl.ARRAY_BUFFER, f.mesh.alpha, gl.DYNAMIC_DRAW);

          // soft shadow: a few jittered translucent black passes build a blurred penumbra
          const sx = f.length * 0.02;
          const sy = f.length * 0.036;
          const j = f.length * 0.011;
          for (let k = 0; k < 6; k++) {
            const ang = (k / 6) * Math.PI * 2;
            drawMesh(f, true, sx + Math.cos(ang) * j, sy + Math.sin(ang) * j, 0.075);
          }
          drawMesh(f, false, 0, 0, 1);
        }
      }

      raf = requestAnimationFrame(frame);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    // the canvas layer is pointer-events:none so links stay clickable -> listen on the hero itself
    const host: HTMLElement =
      parent.closest<HTMLElement>("[data-koi-host]") ?? parent.parentElement ?? parent;
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("pointerdown", onDown);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointerdown", onDown);
    };
  }, []);

  return (
    <>
      <canvas ref={bgRef} className={layerClassName} aria-hidden="true" aria-label="Sparkles and dropped coins" />
      <div ref={wrapRef} className={className} aria-hidden="true">
        <canvas ref={glRef} className="absolute inset-0" aria-label="Swimming koi" />
      </div>
    </>
  );
}
