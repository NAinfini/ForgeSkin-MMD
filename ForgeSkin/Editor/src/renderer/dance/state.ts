// The 舞蹈 tab's state: the open dance, what it was made from (an MMD action, a camera move, a song), what the bake made
// of it and how it plays. The files live in `<data dir>/autosave/dance/<id>.dancework/`, one folder per dance, and the
// project beside it as `<id>.danceproj` — a dance is a folder you can copy, like a skin.
import { create } from 'zustand';
import { call, fileUrl } from '../protocol';
import { autosaveRoot, useStore } from '../store';
import { readDance, writeDanceMapped, danceSeconds, type DanceFile } from './danceFile';
import { parseVmd, type MorphKey } from './vmd';
import { writeCam, readCam, bakeCam, camAt, type CamKey } from './camera';
import { faceCurvesMapped, writeFace } from './face';
import { decodeSong, toWav } from './audio';
import { ensurePlugin } from '../actions';
import { t } from '../i18n';

export type DanceStep = 'import' | 'motion' | 'export';
export const DANCE_STEPS: DanceStep[] = ['import', 'motion', 'export'];

/** One dance in the folder, as the index lists it. */
export interface DanceEntry {
  id: string;
  name: string;
  /** The bake's time, so a list can say which are finished. */
  baked: boolean;
}

export interface DanceSource {
  /** Absolute paths of the imported files, inside the dance's folder. */
  action: string | null;
  camera: string | null;
  audio: string | null;
  face: string | null;
}

/** The three things a dance is made of, each its own strip on the timeline. */
export type TrackId = 'camera' | 'action' | 'music';
export const TRACK_IDS: TrackId[] = ['camera', 'action', 'music'];

/**
 * One strip: `start` is where it sits on the dance's own timeline, `in`/`out` the seconds of its source it shows.
 * A track holds a list of them — a cut at the playhead splits one strip into two, and each half is then trimmed, slid or
 * thrown away on its own, the way a cutting app's tracks work. In a gap the source holds the strip before it, so an
 * action that was cut apart still poses the figure with the same frame its last strip ended on.
 */
