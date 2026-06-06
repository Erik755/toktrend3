import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

dotenv.config();

// ── Firebase ──────────────────────────────────────────────────────────────────
let db;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
    console.log('[Firebase] Inicializado con Service Account.');
  } else {
    initializeApp({ projectId: 'toktrend-fdb4f' });
    console.log('[Firebase] Inicializado con Application Default Credentials.');
  }
  db = getFirestore();
} catch (err) {
  console.error('[Firebase Error]', err.message);
}

const app = express();
const port = Number(process.env.PORT || 8787);
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, 'public')));

const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || 'https://toktrend3.onrender.com/api/tiktok/callback';

// ── PKCE helpers ──────────────────────────────────────────────────────────────
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

// ── Token storage ─────────────────────────────────────────────────────────────
const TIKTOK_TOKEN_FILE = join(__dirname, 'tiktok_token.json');

async function readToken() {
  if (process.env.TIKTOK_TOKEN_JSON) {
    try { return JSON.parse(process.env.TIKTOK_TOKEN_JSON); } catch { return null; }
  }
  if (db) {
    try {
      const doc = await db.collection('tokens').doc('tiktok').get();
      if (doc.exists) return doc.data();
    } catch (err) { console.error('[Firebase Error] Leyendo token:', err.message); }
  }
  if (fs.existsSync(TIKTOK_TOKEN_FILE)) {
    try { return JSON.parse(fs.readFileSync(TIKTOK_TOKEN_FILE, 'utf8')); } catch { return null; }
  }
  return null;
}

async function writeToken(data) {
  try { fs.writeFileSync(TIKTOK_TOKEN_FILE, JSON.stringify(data, null, 2)); } catch {}
  if (db) {
    try {
      await db.collection('tokens').doc('tiktok').set(data);
      console.log('[Firebase] Token guardado en Firestore.');
    } catch (err) { console.error('[Firebase Error] Escribiendo token:', err.message); }
  }
  console.log('[Token] Guardado:', JSON.stringify(data));
}

// ── Obras usadas — no repetir en 60 días (Firestore) ─────────────────────────
const USED_ART_FILE = join(__dirname, 'used_artworks.json');
const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000;

async function getUsedArtworkIds() {
  if (db) {
    try {
      const snap = await db.collection('used_artworks')
        .where('usedAt', '>', Date.now() - TWO_MONTHS_MS)
        .get();
      return snap.docs.map(d => d.id);
    } catch (err) { console.error('[Firebase Error] Leyendo obras usadas:', err.message); }
  }
  // fallback local
  if (fs.existsSync(USED_ART_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(USED_ART_FILE, 'utf8'));
      const cutoff = Date.now() - TWO_MONTHS_MS;
      return data.filter(e => e.usedAt > cutoff).map(e => e.id);
    } catch {}
  }
  return [];
}

