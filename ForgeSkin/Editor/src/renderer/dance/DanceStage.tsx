// The 舞蹈 tab's 3D view: the open character dancing the dance being composed, with the song under it and a scrubber below.
import { CameraControls, Grid } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ActionIcon, Group, Loader, Paper, SegmentedControl, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconAspectRatio } from '@tabler/icons-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Quaternion, type Object3D, type PerspectiveCamera } from 'three';
import type CameraControlsImpl from 'camera-controls';
import { CHARACTER_LIGHTS, modelScene, modelVersion, onModel, restPose, setMorphWeights } from '../character/model';
import { frameFigure } from '../character/stageCamera';
import { t } from '../i18n';
import { DanceTimeline, seekTo } from './DanceTimeline';
import { DanceTracks } from './DanceTracks';
import { morphWeights } from './face';
import { pause as pauseSong, pictureClock, play as playSong, playPicture, setSong, setVolume, songClock, stopPicture } from './playback';
import { dancePlayer, type DancePlayer } from './preview';
import { camAt, type CamKey } from './camera';
import { cameraKeys, clipAt, danceLength, gainAt, sourceAt, trackSourceAt, useDance } from './state';

const useModel = () => {
  useSyncExternalStore(onModel, modelVersion);
  return modelScene();
};

/**
 * The playhead on its own clock, for the stretches with no song under it. `from` is the second the playhead last held —
 * when the clock has drifted from it (a seek, a jump, the play button), the clock is anchored there again.
 */
function wallClock(from: number): number {
  const at = pictureClock();
  if (at === null || Math.abs(at - from) > 0.25) playPicture(from);
  return pictureClock() ?? from;
}

/** Advances the clock — from the song while it runs, by the wall clock when nothing sounds under it — and poses the model. */
function Dancer({ player }: { player: React.RefObject<DancePlayer | null> }) {
  // Which music strip the song is playing for; a cut makes the next strip a new one, and the song jumps to its in-point.
  const stripId = useRef<string | null>(null);
  useFrame(() => {
    const s = useDance.getState();
    const length = danceLength(s);
    const clips = s.tracks.music;
    let time = s.time;
    if (s.playing) {
      // The song is the clock only while the playhead is on one of its strips. Starting (or seeking) onto one brings the
      // song in at the second the strip shows; in a gap, and before or after the music, the picture runs on frame time.
      // Crossing into a different strip (after a cut) restarts the song at that strip's own in-point.
      const strip = clipAt(clips, s.time);
      if (!strip) {
        stripId.current = null;
        if (songClock() !== null) pauseSong();
        time = wallClock(s.time);
      } else {
        // The strip's own gain and its fades, under the preview volume: set every frame so a fade is heard as it runs.
        const level = Math.max(0, Math.min(1, s.volume * gainAt(strip, s.time)));
        if (strip.id !== stripId.current) {
          stripId.current = strip.id;
          playSong(sourceAt(strip, s.time), level);
        } else {
          setVolume(level);
        }
        const at = songClock();
        if (at === null) {
          // A strip with no sound under it (a song that failed to start, a dance with no music at all) runs on the same
          // wall clock a gap does, rather than holding still — so its anchor must be left alone here.
          time = wallClock(s.time);
        } else {
          stopPicture();
          time = strip.start + at - strip.in;
        }
      }
      if (time >= length) {
        time = length;
        useDance.setState({ playing: false });
      }
      if (Math.abs(time - s.time) > 0.02) useDance.setState({ time });
    } else {
      stripId.current = null;
      stopPicture();
      if (songClock() !== null) pauseSong();
    }
    // Where the action strips say this moment of the timeline is in the source: in a gap between them the body holds still.
    const seconds = trackSourceAt(s.tracks.action, Math.min(Math.max(0, time), length));
    player.current?.sample(seconds);
    // The action's own expressions, read on the same clock the `.face` gets written for and matched to the model's shapes
    // exactly as the game matches them. A hand-picked `.face` is opaque here (its curves may belong to another model).
    setMorphWeights(s.source.face ? null : s.morphs.length ? morphWeights(s.morphs, seconds * (s.file?.rate ?? 30)) : null);
  });
  // Leaving the dance tab must not leave the character tab looking at a frozen face.
  useEffect(() => () => setMorphWeights(null), []);
  return null;
}

/**
 * A `.cam` quaternion is Unity's: the camera looks along its own **+Z**. Three's camera looks along **−Z**, so the same
 * pose, seen through three's camera, is the rotation turned half a turn about its own up — without this the view looks
 * straight away from the dancer and the stage seems frozen.
 */
const YAW_AROUND = new Quaternion(0, 1, 0, 0);

/**
 * Watches the dance through the camera move instead of the orbit: the `.cam` is authored in the same space the model
 * stands in (the game re-anchors it to the player only because the player is elsewhere), so the key is used as it is.
 * Checked against Blender itself (`blender_cam_dump.py` on the same PMX + VMD): the dump's camera position `(x,y,z)`
 * equals the key's `(x, z, −y)`, which is exactly how the glTF was written from Blender, and the key's forward equals
 * the dump's — so nothing is mirrored here, the key lands on the model as Blender framed it (max 4 cm, mean 1 mm).
 */
