/* eslint-disable no-restricted-globals */

import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import type { ChordInfo } from './AudioAnalyzer';
import type { StructureSegment } from './AudioAnalysisWorkerClient';
import { ANALYSIS_FILTERS } from './analysisConfig.js';
import { processChordFrames } from './chordUtils.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EssentiaInstance = any;

interface AnalyzeRequest {
  id: number;
  type: 'analyze';
  payload: {
    mono: Float32Array;
    sampleRate: number;
    minHoldSeconds?: number;
  };
}

interface StructureRequest {
  id: number;
  type: 'analyze_structure';
  payload: {
    mono: Float32Array;
    sampleRate: number;
  };
}

interface WarmupRequest {
  id: number;
  type: 'warmup';
}

type WorkerRequest = AnalyzeRequest | StructureRequest | WarmupRequest;

type WorkerResponse =
  | {
      id: number;
      type: 'result';
      payload: {
        bpm: number;
        key: string;
        chords: ChordInfo[];
      };
    }
  | {
      id: number;
      type: 'structure_result';
      payload: { segments: StructureSegment[] };
    }
  | {
      id: number;
      type: 'ok';
    }
  | {
      id: number;
      type: 'error';
      error: string;
    };

let essentia: EssentiaInstance | null = null;
let initPromise: Promise<EssentiaInstance> | null = null;

async function getEssentia(): Promise<EssentiaInstance> {
  if (essentia) return essentia;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    let wasmModule: unknown = EssentiaWASM;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maybeAny = wasmModule as any;

    if (maybeAny && typeof maybeAny.then === 'function') {
      wasmModule = await maybeAny;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ready = (wasmModule as any)?.ready;
    if (ready && typeof ready.then === 'function') {
      await ready;
    }

    essentia = new Essentia(wasmModule);
    return essentia;
  })();

  return initPromise;
}

function toVector(ess: EssentiaInstance, mono: Float32Array) {
  return ess.arrayToVector(mono);
}

function onePoleLowPass(input: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  if (cutoffHz <= 0 || cutoffHz >= sampleRate / 2) return input.slice();

  const output = new Float32Array(input.length);
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);

  output[0] = input[0] ?? 0;
  for (let i = 1; i < input.length; i++) {
    output[i] = output[i - 1] + alpha * (input[i] - output[i - 1]);
  }

  return output;
}

function onePoleHighPass(input: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  if (cutoffHz <= 0) return input.slice();

  const output = new Float32Array(input.length);
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt);

  output[0] = 0;
  for (let i = 1; i < input.length; i++) {
    output[i] = alpha * (output[i - 1] + input[i] - input[i - 1]);
  }

  return output;
}

function preprocessForBpm(mono: Float32Array, sampleRate: number): Float32Array {
  const highPassed = onePoleHighPass(mono, sampleRate, ANALYSIS_FILTERS.bpm.highPassHz);
  return onePoleLowPass(highPassed, sampleRate, ANALYSIS_FILTERS.bpm.lowPassHz);
}

function preprocessForTonal(mono: Float32Array, sampleRate: number): Float32Array {
  const highPassed = onePoleHighPass(mono, sampleRate, ANALYSIS_FILTERS.tonal.highPassHz);
  return onePoleLowPass(highPassed, sampleRate, ANALYSIS_FILTERS.tonal.lowPassHz);
}

function detectBpm(ess: EssentiaInstance, mono: Float32Array, sampleRate: number): number {
  const filtered = preprocessForBpm(mono, sampleRate);
  const signal = toVector(ess, filtered);
  try {
    const rhythm = ess.RhythmExtractor2013(
      signal,
      208,
      'multifeature',
      40
    );

    if (typeof rhythm?.bpm === 'number' && Number.isFinite(rhythm.bpm)) {
      return Math.round(rhythm.bpm);
    }

    const result = ess.PercivalBpmEstimator(signal, undefined, undefined, undefined, undefined, undefined, undefined, sampleRate);
    return Math.round(result.bpm);
  } catch {
    return 0;
  } finally {
    signal.delete();
  }
}

