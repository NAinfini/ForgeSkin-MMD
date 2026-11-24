// The video-style strip pinned to the bottom of the dance stage: play/pause above a full-width scrubber, with 5-second jumps
// either side of it. Clicking anywhere on the bar plays from there; the arrow keys do the same jumps from the keyboard.
import { useEffect, useRef } from 'react';
import { ActionIcon, Group, HoverCard, Slider, Text, Tooltip } from '@mantine/core';
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRewindBackward5,
  IconRewindForward5,
  IconVolume,
  IconVolume2,
  IconVolume3,
  IconVolumeOff,
} from '@tabler/icons-react';
import { t } from '../i18n';
import { playPicture, seekSong } from './playback';
import { danceLength, trackSourceAt, useDance } from './state';

export const clock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Moves the playhead; the song follows its strip when the dance has one. */
export function seekTo(seconds: number): void {
  const s = useDance.getState();
  const time = Math.max(0, Math.min(danceLength(), seconds));
  useDance.setState({ time });
  if (s.tracks.music.length) seekSong(trackSourceAt(s.tracks.music, time));
  // Where no song is playing, the playhead's own clock is what moves it, so it is re-anchored here to the new second.
  playPicture(time);
}

/**
 * Play/pause from the round button or the space bar. A dance that has played to its end starts over from 0:00 instead
 * of sitting on the last frame, which is what pressing play again is asking for.
 */
export function togglePlay(): void {
  const s = useDance.getState();
  if (s.playing) {
    useDance.setState({ playing: false });
    return;
  }
  if (s.time >= danceLength(s) - 1e-3) seekTo(0);
  useDance.setState({ playing: true });
}

/** Left/right arrows jump five seconds and space plays or pauses, as in any video player, unless the user is typing. */
export function useArrowKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const space = e.key === ' ' || e.key === 'Spacebar';
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && !space) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (!useDance.getState().file) return;
      // Capture phase: the scrubber's own handler would otherwise step it by a fraction of a second first.
      e.preventDefault();
      e.stopPropagation();
      if (space) togglePlay();
      else seekTo(useDance.getState().time + (e.key === 'ArrowLeft' ? -5 : 5));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/**
 * The song's level, at the right end of the transport row: the icon clicks between muted and the level it last had,
 * hovering opens the slider itself, and the wheel steps it 1% a notch for a level the slider cannot hit exactly. It
 * writes the dance's own `volume`, which the stage already keeps on the element, so what is set here is what the
 * project saves and what it plays the next time.
 */
export function VolumeButton({ enabled, className = 'timeline-volume' }: { enabled: boolean; className?: string }) {
  const volume = useDance((s) => s.volume);
  const last = useRef(volume > 0.001 ? volume : 0.3);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (volume > 0.001) last.current = volume;
  }, [volume]);
  // Bound natively: React's wheel listener is passive, so a handler of its own could step the level but not stop the
  // stage behind from scrolling at the same time.
  useEffect(() => {
    const el = button.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const from = useDance.getState().volume;
      const step = e.deltaY < 0 ? 0.01 : -0.01;
      useDance.setState({ volume: Math.max(0, Math.min(1, Math.round((from + step) * 100) / 100)) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const muted = volume <= 0.001;
  const Icon = muted ? IconVolumeOff : volume < 0.4 ? IconVolume : volume < 0.75 ? IconVolume2 : IconVolume3;
  return (
    <HoverCard position="top-end" offset={10} shadow="md" withArrow openDelay={100} closeDelay={150}>
      <HoverCard.Target>
        <ActionIcon
          ref={button}
          className={className}
          size="md"
          variant="subtle"
          color="gray"
          disabled={!enabled}
          aria-label={t('dance.volume')}
          onClick={() => useDance.setState({ volume: muted ? last.current : 0 })}
        >
          <Icon size={20} />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Group gap={10} wrap="nowrap">
          <Slider
            w={140}
            min={0}
            max={1}
            step={0.01}
            value={volume}
            label={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => useDance.setState({ volume: v })}
          />
          <Text size="xs" c="dimmed" w={34} ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(volume * 100)}%
          </Text>
        </Group>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

export function DanceTimeline() {
  const time = useDance((s) => s.time);
  const playing = useDance((s) => s.playing);
  const hasFile = useDance((s) => !!s.file);
  const length = danceLength();
  useArrowKeys();
  return (
    <div className="timeline">
      <Group className="timeline-controls" gap={6} wrap="nowrap" justify="center">
        <Tooltip label={t('dance.back5')}>
          <ActionIcon size="md" variant="subtle" color="gray" disabled={!hasFile} onClick={() => seekTo(time - 5)}>
            <IconRewindBackward5 size={20} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={playing ? t('dance.pause') : t('dance.play')}>
          <ActionIcon size={38} radius="xl" variant="filled" color="flare" disabled={!hasFile} onClick={togglePlay}>
            {playing ? <IconPlayerPauseFilled size={18} /> : <IconPlayerPlayFilled size={20} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t('dance.forward5')}>
          <ActionIcon size="md" variant="subtle" color="gray" disabled={!hasFile} onClick={() => seekTo(time + 5)}>
            <IconRewindForward5 size={20} />
          </ActionIcon>
        </Tooltip>
        <VolumeButton enabled={hasFile} />
      </Group>
      <Slider
        classNames={{ root: 'timeline-bar' }}
        min={0}
        max={Math.max(0.1, length)}
        step={0.05}
        value={Math.min(time, length)}
        disabled={!hasFile}
        label={clock}
        onChange={seekTo}
      />
      <Group className="timeline-clock" justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {clock(time)}
        </Text>
        <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {clock(length)}
        </Text>
      </Group>
    </div>
  );
}