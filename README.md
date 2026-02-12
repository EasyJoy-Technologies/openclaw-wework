# OpenClaw WeCom Callback

WeCom(企业微信) callback receiver for OpenClaw integration.

## Configure

Set env (or edit `src/config.js` defaults):
```
WECOM_TOKEN=2609a3ffd814f2f38bcb4156
WECOM_AES_KEY=qMDPRi4g7ki9snNWJFpkj1iMNsxGDHpBlt8EbLhWO4m
WECOM_CORP_ID=ww392ac7ac26269983
PORT=9000
```

## Run
```
npm install
npm start
```
Server listens on `127.0.0.1:9000`.

## WeCom settings
- Callback URL: `https://oc-ww.ej-mobile.cn/wecom/callback`
- Token / EncodingAESKey / CorpID: see above
- Encryption mode: 安全模式

## Behavior
- GET `/wecom/callback`: verify signature, decrypt `echostr` (if encrypted), echo back for WeCom validation.
- POST `/wecom/callback`: verify signature against `<Encrypt>`, decrypt message XML, log it, respond `success`.
- HEAD `/wecom/callback`: returns 200.

## Deploy
Nginx already proxies 443 → `127.0.0.1:9000` with Let’s Encrypt cert on `oc-ww.ej-mobile.cn`.
Replace the stub process with `npm start` using this app.
