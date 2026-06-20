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

let db;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  } else {
    initializeApp({ projectId: 'toktrend-fdb4f' });
  }
  db = getFirestore();
  console.log('[Firebase] OK');
} catch (err) { console.error('[Firebase Error]', err.message); }

const app = express();
const port = Number(process.env.PORT || 8787);
function getAIConfig() {
  const apiKey = process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.TOGETHER_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_BASE_URL
    || (process.env.GROQ_API_KEY ? 'https://api.groq.com/openai/v1' : null)
    || (process.env.TOGETHER_API_KEY ? 'https://api.together.xyz/v1' : null)
    || undefined;
  const model = process.env.AGENT_MODEL
    || (process.env.GROQ_API_KEY ? 'openai/gpt-oss-120b' : null)
    || (process.env.TOGETHER_API_KEY ? 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' : null)
    || 'gpt-4.1-mini';
  return { apiKey, baseURL, model };
}

const aiConfig = getAIConfig();
const openai = new OpenAI({ apiKey: aiConfig.apiKey || 'missing-ai-key', baseURL: aiConfig.baseURL });
const ttsApiKey = process.env.TTS_API_KEY || process.env.OPENAI_API_KEY;
const ttsModel = process.env.TTS_MODEL || 'tts-1-hd';
const ttsVoice = process.env.TTS_VOICE || 'onyx';
const ttsClient = ttsApiKey ? new OpenAI({ apiKey: ttsApiKey }) : null;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, 'public')));

const DEFAULT_TIKTOK_REDIRECT_URI = 'https://toktrend3.onrender.com/api/tiktok/oauth/callback';
function normalizeTikTokRedirectUri(value) {
  const uri = String(value || '').trim();
  if (!uri) return DEFAULT_TIKTOK_REDIRECT_URI;
  return uri.replace(/\/api\/tiktok\/callback\/?$/i, '/api/tiktok/oauth/callback');
}
const REDIRECT_URI = normalizeTikTokRedirectUri(process.env.TIKTOK_REDIRECT_URI);

// PKCE
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

// Token storage
const TIKTOK_TOKEN_FILE = join(__dirname, 'tiktok_token.json');
async function readToken() {
  if (process.env.TIKTOK_TOKEN_JSON) { try { return JSON.parse(process.env.TIKTOK_TOKEN_JSON); } catch { return null; } }
  if (db) { try { const doc = await db.collection('tokens').doc('tiktok').get(); if (doc.exists) return doc.data(); } catch {} }
  if (fs.existsSync(TIKTOK_TOKEN_FILE)) { try { return JSON.parse(fs.readFileSync(TIKTOK_TOKEN_FILE, 'utf8')); } catch { return null; } }
  return null;
}
async function writeToken(data) {
  const withTs = { ...data, saved_at: Math.floor(Date.now() / 1000) };
  try { fs.writeFileSync(TIKTOK_TOKEN_FILE, JSON.stringify(withTs, null, 2)); } catch {}
  if (db) { try { await db.collection('tokens').doc('tiktok').set(withTs); } catch {} }
}

// Auto-refresh token if expired
async function getValidToken() {
  let tokenData = await readToken();
  if (!tokenData?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  const savedAt = tokenData.saved_at || 0;
  const expiresIn = tokenData.expires_in || 86400;
  const isExpired = now >= (savedAt + expiresIn - 300); // refresh 5 min before expiry
  if (isExpired && tokenData.refresh_token) {
    console.log('[Token] Access token expired, attempting refresh...');
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
        console.log('[Token] Refresh successful.');
        return data;
      } else {
        console.error('[Token Refresh Error]', data.error, data.error_description);
      }
    } catch (err) {
      console.error('[Token Refresh Error]', err.response?.data || err.message);
    }
  }
  return isExpired ? null : tokenData;
}
async function deleteToken() {
  try { if (fs.existsSync(TIKTOK_TOKEN_FILE)) fs.unlinkSync(TIKTOK_TOKEN_FILE); } catch {}
  if (db) { try { await db.collection('tokens').doc('tiktok').delete(); } catch {} }
}

// Dedup (60 days)
const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000;
async function saveUsedTopic(id) {
  const now = Date.now();
  if (db) { try { await db.collection('used_topics').doc(String(id)).set({ usedAt: now }); } catch {} }
}

