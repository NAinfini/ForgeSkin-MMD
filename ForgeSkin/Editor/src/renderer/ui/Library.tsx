// The work library at the top of the left column: the game profile the works are seen in, and every character work as a card with
// its state in that profile (in use in game, installed, changed since). The cards open, make, rename, export and delete works, put
// one into use or take it out of the profile, and the profile's character skins from others show read only.
import { ActionIcon, Button, Group, Menu, Modal, ScrollArea, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconDots,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderSymlink,
  IconPackageImport,
  IconPackages,
  IconPencil,
  IconPlug,
  IconPlugOff,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { activateSkin, applyToGame, editorEdition, installPluginInto, installToProfile, profileProblem, shippedLabel, tellNewer } from '../actions';
import { characterPicture, chooseModel, deleteCharacter, drawPackedPicture, ensureCharacterPicture, exportCharacterPack, openCharacter, pictureDrawn, refreshCharacters } from '../character/model';
import { useCharacter } from '../character/state';
import { t } from '../i18n';
import { addPacks, adoptable, adoptPacks, removeFromProfile, statusOf, useEdited, useProfile, type WorkStatus } from '../profile';
import { call, fileUrl, type InstalledPack, type Profile, type ProjectEntry } from '../protocol';
import { useStore } from '../store';
import { Info } from './Features';
import { showTab } from './InspectorTabs';

async function addProfileFolder() {
  const [folder] = await window.forge.openDialog('folder', undefined, 'profile');
  if (!folder) return;
  const s = useStore.getState();
  try {
    const p = await call('profiles.add', { path: folder });
    await s.refreshProfiles();
    s.setPrefs({ profilePath: p.path, profileChosen: true });
  } catch (e) {
    s.fail(e);
  }
}

async function removeProfileFolder(path: string) {
  const s = useStore.getState();
  try {
    await call('profiles.remove', { path });
    await s.refreshProfiles();
  } catch (e) {
    s.fail(e);
  }
}

/** Opens a character project file the author picked (its autosave, or one someone shared). */
async function openProjectFile() {
  const [p] = await window.forge.openDialog('file', [{ name: t('store.k11'), extensions: ['forgeskinproj'] }]);
  if (p) await openCharacter(p);
}

/** Installs (or updates) the skin plugin in the chosen profile. */
export async function installPlugin() {
  const s = useStore.getState();
  const profile = s.profiles.find((p) => p.path === s.prefs.profilePath);
  if (!profile) return;
  try {
    useStore.setState({ busy: t('actions.k10') });
    const { newer } = (await installPluginInto(profile.path)) as { newer?: string[] };
    await s.refreshProfiles();
    if (newer?.length) tellNewer({ ...profile, pluginNewer: newer }, true);
    else s.toast('ok', t('topBar.k23'));
  } catch (e) {
    s.fail(e);
  } finally {
    useStore.setState({ busy: null });
  }
}

async function uninstallPlugin() {
  const s = useStore.getState();
  const profile = s.profiles.find((p) => p.path === s.prefs.profilePath);
  if (!profile) return;
  try {
    await call('plugin.uninstall', { profile: profile.path });
    await s.refreshProfiles();
    s.toast('ok', t('topBar.k21'));
  } catch (e) {
    s.fail(e);
  }
}

/** The game's state as a dot: running, found, not found. */
function useGameDot() {
  return useStore((s) => (!s.game ? '' : !s.game.found ? 'bad' : s.game.running ? 'live' : 'ok'));
}

/** A profile's skin plugin in a few words: installed (and its version), an update due, or none. */
function pluginState(p: Profile) {
  const shipped = shippedLabel(p);
  if (!p.pluginVersion) return t('works.pluginMissing', { v0: shipped });
  return t(p.pluginCurrent === false ? 'works.pluginUpdate' : 'works.pluginInstalled', { v0: p.pluginVersion, v1: shipped });
}

/** The profile row: which profile the works are seen in and 应用 goes to. Its menu picks the profile (each with how many skins it
 * holds) and manages the chosen one: its skin plugin, its folder, whether the game is running. */
function ProfileRow() {
  const profiles = useStore((s) => s.profiles);
  const path = useStore((s) => s.prefs.profilePath);
  const count = useStore((s) => s.installed.length);
  const { refreshProfiles, setPrefs } = useStore.getState();
  const current = useProfile();
  const dot = useGameDot();
  const running = useStore((s) => !!s.game?.running);
  const [uninstall, setUninstall] = useState(false);
  const [dev, setDev] = useState(false);
  useEffect(() => void editorEdition().then((e) => setDev(e === 'dev')), []);
  return (
    <Group className="lib-profile" gap={8} wrap="nowrap" data-tour="profile">
      <Menu position="bottom-start" width={300} onOpen={() => void refreshProfiles()}>
        <Menu.Target>
          <UnstyledButton className="lib-profile-pick">
            <Tooltip label={running ? t('works.gameRunning') : t('works.gameIdle')}>
              <span className={`dot ${dot}`} />
            </Tooltip>
            <span className="to">{t('works.applyTo')}</span>
            <span className="name" title={current?.name}>
              {current?.name ?? t('topBar.k13')}
            </span>
            <IconChevronDown size={14} className="chev" />
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          {current && (
            <>
              <Menu.Label>{t('works.thisProfile', { v0: current.name })}</Menu.Label>
              <div className="lib-this">
                <span className={`dot ${dot}`} />
                <span>{running ? t('works.gameRunning') : t('works.gameIdle')}</span>
              </div>
              {current.hasBepInEx && (
                <div className="lib-this">
                  <IconPlug size={14} className={current.pluginVersion ? 'on' : 'off'} />
                  <span>{pluginState(current)}</span>
                </div>
              )}
              {/* The development editor offers it always: it builds the plugin from the checkout first (installPluginInto). */}
              {current.hasBepInEx && (dev || !current.pluginVersion || current.pluginCurrent === false) && (
                <Menu.Item leftSection={<IconDownload size={14} />} color="flare" onClick={() => void installPlugin()}>
                  {dev ? t('works.devPlugin') : current.pluginVersion ? t('works.updatePlugin') : t('topBar.k24')}
                </Menu.Item>
              )}
              <Menu.Item leftSection={<IconFolderOpen size={14} />} onClick={() => void window.forge.openPath(current.path)}>
                {t('works.openProfile')}
              </Menu.Item>
              {current.pluginVersion && (
                <Menu.Item leftSection={<IconPlugOff size={14} />} c="dimmed" onClick={() => setUninstall(true)}>
                  {t('topBar.k22')}
                </Menu.Item>
              )}
              <Menu.Divider />
            </>
          )}
          <Menu.Label>
            <Group gap={6} wrap="nowrap">
              {t('topBar.testProfile')}
              <Info label={t('topBar.testProfileInfo')} />
            </Group>
          </Menu.Label>
          {profiles.map((p) => (
            <Menu.Item
              key={p.path}
              leftSection={p.path === path ? <IconCheck size={14} /> : <span style={{ display: 'inline-block', width: 14 }} />}
              c={p.hasBepInEx ? undefined : 'dimmed'}
              onClick={() => setPrefs({ profilePath: p.path, profileChosen: true })}
              rightSection={
                <Group gap={4} wrap="nowrap">
                  {p.hasBepInEx && (
                    <Text size="xs" c="dimmed">
                      {t('works.installedCount', { v0: p.path === path ? count : (p.packs ?? 0) })}
                    </Text>
                  )}
                  {p.hasBepInEx && (
                    <Tooltip label={pluginState(p)}>
                      <IconPlug size={13} className={`lib-plug ${p.pluginVersion ? 'on' : 'off'}`} aria-label={pluginState(p)} />
                    </Tooltip>
                  )}
                  {p.custom && (
                    <ActionIcon component="span" size="xs" variant="subtle" color="gray" aria-label={t('topBar.k16')} onClick={(e) => (e.stopPropagation(), void removeProfileFolder(p.path))}>
                      <IconX size={12} />
                    </ActionIcon>
                  )}
                </Group>
              }
            >
              {p.hasBepInEx ? p.name : t('topBar.k14', { v0: p.name })}
            </Menu.Item>
          ))}
          <Menu.Item leftSection={<IconFolderPlus size={14} />} onClick={() => void addProfileFolder()}>
            {t('topBar.k15')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal opened={uninstall} onClose={() => setUninstall(false)} title={t('settings.uninstallTitle')} centered>
        <Text size="sm">{t('settings.uninstallBody', { v0: current?.name })}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" data-autofocus onClick={() => setUninstall(false)}>
            {t('skins.cancel')}
          </Button>
          <Button color="red" onClick={() => (setUninstall(false), void uninstallPlugin())}>
            {t('topBar.k22')}
          </Button>
        </Group>
      </Modal>
    </Group>
  );
}

/** Under the profile row when the profile cannot take skins: why (the plugin itself is offered in the profile menu and on 应用). */
function ProfileBanner() {
  const profile = useProfile();
  const pending = useStore((s) => !!s.pluginPending && s.pluginPending === s.prefs.profilePath);
  const problem = useStore((s) => (s.profiles.length ? profileProblem(profile) : null));
  if (pending) return <div className="lib-banner warn">{t('topBar.pluginPending')}</div>;
  if (profile?.hasBepInEx && !profile.pluginVersion) return null;
  return problem ? <div className="lib-banner bad">{problem}</div> : null;
}

/** The work being edited, on top of both left pages: its name and state; a click shows the works. */
export function CurrentWork() {
  const characterName = useCharacter((s) => s.name);
  const characterId = useCharacter((s) => s.skinId);
  const live = useCharacter((s) => s.lastEdited);
  const installed = useStore((s) => s.installed);
  const open = !!characterId;
  const status = statusOf(installed, characterId ?? '', live);
  return (
    <UnstyledButton className="current-work" onClick={() => showTab('left', 'works')} data-tour="current-work">
      <span className="name">{open ? characterName || t('works.nothingOpen') : t('works.nothingOpen')}</span>
      {open && <span className="sub">{t('works.characters')}</span>}
      {open && <Tags status={status} />}
    </UnstyledButton>
  );
}

/** A work's state in the chosen profile, always one of three (only in the editor, in the profile, in use), and whether it changed
 * since it went in. */
function Tags({ status }: { status: WorkStatus }) {
  return (
    <span className="tags">
      {status.state === 'inUse' && <span className="tag live">{t('works.inUse')}</span>}
      {status.state === 'installed' && <span className="tag inst">{t('works.installed')}</span>}
      {!status.state && <span className="tag editor">{t('works.onlyEditor')}</span>}
      {status.changed && (
        <Tooltip label={t('works.changedInfo')} multiline w={240}>
          <span className="tag changed">{t('works.changed')}</span>
        </Tooltip>
      )}
    </span>
  );
}

interface CardAction {
  label: string;
  icon: ReactNode;
  run: () => void;
  danger?: boolean;
  /** Why the action cannot be taken: shown greyed with this as its hover text. */
  blocked?: string;
}

/** One work as a card: its picture on top with its state over the picture's corner and ⋯ in the other on hover, then its name with
 * 应用 under it. Its actions are on ⋯ and on right click, at the pointer. */
function WorkCard({
  thumb,
  name,
  sub,
  status,
  current,
  onOpen,
  actions,
  renaming,
  onRename,
  use,
}: {
  thumb: ReactNode;
  name: string;
  sub?: string;
  status: WorkStatus;
  current?: boolean;
  onOpen?: () => void;
  actions: CardAction[];
  renaming?: boolean;
  onRename?: (name: string | null) => void;
  /** 应用, under the name. */
  use?: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  /** Where a right click opened the menu: it opens at the pointer (turning back from the window's edges), ⋯ beside itself. */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const commit = (v: string) => onRename?.(v.trim() && v.trim() !== name ? v.trim() : null);
  const items = (
    <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
      {actions.map((a) => (
        <Menu.Item key={a.label} color={a.danger ? 'red' : undefined} leftSection={a.icon} onClick={a.run} disabled={!!a.blocked} title={a.blocked}>
          {a.label}
        </Menu.Item>
      ))}
    </Menu.Dropdown>
  );
  return (
    <div
      className={['work', 'tall', status.state === 'inUse' && 'in-use'].filter(Boolean).join(' ')}
      role="button"
      aria-current={current}
      onClick={() => !current && onOpen?.()}
      onContextMenu={(e) => (e.preventDefault(), actions.length && (setMenu(false), setAt({ x: e.clientX, y: e.clientY })))}
    >
      <div className="thumb">
        {thumb}
        <span className={`tag badge ${status.state === 'inUse' ? 'live' : status.state ? 'inst' : 'editor'}`}>
          {t(status.state === 'inUse' ? 'works.inUse' : status.state ? 'works.installed' : 'works.onlyEditor')}
        </span>
        {!!actions.length && (
          <Menu opened={menu} onChange={setMenu} position="bottom-end" withinPortal returnFocus={false}>
            <Menu.Target>
              <ActionIcon className="more" variant="filled" color="dark" size="sm" aria-label={t('skins.more')} onClick={(e) => (e.stopPropagation(), setAt(null), setMenu(!menu))}>
                <IconDots size={14} />
              </ActionIcon>
            </Menu.Target>
            {items}
          </Menu>
        )}
      </div>
      <div className="foot">
        <div className="text">
          {renaming ? (
            <TextInput
              size="xs"
              autoFocus
              defaultValue={name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commit(e.currentTarget.value)}
              onKeyDown={(e) => (e.key === 'Enter' ? commit(e.currentTarget.value) : e.key === 'Escape' && onRename?.(null))}
            />
          ) : (
            <span className="name" title={name}>
              {name}
            </span>
          )}
          {status.changed ? (
            <Tooltip label={t('works.changedInfo')} multiline w={240}>
              <span className="sub changed">{t('works.changed')}</span>
            </Tooltip>
          ) : (
            sub && (
              <span className="sub" title={sub}>
                {sub}
              </span>
            )
          )}
        </div>
        {use}
      </div>
      {at && (
        <Menu opened onChange={(o) => !o && setAt(null)} position="bottom-start" offset={2} withinPortal returnFocus={false}>
          <Menu.Target>
            <span className="menu-at" style={{ left: at.x, top: at.y }} />
          </Menu.Target>
          {items}
        </Menu>
      )}
    </div>
  );
}

/** 应用 on a card: puts the work into use in the chosen profile. An installed, unchanged one only becomes the game's choice;
 * otherwise it is opened (when it is not the edited one) and applied, which builds and installs it. In use, the card offers 应用
 * only while it has changes not applied; going back to the original look is done in game. */
function UseButtons({ id, name, status, open, tour }: { id: string; name: string; status: WorkStatus; open?: () => Promise<void>; tour?: boolean }) {
  const blocked = useStore((s) => (s.profiles.length ? profileProblem(s.profiles.find((p) => p.path === s.prefs.profilePath)) : null));
  const busy = useStore((s) => !!s.busy);
  const apply = async () => {
    if (status.state === 'installed' && !status.changed) return activateSkin(id, name);
    if (open) await open();
    await applyToGame();
  };
  if (status.state === 'inUse' && !status.changed) return null;
  return (
    <Tooltip label={blocked ?? t('works.applyInfo')} multiline w={260}>
      <Button size="compact-xs" color="flare" disabled={!!blocked || busy} onClick={(e) => (e.stopPropagation(), void apply())} data-tour={tour ? 'apply' : undefined}>
        {t('works.apply')}
      </Button>
    </Tooltip>
  );
}

/** What a card of the author's own work offers, by its state in the profile; `open` makes it the edited work first. */
function ownActions(
  id: string,
  name: string,
  status: WorkStatus,
  open: () => Promise<void>,
  rest: { copy: () => void; rename: () => void; exportIt: () => void; remove: () => void; extra?: CardAction[] },
): CardAction[] {
  const out: CardAction[] = [];
  if (!status.state || (status.state === 'installed' && status.changed))
    out.push({ label: t('works.installOnly'), icon: <IconPackageImport size={14} />, run: () => void open().then(installToProfile) });
  if (status.state) out.push({ label: t('works.removeFromProfile'), icon: <IconPackageImport size={14} style={{ transform: 'scaleY(-1)' }} />, run: () => void removeFromProfile(id, name) });
  out.push(
    { label: t('works.copy'), icon: <IconCopy size={14} />, run: () => void open().then(rest.copy) },
    { label: t('skins.rename'), icon: <IconPencil size={14} />, run: () => void open().then(rest.rename) },
    { label: t('works.export'), icon: <IconDownload size={14} />, run: () => void open().then(rest.exportIt) },
    ...(rest.extra ?? []).map((a) => ({ ...a, run: () => void open().then(a.run) })),
    { label: t('works.deleteWork'), icon: <IconTrash size={14} />, danger: true, run: rest.remove },
  );
  return out;
}

type Deleting = { name: string; adopted?: boolean; run: () => void } | null;

/** A character pack's card picture (once per pack file and version): its own, else one drawn in the background from its model and
 * kept in the data dir's cache; null while it loads or when neither can be had. */
const packPictures = new Map<string, Promise<string | null>>();
async function packPicture(p: InstalledPack): Promise<string | null> {
  const cache = `${useStore.getState().dataDir}\\cache\\packs\\${p.id.replace(/[^\w.-]/g, '_')}-${(p.modified ?? '').replace(/\D/g, '')}`;
  const drawn = `${cache}\\picture.png`;
  if (await window.forge.exists(drawn)) return fileUrl(drawn);
  const r = await call('pack.picture', { pack: p.file, cache });
  if (r.png) return `data:image/png;base64,${r.png}`;
  return r.character && (await drawPackedPicture(r.character, drawn, p.id)) ? fileUrl(drawn) : null;
}
function usePackPicture(p: InstalledPack | null) {
  const [url, setUrl] = useState<string | null>(null);
  const key = p ? `${p.file}|${p.modified ?? ''}` : null;
  useEffect(() => {
    if (!p || !key) return;
    if (!packPictures.has(key))
      packPictures.set(
        key,
        packPicture(p).catch(() => null),
      );
    let live = true;
    void packPictures.get(key)!.then((u) => live && setUrl(u));
    return () => void (live = false);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}

function CharacterWork({ k, onDelete }: { k: ProjectEntry; onDelete: (d: Deleting) => void }) {
  const current = useCharacter((s) => s.skinId === k.id);
  const live = useCharacter((s) => (s.skinId === k.id ? s.name : null));
  const name = live ?? k.name;
  const status = statusOf(
    useStore((s) => s.installed),
    k.id,
    useEdited(k),
  );
  const [renaming, setRenaming] = useState(false);
  const open = () => openCharacter(k.path);
  const drawn = pictureDrawn.get(k.id) ?? 0;
  return (
    <WorkCard
      thumb={
        <>
          <IconUser size={18} />
          {/* Drawn again after an apply or export: a new version reloads it, and an image that failed before shows again. A work
              without one yet (moved from a pack) has it drawn in the background. */}
          <img key={drawn} src={`${fileUrl(characterPicture(k.id))}?v=${drawn}`} alt="" onError={(e) => ((e.currentTarget.style.display = 'none'), ensureCharacterPicture(k))} />
        </>
      }
      name={name}
      status={status}
      current={current}
      onOpen={() => void open()}
      renaming={renaming}
      onRename={(v) => (setRenaming(false), v && useCharacter.setState({ name: v }))}
      use={<UseButtons id={k.id} name={name} status={status} open={current ? undefined : open} tour={current} />}
      actions={ownActions(k.id, name, status, open, {
        copy: () => useStore.getState().toast('info', t('works.noCharacterCopy')),
        rename: () => setRenaming(true),
        exportIt: () => void exportCharacterPack(),
        remove: () => onDelete({ name, adopted: k.adopted, run: () => void deleteCharacter(k.path) }),
      })}
    />
  );
}

/** A skin in the profile that is not one of the author's works: put into use, taken out of the profile (not a skin mod's, which
 * the mod manager owns) or moved to the author's works; never edited or deleted here. */
function OtherWork({ p }: { p: InstalledPack }) {
  const status = statusOf([p], p.id, null);
  const picture = usePackPicture(p);
  const from = p.source === 'mod' ? t('works.fromMod', { v0: p.mod ?? '' }) : p.source === 'hand' ? t('works.fromHand') : null;
  return (
    <WorkCard
      thumb={picture ? <img src={picture} alt="" /> : <IconUser size={18} />}
      name={p.name}
      sub={from ?? undefined}
      status={status}
      use={<UseButtons id={p.id} name={p.name} status={status} />}
      actions={[
        ...(p.source === 'mod'
          ? []
          : [{ label: t('works.removeFromProfile'), icon: <IconPackageImport size={14} style={{ transform: 'scaleY(-1)' }} />, run: () => void removeFromProfile(p.id, p.name) }]),
        { label: t('works.adopt'), icon: <IconFolderSymlink size={14} />, run: () => void adoptPacks([p]) },
      ]}
    />
  );
}

function CharacterWorks({ query, onDelete }: { query: string; onDelete: (d: Deleting) => void }) {
  const characters = useStore((s) => s.characters);
  const installed = useStore((s) => s.installed);
  const q = query.trim().toLowerCase();
  const shown = byState(
    installed,
    characters.filter((k) => !q || k.name.toLowerCase().includes(q)),
  );
  if (!shown.length) return <Text className="lib-empty">{q ? t('works.noHits') : t('works.noCharacterWorks')}</Text>;
  return (
    <div className="lib-grid">
      {shown.map((k) => (
        <CharacterWork key={k.id} k={k} onDelete={onDelete} />
      ))}
    </div>
  );
}

/** Works in use first, then those in the profile, then those only in the editor; the order within each kept. */
function byState<T extends { id: string }>(installed: InstalledPack[], works: T[]): T[] {
  const rank = (id: string) => {
    const state = statusOf(installed, id, null).state;
    return state === 'inUse' ? 0 : state ? 1 : 2;
  };
  return [...works].sort((a, b) => rank(a.id) - rank(b.id));
}

/** 「＋ 新建」: a character work starts from its model file; the menu opens an existing work and adds skin packs. */
function NewButton() {
  const [menu, setMenu] = useState(false);
  const canAdd = useStore((s) => !!s.profiles.find((p) => p.path === s.prefs.profilePath)?.hasBepInEx);
  return (
    <Group gap={0} wrap="nowrap" data-tour="new">
      <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => void chooseModel()} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
        {t('works.new')}
      </Button>
      <Menu opened={menu} onChange={setMenu} position="bottom-end" withinPortal>
        <Menu.Target>
          <Button size="xs" px={6} aria-label={t('works.newMore')} data-tour="new-more" style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(0,0,0,.2)' }}>
            <IconChevronDown size={14} />
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconFolderOpen size={14} />} onClick={() => void openProjectFile()}>
            {t('topBar.k54')}
          </Menu.Item>
          <Tooltip label={t('works.addPacksInfo')} multiline w={260} position="left">
            <Menu.Item leftSection={<IconPackageImport size={14} />} disabled={!canAdd} onClick={() => void addPacks()} data-tour="add-packs">
              {t('works.addPacks')}
            </Menu.Item>
          </Tooltip>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

/** The profile's skins from others, folded into one bar (how many, 全部搬过来) that opens to their cards; nothing when there are none. */
function Others({ others }: { others: InstalledPack[] }) {
  const [open, setOpen] = useState(false);
  if (!others.length) return null;
  return (
    <div className="lib-others" data-tour="others">
      <div className="lib-others-bar" role="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconPackages size={15} className="icon" />
        <Tooltip label={t('works.othersInfo')} multiline w={280} openDelay={400}>
          <span className="label">{t('works.othersCount', { v0: others.length })}</span>
        </Tooltip>
        {others.some(adoptable) && (
          <Tooltip label={t('works.adoptAllInfo')} multiline w={240}>
            <Button size="compact-xs" variant="light" color="flare" leftSection={<IconFolderSymlink size={13} />} onClick={(e) => (e.stopPropagation(), void adoptPacks(others))}>
              {t('works.adoptAll')}
            </Button>
          </Tooltip>
        )}
        <IconChevronDown size={14} className="twist" />
      </div>
      {open && (
        <div className="lib-grid">
          {others.map((p) => (
            <OtherWork key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The left column's top: profile, search and new, the character works and the profile's skins from others. */
export function Library() {
  const ready = useStore((s) => s.ready);
  const installed = useStore((s) => s.installed);
  const characters = useStore((s) => s.characters);
  const hasProfile = useStore((s) => !!s.profiles.find((p) => p.path === s.prefs.profilePath)?.hasBepInEx);
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<Deleting>(null);
  useEffect(() => {
    if (ready) void refreshCharacters();
  }, [ready]);
  const mine = useMemo(() => new Set(characters.map((k) => k.id)), [characters]);
  const others = installed.filter((p) => !mine.has(p.id) && p.weapon === 'character' && !p.error);
  return (
    <section className="library" data-tour="library">
      <ProfileRow />
      <ProfileBanner />
      <div className="lib-tools">
        <Group gap={6} wrap="nowrap">
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            aria-label={t('works.search')}
            placeholder={t('works.searchCharacters')}
            leftSection={<IconSearch size={13} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <NewButton />
        </Group>
      </div>
      <ScrollArea className="lib-list" type="hover" scrollbars="y">
        {hasProfile && <Others others={others} />}
        <div className="lib-section">
          <span>{t('works.mine')}</span>
        </div>
        <CharacterWorks query={query} onDelete={setDeleting} />
      </ScrollArea>
      <Modal opened={!!deleting} onClose={() => setDeleting(null)} title={t('skins.deleteTitle')} centered>
        <Text size="sm">{t(deleting?.adopted ? 'skins.deleteBodyAdopted' : 'skins.deleteBody', { v0: deleting?.name })}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" data-autofocus onClick={() => setDeleting(null)}>
            {t('skins.cancel')}
          </Button>
          <Button color="red" onClick={() => (deleting?.run(), setDeleting(null))}>
            {t('skins.delete')}
          </Button>
        </Group>
      </Modal>
    </section>
  );
}