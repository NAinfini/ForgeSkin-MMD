// The editor's one store, now that it edits character skins only: the app shell's state (startup, the backend, the data folder,
// the game and the chosen profile, what is installed there, the character works, the log panel, updates and preferences).
import { create } from 'zustand';
import { call, type GameInfo, type InstalledPack, type InstallNote, type Profile, type ProjectEntry } from './protocol';
import { detail, friendly } from './errors';
import { notify, type NotifyAction, type NotifyKind } from './ui/notify';
import { setLang, systemLang, t, type Lang } from './i18n';

export interface Prefs {
  profilePath: string | null;
  /** The user picked `profilePath` in the profile menu (not the editor's guess of the most recently used one); only then does
   * the editor install its plugin there on its own. */
  profileChosen: boolean;
  /** UI language; null follows the system. */
  lang: Lang | null;
}

const PREFS_KEY = 'sf.prefs';
export const DEFAULT_PREFS: Prefs = { profilePath: null, profileChosen: false, lang: null };

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { profilePath: saved.profilePath ?? null, profileChosen: saved.profileChosen ?? false, lang: saved.lang ?? null };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export interface LogLine {
  time: string;
  text: string;
  count: number;
}

export const logText = (l: LogLine) => `[${l.time}] ${l.text}${l.count > 1 ? ` ×${l.count}` : ''}`;

/** What a data folder move reported (actions.moveDataFolder), shown once the reloaded window starts. */
export const DATA_NOTICE = 'sf.dataNotice';

interface State {
  ready: boolean;
  backendDown: boolean;
  dataDir: string;
  game: GameInfo | null;
  profiles: Profile[];
  /** Skins installed in the chosen profile. */
  installed: InstalledPack[];
  /** The character works: one autosaved project each (character/model.ts writes it). */
  characters: ProjectEntry[];
  prefs: Prefs;
  logs: LogLine[];
  progress: { text: string; done: number; total: number } | null;
  /** A newer version the update feed holds that this installed copy can download; nothing is downloaded until startUpdate. */
  updateVersion: string | null;
  /** That version downloading, after the user asked for it (total 0 when its size is unknown). */
  update: { received: number; total: number } | null;
  /** A new version is downloaded; restarting installs it. */
  updateReady: boolean;
  /** Plain message when the last character autosave failed; null when it worked. */
  autosaveError: string | null;
  busy: string | null;
  /** Profile whose plugin update waits for the game to close. */
  pluginPending: string | null;

  init(): Promise<void>;
  loadAll(): Promise<void>;
  checkUpdate(asked: boolean): Promise<void>;
  startUpdate(): void;
  log(line: string): void;
  toast(kind: NotifyKind, text: string, action?: NotifyAction): void;
  fail(e: unknown, fallback?: string): void;
  /** A plugin install's note or BepInEx's verdict: the full account to app.log, the short message to the log panel and a toast. */
  report(kind: NotifyKind, note: InstallNote): void;
  setPrefs(p: Partial<Prefs>): void;
  refreshGame(): Promise<void>;
  chooseGameDir(): Promise<void>;
  refreshProfiles(): Promise<void>;
  refreshInstalled(): Promise<void>;
  refreshCharacters(): Promise<void>;
}

let initialised = false;
/** The init run in flight: StrictMode's double effect and the backend-ready retry share it instead of loading twice. */
let initRun: Promise<void> | undefined;

type Set = (p: Partial<State>) => void;