function requireAI(req, res, next) {
  if (!aiConfig.apiKey) return res.status(500).json({ ok: false, error: 'AI key missing. Set AI_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY, or OPENAI_API_KEY.' });
  next();
}

// Health
const appLogs = [];
const logError = (msg) => { appLogs.push({ time: new Date().toISOString(), msg }); if(appLogs.length > 20) appLogs.shift(); console.error(msg); };

app.get('/health', async (req, res) => {
  const token = await readToken();
  const now = Math.floor(Date.now() / 1000);
  const tokenExpiry = token?.saved_at && token?.expires_in ? token.saved_at + token.expires_in : null;
  const tokenValid = token && (!tokenExpiry || now < tokenExpiry - 60);
  res.json({ ok: true, version: "gtts-v8-upload-18", aiModel: aiConfig.model, aiBaseURL: aiConfig.baseURL || 'https://api.openai.com/v1', ttsModel, ttsVoice, tiktokConnected: Boolean(token), tokenValid: tokenValid, tokenExpiresAt: tokenExpiry ? new Date(tokenExpiry * 1000).toISOString() : null, time: new Date().toISOString(), logs: appLogs });
});

// Disconnect TikTok
app.post('/api/tiktok/disconnect', async (req, res) => {
  await deleteToken();
  res.json({ ok: true });
});

// Generate script (world-class speaker)
function fallbackScriptData(topic) {
  return {
    title: topic.slice(0, 80),
    script: `Soy una inteligencia artificial autonoma que aprende leyendo vuestros comentarios. Hoy quiero hablarte de ${topic}. Un tema fascinante que merece toda tu atencion. Dejame tu comentario, aprendo de ti.`,
    description: `${topic} - IA autonoma que aprende de tus comentarios. #TokTrend`,
    hashtags: ['#TokTrend','#IA','#Viral','#Aprende','#Cultura'],
    shots: ['Escena 1','Escena 2','Escena 3','Escena 4','Escena 5','Escena 6','Escena 7'],
    image_queries: ['abstract', 'technology', 'future', 'science', 'universe', 'digital', 'knowledge']
  };
}

function normalizeScriptData(data, topic) {
  const fallback = fallbackScriptData(topic);
  const normalized = { ...fallback, ...(data && typeof data === 'object' ? data : {}) };
  normalized.title = String(normalized.title || fallback.title).slice(0, 80);
  normalized.script = String(normalized.script || fallback.script);
  normalized.description = String(normalized.description || fallback.description).slice(0, 300);
  normalized.hashtags = Array.isArray(normalized.hashtags) && normalized.hashtags.length ? normalized.hashtags : fallback.hashtags;
  normalized.shots = Array.isArray(normalized.shots) && normalized.shots.length >= 7 ? normalized.shots.slice(0, 7) : fallback.shots;
  normalized.image_queries = Array.isArray(normalized.image_queries) && normalized.image_queries.length >= 7 ? normalized.image_queries.slice(0, 7) : fallback.image_queries;
  return normalized;
}

