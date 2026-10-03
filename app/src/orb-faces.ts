/**
 * The orb's expressions: while DSI speaks, the network sphere wears the face of its emotion, drawn
 * in its own style (glowing strokes studded with network nodes), modelled on each emotion's emoji.
 * Neutral wears no face.
 *
 * Coordinates are in sphere radii, centred on the orb: x to the right, y downwards.
 */
import type { Emotion } from "./live";

type Pt = [number, number];
export interface Stroke {
  pts: Pt[];
  /** "line": a glowing stroke; "fill": a soft filled shape (blush, heart). */
  kind: "line" | "fill";
  /** Fill colour for "fill" strokes (otherwise white with the mood's glow). */
  tint?: string;
  /** The mouth: opens with DSI's voice. */
  mouth?: boolean;
  width?: number;
}

const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 18): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
const line = (x0: number, y0: number, x1: number, y1: number, n = 6): Pt[] => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const circle = (cx: number, cy: number, r: number, n = 24): Pt[] => arc(cx, cy, r, r, 0, Math.PI * 2, n);
const star = (cx: number, cy: number, r: number): Pt[] =>
  Array.from({ length: 11 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  });
const heart = (cx: number, cy: number, s: number): Pt[] =>
  Array.from({ length: 41 }, (_, i) => {
    const t = (i / 40) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    return [cx + (x / 17) * s, cy + (y / 17) * s];
  });

// Shapes used by several faces.
const DOWN = Math.PI; // ∪ is the lower half of an arc (0 → π); ∩ the upper half (π → 2π).
const smilingEyes = (y = -0.14): Stroke[] => [
  { kind: "line", pts: arc(-0.3, y + 0.04, 0.13, 0.11, DOWN, 2 * DOWN) },
  { kind: "line", pts: arc(0.3, y + 0.04, 0.13, 0.11, DOWN, 2 * DOWN) },
];
const blush = (tint: string): Stroke[] => [
  { kind: "fill", tint, pts: circle(-0.5, 0.12, 0.1) },
  { kind: "fill", tint, pts: circle(0.5, 0.12, 0.1) },
];