function detectKey(ess: EssentiaInstance, mono: Float32Array, sampleRate: number): string {
  const filtered = preprocessForTonal(mono, sampleRate);
  const signal = toVector(ess, filtered);
  try {
    let result;

    try {
      result = ess.KeyExtractor(
        signal,
        true,
        4096,
        2048,
        36,
        undefined,
        undefined,
        undefined,
        undefined,
        'edma'
      );
    } catch {
      result = ess.KeyExtractor(signal);
    }

    const scaleJa = result.scale === 'major' ? 'メジャー' : 'マイナー';
    return `${result.key} ${scaleJa}`;
  } catch {
    return '';
  } finally {
    signal.delete();
  }
}

function detectChords(
  ess: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
  minHoldSeconds = 1.0
): ChordInfo[] {
  const filtered = preprocessForTonal(mono, sampleRate);
  const signal = toVector(ess, filtered);

  try {
    const hopSize = 2048;
    const result = ess.TonalExtractor(signal, undefined, hopSize);

    const numFrames: number = result.chords_progression.size();
    const frames: string[] = Array.from({ length: numFrames }, (_, i) => result.chords_progression.get(i) as string);

    return processChordFrames(frames, hopSize, sampleRate, minHoldSeconds);
  } catch {
    return [];
  } finally {
    signal.delete();
  }
}

async function analyze(mono: Float32Array, sampleRate: number, minHoldSeconds = 1.0) {
  const ess = await getEssentia();
  const bpm = detectBpm(ess, mono, sampleRate);
  const key = detectKey(ess, mono, sampleRate);
  const chords = detectChords(ess, mono, sampleRate, minHoldSeconds);
  return { bpm, key, chords };
}

// ─── Music Structure Analysis (SSM + Foote novelty) ─────────────────────────

function gaussianSmooth1D(data: Float32Array, sigma: number): Float32Array {
  const out = new Float32Array(data.length);
  const radius = Math.ceil(3 * sigma);
  const kernel: number[] = [];
  let kSum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    kSum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kSum;

  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < kernel.length; j++) {
      const idx = i + j - radius;
      if (idx >= 0 && idx < data.length) sum += data[idx] * kernel[j];
    }
    out[i] = sum;
  }
  return out;
}