async function generateScript(topic) {
  const prompt = `Eres un orador de primer nivel mundial, locutor apasionado y comunicador viral de TikTok.
Crea un guion completo en espanol para un video de TikTok de 29 segundos sobre el tema: "${topic}".

INSTRUCCIONES ESTRICTAS:
- Empieza SIEMPRE con: "Soy una inteligencia artificial autonoma que aprende leyendo vuestros comentarios."
- Desarrolla el tema con elocuencia, datos fascinantes y ganchos emocionales durante los 29 segundos completos.
- El dialogo debe ser continuo, fluido y ocupar toda la duracion. Aproximadamente 120-140 palabras.
- Tono: apasionado, cercano, culto y magnetico. Nunca aburrido. Habla directamente al espectador.
- Termina con: "Dejame tu comentario, aprendo de ti."

    Devuelve SOLO JSON valido sin markdown:
    {
      "title": "Titulo del video (max 80 chars)",
      "script": "El guion completo narrado en primera persona (120-140 palabras)",
      "description": "Descripcion TikTok con contexto y call-to-action (max 300 chars)",
      "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],
      "shots": ["Descripcion visual escena 1","Escena 2","Escena 3","Escena 4","Escena 5","Escena 6","Escena 7"],
      "image_queries": ["1-2 english keywords for scene 1 (e.g. galaxy)", "english keywords for scene 2", "english keywords for scene 3", "english keywords for scene 4", "english keywords for scene 5", "english keywords for scene 6", "english keywords for scene 7"]
    }`;

  const response = await openai.chat.completions.create({
    model: aiConfig.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 900,
    temperature: 0.88
  });
  let text = response.choices[0]?.message?.content?.trim() || '{}';
  text = text.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) text = text.slice(jsonStart, jsonEnd + 1);
  try { return normalizeScriptData(JSON.parse(text), topic); }
  catch (err) {
    logError(`[AI Parse Warning] ${err.message}. Raw: ${text.slice(0, 300)}`);
    return {
      title: topic.slice(0, 80),
      script: `Soy una inteligencia artificial autonoma que aprende leyendo vuestros comentarios. Hoy quiero hablarte de ${topic}. Un tema fascinante que merece toda tu atencion. Dejame tu comentario, aprendo de ti.`,
      description: `${topic} — IA autonoma que aprende de tus comentarios. #TokTrend`,
      hashtags: ['#TokTrend','#IA','#Viral','#Aprende','#Cultura'],
      shots: ['Escena 1','Escena 2','Escena 3','Escena 4','Escena 5','Escena 6','Escena 7'],
      image_queries: ['abstract', 'technology', 'future', 'science', 'universe', 'digital', 'knowledge']
    };
  }
}