/** The height a 16:9 frame takes inside a stage of `w`×`h` — it fills the stage the way it can, never overflowing. */
const frameHeight = (w: number, h: number): number => Math.min(h, (w * 9) / 16);

function CameraView({ keys, framed }: { keys: CamKey[]; framed: boolean }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const view = useDance((s) => s.view);
  // The stage's own near plane is set for an orbit that keeps its distance; a camera move brushes past the figure, and
  // anything within that plane is cut away — which looked like pieces of the model vanishing as the camera came close.
  // The camera move gets a 1 cm plane, and the orbit gets the stage's own back.
  const rest = useRef({ near: camera.near, far: camera.far });
  useEffect(() => {
    if (view !== 'camera') {
      camera.fov = 40;
      camera.near = rest.current.near;
      camera.far = rest.current.far;
      camera.updateProjectionMatrix();
    }
  }, [view, camera]);
  useFrame(() => {
    const s = useDance.getState();
    if (s.view !== 'camera' || !keys.length) return;
    // The camera strips say where this moment of the timeline is in the `.cam`; in a gap the last frame before it holds.
    const key = camAt(keys, trackSourceAt(s.tracks.camera, s.time));
    if (!key) return;
    camera.position.set(key.pos[0], key.pos[1], key.pos[2]);
    camera.quaternion.set(key.rot[0], key.rot[1], key.rot[2], key.rot[3]).multiply(YAW_AROUND);
    // A frame `h` px tall inside a canvas `H` px tall shows tan(fov/2)·H/h of vertical view, so widening the fov by
    // H/h makes the band inside the frame show exactly the vertical angle the `.cam` gives the game.
    const h = framed ? frameHeight(size.width, size.height) : 0;
    camera.fov = h > 0 ? (2 * Math.atan(Math.tan((key.fov * Math.PI) / 360) * (size.height / h)) * 180) / Math.PI : key.fov;
    // Close up, and kept short: the preview has nothing to show beyond a few metres of stage, and a 1 cm near plane
    // against a small far plane keeps the depth buffer well-spread.
    camera.near = 0.01;
    camera.far = 50;
    camera.updateProjectionMatrix();
  });
  return null;
}



/**
 * Puts the orbit where the 人物 tab puts it, from inside the canvas: the orbit is made there, so a tab effect that runs
 * before it exists (a fresh canvas, a reload) would frame nothing and leave the camera at the canvas's own default.
 * Framed once per figure — and again after the camera view, whose keys move the camera behind the orbit's back.
 */
function Framer({ model, controls }: { model: Object3D | null; controls: React.RefObject<CameraControlsImpl | null> }) {
  const view = useDance((s) => s.view);
  const framed = useRef<Object3D | null>(null);
  useFrame(() => {
    if (view !== 'free') {
      framed.current = null;
      return;
    }
    if (!controls.current || !model || framed.current === model) return;
    framed.current = model;
    frameFigure(controls.current, model);
  });
  return null;
}

function Scene({ player, keys, framed, controls }: { player: React.RefObject<DancePlayer | null>; keys: CamKey[]; framed: boolean; controls: React.RefObject<CameraControlsImpl | null> }) {
  const model = useModel();
  const view = useDance((s) => s.view);
  return (
    <>
      <ambientLight intensity={CHARACTER_LIGHTS.ambient} />
      <directionalLight position={CHARACTER_LIGHTS.key.position} intensity={CHARACTER_LIGHTS.key.intensity} />
      <directionalLight position={CHARACTER_LIGHTS.fill.position} intensity={CHARACTER_LIGHTS.fill.intensity} />
      <Grid args={[10, 10]} cellSize={0.25} sectionSize={1} cellColor="#2a3340" sectionColor="#3b4a5c" fadeDistance={12} infiniteGrid />
      {model && <primitive object={model} />}
      <Dancer player={player} />
      <CameraControls ref={controls} makeDefault enabled={view === 'free'} minDistance={0.6} maxDistance={20} />
      <CameraView keys={keys} framed={framed} />
      <Framer model={model} controls={controls} />
    </>
  );
}

