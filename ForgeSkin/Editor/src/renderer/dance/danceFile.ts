/** The game's dance files, as `GtfoMmdDance` reads them (`Plugin.cs`, `DanceRunner.LoadDance`, magic "DNCE",
 * versions 3–6). Positions are metres on the game's axes, rotations are per-joint quaternions (x, y, z, w). */

export type DanceTrack = { name: string; data: Float32Array };

export type DanceFile = {
  version: number;
  /** Frames stored; every frame is kept, there are no keyframes. */
  frames: number;
  /** 50 canonical joints, or 20 for the body only. */
  joints: number;
  /** Frames per second — the field the plugin calls `Rate`. */
  rate: number;
  /** The name inside the file; the plugin ignores it and uses the filename instead. */
  name: string;
  hipBone: string;
  hipPos: [number, number, number];
  /** `frames × joints × 4`, joint-major. */
  turns: Float32Array;
  /** `frames × 3`. */
  hips: Float32Array;
  /** Extra bones posed relative to rest on top of the 50 joints (v4+). */
  rotTracks: DanceTrack[];
  /** Bones that also move (v6+). */
  posTracks: DanceTrack[];
};

class Reader {
  private at = 0;
  constructor(private readonly view: DataView) {}

  get left(): number {
    return this.view.byteLength - this.at;
  }

  u8(): number {
    return this.view.getUint8(this.at++);
  }

  i32(): number {
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.at, true);
    this.at += 4;
    return v;
  }

  /** .NET `BinaryWriter.Write(string)`: a 7-bit length, then that many UTF-8 bytes. */
  text(): string {
    let length = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      length |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.at, length);
    this.at += length;
    return new TextDecoder().decode(bytes);
  }

  floats(count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.f32();
    return out;
  }
}

export function readDance(bytes: Uint8Array): DanceFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(view);
  const magic = new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset, 4));
  if (magic !== 'DNCE') throw new Error('not a .dance file (its signature is not "DNCE")');
  const at = (n: number) => {
    if (r.left < n) throw new Error('this .dance file ends in the middle of a record — it is truncated or damaged');
  };
  r.i32();
  const version = r.i32();
  if (version < 3 || version > 6) throw new Error(`this .dance file is version ${version}, and only versions 3 to 6 are known`);
  const frames = r.i32();
  const joints = r.i32();
  if (frames < 0 || joints < 1 || joints > 1024) throw new Error('this .dance file has no usable frame data');
  const rate = r.f32();
  const name = r.text();
  const hipBone = version >= 5 ? r.text() : '';
  const hipPos: [number, number, number] = version >= 5 ? [r.f32(), r.f32(), r.f32()] : [0, 0.7429, 0.0393];
  at(frames * joints * 16 + frames * 12);
  // Per frame: the 50 joint rotations, then where the hips are (the plugin reads it the same way).
  const turns = new Float32Array(frames * joints * 4);
  const hips = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < joints * 4; i++) turns[f * joints * 4 + i] = r.f32();
    for (let i = 0; i < 3; i++) hips[f * 3 + i] = r.f32();
  }
  const tracks = (read: () => DanceTrack): DanceTrack[] => {
    const count = r.left >= 4 ? r.i32() : 0;
    const out: DanceTrack[] = [];
    for (let i = 0; i < count && r.left > 0; i++) out.push(read());
    return out;
  };
  const rotTracks =
    version >= 4
      ? tracks(() => {
          const bone = r.text();
          return { name: bone, data: r.floats(frames * 4) };
        })
      : [];
  const posTracks =
    version >= 6
      ? tracks(() => {
          const bone = r.text();
          return { name: bone, data: r.floats(frames * 3) };
        })
      : [];
  return { version, frames, joints, rate: rate > 0 ? rate : 30, name, hipBone, hipPos, turns, hips, rotTracks, posTracks };
}

/** The dance's length in seconds, as the plugin counts it. */
export function danceSeconds(dance: DanceFile): number {
  return Math.max(0, (dance.frames - 1) / dance.rate);
}

/** The joint's rotation at a frame, held on the last frame when asked past the end. */
export function turnAt(dance: DanceFile, joint: number, frame: number, out: { x: number; y: number; z: number; w: number }): void {
  const f = Math.min(Math.max(Math.round(frame), 0), Math.max(0, dance.frames - 1));
  const i = (f * dance.joints + joint) * 4;
  out.x = dance.turns[i]!;
  out.y = dance.turns[i + 1]!;
  out.z = dance.turns[i + 2]!;
  out.w = dance.turns[i + 3]!;
}
class Writer {
  private buf = new Uint8Array(1 << 18);
  private view = new DataView(this.buf.buffer);
  private at = 0;

