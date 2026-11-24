// The music lane draws its strips as waveforms, the way a cutting app does. A song is decoded once, reduced to a loudness
// envelope and kept for the session; the strips only ever ask for slices of that envelope, so trimming and zooming cost
// nothing after the first read.

import { fileUrl } from '../protocol';
import { decodeSong } from './audio';

/** The whole song as one loudness value (RMS, 0..1) per 1/RATE second. */
export interface Peaks {
  seconds: number;
  /** Envelope values per second of song. */
  rate: number;
  values: Float32Array;
  /** The loudest bucket in the song, so strips can be drawn against a full height instead of against one. */
  loudest: number;
}

/** 400 per second: finer than a pixel even at the timeline's deepest zoom, and small enough to keep for every song. */
const RATE = 400;

const cache = new Map<string, Promise<Peaks | null>>();

/** Envelope of the song at `path`, decoded on first ask; null when the file cannot be read or decoded. */
export function songPeaks(path: string): Promise<Peaks | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  const run = (async (): Promise<Peaks | null> => {
    try {
      const response = await fetch(fileUrl(path));
      const song = await decodeSong(await response.arrayBuffer());
      return envelope(song.samples, song.channels, song.seconds);
    } catch {
      cache.delete(path);
      return null;
    }
  })();
  cache.set(path, run);
  return run;
}

// Loudness, not the raw extremes: one pixel of a whole-song strip covers some fifty buckets, and min/max over that many
// buckets of mastered music is ±1 in every column — a solid block. RMS keeps the shape (quiet intro, drops, gaps) at any zoom.
function envelope(samples: Float32Array, channels: number, seconds: number): Peaks {
  const frames = Math.floor(samples.length / channels);
  const count = Math.max(1, Math.ceil(seconds * RATE));
  const values = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * frames) / count);
    const to = Math.min(frames, Math.max(from + 1, Math.floor(((b + 1) * frames) / count)));
    let sum = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      for (let c = 0; c < channels; c++) {
        const v = samples[i * channels + c]!;
        sum += v * v;
        n++;
      }
    }
    values[b] = n ? Math.sqrt(sum / n) : 0;
  }
  let loudest = 0;
  for (let b = 0; b < count; b++) if (values[b]! > loudest) loudest = values[b]!;
  return { seconds, rate: RATE, values, loudest };
}

/**
 * Paints `peaks` from song seconds `from` to `to` across the canvas's own width: one bar per pixel column, growing up from
 * the strip's floor the way a cutting app draws audio, so loud parts stand tall and rests flatten to a line.
 * `weight` scales every bar (0..1) by where it sits in the clip, so the strip's gain and fades show in its own shape.
 */
export function paintPeaks(
  canvas: HTMLCanvasElement,
  peaks: Peaks | null,
  from: number,
  to: number,
  color: string,
  weight?: (fraction: number) => number,
): void {
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const height = Math.max(1, Math.round(canvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!peaks) return;
  const { values, rate } = peaks;
  const count = values.length;
  const floor = height - 1;
  const usable = Math.max(1, height - 3);
  const loudest = Math.max(1e-4, peaks.loudest);
  const span = Math.max(1e-6, to - from);
  ctx.fillStyle = color;
  for (let x = 0; x < width; x++) {
    let at = Math.floor((from + (x / width) * span) * rate);
    let end = Math.ceil((from + ((x + 1) / width) * span) * rate);
    if (end <= 0 || at >= count) continue;
    at = Math.max(0, at);
    end = Math.min(count, Math.max(at + 1, end));
    let sum = 0;
    for (let b = at; b < end; b++) sum += values[b]!;
    const amp = Math.min(1, sum / (end - at) / loudest);
    // Loudness read by ear, not by meter: mastered music hovers within a couple of dB of its peak, so a linear height is a
    // solid slab. 24 dB below the song's loudest bucket is the floor, and the shape keeps its dips and build-ups.
    const shape = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(1e-4, amp)) + 24) / 24));
    const scale = weight ? Math.min(1, Math.max(0, weight((x + 0.5) / width))) : 1;
    const bar = Math.max(1, Math.round(shape * scale * usable));
    ctx.fillRect(x, floor - bar, 1, bar);
  }
}