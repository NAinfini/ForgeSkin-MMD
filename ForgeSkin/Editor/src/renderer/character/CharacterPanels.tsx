// The 人物模型 tab's panels: the steps on the left (import, bones, first-person arms, hair and skirt, materials, check) and the
// picked step's settings on the right, built from the same inspector parts as the weapon tab.
import { Badge, Button, Group, Image, Modal, NumberInput, ScrollArea, Select, Stack, Switch, Text, Textarea, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconAdjustments,
  IconAlertTriangle,
  IconBone,
  IconCheck,
  IconHandStop,
  IconListCheck,
  IconPackageExport,
  IconPalette,
  IconPlus,
  IconRefresh,
  IconRulerMeasure,
  IconTrash,
  IconUpload,
  IconUser,
  IconWand,
  IconWind,
  IconWorldUpload,
  type Icon,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { fileUrl } from '../protocol';
import { Field, Slider } from '../ui/fields';
import { modName } from '../actions';
import { Empty, Info, InspHead, Section } from '../ui/Features';
import { BODY_JOINTS, chooseModel, exportCharacterMod, exportCharacterPack, addSpring, autoAddSprings, fitShell, pickBone, rematch, shellParts, springLabel, stageIcon, toggleShellPart, useSpringPresets } from './model';
import { matchOf, matchReady, SPRING_KINDS, STEPS, updateSpring, useCharacter, type RigCheck, type SpringKind, type Step } from './state';

const STEP: Record<Step, { icon: Icon; color: string }> = {
  model: { icon: IconUser, color: 'var(--flare)' },
  bones: { icon: IconBone, color: 'var(--scan)' },
  arms: { icon: IconHandStop, color: 'var(--dust)' },
  springs: { icon: IconWind, color: 'var(--violet)' },
  materials: { icon: IconPalette, color: 'var(--paint)' },
  check: { icon: IconListCheck, color: 'var(--ok)' },
};

const stepTitle = (step: Step) => t(`character.step.${step}`);

/** What a step shows beside its name: done, how many, or what is wrong. */
function StepState({ step }: { step: Step }) {
  const s = useCharacter();
  if (step === 'model') return s.model ? <IconCheck size={14} color="var(--ok)" /> : null;
  if (step === 'bones') {
    if (!s.model) return null;
    if (matchReady(s.check)) return <IconCheck size={14} color="var(--ok)" />;
    return s.check?.missing.length ? (
      <Badge size="xs" color="red" variant="light">
        {s.check.missing.length}
      </Badge>
    ) : null;
  }
  if (step === 'arms') return s.model && matchReady(s.check) ? <IconCheck size={14} color="var(--ok)" /> : null;
  if (step === 'springs' && s.springs.length)
    return (
      <Badge size="xs" color="violet" variant="light">
        {s.springs.length}
      </Badge>
    );
  return null;
}

export function CharacterSteps() {
  const step = useCharacter((s) => s.step);
  return (
    <aside className="rail">
      <div className="parts-head">
        <IconUser size={15} className="ico" />
        <span className="title">{t('character.title')}</span>
        <Info label={t('character.titleInfo')} />
      </div>
      <ScrollArea className="parts" type="hover" scrollbars="y">
        {STEPS.map((x, i) => {
          const S = STEP[x];
          return (
            <UnstyledButton
              key={x}
              className="part char-step"
              role="option"
              aria-selected={x === step}
              style={{ ['--accent' as string]: S.color, width: '100%' }}
              onClick={() => useCharacter.setState({ step: x })}
            >
              <S.icon size={15} className="kind-icon" style={{ color: S.color }} />
              <span className="label">
                {i + 1}. {stepTitle(x)}
              </span>
              <span className="row-actions" data-keep>
                <StepState step={x} />
              </span>
            </UnstyledButton>
          );
        })}
      </ScrollArea>
    </aside>
  );
}

// ---- 1. model ----

function ModelStep() {
  const s = useCharacter();
  return (
    <Section title={t('character.step.model')} icon={IconUser} color={STEP.model.color} info={t('character.modelInfo')}>
      {s.model ? (
        <Stack gap="xs">
          <Field label={t('character.skinName')}>
            <TextInput size="xs" value={s.name} aria-label={t('character.skinName')} onChange={(e) => useCharacter.setState({ name: e.currentTarget.value })} />
          </Field>
          <Field label={t('character.height')}>
            <Tooltip label={t('character.heightInfo')} multiline w={280}>
              <NumberInput
                size="xs"
                value={s.height}
                step={0.05}
                decimalScale={3}
                aria-label={t('character.height')}
                onChange={(v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && useCharacter.setState({ height: v })}
              />
            </Tooltip>
          </Field>
          {s.credit && (
            <Field label={t('character.credit')}>
              <Tooltip label={t('character.creditInfo')} multiline w={280}>
                <Text size="xs" c="dimmed">
                  {s.credit}
                </Text>
              </Tooltip>
            </Field>
          )}
          <Field label={t('character.boneCount')}>
            <Text size="sm">{s.bones.length}</Text>
          </Field>
          <Field label={t('character.vertexCount')}>
            <Text size="sm">{s.vertices.toLocaleString()}</Text>
          </Field>
          <Field label={t('character.materialCount')}>
            <Text size="sm">{s.materials.length}</Text>
          </Field>
          <Button variant="default" leftSection={<IconUpload size={15} />} loading={s.loading} onClick={() => void chooseModel()}>
            {t('character.replace')}
          </Button>
        </Stack>
      ) : (
        <Stack gap="xs">
          <Empty>{t('character.dropHint')}</Empty>
          <Button leftSection={<IconUpload size={15} />} loading={s.loading} onClick={() => void chooseModel()}>
            {t('character.choose')}
          </Button>
        </Stack>
      )}
    </Section>
  );
}

// ---- 2. bones ----

// Where each body joint sits on the figure (the body faces the viewer, so its left is on the right).
const FIGURE: Record<string, [number, number]> = {
  head: [100, 34],
  neck: [100, 62],
  spine2: [100, 86],
  spine1: [100, 106],
  spine0: [100, 126],
  hip: [100, 146],
  leftShoulder: [116, 72],
  leftUpperArm: [136, 78],
  leftLowerArm: [150, 116],
  leftHand: [160, 152],
  rightShoulder: [84, 72],
  rightUpperArm: [64, 78],
  rightLowerArm: [50, 116],
  rightHand: [40, 152],
  leftUpperLeg: [116, 152],
  leftLowerLeg: [120, 212],
  leftFoot: [122, 268],
  rightUpperLeg: [84, 152],
  rightLowerLeg: [80, 212],
  rightFoot: [78, 268],
};
const EDGES: [string, string][] = [
  ['hip', 'spine0'],
  ['spine0', 'spine1'],
  ['spine1', 'spine2'],
  ['spine2', 'neck'],
  ['neck', 'head'],
  ['spine2', 'leftShoulder'],
  ['leftShoulder', 'leftUpperArm'],
  ['leftUpperArm', 'leftLowerArm'],
  ['leftLowerArm', 'leftHand'],
  ['spine2', 'rightShoulder'],
  ['rightShoulder', 'rightUpperArm'],
  ['rightUpperArm', 'rightLowerArm'],
  ['rightLowerArm', 'rightHand'],
  ['hip', 'leftUpperLeg'],
  ['leftUpperLeg', 'leftLowerLeg'],
  ['leftLowerLeg', 'leftFoot'],
  ['hip', 'rightUpperLeg'],
  ['rightUpperLeg', 'rightLowerLeg'],
  ['rightLowerLeg', 'rightFoot'],
];

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;

export function jointLabel(joint: string): string {
  const finger = /^(left|right)(Thumb|Index|Middle|Ring|Pinky)(\d)$/.exec(joint);
  if (finger) return t('character.fingerJoint', { side: t(`character.${finger[1] as 'left' | 'right'}`), finger: t(`character.finger.${finger[2] as 'Thumb'}`), n: finger[3] });
  return t(`character.joint.${joint as 'hip'}`);
}

function Figure() {
  const s = useCharacter();
  const match = matchOf(s);
  const missing = new Set(s.check?.missing ?? []);
  // Red only for the one joint a character cannot do without; a joint left without a bone is grey, not wrong.
  const color = (j: string) => (missing.has(j) ? '#ff5d5d' : match[j] ? '#4fd18b' : '#5b6675');
  return (
    <svg className="char-figure" viewBox="0 0 200 290" role="group" aria-label={t('character.figure')}>
      {EDGES.map(([a, b]) => (
        <line key={a + b} x1={FIGURE[a][0]} y1={FIGURE[a][1]} x2={FIGURE[b][0]} y2={FIGURE[b][1]} stroke="#3b4a5c" strokeWidth={3} strokeLinecap="round" />
      ))}
      <circle cx={100} cy={34} r={16} fill="none" stroke="#3b4a5c" strokeWidth={2} />
      {BODY_JOINTS.map((j) => (
        <Tooltip key={j} label={`${jointLabel(j)}${match[j] ? ` · ${match[j]}` : ''}`}>
          <circle
            cx={FIGURE[j][0]}
            cy={FIGURE[j][1]}
            r={s.joint === j ? 8 : 6}
            fill={color(j)}
            stroke={s.joint === j ? '#ff9a3c' : '#0b0f14'}
            strokeWidth={s.joint === j ? 3 : 1.5}
            style={{ cursor: 'pointer' }}
            role="button"
            aria-label={jointLabel(j)}
            onClick={() => useCharacter.setState({ joint: j })}
          />
        </Tooltip>
      ))}
    </svg>
  );
}

function FingerGrid({ side }: { side: 'left' | 'right' }) {
  const s = useCharacter();
  const match = matchOf(s);
  const moving = movingFingers(s.check, side);
  return (
    <div>
      <Group gap={6} mb={4}>
        <Text size="xs" fw={600}>
          {t(`character.${side}Fingers`)}
        </Text>
        {s.check && (
          <Tooltip label={t('character.fingersInfo')} multiline w={260}>
            <Badge size="xs" color={moving === FINGERS.length ? 'green' : 'gray'} variant="light">
              {moving === FINGERS.length ? t('character.fingersMove') : moving ? t('character.fingersSome', { v0: moving }) : t('character.fingersStill')}
            </Badge>
          </Tooltip>
        )}
      </Group>
      <div className="char-fingers">
        {FINGERS.map((f) =>
          [1, 2, 3].map((n) => {
            const joint = `${side}${f}${n}`;
            return (
              <Tooltip key={joint} label={`${jointLabel(joint)}${match[joint] ? ` · ${match[joint]}` : ''}`}>
                <UnstyledButton
                  className="char-finger"
                  data-on={!!match[joint] || undefined}
                  aria-selected={s.joint === joint}
                  aria-label={jointLabel(joint)}
                  onClick={() => useCharacter.setState({ joint })}
                />
              </Tooltip>
            );
          }),
        )}
      </div>
    </div>
  );
}

/** How many of a hand's fingers the game moves: those whose first joint is posed. */
function movingFingers(check: RigCheck | null, side: 'left' | 'right') {
  if (!check) return 0;
  const unposed = new Set(check.unposed);
  return FINGERS.filter((f) => !unposed.has(`${side}${f}1`)).length;
}

// The joints most skeletons do without: leaving them out changes nothing the author would see, so the notes do not list them.
const QUIET = new Set(['spine2', 'leftShoulder', 'rightShoulder']);

/** What the game will do differently with this match, one plain sentence per kind (never one per joint): which parts stay still,
 * which hand does not hold the gun, whose arms show in first person, what looks bound to the wrong side. None of them stops export. */
function matchNotes(check: RigCheck): string[] {
  const notes: string[] = [];
  const fingers = movingFingers(check, 'left') + movingFingers(check, 'right');
  if (!fingers) notes.push(t('character.note.noFingers'));
  else if (fingers < FINGERS.length * 2) notes.push(t('character.note.someFingers', { v0: FINGERS.length * 2 - fingers }));
  const still = BODY_JOINTS.filter((j) => check.unposed.includes(j) && !QUIET.has(j));
  if (still.length) notes.push(t('character.note.still', { v0: still.map(jointLabel).join(t('character.note.comma')) }));
  if (!check.reach.left || !check.reach.right)
    notes.push(t('character.note.noReach', { v0: t(!check.reach.left && !check.reach.right ? 'character.note.bothHands' : check.reach.left ? 'character.right' : 'character.left') }));
  if (!check.arms) notes.push(t('character.note.noArms'));
  if (check.notes.some((n) => n.kind === 'sides')) notes.push(t('character.note.sides'));
  const off = check.notes.filter((n) => n.kind === 'standing').map((n) => jointLabel(n.joints[0]));
  if (off.length) notes.push(t('character.note.standing', { v0: off.join(t('character.note.comma')) }));
  for (const n of check.notes) if (n.kind === 'other') notes.push(n.text);
  if (check.backwards) notes.push(t('character.backwards'));
  return notes;
}

function BonesStep() {
  const s = useCharacter();
  if (!s.model) return <Empty>{t('character.needModel')}</Empty>;
  const match = matchOf(s);
  const ready = matchReady(s.check);
  const boneOptions = s.bones.map((b) => ({ value: b.name, label: `${'· '.repeat(Math.min(b.depth, 8))}${b.name}` }));
  const required = new Set(s.check?.required ?? []);
  return (
    <>
      <Section
        title={t('character.step.bones')}
        icon={IconBone}
        color={STEP.bones.color}
        info={t('character.bonesInfo')}
        actions={
          <Tooltip label={t('character.rematchInfo')}>
            <Button size="compact-xs" variant="subtle" leftSection={<IconRefresh size={13} />} onClick={rematch}>
              {t('character.rematch')}
            </Button>
          </Tooltip>
        }
      >
        <Stack gap="xs">
          {ready ? (
            <Group gap={6}>
              <IconCheck size={15} color="var(--ok)" />
              <Text size="sm">{t('character.bonesReady')}</Text>
            </Group>
          ) : (
            <div className="char-problems">
              {s.check?.missing.map((j) => (
                <UnstyledButton key={j} className="char-problem" onClick={() => useCharacter.setState({ joint: j })}>
                  <IconAlertTriangle size={13} />
                  {t('character.missingJoint', { v0: jointLabel(j) })}
                </UnstyledButton>
              ))}
            </div>
          )}
          {ready &&
            matchNotes(s.check!).map((note) => (
              <Text key={note} size="xs" c="dimmed">
                {note}
              </Text>
            ))}
          <Figure />
          <Group grow align="flex-start">
            <FingerGrid side="right" />
            <FingerGrid side="left" />
          </Group>
        </Stack>
      </Section>
      <Section title={s.joint ? jointLabel(s.joint) : t('character.pickJoint')} icon={IconBone} color={STEP.bones.color} info={t('character.pickJointInfo')}>
        {s.joint ? (
          <Stack gap="xs">
            <Select
              searchable
              clearable
              aria-label={t('character.boneFor')}
              placeholder={required.has(s.joint) ? t('character.requiredBone') : t('character.optionalBone')}
              data={boneOptions}
              value={match[s.joint] ?? null}
              onChange={(v) => pickBone(s.joint!, v)}
              nothingFoundMessage={t('character.noBone')}
            />
            <Group gap="xs">
              {match[s.joint] && !required.has(s.joint) && (
                <Tooltip label={t('character.unbindInfo')} multiline w={260}>
                  <Button size="compact-xs" variant="subtle" color="gray" onClick={() => pickBone(s.joint!, null)}>
                    {t('character.unbind')}
                  </Button>
                </Tooltip>
              )}
              {s.picked[s.joint] !== undefined && (
                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => pickBone(s.joint!, undefined)}>
                  {t('character.useAuto')}
                </Button>
              )}
            </Group>
          </Stack>
        ) : (
          <Empty>{t('character.pickJointHint')}</Empty>
        )}
      </Section>
    </>
  );
}

// ---- 3. first-person arms: cut from the model by the game's own rule; the author picks the materials left out ----

function ArmsStep() {
  const s = useCharacter();
  if (!s.model) return <Empty>{t('character.needModel')}</Empty>;
  const ready = matchReady(s.check);
  const toggle = (i: number, out: boolean) => useCharacter.setState({ hide: out ? [...s.hide, i].sort((a, b) => a - b) : s.hide.filter((x) => x !== i) });
  return (
    <Section title={t('character.step.arms')} icon={IconHandStop} color={STEP.arms.color} info={t('character.armsInfo')}>
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          {t('character.armsText')}
        </Text>
        <Button size="xs" variant={s.view === 'arms' ? 'filled' : 'light'} disabled={!ready || !s.check?.arms} onClick={() => useCharacter.setState({ view: s.view === 'arms' ? 'body' : 'arms' })}>
          {t(s.view === 'arms' ? 'character.viewBody' : 'character.armsShow')}
        </Button>
        {ready && !s.check?.arms && (
          <Text size="xs" c="dimmed">
            {t('character.note.noArms')}
          </Text>
        )}
        {!ready && (
          <div className="char-problems">
            <UnstyledButton className="char-problem" onClick={() => useCharacter.setState({ step: 'bones' })}>
              <IconAlertTriangle size={13} />
              {t('character.armsNeedsBones', { step: t('character.step.bones') })}
            </UnstyledButton>
          </div>
        )}
        <Stack gap={4} role="group" aria-label={t('character.armsHide')}>
          <Text size="sm" fw={600}>
            {t('character.armsHide')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('character.armsHideInfo')}
          </Text>
          {materialLabels(s.materials).map((label, i) => (
            <Switch key={i} size="xs" label={label} title={s.materials[i]} checked={s.hide.includes(i)} onChange={(e) => toggle(i, e.currentTarget.checked)} />
          ))}
        </Stack>
      </Stack>
    </Section>
  );
}

/** What a model's materials are called on screen: a kind read from the file's own name (脸, 眼睛, 头发, 衣服, 皮肤), numbered when
 * several share it, else 材质 N; the file's name stays in the hover text. */
const MATERIAL_KINDS: [RegExp, 'eye' | 'hair' | 'cloth' | 'face' | 'skin'][] = [
  [/eye|iris|pupil/i, 'eye'],
  [/hair|bang|fringe/i, 'hair'],
  [/cloth|outfit|dress|shirt|skirt|jacket|coat|pants|shoe|sock|tops|bottoms|acc/i, 'cloth'],
  [/face|mouth|brow|head|teeth|tongue/i, 'face'],
  [/skin|body/i, 'skin'],
];

/** VRoid names its materials `<what>_<n>_<KIND>` (`FaceEyeline_00_FACE`, `Face_00_SKIN`): that last word is the kind and wins
 * over words earlier in the name. */
const VROID_KIND = /_(FACE|EYE|SKIN|CLOTH|HAIR)(?:_\d+)?$/;

function materialLabels(names: string[]): string[] {
  const kinds = names.map((n) => (VROID_KIND.exec(n)?.[1].toLowerCase() as (typeof MATERIAL_KINDS)[number][1] | undefined) ?? MATERIAL_KINDS.find(([re]) => re.test(n))?.[1] ?? null);
  const seen: Record<string, number> = {};
  return kinds.map((k, i) => {
    if (!k) return t('character.mat.other', { v0: i + 1 });
    const n = (seen[k] = (seen[k] ?? 0) + 1);
    const label = t(`character.mat.${k}`);
    return kinds.filter((x) => x === k).length > 1 ? `${label} ${n}` : label;
  });
}

// ---- 4. hair and skirt ----

const OPTIONAL_KEYS = [
  'stiffness', 'damping', 'weight', 'gravity', 'radius', 'angleLimit',
  'restore', 'styleLeash', 'inertia', 'azimuthLimit', 'collide', 'collideCloth', 'selfCollide',
  'step', 'iterations', 'lengthPasses',
] as const;
type OptionalKey = (typeof OPTIONAL_KEYS)[number];

/** One optional value beside its preset's default: the slider starts at the default, and once the author moves it a reset button
 * drops the field again so the preset drives it. */
function OptSlider({ changed, value, onChange, onReset, min, max, step, unit }: { changed: boolean; value: number; onChange: (v: number) => void; onReset: () => void; min: number; max: number; step: number; unit?: string }) {
  return (
    <Group gap={4} wrap="nowrap" align="center">
      <div style={{ flex: 1 }}>
        <Slider value={value} min={min} max={max} step={step} unit={unit} onChange={onChange} />
      </div>
      <Tooltip label={t('character.resetValue')}>
        <UnstyledButton aria-label={t('character.resetValue')} onClick={onReset} style={{ opacity: changed ? 1 : 0.25 }}>
          <IconRefresh size={12} />
        </UnstyledButton>
      </Tooltip>
    </Group>
  );
}

function SpringCard({ id }: { id: string }) {
  const sp = useCharacter((s) => s.springs.find((x) => x.id === id));
  const label = useCharacter((s) => springLabel(s.springs, id));
  const presets = useSpringPresets();
  const base = presets?.[sp?.kind ?? 'longHair'];
  const selected = useCharacter((s) => s.spring === id);
  const hovered = useCharacter((s) => s.hover === id);
  const strand = useCharacter((s) => (s.spring === id ? s.strand : null));
  const [more, setMore] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  // A set picked on the figure brings its card into view.
  useEffect(() => {
    if (selected) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  if (!sp || !base) return null;
  const set = (key: 'stiffness' | 'damping' | 'weight' | 'gravity' | 'radius' | 'angleLimit') => (v: number) => updateSpring(id, (x) => void (x[key] = v));
  const reset = (key: OptionalKey) => updateSpring(id, (x) => void (x[key] = undefined));
  // Removing a strand: the last one takes its set with it.
  const drop = (index: number) => {
    updateSpring(id, (x) => void x.strands.splice(index, 1));
    const after = useCharacter.getState().springs.find((x) => x.id === id);
    if (!after || !after.strands.length)
      useCharacter.setState((s) => ({ springs: s.springs.filter((x) => x.id !== id), spring: null, strand: null, hover: null, hoverStrand: null }));
    else useCharacter.setState({ strand: null });
  };
  // A new kind starts from its preset in every value, not four of them.
  const retype = (v: SpringKind) =>
    updateSpring(id, (x) => {
      x.kind = v;
      for (const k of OPTIONAL_KEYS) (x as Record<OptionalKey, unknown>)[k] = undefined;
    });
  const hz = 1 / (sp.step ?? base.step);
  return (
    <div
      ref={card}
      className="char-spring"
      data-selected={selected || undefined}
      data-hover={hovered || undefined}
      onPointerEnter={() => useCharacter.setState({ hover: id })}
      onPointerLeave={() => useCharacter.setState((s) => (s.hover === id ? { hover: null, hoverStrand: null } : {}))}
      onPointerDown={() => useCharacter.setState({ spring: id })}
    >
      <Group gap={6} wrap="nowrap" mb={6}>
        <IconWind size={14} color="var(--violet)" />
        <Text size="sm" fw={600} truncate style={{ flex: 1 }} title={sp.strands.map((x) => x.join(' › ')).join('\n')}>
          {label}
          {sp.strands.length > 1 ? ` ×${sp.strands.length}` : ''}
        </Text>
        <Tooltip label={t('character.removeSpring')}>
          <UnstyledButton aria-label={t('character.removeSpring')} onClick={() => useCharacter.setState((s) => ({ springs: s.springs.filter((x) => x.id !== id), hover: null, spring: null, strand: null }))}>
            <IconTrash size={14} color="var(--mantine-color-red-5)" />
          </UnstyledButton>
        </Tooltip>
      </Group>
      <Field label={t('character.presetLabel')}>
        <Select
          size="xs"
          allowDeselect={false}
          data={SPRING_KINDS.map((p) => ({ value: p, label: t(`character.preset.${p}`) }))}
          value={sp.kind}
          onChange={(v) => v && retype(v as SpringKind)}
        />
      </Field>
      <Field label={t('character.strands')}>
        <Stack gap={2}>
          {sp.strands.map((bones, i) => (
            <Group key={i} gap={4} wrap="nowrap">
              <UnstyledButton
                aria-label={`${t('character.strand')} ${i + 1}`}
                style={{ flex: 1, textAlign: 'left', minWidth: 0 }}
                onClick={() => useCharacter.setState({ spring: id, strand: i })}
              >
                <Text size="xs" truncate c={i === strand ? 'orange' : undefined} fw={i === strand ? 700 : 400}>
                  {i + 1}. {bones[0]}
                  {bones.length > 1 ? ` › … › ${bones[bones.length - 1]}` : ''} <Text span size="xs" c="dimmed">({bones.length})</Text>
                </Text>
              </UnstyledButton>
              <Tooltip label={t('character.removeStrand')}>
                <UnstyledButton aria-label={t('character.removeStrand')} onClick={() => drop(i)}>
                  <IconTrash size={12} color="var(--mantine-color-red-5)" />
                </UnstyledButton>
              </Tooltip>
            </Group>
          ))}
        </Stack>
      </Field>
      <Field label={t('character.stiffness')}>
        <Slider value={sp.stiffness ?? base.stiffness} onChange={set('stiffness')} />
      </Field>
      <Field label={t('character.damping')}>
        <Slider value={sp.damping ?? base.damping} onChange={set('damping')} />
      </Field>
      <Field label={t('character.weight')}>
        <Slider value={sp.weight ?? base.weight} min={0.1} max={3} step={0.05} onChange={set('weight')} />
      </Field>
      <Field label={t('character.gravity')}>
        <Slider value={sp.gravity ?? base.gravity} min={0} max={3} step={0.05} onChange={set('gravity')} />
      </Field>
      <Field label={t('character.radius')}>
        <Slider value={(sp.radius ?? base.radius) * 100} min={0} max={50} step={0.1} unit=" cm" onChange={(v) => set('radius')(v / 100)} />
      </Field>
      <Field label={t('character.angleLimit')}>
        <Slider value={sp.angleLimit ?? base.angleLimit} min={0} max={180} step={1} unit="°" onChange={set('angleLimit')} />
      </Field>
      <UnstyledButton mt={6} onClick={() => setMore(!more)} aria-expanded={more}>
        <Group gap={4}>
          <IconAdjustments size={12} color="var(--violet)" />
          <Text size="xs" c="dimmed">
            {t('character.advanced')}
          </Text>
        </Group>
      </UnstyledButton>
      {more && (
        <Stack gap={6} mt={6}>
          <Field label={t('character.restore')}>
            <OptSlider changed={sp.restore !== undefined} value={sp.restore ?? base.restore} onChange={(v) => updateSpring(id, (x) => void (x.restore = v))} onReset={() => reset('restore')} min={0} max={1} step={0.01} />
          </Field>
          <Field label={t('character.styleLeash')}>
            <OptSlider changed={sp.styleLeash !== undefined} value={sp.styleLeash ?? base.styleLeash} onChange={(v) => updateSpring(id, (x) => void (x.styleLeash = v))} onReset={() => reset('styleLeash')} min={0} max={1} step={0.01} />
          </Field>
          <Field label={t('character.inertia')}>
            <OptSlider changed={sp.inertia !== undefined} value={sp.inertia ?? base.inertia} onChange={(v) => updateSpring(id, (x) => void (x.inertia = v))} onReset={() => reset('inertia')} min={0} max={1} step={0.01} />
          </Field>
          <Field label={t('character.azimuthLimit')}>
            <OptSlider changed={sp.azimuthLimit !== undefined} value={sp.azimuthLimit ?? base.azimuthLimit} onChange={(v) => updateSpring(id, (x) => void (x.azimuthLimit = v))} onReset={() => reset('azimuthLimit')} min={0} max={180} step={1} unit="°" />
          </Field>
          <Field label={t('character.step')}>
            <OptSlider changed={sp.step !== undefined} value={hz} onChange={(v) => updateSpring(id, (x) => void (x.step = 1 / v))} onReset={() => reset('step')} min={60} max={480} step={5} unit=" Hz" />
          </Field>
          <Field label={t('character.iterations')}>
            <OptSlider changed={sp.iterations !== undefined} value={sp.iterations ?? base.iterations} onChange={(v) => updateSpring(id, (x) => void (x.iterations = Math.round(v)))} onReset={() => reset('iterations')} min={1} max={12} step={1} />
          </Field>
          <Field label={t('character.lengthPasses')}>
            <OptSlider changed={sp.lengthPasses !== undefined} value={sp.lengthPasses ?? base.lengthPasses} onChange={(v) => updateSpring(id, (x) => void (x.lengthPasses = Math.round(v)))} onReset={() => reset('lengthPasses')} min={1} max={8} step={1} />
          </Field>
          <Field label={t('character.collide')}>
            <Group gap={4} wrap="nowrap">
              <Switch size="xs" checked={sp.collide ?? base.collide} onChange={(e) => updateSpring(id, (x) => void (x.collide = e.currentTarget.checked))} />
              <UnstyledButton aria-label={t('character.resetValue')} onClick={() => reset('collide')} style={{ opacity: sp.collide !== undefined ? 1 : 0.25 }}>
                <IconRefresh size={12} />
              </UnstyledButton>
            </Group>
          </Field>
          <Field label={t('character.collideCloth')}>
            <Group gap={4} wrap="nowrap">
              <Switch size="xs" checked={sp.collideCloth ?? base.collideCloth} onChange={(e) => updateSpring(id, (x) => void (x.collideCloth = e.currentTarget.checked))} />
              <UnstyledButton aria-label={t('character.resetValue')} onClick={() => reset('collideCloth')} style={{ opacity: sp.collideCloth !== undefined ? 1 : 0.25 }}>
                <IconRefresh size={12} />
              </UnstyledButton>
            </Group>
          </Field>
          <Field label={t('character.selfCollide')}>
            <Group gap={4} wrap="nowrap">
              <Switch size="xs" checked={sp.selfCollide ?? base.selfCollide} onChange={(e) => updateSpring(id, (x) => void (x.selfCollide = e.currentTarget.checked))} />
              <UnstyledButton aria-label={t('character.resetValue')} onClick={() => reset('selfCollide')} style={{ opacity: sp.selfCollide !== undefined ? 1 : 0.25 }}>
                <IconRefresh size={12} />
              </UnstyledButton>
            </Group>
          </Field>
        </Stack>
      )}
    </div>
  );
}

function SpringsStep() {
  const s = useCharacter();
  if (!s.model) return <Empty>{t('character.needModel')}</Empty>;
  const used = new Set([...Object.values(matchOf(s)), ...s.springs.flatMap((x) => x.strands.flat())]);
  const candidates = s.bones.filter((b) => !used.has(b.name)).map((b) => ({ value: b.name, label: b.name }));
  const parts = shellParts();

  return (
    <>
      <Section title={t('character.step.springs')} icon={IconWind} color={STEP.springs.color} info={t('character.springsInfo')}>
        <Stack gap="xs">
          <Group gap="xs" wrap="nowrap">
            <Select
              style={{ flex: 1 }}
              searchable
              leftSection={<IconPlus size={14} />}
              aria-label={t('character.addSpring')}
              placeholder={t('character.addSpring')}
              data={candidates}
              value={null}
              onChange={(name) => name && addSpring(name)}
              nothingFoundMessage={t('character.noBone')}
            />
            <Tooltip label={t('character.autoSpringsInfo')} multiline w={280}>
              <Button size="compact-sm" variant="light" color="violet" leftSection={<IconWand size={14} />} onClick={() => void autoAddSprings()}>
                {t('character.autoSprings')}
              </Button>
            </Tooltip>
          </Group>
          {s.springs.length ? s.springs.map((x) => <SpringCard key={x.id} id={x.id} />) : <Empty>{t('character.noSprings')}</Empty>}
        </Stack>
      </Section>
      <Section id="char.colliders" title={t('character.colliders')} icon={IconWind} color="var(--scan)" info={t('character.collidersInfo')}>
        <Stack gap={6}>
          <Group gap={8} wrap="nowrap">
            <Switch
              size="xs"
              checked={s.shell?.on ?? false}
              disabled={!s.shell?.points}
              label={t('character.shellOn')}
              onChange={(e) => useCharacter.setState((x) => (x.shell ? { shell: { ...x.shell, on: e.currentTarget.checked } } : {}))}
            />
            <Text size="xs" c="dimmed">
              {t('character.shellCount', { v0: s.shell?.points ?? 0, v1: s.shell?.triangles ?? 0 })}
            </Text>
          </Group>
          {s.shell?.on && (
            <Stack gap={4}>
              <Text size="xs" c="dimmed">
                {t('character.shellText')}
              </Text>
              <Group>
                <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconRulerMeasure size={13} />} onClick={() => void fitShell(true)}>
                  {t('character.fitShell')}
                </Button>
              </Group>
              <Stack gap={4} role="group" aria-label={t('character.shellParts')}>
                <Text size="sm" fw={600}>
                  {t('character.shellParts')}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('character.shellPartsInfo')}
                </Text>
                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {materialLabels(s.materials).map((label, i) => {
                    const name = s.materials[i]!;
                    return <Switch key={i} size="xs" label={label} title={name} checked={parts.includes(name)} onChange={() => toggleShellPart(name)} />;
                  })}
                </div>
              </Stack>
            </Stack>
          )}
        </Stack>
      </Section>
    </>
  );
}

// ---- 5. materials ----

function MaterialsStep() {
  const s = useCharacter();
  if (!s.model) return <Empty>{t('character.needModel')}</Empty>;
  return (
    <Section title={t('character.step.materials')} icon={IconPalette} color={STEP.materials.color} info={t('character.shaderInfo')}>
      <Stack gap="xs">
        {materialLabels(s.materials).map((label, i) => (
          <div key={i} title={s.materials[i]}>
            <Field label={label}>
              <Select
                size="xs"
                aria-label={t('character.shader')}
                allowDeselect={false}
                data={[{ value: 'lit', label: t('character.shaderLit') }]}
                value={s.shaders[s.materials[i]] ?? 'lit'}
                onChange={() => undefined}
              />
            </Field>
          </div>
        ))}
      </Stack>
    </Section>
  );
}

// ---- 6. check ----

function CheckRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      {ok ? <IconCheck size={14} color="var(--ok)" /> : <IconAlertTriangle size={14} color="var(--mantine-color-red-5)" />}
      <Text size="sm">{text}</Text>
    </Group>
  );
}

