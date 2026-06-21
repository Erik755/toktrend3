import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ffmpegPath = require('@ffmpeg-installer/ffmpeg');

dotenv.config();
const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------- Firebase ----------------
let db;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  } else {
    initializeApp({ projectId: 'toktrend-fdb4f' });
  }
  db = getFirestore();
  console.log('[Firebase] OK');
} catch (err) {
  console.error('[Firebase Error]', err.message);
}

// ---------------- App ----------------
const app = express();
const port = Number(process.env.PORT || 8787);
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

// ---------------- Memory Optimization ----------------
let isGenerating = false; // Control de concurrencia
const tempFiles = new Set(); // Registro de archivos temporales

// Limpieza automática de archivos temporales
function registerTempFile(filepath) {
  tempFiles.add(filepath);
}

function cleanupTempFile(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      tempFiles.delete(filepath);
      console.log(`[Cleanup] Eliminado: ${filepath}`);
    }
  } catch (err) {
    console.error(`[Cleanup] Error eliminando ${filepath}:`, err.message);
  }
}

function cleanupAllTempFiles() {
  if (isGenerating) {
    console.log('[Cleanup] Generacion activa; se pospone limpieza de temporales');
    return;
  }
  console.log(`[Cleanup] Limpiando ${tempFiles.size} archivos temporales...`);
  for (const file of tempFiles) {
    cleanupTempFile(file);
  }
}

// Monitoreo de memoria cada 30 segundos
setInterval(() => {
  const used = process.memoryUsage();
  const usedMB = Math.round(used.heapUsed / 1024 / 1024);
  const rssMB = Math.round(used.rss / 1024 / 1024);
  
  if (usedMB > 350 || rssMB > 450) {
    console.warn(`⚠️ Memoria alta: Heap ${usedMB}MB, RSS ${rssMB}MB - Limpiando...`);
    cleanupAllTempFiles();
    if (global.gc) {
      global.gc();
      console.log('[GC] Garbage collection ejecutado');
    }
  }
}, 30000);

// Limpieza al cerrar el proceso
process.on('SIGTERM', cleanupAllTempFiles);
process.on('SIGINT', cleanupAllTempFiles);

// ---------------- AI Config ----------------
function getAIConfig() {
  const apiKey = process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.TOGETHER_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_BASE_URL
    || (process.env.GROQ_API_KEY ? 'https://api.groq.com/openai/v1' : null)
    || (process.env.TOGETHER_API_KEY ? 'https://api.together.xyz/v1' : null)
    || undefined;
  const model = process.env.AGENT_MODEL
    || (process.env.GROQ_API_KEY ? 'llama-3.3-70b-versatile' : null)
    || (process.env.TOGETHER_API_KEY ? 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' : null)
    || 'gpt-4.1-mini';
  return { apiKey, baseURL, model };
}
const aiConfig = getAIConfig();
const openai = new OpenAI({ apiKey: aiConfig.apiKey || 'missing-ai-key', baseURL: aiConfig.baseURL });

const ttsClient = process.env.TTS_API_KEY || process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.TTS_API_KEY || process.env.OPENAI_API_KEY })
  : null;

const ABACUS_API_KEY = process.env.ABACUS_API_KEY || '';
const ABACUS_IMAGE_API_URL = process.env.ABACUS_IMAGE_API_URL || '';
const ABACUS_VIDEO_API_URL = process.env.ABACUS_VIDEO_API_URL || '';
const ABACUS_AUDIO_API_URL = process.env.ABACUS_AUDIO_API_URL || '';

// ---------------- Stock media (clips/imágenes reales) ----------------
// Pexels y Pixabay ofrecen API gratuita (solo requiere registrarse y pedir una key).
// Si se configuran, la app usa CLIPS DE VIDEO CINEMATOGRÁFICOS REALES.
// Sin ninguna key, usa imágenes reales de Openverse/Wikimedia (sin key) con movimiento Ken Burns.
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || '';
const STOCK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ---------------- Generación de imágenes por IA (cinematográficas) ----------------
// Pollinations.ai genera imágenes por IA (modelo Flux) GRATIS y SIN API KEY vía URL.
// Es la fuente PRINCIPAL: cada escena del guion se convierte en una imagen cinematográfica
// generada por IA (estilo DALL·E / Stable Diffusion). Si falla, se recurre a imágenes reales.
const AI_IMAGES_ENABLED = String(process.env.AI_IMAGES_ENABLED || 'true').toLowerCase() !== 'false';
const POLLINATIONS_MODEL = process.env.POLLINATIONS_MODEL || 'flux'; // flux | turbo
const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';
// Opcional: si algún día se usa una key de Pollinations (pk_/sk_), se añade como ?key=
const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || '';
// Por defecto el modo visual PRINCIPAL son imágenes cinematográficas generadas por IA.
// Si se quiere priorizar clips de video de stock (Pexels/Pixabay), poner PREFER_STOCK_VIDEO=true.
const PREFER_STOCK_VIDEO = String(process.env.PREFER_STOCK_VIDEO || 'false').toLowerCase() === 'true';

const STORAGE_DIR = join(__dirname, 'storage');
const ANALYTICS_FILE = join(STORAGE_DIR, 'comment_analytics.json');
const AUTOMATION_FILE = join(STORAGE_DIR, 'automation_config.json');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ---------------- Logs ----------------
const appLogs = [];
function pushLog(message) {
  appLogs.push({ time: new Date().toISOString(), message });
  if (appLogs.length > 100) appLogs.shift();
  console.log(message);
}

function ensureAI(req, res, next) {
  if (!aiConfig.apiKey) {
    return res.status(500).json({ ok: false, error: 'Falta API key de IA (AI_API_KEY / OPENAI_API_KEY / GROQ / TOGETHER).' });
  }
  next();
}

// ---------------- TikTok OAuth / Tokens ----------------
const DEFAULT_TIKTOK_REDIRECT_URI = 'https://toktrend3.onrender.com/api/tiktok/oauth/callback';
function normalizeTikTokRedirectUri(value) {
  const uri = String(value || '').trim();
  if (!uri) return DEFAULT_TIKTOK_REDIRECT_URI;
  return uri.replace(/\/api\/tiktok\/callback\/?$/i, '/api/tiktok/oauth/callback');
}
const REDIRECT_URI = normalizeTikTokRedirectUri(process.env.TIKTOK_REDIRECT_URI);

const codeVerifiers = new Map();
function storeVerifier(state, verifier) {
  codeVerifiers.set(state, { verifier, expires: Date.now() + 10 * 60 * 1000 });
  for (const [k, v] of codeVerifiers) if (v.expires < Date.now()) codeVerifiers.delete(k);
}
function getVerifier(state) {
  const entry = codeVerifiers.get(state);
  if (!entry || entry.expires < Date.now()) return null;
  codeVerifiers.delete(state);
  return entry.verifier;
}
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const TIKTOK_TOKEN_FILE = join(__dirname, 'tiktok_token.json');
async function readToken() {
  if (process.env.TIKTOK_TOKEN_JSON) {
    try { return JSON.parse(process.env.TIKTOK_TOKEN_JSON); } catch { return null; }
  }
  if (db) {
    try {
      const doc = await db.collection('tokens').doc('tiktok').get();
      if (doc.exists) return doc.data();
    } catch {}
  }
  if (fs.existsSync(TIKTOK_TOKEN_FILE)) {
    try { return JSON.parse(fs.readFileSync(TIKTOK_TOKEN_FILE, 'utf8')); } catch { return null; }
  }
  return null;
}

async function writeToken(data) {
  const withTs = { ...data, saved_at: Math.floor(Date.now() / 1000) };
  try { fs.writeFileSync(TIKTOK_TOKEN_FILE, JSON.stringify(withTs, null, 2)); } catch {}
  if (db) {
    try { await db.collection('tokens').doc('tiktok').set(withTs); } catch {}
  }
}

async function getValidToken() {
  const tokenData = await readToken();
  if (!tokenData?.access_token) return null;

  const now = Math.floor(Date.now() / 1000);
  const savedAt = tokenData.saved_at || 0;
  const expiresIn = tokenData.expires_in || 86400;
  const isExpired = now >= (savedAt + expiresIn - 300);

  if (isExpired && tokenData.refresh_token) {
    try {
      const params = new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token
      });
      const { data } = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' }
      });
      if (!data.error) {
        await writeToken(data);
        return data;
      }
    } catch (err) {
      pushLog(`[Token] refresh error: ${err.message}`);
    }
  }

  return isExpired ? null : tokenData;
}

