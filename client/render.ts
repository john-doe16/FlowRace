import type { PlayState } from './play-state.ts';

/** Classic Flow-style colours, tuned to stay distinct on a dark board. */
export const PALETTE = [
  '#ff3b3b', // red
  '#1fbf3a', // green
  '#3b6bff', // blue
  '#f2e01d', // yellow
  '#ff9416', // orange
  '#28e6f0', // cyan
  '#ff3df2', // magenta
  '#b5523b', // maroon
  '#9c3cd6', // purple
  '#f2f2f2', // white
  '#9a9a9a', // grey
  '#86ff2e', // lime
  '#c9b98a', // tan
  '#6c63ff', // indigo
  '#1fa39a', // teal
  '#ff8fc7', // pink
];

/** A point in board units: (0,0) is the top-left corner, (size,size) the bottom-right. */
export interface Pointer {
  x: number;
  y: number;
}

/** Animation timings, in ms. */
export const APPEAR_MS = 220;
export const APPEAR_STAGGER_MS = 16;
export const PULSE_MS = 450;
export const FLASH_MS = 160;
export const GAIN_MS = 750;
const SPIN_TURN_MS = 450;
/** Fog: dots are visible within this many cells of the pointer, fading over the last bit. */
const FOG_RADIUS = 2.1;
const FOG_FADE = 0.7;

/** Spin twist: the board turns a quarter every `everyMs`, easing through each turn. Radians. */
export function spinAngle(elapsedMs: number, everyMs: number): number {
  if (elapsedMs < everyMs) return 0;
  const steps = Math.floor(elapsedMs / everyMs);
  const t = Math.min(1, (elapsedMs - steps * everyMs) / SPIN_TURN_MS);
  const eased = 1 - (1 - t) ** 3;
  return ((steps - 1 + eased) * Math.PI) / 2;
}

/**
 * Converts a screen position to board units, undoing the board's rotation
 * (Spin) and flipping left-right first if input is mirrored (Mirror).
 * Not clamped: points off the board fall outside 0..size.
 */
export function boardPoint(
  rect: { left: number; top: number; width: number; height: number },
  size: number,
  clientX: number,
  clientY: number,
  { angle = 0, mirror = false }: { angle?: number; mirror?: boolean } = {},
): Pointer {
  let x = ((clientX - rect.left) / rect.width) * size;
  let y = ((clientY - rect.top) / rect.height) * size;
  if (mirror) x = size - x;
  if (angle) {
    const c = size / 2;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const dx = x - c;
    const dy = y - c;
    x = c + dx * cos - dy * sin;
    y = c + dx * sin + dy * cos;
  }
  return { x, y };
}

/** The cell containing a board-unit point, or null if it's off the board. */
export function cellFromPoint(size: number, p: Pointer): number | null {
  const c = Math.floor(p.x);
  const r = Math.floor(p.y);
  if (r < 0 || c < 0 || r >= size || c >= size) return null;
  return r * size + c;
}

/** Transient effects drawn on top of the board. All times are performance.now() values. */
export interface BoardFx {
  now: number;
  /** When this board appeared; its dots pop in from here. */
  appearAt: number;
  /** A white flash fades out until this time (board solved). */
  flashUntil: number;
  /** Rings expanding from both dots of a colour that just connected. */
  pulses: { color: number; at: number }[];
  /** Floating score text, e.g. "+3", rising from the middle of the board. */
  gain: { text: string; at: number } | null;
  reducedMotion: boolean;
  /** Cell under a mouse or pen that isn't drawing; dots and pipes there get a grab highlight. */
  hover: number | null;
  /** Spin twist: current board rotation in radians. */
  angle: number;
  /** Fog twist: where the player is looking (board units), or null if fog is off. */
  fog: Pointer | 'hidden' | null;
  /** Memory twist: dots have lost their colours. */
  colourless: boolean;
}

/** Sizes the canvas backing store to its CSS box and returns the cell size in CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, size: number): number {
  const dpr = window.devicePixelRatio || 1;
  const css = canvas.clientWidth;
  const px = Math.round(css * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  return css / size;
}

export function cellAt(canvas: HTMLCanvasElement, size: number, clientX: number, clientY: number): number | null {
  const rect = canvas.getBoundingClientRect();
  const c = Math.floor(((clientX - rect.left) / rect.width) * size);
  const r = Math.floor(((clientY - rect.top) / rect.height) * size);
  if (r < 0 || c < 0 || r >= size || c >= size) return null;
  return r * size + c;
}

/** How far (in cells) the pointer must cross into a neighbouring cell before the drag moves there. */
export const CELL_STICKINESS = 0.2;

