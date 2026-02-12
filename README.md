# OpenClaw WeCom Callback

企业微信回调服务，用环境变量配置敏感参数（参见 `.env.example`）。

## 配置
1) 复制 `.env.example` 为 `.env` 并填写：
```
WECOM_TOKEN=
WECOM_AES_KEY=
WECOM_CORP_ID=
WECOM_AGENT_SECRET=
WECOM_AGENT_ID=1000011
GATEWAY_TOKEN=
PORT=9000
```
2) 安装依赖、启动：
```
npm install --production
npm start
```
服务监听 127.0.0.1:9000。

## 功能
- 企业微信回调校验（GET echostr）
- 文本/图片/语音消息解密，转发到 OpenClaw，异步通过企业微信 `message/send` 推送助手回复
- 兜底即时响应“已收到，稍后回复”满足企业微信 5 秒要求

## 部署
- 回调 URL 示例：`https://<your-domain>/wecom/callback`
- Nginx 反代至 127.0.0.1:9000，HTTPS 证书自行配置

## 开发
- 代码位置：`src/`
- 会话存储：`data/sessions.json`（按 FromUserName 建立会话）
- 媒体下载：`tmp/` 目录
- 日志查看：`journalctl -u openclawwework -f`
