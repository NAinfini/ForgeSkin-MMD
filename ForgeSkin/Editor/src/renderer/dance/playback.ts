// The song under the dance preview, kept in one hidden element so the stage and the timeline can both drive it.
import { fileUrl } from '../protocol';

let song: HTMLAudioElement | null = null;
let loaded: string | null = null;
let running = false;
// Our own playhead, started wherever the song was last sent. The element's own `currentTime` is not usable as a clock
// straight after a seek: it keeps reporting the old position until the media pipeline catches up, which dragged the
// playhead back to where the dance was before the click. This anchor never lags, and is nudged back to the element
// whenever the two are close enough that the element has caught up.
let anchor: { audio: number; at: number } | null = null;

/** Points playback at the song a dance uses (null when it has none). */
export function setSong(path: string | null): void {
  if (path === loaded) return;
  loaded = path;
  song?.pause();
  song = null;
  running = false;
  anchor = null;
  if (!path) return;
  song = new Audio(fileUrl(path));
  song.preload = 'auto';
}

export function setVolume(volume: number): void {
  if (song) song.volume = Math.max(0, Math.min(1, volume));
}

/** Starts the song at `at` seconds into the file; a small gap from where it already is keeps playback smooth. */
export function play(at: number, volume: number): void {
  if (!song) return;
  const from = Math.max(0, at);
  song.volume = Math.max(0, Math.min(1, volume));
  if (Math.abs(song.currentTime - from) > 0.3) song.currentTime = from;
  anchor = { audio: from, at: performance.now() };
  running = true;
  void song.play().catch(() => undefined);
}

export function pause(): void {
  song?.pause();
  running = false;
  anchor = null;
}

// A stretch of the timeline with no song under it — a cut's gap, or before and after the music — still has to run at
// the speed of a clock. Adding up frame deltas per frame only ever moved the playhead in steps of one frame, which
// never got past the stage's own write threshold: at 60 fps a 17 ms step is under the 20 ms it takes to commit, so the
// picture stopped dead the moment the playhead left the music. This anchor is wall-clock, like the song's.
let picture: number | null = null;

/** Starts (or restarts) picture-only playback at timeline second `at`. */
export function playPicture(at: number): void {
  picture = performance.now() - at * 1000;
}

export function stopPicture(): void {
  picture = null;
}

/** The timeline second picture-only playback has reached, or null when it is not running. */
export function pictureClock(): number | null {
  return picture === null ? null : (performance.now() - picture) / 1000;
}

export function seekSong(at: number): void {
  if (!song) return;
  const to = Math.max(0, at);
  song.currentTime = to;
  if (running) anchor = { audio: to, at: performance.now() };
}

/** Where the song is, in file seconds, while it is actually running. */
export function songClock(): number | null {
  if (!song || !running) return null;
  const now = performance.now();
  if (!anchor) anchor = { audio: song.currentTime, at: now };
  const time = anchor.audio + (now - anchor.at) / 1000;
  // Follow the element once it agrees: after a seek it briefly disagrees, and following it then is what snapped the
  // playhead back. Small drift is corrected either way so the preview stays with the sound over a long dance.
  if (!song.paused && Math.abs(song.currentTime - time) < 0.25) anchor = { audio: song.currentTime, at: now };
  return time;
}

export function songReady(): boolean {
  return song !== null;
}