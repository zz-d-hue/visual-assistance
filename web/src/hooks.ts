import { useEffect, useRef, useState } from 'react';
import {
  speakNav,
  speakNavAndWait,
  speakText,
  startRecord,
  stopAndRecognize,
  unlockAudio
} from './speech';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { COCO_CN, PH } from './constants';
import { drawOverlay } from './overlay';
export function useVoiceNavigation(voice: string) {
  const [navRecorder, setNavRecorder] = useState<MediaRecorder | null>(null);
  const [navActive, setNavActive] = useState(false);
  const [navWatchId, setNavWatchId] = useState<number | null>(null);

  function parsePolyline(polyline: string): { lat: number; lng: number }[] {
    if (!polyline) return [];
    const parts = polyline.split(';');
    const out: { lat: number; lng: number }[] = [];
    for (const p of parts) {
      const [lngStr, latStr] = p.split(',');
      const lng = Number(lngStr);
      const lat = Number(latStr);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        out.push({ lat, lng });
      }
    }
    return out;
  }

  function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
    const R = 6371000;
    const toRad = (v: number) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  async function handleNavClick() {
    unlockAudio();
    if (!navRecorder) {
      const rec = await startRecord();
      if (!rec) {
        speakText('无法获取麦克风权限');
        return;
      }
      rec.start();
      setNavRecorder(rec);
      speakText('正在录音，请说出想去的地点，然后再次点击语音导航按钮结束');
      return;
    }

    const rec = navRecorder;
    setNavRecorder(null);

    const text = await stopAndRecognize(rec);
    console.log('导航目的地：', text);
    if (!text) {
      speakText('没有识别到目的地');
      return;
    }

    if (!navigator.geolocation) {
      speakText('当前设备不支持定位');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        try {
          const r = await fetch('/api/nav/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, keyword: text })
          });
          if (!r.ok) {
            let msg = '没有找到合适的路线';
            try {
              const err = await r.json();
              if (r.status === 404 || err?.error === 'no destination found') {
                msg = '没有找到相关地点，请换个说法再试一次';
              }
            } catch {}
            speakText(msg);
            return;
          }
          const j = await r.json();
          const destName = (j.destination && j.destination.name) || text;
          const steps = j.steps || [];
          const first = steps[0];
          let msg = `已为你规划到${destName}的步行路线。`;
          if (first && first.instruction) {
            msg += `第一步，${first.instruction}`;
          }

          const destLoc = j.destination && j.destination.location;
          const destLat = destLoc ? destLoc.lat : null;
          const destLng = destLoc ? destLoc.lng : null;

          setNavActive(true);

          if (destLat == null || destLng == null) {
            try {
              await speakNavAndWait(msg, voice);
            } finally {
              setNavActive(false);
            }
            return;
          }

          const stepPoints = (steps as any[]).map((s) =>
            parsePolyline((s && (s as any).polyline) || '')
          );
          let currentStep = 0;
          let finished = false;
          const threshold = 25;

          await speakNavAndWait(msg, voice);

          const watchId = navigator.geolocation.watchPosition(
            (p) => {
              if (finished) return;
              const clat = p.coords.latitude;
              const clng = p.coords.longitude;

              if (currentStep < stepPoints.length) {
                const pts = stepPoints[currentStep];
                const target =
                  pts.length > 0 ? pts[pts.length - 1] : { lat: destLat, lng: destLng };
                const d = haversineDistance(clat, clng, target.lat, target.lng);
                if (d <= threshold) {
                  currentStep += 1;
                  if (currentStep < steps.length) {
                    const next = steps[currentStep] as any;
                    const ins = next && next.instruction;
                    if (ins) {
                      speakNav(`接下来，${ins}`, voice);
                    }
                  }
                }
              } else {
                const dEnd = haversineDistance(clat, clng, destLat, destLng);
                if (dEnd <= threshold) {
                  finished = true;
                  speakNav(`已到达${destName}`, voice);
                  if (navWatchId !== null) {
                    navigator.geolocation.clearWatch(navWatchId);
                  }
                  navigator.geolocation.clearWatch(watchId);
                  setNavWatchId(null);
                  setNavActive(false);
                }
              }
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
          );
          setNavWatchId(watchId);
        } catch {
          speakText('无法获取导航路线');
        }
      },
      () => {
        speakText('无法获取当前位置');
      }
    );
  }

  return { navRecorder, navActive, navWatchId, handleNavClick };
}

