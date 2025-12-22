import os
import json
import base64
import time
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import requests
import dashscope
import tempfile
from openai import OpenAI
from dashscope.audio.tts_v2 import VoiceEnrollmentService, SpeechSynthesizer

app = FastAPI()

DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")
# Use qwen-vl-max for better speed/quality as requested (user asked for qwen-plus but that is text-only)
DASHSCOPE_API_MODEL = os.environ.get("DASHSCOPE_API_MODEL", "qwen3-vl-flash")
DASHSCOPE_ASR_MODEL = os.environ.get("DASHSCOPE_ASR_MODEL", "qwen3-asr-flash")
DASHSCOPE_TTS_MODEL = os.environ.get("DASHSCOPE_TTS_MODEL", "qwen3-tts-flash")
DASHSCOPE_COSY_TTS_MODEL = os.environ.get("DASHSCOPE_COSY_TTS_MODEL", "cosyvoice-v3-flash")

if DASHSCOPE_API_KEY:
    dashscope.api_key = DASHSCOPE_API_KEY

@app.post("/api/vision/detect")
async def detect(req: Request):
    try:
        body = await req.json()
        image = body.get("image")
        prev_image = body.get("prev_image")
        width = body.get("width")
        height = body.get("height")
        if not image or not width or not height:
            return JSONResponse({"error": "missing image/width/height"}, status_code=400)
        if not DASHSCOPE_API_KEY:
            return JSONResponse({"error": "DASHSCOPE_API_KEY not set"}, status_code=503)

        client = OpenAI(
            api_key=DASHSCOPE_API_KEY,
            base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
        )

        messages = [
            {
                "role": "system",
                "content": "你是一名视觉识别助手，面向视力障碍用户。请基于输入画面返回结构化 JSON，直接可用于语音播报：仅输出 JSON，不要包含多余文本。"
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            f"画布尺寸为 width={width}, height={height}。"
                            "请检测主要物体并输出如下 JSON："
                            "{\"detections\":["
                            "{\"label\":\"中文名称\",\"bbox\":[x,y,w,h],\"score\":0.0,"
                            "\"position\":\"左前方|右前方|正前方\",\"distance_m\":0.0,"
                            "\"moving\":false,\"urgency\":\"高|中|低\",\"reason\":\"简短中文理由\"}"
                            "]}"
                            "要求：1) bbox=[x,y,w,h] 中：x,y 为该物体外接矩形左上角的像素坐标，w,h 为该矩形的宽和高（像素），矩形需尽量紧贴该物体轮廓，且必须完全落在画布范围内；"
                            "2) position 按水平角度粗分：x+bw/2 < 0.45*width 视为左前方，> 0.55*width 视为右前方，其他为正前方；"
                            "3) distance_m 若能估计则给出近似值，否则填 null；可依据目标在画面中的相对高度比 h/height 粗略估计；"
                            "4) 若同时提供上一帧图像，请比较两帧判断 moving（中心或尺寸显著变化视为 true）；"
                            "5) urgency 根据是否移动、是否在正前方、是否近距离综合给出；"
                            "仅输出 JSON。"
                        )
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": image}
                    }
                ],
            },
        ]
        if prev_image:
            messages[1]["content"].append({
                "type": "image_url",
                "image_url": {"url": prev_image}
            })

        completion = client.chat.completions.create(
            model=DASHSCOPE_API_MODEL,
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"}
        )
        # print(completion.model_dump_json(),'识别结果')

        content = completion.choices[0].message.content
        try:
            parsed = json.loads(content)
        except:
            parsed = {"detections": []}
        return parsed
    except Exception as e:
        return JSONResponse({"error": "server error", "detail": str(e)}, status_code=500)

@app.post("/api/voice/asr")
async def asr(req: Request):
    try:
        if not DASHSCOPE_API_KEY:
            return JSONResponse({"error": "DASHSCOPE_API_KEY not set"}, status_code=503)
        if dashscope is None:
            return JSONResponse({"error": "dashscope sdk not installed"}, status_code=503)
        body = await req.json()
        audio_b64 = body.get("audio_base64")
        if not audio_b64:
            return JSONResponse({"error": "missing audio_base64"}, status_code=400)

        try:
            raw = base64.b64decode(audio_b64)
        except Exception:
            return JSONResponse({"error": "invalid base64"}, status_code=400)

        # 将前端上传的音频临时落盘为本地文件，并以 file:// 形式供 SDK 读取
        # 由于前端使用 MediaRecorder('audio/webm')，这里默认保存为 .webm
        # 若你已切换前端为 wav，可改为 .wav
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        file_url = f"file://{tmp_path}"

        try:
            dashscope.base_http_api_url = 'https://dashscope.aliyuncs.com/api/v1'
            messages = [
                {"role": "system", "content": [{"text": ""}]},
                {"role": "user", "content": [{"audio": file_url}]},
            ]
            resp = dashscope.MultiModalConversation.call(
                api_key=DASHSCOPE_API_KEY,
                model=DASHSCOPE_ASR_MODEL,
                messages=messages,
                result_format="message",
                asr_options={
                    # 可按需开启 ITN（数字等正规化）
                    "enable_itn": False,
                },
            )
        except Exception as e:
            # 清理临时文件
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            return JSONResponse({"error": "asr upstream error", "detail": str(e)}, status_code=502)

        # 清理临时文件
        try:
            os.remove(tmp_path)
        except Exception:
            pass

        # 解析 SDK 返回的 message 格式，尽量稳健地抽取文本
        text = ""
        try:
            out = getattr(resp, "output", None)
            choices = getattr(out, "choices", None)
            if choices and isinstance(choices, list) and len(choices) > 0:
                msg = getattr(choices[0], "message", None)
                content = getattr(msg, "content", None)
                if isinstance(content, list) and len(content) > 0:
                    for item in content:
                        if isinstance(item, dict) and "text" in item:
                            text = item.get("text") or ""
                            if text:
                                break
                elif isinstance(content, str):
                    text = content
        except Exception:
            text = text or ""

        return {"text": text or ""}
    except:
        return JSONResponse({"error": "server error"}, status_code=500)