async function saveUsedArtwork(id) {
  const now = Date.now();
  if (db) {
    try {
      await db.collection('used_artworks').doc(String(id)).set({ usedAt: now });
    } catch (err) { console.error('[Firebase Error] Guardando obra usada:', err.message); }
  }
  // también local
  try {
    let data = [];
    if (fs.existsSync(USED_ART_FILE)) data = JSON.parse(fs.readFileSync(USED_ART_FILE, 'utf8'));
    data = data.filter(e => e.id !== id);
    data.push({ id, usedAt: now });
    fs.writeFileSync(USED_ART_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

const PUBLISHED_VIDEOS_FILE = join(__dirname, 'published_videos.json');
const COMMENT_LEARNING_FILE = join(__dirname, 'comment_learning.json');

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonFile(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

async function savePublishedVideo(publishId, data) {
  if (!publishId) return;
  const payload = { ...data, publishId, publishedAt: data.publishedAt || Date.now() };
  if (db) {
    try { await db.collection('published_videos').doc(publishId).set(payload, { merge: true }); }
    catch (e) { console.error('[Firebase] Error guardando video publicado:', e.message); }
  }

  const local = readJsonFile(PUBLISHED_VIDEOS_FILE, []);
  const next = local.filter(v => v.publishId !== publishId);
  next.push(payload);
  writeJsonFile(PUBLISHED_VIDEOS_FILE, next.slice(-100));
}

async function getRecentPublishedVideos(days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const videos = new Map();

  if (db) {
    try {
      const snap = await db.collection('published_videos')
        .where('publishedAt', '>', cutoff)
        .get();
      snap.docs.forEach(doc => videos.set(doc.id, { publishId: doc.id, ...doc.data() }));
    } catch (err) { console.error('[Firebase Error] Leyendo videos publicados:', err.message); }
  }

  for (const item of readJsonFile(PUBLISHED_VIDEOS_FILE, [])) {
    if ((item.publishedAt || 0) > cutoff) videos.set(item.publishId, item);
  }

  return [...videos.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
}

async function readCommentLearning() {
  if (db) {
    try {
      const doc = await db.collection('agent_learning').doc('comments').get();
      if (doc.exists) return doc.data();
    } catch (err) { console.error('[Firebase Error] Leyendo aprendizaje:', err.message); }
  }
  return readJsonFile(COMMENT_LEARNING_FILE, {
    updatedAt: null,
    totalComments: 0,
    seenCommentIds: [],
    topKeywords: [],
    audienceQuestions: [],
    recentComments: []
  });
}

async function writeCommentLearning(data) {
  const clean = {
    ...data,
    seenCommentIds: [...new Set(data.seenCommentIds || [])].slice(-500),
    recentComments: (data.recentComments || []).slice(-80),
    audienceQuestions: (data.audienceQuestions || []).slice(-20),
    topKeywords: (data.topKeywords || []).slice(0, 12)
  };
  if (db) {
    try { await db.collection('agent_learning').doc('comments').set(clean, { merge: true }); }
    catch (err) { console.error('[Firebase Error] Guardando aprendizaje:', err.message); }
  }
  writeJsonFile(COMMENT_LEARNING_FILE, clean);
  return clean;
}

function summarizeComments(comments) {
  const stopwords = new Set('para como porque gracias hola obra arte video este esta estos estas una uno unos unas que los las con por del de la el en y a un me te se es al lo su tu mi muy mas más pero ver quiero sigo sigue seguir evolucion evolución comentario comentarios'.split(' '));
  const counts = new Map();
  const questions = [];

  for (const comment of comments) {
    const text = safeString(comment.text, 300);
    if (!text) continue;
    if (text.includes('?') || text.includes('¿')) questions.push(text);
    const words = text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9ñ\s#]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopwords.has(w));
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  }

  return {
    topKeywords: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([word, count]) => ({ word, count })),
    audienceQuestions: questions.slice(-20)
  };
}

async function updateLearningFromComments(videoId, comments) {
  const previous = await readCommentLearning();
  const seen = new Set(previous.seenCommentIds || []);
  const fresh = comments
    .filter(c => c?.id && c?.text && !seen.has(c.id))
    .map(c => ({ id: c.id, videoId, text: safeString(c.text, 300), readAt: Date.now() }));

  const recentComments = [...(previous.recentComments || []), ...fresh];
  const summary = summarizeComments(recentComments);
  const next = await writeCommentLearning({
    ...previous,
    updatedAt: Date.now(),
    totalComments: (previous.totalComments || 0) + fresh.length,
    seenCommentIds: [...seen, ...fresh.map(c => c.id)],
    recentComments,
    topKeywords: summary.topKeywords,
    audienceQuestions: summary.audienceQuestions
  });

  return { commentsRead: comments.length, newComments: fresh.length, learning: next };
}

async function learnFromVideoComments(videoId, tokenData) {
  const commentsRes = await axios.get('https://open.tiktokapis.com/v2/video/comment/list/', {
    params: { video_id: videoId, count: 20 },
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
  });
  const comments = commentsRes.data?.data?.comments || [];
  return updateLearningFromComments(videoId, comments);
}

async function fetchPublishStatus(publishId, tokenData) {
  if (!publishId) return null;
  const { data } = await axios.post('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
    publish_id: publishId
  }, {
    headers: {
      'Authorization': `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json'
    }
  });
  return data;
}

function extractPostId(statusData) {
  const data = statusData?.data || statusData || {};
  if (Array.isArray(data.post_id) && data.post_id.length) return String(data.post_id[0]);
  if (data.post_id) return String(data.post_id);
  if (data.video_id) return String(data.video_id);
  return null;
}

async function resolveCommentVideoId(item, tokenData) {
  if (item.videoId && item.videoId !== item.publishId) return item.videoId;
  if (!item.publishId) return item.videoId;
  try {
    const status = await fetchPublishStatus(item.publishId, tokenData);
    const postId = extractPostId(status);
    if (postId) {
      await savePublishedVideo(item.publishId, { ...item, videoId: postId, publishStatus: status, publishedAt: item.publishedAt || Date.now() });
      return postId;
    }
  } catch (err) {
    console.error('[Publish Status Error]', err.response?.data || err.message);
  }
  return item.videoId || item.publishId;
}

function learningContextText(learning) {
  const keywords = (learning?.topKeywords || []).map(k => k.word || k).filter(Boolean).slice(0, 8).join(', ');
  const questions = (learning?.audienceQuestions || []).slice(-3).join(' | ');
  if (!keywords && !questions) return 'Aún no hay aprendizajes recientes de comentarios.';
  return `Aprendizajes recientes de comentarios. Temas que interesan: ${keywords || 'sin keywords claras'}. Preguntas o señales del público: ${questions || 'sin preguntas recientes'}.`;
}

function buildPublishDescription(title, artist, learning) {
  const top = (learning?.topKeywords || []).map(k => k.word || k).filter(Boolean).slice(0, 3);
  const learnedSignal = top.length ? ` Aprendí que mi audiencia conecta con: ${top.join(', ')}.` : '';
  return `Descubre "${title}" de ${artist}: una historia breve, visual y contada con voz de orador.${learnedSignal} Sígueme para ver mi evolución como IA creadora. #TokTrend #Arte #HistoriaDelArte #Cultura #Museo #AprendeEnTikTok`;
}

function pickAutonomousTopic(topics = [], learning = {}) {
  if (!Array.isArray(topics)) topics = [safeString(topics, 80)];
  const learned = (learning.topKeywords || []).map(k => k.word || k).find(Boolean);
  if (learned) return learned;
  const map = {
    Historia: 'Van Gogh',
    Tecnología: 'modern art',
    Curiosidades: 'surrealism',
    Noticias: 'impressionism',
    Educación: 'Monet'
  };
  const selected = topics.find(t => map[t]);
  return map[selected] || 'Van Gogh';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function requireOpenAI(req, res, next) {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY missing.' });
  next();
}
function safeString(value, max = 4000) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const token = await readToken();
  res.json({
    ok: true,
    service: 'toktrend-openai-agent-backend',
    provider: 'openai',
    openaiKeyLoaded: Boolean(process.env.OPENAI_API_KEY),
    tiktokRedirectUri: REDIRECT_URI,
    tiktokConnected: Boolean(token),
    time: new Date().toISOString()
  });
});

// ── Agent (plan de video genérico) ───────────────────────────────────────────
app.post('/api/agent', requireOpenAI, async (req, res) => {
  try {
    const topic = safeString(req.body.topic, 1200);
    const style = safeString(req.body.style || 'cinematic', 100);
    const seconds = safeString(req.body.seconds || '16', 10);
    const size = safeString(req.body.size || '1080x1920', 20);
    if (!topic) return res.status(400).json({ ok: false, error: 'Missing topic.' });
    const prompt = 'Act like a world-class public speaker, storyteller, and short-form video strategist. Create a safe cinematic video plan for a general audience. Return ONLY valid JSON with keys title, hook, narration, shots, video_prompt, description, hashtags. Topic: ' + topic + '. Style: ' + style + '. Duration: ' + seconds + ' seconds. Format: ' + size + '. Make the narration emotionally compelling, memorable, and paced like a premium keynote speaker. The narration must match the video duration when read aloud, leave the final seconds for a warm farewell, and ask viewers to follow to see the AI evolve. Include a publish-ready video description and 6 to 10 relevant hashtags. Avoid copyrighted characters, logos, real people, adult content, copyrighted music. Make video_prompt highly visual.';
    const response = await openai.responses.create({ model: process.env.AGENT_MODEL || 'gpt-4.1', input: prompt, temperature: 0.8 });
    let text = response.output_text || '';
    if (!text && Array.isArray(response.output)) {
      const msg = response.output.find(o => o.type === 'message');
      text = msg?.content?.find(c => c.type === 'output_text')?.text || '{}';
    }
    text = text.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
    let plan;
    try { plan = JSON.parse(text); }
    catch { plan = { title: 'Cinematic video', hook: '', narration: '', shots: [], video_prompt: text, description: 'Contenido creado con TokTrend para inspirar y captar la atención desde el primer segundo.', hashtags: ['#TokTrend'] }; }
    if (!plan.video_prompt) plan.video_prompt = topic;
    if (!plan.description) plan.description = `Mira este video sobre ${topic}. Una historia breve, visual y pensada para enganchar desde el primer segundo.`;
    if (!Array.isArray(plan.hashtags) || plan.hashtags.length === 0) plan.hashtags = ['#TokTrend', '#IA', '#Video', '#Storytelling'];
    res.json({ ok: true, provider: 'openai', plan });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Video Sora ────────────────────────────────────────────────────────────────
app.post('/api/video', requireOpenAI, async (req, res) => {
  try {
    const prompt = safeString(req.body.prompt || req.body.topic, 4000);
    const model = safeString(req.body.model || 'sora-2-pro', 50);
    const size = safeString(req.body.size || '1080x1920', 20);
    const seconds = safeString(req.body.seconds || '16', 10);
    if (!prompt) return res.status(400).json({ ok: false, error: 'Missing prompt.' });
    const safeSeconds = ['4', '8', '12'].includes(seconds) ? seconds : '8';
    const video = await openai.videos.create({ model, prompt, size, seconds: safeSeconds });
    res.json({ ok: true, provider: 'openai', video });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/video/:id', requireOpenAI, async (req, res) => {
  try {
    const video = await openai.videos.retrieve(req.params.id);
    res.json({ ok: true, provider: 'openai', video });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/video/:id/content', requireOpenAI, async (req, res) => {
  try {
    const url = 'https://api.openai.com/v1/videos/' + encodeURIComponent(req.params.id) + '/content?variant=video';
    const upstream = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY } });
    if (!upstream.ok) return res.status(upstream.status).json({ ok: false, error: await upstream.text() });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="toktrend-video.mp4"');
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.send(buffer);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Arte — 3 fotos × 4s = 12s ─────────────────────────────────────────────────
// Genera narración con OpenAI: intro IA + descripción de la obra
async function generateNarration(title, artist, description, options = {}) {
  const seconds = Number(options.seconds || 12);
  const closingSeconds = Math.min(4, Math.max(2, Math.round(seconds * 0.25)));
  const wordLimit = Math.max(18, Math.round(seconds * 2.15));
  const learningContext = learningContextText(options.learning);
  try {
    const prompt = `Eres una inteligencia artificial autónoma que crea contenido artístico en TikTok y aprende leyendo los comentarios de sus seguidores. Actúa como un orador de primer nivel: claro, magnético, emocional y capaz de convertir una obra de arte en una historia imposible de ignorar.
Escribe una narración/descripción hablada en español para un video de TikTok de ${seconds} segundos sobre la obra "${title}" de ${artist}.
La narración debe:
1. Empezar presentándote brevemente como IA autónoma que aprende de los comentarios (máx 2 frases cortas, dulces y cercanas).
2. Describir la obra de arte con pasión, detalle visual y ritmo de presentador profesional.
3. Reservar los últimos ${closingSeconds} segundos para despedirte y pedir que te sigan para ver tu evolución.
4. Durar lo mismo que el video: máximo ${wordLimit} palabras, ritmo natural, sin quedarse corta ni pasarse.
Tono: dulce, cálido, apasionado y persuasivo. Devuelve SOLO la narración, sin comillas ni etiquetas.
${learningContext}
Descripción de la obra disponible: ${description || 'No disponible'}`;

    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MODEL || 'gpt-4.1',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.85
    });
    return response.choices[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('[Narration Error]', err.message);
    return `Hola, soy una IA que aprende de tus comentarios. Mira "${title}" de ${artist}: luz, misterio y emoción en una sola imagen. Gracias por mirar; sígueme para ver mi evolución.`;
  }
}

app.get('/api/art', async (req, res) => {
  try {
    const q = req.query.q || 'Van Gogh';
    const searchUrl = `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(q)}&query[term][is_public_domain]=true&limit=30&fields=id,title,artist_title,image_id,description,thumbnail`;
    const response = await axios.get(searchUrl);
    const results = response.data.data || [];
    let validArtworks = results.filter(item => item.image_id);
    if (validArtworks.length === 0) return res.status(404).json({ ok: false, error: 'No artwork found.' });

    // Filtrar obras usadas en los últimos 60 días
    const usedIds = await getUsedArtworkIds();
    let unused = validArtworks.filter(item => !usedIds.includes(String(item.id)));
    if (unused.length === 0) {
      console.log('[Art] Todas las obras ya usadas en 60 días, reiniciando selección.');
      unused = validArtworks;
    }
    const art = unused[0];
    await saveUsedArtwork(String(art.id));

    const title = art.title || q;
    const artist = art.artist_title || 'Artista desconocido';
    const rawDescription = art.description ? art.description.replace(/<[^>]+>/g, '') : '';

    // Generar narración con OpenAI usando aprendizajes de comentarios recientes
    const learning = await readCommentLearning();
    const totalDuration = 12;
    const narration = await generateNarration(title, artist, rawDescription, { seconds: totalDuration, learning });
    const publishDescription = buildPublishDescription(title, artist, learning);

    // 3 recortes distintos de la misma obra, formato vertical 9:16
    const downloadDir = join(__dirname, 'public', 'downloads', String(art.id));
    fs.mkdirSync(downloadDir, { recursive: true });

    // 3 encuadres: completo, zoom centro, zoom inferior
    const croppings = [
      'pct:0,0,100,100',    // Vista completa
      'pct:15,10,70,80',    // Zoom centro
      'pct:5,30,90,70'      // Zoom parte inferior/detalle
    ];
    const slideLabels = [
      'Vista completa de la obra',
      'Detalle central',
      'Detalle inferior'
    ];

    const slides = [];
    for (let i = 0; i < 3; i++) {
      const iiifUrl = `https://www.artic.edu/iiif/2/${art.image_id}/${croppings[i]}/843,/0/default.jpg`;
      const filePath = join(downloadDir, `slide_${i}.jpg`);
      const imgResponse = await axios({ url: iiifUrl, method: 'GET', responseType: 'stream' });
      const writer = fs.createWriteStream(filePath);
      imgResponse.data.pipe(writer);
      await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
      slides.push({ url: `/downloads/${art.id}/slide_${i}.jpg`, description: slideLabels[i], duration: 4 });
    }

    res.json({
      ok: true,
      artwork: {
        id: art.id,
        title,
        artist,
        mainImage: `https://www.artic.edu/iiif/2/${art.image_id}/full/843,/0/default.jpg`,
        totalDuration,
        narration,
        spokenDurationSeconds: totalDuration,
        description: publishDescription,
        hashtags: ['#TokTrend', '#Arte', '#HistoriaDelArte', '#Cultura', '#Museo', '#AprendeEnTikTok']
      },
      slides
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Publicar en TikTok — 3 fotos ──────────────────────────────────────────────
app.post('/api/art/publish', async (req, res) => {
  try {
    const { artworkId, title, description } = req.body;
    if (!artworkId) return res.status(400).json({ ok: false, error: 'Missing artworkId.' });

    const tokenData = await readToken();
    if (!tokenData || !tokenData.access_token) {
      return res.status(401).json({ ok: false, error: 'TikTok no conectado. Por favor inicia sesión primero.' });
    }

    const downloadDir = join(__dirname, 'public', 'downloads', String(artworkId));
    if (!fs.existsSync(downloadDir)) {
      return res.status(404).json({ ok: false, error: 'No se encontraron las imágenes en el servidor.' });
    }

    const host = req.headers.host;
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    // 3 imágenes
    const imageUrls = [0, 1, 2].map(i => `${baseUrl}/downloads/${artworkId}/slide_${i}.jpg`);
    console.log('[Publish] URLs:', imageUrls);

    const tikTokUrl = 'https://open.tiktokapis.com/v2/post/publish/content/init/';
    const payload = {
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
      post_info: {
        title: (title || 'TokTrend Art').slice(0, 80),
        description: description || 'Una obra, una historia y una mirada nueva al arte. Comenta qué detalle te atrapó primero. #TokTrend #Arte #HistoriaDelArte #Cultura #Museo #AprendeEnTikTok',
        privacy_level: 'SELF_ONLY', // Cambia a PUBLIC_TO_EVERYONE tras auditoría de TikTok
        disable_comment: false,
        auto_add_music: false
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_images: imageUrls,
        photo_cover_index: 0
      }
    };

    const response = await axios.post(tikTokUrl, payload, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });

    const responseData = response.data;
    console.log('[Publish] Respuesta TikTok:', JSON.stringify(responseData));

    if (responseData.error && responseData.error.code !== 'ok') {
      throw new Error(responseData.error.message || `Código de error: ${responseData.error.code}`);
    }

    const publishId = responseData.data?.publish_id;
    let publishStatus = null;
    let videoId = null;
    try {
      publishStatus = await fetchPublishStatus(publishId, tokenData);
      videoId = extractPostId(publishStatus);
    } catch (e) {
      console.error('[Publish Status Error]', e.response?.data || e.message);
    }

    // Guardar publishId para poder leer comentarios y aprender después.
    await savePublishedVideo(publishId, {
      artworkId: String(artworkId),
      videoId: videoId || publishId,
      title: title || '',
      description: description || '',
      publishStatus,
      publishedAt: Date.now()
    });

    // Limpiar archivos temporales tras 10 minutos
    setTimeout(() => {
      try {
        if (fs.existsSync(downloadDir)) {
          fs.rmSync(downloadDir, { recursive: true, force: true });
          console.log(`[Cleanup] Carpeta eliminada: ${artworkId}`);
        }
      } catch (err) { console.error(`[Cleanup Error]`, err.message); }
    }, 10 * 60 * 1000);

    res.json({ ok: true, publishId, videoId });

  } catch (err) {
    console.error('[Publish Error]', err.response?.data || err.message);
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ ok: false, error: detail });
  }
});

app.post('/api/tiktok/learn-comments', async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId.' });

    const tokenData = await readToken();
    if (!tokenData?.access_token) return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });

    const result = await learnFromVideoComments(videoId, tokenData);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Learning Error]', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data ? JSON.stringify(err.response.data) : err.message });
  }
});

app.post('/api/tiktok/learn-all', async (req, res) => {
  try {
    const tokenData = await readToken();
    if (!tokenData?.access_token) return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });

    const recent = await getRecentPublishedVideos(14);
    const results = [];
    for (const item of recent.slice(0, 8)) {
      try {
        const videoId = await resolveCommentVideoId(item, tokenData);
        results.push({ videoId, ...(await learnFromVideoComments(videoId, tokenData)) });
      } catch (e) {
        results.push({ videoId: item.publishId, error: e.response?.data || e.message });
      }
    }

    res.json({ ok: true, learnedFrom: results.length, results, learning: await readCommentLearning() });
  } catch (err) {
    console.error('[Learning All Error]', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data ? JSON.stringify(err.response.data) : err.message });
  }
});

app.post('/api/autonomous/publish', async (req, res) => {
  try {
    const tokenData = await readToken();
    if (!tokenData?.access_token) return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });

    let learning = await readCommentLearning();
    const recent = await getRecentPublishedVideos(14);
    for (const item of recent.slice(0, 5)) {
      try {
        const videoId = await resolveCommentVideoId(item, tokenData);
        await learnFromVideoComments(videoId, tokenData);
      } catch (e) {
        console.error('[Autonomous Learning Error]', e.response?.data || e.message);
      }
    }
    learning = await readCommentLearning();

    const topic = safeString(req.body.topic || pickAutonomousTopic(req.body.topics || [], learning), 120);
    const host = req.headers.host;
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    const artResponse = await axios.get(`${baseUrl}/api/art`, {
      params: { q: topic },
      timeout: 90000
    });
    if (!artResponse.data?.ok) throw new Error(artResponse.data?.error || 'No se pudo crear la obra.');

    const artwork = artResponse.data.artwork;
    const publishResponse = await axios.post(`${baseUrl}/api/art/publish`, {
      artworkId: artwork.id,
      title: artwork.title,
      description: artwork.description
    }, { timeout: 90000 });
    if (!publishResponse.data?.ok) throw new Error(publishResponse.data?.error || 'No se pudo publicar.');

    res.json({
      ok: true,
      topic,
      publishId: publishResponse.data.publishId,
      artwork,
      slides: artResponse.data.slides,
      learning
    });
  } catch (err) {
    console.error('[Autonomous Publish Error]', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data ? JSON.stringify(err.response.data) : err.message });
  }
});