  private need(n: number): void {
    if (this.at + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.at + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.at));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  magic(text: string): void {
    this.need(text.length);
    for (let i = 0; i < text.length; i++) this.buf[this.at++] = text.charCodeAt(i);
  }

  i32(v: number): void {
    this.need(4);
    this.view.setInt32(this.at, v, true);
    this.at += 4;
  }

  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }

  text(s: string): void {
    const bytes = new TextEncoder().encode(s);
    let length = bytes.length;
    this.need(5);
    while (length >= 0x80) {
      this.buf[this.at++] = (length & 0x7f) | 0x80;
      length >>>= 7;
    }
    this.buf[this.at++] = length;
    this.need(bytes.length);
    this.buf.set(bytes, this.at);
    this.at += bytes.length;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.at);
  }
}

/** Writes frames `from..to-1` of a dance as a version 6 file — what the installed plugin reads, full pose included. */
export function writeDance(dance: DanceFile, from = 0, to = dance.frames): Uint8Array {
  const start = Math.max(0, Math.min(from, dance.frames));
  const end = Math.max(start, Math.min(to, dance.frames));
  const frames = end - start;
  const { joints } = dance;
  const w = new Writer();
  w.magic('DNCE');
  w.i32(6);
  w.i32(frames);
  w.i32(joints);
  w.f32(dance.rate);
  w.text(dance.name);
  w.text(dance.hipBone);
  w.f32(dance.hipPos[0]);
  w.f32(dance.hipPos[1]);
  w.f32(dance.hipPos[2]);
  for (let f = start; f < end; f++) {
    for (let j = 0; j < joints * 4; j++) w.f32(dance.turns[f * joints * 4 + j]!);
    for (let k = 0; k < 3; k++) w.f32(dance.hips[f * 3 + k]!);
  }
  w.i32(dance.rotTracks.length);
  for (const track of dance.rotTracks) {
    w.text(track.name);
    for (let f = start; f < end; f++) for (let k = 0; k < 4; k++) w.f32(track.data[f * 4 + k]!);
  }
  w.i32(dance.posTracks.length);
  for (const track of dance.posTracks) {
    w.text(track.name);
    for (let f = start; f < end; f++) for (let k = 0; k < 3; k++) w.f32(track.data[f * 3 + k]!);
  }
  return w.bytes();
}

/**
 * Writes `frames` frames of a dance where output frame `f` shows source frame `sourceFrame(f)` — how a strip that was cut
 * and slid onto its own place on the timeline becomes a straight `.dance` again. Fractional source frames round (a
 * strip dropped between two frames holds the nearer one), positions and rotations are copied, never blended.
 */
export function writeDanceMapped(dance: DanceFile, frames: number, sourceFrame: (frame: number) => number): Uint8Array {
  const { joints } = dance;
  const last = Math.max(0, dance.frames - 1);
  const at = (f: number): number => Math.min(last, Math.max(0, Math.round(sourceFrame(f))));
  const w = new Writer();
  w.magic('DNCE');
  w.i32(6);
  w.i32(frames);
  w.i32(joints);
  w.f32(dance.rate);
  w.text(dance.name);
  w.text(dance.hipBone);
  w.f32(dance.hipPos[0]);
  w.f32(dance.hipPos[1]);
  w.f32(dance.hipPos[2]);
  for (let f = 0; f < frames; f++) {
    const s = at(f);
    for (let j = 0; j < joints * 4; j++) w.f32(dance.turns[s * joints * 4 + j]!);
    for (let k = 0; k < 3; k++) w.f32(dance.hips[s * 3 + k]!);
  }
  w.i32(dance.rotTracks.length);
  for (const track of dance.rotTracks) {
    w.text(track.name);
    for (let f = 0; f < frames; f++) {
      const s = at(f);
      for (let k = 0; k < 4; k++) w.f32(track.data[s * 4 + k]!);
    }
  }
  w.i32(dance.posTracks.length);
  for (const track of dance.posTracks) {
    w.text(track.name);
    for (let f = 0; f < frames; f++) {
      const s = at(f);
      for (let k = 0; k < 3; k++) w.f32(track.data[s * 3 + k]!);
    }
  }
  return w.bytes();
}
