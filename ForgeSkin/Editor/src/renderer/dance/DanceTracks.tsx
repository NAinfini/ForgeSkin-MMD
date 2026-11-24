// The 剪辑 step's video-style timeline: one lane per source (镜头 / 动作 / 音乐), each holding any number of strips that
// can be picked, cut at the playhead, trimmed by either edge and slid anywhere — the way a cutting app works. Everything
// here edits `useDance.tracks`; the stage, the playhead and the export all read the same strips, so the strips are the cut.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActionIcon, Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCamera,
  IconEye,
  IconEyeglass,
  IconMagnet,
  IconMusic,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlus,
  IconRewindBackward5,
  IconRewindForward5,
  IconRotate,
  IconScissors,
  IconTrash,
  IconUser,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import { t } from '../i18n';
import { clock, seekTo, togglePlay, useArrowKeys, VolumeButton } from './DanceTimeline';
import {
  MIN_CLIP,
  TRACK_IDS,
  clipAt,
  clipEnd,
  clipSpan,
  danceLength,
  gainAt,
  newClipId,
  sourceAt,
  trackEnd,
  useDance,
  wholeStrip,
  type TrackClip,
  type TrackId,
  type Tracks,
} from './state';
import { paintPeaks, songPeaks, type Peaks } from './waveform';

/** Dances already switched to the camera view once, so going back into 剪辑 never overrides a deliberate free view. */
const viewedCamera = new Set<string>();

const CAMERA = '#7aa2f7';
const ACTION = '#f7a95c';
const MUSIC = '#9fb0c6';
/** The song as drawn on its strips: a muted steel blue on the slate strip — loud enough to read, dim enough to stay under
 * the strip's own name and selection border instead of glowing white. */
const MUSIC_WAVE = 'rgba(138, 162, 190, 0.62)';
const LANE_HEIGHT = 44;
/** Height the sideways scrollbar takes under the lanes, always reserved so the lanes never shift when it appears. */
const SCROLLBAR = 12;