/** What export checks: the one joint a character cannot do without has a bone. */
function useChecks() {
  const s = useCharacter();
  return [{ ok: matchReady(s.check), text: t('character.checkJoints') }];
}

function CheckStep() {
  const model = useCharacter((s) => s.model);
  const credit = useCharacter((s) => s.credit);
  const rows = useChecks();
  if (!model) return <Empty>{t('character.needModel')}</Empty>;
  return (
    <Section title={t('character.step.check')} icon={IconListCheck} color={STEP.check.color} info={t('character.checkInfo')}>
      <Stack gap="xs">
        {rows.map((r) => (
          <CheckRow key={r.text} {...r} />
        ))}
        {credit && (
          <Text size="xs" c="dimmed">
            {t('character.creditInPack', { v0: credit })}
          </Text>
        )}
      </Stack>
    </Section>
  );
}

/** 导出 ▸ 导出模组包 on the character page: the checks, then the mod's details and the two exports. */
export function CharacterExportModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const model = useCharacter((s) => s.model);
  const rows = useChecks();
  return (
    <Modal opened={opened} onClose={onClose} title={t('actions.exportMod')} centered size="md">
      {!model ? (
        <Empty>{t('character.needModel')}</Empty>
      ) : (
        <Stack gap="xs">
          {rows.map((r) => (
            <CheckRow key={r.text} {...r} />
          ))}
          <ModForm ready={rows.every((r) => r.ok)} />
        </Stack>
      )}
    </Modal>
  );
}

