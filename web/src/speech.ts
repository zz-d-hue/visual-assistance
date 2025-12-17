export function ensureSpeechReady() {
  try {
    const vs = window.speechSynthesis.getVoices();
    if (vs && vs.length > 0) {
      // noop
    }
    window.speechSynthesis.resume();
  } catch {}
}

export function speakText(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    const vs = window.speechSynthesis.getVoices();
    const zh = vs?.find((v) => v.lang?.toLowerCase?.().startsWith('zh'));
    if (zh) u.voice = zh;
    u.rate = 1;
    window.speechSynthesis.speak(u);
  } catch {}
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