/**
 * Like cellAt, but sticky: while dragging, the pointer must go a little way
 * past a cell border before it counts as the next cell. Stops a finger that
 * runs along a grid line from flicking the pipe back and forth. Positions
 * outside the board clamp to the edge cells, so a captured drag that strays
 * off the canvas still works.
 */
export function stickyCellAt(
  rect: { left: number; top: number; width: number; height: number },
  size: number,
  clientX: number,
  clientY: number,
  last: number,
): number {
  return stickyCell(size, boardPoint(rect, size, clientX, clientY), last);
}

/** stickyCellAt for a point already in board units (after Spin/Mirror mapping). */
export function stickyCell(size: number, p: Pointer, last: number): number {
  const clamp = (v: number) => Math.min(Math.max(v, 0), size - 1e-9);
  const fx = clamp(p.x);
  const fy = clamp(p.y);
  const sticky = (f: number, prev: number): number => {
    const next = Math.floor(f);
    if (next === prev + 1 && f - next < CELL_STICKINESS) return prev;
    if (next === prev - 1 && prev - f < CELL_STICKINESS) return prev;
    return next;
  };
  const col = sticky(fx, last % size);
  const row = sticky(fy, Math.floor(last / size));
  return row * size + col;
}

const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

/**
 * Opaque, desynchronized context: on Windows/ChromeOS this lets strokes skip
 * the compositor queue, cutting pen/touch-to-screen latency by a frame or two.
 */
function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  let ctx = contexts.get(canvas);
  if (!ctx) {
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) ?? canvas.getContext('2d')!;
    contexts.set(canvas, ctx);
  }
  return ctx;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Overshoots slightly before settling, for a satisfying pop. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

/** True while any effect is still moving, so the caller knows to keep redrawing. */
export function fxActive(fx: BoardFx, dots: number): boolean {
  // Twists change with time and pointer position: redraw every frame while one is on.
  if (fx.angle || fx.fog !== null) return true;
  // The flash and the "+3" are drawn even with reduced motion, so keep
  // repainting until they've faded or they'd freeze on the board.
  const fading = fx.now < fx.flashUntil || (fx.gain !== null && fx.now < fx.gain.at + GAIN_MS);
  if (fx.reducedMotion) return fading;
  return (
    fading ||
    fx.now < fx.appearAt + APPEAR_MS + dots * APPEAR_STAGGER_MS ||
    fx.pulses.some((p) => fx.now < p.at + PULSE_MS)
  );
}

/** Small N×N grid icon for board-size options (a staircase of grids for ramp mode). */
export function gridIconSvg(mode: number | 'ramp'): string {
  const lines = (x: number, y: number, s: number, n: number) => {
    let d = `M${x} ${y}h${s}v${s}h${-s}z`;
    for (let i = 1; i < n; i++) {
      const o = (s / n) * i;
      d += `M${x + o} ${y}v${s}M${x} ${y + o}h${s}`;
    }
    return d;
  };
  const d = mode === 'ramp' ? lines(1, 15, 8, 2) + lines(7, 9, 14, 3) : lines(2, 2, 20, mode);
  return `<svg class="opt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="${d}"/></svg>`;
}

