import { uploadToOss } from './upload';

interface QueueItem {
  text: string;
  voice: string;
}

const queue: QueueItem[] = [];
let isProcessing = false;
let audioUnlocked = false;
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) {
      audioCtx = new AC();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const samples = channelData.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  let offset = 0;
  const writeString = (str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
    offset += str.length;
  };

  writeString('RIFF');
  view.setUint32(offset, 36 + dataSize, true);
  offset += 4;
  writeString('WAVE');
  writeString('fmt ');
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, numChannels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true);
  offset += 2;
  writeString('data');
  view.setUint32(offset, dataSize, true);

  let idx = 44;
  for (let i = 0; i < samples; i++) {
    let sample = channelData[i];
    if (sample < -1) sample = -1;
    if (sample > 1) sample = 1;
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(idx, intSample, true);
    idx += bytesPerSample;
  }

  return arrayBuffer;
}

async function convertToWavBlob(blob: Blob): Promise<Blob> {
  const ctx = getAudioContext();
  if (!ctx) throw new Error('audio context not available');
  const ab = await blob.arrayBuffer();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(ab.slice(0));
  } catch (e) {
    throw e instanceof Error ? e : new Error('decode audio failed');
  }
  const wavBuffer = encodeWav(audioBuffer);
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

export async function speakText(text: string, voice: string = 'female_warm') {
  queue.push({ text, voice });
  processQueue();
}

async function processQueue() {
  if (isProcessing) return;
  if (queue.length === 0) return;

  isProcessing = true;
  const item = queue.shift();
  if (!item) {
    isProcessing = false;
    return;
  }

  if (!audioUnlocked) {
    queue.unshift(item);
    isProcessing = false;
    return;
  }

  try {
    const r = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.text, voice: item.voice })
    });
    if (r.ok) {
      const j = await r.json();
      const b64 = j.audio_base64;
      if (b64) {
        const ctx = audioCtx;
        if (!ctx) return;

        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

        let audioBuffer: AudioBuffer | null = null;
        try {
          audioBuffer = await ctx.decodeAudioData(buf.slice(0));
        } catch {
          audioBuffer = null;
        }
        if (!audioBuffer) return;

        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(ctx.destination);
          src.onended = () => {
            try {
              src.disconnect();
            } catch {}
            resolve();
          };
          try {
            src.start(0);
          } catch {
            try {
              src.disconnect();
            } catch {}
            resolve();
          }
        });
      }
    }
  } catch (e) {
    console.error('TTS error:', e);
  } finally {
    isProcessing = false;
    if (queue.length > 0) {
      processQueue();
    }
  }
}

export function unlockAudio() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      (ctx as any).resume?.();
    } catch {}
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        try {
          osc.stop();
        } catch {}
        try {
          osc.disconnect();
        } catch {}
        try {
          gain.disconnect();
        } catch {}
      }, 50);
    } catch {}
    audioUnlocked = true;
  } catch {}
}

export async function startRecord(): Promise<MediaRecorder | null> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(s, { mimeType: 'audio/webm' });
    return rec;
  } catch {
    return null;
  }
}

interface CreateVoiceResult {
  voiceId: string;
  status: string;
}

export async function stopAndCreateVoice(rec: MediaRecorder): Promise<CreateVoiceResult | null> {
  const chunks: BlobPart[] = [];
  return new Promise((resolve) => {
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const wavBlob = await convertToWavBlob(blob);
        const audioUrl = await uploadToOss(wavBlob);
        const r = await fetch('/api/voice/custom/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_url: audioUrl })
        });
        if (!r.ok) {
          resolve(null);
          return;
        }
        const j = await r.json().catch(() => ({} as any));
        const voiceId = j.voice_id || '';
        const status = j.status || '';
        if (!voiceId) {
          resolve(null);
          return;
        }
        resolve({ voiceId, status });
      } catch {
        resolve(null);
      }
    };
    rec.stop();
  });
}
