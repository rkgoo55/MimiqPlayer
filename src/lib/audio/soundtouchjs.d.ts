declare module 'soundtouchjs' {
  export class PitchShifter {
    constructor(
      context: AudioContext,
      buffer: AudioBuffer,
      bufferSize: number,
      onEnd?: () => void,
    );
    /** Current playback position in seconds */
    readonly timePlayed: number;
    /** Current playback position as a percentage (0–100) */
    percentagePlayed: number;
    /** Playback tempo multiplier (1.0 = original speed, pitch-preserving) */
    set tempo(value: number);
    /** Pitch multiplier (1.0 = original pitch) */
    set pitch(value: number);
    /** Pitch shift in semitones */
    set pitchSemitones(value: number);
    /** The underlying ScriptProcessorNode */
    readonly node: ScriptProcessorNode;
    connect(destination: AudioNode): void;
    disconnect(): void;
    on(eventName: string, cb: (detail: unknown) => void): void;
    off(eventName?: string): void;
  }
}
