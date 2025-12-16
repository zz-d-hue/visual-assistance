import os
import json
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import requests

app = FastAPI()

DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY", "sk-411f9eafd8e44f7cb391db6eb116ecba")
DASHSCOPE_API_URL = os.environ.get(
    "DASHSCOPE_API_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
)
DASHSCOPE_API_MODEL = os.environ.get("DASHSCOPE_API_MODEL", "qwen3-vl-plus")

@app.post("/api/vision/detect")
async def detect(req: Request):
    try:
        body = await req.json()
        image = body.get("image")
        width = body.get("width")
        height = body.get("height")
        if not image or not width or not height:
            return JSONResponse({"error": "missing image/width/height"}, status_code=400)
        if not DASHSCOPE_API_KEY:
            return JSONResponse({"error": "DASHSCOPE_API_KEY not set"}, status_code=503)
        messages = [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "你是一名视觉识别助手。请对图像中的主要物体进行检测，返回中文标签和像素级边界框。仅输出 JSON。"
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f'请以如下 JSON 返回：{{"detections":[{{"label":"中文名称","bbox":[x,y,w,h],"score":0.0}}]}} 坐标单位为像素，基于画布尺寸 width={width}, height={height}。确保 bbox 在图像范围内，score 范围 0-1。'
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": image}
                    }
                ],
            },
        ]
        headers = {"Authorization": f"Bearer {DASHSCOPE_API_KEY}", "Content-Type": "application/json"}
        payload = {"model": DASHSCOPE_API_MODEL, "messages": messages, "temperature": 0.2, "response_format": {"type": "json_object"}}
        resp = requests.post(DASHSCOPE_API_URL, headers=headers, json=payload, timeout=60)
        if resp.status_code >= 400:
            return JSONResponse({"error": "upstream error", "detail": resp.text}, status_code=502)
        try:
            data = resp.json()
        except:
            return JSONResponse({"error": "upstream invalid json", "detail": resp.text}, status_code=502)
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        try:
            parsed = json.loads(content)
        except:
            parsed = {"detections": []}
        if not isinstance(parsed.get("detections"), list):
            parsed["detections"] = []
        outs = []
        for d in parsed["detections"]:
            bbox = d.get("bbox") if isinstance(d.get("bbox"), list) else [0, 0, 0, 0]
            x = max(0, min(int(width) - 1, int(bbox[0] if len(bbox) > 0 else 0)))
            y = max(0, min(int(height) - 1, int(bbox[1] if len(bbox) > 1 else 0)))
            w = max(0, min(int(width), int(bbox[2] if len(bbox) > 2 else 0)))
            h = max(0, min(int(height), int(bbox[3] if len(bbox) > 3 else 0)))
            score = d.get("score", 0.5)
            label = d.get("label", "物体")
            outs.append({"label": label, "bbox": [x, y, w, h], "score": score})
        return {"detections": outs}
    except:
        return JSONResponse({"error": "server error"}, status_code=500)

@app.get("/")
def root():
    return JSONResponse({"ok": True, "service": "visual-assistance-api", "endpoints": ["/api/vision/detect"]})

app.mount("/static", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
