import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { encodeWavStereo16 } from './wavUtils';

/**
 * Supported video MIME types that browsers can reliably decode via HTMLVideoElement.
 * Used for detection in FileUpload.
 */
export const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/x-m4v',
  'video/quicktime',
  'video/webm',
  'video/ogg',
  'video/x-matroska',
  'video/avi',
  'video/x-msvideo',
  'video/mpeg',
  'video/3gpp',
  'video/3gpp2',
]);

/** Return true if the file is a video that should be converted to audio. */
export function isVideoFile(file: File): boolean {
  if (VIDEO_MIME_TYPES.has(file.type)) return true;
  // Fallback: inspect extension for cases where the browser returns an empty/wrong MIME type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', '3gp', '3g2'].includes(ext);
}

// ── Lazy-loaded ffmpeg singleton ───────────────────────────────────────────
let ffmpegInstance: FFmpeg | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  const ffmpeg = new FFmpeg();
  await ffmpeg.load();
  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

/**
 * Extract the audio track from a video File and return it as a new audio/wav File.
 *
 * Strategy:
 *   Fast path  — `AudioContext.decodeAudioData()` (works for MP4/WebM with supported codecs)
 *   Fallback   — ffmpeg.wasm (handles any format: .mov, HEVC, MKV, etc.)
 */
export async function videoToAudio(
  file: File,
  onProgress?: (message: string) => void,
): Promise<File> {
  const baseName = file.name.replace(/\.[^.]+$/, '');

  // Formats known to always fail decodeAudioData — skip directly to ffmpeg
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const skipFastPath =
    file.type === 'video/quicktime' || ['mov', 'hevc', 'mkv', 'avi'].includes(ext);

  // ── Fast path ────────────────────────────────────────────────────────────
  if (!skipFastPath) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new AudioContext();
      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      } finally {
        await ctx.close();
      }
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.numberOfChannels >= 2 ? audioBuffer.getChannelData(1) : left;
      const wavBuffer = encodeWavStereo16(left, right, audioBuffer.sampleRate);
      return new File([wavBuffer], `${baseName}.wav`, { type: 'audio/wav' });
    } catch {
      // decodeAudioData failed — fall through to ffmpeg
    }
  }

  // ── ffmpeg.wasm fallback ─────────────────────────────────────────────────
  onProgress?.('ffmpeg を読み込み中...');
  const ffmpeg = await getFFmpeg();

  const inputName = `input${ext ? '.' + ext : ''}`;
  const outputName = 'output.wav';

  onProgress?.('音声を抽出中...');
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  await ffmpeg.exec([
    '-i', inputName,
    '-vn',              // no video
    '-acodec', 'pcm_s16le',
    '-ar', '44100',
    '-ac', '2',         // stereo
    outputName,
  ]);

  const outputData = await ffmpeg.readFile(outputName);

  // Clean up ffmpeg's virtual filesystem
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  if (!(outputData instanceof Uint8Array) || outputData.length === 0) {
    throw new Error(`"${file.name}" から音声を抽出できませんでした。非対応のコーデックの可能性があります。`);
  }

  onProgress?.('完了');
  return new File([outputData], `${baseName}.wav`, { type: 'audio/wav' });
}