export function drawBoard(canvas: HTMLCanvasElement, state: PlayState, pointer: Pointer | null, fx: BoardFx): void {
  const ctx = context(canvas);
  const size = state.size;
  const dpr = window.devicePixelRatio || 1;
  const cell = fitCanvas(canvas, size);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const full = cell * size;
  const center = (i: number): [number, number] => [((i % size) + 0.5) * cell, (Math.floor(i / size) + 0.5) * cell];
  const motion = !fx.reducedMotion;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, full, full);

  // Spin twist: everything on the board turns; the score text and flash below don't.
  if (fx.angle) {
    ctx.translate(full / 2, full / 2);
    ctx.rotate(fx.angle);
    ctx.translate(-full / 2, -full / 2);
  }
  const dotColour = (color: number) => (fx.colourless ? '#e8e8e8' : PALETTE[color % PALETTE.length]);
  /** Fog twist: how visible a dot at this cell is (1 = fully). */
  const visibility = (c: number): number => {
    if (fx.fog === null) return 1;
    if (fx.fog === 'hidden') return 0;
    const d = Math.hypot((c % size) + 0.5 - fx.fog.x, Math.floor(c / size) + 0.5 - fx.fog.y);
    return clamp01((FOG_RADIUS - d) / FOG_FADE);
  };

  // Tint covered cells, stronger once a pipe is connected.
  for (let i = 0; i < size * size; i++) {
    const owner = state.ownerAt(i);
    if (owner < 0) continue;
    ctx.globalAlpha = state.isComplete(owner) ? 0.3 : 0.16;
    ctx.fillStyle = PALETTE[owner % PALETTE.length];
    ctx.fillRect((i % size) * cell, Math.floor(i / size) * cell, cell, cell);
  }
  ctx.globalAlpha = 1;

  // Grid: the original's muted gold lines, with a firmer outer frame.
  ctx.strokeStyle = 'rgba(214, 190, 100, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 1; k < size; k++) {
    const p = Math.round(k * cell) + 0.5;
    ctx.moveTo(p, 0);
    ctx.lineTo(p, full);
    ctx.moveTo(0, p);
    ctx.lineTo(full, p);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(214, 190, 100, 0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, full - 2, full - 2);

  // Pipes. Connected ones glow slightly so finished flows read at a glance.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = cell * 0.34;
  state.paths.forEach((path, color) => {
    if (path.length < 2) return;
    const hue = PALETTE[color % PALETTE.length];
    ctx.strokeStyle = hue;
    if (state.isComplete(color)) {
      ctx.shadowColor = hue;
      ctx.shadowBlur = cell * 0.25;
    }
    ctx.beginPath();
    path.forEach((c, i) => {
      const [x, y] = center(c);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  });

  // Dots, popping in one colour after another on a fresh board.
  state.board.dots.forEach(([a, b], color) => {
    const t = motion ? clamp01((fx.now - fx.appearAt - color * APPEAR_STAGGER_MS) / APPEAR_MS) : 1;
    if (t <= 0) return;
    const radius = cell * 0.36 * easeOutBack(t);
    ctx.fillStyle = dotColour(color);
    for (const c of [a, b]) {
      const seen = visibility(c);
      if (seen <= 0) continue;
      const [x, y] = center(c);
      ctx.globalAlpha = seen;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

  // Fog: a faint ring shows how far you can see.
  if (fx.fog && fx.fog !== 'hidden') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(fx.fog.x * cell, fx.fog.y * cell, (FOG_RADIUS - FOG_FADE / 2) * cell, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Hover highlight: shows what a click would pick up.
  if (fx.hover !== null && state.active === null) {
    const dot = state.dotAt(fx.hover);
    const color = dot >= 0 ? dot : state.ownerAt(fx.hover);
    if (color >= 0 && (dot < 0 || visibility(fx.hover) > 0)) {
      const [x, y] = center(fx.hover);
      ctx.strokeStyle = dot >= 0 ? dotColour(color) : PALETTE[color % PALETTE.length];
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(2, cell * 0.05);
      ctx.beginPath();
      ctx.arc(x, y, cell * (dot >= 0 ? 0.45 : 0.3), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Connection pulses.
  if (motion) {
    for (const p of fx.pulses) {
      const t = (fx.now - p.at) / PULSE_MS;
      if (t < 0 || t >= 1) continue;
      ctx.strokeStyle = dotColour(p.color);
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.lineWidth = cell * 0.07 * (1 - t) + 1;
      for (const c of state.board.dots[p.color] ?? []) {
        const [x, y] = center(c);
        ctx.beginPath();
        ctx.arc(x, y, cell * (0.38 + 0.32 * (1 - (1 - t) ** 2)), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Finger bubble while drawing by touch, like the mobile game.
  if (pointer && state.active !== null) {
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = PALETTE[state.active % PALETTE.length];
    ctx.beginPath();
    ctx.arc(pointer.x * cell, pointer.y * cell, cell * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (fx.now < fx.flashUntil) {
    ctx.globalAlpha = ((fx.flashUntil - fx.now) / FLASH_MS) * 0.4;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, full, full);
    ctx.globalAlpha = 1;
  }

  // "+3" rising out of the board after a solve.
  if (fx.gain && fx.now < fx.gain.at + GAIN_MS) {
    const t = clamp01((fx.now - fx.gain.at) / GAIN_MS);
    const px = Math.max(28, Math.min(72, full * 0.14));
    ctx.font = `800 ${px}px "Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 1 - t * t;
    const y = full / 2 - (motion ? t * full * 0.18 : 0);
    ctx.lineWidth = px * 0.16;
    ctx.strokeStyle = '#000';
    ctx.strokeText(fx.gain.text, full / 2, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(fx.gain.text, full / 2, y);
    ctx.globalAlpha = 1;
  }
}
