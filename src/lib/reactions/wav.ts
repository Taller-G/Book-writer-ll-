// A dependency-free PCM WAV reader/writer. The acoustic reaction detector
// (dsp.ts) runs on decoded float samples; real mp3/m4a decoding would need
// ffmpeg (which may be absent — see the ingest gotcha), but WAV keeps the DSP
// and clip-extraction paths fully exercisable without any external binary.

export interface DecodedAudio {
  sampleRate: number;
  channels: number;
  /** Mono mix, one float per sample in [-1, 1]. */
  samples: Float32Array;
  /** Samples per channel (mono length). */
  frameCount: number;
}

function readFourCc(buf: Buffer, offset: number): string {
  return buf.toString("ascii", offset, offset + 4);
}

/** Parse a PCM WAV buffer (8/16/24/32-bit int, or 32-bit float). */
export function decodeWav(buffer: Buffer): DecodedAudio {
  if (buffer.length < 44 || readFourCc(buffer, 0) !== "RIFF" || readFourCc(buffer, 8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file.");
  }
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= buffer.length) {
    const id = readFourCc(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataStart = body;
      dataLen = Math.min(size, buffer.length - body);
    }
    // Chunks are word-aligned (pad byte when size is odd).
    offset = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error("WAV missing fmt or data chunk.");

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataLen / bytesPerSample);
  const frameCount = Math.floor(totalSamples / channels);
  const mono = new Float32Array(frameCount);

  const readOne = (pos: number): number => {
    if (audioFormat === 3) return buffer.readFloatLE(pos); // IEEE float
    switch (bitsPerSample) {
      case 8:
        return (buffer.readUInt8(pos) - 128) / 128; // 8-bit is unsigned
      case 16:
        return buffer.readInt16LE(pos) / 32768;
      case 24: {
        const b0 = buffer[pos], b1 = buffer[pos + 1], b2 = buffer[pos + 2];
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff; // sign-extend
        return v / 8388608;
      }
      case 32:
        return buffer.readInt32LE(pos) / 2147483648;
      default:
        throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
    }
  };

  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += readOne(dataStart + (i * channels + c) * bytesPerSample);
    }
    mono[i] = acc / channels;
  }
  return { sampleRate, channels, samples: mono, frameCount };
}

/** Encode mono float samples as a 16-bit PCM WAV buffer. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audioFormat = PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** Cut a [startMs, endMs) clip out of decoded audio as a fresh WAV buffer. */
export function sliceClipWav(audio: DecodedAudio, startMs: number, endMs: number): Buffer {
  const from = Math.max(0, Math.floor((startMs / 1000) * audio.sampleRate));
  const to = Math.min(audio.frameCount, Math.ceil((endMs / 1000) * audio.sampleRate));
  const slice = audio.samples.slice(from, Math.max(from, to));
  return encodeWav(slice, audio.sampleRate);
}