const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
/** A tick step that leaves at least ~70 px between labels, so the ruler stays readable at any width. */
const tickStep = (pps: number): number => TICKS.find((s) => s * pps >= 70) ?? TICKS[TICKS.length - 1]!;
/** A ruler label: whole seconds until the axis is stretched past 1 s per tick, then tenths, so neighbouring labels differ. */
const rulerLabel = (s: number, step: number): string =>
  step < 1 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}` : clock(s);

/** What the music file is called, for the clip's label. */
const baseName = (path: string | null): string => (path ? path.replace(/\\/g, '/').split('/').pop() ?? path : '');

/** A lane's strips are edited by replacing the whole record, so each edit starts from a copy of it. */
const copyTracks = (tracks: Tracks): Tracks => ({
  camera: tracks.camera.map((c) => ({ ...c })),
  action: tracks.action.map((c) => ({ ...c })),
  music: tracks.music.map((c) => ({ ...c })),
});

/** The song's shape drawn across a music strip: the slice its clip plays, scaled by the clip's own level and fades, and
 * repainted whenever the strip is trimmed, slid, re-levelled or faded (each of those hands down a new clip object). */
function ClipWave({ clip, path, color }: { clip: TrackClip; path: string | null; color: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  useEffect(() => {
    if (!path) {
      setPeaks(null);
      return;
    }
    let live = true;
    void songPeaks(path).then((p) => {
      if (live) setPeaks(p);
    });
    return () => {
      live = false;
    };
  }, [path]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { in: from, out: to } = clip;
    const span = Math.max(1e-6, clipSpan(clip));
    const level = (fraction: number): number => Math.min(1, gainAt(clip, clip.start + fraction * span));
    const draw = (): void => paintPeaks(canvas, peaks, from, to, color, level);
    draw();
    // Trimming and zooming resize the canvas through its style, not through React, so watch the element itself.
    const watch = new ResizeObserver(draw);
    watch.observe(canvas);
    return () => watch.disconnect();
  }, [peaks, clip, color]);
  return <canvas ref={ref} className="clip-wave" aria-hidden />;
}

/** Whether snapping is on; remembered across dances and restarts, like a magnet toggle in any cutting app. */
const SNAP_KEY = 'sf.snap';
const savedSnap = (): boolean => localStorage.getItem(SNAP_KEY) !== '0';

/** Measures the lane area; the timeline scales to whatever width the window gives it. */
function useWidth(): [{ current: HTMLDivElement | null }, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function TrackHead({ icon, color, label, selected, onPick, right }: {
  icon: React.ReactNode;
  color: string;
  label: string;
  selected: boolean;
  onPick: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className={`track-name${selected ? ' is-selected' : ''}`} onClick={onPick}>
      <span className="track-icon" style={{ color, display: 'inline-flex' }}>
        {icon}
      </span>
      <span className="track-name-label">{label}</span>
      {right}
    </div>
  );
}

/** What a grabbed pointer is doing: moving the playhead, sliding a strip, or trimming one of its edges. The grab keeps
 * the pointer's x in pixels, not in seconds: the timeline rescales a little when a drag starts (it makes room to the
 * right), so a second measured before that would not match the plan after it and the strip would jump. */
type Grab = { kind: 'seek' | 'move' | 'in' | 'out'; track: TrackId | null; x: number; clip: TrackClip | null; before: Tracks | null; pushed: boolean };

export function DanceTracks() {
  const file = useDance((s) => s.file);
  const time = useDance((s) => s.time);
  const playing = useDance((s) => s.playing);
  const tracks = useDance((s) => s.tracks);
  const lengths = useDance((s) => s.lengths);
  const selected = useDance((s) => s.selected);
  const cam = useDance((s) => s.cam);
  const view = useDance((s) => s.view);
  const id = useDance((s) => s.id);
  const source = useDance((s) => s.source);
  const hasFile = !!file;
  const [plot, width] = useWidth();
  const [magnet, setMagnet] = useState(savedSnap);
  // How far the time axis is blown up sideways (1 = the whole dance fits the window). Above 1 the plot scrolls, which is
  // what makes a frame-level cut possible in a three-minute dance.
  const [zoomX, setZoomX] = useState(1);
  // While a strip is being dragged, the timeline keeps the room it had (and a little more) instead of rescaling under the
  // pointer every time the dance gets longer. It is only taken once the drag actually moves: taking it on pointerdown
  // rescaled the whole timeline on a plain click, which made the tracks jump under the cursor.
  const [stretch, setStretch] = useState(0);
  // The edge a drag is currently snapped to, drawn as a guide line so the author can see what caught it.
  const [snap, setSnap] = useState<number | null>(null);
  const total = Math.max(0.1, Math.max(danceLength(), stretch));
  const pps = width > 0 ? (width / total) * zoomX : 0;
  const length = danceLength();
  const position = Math.max(0, Math.min(length, time));
  const [history, setHistory] = useState<{ past: Tracks[]; future: Tracks[] }>({ past: [], future: [] });
  useArrowKeys();

  useEffect(() => {
    try {
      localStorage.setItem(SNAP_KEY, magnet ? '1' : '0');
    } catch {
      // A private-mode window just forgets the toggle; snapping itself still works.
    }
  }, [magnet]);

  // Entering 剪辑 with a camera move shows the dance the way the game will play it, once per dance; the eye in the
  // lane header switches back and forth afterwards.
  useEffect(() => {
    if (!id || !cam || viewedCamera.has(id)) return;
    viewedCamera.add(id);
    useDance.setState({ view: 'camera' });
  }, [id, cam]);

  const drag = useRef<Grab | null>(null);
  const timeAt = (clientX: number): number => {
    const el = plot.current;
    const rect = el?.getBoundingClientRect();
    if (!el || !rect || !pps) return 0;
    return Math.max(0, Math.min(total, (clientX - rect.left + el.scrollLeft) / pps));
  };

  /** Changing the time zoom while keeping one point of the axis under the pointer (or the playhead, for the buttons) so
   * the strip being worked on does not run off screen when the axis stretches. */
  const live = useRef({ pps, zoomX });
  live.current = { pps, zoomX };
  const zoomBy = (factor: number, clientX?: number): void => {
    const el = plot.current;
    if (!el) return;
    const { pps: before, zoomX: from } = live.current;
    if (!before) return;
    const next = Math.max(1, Math.min(32, from * factor));
    if (Math.abs(next - from) < 1e-3) return;
    const rect = el.getBoundingClientRect();
    // The wheel keeps whatever is under the cursor in place; the buttons keep the playhead, and when it sits outside the
    // view they scroll it in (the anchor edge then does the work).
    const at = clientX != null ? (el.scrollLeft + clientX - rect.left) / before : position;
    const inView =
      clientX != null
        ? clientX - rect.left
        : Math.max(0, Math.min(el.clientWidth, position * before - el.scrollLeft));
    setZoomX(next);
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, at * (before * (next / from)) - inView);
    });
  };
  // The sideways scrollbar under the lanes is drawn here rather than by the browser: the native one comes out light on a
  // dark panel, and a stretch of 32× leaves a sliver a few pixels wide that is hard to grab. It mirrors the plot and can
  // be dragged; the wheel keeps panning as before.
  const [bar, setBar] = useState({ scroll: 0, client: 0, full: 0 });
  const syncBar = useCallback((): void => {
    const el = plot.current;
    if (!el) return;
    const next = { scroll: el.scrollLeft, client: el.clientWidth, full: el.scrollWidth };
    setBar((was) =>
      was.scroll === next.scroll && was.client === next.client && was.full === next.full ? was : next,
    );
  }, [plot]);
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    syncBar();
    el.addEventListener('scroll', syncBar, { passive: true });
    const ro = new ResizeObserver(syncBar);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', syncBar);
      ro.disconnect();
    };
  }, [plot, syncBar]);
  // The canvas width only changes after a render, so the bars are re-measured once layout is done.
  useLayoutEffect(() => {
    syncBar();
  }, [zoomX, width, total, syncBar]);
  const overflow = bar.client > 0 && bar.full > bar.client + 1;
  const thumbW = overflow ? Math.max(28, Math.round((bar.client / bar.full) * bar.client)) : 0;
  const thumbX = overflow
    ? Math.round((bar.scroll / Math.max(1, bar.full - bar.client)) * Math.max(0, bar.client - thumbW))
    : 0;
  const scrub = useRef<{ offset: number } | null>(null);
  const scrubTo = (x: number): void => {
    const el = plot.current;
    if (!el) return;
    const room = el.clientWidth - thumbW;
    const most = el.scrollWidth - el.clientWidth;
    if (room <= 0 || most <= 0) return;
    el.scrollLeft = Math.max(0, Math.min(most, ((x - (scrub.current?.offset ?? 0)) / room) * most));
    syncBar();
  };
  const scrubDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!overflow) return;
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    scrub.current = { offset: x >= thumbX && x <= thumbX + thumbW ? x - thumbX : thumbW / 2 };
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubTo(x);
  };
  const scrubMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!scrub.current) return;
    scrubTo(e.clientX - e.currentTarget.getBoundingClientRect().left);
  };
  const scrubUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    scrub.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomBy(e.deltaY < 0 ? 1.25 : 0.8, e.clientX);
        return;
      }
      el.scrollLeft += e.deltaY || e.deltaX;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // zoomBy reads the live values through `live`, so the listener is registered once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Playback follows itself: once the head would leave the right of the plot it is pulled back into view, so a zoomed
  // axis does not play off screen.
  useEffect(() => {
    const el = plot.current;
    if (!el || zoomX <= 1 || !pps) return;
    const x = position * pps;
    if (x < el.scrollLeft + 24) el.scrollLeft = Math.max(0, x - 24);
    else if (x > el.scrollLeft + el.clientWidth - 64) el.scrollLeft = x - el.clientWidth + 64;
  }, [plot, position, pps, zoomX]);

  /** One edit of the whole strip set, with the version before it kept for undo. The snapshot is taken here, before the
   * new strips land: reading it inside the state updater would run after the change and record the new version instead. */
  const edit = (next: Tracks): void => {
    const before = copyTracks(useDance.getState().tracks);
    setHistory((h) => ({ past: [...h.past.slice(-99), before], future: [] }));
    useDance.setState({ tracks: next });
  };
  const undo = (): void => {
    const last = history.past.at(-1);
    if (!last) return;
    const now = copyTracks(useDance.getState().tracks);
    useDance.setState({ tracks: last });
    setHistory({ past: history.past.slice(0, -1), future: [...history.future, now] });
  };
  const redo = (): void => {
    const next = history.future.at(-1);
    if (!next) return;
    const now = copyTracks(useDance.getState().tracks);
    useDance.setState({ tracks: next });
    setHistory({ past: [...history.past, now], future: history.future.slice(0, -1) });
  };

  /** The timeline second a drag edge would snap to: the playhead, the head of the timeline or any other strip's edge,
   * whichever is within ~8 px. Null when nothing is close enough, so the edge stays where the pointer put it. */
  const nearestEdge = (value: number, skip: TrackClip | null): { at: number; d: number } | null => {
    const s = useDance.getState();
    const tol = 8 / (pps || 1);
    const points = [0, s.time];
    TRACK_IDS.forEach((k) =>
      s.tracks[k].forEach((c) => {
        if (!skip || c.id !== skip.id) points.push(c.start, clipEnd(c));
      }),
    );
    let best: { at: number; d: number } | null = null;
    for (const p of points) {
      const d = Math.abs(p - value);
      if (d <= tol && (!best || d < best.d)) best = { at: p, d };
    }
    return best;
  };

  /** Cutting the picked track at the playhead: one strip becomes two, and either half can be trimmed, slid or deleted. */
  const split = (): void => {
    const s = useDance.getState();
    const track = s.selected?.track ?? 'action';
    const hit = clipAt(s.tracks[track], s.time);
    if (!hit) return;
    const cut = s.time - hit.start;
    if (cut < MIN_CLIP - 1e-6 || clipSpan(hit) - cut < MIN_CLIP - 1e-6) return;
    // Where in the source the cut lands: a strip running at 2× has used twice its timeline seconds of footage by then.
    const at = sourceAt(hit, s.time);
    if (at <= hit.in + 1e-6 || at >= hit.out - 1e-6) return;
    // Each half keeps the fade that faces away from the cut; the two new inner edges start without one.
    const left: TrackClip = { ...hit, out: at, fadeOut: 0 };
    const right: TrackClip = { ...hit, id: newClipId(), start: hit.start + cut, in: at, fadeIn: 0 };
    edit({ ...s.tracks, [track]: s.tracks[track].flatMap((c) => (c.id === hit.id ? [left, right] : [c])) });
    useDance.setState({ selected: { track, id: right.id } });
  };

  /** Throws away the picked strip and nothing else; its lane keeps whatever strips are left. */
  const drop = (): void => {
    const s = useDance.getState();
    const pick = s.selected;
    if (!pick) return;
    const list = s.tracks[pick.track];
    if (!list.some((c) => c.id === pick.id)) return;
    edit({ ...s.tracks, [pick.track]: list.filter((c) => c.id !== pick.id) });
    useDance.setState({ selected: null });
  };

  const pickTrack = (track: TrackId): void => {
    const s = useDance.getState();
    const hit = clipAt(s.tracks[track], s.time) ?? s.tracks[track][0] ?? null;
    useDance.setState({ selected: hit ? { track, id: hit.id } : null });
  };

  const restore = (): void => {
    const track = selected?.track ?? 'action';
    const s = useDance.getState();
    const list = wholeStrip(s.lengths[track]);
    if (!list.length) return;
    edit({ ...s.tracks, [track]: list });
    useDance.setState({ selected: { track, id: list[0]!.id } });
  };

  const add = (track: TrackId): void => {
    const s = useDance.getState();
    const list = wholeStrip(s.lengths[track]);
    if (!list.length) return;
    edit({ ...s.tracks, [track]: list });
    useDance.setState({ selected: { track, id: list[0]!.id } });
  };

  // Ctrl+B cuts the picked track at the playhead, Delete throws the picked strip away and Ctrl+Z / Ctrl+Shift+Z walk the
  // strip history, as in a cutting app. The handlers are read through a ref so the window listener is registered once,
  // however often the strips change — a listener closed over `undo` would keep the history it saw at mount.
  const keys = useRef({ split, drop, undo, redo });
  useEffect(() => {
    keys.current = { split, drop, undo, redo };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) keys.current.redo();
        else keys.current.undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        e.stopPropagation();
        keys.current.redo();
        return;
      }
      if (mod && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        e.stopPropagation();
        keys.current.split();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && useDance.getState().selected) {
        e.preventDefault();
        e.stopPropagation();
        keys.current.drop();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const grab = (kind: Grab['kind'], track: TrackId | null, clip: TrackClip | null = null) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const s = useDance.getState();
    drag.current = {
      kind,
      track,
      x: e.clientX,
      clip: clip ? { ...clip } : null,
      // A pointerdown that never moves the strip must not leave an undo step behind, so the version is only kept once
      // the drag actually changes something.
      before: kind === 'seek' || !clip ? null : copyTracks(s.tracks),
      pushed: false,
    };
    if (kind === 'seek') {
      seekTo(timeAt(e.clientX));
    } else if (track && clip) {
      useDance.setState({ selected: { track, id: clip.id } });
    }
    const host = (e.currentTarget as HTMLElement).closest('.track-clip, .tracks-plot') as HTMLElement | null;
    (host ?? (e.currentTarget as HTMLElement)).setPointerCapture(e.pointerId);
  };

  const move = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    if (d.kind === 'seek') {
      seekTo(timeAt(e.clientX));
      return;
    }
    const s = useDance.getState();
    const base = d.clip;
    if (!base || !d.track) return;
    const delta = (e.clientX - d.x) / (pps || 1);
    const limit = s.lengths[d.track] || 0;
    const span = clipSpan(base);
    let next: TrackClip;
    let guide: number | null = null;
    // A lane never overlaps itself, as in a cutting app: the strips beside the grabbed one leave a corridor it may slide
    // and stretch in, and it stops at their edges. The neighbours do not move during a drag, so they are measured once.
    const others = s.tracks[d.track].filter((c) => c.id !== base.id);
    const prevEnd = others.reduce((end, c) => (c.start <= base.start ? Math.max(end, clipEnd(c)) : end), 0);
    const nextAt = others.reduce<number | null>((at, c) => (c.start > base.start ? Math.min(at ?? Infinity, c.start) : at), null);
    if (d.kind === 'move') {
      // Both edges of the strip can catch a neighbour (or the playhead): the closer of the two wins, and the strip is
      // slid so that edge lands exactly on the line.
      let start = Math.max(0, base.start + delta);
      if (magnet) {
        const head = nearestEdge(start, base);
        const tail = nearestEdge(start + span, base);
        const best = [head, tail].filter((x): x is { at: number; d: number } => !!x).sort((a, b) => a.d - b.d)[0] ?? null;
        if (best) {
          start = head === best ? best.at : best.at - span;
          guide = best.at;
        }
      }
      const right = nextAt === null ? Infinity : nextAt - span;
      start = Math.max(prevEnd, Math.min(Math.max(prevEnd, right), start));
      if (guide !== null && Math.abs(start - guide) > 1e-6 && Math.abs(start + span - guide) > 1e-6) guide = null;
      next = { ...base, start };
    } else if (d.kind === 'in') {
      // Pulling the left edge in also walks the strip right, so the content under the cursor stays put (as in a cutting
      // app); the strip can never pass the strip before it, the timeline head or leave less than a frame's worth.
      const reach = Math.max(0, base.start - prevEnd);
      let start = Math.max(base.start - reach, base.start + delta);
      if (magnet) {
        const near = nearestEdge(start, base);
        if (near) {
          start = near.at;
          guide = near.at;
        }
      }
      const face = Math.min(base.out - MIN_CLIP, Math.max(Math.max(0, base.in - reach), base.in + (start - base.start)));
      next = { ...base, in: face, start: Math.max(prevEnd, base.start + (face - base.in)) };
      if (guide !== null && Math.abs(next.start - guide) > 1e-6) guide = null;
    } else {
      // The right edge can reach into the gap after the strip but stops where the next strip begins.
      let out = Math.min(limit || base.out, Math.max(base.in + MIN_CLIP, base.out + delta));
      if (magnet) {
        const end = base.start + (out - base.in);
        const near = nearestEdge(end, base);
        if (near) {
          out = Math.min(limit || base.out, Math.max(base.in + MIN_CLIP, base.in + (near.at - base.start)));
          guide = near.at;
        }
      }
      if (nextAt !== null) out = Math.min(out, base.in + (nextAt - base.start));
      next = { ...base, out };
      if (guide !== null && Math.abs(base.start + (next.out - base.in) - guide) > 1e-6) guide = null;
    }
    setSnap(guide);
    if (!d.pushed && d.before) {
      d.pushed = true;
      setHistory((h) => ({ past: [...h.past.slice(-99), d.before!], future: [] }));
      // Room to drag a strip's tail a little past the end without the whole timeline shrinking under it.
      setStretch(Math.max(danceLength(), trackEnd(s.tracks[d.track]) + 10));
    }
    useDance.setState({ tracks: { ...s.tracks, [d.track]: s.tracks[d.track].map((c) => (c.id === base.id ? next : c)) } });
  };

  const release = (e: React.PointerEvent): void => {
    if (drag.current && drag.current.kind !== 'seek') setStretch(0);
    drag.current = null;
    setSnap(null);
    const host = (e.currentTarget as HTMLElement).closest('.track-clip, .tracks-plot') as HTMLElement | null;
    const el = host ?? (e.currentTarget as HTMLElement);
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const step = pps ? tickStep(pps) : 10;
  const ticks: number[] = [];
  // Counted by index, not accumulated: tenths drift when added up and the labels would stop landing on the labels' own values.
  for (let i = 0; i * step <= total + 1e-6; i++) ticks.push(i * step);
  const lit = selected ? (tracks[selected.track].find((c) => c.id === selected.id) ?? null) : null;
  const cutTrack = selected?.track ?? 'action';
  const cutHere = clipAt(tracks[cutTrack], time);
  const canSplit = !!cutHere && time - cutHere.start >= MIN_CLIP - 1e-6 && clipEnd(cutHere) - time >= MIN_CLIP - 1e-6;
  const cameraName = cam ? baseName(cam.file) : '';
  const musicName = baseName(source.audio);

  // The rows are given a definite height: with only the contents deciding it, a stretched time axis could leave the plot
  // without one, and the lanes were then clipped by the window instead of the panel growing to hold them.
  const bodyHeight = 22 + TRACK_IDS.length * LANE_HEIGHT + SCROLLBAR;

  const lane = (track: TrackId, color: string, icon: React.ReactNode, label: string, note: string): React.ReactNode => {
    const clips = tracks[track];
    return (
      <div
        className="track-lane"
        onPointerDown={grab('seek', null)}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
      >
        {clips.map((clip) => (
          <div
            key={clip.id}
            className={`track-clip clip-${track}${selected?.track === track && selected.id === clip.id ? ' is-selected' : ''}`}
            style={{ left: clip.start * pps, width: Math.max(3, clipSpan(clip) * pps) }}
            onPointerDown={grab('move', track, clip)}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={release}
          >
            <span className="clip-handle clip-in" onPointerDown={grab('in', track, clip)} />
            {track === 'music' ? <ClipWave clip={clip} path={source.audio} color={MUSIC_WAVE} /> : null}
            <span style={{ color, display: 'inline-flex' }}>{icon}</span>
            <span className="clip-label">{label}</span>
            <span className="clip-note">{note}</span>
            <span className="clip-handle clip-out" onPointerDown={grab('out', track, clip)} />
          </div>
        ))}
        {!clips.length && lengths[track] > 0 ? (
          <UnstyledButton className="clip-add" onPointerDown={(e) => e.stopPropagation()} onClick={() => add(track)}>
            <IconPlus size={12} />
            {t('dance.stripAdd')}
          </UnstyledButton>
        ) : null}
      </div>
    );
  };

  return (
    <div className="tracks">
      <div className="tracks-top">
        <Group gap={2} wrap="nowrap">
          <Tooltip label={t('dance.undo')}>
            <ActionIcon size="md" variant="subtle" color="gray" disabled={!history.past.length} onClick={undo}>
              <IconArrowBackUp size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('dance.redo')}>
            <ActionIcon size="md" variant="subtle" color="gray" disabled={!history.future.length} onClick={redo}>
              <IconArrowForwardUp size={17} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <span className="tracks-sep" />
        <Group gap={2} wrap="nowrap">
          <Tooltip label={`${t('dance.split')} (Ctrl+B)`}>
            <ActionIcon size="md" variant="subtle" color="gray" disabled={!canSplit} onClick={split}>
              <IconScissors size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('dance.snap')}>
            <ActionIcon
              size="md"
              variant={magnet ? 'light' : 'subtle'}
              color={magnet ? 'flare' : 'gray'}
              aria-pressed={magnet}
              aria-label={t('dance.snap')}
              onClick={() => setMagnet((on) => !on)}
            >
              <IconMagnet size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('dance.stripDelete')}>
            <ActionIcon size="md" variant="subtle" color="gray" disabled={!lit} onClick={drop}>
              <IconTrash size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('dance.stripReset')}>
            <ActionIcon size="md" variant="subtle" color="gray" disabled={!selected} onClick={restore}>
              <IconRotate size={17} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Group className="tracks-play" gap={6} wrap="nowrap">
          <Tooltip label={t('dance.back5')}>
            <ActionIcon size="md" variant="subtle" color="gray" disabled={!hasFile} onClick={() => seekTo(time - 5)}>
              <IconRewindBackward5 size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={playing ? t('dance.pause') : t('dance.play')}>
            <ActionIcon size={30} radius="xl" variant="filled" color="flare" disabled={!hasFile} onClick={togglePlay}>
              {playing ? <IconPlayerPauseFilled size={14} /> : <IconPlayerPlayFilled size={16} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('dance.forward5')}>
            <ActionIcon size="md" variant="subtle" color="gray" disabled={!hasFile} onClick={() => seekTo(time + 5)}>
              <IconRewindForward5 size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Text className="tracks-clock">
          {clock(position)} / {clock(length)}
        </Text>
        <span className="tracks-trimmed">
          {selected && lit
            ? `${t(`dance.track.${selected.track}`)} ${clock(clipSpan(lit))}`
            : t('dance.trimLength', { v0: clock(length) })}
        </span>
        <Group ml="auto" gap={6} wrap="nowrap">
          <Group gap={2} wrap="nowrap">
            <Tooltip label={t('dance.zoomOut')}>
              <ActionIcon size="md" variant="subtle" color="gray" disabled={zoomX <= 1} onClick={() => zoomBy(1 / 1.6)}>
                <IconZoomOut size={17} />
              </ActionIcon>
            </Tooltip>
            <Text className="tracks-zoomx">{zoomX.toFixed(zoomX < 10 ? 1 : 0)}×</Text>
            <Tooltip label={t('dance.zoomIn')}>
              <ActionIcon size="md" variant="subtle" color="gray" disabled={zoomX >= 32} onClick={() => zoomBy(1.6)}>
                <IconZoomIn size={17} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <VolumeButton enabled={hasFile} className="tracks-volume" />
        </Group>
      </div>
      <div className="tracks-body" style={{ height: bodyHeight }}>
        <div className="tracks-names">
          <div className="ruler-space" />
          <TrackHead
            icon={<IconCamera size={14} />}
            color={CAMERA}
            label={t('dance.camera')}
            selected={selected?.track === 'camera'}
            onPick={() => pickTrack('camera')}
            right={
              <Tooltip label={view === 'camera' ? t('dance.viewFree') : t('dance.viewCamera')} withArrow>
                <ActionIcon
                  className="track-eye"
                  size={20}
                  variant="subtle"
                  color={view === 'camera' ? 'flare' : 'gray'}
                  aria-label={view === 'camera' ? t('dance.viewFree') : t('dance.viewCamera')}
                  onClick={(e) => {
                    e.stopPropagation();
                    useDance.setState({ view: view === 'camera' ? 'free' : 'camera' });
                  }}
                >
                  {view === 'camera' ? <IconEye size={13} /> : <IconEyeglass size={13} />}
                </ActionIcon>
              </Tooltip>
            }
          />
          <TrackHead
            icon={<IconUser size={14} />}
            color={ACTION}
            label={t('dance.action')}
            selected={selected?.track === 'action'}
            onPick={() => pickTrack('action')}
          />
          <TrackHead
            icon={<IconMusic size={14} />}
            color={MUSIC}
            label={t('dance.music')}
            selected={selected?.track === 'music'}
            onPick={() => pickTrack('music')}
          />
        </div>
        <div className="tracks-main">
        <div
          // Only a stretched axis overflows; at 1× the canvas fits exactly and a rounding hair must not raise a bar.
          className={`tracks-plot${zoomX > 1.0001 ? ' is-zoomed' : ''}`}
          ref={plot}
          onPointerDown={grab('seek', null)}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={release}
        >
          <div className="tracks-canvas" style={{ width: Math.max(0, total * pps) }}>
            <div className="track-ruler">
              {ticks.map((s) => (
                <span key={s} className="track-tick" style={{ left: s * pps }}>
                  <span className="track-tick-label">{rulerLabel(s, step)}</span>
                </span>
              ))}
            </div>
            {lane('camera', CAMERA, <IconCamera size={12} />, cameraName || t('dance.camera'), '')}
            {lane(
              'action',
              ACTION,
              <IconUser size={12} />,
              t('dance.action'),
              t('dance.framesInfo', { v0: file?.frames ?? 0, v1: file?.rate ?? 30, v2: file?.joints ?? 50 }),
            )}
            {lane('music', MUSIC, <IconMusic size={12} />, musicName || t('dance.music'), '')}
            {snap !== null && <div className="track-snap" style={{ left: snap * pps }} />}
            <div className="track-playhead" style={{ left: position * pps }} />
          </div>
        </div>
        <div
          className={`tracks-scroll${overflow ? ' is-on' : ''}`}
          onPointerDown={scrubDown}
          onPointerMove={scrubMove}
          onPointerUp={scrubUp}
          onPointerCancel={scrubUp}
        >
          {overflow ? <div className="tracks-scroll-thumb" style={{ left: thumbX, width: thumbW }} /> : null}
        </div>
      </div>
      </div>
    </div>
  );
}