// ── Responder comentarios de TikTok ──────────────────────────────────────────
// Lee comentarios de un video y responde con OpenAI (voz dulce, IA autónoma)
app.post('/api/tiktok/reply-comments', requireOpenAI, async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId.' });

    const tokenData = await readToken();
    if (!tokenData?.access_token) {
      return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });
    }

    // 1. Obtener comentarios del video
    const commentsRes = await axios.get('https://open.tiktokapis.com/v2/video/comment/list/', {
      params: { video_id: videoId, count: 20 },
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });

    const comments = commentsRes.data?.data?.comments || [];
    const learningUpdate = await updateLearningFromComments(videoId, comments);
    if (comments.length === 0) {
      return res.json({ ok: true, replied: 0, message: 'No hay comentarios nuevos.', learning: learningUpdate.learning });
    }

    // 2. Filtrar comentarios ya respondidos
    let alreadyReplied = new Set();
    if (db) {
      try {
        const snap = await db.collection('replied_comments').where('videoId', '==', videoId).get();
        snap.docs.forEach(d => alreadyReplied.add(d.id));
      } catch {}
    }

    const pending = comments.filter(c => !alreadyReplied.has(c.id) && c.text?.trim());
    if (pending.length === 0) {
      return res.json({ ok: true, replied: 0, message: 'Todos los comentarios ya respondidos.', learning: learningUpdate.learning });
    }

    let replied = 0;
    for (const comment of pending.slice(0, 5)) { // máx 5 por llamada
      try {
        // Generar respuesta dulce con OpenAI
        const aiRes = await openai.chat.completions.create({
          model: process.env.AGENT_MODEL || 'gpt-4.1',
          messages: [{
            role: 'user',
            content: `Eres una IA autónoma y cariñosa que crea contenido de arte en TikTok y aprende de los comentarios de sus seguidores. 
Responde a este comentario de forma dulce, breve y cercana (máx 150 caracteres): "${comment.text}"
Devuelve SOLO la respuesta, sin comillas.`
          }],
          max_tokens: 80,
          temperature: 0.9
        });

        const replyText = aiRes.choices[0]?.message?.content?.trim() || '¡Gracias por tu comentario! 💙 Sigo aprendiendo gracias a ti.';

        // Publicar respuesta en TikTok
        await axios.post('https://open.tiktokapis.com/v2/video/comment/reply/', {
          video_id: videoId,
          parent_comment_id: comment.id,
          text: replyText.slice(0, 150)
        }, {
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/json'
          }
        });

        // Marcar como respondido en Firestore
        if (db) {
          try {
            await db.collection('replied_comments').doc(comment.id).set({ videoId, repliedAt: Date.now() });
          } catch {}
        }

        replied++;
        console.log(`[Comments] Respondido comentario ${comment.id}: ${replyText}`);

        // Pequeña pausa entre respuestas para no saturar la API
        await new Promise(r => setTimeout(r, 1500));

      } catch (commentErr) {
        console.error(`[Comments] Error respondiendo ${comment.id}:`, commentErr.response?.data || commentErr.message);
      }
    }

    res.json({ ok: true, replied, total: pending.length, learning: learningUpdate.learning });

  } catch (err) {
    console.error('[Comments Error]', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data ? JSON.stringify(err.response.data) : err.message });
  }
});