export const FACES: Record<Emotion, Stroke[]> = {
  neutral: [],
  // 😌 relieved and calm: closed eyes that curve down, a soft small smile
  calm: [
    { kind: "line", pts: arc(-0.3, -0.12, 0.13, 0.07, 0, DOWN) },
    { kind: "line", pts: arc(0.3, -0.12, 0.13, 0.07, 0, DOWN) },
    { kind: "line", pts: arc(-0.32, -0.32, 0.12, 0.04, DOWN * 1.1, DOWN * 1.9), width: 0.7 },
    { kind: "line", pts: arc(0.32, -0.32, 0.12, 0.04, DOWN * 1.1, DOWN * 1.9), width: 0.7 },
    { kind: "line", mouth: true, pts: arc(0, 0.22, 0.17, 0.08, 0, DOWN) },
  ],
  // 😊 cheerful: smiling eyes, a wide smile, rosy cheeks
  cheerful: [...smilingEyes(), { kind: "line", mouth: true, pts: arc(0, 0.2, 0.28, 0.17, 0, DOWN) }, ...blush("#ff8fb1")],
  // 🤗 warm: smiling eyes, smile, cheeks, and open arms reaching round the sphere
  warm: [
    ...smilingEyes(),
    { kind: "line", mouth: true, pts: arc(0, 0.2, 0.24, 0.14, 0, DOWN) },
    ...blush("#ffb1c8"),
    // 🤗's hands, cupped in front
    { kind: "line", pts: arc(-0.42, 0.5, 0.15, 0.1, 0, DOWN), width: 1.1 },
    { kind: "line", pts: arc(0.42, 0.5, 0.15, 0.1, 0, DOWN), width: 1.1 },
  ],
  // 🤩 excited: star eyes and a big open grin
  excited: [
    { kind: "line", pts: star(-0.3, -0.14, 0.15) },
    { kind: "line", pts: star(0.3, -0.14, 0.15) },
    { kind: "line", mouth: true, pts: [...arc(0, 0.17, 0.3, 0.25, 0, DOWN), [-0.3, 0.17], [0.3, 0.17]] },
  ],
  // 🫶 empathetic: gentle closed eyes, a soft smile, and a heart
  empathetic: [
    { kind: "line", pts: arc(-0.3, -0.2, 0.11, 0.06, 0, DOWN) },
    { kind: "line", pts: arc(0.3, -0.2, 0.11, 0.06, 0, DOWN) },
    { kind: "line", mouth: true, pts: arc(0, 0.04, 0.12, 0.05, 0, DOWN) },
    { kind: "fill", tint: "#ff6b9a", pts: heart(0, 0.36, 0.2) },
  ],
  // 🧐 serious: level, lowered brows, a monocle, a straight mouth
  serious: [
    { kind: "line", pts: line(-0.46, -0.32, -0.16, -0.26), width: 1.1 },
    { kind: "line", pts: line(0.16, -0.26, 0.46, -0.32), width: 1.1 },
    { kind: "fill", pts: circle(-0.3, -0.12, 0.065), tint: "#ffffff" },
    { kind: "fill", pts: circle(0.3, -0.12, 0.065), tint: "#ffffff" },
    { kind: "line", pts: circle(0.3, -0.12, 0.15) },
    { kind: "line", pts: line(0.39, 0.0, 0.5, 0.42, 4), width: 0.6 },
    { kind: "line", mouth: true, pts: line(-0.2, 0.26, 0.2, 0.26) },
  ],
  // 🤔 curious: one raised brow, round eyes, a sideways mouth, and a question
  curious: [
    { kind: "line", pts: arc(-0.3, -0.27, 0.13, 0.08, DOWN * 1.15, DOWN * 1.85) },
    { kind: "line", pts: line(0.17, -0.29, 0.44, -0.27), width: 0.9 },
    { kind: "fill", pts: circle(-0.3, -0.12, 0.07), tint: "#ffffff" },
    { kind: "fill", pts: circle(0.3, -0.12, 0.07), tint: "#ffffff" },
    { kind: "line", mouth: true, pts: line(-0.14, 0.27, 0.16, 0.2) },
    { kind: "line", pts: [...arc(0.62, -0.62, 0.1, 0.1, DOWN, DOWN * 2.5), [0.62, -0.42], [0.62, -0.38]], width: 0.8 },
    { kind: "fill", pts: circle(0.62, -0.28, 0.025), tint: "#ffffff" },
  ],
};

/**
 * Draw an expression over the orb. `alpha` fades it in and out; `open` (0..1) opens the mouth with
 * the voice; `t` is time in seconds, for a gentle bob.
 */
export function drawFace(g: CanvasRenderingContext2D, face: Stroke[], c: number, R: number, color: string, alpha: number, open: number, t: number) {
  if (alpha <= 0.01 || !face.length) return;
  const bob = Math.sin(t * 2.2) * R * 0.012;
  const P = ([x, y]: Pt, mouth?: boolean, mouthY = 0): Pt => [c + x * R, c + bob + (mouth ? mouthY + (y - mouthY) * (1 + open * 0.9) : y) * R];
  g.save();
  g.globalAlpha = alpha;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const s of face) {
    const mouthY = s.mouth ? s.pts.reduce((a, p) => Math.min(a, p[1]), Infinity) : 0;
    const pts = s.pts.map((p) => P(p, s.mouth, mouthY));
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (s.kind === "fill") {
      g.closePath();
      g.shadowColor = s.tint ?? color;
      g.shadowBlur = R * 0.12;
      g.fillStyle = `${s.tint ?? "#ffffff"}${s.tint === "#ffffff" ? "ee" : "aa"}`;
      g.fill();
      continue;
    }
    // A glowing stroke in the mood's colour, with a bright core.
    g.shadowColor = color;
    g.shadowBlur = R * 0.1;
    g.strokeStyle = `${color}cc`;
    g.lineWidth = R * 0.07 * (s.width ?? 1);
    g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = "#ffffffee";
    g.lineWidth = R * 0.028 * (s.width ?? 1);
    g.stroke();
    // Network nodes along the stroke, so the face looks woven from the sphere itself.
    g.fillStyle = "#ffffff";
    for (let i = 0; i < pts.length; i += 3) {
      g.beginPath();
      g.arc(pts[i][0], pts[i][1], R * 0.022 * (s.width ?? 1), 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}
