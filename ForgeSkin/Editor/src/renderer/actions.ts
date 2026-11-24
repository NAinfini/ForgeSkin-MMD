// Multi-step user actions: applying the open character to the game, keeping the profile's plugin current, and moving the data folder.
import { buildCharacterPack, saveCharacter } from './character/model';
import { matchReady, useCharacter } from './character/state';
import { call, type Profile } from './protocol';
import { DATA_NOTICE, useStore } from './store';
import { t } from './i18n';
import { detail, friendly } from './errors';

const st = () => useStore.getState();

let building = false;
let applyAgain = false;

/** Runs one build or apply at a time; undefined (with a note unless `quiet`) when another is still going. The one running
 * owns `busy` and clears it when done; an automatic apply asked for meanwhile runs once after it. */
export async function exclusive<T>(fn: () => Promise<T>, quiet = false): Promise<T | undefined> {
  if (building) {
    if (!quiet) st().toast('info', t('actions.building'));
    return undefined;
  }
  building = true;
  try {
    return await fn();
  } finally {
    building = false;
    useStore.setState({ busy: null });
    if (applyAgain) {
      applyAgain = false;
      void applyToGame(true);
    }
  }
}

/** What stops 应用到游戏 for the chosen profile, in plain words; null when it can go ahead. */
export function profileProblem(profile: Profile | undefined): string | null {
  if (!profile) return t('actions.k8');
  if (!profile.hasBepInEx) return t('actions.k9', { v0: profile.name });
  return null;
}

/** The plugin version this editor ships, as said to the user; the backend gives none when its plugin files are missing. */
export const shippedLabel = (profile: Profile) => profile.pluginShipped ?? t('works.shippedNone');

let edition: Promise<'dev' | 'installed' | 'portable'> | null = null;
/** dev: run from a checkout; installed or portable: a packaged editor carrying its own plugin/. */
export const editorEdition = () => (edition ??= window.forge.edition());

/** plugin.install into `profile`. The development editor first builds and stages the plugin from its checkout, so it never
 * installs an old build; when it cannot, the error carries the build's last lines for the log. What the install moved away
 * is reported (PLAN §4.5). */
export async function installPluginInto(profile: string) {
  if ((await editorEdition()) === 'dev') {
    const staged = await window.forge.stagePlugin();
    if (!staged.ok) throw { code: 'dev-plugin', message: `build-editor-release.ps1 -PluginOnly failed (whole output in app.log, "plugin stage"): ${staged.detail ?? ''}` };
  }
  const r = await call('plugin.install', { profile });
  for (const note of r.notes) st().report('info', note);
  return r;
}

// BepInEx's verdicts already reported, so a check repeated on focus, a profile change or a game start says each once per run.
const toldLoad = new Set<string>();
/** What BepInEx said about ForgeCore and ForgeSkin the last time the game started from `profile` (plugin.loadCheck reads its
 * LogOutput.log): each refusal once, the full account to app.log and a short toast. A ForgeSkin skipped only because ForgeCore
 * did not load is left to the ForgeCore message, which names the cause. */
export async function checkPluginLoad(profile: string): Promise<void> {
  const r = await call('plugin.loadCheck', { profile }).catch((e: unknown) => (window.forge.appLog('plugin.loadCheck', detail(e)), null));
  const notes = (r?.notes ?? []).filter((n) => !toldLoad.has(n.detail));
  const causes = notes.filter((n) => n.code !== 'load-dependency-failed');
  for (const note of notes) {
    toldLoad.add(note.detail);
    if (causes.length && !causes.includes(note)) window.forge.appLog(`install ${note.code}`, note.detail);
    else st().report('error', note);
  }
}

// Profiles already told that the editor leaves their newer store plugin alone (once per editor run and set of copies, unless
// `again`: the user asked for the install).
const toldNewer = new Set<string>();
export function tellNewer(profile: Profile, again = false) {
  const newer = profile.pluginNewer ?? [];
  const key = `${profile.path}|${newer.join(',')}`;
  if (!newer.length || (toldNewer.has(key) && !again)) return;
  toldNewer.add(key);
  st().toast('info', t('actions.pluginNewer', { v0: profile.name, v1: newer.join(', ') }));
}

/**
 * Installs or updates the skin plugin in the chosen profile when it is missing or not this app's build, like a mod
 * manager would. While the running game holds an old plugin the update waits (`pluginPending`) and is retried once the
 * game is closed. Returns false when the plugin is still not the current one.
 */
export async function ensurePlugin(quiet = false): Promise<boolean> {
  // Read the chosen profile fresh (the plugin files may have changed on disk since the list was last loaded), and only that
  // one: reading every mod manager profile takes seconds, before every apply.
  const s = st();
  const known = s.profiles.find((p) => p.path === s.prefs.profilePath);
  const fresh = known ? await call('profiles.get', { path: known.path }).catch(() => null) : null;
  const profile = fresh ? { ...fresh, name: known!.name } : known;
  if (fresh) useStore.setState({ profiles: st().profiles.map((p) => (p.path === profile!.path ? profile! : p)) });
  if (profile?.hasBepInEx) tellNewer(profile);
  if (!profile?.hasBepInEx || profile.pluginCurrent !== false) return true;
  // Say which problem this is before fixing it; not an error, the install follows by itself.
  const why = profile.pluginVersion
    ? t('actions.pluginWrong', { v0: profile.name, v1: profile.pluginVersion, v2: shippedLabel(profile) })
    : t('actions.pluginMissing', { v0: profile.name, v1: shippedLabel(profile) });
  try {
    if (!quiet) s.toast('info', why);
    await installPluginInto(profile.path);
    useStore.setState({ pluginPending: null });
    await s.refreshProfiles();
    s.toast('ok', t(profile.pluginVersion ? 'actions.pluginUpdated' : 'actions.pluginInstalled', { v0: profile.name }));
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'game-running') {
      useStore.setState({ pluginPending: profile.path });
      if (!quiet) s.toast('info', `${why} ${t('actions.pluginUpdate')}`);
    } else failedAt(e, t('actions.stepPlugin'));
    return false;
  }
}

