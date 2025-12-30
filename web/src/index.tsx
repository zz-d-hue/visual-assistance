import { useEffect, useRef, useState } from 'react';
import { Button, Switch, Select, Radio, Space, Badge } from 'antd';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
import { COCO_CN, PH } from './constants';
import { drawOverlay } from './overlay';
import {
  speakText,
  unlockAudio,
  startRecord,
  stopAndCreateVoice,
  speakNav,
  stopAndRecognize
} from './speech';

export default function App() {
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
  const [voice, setVoice] = useState<string>('female_warm');
  const [voiceOptions, setVoiceOptions] = useState<{ value: string; label: string }[]>([
    { value: 'female_warm', label: '温柔女声' },
    { value: 'Jada', label: '上海女声' },
    { value: 'Ethan', label: '沉稳男声' }
  ]);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [navRecorder, setNavRecorder] = useState<MediaRecorder | null>(null);
  const [customVoiceId, setCustomVoiceId] = useState<string>('');
  const [creatingVoice, setCreatingVoice] = useState(false);

  useEffect(() => {
    captureCanvasRef.current = document.createElement('canvas');
    return () => {
      stop();
    };
  }, []);

  function speakDetections(dets: Det[], source: 'server' | 'local' | 'merged') {
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

    // 辅助函数：执行服务端检测
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

    // 辅助函数：执行本地检测
    const doLocal = async () => {
      try {
        if (!modelRef.current) {
          modelRef.current = await cocoSsd.load();
        }
        setStatus('本地模型识别中');
        const rawRes = await modelRef.current.detect(video);
        // 将英文 class 转换为中文 label，并强制转换为 Det 类型
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
        // 如果服务端失败或无结果，尝试本地
        const lDets = await doLocal();
        if (lDets.length > 0) {
          dets = lDets;
          source = 'local';
        } else {
          setStatus('识别失败');
        }
      }
    } else {
      // local mode
      dets = await doLocal();
      source = 'local';
      if (dets.length === 0) {
        // 本地无结果，尝试服务端
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
    // 只有在运行时才持续绘制
    if (!runningRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!video || !canvas || !captureCanvas) return;

    // 移除了调试信息的绘制，只绘制检测框
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
    // 启动时清除 Canvas 上的任何残留内容（包括快照和标注）
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
    // 停止前先保留当前画面作为快照，并绘制标注
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas && runningRef.current) {
      try {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // 确保 Canvas 尺寸与视频真实尺寸一致
          if (video.videoWidth && video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          // 绘制视频当前帧到 canvas 作为背景
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          // 在背景之上绘制标注，不清除背景
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

    // 停止视频流
    const tracks = video?.srcObject ? (video!.srcObject as MediaStream).getTracks() : [];
    tracks.forEach((t) => t.stop());
    if (video) video.srcObject = null;

    setSnapshotMode(true);
  }

  return (
    <div className="w-screen h-screen bg-white text-neutral-900">
      {!running && (
        <div className="border-b border-neutral-200 px-4 py-3">
          <Space wrap>
            <Button type="primary" onClick={start} disabled={running}>
              开始识别
            </Button>
            <Button
              onClick={() => {
                unlockAudio();
                speakText('语音测试', voice);
              }}
            >
              测试语音
            </Button>
            <Space>
              <span>语音音色</span>
              <Select
                value={voice}
                onChange={(v) => setVoice(v as any)}
                options={voiceOptions}
                style={{ width: 140 }}
              />
            </Space>
            <Space>
              <span>语音播报</span>
              <Switch checked={speakOn} onChange={setSpeakOn} />
            </Space>
            <Space>
              <Button
                onClick={async () => {
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
                        let msg = `已为你规划到${destName}的路线。`;
                        if (first && first.instruction) {
                          msg += `第一步，${first.instruction}`;
                        }
                        speakNav(msg, voice);
                      } catch {
                        speakText('无法获取导航路线');
                      }
                    },
                    () => {
                      speakText('无法获取当前位置');
                    }
                  );
                }}
              >
                {navRecorder ? '停止并识别目的地' : '语音导航'}
              </Button>
            </Space>
            <Space>
              <Button
                disabled={!!recorder}
                onClick={async () => {
                  const rec = await startRecord();
                  if (rec) {
                    rec.start();
                    setRecorder(rec);
                    setCustomVoiceId('');
                  }
                }}
              >
                开始录音
              </Button>
              <Button
                disabled={!recorder}
                loading={creatingVoice}
                onClick={async () => {
                  const rec = recorder;
                  if (!rec) return;
                  setCreatingVoice(true);
                  const result = await stopAndCreateVoice(rec);
                  setRecorder(null);
                  setCreatingVoice(false);
                  if (!result || !result.voiceId) {
                    setCustomVoiceId('');
                    return;
                  }
                  const vid = result.voiceId;
                  const label = '自定义音色';
                  setVoiceOptions((prev) => {
                    if (prev.some((item) => item.value === vid)) return prev;
                    return [...prev, { value: vid, label }];
                  });
                  setVoice(vid);
                  setCustomVoiceId(vid);
                }}
              >
                停止并创建音色
              </Button>
              {customVoiceId ? <Badge count="已创建音色" /> : null}
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
      )}

      <div className="grid place-items-center p-4 relative w-full h-full">
        {running && (
          <Button onClick={stop} disabled={!running} className="absolute top-2 right-2 z-10">
            停止识别
          </Button>
        )}
        <div className="absolute top-0 left-0 w-full h-full">
          <video
            ref={videoRef}
            className={`w-full h-auto block ${snapshotMode || !running ? 'hidden' : ''}`}
            playsInline
            autoPlay
            muted
          />
          <canvas
            ref={canvasRef}
            className={
              snapshotMode || !running
                ? 'w-full h-auto block rounded-lg'
                : 'absolute inset-0 w-full h-full bg-transparent rounded-lg'
            }
          />
        </div>
      </div>

      <div className="fixed bottom-2 right-2 text-sm text-neutral-600">
        <Badge status="processing" text={`状态：${status} · 服务端大模型识别`} />
      </div>
    </div>
  );
}