export interface TrackClip {
  /** Stable across edits, so a strip stays picked while others are cut, moved or deleted around it. */
  id: string;
  start: number;
  in: number;
  out: number;
  /** How much source the strip runs through per timeline second (action and camera strips): 2 plays the move twice as
   * fast inside the same room, and footage that would run past `out` holds on the strip's last frame. Unset is 1×. */
  speed?: number;
  /** Music strips: loudness multiplier (1 = as recorded), and fade lengths in timeline seconds measured in from the
   * strip's own start and back from its end. Unset gain is 1, unset fades are 0. */
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export type Tracks = Record<TrackId, TrackClip[]>;

/** What the timeline has picked: one strip, and the lane it sits in. */
export interface TrackPick {
  track: TrackId;
  id: string;
}

/** How long each source runs in its own seconds; measured when a dance opens. */
export type TrackLengths = Record<TrackId, number>;

export const noTracks = (): Tracks => ({ camera: [], action: [], music: [] });
export const noLengths = (): TrackLengths => ({ camera: 0, action: 0, music: 0 });

let clipSeq = 0;
export const newClipId = (): string => `c${(clipSeq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Seconds a strip occupies on the timeline. */
export const clipSpan = (clip: TrackClip): number => Math.max(0, clip.out - clip.in);

/** The timeline second a strip ends at. */
export const clipEnd = (clip: TrackClip): number => clip.start + clipSpan(clip);

/** A track's strips left to right: the order a lane draws them in, and the order a gap looks back through. */
export const ordered = (clips: TrackClip[]): TrackClip[] => [...clips].sort((a, b) => a.start - b.start);

/** The strip covering timeline second `t`; a strip's very end is already outside it, and so is a gap between strips. */
export function clipAt(clips: TrackClip[], t: number): TrackClip | null {
  for (const clip of clips) if (t >= clip.start - 1e-6 && t < clipEnd(clip) - 1e-6) return clip;
  return null;
}

/** The shortest strip the editor lets a trim leave: a tenth of a second, about three MMD frames. */
export const MIN_CLIP = 0.1;

/**
 * The source second a strip shows at timeline second `t`. Inside the strip this is an ordinary offset; outside it the
 * value holds at the nearest edge, which is how the stage, the camera and the export all freeze a strip that ran out.
 */
export function sourceAt(clip: TrackClip | null, t: number): number {
  if (!clip) return 0;
  return Math.min(clip.out, Math.max(clip.in, clip.in + (t - clip.start) * clipSpeed(clip)));
}

/** A strip's speed with the bounds the editor allows, so a hand-edited project cannot send it to zero or worse. */
export const clipSpeed = (clip: TrackClip): number =>
  clip.speed !== undefined && Number.isFinite(clip.speed) && clip.speed > 0.05 ? Math.min(8, clip.speed) : 1;

/** A music strip's loudness at timeline second `t`: its gain, scaled by the fade-in and fade-out that run in from the
 * strip's own edges. The preview sets the song's volume to this every frame, and the export multiplies its samples by it,
 * so what is heard is what gets written. */
export function gainAt(clip: TrackClip, t: number): number {
  const gain = Math.max(0, Math.min(2, clip.gain ?? 1));
  const rise = clip.fadeIn ? (t - clip.start) / clip.fadeIn : 1;
  const fall = clip.fadeOut ? (clipEnd(clip) - t) / clip.fadeOut : 1;
  return gain * Math.min(1, Math.max(0, Math.min(rise, fall)));
}

/** Whether the timeline's `t` is inside a strip (its very end is not: the strip has already finished there). */
export const insideClip = (clip: TrackClip | null, t: number): boolean =>
  !!clip && t >= clip.start - 1e-6 && t < clipEnd(clip) - 1e-6;

/**
 * The source second a whole track shows at timeline second `t`: the strip under `t`, or in a gap the last frame of the
 * strip before it (and before the first strip, that strip's first frame). This is what the stage poses, the camera move
 * samples and the export writes on every track that has more than one strip.
 */
export function trackSourceAt(clips: TrackClip[], t: number): number {
  const inside = clipAt(clips, t);
  if (inside) return sourceAt(inside, t);
  const list = ordered(clips);
  const first = list[0];
  if (!first) return 0;
  if (t < first.start) return first.in;
  let held = first;
  for (const clip of list) {
    if (clip.start > t) break;
    held = clip;
  }
  return held.out;
}

/** Seconds a whole track runs: its furthest strip's end. */
export const trackEnd = (clips: TrackClip[]): number => clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);

export interface DanceState {
  /** Which tab the window shows. */
  mode: 'character' | 'dance';
  step: DanceStep;
  /** What the 3D view shows: the author's own orbit, or the camera move baked into the dance. */
  view: 'free' | 'camera';
  list: DanceEntry[];
  id: string | null;
  name: string;
  /** The dance's own folder (absolute); every file below lives in it. */
  dir: string | null;
  source: DanceSource;
  /** What the bake wrote: the game's files, and when. */
  baked: { dance: string | null; cam: string | null; at: number };
  /** The baked dance as read back, for playback and the timeline. */
  file: DanceFile | null;
  /** The camera move the dance plays with, when it has one. */
  cam: { file: string; at: number } | null;
  useCamera: boolean;
  /** Expression keys read out of the action VMD, and whether the export writes them as a `.face`. */
  morphs: MorphKey[];
  useMorphs: boolean;
  volume: number;
  /** Each lane's strips; an empty list is a lane the dance does not use (or whose strips were all cut away). */
  tracks: Tracks;
  /** How long each source runs, measured when the dance opens; a strip cannot be trimmed or slid past these. */
  lengths: TrackLengths;
  /** The strip last clicked, which the toolbar's actions apply to. */
  selected: TrackPick | null;
  busy: string | null;
  log: string[];
  time: number;
  playing: boolean;
}

/** How loud the song plays. It is a listening preference rather than a property of one dance, so it is remembered
 * across dances and across editor restarts, and opening another dance keeps whatever the last one was set to. */
const VOLUME_KEY = 'sf.volume';
const savedVolume = (): number => {
  const raw = localStorage.getItem(VOLUME_KEY);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.3;
};

const initial = {
  mode: 'character' as const,
  step: 'import' as DanceStep,
  view: 'free' as const,
  list: [] as DanceEntry[],
  id: null,
  name: '',
  dir: null,
  source: { action: null, camera: null, audio: null, face: null } as DanceSource,
  baked: { dance: null, cam: null, at: 0 },
  file: null,
  cam: null,
  useCamera: true,
  morphs: [] as MorphKey[],
  useMorphs: true,
  volume: savedVolume(),
  tracks: noTracks(),
  lengths: noLengths(),
  selected: null,
  busy: null,
  log: [] as string[],
  time: 0,
  playing: false,
};

export const useDance = create<DanceState>(() => ({ ...initial }));

let renameTimer = 0;
let trackTimer = 0;
useDance.subscribe((s, prev) => {
  if (s.name !== prev.name && s.id && s.list.some((e) => e.id === s.id && e.name !== s.name)) {
    // The list labels the open dance with the live name, and the project file is written once typing pauses — a rename
    // should show up in 我的舞蹈 as it is typed and still be there after a reload.
    useDance.setState({ list: s.list.map((e) => (e.id === s.id ? { ...e, name: s.name } : e)) });
    clearTimeout(renameTimer);
    renameTimer = window.setTimeout(() => void saveDance().catch(() => undefined), 400);
  }
  if (s.tracks !== prev.tracks && s.id) {
    // Strip edits arrive in bursts while dragging; write once the pointer has been still for a moment so a reload
    // reopens the timeline exactly as it was left.
    clearTimeout(trackTimer);
    trackTimer = window.setTimeout(() => void saveDance().catch(() => undefined), 500);
  }
  if (s.volume === prev.volume) return;
  try {
    localStorage.setItem(VOLUME_KEY, String(s.volume));
  } catch {
    // Private mode or a full quota: the level still works this session, the next start just falls back.
  }
});

export const danceRoot = (): string => (useStore.getState().dataDir ? `${autosaveRoot()}\\dance` : '');
export const danceDir = (id: string): string => `${danceRoot()}\\${id}.dancework`;
export const danceProject = (id: string): string => `${danceRoot()}\\${id}.danceproj`;

/** Seconds the whole dance runs: the furthest end of any strip on any track. 0 while nothing has been laid out yet. */
export function danceLength(state: DanceState = useDance.getState()): number {
  let end = 0;
  for (const id of TRACK_IDS) end = Math.max(end, trackEnd(state.tracks[id]));
  return end;
}

/** Seconds of the baked dance, before any cutting. */
export function danceTotal(state: DanceState = useDance.getState()): number {
  return state.file ? danceSeconds(state.file) : 0;
}

/** Keeps a strip inside its source: start never negative, in/out inside the file, and never shorter than MIN_CLIP. */
function fitClip(clip: TrackClip, length: number): TrackClip {
  const cap = length > 0.01 ? length : Math.max(clip.out, clip.in + MIN_CLIP);
  const from = Math.min(Math.max(0, clip.in), Math.max(0, cap - MIN_CLIP));
  const to = Math.min(Math.max(from + MIN_CLIP, clip.out), cap);
  return { ...clip, start: Math.max(0, clip.start), in: from, out: to };
}

/** Lays a lane's strips out left to right so none covers another: a strip that would overlap the one before it is slid
 * right until it clears. The editor never lets strips be dragged on top of each other; a project saved with an overlap
 * (an older build allowed it) is mended the same way when it opens. */
export function separate(clips: TrackClip[]): TrackClip[] {
  let end = 0;
  return clips.map((clip) => {
    const start = Math.max(clip.start, end);
    end = start + clipSpan(clip);
    return start === clip.start ? clip : { ...clip, start };
  });
}

/** A whole-source strip at 0:00, for a track whose source exists. */
export const wholeStrip = (length: number): TrackClip[] => (length > 0.01 ? [{ id: newClipId(), start: 0, in: 0, out: length }] : []);

/** Fits saved strips to the sources measured now, keeping each lane in timeline order. A lane left empty stays empty: its
 * strips were deleted on purpose, and a reload must not bring them back. */
function fitTracks(tracks: Tracks, lengths: TrackLengths): Tracks {
  const out = noTracks();
  for (const id of TRACK_IDS)
    out[id] = separate(lengths[id] > 0.01 ? ordered(tracks[id].map((clip) => fitClip(clip, lengths[id]))) : ordered(tracks[id]));
  return out;
}

/** Fits the strips and gives a whole strip to any source that has none — what an import does, so a camera or song brought
 * in after the timeline was cut gets its lane filled, while cuts already made stay as they are. */
function filledTracks(tracks: Tracks, lengths: TrackLengths): Tracks {
  const out = fitTracks(tracks, lengths);
  for (const id of TRACK_IDS) if (!out[id].length) out[id] = wholeStrip(lengths[id]);
  return out;
}

/** The strips a project saved: a list per lane, or the single strip (or null) an older build wrote. Malformed strips are
 * dropped rather than half-read; a project with no `tracks` at all returns null, so its `trim` is used instead. */
function readTracks(raw: unknown): Tracks | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!TRACK_IDS.some((id) => id in record)) return null;
  const out = noTracks();
  for (const id of TRACK_IDS) {
    const value = record[id];
    const list = Array.isArray(value) ? value : value ? [value] : [];
    for (const entry of list) {
      const clip = entry as Partial<TrackClip> | null | undefined;
      if (!clip || typeof clip.start !== 'number' || typeof clip.in !== 'number' || typeof clip.out !== 'number') continue;
      if (!Number.isFinite(clip.start) || !Number.isFinite(clip.in) || !Number.isFinite(clip.out)) continue;
      const num = (value: unknown, lo: number, hi: number): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : undefined;
      const speed = num(clip.speed, 0.1, 8);
      const gain = num(clip.gain, 0, 2);
      const fadeIn = num(clip.fadeIn, 0, 120);
      const fadeOut = num(clip.fadeOut, 0, 120);
      out[id].push({
        id: typeof clip.id === 'string' && clip.id ? clip.id : newClipId(),
        start: clip.start,
        in: clip.in,
        out: clip.out,
        ...(speed !== undefined && Math.abs(speed - 1) > 1e-6 ? { speed } : {}),
        ...(gain !== undefined && Math.abs(gain - 1) > 1e-6 ? { gain } : {}),
        ...(fadeIn ? { fadeIn } : {}),
        ...(fadeOut ? { fadeOut } : {}),
      });
    }
    out[id] = separate(ordered(out[id]));
  }
  return out;
}

/** Projects from before strips existed carry one global trim: it becomes the action lane's one strip, and the camera and
 * song keep their whole files, which is the closest the new timeline can come to what they played. */
function fromTrim(raw: unknown, lengths: TrackLengths): Tracks {
  const tracks = filledTracks(noTracks(), lengths);
  const trim = (raw ?? {}) as { start?: unknown; end?: unknown };
  const start = typeof trim.start === 'number' && trim.start > 0 ? trim.start : 0;
  const end = typeof trim.end === 'number' && trim.end > 0 ? trim.end : 0;
  const action = tracks.action[0];
  if (action && (start > 0 || end > 0)) {
    action.in = Math.min(start, Math.max(0, lengths.action - MIN_CLIP));
    action.out = end > 0 ? Math.min(Math.max(end, action.in + MIN_CLIP), lengths.action) : lengths.action;
  }
  return tracks;
}

/**
 * Measures every source so the strips know their limits: the baked action's length, the camera's last key and the song.
 * Reading the camera VMD means parsing the whole file, and decoding the song is the slowest of the three, so this runs
 * once when a dance opens (and after a source is replaced), never per frame.
 */
export async function loadTrackLengths(): Promise<TrackLengths> {
  const s = useDance.getState();
  const lengths = noLengths();
  lengths.action = s.file ? danceSeconds(s.file) : 0;
  const camera = s.source.camera;
  if (camera) {
    try {
      const bytes = await readBytes(camera);
      if (/\.cam$/i.test(camera)) {
        lengths.camera = readCam(bytes).at(-1)?.t ?? 0;
      } else {
        const keys = parseVmd(bytes).camera;
        lengths.camera = keys.length ? Math.max(...keys.map((k) => k.frame)) / 30 : 0;
      }
    } catch {
      // An unreadable camera move simply has no track to lay out.
    }
  }
  lengths.music = await songSeconds();
  useDance.setState({ lengths });
  return lengths;
}

/** Re-measures the sources and folds the strips onto them: what the tab does after a source is imported or baked. */
export async function syncTracks(): Promise<void> {
  const lengths = await loadTrackLengths();
  useDance.setState({ tracks: filledTracks(useDance.getState().tracks, lengths) });
}

const write = async (path: string, text: string): Promise<void> => {
  await window.forge.writeFile(path, new TextEncoder().encode(text));
};

/** The project file: the folder's index (what the author imported), not the game's files. */
function toJson(): string {
  const s = useDance.getState();
  return JSON.stringify(
    {
      schema: 1,
      id: s.id,
      name: s.name,
      source: s.source,
      baked: s.baked,
      useCamera: s.useCamera,
      useMorphs: s.useMorphs,
      volume: s.volume,
      // Every lane's strips. `trim` stays too, so a build from before strips can still open the project, where it becomes
      // the action lane's cut; the new build ignores it once `tracks` is there. A cut-into-pieces action has no single
      // trim to report, so it writes none.
      tracks: s.tracks,
      trim: {
        start: s.tracks.action.length === 1 ? s.tracks.action[0]!.in : 0,
        end:
          s.tracks.action.length === 1 && s.tracks.action[0]!.out < s.lengths.action ? s.tracks.action[0]!.out : 0,
      },
    },
    null,
    1,
  );
}

export async function saveDance(): Promise<void> {
  const s = useDance.getState();
  if (!s.id) return;
  await write(danceProject(s.id), toJson());
  // This dance's own entry goes in front (replacing its older one): the list shows it without rescanning the folder.
  const rest = useDance.getState().list.filter((e) => e.id !== s.id);
  useDance.setState({ list: [{ id: s.id, name: s.name, baked: !!s.baked.dance }, ...rest] });
  await saveIndex();
}

/** The index the tab lists; kept beside the dances so a folder copied in from outside still shows up after a reload. */
async function saveIndex(): Promise<void> {
  const root = danceRoot();
  if (!root) return;
  const entries = useDance.getState().list;
  await write(`${root}\\index.json`, JSON.stringify(entries, null, 1));
  await window.forge.writeFile(`${root}\\.keep`, new Uint8Array());
}

export async function refreshDances(): Promise<void> {
  const root = danceRoot();
  if (!root) return;
  // The folder is the truth: every project file in it is listed, with the name and bake state the file itself holds, so a
  // dance copied in from outside — or one an older build left out of the index — still shows.
  const files = await window.forge.list(root).catch(() => []);
  const found: { entry: DanceEntry; time: number }[] = [];
  for (const f of files) {
    if (!f.name.endsWith('.danceproj')) continue;
    const id = f.name.slice(0, -'.danceproj'.length);
    let name = id;
    let baked = false;
    const doc = await window.forge.readText(`${root}\\${f.name}`).catch(() => null);
    try {
      const d = doc ? (JSON.parse(doc) as { name?: unknown; baked?: { dance?: unknown } | null }) : null;
      if (typeof d?.name === 'string' && d.name.trim()) name = d.name;
      baked = !!d?.baked?.dance;
    } catch {
      // A half-written project still lists under its file name.
    }
    found.push({ entry: { id, name, baked }, time: f.time });
  }
  found.sort((a, b) => b.time - a.time);
  let list = found.map((x) => x.entry);
  if (!files.length) {
    // No folder listing (an older main process): the index is all there is.
    const text = await window.forge.readText(`${root}\\index.json`).catch(() => null);
    try {
      const parsed = text ? (JSON.parse(text) as DanceEntry[]) : [];
      list = Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string') : [];
    } catch {
      list = [];
    }
  }
  useDance.setState({ list });
}

const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'dance';

/** A new, empty dance folder named after `name`; the tab opens it. */
export async function newDance(name: string): Promise<void> {
  const root = danceRoot();
  if (!root) throw new Error('the data folder is not known yet');
  const id = `dance-${slug(name)}-${Date.now().toString(36).slice(-5)}`;
  useDance.setState({ ...initial, mode: 'dance', id, name, dir: danceDir(id), list: useDance.getState().list });
  await saveDance();
  await refreshDances();
  await openDance(id, name);
}

export async function openDance(id: string, fallbackName?: string): Promise<void> {
  const text = await window.forge.readText(danceProject(id)).catch(() => null);
  const doc = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const source = (doc.source ?? {}) as Partial<DanceSource>;
  const baked = (doc.baked ?? {}) as { dance?: string | null; cam?: string | null; at?: number };
  const dir = danceDir(id);
  useDance.setState({
    mode: 'dance',
    id,
    name: typeof doc.name === 'string' ? doc.name : (fallbackName ?? id),
    dir,
    source: { action: source.action ?? null, camera: source.camera ?? null, audio: source.audio ?? null, face: source.face ?? null },
    baked: { dance: baked.dance ?? null, cam: baked.cam ?? null, at: baked.at ?? 0 },
    useCamera: doc.useCamera !== false,
    useMorphs: doc.useMorphs !== false,
    morphs: [],
    volume: savedVolume(),
    // Saved strips show at once; the limits they must respect are measured below, once the sources are loaded.
    tracks: readTracks(doc.tracks) ?? noTracks(),
    lengths: noLengths(),
    selected: null,
    time: 0,
    playing: false,
    log: [],
  });
  await Promise.all([loadBaked(), loadMorphs()]);
  if (useDance.getState().id !== id) return; // another dance was opened while this one was loading
  const saved = readTracks(doc.tracks);
  const lengths = await loadTrackLengths();
  if (useDance.getState().id !== id) return;
  // A project from before strips existed gets them from its single trim; every source present is laid out whole.
  useDance.setState({ tracks: saved ? fitTracks(saved, lengths) : fromTrim(doc.trim, lengths) });
}

/**
 * Renames a dance (double-clicking its name in 我的舞蹈). The open dance goes through the state, so the name field and
 * the list stay one value; another dance's project file is patched in place — a folder keeps its id, only the label moves.
 */
export async function renameDance(id: string, name: string): Promise<void> {
  const s = useDance.getState();
  const text = name.trim();
  if (!text) return;
  if (s.id === id) {
    if (s.name === text) return;
    useDance.setState({ name: text }); // the subscribe above mirrors it into the list and saves
    await saveDance();
    return;
  }
  const path = danceProject(id);
  const raw = await window.forge.readText(path).catch(() => null);
  if (!raw) return;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  doc.name = text;
  await write(path, JSON.stringify(doc, null, 1));
  useDance.setState({ list: s.list.map((e) => (e.id === id ? { ...e, name: text } : e)) });
  await saveIndex();
}

/**
 * Reads the expression keys out of the action VMD: an MMD action usually animates its own morphs (blinks, mouth, eyes),
 * and those are the dance's face — the author does not have to find a separate `.face` for them.
 */
export async function loadMorphs(): Promise<void> {
  const path = useDance.getState().source.action;
  if (!path) {
    useDance.setState({ morphs: [] });
    return;
  }
  try {
    const morphs = parseVmd(await readBytes(path)).morphs;
    useDance.setState({ morphs });
  } catch (e) {
    useStore.getState().log(`dance morphs: ${(e as Error).message}`);
    useDance.setState({ morphs: [] });
  }
}

/** Reads the baked dance (and camera) back so the stage can play it; a missing file just leaves the stage empty. */
export async function loadBaked(): Promise<void> {
  const s = useDance.getState();
  if (!s.baked.dance) return useDance.setState({ file: null });
  try {
    const bytes = await fetch(fileUrl(s.baked.dance)).then((r) => r.arrayBuffer());
    const file = readDance(new Uint8Array(bytes));
    useDance.setState({ file, cam: s.baked.cam ? { file: s.baked.cam, at: s.baked.at } : null });
  } catch (e) {
    useStore.getState().log(`dance: ${(e as Error).message}`);
    useDance.setState({ file: null });
  }
}

/** Copies a file the author picked into the dance's folder, so the dance carries everything it needs. */
export async function importInto(kind: keyof DanceSource, sourcePath: string, fileName: string): Promise<string> {
  const s = useDance.getState();
  if (!s.dir) throw new Error('no dance is open');
  const dest = `${s.dir}\\${fileName}`;
  await window.forge.copyFile(sourcePath, dest);
  useDance.setState({ source: { ...s.source, [kind]: dest } });
  if (kind === 'action') await loadMorphs();
  await saveDance();
  // A camera or song imported after the strips were laid out gets its own whole strip; existing cuts are kept.
  await syncTracks();
  return dest;
}

/** Runs the bake: Blender + mmd_tools turn the VMD into the game's `.dance` (main/dance.ts runs it). */
export async function bakeAction(): Promise<boolean> {
  const s = useDance.getState();
  if (!s.dir || !s.source.action) return false;
  const out = `${s.dir}\\dance.dance`;
  useDance.setState({ busy: 'bake', log: [] });
  const off = window.forge.onDanceProgress((line) => {
    const log = useDance.getState().log;
    useDance.setState({ log: [...log.slice(-200), line] });
  });
  try {
    const result = await window.forge.bakeDance({ vmd: s.source.action, out, name: s.name });
    if (!result.ok) {
      const why =
        result.reason === 'blender'
          ? '没有找到 Blender：装一个 4.2 以上的 Blender，或者在上面填好它的位置。'
          : result.reason === 'busy'
            ? '已经在转换另一个舞蹈了，等它结束。'
            : `转换失败：${result.detail ?? ''}`;
      useStore.getState().toast('error', why);
      useDance.setState({ busy: null });
      return false;
    }
    useDance.setState({ baked: { dance: out, cam: useDance.getState().baked.cam, at: Date.now() }, busy: null });
    await saveDance();
    await loadBaked();
    await syncTracks();
    useStore.getState().toast('ok', `已转换成游戏用的舞蹈（${useDance.getState().file?.frames ?? 0} 帧）`);
    return true;
  } finally {
    off();
    useDance.setState({ busy: null });
  }
}

/** A name the game can use for the files: the dance is known by its filename, so it has to be a valid one. */
export function gameName(name: string): string {
  const clean = name
    .replace(/[\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || 'Dance';
}

const readBytes = async (path: string): Promise<Uint8Array> => {
  const response = await fetch(fileUrl(path));
  return new Uint8Array(await response.arrayBuffer());
};

export interface DanceOutput {
  /** Where the three files are; the apply step copies them into the game from here. */
  dir: string;
  dance: string;
  cam: string | null;
  wav: string | null;
  face: string | null;
  seconds: number;
}

/** The camera move in the game's space: a VMD is converted with MMD's easing baked in (one key per frame), a `.cam` is
 * already in the game's space and read as it is. */
export async function cameraKeys(): Promise<CamKey[]> {
  const path = useDance.getState().source.camera;
  if (!path) return [];
  const bytes = await readBytes(path);
  if (/\.cam$/i.test(path)) return readCam(bytes);
  return bakeCam(parseVmd(bytes).camera);
}

/** Seconds of the song, for the panels: 0 when there is none or it cannot be read. */
export async function songSeconds(): Promise<number> {
  const path = useDance.getState().source.audio;
  if (!path) return 0;
  try {
    const song = await decodeSong(await readBytes(path).then((b) => b.buffer as ArrayBuffer));
    return song.seconds;
  } catch {
    return 0;
  }
}

/**
 * Builds what the game loads, trim and name applied, into `<dance folder>/out/`: the `.dance` (only rewritten when it
 * has to be cut), its `.cam` and its `.wav` under the same name. The plugin takes the filename as the dance's identity.
 */
export async function exportDance(): Promise<DanceOutput | null> {
  const s = useDance.getState();
  const dance = s.file;
  const toast = useStore.getState().toast;
  if (!s.dir || !dance || !s.baked.dance) {
    toast('error', '还没有转换过的舞蹈可以导出：先在第 1 步把动作转成舞蹈。');
    return null;
  }
  const dir = `${s.dir}\\out`;
  const base = gameName(s.name);
  const length = danceLength(s);
  const action = s.tracks.action;
  if (!action.length || length <= 0) {
    toast('error', '时间线上没有动作：先在 1. 动作与音乐 里导入并转换一个舞蹈。');
    return null;
  }
  // Everything is rebuilt on the timeline's clock: output frame f shows the action's second `trackSourceAt(action, f / rate)`,
  // so strips that were cut and slid play where the author put them, and a gap holds the frame its last strip ended on.
  const frames = Math.max(2, Math.round(length * dance.rate) + 1);
  if (frames < 2) {
    toast('error', '剪辑后剩下的太短了，至少要有两帧。');
    return null;
  }
  const sourceSecond = (frame: number): number => trackSourceAt(action, frame / dance.rate);
  useDance.setState({ busy: 'export' });
  try {
    const dancePath = `${dir}\\${base}.dance`;
    // One strip covering the whole take is the file as it was baked: copied rather than rebuilt frame by frame.
    const only = action.length === 1 ? action[0]! : null;
    const whole =
      !!only &&
      only.start <= 1e-6 &&
      only.in <= 1e-6 &&
      only.out >= danceSeconds(dance) - 1e-6 &&
      frames === dance.frames;
    await window.forge.writeFile(
      dancePath,
      whole ? await readBytes(s.baked.dance) : writeDanceMapped(dance, frames, (f) => sourceSecond(f) * dance.rate),
    );

    let camPath: string | null = null;
    const camClips = s.tracks.camera;
    if (s.useCamera && camClips.length && s.source.camera) {
      const keys = await cameraKeys();
      if (keys.length) {
        const out: CamKey[] = [];
        for (let f = 0; f < frames; f++) {
          const at = camAt(keys, trackSourceAt(camClips, f / dance.rate));
          if (at) out.push({ ...at, t: f / dance.rate });
        }
        if (out.length) {
          camPath = `${dir}\\${base}.cam`;
          await window.forge.writeFile(camPath, writeCam(out));
        }
      }
    }

    // The face: an imported `.face` is already baked for one mesh (the plugin checks its vertices), so it is carried as it
    // is; otherwise the action's own morph keys become curves on the dance's clock, which the skin's own morph names answer.
    let facePath: string | null = null;
    if (s.source.face) {
      facePath = `${dir}\\${base}.face`;
      await window.forge.writeFile(facePath, await readBytes(s.source.face));
    } else if (s.useMorphs && s.morphs.length) {
      const curves = faceCurvesMapped(s.morphs, frames, (f) => sourceSecond(f) * dance.rate);
      if (curves.length) {
        facePath = `${dir}\\${base}.face`;
        await window.forge.writeFile(facePath, writeFace(curves));
      }
    }

    // The song is laid onto the timeline one strip at a time, each at its own place on the clock: silence in the gaps, so
    // music and picture stay together wherever the author cut and slid the pieces.
    let wavPath: string | null = null;
    const music = s.tracks.music;
    if (s.source.audio && music.length) {
      try {
        const song = await decodeSong(await readBytes(s.source.audio).then((b) => b.buffer as ArrayBuffer));
        const rate = song.sampleRate;
        const channels = song.channels;
        const total = Math.max(1, Math.round(length * rate));
        const samples = new Float32Array(total * channels);
        for (const strip of music) {
          const fromSample = Math.round(strip.in * rate);
          const toSample = Math.round(strip.start * rate);
          const count = Math.round(clipSpan(strip) * rate);
          for (let i = 0; i < count; i++) {
            const dst = (toSample + i) * channels;
            const src = (fromSample + i) * channels;
            if (dst < 0 || dst + channels > samples.length) continue;
            if (src < 0 || src + channels > song.samples.length) continue;
            // The strip's own level and fades, the same curve the preview's volume follows.
            const level = gainAt(strip, strip.start + i / rate);
            for (let c = 0; c < channels; c++) samples[dst + c] = song.samples[src + c]! * level;
          }
        }
        wavPath = `${dir}\\${base}.wav`;
        await window.forge.writeFile(wavPath, toWav({ channels, sampleRate: rate, samples, seconds: total / rate }));
      } catch (e) {
        useStore.getState().log(`dance audio: ${(e as Error).message}`);
        toast('error', '音乐读不出来，这次只导出舞蹈和相机。');
      }
    }

    const out = { dir, dance: dancePath, cam: camPath, wav: wavPath, face: facePath, seconds: length };
    useStore.getState().log(`dance export: ${JSON.stringify(out)}`);
    toast('ok', `已生成游戏用的文件：${base}.dance${camPath ? '、.cam' : ''}${wavPath ? '、.wav' : ''}${facePath ? '、.face' : ''}`);
    return out;
  } catch (e) {
    toast('error', `导出失败：${(e as Error).message}`);
    return null;
  } finally {
    useDance.setState({ busy: null });
  }
}

/** Moves a dance and its working folder to the Recycle Bin, as a skin's delete does, so it can be put back from there;
 * deleting the open one opens the next newest, else leaves the tab on no dance. */
export async function deleteDance(id: string): Promise<void> {
  const open = useDance.getState().id === id;
  try {
    await call('project.delete', { path: danceProject(id) });
  } catch (e) {
    useStore.getState().fail(e, t('dance.deleteFailed'));
    return;
  }
  await refreshDances();
  const [next] = useDance.getState().list;
  if (!open) return;
  useDance.setState({ ...initial, mode: 'dance', list: useDance.getState().list });
  if (next) await openDance(next.id);
}

/** Switches the window to 舞蹈: lists the dances and opens one, so the tab is never blank when a dance exists. */
export async function enterDance(): Promise<void> {
  useDance.setState({ mode: 'dance' });
  await refreshDances();
  const s = useDance.getState();
  if (!s.id && s.list[0]) await openDance(s.list[0].id);
}

/**
 * 应用到游戏: the dance's files, installed into the chosen profile with the plugin that plays them. Only this editor's own
 * three plugins are installed — BepInExPack_GTFO and GTFO_API are the author's, and the result says when they are missing.
 */
export async function applyDance(): Promise<boolean> {
  const s = useDance.getState();
  const { profiles, prefs, toast } = useStore.getState();
  const profile = profiles.find((p) => p.path === prefs.profilePath);
  if (!profile) {
    toast('error', '先在右上角选一个游戏档案，再把舞蹈装进去。');
    return false;
  }
  try {
    if (!(await ensurePlugin())) return false;
    const built = await exportDance();
    if (!built) return false;
    useDance.setState({ busy: 'apply' });
    const result = await call('dance.install', { profile: profile.path, dir: built.dir, name: gameName(s.name) });
    useStore.getState().log(`dance apply: ${JSON.stringify(result)}`);
    if (result.missing.length) {
      toast('info', `舞蹈装好了，但游戏还缺 ${result.missing.join('、')}：这两个要在 r2modman 里自己装一次，装好就能用了。`);
    } else {
      toast('ok', `已装进 ${profile.name}：进游戏按 F9 就能在列表里看到它。`);
    }
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    toast('error', code === 'game-running' ? '游戏正开着，先关掉游戏再装。' : `装进游戏失败：${(e as Error).message}`);
    return false;
  } finally {
    useDance.setState({ busy: null });
  }
}