/** 应用到游戏: the open character skin, built and installed into the chosen profile so the game shows it on the player. */
export async function applyToGame(quiet = false): Promise<void> {
  if (building && quiet) return void (applyAgain = true);
  await exclusive(() => apply(quiet), quiet);
}

/** 「装进档案」: the open character built and installed, without becoming the skin the game uses. */
export async function installToProfile(): Promise<void> {
  await exclusive(() => apply(false, false));
}

/** `wear` false (「装进档案」): installed without becoming the game's choice for the character. */
async function apply(quiet: boolean, wear = true): Promise<void> {
  const s = st();
  const c = useCharacter.getState();
  if (!c.skinId || !matchReady(c.check)) return quiet ? undefined : s.toast('error', t('character.applyNotReady'));
  const profile = s.profiles.find((p) => p.path === s.prefs.profilePath);
  const blocked = profileProblem(profile);
  if (blocked || !profile) return quiet ? undefined : s.toast('error', blocked ?? '');
  // The step under way, named in the toast when it fails.
  let step = t('actions.stepPlugin');
  try {
    useStore.setState({ busy: t('actions.k10') });
    if (!(await ensurePlugin())) return;
    step = t('actions.stepBuild');
    const pack = await buildCharacterPack(`${s.dataDir}\\packs\\${useCharacter.getState().skinId}.forgeskin`);
    step = t('actions.stepInstall');
    useStore.setState({ busy: t('actions.k11') });
    logDropped(useCharacter.getState().name, await call('pack.install', { pack, profile: profile.path, activate: wear, pick: wear }));
    void s.refreshInstalled();
    if (!wear) return s.toast('ok', t('works.installedOnly', { v0: useCharacter.getState().name, v1: profile.name }));
    s.toast('ok', t('character.applied', { v0: profile.name }));
    s.log(t('actions.k14', { v0: pack, v1: profile.path }));
  } catch (e) {
    failedAt(e, step);
  }
}

/** Whether the game runs now (not when the window last looked) and was started from `profile`: a game running another profile
 * never sees this install. */
async function gameRunning(profile: string): Promise<boolean> {
  const running = (await call('game.locate', { profile }).catch(() => null))?.running ?? false;
  useStore.setState((x) => ({ game: x.game && { ...x.game, running } }));
  return running;
}

/** Makes an installed character skin the one the game uses (the profile's other skins stay installed). */
export async function activateSkin(id: string, name: string): Promise<void> {
  const s = st();
  const profile = s.profiles.find((p) => p.path === s.prefs.profilePath);
  if (!profile) return;
  try {
    await call('pack.activate', { profile: profile.path, skinId: id });
    await s.refreshInstalled();
    s.toast('ok', `${t('skins.activated', { v0: name })} · ${(await gameRunning(profile.path)) ? t('actions.k12') : t('works.nextLaunch')}`);
  } catch (e) {
    s.fail(e);
  }
}

/** Other copies of the skin the install moved to the Recycle Bin, said in the log. */
export function logDropped(name: string, r: { dropped?: string[] | null }) {
  if (r.dropped?.length) st().log(t('gameLog.dropped', { v0: name, v1: r.dropped.join('、') }));
}

/** One toast for a failed 应用到游戏: the step it stopped at and why (a backend code in plain words, else the error's own
 * text, such as the file an image could not be read from); the full error goes to the log. */
function failedAt(e: unknown, step: string) {
  const s = st();
  window.forge.appLog('error', detail(e));
  const own = (e as { message?: string } | undefined)?.message ?? String(e);
  const text = t('actions.applyFailed', { v0: step, v1: friendly(e, own) });
  s.log(text);
  s.toast('error', text);
}

/** A Thunderstore mod name (ASCII letters, digits and _) from a skin name. A name written in Latin letters keeps them (accents
 * dropped); one in another script (a Chinese name) would keep only its stray digits and Latin bits, so `fallback` is used. */
export const modName = (name: string, fallback: string) => (/[^\u0000-ɏ]/.test(name) ? '' : asciiName(name)) || fallback;

const asciiName = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // the accents NFKD splits off (Köning: o + ¨), not a word break
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Settings → data folder: saves the open character, moves the data (main/dataDir.ts) and reloads the window on success. */
export async function moveDataFolder(): Promise<void> {
  const [to] = await window.forge.openDialog('folder', undefined, 'dataDir');
  if (!to) return;
  await exclusive(async () => {
    useStore.setState({ busy: t('dataDir.moving') });
    await saveCharacter();
    const r = await window.forge.moveDataDir(to);
    if (!r.ok) return st().toast('error', t(`dataDir.${r.reason}`, { v0: r.detail ?? '' }));
    const notice = r.adopted ? t('dataDir.adopted', { v0: to }) : r.leftover ? t('dataDir.leftover', { v0: r.leftover }) : t('dataDir.moved', { v0: to });
    sessionStorage.setItem(DATA_NOTICE, notice);
    window.location.reload();
  });
}