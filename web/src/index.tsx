import { useState } from 'react';
import { Button, Switch, Select, Radio, Space, Badge } from 'antd';
import '@tensorflow/tfjs';
import { speakText, unlockAudio, startRecord, stopAndCreateVoice } from './speech';
import { useVoiceNavigation, useVisionDetection } from './hooks';

export default function App() {
  const [voice, setVoice] = useState<string>('female_warm');
  const [voiceOptions, setVoiceOptions] = useState<{ value: string; label: string }[]>([
    { value: 'female_warm', label: '温柔女声' },
    { value: 'Jada', label: '上海女声' },
    { value: 'Ethan', label: '沉稳男声' }
  ]);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [customVoiceId, setCustomVoiceId] = useState<string>('');
  const [creatingVoice, setCreatingVoice] = useState(false);

  const { navRecorder, navActive, navLoading, handleNavClick } = useVoiceNavigation(voice);

  const {
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
  } = useVisionDetection(navActive, voice);

  function handleTestVoice() {
    unlockAudio();
    speakText('语音测试', voice);
  }

  async function handleStartCustomRecord() {
    const rec = await startRecord();
    if (rec) {
      rec.start();
      setRecorder(rec);
      setCustomVoiceId('');
    }
  }

  async function handleStopAndCreateVoice() {
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
  }

  return (
    <div className="w-screen h-screen bg-white text-neutral-900">
      {!running && (
        <div className="border-b border-neutral-200 px-4 py-3">
          <Space wrap>
            <Button type="primary" onClick={start} disabled={running}>
              开始识别
            </Button>
            <Button onClick={handleTestVoice}>测试语音</Button>
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
            <Button onClick={handleNavClick} loading={navLoading}>
              {navRecorder ? '停止并识别目的地' : '语音导航'}
            </Button>
            <Space>
              {!!recorder ? (
                <Button loading={creatingVoice} onClick={handleStopAndCreateVoice}>
                  结束录音
                </Button>
              ) : (
                <Button onClick={handleStartCustomRecord}>开始录音并创建音色</Button>
              )}

              {customVoiceId ? <Badge count="已创建音色" /> : null}
            </Space>
            <Space>
              <span>识别频率</span>
              <Select
                value={fps}
                onChange={handleFpsChange}
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
              onChange={handleModeChange}
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
