/** A VMD file, read the way the game's bake step reads it: bone keys carry a position and a rotation in MMD's own
 * units, plus the four Bézier curves that say how a key blends into the next. MMD units are 1/12.5 m: a 20-unit-tall
 * dance model is 1.6 m, so a VMD position is multiplied by `MMD_SCALE` to reach the metres the editor works in. */

/** MMD unit to metre (a MMD model is about 20 units tall and about 1.6 m). */
export const MMD_SCALE = 0.08;

/** How one key blends into the next: a cubic Bézier through (0,0)-(x1,y1)-(x2,y2)-(1,1), in 0..1. */
export type Curve = { x1: number; y1: number; x2: number; y2: number };

export type BoneKey = {
  name: string;
  frame: number;
  /** World-axis offset in MMD units, as MMD applies a bone's position. */
  pos: [number, number, number];
  rot: [number, number, number, number];
  /** x, y, z, rotation — the four curves this key uses. */
  curve: [Curve, Curve, Curve, Curve];
};

export type MorphKey = { name: string; frame: number; weight: number };

/** How one camera key eases into the next: MMD stores six curves, one per channel it interpolates. */
export type CameraEase = { x: Curve; y: Curve; z: Curve; rot: Curve; dist: Curve; fov: Curve };

export type CameraKey = {
  frame: number;
  /** Distance to the target; negative means the position holds the look-at point instead (MMD's own quirk). */
  distance: number;
  /** MMD units. */
  pos: [number, number, number];
  /** Euler radians, MMD order. */
  rot: [number, number, number];
  /** Vertical field of view in degrees. */
  fov: number;
  ease: CameraEase;
};

export type Vmd = { name: string; bones: BoneKey[]; morphs: MorphKey[]; camera: CameraKey[] };

const LINEAR: Curve = { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 };

/** The 64 interpolation bytes as MMD reads them: four rows of (x1, y1, x2, y2) for x, y, z and rotation. */
function curves(table: Uint8Array, at: number): [Curve, Curve, Curve, Curve] {
  const one = (i: number): Curve => ({ x1: table[at + i] / 127, y1: table[at + i + 4] / 127, x2: table[at + i + 8] / 127, y2: table[at + i + 12] / 127 });
  return [one(0), one(1), one(2), one(3)];
}

/** A name as the file writes it: 15 bytes of Shift-JIS, zero-padded. */
function name(bytes: Uint8Array, at: number, length: number): string {
  let end = at;
  while (end < at + length && bytes[end] !== 0) end++;
  return new TextDecoder('shift_jis').decode(bytes.subarray(at, end));
}

export function parseVmd(bytes: Uint8Array): Vmd {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = new TextDecoder('shift_jis').decode(bytes.subarray(0, 25));
  if (!sig.startsWith('Vocaloid Motion Data')) throw new Error('not a VMD file (its signature is not "Vocaloid Motion Data")');
  let at = 50; // 30 signature + 20 model name
  const read = (n: number) => {
    const v = view.getUint32(at, true);
    at += n;
    return v;
  };

  const bones: BoneKey[] = [];
  for (let n = read(4), i = 0; i < n; i++, at += 111) {
    bones.push({
      name: name(bytes, at, 15),
      frame: view.getUint32(at + 15, true),
      pos: [view.getFloat32(at + 19, true), view.getFloat32(at + 23, true), view.getFloat32(at + 27, true)],
      rot: [view.getFloat32(at + 31, true), view.getFloat32(at + 35, true), view.getFloat32(at + 39, true), view.getFloat32(at + 43, true)],
      curve: curves(bytes, at + 47),
    });
  }

  const morphs: MorphKey[] = [];
  for (let n = read(4), i = 0; i < n; i++, at += 23)
    morphs.push({ name: name(bytes, at, 15), frame: view.getUint32(at + 15, true), weight: view.getFloat32(at + 19, true) });

  const camera: CameraKey[] = [];
  if (at + 4 <= bytes.length)
    for (let n = read(4), i = 0; i < n; i++, at += 61) {
      const table = bytes.subarray(at + 32, at + 32 + 24);
      // Six channels of four bytes, each (x1, x2, y1, y2) — the order MMD writes them in, which mmd_tools reads back
      // with the pair swapped into (x1, y1, x2, y2).
      const one = (o: number): Curve =>
        table.length >= o + 4 ? { x1: table[o]! / 127, y1: table[o + 2]! / 127, x2: table[o + 1]! / 127, y2: table[o + 3]! / 127 } : LINEAR;
      camera.push({
        frame: view.getUint32(at, true),
        distance: view.getFloat32(at + 4, true),
        pos: [view.getFloat32(at + 8, true), view.getFloat32(at + 12, true), view.getFloat32(at + 16, true)],
        rot: [view.getFloat32(at + 20, true), view.getFloat32(at + 24, true), view.getFloat32(at + 28, true)],
        fov: view.getUint32(at + 56, true),
        ease: { x: one(0), y: one(4), z: one(8), rot: one(12), dist: one(16), fov: one(20) },
      });
    }

  // The 20-byte model name carries no useful characters in most files; the file name is what names a dance.
  return { name: '', bones, morphs, camera };
}