async function deleteToken() {
  try { if (fs.existsSync(TIKTOK_TOKEN_FILE)) fs.unlinkSync(TIKTOK_TOKEN_FILE); } catch {}
  if (db) {
    try { await db.collection('tokens').doc('tiktok').delete(); } catch {}
  }
}

// ---------------- Data utils ----------------
function readJSONSafe(path, fallback) {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONSafe(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function uniqueByText(items) {
  const seen = new Set();
  return items.filter((x) => {
    const k = String(x.topic || '').toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------- Trending engine ----------------
async function getGoogleTrending(limit = 10) {
  try {
    const { data: xml } = await axios.get('https://trends.google.com/trending/rss?geo=US', { timeout: 12000 });
    const items = [...String(xml).matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<ht:approx_traffic>(.*?)<\/ht:approx_traffic>[\s\S]*?<\/item>/g)]
      .slice(0, limit)
      .map((m) => ({
        topic: m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        source: 'google_trends',
        score: Number(String(m[2]).replace(/[^\d]/g, '')) || 0,
        rawTraffic: m[2]
      }));
    return items;
  } catch (err) {
    pushLog(`[Trends] Google error: ${err.message}`);
    return [];
  }
}

async function getRedditTrending(limit = 10) {
  try {
    const { data } = await axios.get('https://www.reddit.com/r/popular/hot.json?limit=30', { timeout: 12000, headers: { 'User-Agent': 'toktrend3/1.0' } });
    const children = data?.data?.children || [];
    return children.slice(0, limit).map((item) => ({
      topic: item?.data?.title?.slice(0, 120),
      source: 'reddit_hot',
      score: Number(item?.data?.ups || 0)
    })).filter((x) => x.topic);
  } catch (err) {
    pushLog(`[Trends] Reddit error: ${err.message}`);
    return [];
  }
}

async function getTikTokTrending(limit = 10) {
  const endpoint = process.env.TIKTOK_TRENDS_API_URL;
  if (!endpoint) return [];
  try {
    const { data } = await axios.get(endpoint, {
      timeout: 15000,
      headers: process.env.TIKTOK_TRENDS_API_KEY ? { Authorization: `Bearer ${process.env.TIKTOK_TRENDS_API_KEY}` } : undefined
    });
    const arr = Array.isArray(data) ? data : data?.data || data?.trends || [];
    return arr.slice(0, limit).map((it) => ({
      topic: it.name || it.keyword || it.title || it.hashtag,
      source: 'tiktok_api',
      score: Number(it.score || it.views || it.popularity || 0)
    })).filter((x) => x.topic);
  } catch (err) {
    pushLog(`[Trends] TikTok trends API error: ${err.message}`);
    return [];
  }
}

async function detectTrendingTopics(limit = 20) {
  const [google, reddit, tiktok] = await Promise.all([
    getGoogleTrending(limit),
    getRedditTrending(limit),
    getTikTokTrending(limit)
  ]);
  const merged = uniqueByText([...tiktok, ...google, ...reddit])
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit)
    .map((x, idx) => ({ ...x, rank: idx + 1 }));
  return merged;
}

// ---------------- Abacus media adapters ----------------
function maybeParseJSON(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function callAbacusMediaAPI(apiUrl, payload) {
  if (!apiUrl || !ABACUS_API_KEY) return null;
  try {
    const { data } = await axios.post(apiUrl, payload, {
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${ABACUS_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return data;
  } catch (err) {
    pushLog(`[Abacus API] ${apiUrl} error: ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function generateImageWithAbacus(prompt, outPath) {
  const data = await callAbacusMediaAPI(ABACUS_IMAGE_API_URL, {
    prompt,
    aspect_ratio: '9:16',
    quality: 'high',
    style: 'cinematic',
    format: 'jpg'
  });
  if (!data) return false;

  const imageUrl = data.image_url || data.url || data.output_url || data?.result?.url;
  const base64 = data.image_base64 || data.base64 || data?.result?.base64;

  try {
    if (imageUrl) {
      const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(outPath, Buffer.from(resp.data));
      return true;
    }
    if (base64) {
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      return true;
    }
  } catch (err) {
    pushLog(`[Abacus image download] error: ${err.message}`);
  }
  return false;
}

async function generateNarrationWithAbacus(script, outputPath) {
  const data = await callAbacusMediaAPI(ABACUS_AUDIO_API_URL, {
    text: script,
    language: 'es',
    voice_style: 'professional-natural',
    format: 'mp3',
    quality: 'high'
  });
  if (!data) return false;

  const audioUrl = data.audio_url || data.url || data.output_url || data?.result?.url;
  const base64 = data.audio_base64 || data.base64 || data?.result?.base64;
  try {
    if (audioUrl) {
      const resp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 120000 });
      fs.writeFileSync(outputPath, Buffer.from(resp.data));
      return true;
    }
    if (base64) {
      fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
      return true;
    }
  } catch (err) {
    pushLog(`[Abacus audio download] error: ${err.message}`);
  }
  return false;
}

async function generateVideoWithAbacus(prompts, outputPath) {
  const data = await callAbacusMediaAPI(ABACUS_VIDEO_API_URL, {
    prompts,
    aspect_ratio: '9:16',
    style: 'cinematic documentary',
    quality: 'high'
  });
  if (!data) return false;
  const videoUrl = data.video_url || data.url || data.output_url || data?.result?.url;
  const base64 = data.video_base64 || data.base64 || data?.result?.base64;
  try {
    if (videoUrl) {
      const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
      fs.writeFileSync(outputPath, Buffer.from(resp.data));
      return true;
    }
    if (base64) {
      fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
      return true;
    }
  } catch (err) {
    pushLog(`[Abacus video download] error: ${err.message}`);
  }
  return false;
}

// ---------------- Content generation ----------------
function normalizeScriptData(data, topic) {
  const fallback = {
    title: `Impacto de ${topic}`.slice(0, 80),
    script: `Soy una inteligencia artificial autonoma que aprende leyendo vuestros comentarios. ${topic} no es un tema cualquiera: es una puerta para entender cambios reales en nuestro mundo. Si observas con detalle, veras un patron que conecta personas, cultura y decisiones cotidianas. Lo potente es que cada tendencia tiene una historia oculta y una oportunidad de aprendizaje. Quiero que en este video detectes el giro clave, el dato que cambia la perspectiva y la pregunta que te obliga a pensar mas profundo. Dejame tu comentario, aprendo de ti.`,
    description: `${topic} explicado en formato cinematográfico y accionable.`,
    hashtags: ['#TokTrend', '#IA', '#Cine', '#Tendencias', '#Aprendizaje'],
    shots: [
      `Plano épico de apertura sobre ${topic}`,
      'Detalle en movimiento con profundidad de campo',
      'Transición con cámara travelling lateral',
      'Close-up dramático con luz volumétrica',
      'Escena urbana moderna con ritmo rápido',
      'Plano simbólico que represente transformación',
      'Cierre emocional con composición cinematográfica'
    ],
    image_queries: [
      `${topic} cinematic wide shot`,
      `${topic} dramatic close up`,
      `${topic} futuristic city`,
      `${topic} storytelling visual`,
      `${topic} documentary lighting`,
      `${topic} high detail texture`,
      `${topic} emotional finale`
    ]
  };

  const merged = { ...fallback, ...(data || {}) };
  merged.title = String(merged.title || fallback.title).slice(0, 80);
  merged.script = String(merged.script || fallback.script);
  merged.description = String(merged.description || fallback.description).slice(0, 300);
  merged.hashtags = Array.isArray(merged.hashtags) && merged.hashtags.length ? merged.hashtags.slice(0, 12) : fallback.hashtags;
  merged.shots = Array.isArray(merged.shots) && merged.shots.length ? merged.shots.slice(0, 7) : fallback.shots;
  merged.image_queries = Array.isArray(merged.image_queries) && merged.image_queries.length ? merged.image_queries.slice(0, 7) : fallback.image_queries;
  return merged;
}

async function generateScript(topic, learningContext = '') {
  const prompt = `Eres estratega viral de TikTok y director cinematográfico.
Genera SOLO JSON válido para un video de 30-45s en español sobre: "${topic}".
Incluye gancho, narrativa, tensión y cierre con CTA.
Debes empezar el script con: "Soy una inteligencia artificial autonoma que aprende leyendo vuestros comentarios."
Termina con: "Dejame tu comentario, aprendo de ti."
Usa este contexto de aprendizaje (si existe): ${learningContext || 'sin contexto'}

IMPORTANTE sobre "image_queries": son prompts EN INGLÉS para un GENERADOR DE IMÁGENES POR IA
(tipo DALL·E / Stable Diffusion). Cada uno debe describir una ESCENA cinematográfica concreta y
visualmente rica (sujeto, entorno, acción, atmósfera, iluminación), NO palabras de búsqueda.
Da 5 a 7 escenas distintas que cuenten la historia del video. Ejemplo:
"a lone astronaut standing on a glowing alien desert at dusk, dramatic backlight, wide cinematic shot".

Formato exacto:
{
 "title": "...",
 "script": "...",
 "description": "...",
 "hashtags": ["#..."],
 "shots": ["..."],
 "image_queries": ["detailed english scene prompt for AI image generation", "..."]
}`;

  const response = await openai.chat.completions.create({
    model: aiConfig.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 1000
  });

  let text = response.choices?.[0]?.message?.content?.trim() || '{}';
  text = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const parsed = maybeParseJSON(text);
  return normalizeScriptData(parsed, topic);
}

// Descarga una imagen desde una URL y la guarda; valida que sea una imagen real (>3KB)
async function downloadImageTo(url, outputPath) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': STOCK_UA, 'Accept': 'image/*' },
      maxContentLength: 25 * 1024 * 1024
    });
    const buf = Buffer.from(resp.data);
    if (buf.length < 3000) return false; // demasiado pequeña: probablemente error/placeholder
    fs.writeFileSync(outputPath, buf);
    return true;
  } catch {
    return false;
  }
}

// 1) Pexels (foto). Requiere PEXELS_API_KEY (gratis). Imágenes profesionales y cinematográficas.
async function fetchPexelsPhoto(query, outputPath) {
  if (!PEXELS_API_KEY) return false;
  try {
    const { data } = await axios.get('https://api.pexels.com/v1/search', {
      params: { query, orientation: 'portrait', per_page: 8, size: 'medium' },
      headers: { Authorization: PEXELS_API_KEY },
      timeout: 15000
    });
    const photos = data?.photos || [];
    for (const ph of photos) {
      const src = ph?.src?.portrait || ph?.src?.large2x || ph?.src?.large || ph?.src?.original;
      if (src && await downloadImageTo(src, outputPath)) return true;
    }
  } catch (err) {
    pushLog(`[Pexels photo] ${err.response?.status || ''} ${err.message}`);
  }
  return false;
}

// 2) Pixabay (foto). Requiere PIXABAY_API_KEY (gratis).
async function fetchPixabayPhoto(query, outputPath) {
  if (!PIXABAY_API_KEY) return false;
  try {
    const { data } = await axios.get('https://pixabay.com/api/', {
      params: { key: PIXABAY_API_KEY, q: query, image_type: 'photo', orientation: 'vertical', per_page: 8, safesearch: true },
      timeout: 15000
    });
    const hits = data?.hits || [];
    for (const h of hits) {
      const src = h?.largeImageURL || h?.webformatURL;
      if (src && await downloadImageTo(src, outputPath)) return true;
    }
  } catch (err) {
    pushLog(`[Pixabay photo] ${err.response?.status || ''} ${err.message}`);
  }
  return false;
}

// 3) Openverse (sin key): >700M imágenes CC. Relevancia alta.
async function fetchOpenversePhoto(query, outputPath) {
  try {
    const { data } = await axios.get('https://api.openverse.org/v1/images/', {
      params: { q: query, page_size: 8, license_type: 'commercial', mature: false },
      headers: { 'User-Agent': 'toktrend/1.0 (+https://toktrend3.onrender.com)' },
      timeout: 15000
    });
    const results = data?.results || [];
    for (const r of results) {
      const src = r?.url || r?.thumbnail;
      if (src && await downloadImageTo(src, outputPath)) return true;
    }
  } catch (err) {
    pushLog(`[Openverse] ${err.response?.status || ''} ${err.message}`);
  }
  return false;
}

// 4) Wikimedia Commons (sin key): filtrado a imágenes reales (jpeg/png/webp).
async function fetchWikimediaPhoto(query, outputPath) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=720&format=json&gsrlimit=12`;
    const { data } = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'toktrend/1.0 (+https://toktrend3.onrender.com)' } });
    const pages = Object.values(data?.query?.pages || {});
    const candidates = pages
      .map((p) => p?.imageinfo?.[0])
      .filter((img) => img?.thumburl && /image\/(jpeg|png|webp)/i.test(img?.mime || ''));
    for (const c of candidates) {
      if (await downloadImageTo(c.thumburl, outputPath)) return true;
    }
  } catch (err) {
    pushLog(`[Wikimedia] ${err.message}`);
  }
  return false;
}

// 5) Último recurso: gradiente atractivo (NO color plano) generado con FFmpeg.
async function makeGradientBackground(outputPath, idx = 0) {
  const palettes = [
    ['0x0f172a', '0x2563eb'], ['0x1e1b4b', '0x7c3aed'], ['0x064e3b', '0x14b8a6'],
    ['0x451a03', '0xf97316'], ['0x500724', '0xdb2777'], ['0x0c4a6e', '0x22d3ee']
  ];
  const [c0, c1] = palettes[idx % palettes.length];
  // gradiente diagonal suave 720x1280
  const cmd = `"${ffmpegPath.path}" -f lavfi -i "gradients=s=720x1280:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=720:y1=1280" -frames:v 1 -y "${outputPath}"`;
  try {
    await execAsync(cmd);
  } catch {
    // si el filtro gradients no está disponible, usar color sólido como respaldo final
    await execAsync(`"${ffmpegPath.path}" -f lavfi -i "color=c=${c1}:s=720x1280" -frames:v 1 -y "${outputPath}"`);
  }
  registerTempFile(outputPath);
  return true;
}

// ---------------- Generación de imágenes por IA (Pollinations / Flux) ----------------
// Convierte la consulta de la escena en un prompt cinematográfico en inglés.
function buildCinematicPrompt(query) {
  const base = String(query || 'cinematic storytelling').replace(/\s+/g, ' ').trim();
  // Si el prompt ya trae estilo, igualmente reforzamos con descriptores cinematográficos.
  return `Cinematic film still, ${base}, dramatic cinematic lighting, shallow depth of field, ` +
    `volumetric light, atmospheric, ultra detailed, photorealistic, 8k, professional color grading, ` +
    `epic movie scene, anamorphic, high dynamic range`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Genera UNA imagen por IA con Pollinations (Flux/Turbo). Gratis y sin API key.
// IMPORTANTE: la API SIN KEY limita a ~1 petición simultánea (responde 429 si hay concurrencia).
// Por eso se llama SECUENCIALMENTE y se reintenta con backoff cuando hay 429.
async function generateAiImage(query, outputPath, idx = 0) {
  if (!AI_IMAGES_ENABLED) return false;
  const prompt = buildCinematicPrompt(query);
  let seed = (Math.floor(Math.random() * 1e6) + idx * 7919) % 1000000;
  // Alternamos de modelo en intentos tardíos por si uno está saturado.
  const models = [POLLINATIONS_MODEL, POLLINATIONS_MODEL, 'turbo', 'flux'];
  const MAX_ATTEMPTS = 4;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const params = new URLSearchParams({
      width: '768',
      height: '1344',          // vertical 9:16 para TikTok
      model: models[attempt] || POLLINATIONS_MODEL,
      nologo: 'true',
      enhance: 'true',          // la IA mejora el prompt para mayor calidad
      seed: String(seed),
      safe: 'true'
    });
    if (POLLINATIONS_KEY) params.set('key', POLLINATIONS_KEY);
    const url = `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;
    try {
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 95000, // la generación por IA puede tardar; damos margen
        headers: { 'User-Agent': STOCK_UA, 'Accept': 'image/*' },
        maxContentLength: 25 * 1024 * 1024
      });
      const buf = Buffer.from(resp.data);
      const ct = String(resp.headers?.['content-type'] || '');
      if (buf.length > 5000 && /image\//i.test(ct)) {
        fs.writeFileSync(outputPath, buf);
        return true;
      }
    } catch (err) {
      const status = err.response?.status;
      pushLog(`[Pollinations] escena ${idx} intento ${attempt + 1} (${models[attempt]}) falló: ${status || ''} ${err.message}`);
      // 429 = rate limit: esperar (backoff) y reintentar; suele resolverse al esperar.
      if (status === 429 && attempt < MAX_ATTEMPTS - 1) {
        await sleep(4000 + attempt * 4000); // 4s, 8s, 12s
      } else if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(1500);
      }
    }
    seed = (seed + 4111 + attempt * 131) % 1000000; // varía la semilla en el próximo intento
  }
  return false;
}

// Obtiene UNA imagen real intentando todas las fuentes en orden de calidad.
async function fetchFallbackImage(query, outputPath, idx = 0) {
  if (await fetchPexelsPhoto(query, outputPath)) return true;
  if (await fetchPixabayPhoto(query, outputPath)) return true;
  if (await fetchOpenversePhoto(query, outputPath)) return true;
  if (await fetchWikimediaPhoto(query, outputPath)) return true;
  await makeGradientBackground(outputPath, idx);
  return true;
}

// ---------------- Clips de video stock REALES (cinematográficos) ----------------
async function downloadFileTo(url, outputPath, minBytes = 20000) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'User-Agent': STOCK_UA },
      maxContentLength: 80 * 1024 * 1024
    });
    const buf = Buffer.from(resp.data);
    if (buf.length < minBytes) return false;
    fs.writeFileSync(outputPath, buf);
    return true;
  } catch {
    return false;
  }
}

// Pexels video: elige un archivo vertical/HD ligero (<=1280px) para ahorrar memoria.
function pickPexelsVideoFile(videoFiles = []) {
  const portrait = videoFiles.filter((f) => f.width && f.height && f.height >= f.width);
  const pool = portrait.length ? portrait : videoFiles;
  // preferir el más cercano a 720px de ancho para 720x1280
  const sorted = pool
    .filter((f) => f.link && /mp4/i.test(f.file_type || 'mp4'))
    .sort((a, b) => Math.abs((a.width || 720) - 720) - Math.abs((b.width || 720) - 720));
  return sorted[0]?.link || null;
}

async function fetchPexelsVideos(queries, outputDir, count) {
  if (!PEXELS_API_KEY) return [];
  const clips = [];
  for (let i = 0; i < queries.length && clips.length < count; i++) {
    const query = queries[i];
    try {
      const { data } = await axios.get('https://api.pexels.com/videos/search', {
        params: { query, orientation: 'portrait', per_page: 5, size: 'medium' },
        headers: { Authorization: PEXELS_API_KEY },
        timeout: 15000
      });
      const videos = data?.videos || [];
      for (const v of videos) {
        const link = pickPexelsVideoFile(v.video_files);
        if (!link) continue;
        const outPath = join(outputDir, `clip_${clips.length}.mp4`);
        if (await downloadFileTo(link, outPath)) {
          clips.push(outPath);
          registerTempFile(outPath);
          break;
        }
      }
    } catch (err) {
      pushLog(`[Pexels video] ${err.response?.status || ''} ${err.message}`);
    }
  }
  return clips;
}

async function fetchPixabayVideos(queries, outputDir, count) {
  if (!PIXABAY_API_KEY) return [];
  const clips = [];
  for (let i = 0; i < queries.length && clips.length < count; i++) {
    const query = queries[i];
    try {
      const { data } = await axios.get('https://pixabay.com/api/videos/', {
        params: { key: PIXABAY_API_KEY, q: query, per_page: 5, safesearch: true },
        timeout: 15000
      });
      const hits = data?.hits || [];
      for (const h of hits) {
        const v = h?.videos || {};
        const link = v.medium?.url || v.small?.url || v.large?.url || v.tiny?.url;
        if (!link) continue;
        const outPath = join(outputDir, `clip_${clips.length}.mp4`);
        if (await downloadFileTo(link, outPath)) {
          clips.push(outPath);
          registerTempFile(outPath);
          break;
        }
      }
    } catch (err) {
      pushLog(`[Pixabay video] ${err.response?.status || ''} ${err.message}`);
    }
  }
  return clips;
}

// Intenta obtener clips de video reales (solo si hay key de Pexels/Pixabay).
async function fetchStockVideoClips(queries, outputDir, count = 5) {
  fs.mkdirSync(outputDir, { recursive: true });
  let clips = await fetchPexelsVideos(queries, outputDir, count);
  if (clips.length < Math.min(3, count)) {
    const more = await fetchPixabayVideos(queries, outputDir, count - clips.length);
    clips = clips.concat(more);
  }
  return clips;
}

// Compone un video cinematográfico a partir de CLIPS de video reales + narración.
// Cada clip se recorta a una duración uniforme, se escala/recorta a 720x1280 y se concatena.
async function buildVideoFromClips(clips, audioPath, outputPath, audioSeconds) {
  // Cola de seguridad para que la narración termine completa (sin cortar el diálogo final).
  const TAIL = 1.4;
  const videoSeconds = Math.max(2, (Number(audioSeconds) || 0) + TAIL);
  const perClip = Math.max(2.5, videoSeconds / clips.length);
  const inputs = clips.map((c) => `-stream_loop -1 -t ${perClip.toFixed(2)} -i "${c}"`).join(' ');

  const filters = clips.map((_, i) =>
    `[${i}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30,format=yuv420p[v${i}]`
  ).join(';');
  const concatChain = clips.map((_, i) => `[v${i}]`).join('');
  // Audio rellenado con silencio (apad) para que nunca termine antes que el video.
  const filter = `${filters};${concatChain}concat=n=${clips.length}:v=1:a=0[v];[${clips.length}:a]apad[a]`;

  const cmd = [
    `"${ffmpegPath.path}" -y`,
    inputs,
    `-i "${audioPath}"`,
    `-filter_complex "${filter}"`,
    `-map "[v]" -map "[a]"`,
    '-c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p',
    '-c:a aac -b:a 192k -ar 48000 -ac 2',
    `-t ${videoSeconds.toFixed(2)} -movflags +faststart`,
    `"${outputPath}"`
  ].join(' ');

  await execAsync(cmd, { maxBuffer: 200 * 1024 * 1024 });
}

async function generateImages(prompts, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const COUNT = 5; // 5 imágenes (optimización de memoria)
  const imagePaths = new Array(COUNT);
  let aiCount = 0;

  // SECUENCIAL (concurrencia=1): la API gratuita de Pollinations rechaza peticiones
  // simultáneas con 429. Generar una a una garantiza que casi todas sean imágenes IA.
  for (let i = 0; i < COUNT; i++) {
    const p = prompts[i] || prompts[0] || 'cinematic storytelling';
    const outPath = join(outputDir, `img_${i}.jpg`);
    let ok = false;
    // 1) Abacus (si está configurado en producción)
    if (ABACUS_IMAGE_API_URL && ABACUS_API_KEY) {
      ok = await generateImageWithAbacus(p, outPath);
    }
    // 2) PRINCIPAL: imagen CINEMATOGRÁFICA generada por IA (Pollinations / Flux, gratis y sin key)
    if (!ok) {
      ok = await generateAiImage(p, outPath, i);
      if (ok) aiCount++;
    }
    // 3) Último recurso: imagen real de stock / gradiente (solo si la IA falló tras varios intentos)
    if (!ok) {
      await fetchFallbackImage(p, outPath, i);
    }
    imagePaths[i] = outPath;
    // pequeña pausa entre escenas para respetar el rate-limit de la API gratuita
    if (i < COUNT - 1) await sleep(1200);
  }
  pushLog(`[Imágenes] ${aiCount}/${COUNT} generadas por IA (Pollinations/${POLLINATIONS_MODEL}), resto por fallback real.`);
  return imagePaths;
}

// Divide el texto en fragmentos <=180 caracteres respetando límites de frase/palabra.
function splitTextForTTS(text, maxLen = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    const sentence = s.trim();
    if (sentence.length > maxLen) {
      // frase muy larga: trocear por palabras
      const words = sentence.split(' ');
      for (const w of words) {
        if ((current + ' ' + w).trim().length > maxLen) {
          if (current) chunks.push(current.trim());
          current = w;
        } else {
          current = (current + ' ' + w).trim();
        }
      }
    } else if ((current + ' ' + sentence).trim().length > maxLen) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current = (current + ' ' + sentence).trim();
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

// TTS gratuito sin key vía Google Translate (es). Trocea, descarga y concatena con FFmpeg.
async function synthesizeGoogleTTS(script, outputPath, lang = 'es') {
  const chunks = splitTextForTTS(script, 180);
  if (!chunks.length) return false;
  const tmpDir = join(dirname(outputPath), 'tts_parts');
  fs.mkdirSync(tmpDir, { recursive: true });
  const partPaths = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunks[i])}&tl=${lang}&client=tw-ob&total=${chunks.length}&idx=${i}&textlen=${chunks[i].length}`;
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: { 'User-Agent': STOCK_UA, 'Referer': 'https://translate.google.com/' }
          });
          const buf = Buffer.from(resp.data);
          if (buf.length > 500) {
            const p = join(tmpDir, `part_${i}.mp3`);
            fs.writeFileSync(p, buf);
            partPaths.push(p);
            ok = true;
          }
        } catch {
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (!ok) { /* salta el fragmento fallido pero continúa */ }
    }

    if (!partPaths.length) return false;

    // Concatenar todas las partes re-codificando para evitar problemas de cabeceras
    const listFile = join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await execAsync(
      `"${ffmpegPath.path}" -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -b:a 128k "${outputPath}"`,
      { maxBuffer: 50 * 1024 * 1024 }
    );
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  } catch (err) {
    pushLog(`[GoogleTTS] error: ${err.message}`);
    return false;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Genera una pista silenciosa (último recurso para que el video siempre se construya).
async function makeSilentAudio(outputPath, seconds) {
  await execAsync(
    `"${ffmpegPath.path}" -y -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 -t ${seconds} -c:a libmp3lame -b:a 96k "${outputPath}"`
  );
  return true;
}

// Limpia y normaliza el texto del guion para que la VOZ suene fluida y natural:
// quita emojis, hashtags, markdown, URLs y normaliza espacios y puntuación (pausas naturales).
function cleanNarrationText(text) {
  let t = String(text || '');
  t = t.replace(/https?:\/\/\S+/g, ' ');           // URLs
  t = t.replace(/[#@][\wáéíóúñ]+/gi, ' ');          // hashtags / menciones (se leen mal)
  t = t.replace(/[*_`>#~|]+/g, ' ');                // markdown básico
  // emojis y pictogramas
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, ' ');
  t = t.replace(/[“”«»"]/g, '');                    // comillas tipográficas
  t = t.replace(/\s*[–—]\s*/g, ', ');               // guiones largos -> pausa
  t = t.replace(/\s*([,.;:!?¡¿])\s*/g, '$1 ');      // espacio tras puntuación
  t = t.replace(/([,.;:!?])\1+/g, '$1');            // puntuación repetida
  t = t.replace(/[ \t]+/g, ' ');                    // espacios múltiples
  t = t.replace(/\s+/g, ' ').trim();
  if (t && !/[.!?]$/.test(t)) t += '.';             // cierre con cadencia natural
  return t;
}

async function generateNarration(script, outputPath) {
  const text = cleanNarrationText(script) || String(script || '').trim();

  // 1) Abacus Audio (si está configurado)
  if (ABACUS_AUDIO_API_URL && ABACUS_API_KEY) {
    if (await generateNarrationWithAbacus(text, outputPath)) return 'abacus';
  }

  // 2) OpenAI / TTS_API_KEY — voz natural. Intenta primero el modelo más expresivo
  //    (gpt-4o-mini-tts con instrucciones de tono) y cae a tts-1-hd si no está disponible.
  if (ttsClient) {
    const voice = process.env.TTS_VOICE || 'nova';
    const speed = Number(process.env.TTS_SPEED || 1.0);
    const instructions = process.env.TTS_INSTRUCTIONS
      || 'Narra en español latino neutro con una voz cálida, cercana y muy natural, como un buen narrador de documental. Ritmo fluido y conversacional, entonación expresiva que sube y baja con la historia, y pausas naturales en las comas y los puntos. Pronuncia con claridad, sin sonar robótico ni apresurado.';
    const models = process.env.TTS_MODEL ? [process.env.TTS_MODEL] : ['gpt-4o-mini-tts', 'tts-1-hd'];
    for (const model of models) {
      try {
        const params = { model, voice, input: text, response_format: 'mp3' };
        // 'instructions' solo lo soporta gpt-4o-mini-tts; 'speed' solo los tts-1*.
        if (model.includes('gpt-4o')) params.instructions = instructions;
        else params.speed = speed;
        const tts = await ttsClient.audio.speech.create(params);
        fs.writeFileSync(outputPath, Buffer.from(await tts.arrayBuffer()));
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
          pushLog(`[TTS] Voz natural generada con OpenAI (${model}, voz "${voice}").`);
          return 'openai';
        }
      } catch (err) {
        pushLog(`[OpenAI TTS] modelo ${model} falló: ${err.message}`);
      }
    }
  }

  // 3) Google Translate TTS (gratis, sin key) — fallback robusto en español
  if (await synthesizeGoogleTTS(text, outputPath, 'es')) return 'google';

  // 4) Último recurso: pista silenciosa para que el video siempre se genere
  pushLog('[Narración] Todas las fuentes TTS fallaron, usando pista silenciosa.');
  await makeSilentAudio(outputPath, estimateSeconds(text));
  return 'silent';
}

// Duración real del audio (segundos) usando ffprobe/ffmpeg.
async function getAudioDuration(audioPath) {
  try {
    // El comando usa 2>&1, así que la salida de ffmpeg llega por stdout (y a veces stderr).
    // Combinamos ambas para extraer la "Duration" de forma fiable (antes leía solo stderr → null).
    const { stdout, stderr } = await execAsync(`"${ffmpegPath.path}" -i "${audioPath}" -f null - 2>&1 || true`);
    const out = `${stdout || ''}\n${stderr || ''}`;
    const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  } catch {}
  return null;
}

function estimateSeconds(script) {
  const words = String(script || '').split(/\s+/).filter(Boolean).length;
  return Math.max(30, Math.min(55, Math.ceil(words / 2.4)));
}

async function buildCinematicVideo(images, audioPath, outputPath, audioSeconds) {
  const fps = 30;
  // Cola de seguridad: el video dura un poco MÁS que el audio para que la última
  // frase de la narración termine completa y nunca se corte el diálogo final.
  const TAIL = 1.4;
  const videoSeconds = Math.max(2, (Number(audioSeconds) || 0) + TAIL);
  // Frames por imagen. Usamos ceil para que la duración VISUAL sea >= audio + cola.
  const perFrames = Math.max(fps, Math.ceil((videoSeconds / images.length) * fps));
  const imageInputs = images.map((p) => `-i "${p}"`).join(' ');

  // Movimiento Ken Burns: cada imagen es UNA entrada y zoompan genera 'perFrames' frames.
  // Se escala el origen a 1080x1920 para dar margen de zoom y se emite a 720x1280 (memoria optimizada).
  const visualFilters = images.map((_, i) => {
    const zoomIn = i % 2 === 0;
    // zoom suave hacia dentro o hacia fuera, con paneo centrado
    const z = zoomIn ? `min(zoom+0.0012,1.30)` : `if(lte(zoom,1.0),1.30,max(zoom-0.0012,1.0))`;
    return `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${perFrames}:s=720x1280:fps=${fps},setsar=1,format=yuv420p[v${i}]`;
  }).join(';');

  const concatChain = images.map((_, i) => `[v${i}]`).join('');
  // Se rellena el AUDIO con silencio (apad) para que jamás termine antes que el video.
  // El corte final lo marca -t videoSeconds (audio completo + cola), no -shortest.
  const filter = `${visualFilters};${concatChain}concat=n=${images.length}:v=1:a=0[v];[${images.length}:a]apad[a]`;

  const cmd = [
    `"${ffmpegPath.path}" -y`,
    imageInputs,
    `-i "${audioPath}"`,
    `-filter_complex "${filter}"`,
    `-map "[v]" -map "[a]"`,
    '-c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p',
    '-c:a aac -b:a 192k -ar 48000 -ac 2',
    `-t ${videoSeconds.toFixed(2)} -movflags +faststart`,
    `"${outputPath}"`
  ].join(' ');

  await execAsync(cmd, { maxBuffer: 150 * 1024 * 1024 });
}

// Extrae un fotograma de un clip para usarlo como miniatura de previsualización.
async function extractThumbnail(clipPath, outPath, atSec = 0.5) {
  try {
    await execAsync(`"${ffmpegPath.path}" -y -ss ${atSec} -i "${clipPath}" -frames:v 1 -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280" "${outPath}"`);
    return fs.existsSync(outPath);
  } catch {
    return false;
  }
}

async function saveGeneratedRecord(record) {
  if (db) {
    try {
      await db.collection('generated_videos').doc(record.sessionId).set(record);
      return;
    } catch {}
  }
  const localPath = join(STORAGE_DIR, 'generated_videos.json');
  const arr = readJSONSafe(localPath, []);
  arr.unshift(record);
  writeJSONSafe(localPath, arr.slice(0, 300));
}

async function getGeneratedRecords(limit = 50) {
  if (db) {
    try {
      const snap = await db.collection('generated_videos').orderBy('createdAt', 'desc').limit(limit).get();
      return snap.docs.map((d) => d.data());
    } catch {}
  }
  return readJSONSafe(join(STORAGE_DIR, 'generated_videos.json'), []).slice(0, limit);
}

function hasGeneratedVideoFile(record) {
  if (!record?.sessionId) return false;
  return fs.existsSync(join(__dirname, 'public', 'videos', record.sessionId, 'video.mp4'));
}

async function getLatestGeneratedVideo() {
  const records = await getGeneratedRecords(50);
  return records.find(hasGeneratedVideoFile) || null;
}

async function getLearningContext() {
  const analytics = readJSONSafe(ANALYTICS_FILE, { insights: [] });
  return (analytics.insights || []).slice(0, 8).join(' | ');
}

async function generateVideoPipeline({ topic, source = 'manual' }) {
  const sessionId = crypto.randomBytes(8).toString('hex');
  const workDir = join(__dirname, 'public', 'videos', sessionId);
  const imgDir = join(workDir, 'imgs');
  fs.mkdirSync(imgDir, { recursive: true });

  const learningContext = await getLearningContext();
  const scriptData = await generateScript(topic, learningContext);
  const queries = scriptData.image_queries?.length ? scriptData.image_queries : [topic];

  // 1) Narración primero, para sincronizar la duración del video con la voz real.
  const audioPath = join(workDir, 'narration.mp3');
  const narrationSource = await generateNarration(scriptData.script, audioPath);
  registerTempFile(audioPath);

  const audioDuration = await getAudioDuration(audioPath);
  // Duración REAL del audio (fraccional). Tope generoso (95s) para no recortar narraciones
  // largas; el video se construye con una cola extra para que el diálogo nunca se corte.
  const audioSec = Math.max(8, Math.min(95, audioDuration || estimateSeconds(scriptData.script)));
  const duration = audioSec;                 // se pasa a los constructores de video (fraccional)
  const displayDuration = Math.round(audioSec); // valor entero para UI/registro

  const videoPath = join(workDir, 'video.mp4');

  // 2) Estrategia visual:
  //    a) Abacus video (si está configurado)
  //    b) PRINCIPAL: imágenes CINEMATOGRÁFICAS generadas por IA (Pollinations/Flux) + Ken Burns
  //    c) (opcional) clips de stock reales, solo si PREFER_STOCK_VIDEO=true y hay key
  let visualMode = 'images';
  let slides = [];

  // a) Abacus video generativo (si está configurado)
  let built = false;
  if (ABACUS_VIDEO_API_URL && ABACUS_API_KEY) {
    if (await generateVideoWithAbacus(scriptData.shots, videoPath)) {
      built = true;
      visualMode = 'abacus_video';
    }
  }

  // b) OPCIONAL: clips de video stock REALES (solo si se prefiere explícitamente y hay key)
  if (!built && PREFER_STOCK_VIDEO && (PEXELS_API_KEY || PIXABAY_API_KEY)) {
    const clips = await fetchStockVideoClips(queries, imgDir, 5);
    if (clips.length >= 3) {
      await buildVideoFromClips(clips, audioPath, videoPath, duration);
      built = true;
      visualMode = 'stock_clips';
      // miniaturas de previsualización a partir de los clips
      for (let i = 0; i < clips.length; i++) {
        const thumb = join(imgDir, `img_${i}.jpg`);
        if (await extractThumbnail(clips[i], thumb)) {
          slides.push({
            url: `/videos/${sessionId}/imgs/img_${i}.jpg`,
            description: scriptData.shots?.[i] || `Escena ${i + 1}`,
            duration: Number((displayDuration / clips.length).toFixed(1))
          });
        }
      }
    }
  }

  // c) PRINCIPAL: imágenes CINEMATOGRÁFICAS generadas por IA + movimiento Ken Burns
  //    (generateImages usa Pollinations/Flux como fuente principal y stock real como respaldo)
  if (!built) {
    const images = await generateImages(queries, imgDir);
    await buildCinematicVideo(images, audioPath, videoPath, duration);
    visualMode = AI_IMAGES_ENABLED ? 'ai_images_kenburns' : 'images_kenburns';
    slides = images.map((_, i) => ({
      url: `/videos/${sessionId}/imgs/img_${i}.jpg`,
      description: scriptData.shots?.[i] || `Escena ${i + 1}`,
      duration: Number((displayDuration / images.length).toFixed(1))
    }));
  }

  const record = {
    sessionId,
    topic,
    source,
    title: scriptData.title,
    createdAt: Date.now(),
    duration: displayDuration,
    visualMode,
    narrationSource,
    usedAbacusVideo: visualMode === 'abacus_video',
    hasStockKeys: Boolean(PEXELS_API_KEY || PIXABAY_API_KEY),
    hasAbacusImage: Boolean(ABACUS_IMAGE_API_URL && ABACUS_API_KEY),
    hasAbacusAudio: Boolean(ABACUS_AUDIO_API_URL && ABACUS_API_KEY),
    videoUrl: `/videos/${sessionId}/video.mp4`,
    scriptData,
    slides
  };
  await saveGeneratedRecord(record);
  pushLog(`[Pipeline] Video listo (${visualMode}, voz: ${narrationSource}, ${displayDuration}s) sobre "${topic}"`);

  setTimeout(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 60 * 60 * 1000);

  return {
    ok: true,
    sessionId,
    topic,
    duration: displayDuration,
    visualMode,
    narrationSource,
    videoUrl: `/videos/${sessionId}/video.mp4`,
    scriptData,
    slides
  };
}

// ---------------- TikTok publish ----------------
async function initTikTokPublish(token, payload) {
  try {
    const direct = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/', payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
    });
    return { method: 'DIRECT_POST', data: direct.data };
  } catch (directErr) {
    const code = directErr.response?.data?.error?.code;
    if (code !== 'unaudited_client_can_only_post_to_private_accounts') throw directErr;

    const inbox = await axios.post('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', { source_info: payload.source_info }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
    });
    return { method: 'INBOX_UPLOAD', data: inbox.data };
  }
}

async function uploadFileChunks(uploadUrl, fileBuffer) {
  const videoSize = fileBuffer.length;
  let chunkSize = 10 * 1024 * 1024;
  let totalChunks = Math.ceil(videoSize / chunkSize);
  if (videoSize <= chunkSize) {
    chunkSize = videoSize;
    totalChunks = 1;
  }

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = i === totalChunks - 1 ? videoSize : start + chunkSize;
    const chunk = fileBuffer.slice(start, end);

    await axios.put(uploadUrl, chunk, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end - 1}/${videoSize}`,
        'Content-Length': chunk.length
      },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  }

  return { videoSize, chunkSize, totalChunks };
}

async function publishSessionToTikTok({ sessionId, title, description }) {
  const tokenData = await getValidToken();
  if (!tokenData?.access_token) throw new Error('TikTok no conectado.');

  const videoPath = join(__dirname, 'public', 'videos', sessionId, 'video.mp4');
  if (!fs.existsSync(videoPath)) throw new Error('Video no encontrado para publicar.');

  const videoBuffer = fs.readFileSync(videoPath);
  const sourceInfo = {
    source: 'FILE_UPLOAD',
    video_size: videoBuffer.length,
    chunk_size: Math.min(videoBuffer.length, 10 * 1024 * 1024),
    total_chunk_count: Math.ceil(videoBuffer.length / (10 * 1024 * 1024))
  };

  const payload = {
    post_info: {
      title: (title || 'TokTrend IA').slice(0, 80),
      description: (description || 'Video generado con TokTrend IA').slice(0, 2200),
      privacy_level: 'SELF_ONLY',
      disable_comment: false,
      auto_add_music: false
    },
    source_info: sourceInfo
  };

  const init = await initTikTokPublish(tokenData.access_token, payload);
  const uploadUrl = init.data?.data?.upload_url;
  const publishId = init.data?.data?.publish_id;
  if (!uploadUrl) throw new Error('TikTok no devolvió upload_url');

  await uploadFileChunks(uploadUrl, videoBuffer);
  return {
    publishId,
    method: init.method,
    message: init.method === 'INBOX_UPLOAD'
      ? 'Video subido a TikTok Inbox. Revísalo y publícalo desde la app de TikTok.'
      : 'Video publicado en TikTok.'
  };
}

// ---------------- Learning system ----------------
async function fetchTikTokComments(videoId, count = 50) {
  const tokenData = await getValidToken();
  if (!tokenData?.access_token) throw new Error('TikTok no conectado para leer comentarios.');

  const { data } = await axios.get('https://open.tiktokapis.com/v2/video/comment/list/', {
    params: { video_id: videoId, count },
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  return data?.data?.comments || [];
}

async function analyzeCommentsWithAI(topic, comments) {
  const commentsText = comments.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  const prompt = `Analiza comentarios de TikTok para mejorar contenido futuro.
Tema base: ${topic}
Comentarios:\n${commentsText}

Devuelve SOLO JSON válido:
{
  "summary": "...",
  "sentiment": {"positive": 0, "neutral": 0, "negative": 0},
  "contentIdeas": ["..."],
  "insights": ["..."],
  "recommendedHooks": ["..."]
}`;

  const response = await openai.chat.completions.create({
    model: aiConfig.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 700
  });

  const raw = response.choices?.[0]?.message?.content?.trim() || '{}';
  const parsed = maybeParseJSON(raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim()) || {};

  const total = comments.length || 1;
  const sentiment = parsed.sentiment || {};

  return {
    summary: parsed.summary || 'Análisis completado.',
    sentiment: {
      positive: Number(sentiment.positive ?? 0),
      neutral: Number(sentiment.neutral ?? 0),
      negative: Number(sentiment.negative ?? 0)
    },
    sentimentRate: {
      positive: Number((((sentiment.positive ?? 0) / total) * 100).toFixed(1)),
      neutral: Number((((sentiment.neutral ?? 0) / total) * 100).toFixed(1)),
      negative: Number((((sentiment.negative ?? 0) / total) * 100).toFixed(1))
    },
    contentIdeas: Array.isArray(parsed.contentIdeas) ? parsed.contentIdeas : [],
    insights: Array.isArray(parsed.insights) ? parsed.insights : [],
    recommendedHooks: Array.isArray(parsed.recommendedHooks) ? parsed.recommendedHooks : []
  };
}

function saveCommentAnalytics(data) {
  const current = readJSONSafe(ANALYTICS_FILE, { analyses: [], insights: [] });
  current.analyses.unshift(data);
  current.analyses = current.analyses.slice(0, 200);

  const newInsights = Array.isArray(data.analysis?.insights) ? data.analysis.insights : [];
  current.insights = [...newInsights, ...(current.insights || [])].slice(0, 100);

  writeJSONSafe(ANALYTICS_FILE, current);
}

// ---------------- Automation backend ----------------
let automationState = readJSONSafe(AUTOMATION_FILE, {
  enabled: false,
  intervalMinutes: 60,
  mode: 'trending',
  manualTopic: '',
  autoPublish: true,
  lastRunAt: null,
  nextRunAt: null,
  running: false
});
let automationTimer = null;

function persistAutomationState() {
  writeJSONSafe(AUTOMATION_FILE, automationState);
}

async function runAutomationCycle() {
  if (!automationState.enabled || automationState.running) return;
  automationState.running = true;
  persistAutomationState();

  try {
    let topic = automationState.manualTopic || 'Tecnología';
    let source = 'manual';

    if (automationState.mode === 'trending') {
      const trends = await detectTrendingTopics(10);
      if (trends.length) {
        topic = trends[0].topic;
        source = trends[0].source;
      }
    }

    const result = await generateVideoPipeline({ topic, source: `auto_${source}` });

    if (automationState.autoPublish) {
      const desc = `${result.scriptData.description} ${(result.scriptData.hashtags || []).join(' ')}`.slice(0, 2200);
      await publishSessionToTikTok({ sessionId: result.sessionId, title: result.scriptData.title, description: desc });
    }

    automationState.lastRunAt = new Date().toISOString();
  } catch (err) {
    pushLog(`[Automation] error: ${err.message}`);
  } finally {
    automationState.running = false;
    automationState.nextRunAt = new Date(Date.now() + automationState.intervalMinutes * 60 * 1000).toISOString();
    persistAutomationState();
  }
}

function setupAutomation() {
  if (automationTimer) clearInterval(automationTimer);
  if (!automationState.enabled) return;

  automationState.nextRunAt = new Date(Date.now() + automationState.intervalMinutes * 60 * 1000).toISOString();
  persistAutomationState();

  automationTimer = setInterval(runAutomationCycle, automationState.intervalMinutes * 60 * 1000);
  pushLog(`[Automation] activo cada ${automationState.intervalMinutes} min`);
}
setupAutomation();

// ---------------- Endpoints ----------------
// Endpoint de diagnóstico de memoria
app.get('/api/diagnostics', (req, res) => {
  const used = process.memoryUsage();
  const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
  
  res.json({
    ok: true,
    memory: {
      rss: formatMB(used.rss),
      heapTotal: formatMB(used.heapTotal),
      heapUsed: formatMB(used.heapUsed),
      external: formatMB(used.external),
      arrayBuffers: formatMB(used.arrayBuffers || 0)
    },
    tempFiles: tempFiles.size,
    isGenerating,
    uptime: `${Math.floor(process.uptime() / 60)} minutos`,
    nodeVersion: process.version
  });
});

app.get('/health', async (req, res) => {
  const token = await readToken();
  const now = Math.floor(Date.now() / 1000);
  const tokenExpiry = token?.saved_at && token?.expires_in ? token.saved_at + token.expires_in : null;
  const tokenValid = token && (!tokenExpiry || now < tokenExpiry - 60);

  res.json({
    ok: true,
    version: 'toktrend3-pro-v12-voice-fullvideo',
    buildMarker: 'natural-voice-no-cut',
    aiModel: aiConfig.model,
    aiBaseURL: aiConfig.baseURL || 'https://api.openai.com/v1',
    abacus: {
      configured: Boolean(ABACUS_API_KEY),
      imageEndpoint: Boolean(ABACUS_IMAGE_API_URL),
      videoEndpoint: Boolean(ABACUS_VIDEO_API_URL),
      audioEndpoint: Boolean(ABACUS_AUDIO_API_URL)
    },
    media: {
      // Cómo se generan los visuales/voz en este despliegue:
      primaryVisual: AI_IMAGES_ENABLED && !PREFER_STOCK_VIDEO ? 'ai_generated_images' : (PREFER_STOCK_VIDEO ? 'stock_video' : 'real_images'),
      aiImages: AI_IMAGES_ENABLED, // imágenes cinematográficas generadas por IA (Pollinations/Flux)
      aiImageProvider: AI_IMAGES_ENABLED ? `pollinations:${POLLINATIONS_MODEL}` : null,
      preferStockVideo: PREFER_STOCK_VIDEO,
      stockVideo: Boolean(PEXELS_API_KEY || PIXABAY_API_KEY), // clips cinematográficos reales (opcional)
      pexels: Boolean(PEXELS_API_KEY),
      pixabay: Boolean(PIXABAY_API_KEY),
      freeImageSources: ['pollinations(ai)', 'openverse', 'wikimedia'], // siempre disponibles (sin key)
      ttsOpenAI: Boolean(ttsClient),
      ttsModel: ttsClient ? (process.env.TTS_MODEL || 'gpt-4o-mini-tts→tts-1-hd') : null,
      ttsVoice: ttsClient ? (process.env.TTS_VOICE || 'nova') : null,
      ttsFreeFallback: 'google-translate-tts' // siempre disponible (sin key)
    },
    automation: automationState,
    tiktokConnected: Boolean(token),
    tokenValid,
    tokenExpiresAt: tokenExpiry ? new Date(tokenExpiry * 1000).toISOString() : null,
    logs: appLogs.slice(-20)
  });
});

app.get('/api/trends', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 15), 30);
  const trends = await detectTrendingTopics(limit);
  res.json({ ok: true, trends });
});

// Compatibilidad legado
app.get('/api/generate', ensureAI, async (req, res) => {
  try {
    const topic = String(req.query.q || 'Historia del arte').slice(0, 200);
    const result = await generateVideoPipeline({ topic, source: 'manual_legacy' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 1) Generar video manual (con control de concurrencia)
app.post('/api/videos/manual', ensureAI, async (req, res) => {
  if (isGenerating) {
    return res.status(503).json({ ok: false, error: 'Ya hay un video generándose. Por favor espera 1-2 minutos e intenta de nuevo.' });
  }
  
  isGenerating = true;
  try {
    const topic = String(req.body.topic || '').trim();
    if (!topic) return res.status(400).json({ ok: false, error: 'topic es obligatorio' });
    const result = await generateVideoPipeline({ topic: topic.slice(0, 200), source: 'manual' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    isGenerating = false;
    // Forzar limpieza de memoria después de cada generación
    if (global.gc) global.gc();
  }
});

// 2) Generar video de trending (con control de concurrencia)
app.post('/api/videos/trending', ensureAI, async (req, res) => {
  if (isGenerating) {
    return res.status(503).json({ ok: false, error: 'Ya hay un video generándose. Por favor espera 1-2 minutos e intenta de nuevo.' });
  }
  
  isGenerating = true;
  try {
    const trends = await detectTrendingTopics(10);
    if (!trends.length) return res.status(503).json({ ok: false, error: 'No se pudieron detectar tendencias en este momento.' });
    const selected = trends[0];
    const result = await generateVideoPipeline({ topic: selected.topic, source: selected.source || 'trending' });
    res.json({ ...result, trend: selected, trends });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    isGenerating = false;
    // Forzar limpieza de memoria después de cada generación
    if (global.gc) global.gc();
  }
});

// 3) Configurar programación automática backend
app.post('/api/automation/schedule', async (req, res) => {
  const intervalMinutes = Math.max(5, Math.min(1440, Number(req.body.intervalMinutes || 60)));
  automationState = {
    ...automationState,
    enabled: Boolean(req.body.enabled),
    intervalMinutes,
    mode: req.body.mode === 'manual' ? 'manual' : 'trending',
    manualTopic: String(req.body.manualTopic || '').slice(0, 200),
    autoPublish: req.body.autoPublish !== false
  };
  persistAutomationState();
  setupAutomation();
  res.json({ ok: true, automation: automationState });
});

app.get('/api/automation/status', async (req, res) => {
  res.json({ ok: true, automation: automationState });
});

// 4) Historial y análisis comentarios
app.get('/api/history', async (req, res) => {
  const items = await getGeneratedRecords(50);
  res.json({ ok: true, items });
});

app.get('/api/videos/latest', async (req, res) => {
  const latest = await getLatestGeneratedVideo();
  if (!latest) return res.status(404).json({ ok: false, error: 'No hay video reciente disponible.' });
  res.json({ ok: true, video: latest });
});

app.post('/api/analytics/comments/analyze', ensureAI, async (req, res) => {
  try {
    const { videoId, topic } = req.body;
    if (!videoId) return res.status(400).json({ ok: false, error: 'videoId es obligatorio' });

    const comments = await fetchTikTokComments(videoId, 60);
    if (!comments.length) return res.json({ ok: true, comments: 0, analysis: null, message: 'No hay comentarios para analizar.' });

    const analysis = await analyzeCommentsWithAI(topic || 'tema general', comments);
    const record = {
      id: crypto.randomBytes(6).toString('hex'),
      videoId,
      topic: topic || null,
      commentsCount: comments.length,
      analyzedAt: new Date().toISOString(),
      analysis,
      sampleComments: comments.slice(0, 8).map((c) => c.text)
    };

    saveCommentAnalytics(record);
    if (db) {
      try { await db.collection('comment_analytics').doc(record.id).set(record); } catch {}
    }

    res.json({ ok: true, ...record });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/analytics/comments', async (req, res) => {
  try {
    if (db) {
      const snap = await db.collection('comment_analytics').orderBy('analyzedAt', 'desc').limit(30).get();
      const analyses = snap.docs.map((d) => d.data());
      return res.json({ ok: true, analyses });
    }
  } catch {}
  const local = readJSONSafe(ANALYTICS_FILE, { analyses: [] });
  res.json({ ok: true, analyses: (local.analyses || []).slice(0, 30) });
});

app.post('/api/publish', async (req, res) => {
  try {
    const { sessionId, title, description } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing sessionId' });
    const published = await publishSessionToTikTok({ sessionId, title, description });
    
    // Limpiar archivos temporales después de publicar exitosamente
    setTimeout(() => {
      const workDir = join(__dirname, 'public', 'videos', sessionId);
      try {
        if (fs.existsSync(workDir)) {
          fs.rmSync(workDir, { recursive: true, force: true });
          console.log(`[Cleanup] Directorio ${sessionId} eliminado después de publicar`);
        }
      } catch (err) {
        console.error(`[Cleanup] Error eliminando directorio ${sessionId}:`, err.message);
      }
    }, 5000); // 5 segundos después de publicar
    
    res.json({ ok: true, ...published });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tiktok/reply-comments', ensureAI, async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId' });
    const comments = await fetchTikTokComments(videoId, 20);
    if (!comments.length) return res.json({ ok: true, replied: 0, message: 'Sin comentarios.' });

    const tokenData = await getValidToken();
    if (!tokenData?.access_token) return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });

    let replied = 0;
    for (const comment of comments.slice(0, 8)) {
      const aiRes = await openai.chat.completions.create({
        model: aiConfig.model,
        messages: [{ role: 'user', content: `Responde en español en máximo 150 caracteres de forma natural y cálida a este comentario: "${comment.text}"` }],
        max_tokens: 80,
        temperature: 0.9
      });
      const replyText = (aiRes.choices?.[0]?.message?.content || 'Gracias por comentar.').trim().slice(0, 150);

      await axios.post('https://open.tiktokapis.com/v2/video/comment/reply/', {
        video_id: videoId,
        parent_comment_id: comment.id,
        text: replyText
      }, {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' }
      });
      replied += 1;
      await new Promise((r) => setTimeout(r, 1300));
    }

    res.json({ ok: true, replied, total: comments.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tiktok/disconnect', async (req, res) => {
  await deleteToken();
  res.json({ ok: true });
});

app.get('/api/tiktok/login', async (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).send('Missing TIKTOK_CLIENT_KEY');
  const state = crypto.randomBytes(8).toString('hex');
  const { verifier, challenge } = generatePKCE();
  storeVerifier(state, verifier);

  const scope = 'user.info.basic,video.publish,video.upload';
  res.redirect(`https://www.tiktok.com/v2/auth/authorize?client_key=${clientKey}&response_type=code&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`);
});

async function handleTikTokOAuthCallback(req, res) {
  const { code, error, state } = req.query;
  if (error) return res.send(`<h1>Error: ${error}</h1>`);
  if (!code) return res.status(400).send('No code');
  const verifier = getVerifier(state);
  if (!verifier) return res.status(400).send('<h1>Estado inválido.</h1>');

  try {
    const params = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    });
    const { data } = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' }
    });
    if (data.error) throw new Error(data.error_description || data.error);

    await writeToken(data);
    res.send('<div style="font-family:sans-serif;text-align:center;padding:50px"><h1 style="color:#10b981">✅ TikTok Conectado</h1><script>setTimeout(()=>window.close(),2500)</script></div>');
  } catch (err) {
    res.status(500).send(`<h1>Error conectando a TikTok</h1><pre>${err.response ? JSON.stringify(err.response.data, null, 2) : err.message}</pre><p>Revisa TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET y Redirect URI: <b>${REDIRECT_URI}</b></p>`);
  }
}
app.get('/api/tiktok/oauth/callback', handleTikTokOAuthCallback);
app.get('/api/tiktok/callback', handleTikTokOAuthCallback);

app.get('/api/tiktok/status', async (req, res) => {
  const token = await readToken();
  res.json({ connected: Boolean(token) });
});

app.all('/api/tiktok/webhook', (req, res) => {
  if (req.query.challenge) return res.send(req.query.challenge);
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
app.listen(port, () => console.log(`TokTrend Pro on :${port}`));
