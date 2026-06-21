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

Formato exacto:
{
 "title": "...",
 "script": "...",
 "description": "...",
 "hashtags": ["#..."],
 "shots": ["..."],
 "image_queries": ["english prompt ..."]
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

async function fetchFallbackImage(query, outputPath, idx = 0) {
  const colors = ['0xf97316', '0x14b8a6', '0x2563eb', '0xdb2777', '0x84cc16', '0x8b5cf6', '0x22d3ee'];
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}&gsrnamespace=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=1080&format=json&gsrlimit=8`;
    const { data } = await axios.get(url, { timeout: 12000 });
    const pages = Object.values(data?.query?.pages || {});
    const candidate = pages.map((p) => p?.imageinfo?.[0]).find((img) => img?.thumburl);
    if (candidate?.thumburl) {
      const imgResp = await axios.get(candidate.thumburl, { responseType: 'arraybuffer', timeout: 15000 });
      fs.writeFileSync(outputPath, Buffer.from(imgResp.data));
      return true;
    }
  } catch {}

  // Resolución reducida para ahorrar memoria (720x1280 en vez de 1080x1920)
  await execAsync(`"${ffmpegPath.path}" -f lavfi -i "color=c=${colors[idx % colors.length]}:s=720x1280" -frames:v 1 -y "${outputPath}"`);
  registerTempFile(outputPath);
  return true;
}

async function generateImages(prompts, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const imagePaths = [];
  // Reducido de 7 a 5 imágenes para optimizar memoria
  for (let i = 0; i < 5; i++) {
    const p = prompts[i] || prompts[0] || 'cinematic storytelling';
    const outPath = join(outputDir, `img_${i}.jpg`);
    let ok = false;

    if (ABACUS_IMAGE_API_URL && ABACUS_API_KEY) {
      ok = await generateImageWithAbacus(p, outPath);
    }
    if (!ok) {
      await fetchFallbackImage(p, outPath, i);
    }
    imagePaths.push(outPath);
  }
  return imagePaths;
}

async function generateNarration(script, outputPath) {
  let generated = false;
  if (ABACUS_AUDIO_API_URL && ABACUS_API_KEY) {
    generated = await generateNarrationWithAbacus(script, outputPath);
  }

  if (!generated) {
    if (!ttsClient) throw new Error('TTS no configurado. Configura OPENAI_API_KEY o TTS_API_KEY.');
    const tts = await ttsClient.audio.speech.create({
      model: process.env.TTS_MODEL || 'tts-1-hd',
      voice: process.env.TTS_VOICE || 'nova',
      input: script,
      response_format: 'mp3',
      speed: Number(process.env.TTS_SPEED || 0.95)
    });
    fs.writeFileSync(outputPath, Buffer.from(await tts.arrayBuffer()));
  }
}

function estimateSeconds(script) {
  const words = String(script || '').split(/\s+/).filter(Boolean).length;
  return Math.max(30, Math.min(55, Math.ceil(words / 2.4)));
}

async function buildCinematicVideo(images, audioPath, outputPath, totalSeconds) {
  const perImage = (totalSeconds / images.length).toFixed(2);
  const imageInputs = images.map((p) => `-loop 1 -t ${perImage} -i "${p}"`).join(' ');

  // Resolución reducida para ahorrar memoria (720x1280 en vez de 1080x1920)
  const visualFilters = images.map((_, i) => {
    const zoomStart = 1.0 + (i % 3) * 0.03;
    const zoomEnd = zoomStart + 0.1;
    return `[${i}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=z='if(lte(on,1),${zoomStart},min(zoom+0.0012,${zoomEnd}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=75:s=720x1280,fps=30,format=yuv420p[v${i}]`;
  }).join(';');

  const concatChain = images.map((_, i) => `[v${i}]`).join('');
  const filter = `${visualFilters};${concatChain}concat=n=${images.length}:v=1:a=0[v]`;

  const cmd = [
    `"${ffmpegPath.path}" -y`,
    imageInputs,
    `-i "${audioPath}"`,
    `-filter_complex "${filter}"`,
    `-map "[v]" -map ${images.length}:a`,
    '-c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p',
    '-c:a aac -b:a 192k -ar 48000 -ac 2',
    `-shortest -t ${totalSeconds} -movflags +faststart`,
    `"${outputPath}"`
  ].join(' ');

  await execAsync(cmd, { maxBuffer: 150 * 1024 * 1024 });
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

async function getLearningContext() {
  const analytics = readJSONSafe(ANALYTICS_FILE, { insights: [] });
  return (analytics.insights || []).slice(0, 8).join(' | ');
}

async function generateVideoPipeline({ topic, source = 'manual' }) {
  const sessionId = crypto.randomBytes(8).toString('hex');
  const workDir = join(__dirname, 'public', 'videos', sessionId);
  fs.mkdirSync(workDir, { recursive: true });

  const learningContext = await getLearningContext();
  const scriptData = await generateScript(topic, learningContext);
  const imgDir = join(workDir, 'imgs');
  const images = await generateImages(scriptData.image_queries || [topic], imgDir);
  
  // Registrar imágenes para limpieza
  images.forEach(img => registerTempFile(img));
  
  const audioPath = join(workDir, 'narration.mp3');
  await generateNarration(scriptData.script, audioPath);
  registerTempFile(audioPath);

  const videoPath = join(workDir, 'video.mp4');
  registerTempFile(videoPath);
  
  const duration = estimateSeconds(scriptData.script);

  let usedAbacusVideo = false;
  if (ABACUS_VIDEO_API_URL && ABACUS_API_KEY) {
    usedAbacusVideo = await generateVideoWithAbacus(scriptData.shots, videoPath);
  }
  if (!usedAbacusVideo) {
    await buildCinematicVideo(images, audioPath, videoPath, duration);
  }

  const record = {
    sessionId,
    topic,
    source,
    title: scriptData.title,
    createdAt: Date.now(),
    duration,
    usedAbacusVideo,
    hasAbacusImage: Boolean(ABACUS_IMAGE_API_URL && ABACUS_API_KEY),
    hasAbacusAudio: Boolean(ABACUS_AUDIO_API_URL && ABACUS_API_KEY)
  };
  await saveGeneratedRecord(record);

  setTimeout(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 60 * 60 * 1000);

  return {
    ok: true,
    sessionId,
    topic,
    duration,
    videoUrl: `/videos/${sessionId}/video.mp4`,
    scriptData,
    slides: images.map((_, i) => ({
      url: `/videos/${sessionId}/imgs/img_${i}.jpg`,
      description: scriptData.shots?.[i] || `Escena ${i + 1}`,
      duration: Number((duration / images.length).toFixed(1))
    }))
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
    version: 'toktrend3-pro-v9',
    aiModel: aiConfig.model,
    aiBaseURL: aiConfig.baseURL || 'https://api.openai.com/v1',
    abacus: {
      configured: Boolean(ABACUS_API_KEY),
      imageEndpoint: Boolean(ABACUS_IMAGE_API_URL),
      videoEndpoint: Boolean(ABACUS_VIDEO_API_URL),
      audioEndpoint: Boolean(ABACUS_AUDIO_API_URL)
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
  try {
    if (db) {
      const snap = await db.collection('generated_videos').orderBy('createdAt', 'desc').limit(50).get();
      const items = snap.docs.map((d) => d.data());
      return res.json({ ok: true, items });
    }
  } catch {}
  const items = readJSONSafe(join(STORAGE_DIR, 'generated_videos.json'), []);
  res.json({ ok: true, items: items.slice(0, 50) });
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