@app.post("/api/voice/tts")
async def tts(req: Request):
    try:
        if not DASHSCOPE_API_KEY:
            return JSONResponse({"error": "DASHSCOPE_API_KEY not set"}, status_code=503)
        if dashscope is None:
            return JSONResponse({"error": "dashscope sdk not installed"}, status_code=503)
        body = await req.json()
        text = body.get("text")
        raw_voice = body.get("voice", "female_warm")
        if not text:
            return JSONResponse({"error": "missing text"}, status_code=400)

        if isinstance(raw_voice, str) and raw_voice.startswith("cosyvoice-"):
            try:
                synthesizer = SpeechSynthesizer(model=DASHSCOPE_COSY_TTS_MODEL, voice=raw_voice)
                audio_bytes = synthesizer.call(text)
            except Exception as e:
                return JSONResponse({"error": "tts upstream error", "detail": str(e)}, status_code=502)
            audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
            return {"audio_base64": audio_b64, "format": "mp3"}

        voice_map = {
            "female_warm": "Cherry",
            "female_bright": "Sunny",
            "male_deep": "Ryan",
        }
        voice = voice_map.get(raw_voice, raw_voice)
        try:
            dashscope.base_http_api_url = 'https://dashscope.aliyuncs.com/api/v1'
            resp = dashscope.MultiModalConversation.call(
                model=DASHSCOPE_TTS_MODEL,
                api_key=DASHSCOPE_API_KEY,
                text=text,
                voice=voice,
                language_type="Chinese",
                stream=False,
            )
        except Exception as e:
            return JSONResponse({"error": "tts upstream error", "detail": str(e)}, status_code=502)
        audio_url = ""
        try:
            audio_url = getattr(getattr(resp, "output", None), "audio", None).url  # type: ignore
        except Exception:
            audio_url = ""
        if not audio_url:
            return JSONResponse({"error": "empty audio url"}, status_code=502)
        try:
            ar = requests.get(audio_url, timeout=60)
        except Exception as e:
            return JSONResponse({"error": "download audio failed", "detail": str(e)}, status_code=502)
        if ar.status_code >= 400:
            return JSONResponse({"error": "download audio failed", "detail": ar.text}, status_code=502)
        audio_b64 = base64.b64encode(ar.content).decode("ascii")
        return {"audio_base64": audio_b64, "format": "wav"}
    except:
        return JSONResponse({"error": "server error"}, status_code=500)


@app.post("/api/voice/custom/create")
async def create_custom_voice(req: Request):
    try:
        if not DASHSCOPE_API_KEY:
            return JSONResponse({"error": "DASHSCOPE_API_KEY not set"}, status_code=503)
        if dashscope is None:
            return JSONResponse({"error": "dashscope sdk not installed"}, status_code=503)
        body = await req.json()
        audio_url = body.get("audio_url")
        if not audio_url:
            return JSONResponse({"error": "missing audio_url"}, status_code=400)

        voice_id = ""
        status = ""
        try:
            service = VoiceEnrollmentService()
            voice_id = service.create_voice(
                target_model=DASHSCOPE_COSY_TTS_MODEL,
                prefix='myvoice',
                url=audio_url,
            )
            max_attempts = 30
            interval = 5
            for _ in range(max_attempts):
                info = service.query_voice(voice_id=voice_id)
                if isinstance(info, dict):
                    status = info.get("status") or ""
                    if not status:
                        output = info.get("output") or {}
                        if isinstance(output, dict):
                            status = output.get("status") or ""
                if status == "OK":
                    break
                time.sleep(interval)
        except Exception as e:
            return JSONResponse({"error": "voice enrollment error", "detail": str(e)}, status_code=502)
        return {"voice_id": voice_id, "status": status or "UNKNOWN"}
    except:
        return JSONResponse({"error": "server error"}, status_code=500)

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