export function DanceStage() {
  const model = useModel();
  const file = useDance((s) => s.file);
  const audio = useDance((s) => s.source.audio);
  const volume = useDance((s) => s.volume);
  const view = useDance((s) => s.view);
  const step = useDance((s) => s.step);
  const useCamera = useDance((s) => s.useCamera);
  const paths = useDance((s) => s.source.camera);
  const player = useRef<DancePlayer | null>(null);
  const controls = useRef<CameraControlsImpl | null>(null);
  const [keys, setKeys] = useState<CamKey[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'empty'>('idle');
  // The camera-frame overlay: a 16:9 window on the stage's picture, everything outside it hidden.
  const [framed, setFramed] = useState(false);
  // Measured on the picture area alone: the 剪辑 strip stands under it in the layout, so the 16:9 window is worked out
  // from the space the picture really has and never runs behind the timeline.
  const stage = useElementSize<HTMLDivElement>();
  const boxW = Math.min(stage.width, (stage.height * 16) / 9);
  const boxH = (boxW * 9) / 16;

  useEffect(() => {
    if (view !== 'camera') setFramed(false);
  }, [view]);

  // The camera move is only read when it can be watched (or when the view asks for it): VMD→`.cam` is a cheap
  // conversion, but the file may be large and none of it is needed before then.
  useEffect(() => {
    let live = true;
    if (!paths || !useCamera) {
      setKeys([]);
      return;
    }
    void cameraKeys()
      .then((k) => live && setKeys(k))
      .catch(() => live && setKeys([]));
    return () => {
      live = false;
    };
  }, [paths, useCamera]);

  // A camera view without a camera is the orbit; fall back rather than freeze the stage.
  useEffect(() => {
    if (view === 'camera' && (!useCamera || !paths)) useDance.setState({ view: 'free' });
  }, [view, useCamera, paths]);

  useEffect(() => setSong(audio), [audio]);
  useEffect(() => setVolume(volume), [volume]);
  // The song's start and stop follow the playhead onto and off its strip — done inside `Dancer`, which already runs every
  // frame on the clock the picture uses, so the two can never drift apart.

  // Leaving the tab unmounts the stage but not the song: it kept singing behind the character tab, and the dance came
  // back at 0:00 while the music was already minutes in. Stop both (the reload below puts the dance back at the start).
  useEffect(
    () => () => {
      pauseSong();
      useDance.setState({ playing: false });
    },
    [],
  );

  // The dance plays on the character that is open; opening another one (or another dance) rebuilds the copy.
  useEffect(() => {
    let live = true;
    let made: DancePlayer | null = null;
    player.current = null;
    if (!file || !model) {
      setState('empty');
      return;
    }
    setState('loading');
    seekTo(0);
    void dancePlayer(file)
      .then((p) => {
        if (!live) {
          p?.dispose();
          return;
        }
        made = p;
        player.current = p;
        setState(p ? 'ready' : 'empty');
      })
      .catch(() => live && setState('empty'));
    return () => {
      live = false;
      made?.dispose();
      if (player.current === made) player.current = null;
      restPose(); // the character tab shows its own clip from the rest pose
    };
  }, [file, model]);

  return (
    <main className="stage">
      <div className="stage-view" ref={stage.ref}>
      <Canvas gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }} dpr={[1, 2]} camera={{ position: [0, 1.2, 3.2], fov: 40 }}>
        <Scene player={player} keys={keys} framed={framed} controls={controls} />
      </Canvas>
      {view === 'camera' && framed && keys.length > 0 && boxW > 0 && (
        <div aria-hidden style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', overflow: 'hidden', pointerEvents: 'none' }}>
          <div
            style={{
              width: boxW,
              height: boxH,
              boxShadow: '0 0 0 100vmax rgba(8, 9, 11, 0.94)',
              outline: '1px solid rgba(255, 255, 255, 0.28)',
            }}
          />
        </div>
      )}
      {/* No title here: the window's top bar already shows 舞蹈, and the open dance's name sits in the right panel and
          the status bar — the stage keeps only the view switch. */}
      <div className="stage-head">
        <Group gap={6} wrap="nowrap">
          <SegmentedControl
            className="view-toggle"
            size="xs"
            value={view}
            onChange={(v) => {
              useDance.setState({ view: v as 'free' | 'camera' });
              // The camera view is about the game's framing, so it starts with the 16:9 window on.
              setFramed(v === 'camera');
            }}
            data={[
              { label: t('dance.viewFree'), value: 'free' },
              { label: t('dance.viewCamera'), value: 'camera', disabled: !keys.length },
            ]}
          />
          <Tooltip label={t('dance.frameHint')} withArrow>
            <ActionIcon
              className="frame-toggle"
              data-on={framed}
              size={26}
              radius="sm"
              variant="transparent"
              color="flare"
              aria-label={t('dance.frameHint')}
              disabled={!keys.length}
              onClick={() => {
                if (view !== 'camera') {
                  useDance.setState({ view: 'camera' });
                  setFramed(true);
                } else setFramed((v) => !v);
              }}
            >
              <IconAspectRatio size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </div>
      {state === 'loading' && (
        <div className="stage-empty">
          <Loader type="bars" size="sm" />
        </div>
      )}
      {state === 'empty' && (
        <div className="stage-empty">
          <Paper className="card" bg="transparent">
            <Stack align="center">
              <Title order={2}>{model ? t('dance.emptyTitle') : t('dance.emptyModelTitle')}</Title>
              <Text c="dimmed" ta="center">
                {model ? t('dance.emptyText') : t('dance.emptyModelText')}
              </Text>
            </Stack>
          </Paper>
        </div>
      )}
      </div>
      {/* 剪辑 replaces the plain playback row with the track strip, so the two never stack up. The strip takes its own
          room below the picture instead of lying over it: a camera view framed inside the stage stayed half hidden
          behind it. */}
      {model && file && (step === 'motion' ? <DanceTracks /> : <DanceTimeline />)}
    </main>
  );
}