const NAME = /^[A-Za-z0-9_]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** The Thunderstore mod's name, version, description and icon (the 3D view's picture until one is picked), and the two exports. */
function ModForm({ ready }: { ready: boolean }) {
  const skin = useCharacter((s) => s.skinId);
  const skinName = useCharacter((s) => s.name);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(modName(skinName, 'Character_Skin'));
    void stageIcon().then(setIcon, () => setIcon(null));
  }, [skin]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickIcon = async () => {
    const [p] = await window.forge.openDialog('file', [{ name: t('exportMod.images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]);
    if (p) setIcon(p);
  };
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    await job();
    setBusy(false);
  };
  const formOk = NAME.test(name) && VERSION.test(version) && !!icon;
  return (
    <Stack gap="xs" mt="xs">
      <TextInput size="xs" label={t('exportMod.name')} description={t('exportMod.nameHint')} value={name} onChange={(e) => setName(e.currentTarget.value)} error={name && !NAME.test(name)} />
      <TextInput size="xs" label={t('exportMod.version')} value={version} onChange={(e) => setVersion(e.currentTarget.value)} error={!VERSION.test(version)} w={140} />
      <Textarea size="xs" label={t('exportMod.description')} value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={250} autosize minRows={2} />
      <Field label={t('exportMod.icon')}>
        <Group gap="xs" wrap="nowrap">
          {icon ? <Image src={fileUrl(icon)} w={56} h={56} radius="sm" fit="cover" /> : <Text size="xs">{t('exportMod.noIcon')}</Text>}
          <Button size="compact-xs" variant="default" onClick={() => void pickIcon()}>
            {t('exportMod.pickIcon')}
          </Button>
        </Group>
      </Field>
      <Button
        fullWidth
        leftSection={<IconWorldUpload size={15} />}
        disabled={!ready || !formOk}
        loading={busy}
        onClick={() => void run(() => exportCharacterMod({ name, version, description, icon: icon! }))}
      >
        {t('character.exportMod')}
      </Button>
      <Button fullWidth variant="default" leftSection={<IconPackageExport size={15} />} disabled={!ready} loading={busy} onClick={() => void run(exportCharacterPack)}>
        {t('character.exportPack')}
      </Button>
    </Stack>
  );
}

const PANELS: Record<Step, () => React.ReactElement> = {
  model: ModelStep,
  bones: BonesStep,
  arms: ArmsStep,
  springs: SpringsStep,
  materials: MaterialsStep,
  check: CheckStep,
};

export function CharacterInspector() {
  const step = useCharacter((s) => s.step);
  const model = useCharacter((s) => s.model);
  const Panel = PANELS[step];
  const S = STEP[step];
  return (
    <>
      <InspHead kind={t('character.title')} icon={S.icon} color={S.color} title={stepTitle(step)} meta={model ? model.split(/[\\/]/).pop() : undefined} />
      <Panel />
    </>
  );
}
