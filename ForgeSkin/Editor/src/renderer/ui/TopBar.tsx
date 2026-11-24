import { ActionIcon, Button, Group, Menu, Popover, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core';
import { IconChevronDown, IconCopy, IconDownload, IconFileText, IconFolder, IconMinus, IconRefresh, IconSettings, IconSquare, IconWorldUpload, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { moveDataFolder } from '../actions';
import { useStore } from '../store';
import logo from '../../../assets/icon.png';
import { t, useLang, type Lang } from '../i18n';
import { Info } from './Features';
import { HelpButton } from './HelpDocs';
import { CharacterExportModal } from '../character/CharacterPanels';
import { enterDance, useDance } from '../dance/state';

/** A settings section: its title (with what it is for) over its controls. */
function Section({ title, info, children }: { title: string; info?: string; children: React.ReactNode }) {
  return (
    <Stack gap={6}>
      <Group gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed">
          {title}
        </Text>
        {info && <Info label={info} />}
      </Group>
      {children}
    </Stack>
  );
}

/** Settings for the whole editor: language, the game folder, the data folder, updates (a profile's own plugin is in its menu). */
function SettingsMenu() {
  const lang = useLang();
  const dataDir = useStore((s) => s.dataDir);
  const game = useStore((s) => s.game);
  const { setPrefs, refreshGame, refreshProfiles, chooseGameDir, checkUpdate, startUpdate } = useStore.getState();
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [edition, setEdition] = useState<'dev' | 'installed' | 'portable'>('installed');
  useEffect(() => void window.forge.version().then(setVersion), []);
  useEffect(() => void window.forge.edition().then(setEdition), []);
  const updateVersion = useStore((s) => (s.update || s.updateReady ? null : s.updateVersion));
  const check = () => {
    setChecking(true);
    void checkUpdate(true).finally(() => setChecking(false));
  };
  const gameState = !game ? t('topBar.k6') : !game.found ? t('topBar.k7') : game.running ? t('topBar.k8') : t('topBar.k9');
  return (
    <Popover position="bottom-end" width={320} shadow="md">
      <Popover.Target>
        <Tooltip label={t('topBar.settings')}>
          <ActionIcon size={30} variant="subtle" color="gray" aria-label={t('topBar.settings')} data-tour="settings">
            <IconSettings size={19} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="md">
          <Section title={t('topBar.language')}>
            <SegmentedControl
              fullWidth
              size="xs"
              value={lang}
              onChange={(v) => setPrefs({ lang: v as Lang })}
              data={[
                { value: 'zh', label: t('lang.zh') },
                { value: 'en', label: t('lang.en') },
              ]}
            />
          </Section>
          <Section title={t('settings.game')} info={gameState}>
            <Text size="xs" style={{ userSelect: 'text', wordBreak: 'break-all' }}>
              {game?.gameDir ?? t('topBar.k7')}
            </Text>
            <Group gap={6} grow>
              <Button variant="default" size="xs" leftSection={<IconRefresh size={14} />} onClick={() => void Promise.all([refreshGame(), refreshProfiles()])}>
                {t('topBar.k10')}
              </Button>
              <Button variant="default" size="xs" leftSection={<IconFolder size={14} />} onClick={() => void chooseGameDir()}>
                {t('topBar.k11')}
              </Button>
            </Group>
          </Section>
          <Section title={t('dataDir.title')} info={t(`dataDir.info.${edition}`)}>
            <Text size="xs" truncate="start" title={dataDir} style={{ userSelect: 'text' }}>
              {dataDir}
            </Text>
            <Group gap={6} grow>
              <Tooltip label={t('dataDir.dev')} disabled={edition !== 'dev'} multiline w={240}>
                <span style={{ display: 'flex' }}>
                  <Button variant="default" size="xs" fullWidth disabled={edition === 'dev'} onClick={() => void moveDataFolder()}>
                    {t('dataDir.change')}
                  </Button>
                </span>
              </Tooltip>
              <Button variant="default" size="xs" leftSection={<IconFolder size={14} />} onClick={() => void window.forge.openPath(dataDir)}>
                {t('dataDir.open')}
              </Button>
            </Group>
          </Section>
          <Button variant="default" size="xs" leftSection={<IconRefresh size={14} />} loading={checking} onClick={check}>
            {t('topBar.checkUpdate', { v0: version })}
          </Button>
          {updateVersion && (
            <Button size="xs" color="flare" leftSection={<IconDownload size={14} />} onClick={startUpdate}>
              {t('topBar.update.getVersion', { v0: updateVersion })}
            </Button>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Windows-style minimize / maximize-restore / close for the frameless window. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    void window.forge.isMaximized().then(setMaximized);
    return window.forge.onMaximized(setMaximized);
  }, []);
  const size = maximized ? t('topBar.restore') : t('topBar.maximize');
  return (
    <div className="winctl">
      <button type="button" aria-label={t('topBar.minimize')} title={t('topBar.minimize')} onClick={() => window.forge.minimize()}>
        <IconMinus size={16} stroke={1.25} />
      </button>
      <button type="button" aria-label={size} title={size} onClick={() => window.forge.toggleMaximize()}>
        {maximized ? <IconCopy size={14} stroke={1.25} style={{ transform: 'scaleX(-1)' }} /> : <IconSquare size={13} stroke={1.25} />}
      </button>
      <button type="button" className="close" aria-label={t('topBar.close')} title={t('topBar.close')} onClick={() => window.forge.close()}>
        <IconX size={16} stroke={1.25} />
      </button>
    </div>
  );
}

/** Getting the character skin to other players: as a Thunderstore skin mod, or as a pack. */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Menu position="bottom-end" width={300}>
        <Menu.Target>
          <Button size="sm" variant="light" color="cyan" leftSection={<IconDownload size={15} />} rightSection={<IconChevronDown size={14} />} data-tour="export">
            {t('topBar.export')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconWorldUpload size={14} />} onClick={() => setOpen(true)}>
            {t('actions.exportMod')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <CharacterExportModal opened={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Which editor the window shows: the character one, or the dance one (both share the open character). */
function ModeSwitch() {
  const mode = useDance((s) => s.mode);
  return (
    <SegmentedControl
      className="modes"
      size="xs"
      value={mode}
      onChange={(v) => {
        if (v === 'dance') void enterDance();
        else useDance.setState({ mode: 'character' });
      }}
      data={[
        { value: 'character', label: t('mode.character') },
        { value: 'dance', label: t('mode.dance') },
      ]}
    />
  );
}

export function TopBar({ status, onLog }: { status: React.ReactNode; onLog: () => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src={logo} alt="" />
        <b>FORGESKIN</b>
      </div>
      <div style={{ marginLeft: 12 }}>
        <ModeSwitch />
      </div>
      {status}
      <Tooltip label={t('app.k3')}>
        <ActionIcon variant="subtle" color="gray" aria-label={t('app.k3')} data-tour="log" onClick={onLog}>
          <IconFileText size={17} />
        </ActionIcon>
      </Tooltip>
      <HelpButton />
      <SettingsMenu />
      <ExportMenu />
      <WindowControls />
    </header>
  );
}