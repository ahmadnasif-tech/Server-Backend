# CAZPER Analyzer Backend

Local backend for the CAZPER TikTok Analyzer.

## Requirements
- Node.js 18+ (Node 20+ recommended)

## Start
```bash
npm start
```
The API listens on:
`http://127.0.0.1:8787`

Health check:
`http://127.0.0.1:8787/health`

The extension will try this backend first and automatically fall back to its existing direct analyzer if the backend is not running.

## Endpoint
`POST /api/analyze`
```json
{"url":"https://www.tiktok.com/@user/video/123"}
```

The backend only returns fields that it can actually extract from the publicly accessible TikTok response/media. It does not fabricate region, source, shadow-ban, VQ or other unavailable values.
