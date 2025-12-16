# visual_assistance

## 启动步骤

1. 启动后端（必需）

```bash
# 安装依赖
pip3 install fastapi uvicorn requests

# 配置通义千问兼容接口
export DASHSCOPE_API_KEY="你的通义千问Key"
export DASHSCOPE_API_URL="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
export DASHSCOPE_API_MODEL="qwen3-vl-plus"

# 启动后端
python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

2. 启动前端（React + TypeScript）

```bash
cd web
npm install
npm run dev
```

访问前端开发站点：

```
http://localhost:5173/
```

说明：

- 前端已配置代理：`/api` → `http://localhost:8000`（见 `web/vite.config.ts`）
- 后端必须运行，否则前端调用 `/api/vision/detect` 会报错
- Node 版本建议：Node 18+

常见问题：

- 若 `5173` 已占用，Vite 会自动切换端口（如 `5174`）。
- 若出现 `502`，查看浏览器控制台的接口返回文本，检查 `DASHSCOPE_API_*` 是否配置正确，以及图片负载是否可被兼容端点接受。
