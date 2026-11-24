// The `.face` a dance plays beside it: one curve per expression, on the dance's own clock. An MMD action usually carries
// its own expression keys (まばたき, 笑い, あ…), so the editor reads them from the action and writes this file — no second
// import. A ForgeSkin character brings its own blend shapes (the pack keeps them by name), so no vertex deltas are written:
// the game resolves each curve against the model's morph names and only the strength over time comes from here.
import type { MorphKey } from './vmd';

/** Actions written on Windows sometimes carry half-width katakana (ｳｨﾝｸ２右) while a model names its morphs in full width
 * (ウィンク２右). Each run of half-width kana is widened on its own, so the digits and kanji inside a name stay as written. */
const wide = (name: string): string => name.replace(/[｡-ﾟ]+/g, (run) => run.normalize('NFKC'));

/** The game's seven standard expressions and the names models give them (`GtfoMmdDance` `Plugin.cs` `CurveAliases`), so a
 * curve written as `blink` drives a model whose shape is called まばたき, and both are what the game itself resolves. */
const aliases: Record<string, readonly string[]> = {
  blink: ['まばたき', 'まばたき2', 'まばたき２', '瞬き', '眨眼', '目ぱち', 'blink', 'Blink'],
  smile: ['笑い', 'にこり', 'にやり', 'smile', 'Smile', '微笑'],
  a: ['あ', 'あ２', 'a', 'A'],
  i: ['い', 'i', 'I'],
  u: ['う', 'u', 'U'],
  e: ['え', 'e', 'E'],
  o: ['お', 'お2', 'o', 'O'],
};

/** The name a curve drives on the character, resolved as the game does it: the curve's own name when the model has it,
 * else the first alias of a standard expression that exists. `has` receives the widened (model-side) name. */
export function resolveMorph(name: string, has: (name: string) => boolean): string | null {
  for (const candidate of aliases[name] ?? [name]) {
    const widened = wide(candidate);
    if (has(widened)) return widened;
  }
  return null;
}

export interface FaceCurve {
  name: string;
  /** Frame (30 fps, the dance's clock, already trimmed) and weight 0..1, in order. */
  keys: { frame: number; weight: number }[];
}

/** How strong one curve is at a frame, sampled the way the game does it: linear between keys, held at both ends. */
function sample(keys: readonly { frame: number; weight: number }[], frame: number): number {
  if (!keys.length) return 0;
  if (frame <= keys[0]!.frame) return keys[0]!.weight;
  const last = keys[keys.length - 1]!;
  if (frame >= last.frame) return last.weight;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.frame <= frame) lo = mid;
    else hi = mid;
  }
  const a = keys[lo]!;
  const b = keys[hi]!;
  const u = Math.min(1, Math.max(0, (frame - a.frame) / Math.max(1e-4, b.frame - a.frame)));
  return a.weight + (b.weight - a.weight) * u;
}

/** The expressions a VMD really animates: any key above 0. Most actions also define every other morph once at frame 0
 * with weight 0 ("exists, unused"), and those are not expressions. */
export function morphNames(morphs: readonly MorphKey[]): string[] {
  const top = new Map<string, number>();
  for (const key of morphs) top.set(wide(key.name), Math.max(top.get(wide(key.name)) ?? 0, key.weight));
  return [...top].filter(([, weight]) => weight > 0.001).map(([name]) => name);
}

/**
 * The curves a VMD's morph keys make for the trimmed dance: the first kept frame becomes 0, keys outside the window are
 * replaced by the value at its edge (so a curve still starts and ends where the dance does), weights are clamped to 0..1,
 * and curves that never leave 0 are dropped.
 */
export function faceCurves(morphs: readonly MorphKey[], from: number, to: number): FaceCurve[] {
  const byName = new Map<string, { frame: number; weight: number }[]>();
  for (const key of morphs) {
    const weight = Math.min(1, Math.max(0, key.weight));
    const name = wide(key.name);
    const list = byName.get(name);
    if (list) list.push({ frame: key.frame, weight });
    else byName.set(name, [{ frame: key.frame, weight }]);
  }
  const end = Math.max(from, to - 1);
  const curves: FaceCurve[] = [];
  for (const [name, raw] of byName) {
    raw.sort((a, b) => a.frame - b.frame);
    // One key per frame: a file may restate a frame, and MMD applies the last one written.
    const keys = raw.filter((k, i) => i + 1 === raw.length || raw[i + 1]!.frame !== k.frame);
    let top = 0;
    for (const k of keys) top = Math.max(top, k.weight);
    if (top <= 0.001) continue;
    const kept = [{ frame: 0, weight: sample(keys, from) }];
    for (const k of keys) if (k.frame > from && k.frame < to) kept.push({ frame: k.frame - from, weight: k.weight });
    const last = sample(keys, end);
    if (kept[kept.length - 1]!.frame < end - from) kept.push({ frame: end - from, weight: last });
    // A curve the trim leaves at 0 all the way through is dead weight for this dance, whatever it does outside it.
    let live = 0;
    for (const k of kept) live = Math.max(live, k.weight);
    if (live > 0.001) curves.push({ name, keys: kept });
  }
  // The game reads at most 512 curves; if a file carries more, the liveliest ones are the expressions worth keeping.
  curves.sort((a, b) => b.keys.length - a.keys.length);
  return curves.slice(0, 512);
}