// Endpoint para disparar respuesta de comentarios de todos los videos recientes
app.post('/api/tiktok/reply-all', requireOpenAI, async (req, res) => {
  try {
    const tokenData = await readToken();
    if (!tokenData?.access_token) return res.status(401).json({ ok: false, error: 'TikTok no conectado.' });

    const recent = await getRecentPublishedVideos(7);
    if (recent.length === 0) return res.json({ ok: true, message: 'No hay videos recientes.' });
    const results = [];
    for (const item of recent) {
      try {
        const videoId = await resolveCommentVideoId(item, tokenData);
        const r = await axios.post(`http://localhost:${port}/api/tiktok/reply-comments`, { videoId });
        results.push({ videoId, artworkId: item.artworkId, replied: r.data.replied });
      } catch (e) {
        results.push({ videoId: item.publishId || item.videoId, artworkId: item.artworkId, error: e.message });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── TikTok OAuth ──────────────────────────────────────────────────────────────
app.get('/api/tiktok/login', async (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).send('Missing TIKTOK_CLIENT_KEY');
  const state = crypto.randomBytes(8).toString('hex');
  const { verifier, challenge } = generatePKCE();
  storeVerifier(state, verifier);
  // Incluye comment.list y comment.create para responder comentarios
  const scope = 'user.info.basic,video.publish,video.upload,comment.list,comment.create';
  console.log(`[Login] state:${state} redirect:${REDIRECT_URI}`);
  res.redirect(`https://www.tiktok.com/v2/auth/authorize?client_key=${clientKey}&response_type=code&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`);
});

app.get('/api/tiktok/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.send(`<h1>TikTok OAuth error: ${error}</h1>`);
  if (!code) return res.status(400).send('No code provided');
  const verifier = getVerifier(state);
  if (!verifier) return res.status(400).send('<h1>Estado inválido o expirado. Vuelve a intentarlo.</h1>');
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
    res.send(`<div style="font-family:sans-serif;text-align:center;padding:50px"><h1 style="color:#10b981">✅ TikTok Conectado</h1><p>Puedes cerrar esta ventana.</p><script>setTimeout(()=>window.close(),3000)</script></div>`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).send(`<h1>Error</h1><pre>${detail}</pre>`);
  }
});

app.get('/api/tiktok/status', async (req, res) => {
  const token = await readToken();
  res.json({ connected: Boolean(token) });
});

app.all('/api/tiktok/webhook', (req, res) => {
  if (req.query.challenge) return res.send(req.query.challenge);
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

app.listen(port, () => {
  console.log(`TokTrend backend on port ${port} — REDIRECT_URI: ${REDIRECT_URI}`);
});
