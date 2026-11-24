// A song for a dance. The game plays a dance's music with NAudio's WaveFileReader, so anything the author drops in (mp3,
// m4a, ogg, flac) is decoded here and written out as plain 16-bit PCM in a .wav beside the dance.

/** Decoded samples, ready to write: interleaved stereo unless the source was mono, which stays mono. */
export interface Song {
  channels: number;
  sampleRate: number;
  samples: Float32Array;
  seconds: number;
}

const CONTEXT = 1;

export async function decodeSong(bytes: ArrayBuffer): Promise<Song> {
  // Any AudioContext can decode; an offline one needs no output device and is closed at once.
  const context = new OfflineAudioContext(CONTEXT, CONTEXT, 44100);
  const buffer = await context.decodeAudioData(bytes);
  const channels = Math.min(2, buffer.numberOfChannels);
  if (channels === 1) {
    const mono = buffer.getChannelData(0).slice();
    return { channels: 1, sampleRate: buffer.sampleRate, samples: mono, seconds: buffer.duration };
  }
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const samples = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    samples[i * 2] = left[i]!;
    samples[i * 2 + 1] = right[i]!;
  }
  return { channels: 2, sampleRate: buffer.sampleRate, samples, seconds: buffer.duration };
}

/** The same song as a PCM WAV file. */
export function toWav(song: Song): Uint8Array {
  const bytes = song.samples.length * 2;
  const out = new Uint8Array(44 + bytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, song.channels, true);
  view.setUint32(24, song.sampleRate, true);
  view.setUint32(28, song.sampleRate * song.channels * 2, true);
  view.setUint16(32, song.channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  let at = 44;
  for (let i = 0; i < song.samples.length; i++) {
    const v = Math.max(-1, Math.min(1, song.samples[i]!));
    view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    at += 2;
  }
  return out;
}