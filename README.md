# TalkTrend OpenAI Agent Backend

Backend Node/Express para crear planes cinematográficos y generar videos MP4 usando OpenAI.

## Verificación

Este backend usa solo OpenAI:
- paquete npm: openai
- variable: OPENAI_API_KEY
- provider en respuestas: openai

No usa Gemini, no usa GEMINI_API_KEY y no usa @google/generative-ai.

## Local

npm install
cp .env.example .env
# Edita .env y agrega OPENAI_API_KEY
npm start

Abre:
http://localhost:8787/health

## Endpoints

GET /health
POST /api/agent
POST /api/video
GET /api/video/:id
GET /api/video/:id/content

## Deploy

1. Crea un servicio Node en Render/Railway/Fly/VPS.
2. Sube estos archivos.
3. Añade OPENAI_API_KEY como variable privada.
4. Start command: npm start
5. Pega la URL pública en la web de TalkTrend.
