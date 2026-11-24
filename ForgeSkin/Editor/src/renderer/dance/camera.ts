// MMD camera keys → the game's `.cam` (CAM2), a straight port of the tool the shipped dances were made with
// (`_work/cam_convert.py`): MMD's degree angles become the camera's rotation, its 0.08-unit space becomes meters and the
// game mirrors X. MMD eases between its own keys with a Bézier per channel while the game only lerps, so a VMD camera is
// baked to one key per frame here — that is what makes the editor and the game follow the same path MMD/Blender shows.
import type { CameraKey, Curve } from './vmd';

export interface CamKey {
  t: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  fov: number;
}

const SCALE = 0.08;
const FPS = 30;

type Vec3 = [number, number, number];

const rotate = (m: number[][], v: Vec3): Vec3 => [
  m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
  m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
  m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
];
const mul = (a: number[][], b: number[][]): number[][] =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0]! * b[0]![j]! + a[i]![1]! * b[1]![j]! + a[i]![2]! * b[2]![j]!));
const rotX = (a: number): number[][] => [
  [1, 0, 0],
  [0, Math.cos(a), -Math.sin(a)],
  [0, Math.sin(a), Math.cos(a)],
];
const rotY = (a: number): number[][] => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
];
const rotZ = (a: number): number[][] => [
  [Math.cos(a), -Math.sin(a), 0],
  [Math.sin(a), Math.cos(a), 0],
  [0, 0, 1],
];
const mirror = (v: Vec3): Vec3 => [v[0], v[1], -v[2]];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Unity's LookRotation (right = up × forward), as a quaternion (x, y, z, w). */
function lookRotation(fwd: Vec3, up: Vec3): [number, number, number, number] {
  const z = norm(fwd);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const [m00, m10, m20] = x as [number, number, number];
  const [m01, m11, m21] = y as [number, number, number];
  const [m02, m12, m22] = z as [number, number, number];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

/** One MMD camera key in the game's space: position in meters, rotation as (x, y, z, w), vertical FOV in degrees. */
export function cameraKeyOf(key: CameraKey): CamKey {
  // VMD keeps camera angles in radians already (a value of 0.224 is the 12.8° tilt the file was authored with).
  const [rx, ry, rz] = key.rot;
  const rmm = mul(mul(rotY(-ry), rotX(-rx)), rotZ(rz));
  const f = mirror(rotate(rmm, [0, 0, 1]));
  const up = mirror(rotate(rmm, [0, 1, 0]));
  const pt: Vec3 = [key.pos[0] * SCALE, key.pos[1] * SCALE, -key.pos[2] * SCALE];
  // The three position numbers are the look-at point (mmd_tools' MMD_Camera empty); the camera sits `distance` away
  // from it along the empty's +Y and looks back. The sign belongs to the distance itself — most files store it
  // negative, but a file authored with positive distances means the same thing and used to be flattened onto the
  // look-at point, which parked the camera in the dancer's face at 12 m up.
  const d = key.distance * SCALE;
  const pos: Vec3 = [pt[0] + f[0] * d, pt[1] + f[1] * d, pt[2] + f[2] * d];
  // The camera rides the empty and keeps looking along its +Y, so its own forward is `f` whatever the distance sign is.
  return { t: key.frame / FPS, pos, rot: lookRotation(f, up), fov: key.fov };
}

/** MMD's easing at time u: the curve runs (0,0)-(x1,y1)-(x2,y2)-(1,1), and the value is its y where x(s) is u. */
export function easeAt(c: Curve, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const at = (a: number, b: number, s: number): number => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (at(c.x1, c.x2, mid) < u) lo = mid;
    else hi = mid;
  }
  return at(c.y1, c.y2, (lo + hi) / 2);
}

/** The camera at `frame`, blended the way Blender blends two keys: each channel follows the curve stored on the key the
 * segment runs INTO. mmd_tools calls __setInterpolation with the upcoming key's bytes (`interp = k.interp` while
 * prev_kp/kp are the two keys), so the easing of a segment belongs to its right-hand key — using the left key's curve
 * makes every move start at full speed and drift away from what Blender shows. */