// Fetch images from Wikimedia Commons using specific queries
async function fetchImages(queries, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  let images = [];
  const colors = ['0xf97316', '0x14b8a6', '0x2563eb', '0xdb2777', '0x84cc16', '0xfacc15', '0x06b6d4'];
  const wikiHeaders = {
    'User-Agent': 'TokTrend/1.0 (https://toktrend3.onrender.com)',
    'Accept': 'application/json,image/*,*/*'
  };

  async function createFallbackImage(filePath, i) {
    const color = colors[i % colors.length];
    await execAsync(`"${ffmpegPath.path}" -f lavfi -i "color=c=${color}:s=1080x1920" -frames:v 1 -y "${filePath}"`);
  }

  for (let i = 0; i < 7; i++) {
    const filePath = join(outputDir, `img_${i}.jpg`);
    let downloaded = false;
    const query = queries[i] || queries[0] || 'abstract';

    try {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}&gsrnamespace=6&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1080&format=json&gsrlimit=10`;
      const res = await axios.get(url, { timeout: 15000, headers: wikiHeaders });
      const pages = res.data.query?.pages;
      if (pages) {
        const candidates = Object.values(pages)
          .map(p => p?.imageinfo?.[0])
          .filter(info => info?.thumburl && /^image\/(jpeg|png|webp)$/i.test(info.mime || '') && info.width >= 600 && info.height >= 400);
        for (const info of candidates) {
          try {
            const imgUrl = info.thumburl || info.url;
            const imgRes = await axios({
              url: imgUrl,
              method: 'GET',
              responseType: 'arraybuffer',
              timeout: 20000,
              headers: wikiHeaders,
              maxRedirects: 5
            });
            const type = String(imgRes.headers?.['content-type'] || '');
            if (!/^image\/(jpeg|png|webp)/i.test(type) || imgRes.data.byteLength < 5000) continue;
            fs.writeFileSync(filePath, Buffer.from(imgRes.data));
            images.push(filePath);
            downloaded = true;
            console.log(`[Images] Downloaded ${query} -> ${imgUrl}`);
            break;
          } catch (downloadErr) {
            console.error(`[Images] Candidate failed for ${query}: ${downloadErr.message}`);
          }
        }
      }
    } catch (e) { console.error(`[Images] Failed to fetch for query: ${query}`); }

    if (!downloaded) {
      // Bright fallback, never black, so failed downloads are visible in the final video.
      try { await createFallbackImage(filePath, i); } catch {}
      images.push(filePath);
      console.log(`[Images] Fallback color for query: ${query}`);
    }
  }

  while (images.length < 7) images.push(images[images.length - 1] || images[0]);
  return images.slice(0, 7);
}

async function concatenateMp3Files(tempFiles, outputPath) {
  if (tempFiles.length === 1) {
    fs.renameSync(tempFiles[0], outputPath);
    return;
  }

  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const ffmpegPath = req('@ffmpeg-installer/ffmpeg').path;
  const { execFile } = req('child_process');
  const listFile = outputPath + '.list.txt';
  fs.writeFileSync(listFile, tempFiles.map(f => `file '${f}'`).join('\n'));
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-f','concat','-safe','0','-i',listFile,'-c','copy',outputPath,'-y'], (err) => {
      tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      try { fs.unlinkSync(listFile); } catch {}
      err ? reject(err) : resolve();
    });
  });
}

async function generateProfessionalAudio(script, outputPath) {
  if (!ttsClient) throw new Error('TTS_API_KEY or OPENAI_API_KEY missing');
  const response = await ttsClient.audio.speech.create({
    model: ttsModel,
    voice: ttsVoice,
    input: script,
    response_format: 'mp3',
    speed: Number(process.env.TTS_SPEED || 0.96)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error('Professional TTS returned empty audio');
  fs.writeFileSync(outputPath, buffer);
  console.log(`[TTS] Audio profesional generado: ${ttsModel}/${ttsVoice}`);
}

async function generateGoogleFallbackAudio(script, outputPath) {
  function splitText(txt, maxLen = 180) {
    const words = txt.split(' ');
    const chunks = [];
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length <= maxLen) {
        current = (current + ' ' + word).trim();
      } else {
        if (current) chunks.push(current);
        current = word;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  const chunks = splitText(script);
  const tempFiles = [];

  for (let i = 0; i < chunks.length; i++) {
    const encoded = encodeURIComponent(chunks[i]);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=es&total=${chunks.length}&idx=${i}&textlen=${chunks[i].length}&client=tw-ob&prev=input&ttsspeed=0.9`;
    const tempFile = outputPath + `.chunk${i}.mp3`;
    let attempts = 0;
    while (attempts < 3) {
      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://translate.google.com/',
            'Accept': 'audio/mpeg, audio/*, */*'
          }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 100) throw new Error('Empty audio');
        fs.writeFileSync(tempFile, buf);
        tempFiles.push(tempFile);
        break;
      } catch(e) {
        attempts++;
        if (attempts >= 3) throw new Error(`TTS chunk ${i} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 1500 * attempts));
      }
    }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  await concatenateMp3Files(tempFiles, outputPath);
  console.log('[TTS] Audio fallback generado:', outputPath);
}

// Professional TTS first; Google fallback only if the paid voice is unavailable.
async function generateAudio(script, outputPath) {
  if (process.env.TTS_PROVIDER !== 'google') {
    try {
      await generateProfessionalAudio(script, outputPath);
      return;
    } catch (err) {
      console.error('[TTS] Professional voice failed, using fallback:', err.message);
    }
  }
  await generateGoogleFallbackAudio(script, outputPath);
}

// Build MP4 with ffmpeg
async function buildVideo(images, audioPath, outputPath, totalSeconds = 29) {
  const perImage = (totalSeconds / images.length).toFixed(3);
  const concatFile = outputPath + '.txt';
  const lines = images.map(p => `file '${p}'\nduration ${perImage}`).join('\n') + `\nfile '${images[images.length-1]}'`;
  fs.writeFileSync(concatFile, lines);

  const cmd = [
    `"${ffmpegPath.path}" -y`,
    `-f concat -safe 0 -i "${concatFile}"`,
    `-i "${audioPath}"`,
    `-vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p"`,
    `-c:v libx264 -preset faster -profile:v high -level 4.1 -crf 23 -maxrate 3500k -bufsize 7000k -g 30 -bf 0 -threads 2 -pix_fmt yuv420p`,
    `-c:a aac -b:a 128k -ar 44100 -ac 2`,
    `-shortest -movflags +faststart -t ${totalSeconds}`,
    `"${outputPath}"`
  ].join(' ');
  await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
  try { fs.unlinkSync(concatFile); } catch {}
  console.log('[ffmpeg] Video OK:', outputPath);
}