function subscribe(f: Window['forge'], set: Set, get: () => State) {
  f.onLog((line) => get().log(line));
  f.onUpdateProgress((received, total) => {
    if (received < 0) get().toast('error', t('topBar.update.failed'));
    set({ update: received < 0 || (total > 0 && received >= total) ? null : { received, total } });
  });
  f.onUpdateReady(() => {
    set({ update: null, updateReady: true, updateVersion: null });
    get().toast('ok', t('app.updateReady'), { label: t('app.restartUpdate'), run: () => void f.restartToUpdate() });
  });
  f.onEvent((event, data) => {
    if (event === 'progress') {
      const p = data as { done: number; total: number; text: string };
      set({ progress: p.done >= p.total ? null : p });
    }
  });
  f.onStatus((s) => {
    set({ backendDown: s !== 'ready' });
    // The backend came back after a crash before anything loaded: load again.
    if (s === 'ready' && !get().ready) setTimeout(() => void get().init(), 500);
    if (s === 'down') get().toast('error', t('store.k1'));
  });
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  backendDown: false,
  dataDir: '',
  game: null,
  profiles: [],
  installed: [],
  characters: [],
  prefs: loadPrefs(),
  logs: [],
  progress: null,
  updateVersion: null,
  update: null,
  updateReady: false,
  autosaveError: null,
  busy: null,
  pluginPending: null,

  init() {
    initRun ??= get()
      .loadAll()
      .finally(() => (initRun = undefined));
    return initRun;
  },
  async loadAll() {
    const f = window.forge;
    if (!initialised) {
      initialised = true;
      subscribe(f, set, get);
      void get().checkUpdate(false);
    }
    const dataDir = await f.dataDir();
    set({ dataDir });
    // The drawn pack pictures stay under 512 MB, oldest first; forgetting one only means drawing it again.
    void f.pruneCache(`${dataDir}\\cache\\packs`, 512 << 20).catch(() => undefined);
    const notice = sessionStorage.getItem(DATA_NOTICE);
    if (notice) {
      sessionStorage.removeItem(DATA_NOTICE);
      get().toast('ok', notice);
    }
    await get().refreshGame();
    await get().refreshProfiles();
    await Promise.all([get().refreshInstalled(), get().refreshCharacters()]);
    set({ ready: true });
  },
  async checkUpdate(asked) {
    const r = await window.forge.checkUpdate();
    if (r.state === 'available') {
      set({ updateVersion: r.version });
      get().toast('info', t('topBar.update.available', { v0: r.version }), { label: t('topBar.update.get'), run: () => get().startUpdate() });
    } else if (r.state === 'portable') get().toast('info', t('topBar.update.portable', { v0: r.version }));
    else if (asked) get().toast(r.state === 'error' ? 'error' : 'ok', t(`topBar.update.${r.state}`));
  },
  startUpdate() {
    if (get().update || get().updateReady) return;
    set({ update: { received: 0, total: 0 } });
    void window.forge.downloadUpdate();
  },
  log(line) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // A line already in the panel is one entry: it moves to the end with the latest time and how often it came.
    set((s) => {
      const old = s.logs.find((l) => l.text === line);
      return { logs: [...s.logs.filter((l) => l !== old).slice(-499), { time, text: line, count: (old?.count ?? 0) + 1 }] };
    });
  },
  toast(kind, text, action) {
    notify(kind, text, action);
  },
  // The log panel keeps the plain words; the raw error (code and backend text) goes only to the log file.
  fail(e, fallback) {
    const text = friendly(e, fallback);
    window.forge.appLog('error', detail(e));
    get().log(text);
    get().toast('error', text);
  },
  report(kind, note) {
    window.forge.appLog(`install ${note.code}`, note.detail);
    const text = t(`install.${note.code}`, { ...note.args, defaultValue: '' });
    get().log(text);
    get().toast(kind, text);
  },
  setPrefs(p) {
    const prefs = { ...get().prefs, ...p };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    set({ prefs });
    setLang(prefs.lang ?? systemLang());
  },

  async refreshGame() {
    try {
      const game = await call('game.locate', { profile: get().prefs.profilePath });
      set({ game });
      if (game.found) get().log(t('store.k3', { v0: game.gameDir }));
    } catch (e) {
      get().log(`game.locate: ${detail(e)}`);
      set({ game: { found: false, running: false, gameDir: null, dataDir: null } });
    }
  },
  async chooseGameDir() {
    const [dir] = await window.forge.openDialog('folder', undefined, 'game');
    if (!dir) return;
    try {
      const game = await call('game.setDir', { dir });
      set({ game });
      if (!game.found) get().toast('error', t('store.k4'));
      else {
        get().toast('ok', t('store.k5'));
        await get().refreshProfiles();
      }
    } catch (e) {
      get().fail(e);
    }
  },
  async refreshProfiles() {
    try {
      const profiles = await call('profiles.list', {});
      const before = get().prefs.profilePath;
      set({ profiles });
      // The last one used while it still has BepInEx; else the most recently changed one with BepInEx; else none.
      const last = profiles.find((p) => p.path === get().prefs.profilePath && p.hasBepInEx);
      const ready = profiles.filter((p) => p.hasBepInEx).sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
      const pick = last ?? ready[0];
      get().setPrefs(last ? {} : { profilePath: pick?.path ?? null, profileChosen: false });
      if (before && !profiles.some((p) => p.path === before)) get().toast('info', t('store.profileGone', { v0: before }));
    } catch (e) {
      get().log(`profiles.list: ${detail(e)}`);
    }
  },
  async refreshInstalled() {
    const s = get();
    const profile = s.profiles.find((p) => p.path === s.prefs.profilePath);
    // Copies of the same skin go to the Recycle Bin, said in the log.
    const installed = profile?.hasBepInEx ? await call('pack.list', { profile: profile.path, tidy: true }).catch((e) => (s.log(`pack.list: ${detail(e)}`), [])) : [];
    for (const p of installed) if (p.dropped?.length) s.log(t('gameLog.dropped', { v0: p.name, v1: p.dropped.join('、') }));
    // A profile chosen meanwhile has its own read under way.
    if (get().prefs.profilePath === s.prefs.profilePath) set({ installed });
  },
  async refreshCharacters() {
    // Before the data folder is known a `\autosave\character` would be drive-relative (D:\autosave\character): nothing to list yet.
    if (!get().dataDir) return;
    const characters: ProjectEntry[] = await call('project.list', { dir: `${autosaveRoot()}\\character` }).catch((e) => (get().log(`project.list: ${detail(e)}`), []));
    set({ characters });
  },
}));

/** Where skins live: one autosaved project each under here (character/model.ts: `character/`). */
export const autosaveRoot = (): string => `${useStore.getState().dataDir}\\autosave`;