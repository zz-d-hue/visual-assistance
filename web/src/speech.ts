interface QueueItem {
  text: string;
  voice: string;
}

const queue: QueueItem[] = [];
let isProcessing = false;

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
        const fmt = (j.format as string) || 'mp3';
        const a = new Audio(`data:audio/${fmt};base64,${b64}`);
        await new Promise<void>((resolve) => {
          a.onended = () => resolve();
          a.onerror = () => resolve();
          a.play().catch(() => resolve());
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
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 100);
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
