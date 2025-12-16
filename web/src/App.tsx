import { useEffect, useRef, useState } from 'react';
import { Button, Switch, Select, Radio, Space, Badge } from 'antd';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';

type Det = {
  bbox: [number, number, number, number];
  label?: string;
  class?: string;
  score?: number;
};

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<cocoSsd.ObjectDetection | null>(null);
  const rafRef = useRef<number | null>(null);
  const spokenMapRef = useRef<Map<string, number>>(new Map());
  const lastMsRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);

  const [running, setRunning] = useState(false);
  const [speakOn, setSpeakOn] = useState(true);
  const [fps, setFps] = useState(2);
  const [mode, setMode] = useState<'local' | 'server' | 'parallel'>('server');
  const [status, setStatus] = useState('未开始');
  const [lastDets, setLastDets] = useState<Det[]>([]);

  useEffect(() => {
    const c = document.createElement('canvas');
    captureCanvasRef.current = c;
    return () => {
      stop();
    };
  }, []);

  function drawOverlay(dets: Det[]) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    const labels = new Set<string>();
    for (const det of dets) {
      const [x, y, w, h] = det.bbox;
      const label = det.label || det.class || '物体';
      labels.add(label);
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.9)';
      ctx.fillStyle = 'rgba(0, 200, 255, 0.18)';
      ctx.strokeRect(x, y, w, h);
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x, y - 28, ctx.measureText(label).width + 16, 24);
      ctx.fillStyle = '#00e0ff';
      ctx.font = '18px system-ui';
      ctx.fillText(label, x + 8, y - 10);
    }
    const text = `识别：${dets.length} · ${Array.from(labels).join('、')}`;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    const tw = ctx.measureText(text).width + 16;
    ctx.fillRect(8, 8, tw, 26);
    ctx.fillStyle = '#00e0ff';
    ctx.font = '16px system-ui';
    ctx.fillText(text, 16, 26);
  }

  function speakDetections(dets: Det[], source: 'server' | 'local' | 'merged') {
    if (!speakOn) return;
    if (mode === 'server' && source !== 'server') return;
    const now = performance.now();
    const labels = new Set<string>();
    for (const d of dets) {
      if ((d.score ?? 0) < 0.3) continue;
      const label = d.label || d.class || '物体';
      labels.add(label);
    }
    for (const label of labels) {
      const last = spokenMapRef.current.get(label) || 0;
      if (now - last > 4000) {
        const u = new SpeechSynthesisUtterance(label);
        u.lang = 'zh-CN';
        u.rate = 1;
        window.speechSynthesis.speak(u);
        spokenMapRef.current.set(label, now);
      }
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
        width: canvas.width,
        height: canvas.height
      })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || 'server error');
    }
    const json = await resp.json();
    return (json.detections ?? []) as Det[];
  }

  async function tickOnce() {
    const video = videoRef.current;
    if (!video) return;
    let dets: Det[] = [];
    if (mode === 'parallel') {
      let serverDets: Det[] = [];
      let localDets: Det[] = [];
      try {
        setStatus('服务端识别中');
        serverDets = await detectServer();
        setStatus(`服务端识别成功（${serverDets.length}）`);
      } catch {
        serverDets = [];
      }
      try {
        if (!modelRef.current) {
          modelRef.current = await cocoSsd.load();
        }
        setStatus('本地模型识别中');
        localDets = await modelRef.current.detect(video);
        setStatus(`本地识别成功（${localDets.length}）`);
      } catch {
        localDets = [];
      }
      const key = (d: Det) => `${d.label || d.class || '物体'}@${(d.bbox || []).join(',')}`;
      const map = new Map<string, Det>();
      for (const d of [...serverDets, ...localDets]) map.set(key(d), d);
      dets = Array.from(map.values());
      setLastDets(dets);
      speakDetections(dets, 'merged');
      return;
    }
    if (mode === 'server') {
      try {
        setStatus('服务端识别中');
        dets = await detectServer();
        setStatus(`服务端识别成功（${dets.length}）`);
        setLastDets(dets);
        speakDetections(dets, 'server');
        return;
      } catch {}
      try {
        if (!modelRef.current) modelRef.current = await cocoSsd.load();
        setStatus('本地模型识别中');
        dets = await modelRef.current.detect(video);
        setStatus(`本地识别成功（${dets.length}）`);
      } catch {
        setStatus('识别失败');
        dets = [];
      }
      setLastDets(dets);
      speakDetections(dets, 'local');
      return;
    }
    try {
      if (!modelRef.current) modelRef.current = await cocoSsd.load();
      setStatus('本地模型识别中');
      dets = await modelRef.current.detect(video);
      setStatus(`本地识别成功（${dets.length}）`);
      setLastDets(dets);
      speakDetections(dets, 'local');
      return;
    } catch {}
    try {
      setStatus('服务端识别中');
      dets = await detectServer();
      setStatus(`服务端识别成功（${dets.length}）`);
    } catch {
      setStatus('识别失败');
      dets = [];
    }
    setLastDets(dets);
    speakDetections(dets, 'server');
  }

  async function drawFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!video || !canvas || !captureCanvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const info = `video rs=${video.readyState} ${video.videoWidth}x${video.videoHeight}`;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const tw = ctx.measureText(info).width + 16;
    ctx.fillRect(canvas.width - tw - 8, 8, tw, 22);
    ctx.fillStyle = '#ccc';
    ctx.font = '14px system-ui';
    ctx.fillText(info, canvas.width - tw, 24);
    drawOverlay(lastDets || []);
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
    if (!window.isSecureContext) {
      alert('当前为非安全上下文，摄像头被阻止。请使用 https 或 localhost。');
      return;
    }
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          },
          audio: false
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
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
      setRunning(true);
      runningRef.current = true;
      setStatus('已启动');
      try {
        const u = new SpeechSynthesisUtterance('识别已启动');
        u.lang = 'zh-CN';
        u.rate = 1;
        window.speechSynthesis.speak(u);
      } catch {}
      await tickOnce();
      loop();
    } catch (e: any) {
      alert(`无法启动摄像头：${e?.name || ''} ${e?.message || ''}`);
    }
  }

  function stop() {
    setRunning(false);
    runningRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const video = videoRef.current;
    const tracks = video?.srcObject ? (video!.srcObject as MediaStream).getTracks() : [];
    tracks.forEach((t) => t.stop());
    if (video) video.srcObject = null;
  }

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <div className="border-b border-neutral-200 px-4 py-3">
        <Space wrap>
          <Button type="primary" onClick={start} disabled={running}>
            开始识别
          </Button>
          <Button onClick={stop} disabled={!running}>
            停止识别
          </Button>
          <Space>
            <span>语音播报</span>
            <Switch checked={speakOn} onChange={setSpeakOn} />
          </Space>
          <Space>
            <span>识别频率</span>
            <Select
              value={fps}
              onChange={(v) => setFps(Number(v))}
              options={[
                { value: 2, label: '每秒2次' },
                { value: 4, label: '每秒4次' },
                { value: 8, label: '每秒8次' }
              ]}
              style={{ width: 120 }}
            />
          </Space>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={[
              { label: '本地优先', value: 'local' },
              { label: '服务端优先', value: 'server' },
              { label: '并行识别', value: 'parallel' }
            ]}
            optionType="button"
            buttonStyle="solid"
          />
        </Space>
      </div>
      <div className="grid place-items-center p-4">
        <div className="relative w-[92vw] max-w-[1200px]">
          <video ref={videoRef} className="w-full h-auto block" playsInline autoPlay muted />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full bg-transparent rounded-lg"
          />
        </div>
      </div>
      <div className="fixed bottom-2 right-2 text-sm text-neutral-600">
        <Badge status="processing" text={`状态：${status} · 服务端大模型识别 · React 前端`} />
      </div>
    </div>
  );
}