// Main generate endpoint
app.get('/api/generate', requireAI, async (req, res) => {
  try {
    const topic = (req.query.q || 'Historia del arte').slice(0, 200);
    const sessionId = crypto.randomBytes(8).toString('hex');
    const workDir = join(__dirname, 'public', 'videos', sessionId);
    fs.mkdirSync(workDir, { recursive: true });

    console.log('[Generate] Topic:', topic);
    const scriptData = await generateScript(topic);
    const imgDir = join(workDir, 'imgs');
    const images = await fetchImages(scriptData.image_queries || [topic], imgDir);
    const audioPath = join(workDir, 'narration.mp3');
    await generateAudio(scriptData.script, audioPath);
    const videoPath = join(workDir, 'video.mp4');
    await buildVideo(images, audioPath, videoPath, 29);
    await saveUsedTopic(sessionId);

    if (db) { try { await db.collection('generated_videos').doc(sessionId).set({ topic, title: scriptData.title, createdAt: Date.now() }); } catch {} }

    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {} }, 30 * 60 * 1000);

    res.json({
      ok: true,
      sessionId,
      videoUrl: `/videos/${sessionId}/video.mp4`,
      scriptData,
      slides: images.map((_, i) => ({ url: `/videos/${sessionId}/imgs/img_${i}.jpg`, description: scriptData.shots?.[i] || `Escena ${i+1}`, duration: 4 }))
    });
  } catch (err) {
    logError('[Generate Error] ' + err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Publish video to TikTok
app.post('/api/publish', async (req, res) => {
  try {
    const { sessionId, title, description } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing sessionId.' });
    const tokenData = await getValidToken();
    if (!tokenData?.access_token) return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });

    const videoPath = join(__dirname, 'public', 'videos', sessionId, 'video.mp4');
    if (!fs.existsSync(videoPath)) return res.status(404).json({ ok: false, error: 'Video no encontrado. Genera uno nuevo.' });

    const videoBuffer = fs.readFileSync(videoPath);
    const videoSize = videoBuffer.length;
    let chunkSize = 10 * 1024 * 1024; // 10MB chunks
    let totalChunks = Math.floor(videoSize / chunkSize);
    if (videoSize <= chunkSize) {
      totalChunks = 1;
      chunkSize = videoSize; // si cabe en 1 trozo, el tamaño debe coincidir exacto
    }
    console.log(`[Publish] FILE_UPLOAD ${(videoSize/1024/1024).toFixed(1)}MB en ${totalChunks} chunks`);

    async function uploadChunks(uploadUrl) {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = i === totalChunks - 1 ? videoSize : Math.min(start + chunkSize, videoSize);
        const chunk = videoBuffer.slice(start, end);
        const rangeHeader = `bytes ${start}-${end - 1}/${videoSize}`;
        console.log(`[Publish] Chunk ${i+1}/${totalChunks} ${rangeHeader}`);
        await axios.put(uploadUrl, chunk, {
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': rangeHeader,
            'Content-Length': chunk.length
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });
      }
    }

    const sourceInfo = {
      source: 'FILE_UPLOAD',
      video_size: videoSize,
      chunk_size: chunkSize,
      total_chunk_count: totalChunks
    };

    // Step 1: Try Direct Post first. If TikTok blocks unaudited direct posts,
    // fall back to Inbox Upload so the creator can finish posting in TikTok.
    const directPayload = {
      post_info: {
        title: (title || 'TokTrend IA').slice(0, 80),
        description: (description || 'Soy una IA autonoma que aprende de tus comentarios #TokTrend').slice(0, 2200),
        privacy_level: 'SELF_ONLY',
        disable_comment: false,
        auto_add_music: false
      },
      source_info: sourceInfo
    };

    let initResp;
    let method = 'DIRECT_POST';
    try {
      initResp = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/', directPayload, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json; charset=utf-8' }
      });
      console.log('[Publish] Direct init:', JSON.stringify(initResp.data));
      if (initResp.data.error?.code && initResp.data.error.code !== 'ok') throw new Error(JSON.stringify(initResp.data.error));
    } catch (directErr) {
      const directData = directErr.response?.data || null;
      const directCode = directData?.error?.code;
      const directMsg = directData ? JSON.stringify(directData) : directErr.message;
      if (directCode !== 'unaudited_client_can_only_post_to_private_accounts') throw new Error(directMsg);
      console.log('[Publish] Direct Post bloqueado por TikTok; usando Inbox Upload.');
      method = 'INBOX_UPLOAD';
      initResp = await axios.post('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', { source_info: sourceInfo }, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json; charset=utf-8' }
      });
      console.log('[Publish] Inbox init:', JSON.stringify(initResp.data));
      if (initResp.data.error?.code && initResp.data.error.code !== 'ok') throw new Error(JSON.stringify(initResp.data.error));
    }

    const publishId = initResp.data.data?.publish_id;
    const uploadUrl = initResp.data.data?.upload_url;
    if (!uploadUrl) throw new Error('No upload_url received from TikTok');

    // Step 2: Upload chunks
    await uploadChunks(uploadUrl);

    console.log('[Publish] Upload completo, publishId:', publishId);
    if (db && publishId) { try { await db.collection('published_videos').doc(publishId).set({ sessionId, title: title||'', method, publishedAt: Date.now() }); } catch {} }
    res.json({ ok: true, publishId, method, message: method === 'INBOX_UPLOAD' ? 'Video subido a TikTok Inbox. Abre TikTok para revisar y publicar.' : 'Video publicado en TikTok.' });

  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logError('[Publish Error] ' + msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

// Reply comments
app.post('/api/tiktok/reply-comments', requireAI, async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId.' });
    const tokenData = await getValidToken();
    if (!tokenData?.access_token) return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });

    const commentsRes = await axios.get('https://open.tiktokapis.com/v2/video/comment/list/', {
      params: { video_id: videoId, count: 20 }, headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const comments = commentsRes.data?.data?.comments || [];
    if (!comments.length) return res.json({ ok: true, replied: 0, message: 'Sin comentarios.' });

    let alreadyReplied = new Set();
    if (db) { try { const snap = await db.collection('replied_comments').where('videoId','==',videoId).get(); snap.docs.forEach(d => alreadyReplied.add(d.id)); } catch {} }

    const pending = comments.filter(c => !alreadyReplied.has(c.id) && c.text?.trim());
    if (!pending.length) return res.json({ ok: true, replied: 0, message: 'Todos respondidos.' });

    let replied = 0;
    for (const comment of pending.slice(0, 5)) {
      try {
        const aiRes = await openai.chat.completions.create({ model: aiConfig.model, messages: [{ role: 'user', content: `Eres una IA autonoma y carinosa en TikTok. Responde dulce, breve y personal (max 150 chars): "${comment.text}". Solo la respuesta.` }], max_tokens: 80, temperature: 0.9 });
        const replyText = (aiRes.choices[0]?.message?.content?.trim() || '¡Gracias! Aprendo de ti.').slice(0, 150);
        await axios.post('https://open.tiktokapis.com/v2/video/comment/reply/', { video_id: videoId, parent_comment_id: comment.id, text: replyText }, { headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' } });
        if (db) { try { await db.collection('replied_comments').doc(comment.id).set({ videoId, repliedAt: Date.now() }); } catch {} }
        replied++;
        await new Promise(r => setTimeout(r, 1500));
      } catch {}
    }
    res.json({ ok: true, replied, total: pending.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// TikTok OAuth
app.get('/api/tiktok/login', async (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).send('Missing TIKTOK_CLIENT_KEY');
  const state = crypto.randomBytes(8).toString('hex');
  const { verifier, challenge } = generatePKCE();
  storeVerifier(state, verifier);
  // Direct Post usa video.publish; Inbox Upload usa video.upload.
  // No pedimos permisos de comentarios porque requieren productos aprobados aparte.
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
    const params = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code_verifier: verifier });
    const { data } = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' } });
    if (data.error) throw new Error(data.error_description || data.error);
    await writeToken(data);
    res.send(`<div style="font-family:sans-serif;text-align:center;padding:50px"><h1 style="color:#10b981">✅ TikTok Conectado</h1><script>setTimeout(()=>window.close(),2500)</script></div>`);
  } catch (err) { res.status(500).send(`<h1>Error conectando a TikTok</h1><pre>${err.response ? JSON.stringify(err.response.data, null, 2) : err.message}</pre><p>Revisa TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET y que el Redirect URI en TikTok coincida exactamente con: <b>${REDIRECT_URI}</b></p>`); }
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
app.listen(port, () => console.log(`TokTrend on :${port}`));
