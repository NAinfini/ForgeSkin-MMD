// The 舞蹈 tab's two panels: the steps rail on the left, the open step's settings on the right. A dance is built in the
// same order the steps run — bring in an MMD action (and its song), cut it to the music, add a camera move, export.
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAdjustmentsHorizontal,
  IconCamera,
  IconCut,
  IconFilePlus,
  IconFolder,
  IconMusic,
  IconPackageExport,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconDeviceGamepad2 } from '@tabler/icons-react';
import { morphNames } from './face';
import { t } from '../i18n';
import { useStore } from '../store';
import { RailHost } from '../ui/InspectorTabs';
import { InspHead, Section, Empty } from '../ui/Features';
import { Field, Slider } from '../ui/fields';
import { clock } from './DanceTimeline';
import {
  applyDance,
  bakeAction,
  clipEnd,
  clipSpan,
  clipSpeed,
  danceTotal,
  deleteDance,
  exportDance,
  gameName,
  importInto,
  newDance,
  openDance,
  renameDance,
  useDance,
  type DanceSource,
  type DanceStep,
  type TrackClip,
  type TrackId,
} from './state';

const STEP: Record<DanceStep, { icon: typeof IconMusic; color: string }> = {
  import: { icon: IconFilePlus, color: '#7aa2f7' },
  motion: { icon: IconCut, color: '#f7a95c' },
  export: { icon: IconPackageExport, color: '#5cc78a' },
};

const ORDER: DanceStep[] = ['import', 'motion', 'export'];
const CAM_COLOR = '#9b8cff';
const stepTitle = (step: DanceStep): string => t(`dance.step.${step}`);

// ---- steps ----

/** The three steps as the right panel's side tabs (the bar the character tab puts on the window's edge): icon over label
 * down the right edge of the dance inspector, numbered in the order a dance is built — 动作与音乐 → 剪辑 → 导出. The full
 * step name is the tab's tooltip. */
export function DanceStepsRail() {
  const host = useContext(RailHost);
  const step = useDance((s) => s.step);
  if (!host) return null;
  return createPortal(
    ORDER.map((x, i) => {
      const S = STEP[x];
      return (
        <Tooltip key={x} label={stepTitle(x)} position="left" withArrow>
          <UnstyledButton
            className="rail-tab"
            aria-label={stepTitle(x)}
            aria-selected={x === step}
            style={{ ['--accent' as string]: S.color }}
            onClick={() => useDance.setState({ step: x })}
          >
            <S.icon size={19} stroke={1.6} />
            <span className="rail-label">{t(`dance.tab.${x}`)}</span>
            <span className="rail-count">{i + 1}</span>
          </UnstyledButton>
        </Tooltip>
      );
    }),
    host,
  );
}

// ---- one imported file ----

const ACCEPT: Record<keyof DanceSource, string[]> = {
  action: ['vmd'],
  camera: ['vmd', 'cam'],
  audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'],
  face: ['face'],
};

function FileRow({ kind, label }: { kind: keyof DanceSource; label: string }) {
  const path = useDance((s) => s.source[kind]);
  const pick = async () => {
    const toast = useStore.getState().toast;
    const [file] = await window.forge.openDialog('file', [{ name: label, extensions: ACCEPT[kind] }], `dance-${kind}`);
    if (!file) return;
    const ext = /\.[^.\\/]+$/.exec(file)?.[0] ?? '';
    try {
      await importInto(kind, file, `${kind}${ext.toLowerCase()}`);
    } catch (e) {
      toast('error', `${t('dance.importFailed')}${(e as Error).message}`);
    }
  };
  return (
    <Field label={label}>
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Text size="xs" c={path ? undefined : 'dimmed'} truncate style={{ flex: 1 }} title={path ?? undefined}>
          {path ? path.split(/[\\/]/).pop() : t('dance.none')}
        </Text>
        <Button size="compact-xs" variant="light" onClick={() => void pick()}>
          {path ? t('dance.replace') : t('dance.choose')}
        </Button>
      </Group>
    </Field>
  );
}

// ---- 1. import ----