function cameraAt(keys: CameraKey[], frame: number): CameraKey {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.frame <= frame) i++;
  const a = keys[i]!;
  const b = keys[i + 1];
  if (!b || b.frame <= a.frame) return a;
  const u = Math.min(1, Math.max(0, (frame - a.frame) / (b.frame - a.frame)));
  const mix = (from: number, to: number, c: Curve): number => from + (to - from) * easeAt(c, u);
  return {
    frame,
    distance: mix(a.distance, b.distance, b.ease.dist),
    pos: [mix(a.pos[0], b.pos[0], b.ease.x), mix(a.pos[1], b.pos[1], b.ease.y), mix(a.pos[2], b.pos[2], b.ease.z)],
    rot: [mix(a.rot[0], b.rot[0], b.ease.rot), mix(a.rot[1], b.rot[1], b.ease.rot), mix(a.rot[2], b.rot[2], b.ease.rot)],
    fov: mix(a.fov, b.fov, b.ease.fov),
    ease: b.ease,
  };
}

/** A VMD camera as game keys, one per frame. MMD files also store their keys out of order, which the game's lerp would
 * turn into jumps, so the keys are sorted first. */
export function bakeCam(keys: CameraKey[]): CamKey[] {
  if (!keys.length) return [];
  const list = [...keys].sort((a, b) => a.frame - b.frame);
  const last = Math.round(list[list.length - 1]!.frame);
  const out: CamKey[] = [];
  for (let f = 0; f <= last; f++) out.push(cameraKeyOf(cameraAt(list, f)));
  return out;
}

/**
 * The camera at time `t`, between the two keys around it: positions mix linearly, rotations slerp the short way and the
 * field of view mixes too, which is what the game's own camera player does with the keys it is handed.
 */
export function camAt(keys: CamKey[], t: number): CamKey | null {
  if (!keys.length) return null;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.t <= t) i++;
  const a = keys[i]!;
  const b = keys[i + 1];
  if (!b || b.t <= a.t) return a;
  const u = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  const mix = (from: number, to: number): number => from + (to - from) * u;
  return {
    t,
    pos: [mix(a.pos[0], b.pos[0]), mix(a.pos[1], b.pos[1]), mix(a.pos[2], b.pos[2])],
    rot: slerp(a.rot, b.rot, u),
    fov: mix(a.fov, b.fov),
  };
}

function slerp(a: [number, number, number, number], b: [number, number, number, number], u: number): [number, number, number, number] {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    const x = a[0] + (bx - a[0]) * u;
    const y = a[1] + (by - a[1]) * u;
    const z = a[2] + (bz - a[2]) * u;
    const w = a[3] + (bw - a[3]) * u;
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  }
  const th = Math.acos(Math.min(1, dot));
  const s = Math.sin(th);
  const ka = Math.sin((1 - u) * th) / s;
  const kb = Math.sin(u * th) / s;
  return [a[0] * ka + bx * kb, a[1] * ka + by * kb, a[2] * ka + bz * kb, a[3] * ka + bw * kb];
}

/** The `.cam` file: `CAM2`, a key count, then 36 bytes per key (t, position, rotation, vertical FOV). */
export function toCam(keys: CameraKey[]): Uint8Array {
  return writeCam(keys.map(cameraKeyOf));
}

/** Writes keys that are already in the game's space — an imported `.cam`, or a VMD's keys shifted by a trim. */
export function writeCam(keys: CamKey[]): Uint8Array {
  const list = [...keys].sort((a, b) => a.t - b.t);
  const out = new Uint8Array(8 + list.length * 36);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = 'CAM2'.charCodeAt(i);
  view.setUint32(4, list.length, true);
  let at = 8;
  for (const k of list) {
    view.setFloat32(at, k.t, true);
    view.setFloat32(at + 4, k.pos[0], true);
    view.setFloat32(at + 8, k.pos[1], true);
    view.setFloat32(at + 12, k.pos[2], true);
    view.setFloat32(at + 16, k.rot[0], true);
    view.setFloat32(at + 20, k.rot[1], true);
    view.setFloat32(at + 24, k.rot[2], true);
    view.setFloat32(at + 28, k.rot[3], true);
    view.setFloat32(at + 32, k.fov, true);
    at += 36;
  }
  return out;
}

/** A `.cam` the game already has, read back for the timeline; unknown files give no keys. */
export function readCam(bytes: Uint8Array): CamKey[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'CAM2') return [];
  const count = view.getUint32(4, true);
  const keys: CamKey[] = [];
  for (let i = 0; i < count && 8 + i * 36 + 36 <= bytes.byteLength; i++) {
    const at = 8 + i * 36;
    keys.push({
      t: view.getFloat32(at, true),
      pos: [view.getFloat32(at + 4, true), view.getFloat32(at + 8, true), view.getFloat32(at + 12, true)],
      rot: [view.getFloat32(at + 16, true), view.getFloat32(at + 20, true), view.getFloat32(at + 24, true), view.getFloat32(at + 28, true)],
      fov: view.getFloat32(at + 32, true),
    });
  }
  return keys.sort((a, b) => a.t - b.t);
}