import { ActionIcon, Button, Group, Progress, ScrollArea, Text, Tooltip } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useHotkeys } from '@mantine/hooks';
import { IconFileText, IconFolderDown, IconListNumbers, IconStack2, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Group as PanelGroup, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { applyToGame, checkPluginLoad, editorEdition, ensurePlugin } from './actions';
import { useGameWarnings } from './gameLog';
import { useProfile, useProfileSync } from './profile';
import { call } from './protocol';
import { logText, useStore } from './store';
import { InspectorTabs, RailHost } from './ui/InspectorTabs';
import { CurrentWork, Library } from './ui/Library';
import { Welcome } from './ui/Welcome';
import { HelpDocs } from './ui/HelpDocs';
import { TopBar } from './ui/TopBar';
import { CharacterInspector, CharacterSteps } from './character/CharacterPanels';
import { CharacterStage } from './character/CharacterStage';
import { DanceInspector, DanceStepsRail } from './dance/DancePanels';
import { DanceStage } from './dance/DanceStage';
import { useDance } from './dance/state';
import { importModel, openCharacter, reopenCharacter, saveCharacter } from './character/model';
import { useCharacter } from './character/state';
import { t, useLang } from './i18n';

/** The one-line status: rides the top bar beside the logo (it used to be a whole row of its own under the window, which
 * cost 28px of stage and was never read there). Only plain status here; backend log lines stay in the log panel. */
function StatusLine() {
  const busy = useStore((s) => s.busy);
  // Backend progress only matters while the user waits on something.
  const progress = useStore((s) => (s.busy ? s.progress : null));
  const update = useStore((s) => s.update);
  const updateReady = useStore((s) => s.updateReady);
  const updateVersion = useStore((s) => (s.update || s.updateReady ? null : s.updateVersion));
  const down = useStore((s) => s.backendDown);
  const saveError = useStore((s) => s.autosaveError);
  const name = useCharacter((s) => s.name || null);
  const dance = useDance((s) => s.name || null);
  const danceMode = useDance((s) => s.mode === 'dance');
  const text = down ? t('app.k1') : (progress?.text ?? busy ?? t('app.k2'));
  const profile = useProfile();
  const running = useStore((s) => !!s.game?.running);
  return (
    <div className="topbar-status">
      {profile?.pluginVersion && (
        <span className={`hot ${running ? 'live' : ''}`} data-tour="hot-reload">
          {running ? t('app.hotLive', { v0: profile.name }) : t('app.hotIdle', { v0: profile.name })}
        </span>
      )}
      <span className="grow">{text}</span>
      {progress && <Progress w={110} size="xs" value={(progress.done / Math.max(1, progress.total)) * 100} />}
      {update && (
        <Group gap={6} wrap="nowrap">
          <span>{update.total ? t('app.updating', { v0: Math.floor((update.received / update.total) * 100) }) : t('app.updatingUnknown')}</span>
          <Progress w={90} size="xs" value={update.total ? (update.received / update.total) * 100 : 100} animated={!update.total} striped={!update.total} />
        </Group>
      )}
      {updateVersion && (
        <Button size="compact-xs" variant="light" color="flare" onClick={useStore.getState().startUpdate}>
          {t('topBar.update.getVersion', { v0: updateVersion })}
        </Button>
      )}
      {updateReady && (
        <Tooltip label={t('app.updateReady')}>
          <Button size="compact-xs" color="flare" onClick={() => void window.forge.restartToUpdate()}>
            {t('app.restartUpdate')}
          </Button>
        </Tooltip>
      )}
      {saveError ? (
        <Tooltip label={saveError}>
          <span style={{ color: 'var(--mantine-color-red-4)' }}>{t('app.k6')}</span>
        </Tooltip>
      ) : (
        <span className="work-name">{(danceMode ? dance : name) ?? t('app.k7')}</span>
      )}
    </div>
  );
}

/** The log is a dock at the bottom of the window: opening it shortens the stage instead of floating over it. It used
 * to be a Drawer, which read as a popup laid over the picture; a dock keeps the whole log readable in place. */
function LogDock({ onClose }: { onClose: () => void }) {
  const logs = useStore((s) => s.logs).map(logText);
  const dataDir = useStore((s) => s.dataDir);
  return (
    <section className="log-dock">
      <div className="log-dock-head">
        <IconFileText size={15} />
        <b>{t('app.k3')}</b>
        <Button size="compact-xs" variant="default" onClick={() => void window.forge.openPath(`${dataDir}\logs`)}>
          {t('app.k11')}
        </Button>
        <Button size="compact-xs" variant="default" onClick={() => void navigator.clipboard.writeText(logs.join('\n'))}>
          {t('app.k12')}
        </Button>
        <ActionIcon variant="subtle" color="gray" size="sm" ml="auto" onClick={onClose} aria-label={t('app.k14')}>
          <IconX size={15} />
        </ActionIcon>
      </div>
      <ScrollArea className="log-dock-body">
        <pre className="log">{logs.join('\n') || t('app.k13')}</pre>
      </ScrollArea>
    </section>
  );
}

/** Dropping anywhere: a project file opens, a model (.glb/.vrm) imports, and any other file is refused by name. */
function onGlobalDrop(files: File[]) {
  const paths = files.map((f) => window.forge.pathOf(f)).filter(Boolean);
  if (!paths.length) return;
  const s = useStore.getState();
  const project = paths.find((p) => /\.forgeskinproj$/i.test(p));
  if (project) return void openCharacter(project);
  if (paths.some((p) => /\.gltf$/i.test(p))) return s.toast('error', t('errors.gltfUnsupported'));
  const model = paths.find((p) => /\.(glb|vrm)$/i.test(p));
  if (model) return void importModel(model);
  s.toast('error', t('errors.unsupportedFile'));
}

/** Opens a character project file the author picks (its autosave, or one someone shared). */
async function openProjectDialog() {
  const [p] = await window.forge.openDialog('file', [{ name: t('store.k11'), extensions: ['forgeskinproj'] }]);
  if (p) await openCharacter(p);
}

function useShortcuts() {
  useHotkeys([
    ['mod+s', () => void saveCharacter()],
    ['mod+o', () => void openProjectDialog()],
    ['mod+Enter', () => void applyToGame()],
  ]);
}

/** Keeps the 游戏运行中 badge live: asks every 2 s while the window has focus, and right away when it gets focus. */
function useGameRunning() {
  useGameWarnings();
  useEffect(() => {
    const check = async () => {
      const s = useStore.getState();
      if (!document.hasFocus() || !s.game?.found || s.backendDown) return;
      // Running from the chosen profile: a game started from another one never shows what is applied here.
      const game = await call('game.locate', { profile: s.prefs.profilePath }).catch(() => null);
      if (game && game.running !== useStore.getState().game?.running) useStore.setState({ game });
    };
    const id = setInterval(() => void check(), 2000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', check);
    };
  }, []);
}

/** Keeps the chosen profile's plugin current: on start, on a profile change or refresh, and once the game closes. Only a
 * packaged editor (its own plugin/) does this, and only in a profile the user picked; a development editor, and the
 * editors build scripts start, install only when the user asks (应用, or the profile menu). */
function useAutoPlugin() {
  const profile = useStore((s) => (s.prefs.profileChosen ? s.profiles.find((p) => p.path === s.prefs.profilePath) : undefined));
  const running = useStore((s) => !!s.game?.running);
  const due = !!profile?.hasBepInEx && profile.pluginCurrent === false;
  useEffect(() => {
    if (due) void editorEdition().then((e) => e !== 'dev' && ensurePlugin(true));
  }, [due, profile?.path, running]);
}

/** Reads what BepInEx said about ForgeCore and ForgeSkin in the chosen profile (PLAN §4.5): when the editor opens, on a profile
 * change, about 20 s after the game starts (BepInEx has decided by then) and when it closes. Only the game's log is read. */
function usePluginLoadCheck() {
  const profile = useStore((s) => s.profiles.find((p) => p.path === s.prefs.profilePath && p.hasBepInEx)?.path);
  const running = useStore((s) => !!s.game?.running);
  useEffect(() => {
    if (!profile) return;
    const id = setTimeout(() => void checkPluginLoad(profile), running ? 20000 : 0);
    return () => clearTimeout(id);
  }, [profile, running]);
}

/** The left panel: two side tabs on the window's edge, the works (profile, character list) and the open work's steps, each the
 * panel's full height; the open work's name stays on top of both. The dance tab has no left panel: its three steps are the
 * side tabs of the right panel instead. */
function LeftColumn() {
  const [rail, setRail] = useState<HTMLElement | null>(null);
  const characters = useStore((s) => s.characters.length);
  return (
    <div className="inspector-pane">
      <nav className="insp-rail left" ref={setRail} />
      <div className="left-body">
        <CurrentWork />
        <RailHost.Provider value={rail}>
          <InspectorTabs
            id="left"
            side="left"
            tabs={[
              { id: 'works', label: t('works.tab'), icon: IconStack2, count: characters, content: <Library /> },
              { id: 'steps', label: t('works.tabSteps'), icon: IconListNumbers, content: <CharacterSteps /> },
            ]}
          />
        </RailHost.Provider>
      </div>
    </div>
  );
}

export function App() {
  useLang(); // the whole tree re-renders in the new language
  const mode = useDance((s) => s.mode);
  const [log, setLog] = useState(false);
  // The dance tab has one panel fewer (no left column), so it keeps a layout of its own.
  const layout = useDefaultLayout({
    id: 'sf.layout',
    panelIds: mode === 'dance' ? ['stage', 'right'] : ['left', 'stage', 'right'],
    storage: localStorage,
  });
  const [rail, setRail] = useState<HTMLElement | null>(null);
  useShortcuts();
  useEffect(() => {
    void useStore.getState().init();
    // The character is the window's, not the 人物 tab's: the dance stage dances the same one, so it opens before either tab shows.
    void reopenCharacter();
  }, []);
    useGameRunning();
  useAutoPlugin();
  usePluginLoadCheck();
  useProfileSync();
  // The whole window takes dropped files; a target inside it (a model slot) takes its own first. The veil only shows
  // and never catches the drop, so the target under the pointer gets it.
  return (
    <Dropzone className="app-drop" unstyled onDrop={onGlobalDrop} activateOnClick={false} activateOnKeyboard={false} enablePointerEvents>
      <div className={log ? 'shell has-log' : 'shell'}>
        <TopBar status={<StatusLine />} onLog={() => setLog(!log)} />
        <div className="main-row">
          <PanelGroup className="panes" orientation="horizontal" {...layout}>
            {mode === 'character' && (
              <Panel id="left" defaultSize={330} minSize={260} maxSize={520}>
                <LeftColumn />
              </Panel>
            )}
            {mode === 'character' && <Separator className="sep-v" />}
            <Panel id="stage" minSize={400}>
              {mode === 'dance' ? <DanceStage /> : <CharacterStage />}
              <Welcome />
              <HelpDocs />
            </Panel>
            <Separator className="sep-v" />
            <Panel id="right" defaultSize={360} minSize={320} maxSize={560}>
              <div className="inspector-pane">
                <aside className="inspector">
                  <RailHost.Provider value={rail}>
                    {mode === 'dance' ? (
                      <>
                        <DanceStepsRail />
                        <DanceInspector />
                      </>
                    ) : (
                      <CharacterInspector />
                    )}
                  </RailHost.Provider>
                </aside>
                <nav className="insp-rail" ref={setRail} />
              </div>
            </Panel>
          </PanelGroup>
        </div>
        {log && <LogDock onClose={() => setLog(false)} />}
      </div>
      <Dropzone.Accept>
        <div className="drop-host">
          <div className="drop-veil">
            <IconFolderDown size={44} stroke={1.3} color="var(--flare)" />
            <b>{t('app.k15')}</b>
            <Text c="dimmed">{t('app.k16')}</Text>
          </div>
        </div>
      </Dropzone.Accept>
    </Dropzone>
  );
}