/**
 * The curves for a timeline of `frames` frames whose action strip may be cut and slid: output frame `f` asks
 * `sourceFrame` which source frame it shows, so the face follows the body wherever the strip sits. A key is written only
 * where the weight actually moves (the output is per frame, and an expression is usually still), and the last frame
 * always gets one so the curve holds its end value.
 */
export function faceCurvesMapped(
  morphs: readonly MorphKey[],
  frames: number,
  sourceFrame: (frame: number) => number,
): FaceCurve[] {
  const byName = new Map<string, { frame: number; weight: number }[]>();
  for (const key of morphs) {
    const name = wide(key.name);
    const list = byName.get(name);
    const entry = { frame: key.frame, weight: Math.min(1, Math.max(0, key.weight)) };
    if (list) list.push(entry);
    else byName.set(name, [entry]);
  }
  const curves: FaceCurve[] = [];
  for (const [name, raw] of byName) {
    raw.sort((a, b) => a.frame - b.frame);
    // One key per frame, as in `faceCurves`: a file may restate a frame and MMD applies the last one written.
    const keys = raw.filter((k, i) => i + 1 === raw.length || raw[i + 1]!.frame !== k.frame);
    let top = 0;
    for (const k of keys) top = Math.max(top, k.weight);
    if (top <= 0.001) continue;
    const kept: { frame: number; weight: number }[] = [];
    let shown = -1;
    for (let f = 0; f < frames; f++) {
      const weight = sample(keys, sourceFrame(f));
      if (shown < 0 || Math.abs(weight - shown) > 0.002) {
        kept.push({ frame: f, weight });
        shown = weight;
      }
    }
    if (kept.length && kept[kept.length - 1]!.frame < frames - 1) {
      kept.push({ frame: frames - 1, weight: sample(keys, sourceFrame(frames - 1)) });
    }
    let live = 0;
    for (const k of kept) live = Math.max(live, k.weight);
    if (live > 0.001) curves.push({ name, keys: kept });
  }
  curves.sort((a, b) => b.keys.length - a.keys.length);
  return curves.slice(0, 512);
}

/** Per-name keys, grouped once per action: the preview asks for a frame 60 times a second and sorting thousands of keys
 * each time would be waste. */
let groupedFor: readonly MorphKey[] | null = null;
let grouped = new Map<string, { frame: number; weight: number }[]>();

/** How strong each expression is at a frame of the source action (30 fps, untrimmed): the same keys `faceCurves` writes, so
 * the preview shows exactly what the game will play. Only expressions that are awake at that frame come back. */
export function morphWeights(morphs: readonly MorphKey[], frame: number): Map<string, number> {
  if (morphs !== groupedFor) {
    groupedFor = morphs;
    grouped = new Map();
    for (const key of morphs) {
      const name = wide(key.name);
      const list = grouped.get(name);
      if (list) list.push({ frame: key.frame, weight: Math.min(1, Math.max(0, key.weight)) });
      else grouped.set(name, [{ frame: key.frame, weight: Math.min(1, Math.max(0, key.weight)) }]);
    }
    for (const [name, raw] of grouped) {
      raw.sort((a, b) => a.frame - b.frame);
      // One key per frame: a file may restate a frame, and MMD applies the last one written (as `faceCurves` does).
      grouped.set(
        name,
        raw.filter((k, i) => i + 1 === raw.length || raw[i + 1]!.frame !== k.frame),
      );
    }
  }
  const weights = new Map<string, number>();
  for (const [name, keys] of grouped) {
    const weight = sample(keys, frame);
    if (weight > 0.001) weights.set(name, weight);
  }
  return weights;
}

/** Bytes of a `.face` that holds curves only: `"FACE"`, no vertex morphs, then name + (frame, weight) per curve. */
export function writeFace(curves: readonly FaceCurve[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = curves.map((c) => encoder.encode(c.name));
  let size = 4 + 4 + 4;
  for (let i = 0; i < curves.length; i++) size += 4 + names[i]!.length + 4 + curves[i]!.keys.length * 8;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const int = (v: number) => {
    view.setInt32(at, v, true);
    at += 4;
  };
  bytes.set(encoder.encode('FACE'), 0);
  at = 4;
  int(0); // no vertex morphs: the character's own shapes are what the curves drive
  int(curves.length);
  for (let i = 0; i < curves.length; i++) {
    int(names[i]!.length);
    bytes.set(names[i]!, at);
    at += names[i]!.length;
    int(curves[i]!.keys.length);
    for (const key of curves[i]!.keys) {
      int(key.frame);
      view.setFloat32(at, key.weight, true);
      at += 4;
    }
  }
  return bytes;
}