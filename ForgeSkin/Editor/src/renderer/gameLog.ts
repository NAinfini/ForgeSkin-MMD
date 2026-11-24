// The skin plugin's own log (forgeskin.log in the chosen profile, cleared at each game launch): reading what the game did with
// the character skin, in plain words.
import { useEffect } from 'react';
import { call } from './protocol';
import { useStore } from './store';
import { t } from './i18n';

export interface PluginLine {
  time: string;
  level: 'info' | 'warn';
  message: string;
}

/**
 * Reads forgeskin.log on from where the previous read stopped: each read returns only the lines written since (all of them again,
 * with `reset`, after the game was started again and cleared the log), and only those after `since`. A read while the previous one
 * is still running returns null.
 */
export function pluginLogReader(profile: string, since?: string) {
  let from = 0;
  let head = '';
  let busy = false;
  return async (): Promise<{ lines: PluginLine[]; reset: boolean } | null> => {
    if (busy) return null;
    busy = true;
    try {
      const r = await call('plugin.log', { profile, since, from, head });
      from = r.next;
      head = r.head;
      return r;
    } finally {
      busy = false;
    }
  };
}

/** The plugin's label ("Raptus Steigro [1P]", "… [pickup item:12]") as "Raptus Steigro（第一人称）". */
function gear(label: string): string {
  const m = label.match(/^(.+?) \[(1P|3P|placed|menu|pickup)\b[^\]]*\]$/);
  return m ? `${m[1]}（${t(`gameLog.view.${m[2] as '1P' | '3P' | 'placed' | 'menu' | 'pickup'}`)}）` : label;
}

/** A plugin warning in plain words; unknown ones keep the plugin's text. */
export function plainPluginLine(message: string): string {
  let m: RegExpMatchArray | null;
  if ((m = message.match(/^(.+?): bad-audio: sound (.+?): .*; skin not loaded$/))) return t('gameLog.badAudio', { v0: m[1], v1: m[2] });
  if ((m = message.match(/^(.+?): .+?: (.+); skin not loaded$/))) return t('gameLog.notLoaded', { v0: m[1], v1: m[2] });
  if ((m = message.match(/: material (.+) matched no renderer/))) return t('gameLog.noRenderer', { v0: m[1] });
  if ((m = message.match(/: revert (.+): the game's material was destroyed/))) return t('gameLog.destroyed', { v0: m[1] });
  if ((m = message.match(/^(.+): \d+x\d+ is not a multiple of 4, left uncompressed$/))) return t('gameLog.notMultiple', { v0: m[1].split(/[\\/]/).pop() });
  if ((m = message.match(/^(.+): update failed: (.+); left vanilla$/))) return t('gameLog.updateFailed', { v0: gear(m[1]), v1: m[2] });
  if ((m = message.match(/^(.+): active skin (.+) is not installed; left vanilla$/))) return t('gameLog.notInstalled', { v0: gear(m[1]), v1: m[2] });
  if ((m = message.match(/^(.+\]): (.+); left vanilla$/))) return t('gameLog.leftVanilla', { v0: gear(m[1]), v1: m[2] });
  if ((m = message.match(/^(.+\]): code effect \S+ \((.*)\): skipped, (.+)$/))) return t('gameLog.fxSkipped', { v0: gear(m[1]), v1: m[2], v2: m[3] });
  if ((m = message.match(SAME_ID))) return t('gameLog.sameId', { v0: skinName(m[1]) });
  return message;
}

const SAME_ID = /^two packs share id (\S+); /;

/** A skin by its name: the installed pack's, else the editor's own character work, else its id. */
function skinName(id: string): string {
  const s = useStore.getState();
  return s.installed.find((p) => p.id === id)?.name || s.characters.find((k) => k.id === id)?.name || id;
}

/** Plugin warnings as one toast's lines: the same kind said once (the skins installed twice named together), repeats dropped. */
export function plainWarnings(messages: string[]): string[] {
  // A skin the plugin saw twice is said only while the profile still holds two copies: the editor's listing moves the extra one to the
  // Recycle Bin (Install.Dedupe), and a warning the plugin wrote before that is out of date.
  const installed = useStore.getState().installed;
  const twice = [...new Set(messages.flatMap((m) => m.match(SAME_ID)?.[1] ?? []))].filter((id) => installed.filter((p) => p.id === id).length > 1);
  const rest = messages.filter((m) => !SAME_ID.test(m)).map(plainPluginLine);
  return [...new Set(twice.length ? [t('gameLog.sameId', { v0: twice.map(skinName).join('、') }), ...rest] : rest)];
}

/**
 * While the game runs, every plugin warning (a material destroyed, a skin not loaded, a character's physics file refused) goes
 * into the log panel and pops up as an alert as it happens.
 */
export function useGameWarnings() {
  const profile = useStore((s) => s.prefs.profilePath);
  const running = useStore((s) => !!s.game?.running);
  useEffect(() => {
    if (!running || !profile) return;
    const read = pluginLogReader(profile, new Date().toISOString());
    const poll = async () => {
      const lines = (await read().catch(() => null))?.lines ?? [];
      if (!lines.length) return;
      const warns = plainWarnings(lines.filter((l) => l.level === 'warn').map((l) => l.message));
      if (!warns.length) return;
      const s = useStore.getState();
      for (const w of warns) s.log(`${t('gameLog.warn')}: ${w}`);
      s.toast('error', `${t('gameLog.warned')} ${warns.join(' · ')}`);
    };
    const id = setInterval(() => void poll(), 3000);
    return () => clearInterval(id);
  }, [running, profile]);
}