export function useVisionDetection(navActive: boolean, voice: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<cocoSsd.ObjectDetection | null>(null);
  const rafRef = useRef<number | null>(null);
  const spokenMapRef = useRef<Map<string, number>>(new Map());
  const lastImageRef = useRef<string | null>(null);
  const lastMsRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);
  const lastDetsRef = useRef<Det[]>([]);

  const fovDeg = 60;

  const [running, setRunning] = useState(false);
  const [speakOn, setSpeakOn] = useState(true);
  const [fps, setFps] = useState(2);
  const [mode, setMode] = useState<'local' | 'server' | 'parallel'>('server');
  const [status, setStatus] = useState('未开始');
  const [snapshotMode, setSnapshotMode] = useState(false);

  useEffect(() => {
    captureCanvasRef.current = document.createElement('canvas');
    return () => {
      stop();
    };
  }, []);

  function speakDetections(dets: Det[], source: 'server' | 'local' | 'merged') {
    if (navActive) return;
    if (!speakOn) return;
    if (mode === 'server' && source !== 'server') return;

    const now = performance.now();
    const sentences: string[] = [];

    for (const d of dets) {
      if ((d.score ?? 0) < 0.3) continue;
      const canvas = canvasRef.current;
      if (!canvas) continue;

      const w = canvas.width;
      const h = canvas.height;
      const [x, _y, bw, bh] = d.bbox;
      const cx = x + bw / 2;

      const f = (0.5 * h) / Math.tan((fovDeg * Math.PI) / 360);
      const ang = Math.atan((cx - w / 2) / f) * (180 / Math.PI);

      const cls = (d.label || d.class || '物体').toLowerCase();
      const rh = PH[cls];
      const meters = rh ? Math.max(0.2, Math.min(50, (rh * f) / Math.max(1, bh))) : NaN;

      let dir = '正前方';
      if (ang <= -10) dir = '左前方';
      else if (ang >= 10) dir = '右前方';

      let speak = '';
      const pos = (d as any).position as string | undefined;
      const dist = (d as any).distance_m as number | undefined;
      const moving = !!(d as any).moving;
      if (pos && typeof dist === 'number') {
        if (moving && dist <= 10 && pos === '正前方')
          speak = `${pos}移动物体约${Math.round(dist * 10) / 10}米 ${cls}`;
        else if (moving && dist <= 2 && pos !== '正前方')
          speak = `${pos}移动物体约${Math.round(dist * 10) / 10}米 ${cls}`;
        else if (pos === '正前方' && dist <= 10)
          speak = `${pos}约${Math.round(dist * 10) / 10}米 ${cls}`;
        else if (pos !== '正前方' && dist <= 2)
          speak = `${pos}约${Math.round(dist * 10) / 10}米 ${cls}`;
      } else {
        if (!Number.isNaN(meters)) {
          const m = Math.round(meters * 10) / 10;
          if (dir === '正前方' && m <= 10) speak = `${dir}约${m}米 ${cls}`;
          else if (dir !== '正前方' && m <= 2) speak = `${dir}约${m}米 ${cls}`;
        } else {
          const ratio = bh / h;
          if (dir === '正前方' && ratio >= 0.15) speak = `${dir}近距离 ${cls}`;
          else if (dir !== '正前方' && ratio >= 0.3) speak = `${dir}近距离 ${cls}`;
        }
      }
      if (!speak) continue;

      const key = speak;
      const last = spokenMapRef.current.get(key) || 0;
      const shouldSpeak = moving || last === 0 || now - last > 4000;
      if (shouldSpeak) {
        sentences.push(speak);
        if (!moving) {
          spokenMapRef.current.set(key, now);
        }
      }
    }

    if (sentences.length > 0) {
      const merged = sentences.join('，');
      speakText(merged, voice);
    }
  }

  async function detectServer(): Promise<Det[]> {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const captureCanvas = captureCanvasRef.current;
    const captureCtx = captureCanvas?.getContext('2d');
    if (!video || !canvas || !captureCanvas || !captureCtx) return [];

    captureCtx.filter = 'none';
    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);

    const resp = await fetch('/api/vision/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: dataUrl,
        prev_image: lastImageRef.current,
        width: canvas.width,
        height: canvas.height
      })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || 'server error');
    }
    const json = await resp.json();
    lastImageRef.current = dataUrl;
    return (json.detections ?? []) as Det[];
  }

  async function tickOnce() {
    const video = videoRef.current;
    if (!video) return;

    const doServer = async () => {
      try {
        setStatus('服务端识别中');
        const res = await detectServer();
        setStatus(`服务端识别成功（${res.length}）`);
        return res;
      } catch {
        return [];
      }
    };

    const doLocal = async () => {
      try {
        if (!modelRef.current) {
          modelRef.current = await cocoSsd.load();
        }
        setStatus('本地模型识别中');
        const rawRes = await modelRef.current.detect(video);
        const res: Det[] = rawRes.map((d) => {
          const det = d as unknown as Det;
          if (det.class && COCO_CN[det.class]) {
            det.label = COCO_CN[det.class];
          }
          return det;
        });
        setStatus(`本地识别成功（${res.length}）`);
        return res;
      } catch {
        return [];
      }
    };

    let dets: Det[] = [];
    let source: 'server' | 'local' | 'merged' = 'local';

    if (mode === 'parallel') {
      const [sDets, lDets] = await Promise.all([doServer(), doLocal()]);
      const key = (d: Det) => `${d.label || d.class || '物体'}@${(d.bbox || []).join(',')}`;
      const map = new Map<string, Det>();
      for (const d of [...sDets, ...lDets]) map.set(key(d), d);
      dets = Array.from(map.values());
      source = 'merged';
    } else if (mode === 'server') {
      dets = await doServer();
      source = 'server';
      if (dets.length === 0) {
        const lDets = await doLocal();
        if (lDets.length > 0) {
          dets = lDets;
          source = 'local';
        } else {
          setStatus('识别失败');
        }
      }
    } else {
      dets = await doLocal();
      source = 'local';
      if (dets.length === 0) {
        const sDets = await doServer();
        if (sDets.length > 0) {
          dets = sDets;
          source = 'server';
        } else {
          setStatus('识别失败');
        }
      }
    }

    lastDetsRef.current = dets;
    if (!runningRef.current) return;
    const canvas = canvasRef.current;
    if (canvas) {
      drawOverlay(canvas, dets);
    }
    speakDetections(dets, source);
  }

  async function drawFrame() {
    if (!runningRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!video || !canvas || !captureCanvas) return;

    drawOverlay(canvasRef.current, lastDetsRef.current);
  }

  async function loop() {
    if (!runningRef.current) return;
    const now = performance.now();
    const interval = Math.max(125, Math.floor(1000 / Number(fps)));
    if (now - lastMsRef.current >= interval) {
      lastMsRef.current = now;
      await tickOnce();
    }
    await drawFrame();
    rafRef.current = requestAnimationFrame(loop);
  }

  async function start() {
    setSnapshotMode(false);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (!window.isSecureContext) {
      alert('当前为非安全上下文，摄像头被阻止。请使用 https 或 localhost。');
      return;
    }
    setRunning(true);

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
      }

      const video = videoRef.current!;
      video.srcObject = stream;
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });
      try {
        await video.play();
      } catch {}

      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      const canvas = canvasRef.current!;
      const captureCanvas = captureCanvasRef.current!;
      canvas.width = w;
      canvas.height = h;
      captureCanvas.width = w;
      captureCanvas.height = h;

      runningRef.current = true;
      setStatus('已启动');

      try {
        unlockAudio();
        speakText('识别已启动');
      } catch {}

      await tickOnce();
      loop();
    } catch (e: any) {
      alert(`无法启动摄像头：${e?.name || ''} ${e?.message || ''}`);
    }
  }

  function stop() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas && runningRef.current) {
      try {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          if (video.videoWidth && video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          drawOverlay(canvasRef.current, lastDetsRef.current, true);
        }
      } catch {}
    }

    setRunning(false);
    runningRef.current = false;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const tracks = video?.srcObject ? (video!.srcObject as MediaStream).getTracks() : [];
    tracks.forEach((t) => t.stop());
    if (video) video.srcObject = null;

    setSnapshotMode(true);
  }

  function handleFpsChange(v: any) {
    setFps(Number(v));
  }

  function handleModeChange(e: any) {
    setMode(e.target.value);
  }

  return {
    videoRef,
    canvasRef,
    running,
    start,
    stop,
    status,
    snapshotMode,
    speakOn,
    setSpeakOn,
    fps,
    mode,
    handleFpsChange,
    handleModeChange
  };
}