async function detectSegments(mono: Float32Array, sampleRate: number): Promise<StructureSegment[]> {
  const ess = await getEssentia();

  // ~185ms per frame at 44100 Hz — coarse enough for structural analysis
  const hopSize = 8192;
  const totalDuration = mono.length / sampleRate;

  // Sections shorter than this are merged / ignored
  const minSegSecs = 10;
  const minSegFrames = Math.ceil((minSegSecs * sampleRate) / hopSize);

  // Cap at 10 min to keep the O(N²) SSM tractable
  const maxSamples = sampleRate * 600;
  const audio = mono.length > maxSamples ? mono.slice(0, maxSamples) : mono;

  const filtered = preprocessForTonal(audio, sampleRate);
  const signal = toVector(ess, filtered);

  try {
    const result = ess.TonalExtractor(signal, undefined, hopSize);
    const N: number = result.hpcp.size();

    if (N < minSegFrames * 2) {
      return [{ start: 0, end: totalDuration }];
    }

    // Extract and L2-normalise HPCP vectors (12 chroma bins per frame)
    const hpcp: Float32Array[] = [];
    for (let i = 0; i < N; i++) {
      const frame = result.hpcp.get(i);
      const dim: number = frame.size();
      const v = new Float32Array(dim);
      let sqSum = 0;
      for (let j = 0; j < dim; j++) {
        v[j] = frame.get(j);
        sqSum += v[j] * v[j];
      }
      const norm = Math.sqrt(sqSum) + 1e-8;
      for (let j = 0; j < dim; j++) v[j] /= norm;
      hpcp.push(v);
    }
    const dim = hpcp[0]?.length ?? 12;

    // Build cosine-similarity SSM (symmetric, N×N)
    const ssm = new Float32Array(N * N);
    for (let i = 0; i < N; i++) {
      ssm[i * N + i] = 1;
      for (let j = i + 1; j < N; j++) {
        let dot = 0;
        for (let k = 0; k < dim; k++) dot += hpcp[i][k] * hpcp[j][k];
        ssm[i * N + j] = dot;
        ssm[j * N + i] = dot;
      }
    }

    // Foote novelty — checkerboard kernel with half-size K
    const K = Math.min(minSegFrames, Math.floor(N / 4));
    const novelty = new Float32Array(N);
    for (let t = K; t < N - K; t++) {
      let score = 0;
      for (let di = 1; di <= K; di++) {
        for (let dj = 1; dj <= K; dj++) {
          const ip = t + di, im = t - di;
          const jp = t + dj, jm = t - dj;
          if (ip >= N || jp >= N) continue;
          score += ssm[ip * N + jp];
          score += ssm[im * N + jm];
          score -= ssm[ip * N + jm];
          score -= ssm[im * N + jp];
        }
      }
      novelty[t] = Math.max(0, score);
    }

    // Aggressive smoothing (σ ≈ minSegFrames/4) to suppress intra-section noise
    const sigma = Math.max(5, minSegFrames / 4);
    const smoothed = gaussianSmooth1D(novelty, sigma);

    // Only accept peaks well above the mean: mean + 1.5σ threshold
    let mean = 0, sq = 0, cnt = 0;
    for (let t = K; t < N - K; t++) { mean += smoothed[t]; sq += smoothed[t] ** 2; cnt++; }
    mean /= cnt;
    const std = Math.sqrt(Math.max(0, sq / cnt - mean ** 2));
    const threshold = mean + 1.5 * std;

    // Pick local maxima above threshold, enforcing minimum spacing
    const boundaryFrames: number[] = [0];
    let lastPeak = 0;
    for (let t = K + 1; t < N - K - 1; t++) {
      if (
        smoothed[t] >= threshold &&
        smoothed[t] > smoothed[t - 1] &&
        smoothed[t] > smoothed[t + 1] &&
        t - lastPeak >= minSegFrames
      ) {
        boundaryFrames.push(t);
        lastPeak = t;
      }
    }
    boundaryFrames.push(N);

    // Convert frame indices → seconds; drop segments shorter than half minSegSecs
    const hopSecs = hopSize / sampleRate;
    const segs: StructureSegment[] = [];
    for (let i = 0; i < boundaryFrames.length - 1; i++) {
      const start = boundaryFrames[i] * hopSecs;
      const end = i === boundaryFrames.length - 2
        ? totalDuration
        : boundaryFrames[i + 1] * hopSecs;
      if (end - start >= minSegSecs * 0.5) segs.push({ start, end });
    }

    // Safety cap: no more than 10 sections (keep only the strongest boundaries)
    if (segs.length > 10) {
      // Re-score each boundary by its novelty peak value and keep the top 9
      const scored = boundaryFrames
        .slice(1, -1)
        .map((f) => ({ frame: f, score: smoothed[f] }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 9)
        .map((x) => x.frame)
        .sort((a, b) => a - b);

      const trimmedBounds = [0, ...scored, N];
      const trimmed: StructureSegment[] = [];
      for (let i = 0; i < trimmedBounds.length - 1; i++) {
        const start = trimmedBounds[i] * hopSecs;
        const end = i === trimmedBounds.length - 2 ? totalDuration : trimmedBounds[i + 1] * hopSecs;
        trimmed.push({ start, end });
      }
      return trimmed;
    }

    return segs.length > 0 ? segs : [{ start: 0, end: totalDuration }];
  } finally {
    signal.delete();
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void (async () => {
    const data = event.data;
    try {
      if (data.type === 'warmup') {
        await getEssentia();
        const response: WorkerResponse = { id: data.id, type: 'ok' };
        self.postMessage(response);
        return;
      }

      if (data.type === 'analyze_structure') {
        const segments = await detectSegments(data.payload.mono, data.payload.sampleRate);
        const response: WorkerResponse = {
          id: data.id,
          type: 'structure_result',
          payload: { segments },
        };
        self.postMessage(response);
        return;
      }

      const result = await analyze(
        data.payload.mono,
        data.payload.sampleRate,
        data.payload.minHoldSeconds
      );

      const response: WorkerResponse = {
        id: data.id,
        type: 'result',
        payload: result,
      };
      self.postMessage(response);
    } catch (err) {
      const response: WorkerResponse = {
        id: data.id,
        type: 'error',
        error: err instanceof Error ? err.message : 'Unknown worker error',
      };
      self.postMessage(response);
    }
  })();
};