function ImportStep() {
  const list = useDance((s) => s.list);
  const id = useDance((s) => s.id);
  const name = useDance((s) => s.name);
  const action = useDance((s) => s.source.action);
  const path = useDance((s) => s.source.camera);
  const useCamera = useDance((s) => s.useCamera);
  const faceFile = useDance((s) => s.source.face);
  const morphs = useDance((s) => s.morphs);
  const useMorphs = useDance((s) => s.useMorphs);
  const expressions = useMemo(() => morphNames(morphs), [morphs]);
  const busy = useDance((s) => s.busy);
  const file = useDance((s) => s.file);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  // Double-clicking a name in 我的舞蹈 renames it in place; the open dance's rename lands in the 名字 field as well.
  const [renaming, setRenaming] = useState<{ id: string; was: string; text: string } | null>(null);
  const renameDone = useRef(false);
  const seconds = danceTotal();
  const startRename = (d: { id: string; name: string }) => {
    renameDone.current = false;
    setRenaming({ id: d.id, was: d.name, text: d.name });
  };
  const commitRename = () => {
    if (renameDone.current) return;
    renameDone.current = true;
    const r = renaming;
    setRenaming(null);
    if (r && r.text.trim() && r.text.trim() !== r.was) void renameDance(r.id, r.text.trim());
  };
  const open = async (next: string) => {
    try {
      await openDance(next);
    } catch (e) {
      useStore.getState().toast('error', `${t('dance.importFailed')}${(e as Error).message}`);
    }
  };
  // A double-click counted on the row itself: React may replace the row between the two clicks (opening a dance
  // re-renders the list), and the browser's dblclick only fires when both clicks land on the same node.
  const lastClick = useRef({ id: '', at: 0 });
  const rowClick = (d: { id: string; name: string }, label: string) => {
    const now = Date.now();
    if (lastClick.current.id === d.id && now - lastClick.current.at < 400) {
      lastClick.current = { id: '', at: 0 };
      startRename({ id: d.id, name: label });
      return;
    }
    lastClick.current = { id: d.id, at: now };
    // Clicking the dance that is already open is only ever the first half of a rename (or a plain re-click): reopening it
    // reloads the stage and throws playback back to 0:00, so a rename in the middle of a dance keeps playing.
    if (d.id === id) return;
    void open(d.id);
  };
  return (
    <Stack gap="xs">
      <Section title={t('dance.works')} icon={IconFolder} color={STEP.import.color} id="dance-works">
        {list.length === 0 ? (
          <Text size="xs" c="dimmed">
            {t('dance.noDances')}
          </Text>
        ) : (
          <Stack gap={2}>
            {list.map((d) => {
              // The open dance reads its label from the live name, so typing in 名字 renames the row as it is typed.
              const label = d.id === id ? name : d.name;
              return (
                <Group key={d.id} gap={2} wrap="nowrap" align="center">
                  {renaming?.id === d.id ? (
                    <TextInput
                      size="xs"
                      autoFocus
                      value={renaming.text}
                      aria-label={t('dance.name')}
                      style={{ flex: 1, minWidth: 0 }}
                      onChange={(e) => setRenaming({ id: d.id, was: renaming.was, text: e.currentTarget.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') {
                          renameDone.current = true;
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    <UnstyledButton
                      className="part"
                      aria-selected={d.id === id}
                      title={t('dance.renameHint')}
                      onClick={() => rowClick({ id: d.id, name: d.name }, label)}
                      style={{ ['--accent' as string]: d.id === id ? STEP.import.color : 'transparent', flex: 1, minWidth: 0 }}
                    >
                      <IconMusic size={13} className="kind-icon" style={{ color: STEP.import.color }} />
                      <span className="label" style={{ gridColumn: '2 / -1' }}>
                        {label}
                      </span>
                    </UnstyledButton>
                  )}
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    aria-label={t('dance.delete')}
                    title={t('dance.delete')}
                    onClick={() => setDeleting({ id: d.id, name: label })}
                  >
                    <IconTrash size={13} />
                  </ActionIcon>
                </Group>
              );
            })}
          </Stack>
        )}
        <Button
          mt={6}
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={13} />}
          onClick={() => void newDance(t('dance.untitled'))}
        >
          {t('dance.newDance')}
        </Button>
      </Section>

      {id ? (
        <>
          <Section title={t('dance.name')} icon={IconMusic} color={STEP.import.color} id="dance-name">
            <TextInput size="xs" value={name} aria-label={t('dance.name')} onChange={(e) => useDance.setState({ name: e.currentTarget.value })} />
            <Text mt={4} size="xs" c="dimmed">
              {t('dance.nameInfo')}
            </Text>
          </Section>

          <Section title={t('dance.action')} icon={IconFilePlus} color={STEP.import.color} id="dance-action" info={t('dance.actionInfo')}>
            <FileRow kind="action" label={t('dance.actionFile')} />
            <Button mt={8} fullWidth size="compact-sm" loading={busy === 'bake'} disabled={!action} onClick={() => void bakeAction()}>
              {file ? t('dance.rebake') : t('dance.bake')}
            </Button>
            {file && (
              <Text mt={4} size="xs" c="dimmed">
                {t('dance.bakedInfo', { v0: file.frames, v1: clock(seconds) })}
              </Text>
            )}
          </Section>

          <Section title={t('dance.music')} icon={IconMusic} color={STEP.import.color} id="dance-music" info={t('dance.musicInfo')}>
            <FileRow kind="audio" label={t('dance.musicFile')} />
          </Section>

          <Section title={t('dance.camera')} icon={IconCamera} color={CAM_COLOR} id="dance-camera" info={t('dance.cameraInfo')}>
            <FileRow kind="camera" label={t('dance.cameraFile')} />
            <Group mt={8} justify="space-between">
              <Text size="xs">{t('dance.useCamera')}</Text>
              <Switch checked={useCamera} onChange={(e) => useDance.setState({ useCamera: e.currentTarget.checked })} />
            </Group>
            <Text mt={6} size="xs" c="dimmed">
              {useCamera && path ? t('dance.cameraReady') : t('dance.cameraNone')}
            </Text>
          </Section>

          <Section title={t('dance.face')} icon={IconMusic} color={STEP.import.color} id="dance-face" info={t('dance.faceInfo')}>
            {morphs.length > 0 && (
              <>
                <Group justify="space-between">
                  <Text size="xs">{t('dance.useMorphs')}</Text>
                  <Switch checked={useMorphs} onChange={(e) => useDance.setState({ useMorphs: e.currentTarget.checked })} />
                </Group>
                <Text mt={6} size="xs" c="dimmed">
                  {expressions.length ? t('dance.morphDetected', { v0: expressions.length, v1: `${expressions.slice(0, 6).join('、')}${expressions.length > 6 ? ' …' : ''}` }) : t('dance.morphNone')}
                </Text>
                {faceFile && (
                  <Text mt={4} size="xs" c="dimmed">
                    {t('dance.morphOverridden')}
                  </Text>
                )}
                <Text mt={8} size="xs" c="dimmed">
                  {t('dance.faceOrMorph')}
                </Text>
              </>
            )}
            <FileRow kind="face" label={t('dance.faceFile')} />
          </Section>
        </>
      ) : (
        <Empty>{t('dance.noDance')}</Empty>
      )}
      <Modal opened={!!deleting} onClose={() => setDeleting(null)} title={t('dance.deleteTitle')} centered>
        <Text size="sm">{t('dance.deleteBody', { v0: deleting?.name ?? '' })}</Text>
        <Group justify="flex-end" mt="md" gap="xs">
          <Button variant="default" data-autofocus onClick={() => setDeleting(null)}>
            {t('dance.cancel')}
          </Button>
          <Button
            color="red"
            onClick={() => {
              const d = deleting;
              setDeleting(null);
              if (d) void deleteDance(d.id);
            }}
          >
            {t('dance.delete')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}

// ---- 2. motion ----

const TRACK_COLOR: Record<TrackId, string> = { camera: '#7aa2f7', action: '#f7a95c', music: '#9fb0c6' };

/**
 * Settings for the strip picked on the timeline — a cutting app's clip inspector rather than a second copy of the trim
 * handles: the timeline itself trims, slides and cuts strips, and this panel holds the things a drag cannot say. A music
 * strip gets its own level and its fades (both written into the exported wav), an action or camera strip gets its speed.
 * With nothing picked it says how to pick one; picking a lane's name picks the strip under the playhead, so a track opens
 * from its name too.
 */
function MotionStep() {
  const file = useDance((s) => s.file);
  const selected = useDance((s) => s.selected);
  const tracks = useDance((s) => s.tracks);
  const clip = selected ? (tracks[selected.track].find((c) => c.id === selected.id) ?? null) : null;
  const track = selected?.track ?? null;
  const span = clip ? clipSpan(clip) : 0;
  const set = (patch: Partial<TrackClip>): void => {
    if (!selected || !clip) return;
    const s = useDance.getState();
    const list = s.tracks[selected.track].map((c) => (c.id === clip.id ? { ...c, ...patch } : c));
    useDance.setState({ tracks: { ...s.tracks, [selected.track]: list } });
  };
  const fadeMax = Math.max(0.5, Math.min(10, span));
  return (
    <Stack gap="xs">
      {!file ? (
        <Empty>{t('dance.notBaked')}</Empty>
      ) : (
        <Section
          title={t('dance.clipParams')}
          icon={IconAdjustmentsHorizontal}
          color={STEP.motion.color}
          id="dance-clip"
          info={t('dance.clipParamsInfo')}
        >
          {!clip || !track ? (
            <Text size="xs" c="dimmed">
              {t('dance.clipHint')}
            </Text>
          ) : (
            <Stack gap={10}>
              <Group gap={6} wrap="nowrap">
                <span className="clip-color" style={{ background: TRACK_COLOR[track] }} />
                <Text size="xs" fw={600}>
                  {t(`dance.track.${track}`)}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('dance.clipWhere', { v0: clock(clip.start), v1: clock(clipEnd(clip)) })}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {t('dance.clipSource', { v0: clock(clip.in), v1: clock(clip.out) })}
              </Text>
              {track === 'music' ? (
                <>
                  <Field label={t('dance.clipGain')}>
                    <Slider
                      value={Math.round((clip.gain ?? 1) * 100)}
                      min={0}
                      max={200}
                      step={5}
                      unit=" %"
                      onChange={(v) => set({ gain: Math.abs(v - 100) < 1e-6 ? undefined : v / 100 })}
                    />
                  </Field>
                  <Field label={t('dance.clipFadeIn')}>
                    <Slider
                      value={Math.min(clip.fadeIn ?? 0, span)}
                      min={0}
                      max={fadeMax}
                      step={0.1}
                      unit=" s"
                      onChange={(v) => set({ fadeIn: v > 0.001 ? v : undefined })}
                    />
                  </Field>
                  <Field label={t('dance.clipFadeOut')}>
                    <Slider
                      value={Math.min(clip.fadeOut ?? 0, span)}
                      min={0}
                      max={fadeMax}
                      step={0.1}
                      unit=" s"
                      onChange={(v) => set({ fadeOut: v > 0.001 ? v : undefined })}
                    />
                  </Field>
                  <Text size="xs" c="dimmed">
                    {t('dance.clipMusicHint')}
                  </Text>
                </>
              ) : (
                <>
                  <Field label={t('dance.clipSpeed')}>
                    <Slider
                      value={clipSpeed(clip)}
                      min={0.25}
                      max={3}
                      step={0.05}
                      unit="×"
                      onChange={(v) => set({ speed: Math.abs(v - 1) < 0.03 ? undefined : v })}
                    />
                  </Field>
                  <Text size="xs" c="dimmed">
                    {t('dance.clipSpeedHint')}
                  </Text>
                </>
              )}
            </Stack>
          )}
        </Section>
      )}
    </Stack>
  );
}

// ---- 3. export ----

function ExportStep() {
  const name = useDance((s) => s.name);
  const file = useDance((s) => s.file);
  const busy = useDance((s) => s.busy);
  const [out, setOut] = useState<Awaited<ReturnType<typeof exportDance>>>(null);
  return (
    <Stack gap="xs">
      {!file ? (
        <Empty>{t('dance.notBaked')}</Empty>
      ) : (
        <Section title={t('dance.export')} icon={IconPackageExport} color={STEP.export.color} id="dance-export" info={t('dance.exportInfo')}>
          <Field label={t('dance.gameName')}>
            <TextInput size="xs" value={gameName(name)} readOnly aria-label={t('dance.gameName')} />
          </Field>
          <Button
            mt={8}
            fullWidth
            size="compact-sm"
            loading={busy === 'export'}
            leftSection={<IconPackageExport size={13} />}
            onClick={() => void exportDance().then(setOut)}
          >
            {t('dance.build')}
          </Button>
          {out && (
            <Stack gap={2} mt={8}>
              <Text size="xs" c="dimmed">
                {t('dance.built', { v0: out.dir })}
              </Text>
              <Text size="xs">{out.dance.split(/[\\/]/).pop()}</Text>
              {out.cam && <Text size="xs">{out.cam.split(/[\\/]/).pop()}</Text>}
              {out.wav && <Text size="xs">{out.wav.split(/[\\/]/).pop()}</Text>}
            </Stack>
          )}
          <Button mt={10} fullWidth size="compact-sm" variant="light" color="teal" loading={busy === 'apply'} leftSection={<IconDeviceGamepad2 size={13} />} onClick={() => void applyDance()}>
            {t('dance.apply')}
          </Button>
          <Text mt={6} size="xs" c="dimmed">
            {t('dance.applyHint')}
          </Text>
        </Section>
      )}
    </Stack>
  );
}

const PANELS: Record<DanceStep, () => React.JSX.Element> = {
  import: ImportStep,
  motion: MotionStep,
  export: ExportStep,
};

export function DanceInspector() {
  const step = useDance((s) => s.step);
  const name = useDance((s) => s.name);
  const id = useDance((s) => s.id);
  const S = STEP[step];
  const Panel = PANELS[step];
  return (
    <>
      <InspHead kind={t('dance.title')} icon={S.icon} color={S.color} title={stepTitle(step)} meta={id ? name : undefined} />
      <Panel />
    </>
  );
}