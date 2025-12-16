# visual_assistance

## 启动后台

确保已安装依赖并设置环境变量：

```bash
pip3 install fastapi uvicorn requests
export OPENAI_API_KEY="你的key"
```

启动服务（方式一，直接运行 Python 脚本）：

```bash
python3 server.py
```

或使用 Uvicorn（方式二，推荐开发时热重载）：

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

启动后访问：

```
http://localhost:8000/
```
