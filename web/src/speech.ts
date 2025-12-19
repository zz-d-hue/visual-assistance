interface QueueItem {
  text: string;
  voice: string;
}

const queue: QueueItem[] = [];
let isProcessing = false;
let audioUnlocked = false;
let audioCtx: AudioContext | null = null;

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
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) {
      audioCtx = new AC();
    }
    const ctx = audioCtx;
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

export async function stopAndTranscribe(rec: MediaRecorder): Promise<string> {
  const chunks: BlobPart[] = [];
  return new Promise((resolve) => {
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const buf = await blob.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: b64 })
      });
      if (!r.ok) return resolve('');
      const j = await r.json().catch(() => ({} as any));
      resolve(j.text || '');
    };
    rec.stop();
  });
}
