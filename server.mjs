import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8787);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, 'public')));

// ── TikTok Auth Setup ──────────────────────────────────────────────────────────
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || 'http://localhost:8787/api/tiktok/callback';

const codeVerifiers = new Map();
function storeVerifier(state, verifier) {
  codeVerifiers.set(state, { verifier, expires: Date.now() + 10 * 60 * 1000 });
  for (const [k, v] of codeVerifiers) {
    if (v.expires < Date.now()) codeVerifiers.delete(k);
  }
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

function readToken() {
  if (process.env.TIKTOK_TOKEN_JSON) {
    try { return JSON.parse(process.env.TIKTOK_TOKEN_JSON); } catch { return null; }
  }
  if (fs.existsSync(TIKTOK_TOKEN_FILE)) {
    try { return JSON.parse(fs.readFileSync(TIKTOK_TOKEN_FILE, 'utf8')); } catch { return null; }
  }
  return null;
}

function writeToken(data) {
  try { fs.writeFileSync(TIKTOK_TOKEN_FILE, JSON.stringify(data, null, 2)); } catch {}
  console.log('[Token] Token guardado. En producción, copia este valor en TIKTOK_TOKEN_JSON:');
  console.log(JSON.stringify(data));
}

function requireOpenAI(req, res, next) {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY is missing on the server.' });
  }
  next();
}

function safeString(value, max = 4000) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'toktrend-openai-agent-backend',
    provider: 'openai',
    openaiKeyLoaded: Boolean(process.env.OPENAI_API_KEY),
    tiktokRedirectUri: REDIRECT_URI,
    tiktokConnected: Boolean(readToken()),
    time: new Date().toISOString()
  });
});

app.post('/api/agent', requireOpenAI, async (req, res) => {
  try {
    const topic = safeString(req.body.topic, 1200);
    const style = safeString(req.body.style || 'cinematic', 100);
    const seconds = safeString(req.body.seconds || '16', 10);
    const size = safeString(req.body.size || '1080x1920', 20);
    if (!topic) return res.status(400).json({ ok: false, error: 'Missing topic.' });
    const prompt = 'Create a safe cinematic video plan for a general audience. Return ONLY valid JSON with keys title, hook, narration, shots, video_prompt, hashtags. Topic: ' + topic + '. Style: ' + style + '. Duration: ' + seconds + ' seconds. Format: ' + size + '. Avoid copyrighted characters, logos, real people, adult content, copyrighted music, and unsafe content. Make video_prompt highly visual: subject, camera movement, lighting, lens, atmosphere, color grade, pacing, no text overlays.';
    const response = await openai.responses.create({ model: process.env.AGENT_MODEL || 'gpt-4.1', input: prompt, temperature: 0.8 });
    let text = '';
    if (response.output_text) { text = response.output_text; }
    else if (Array.isArray(response.output)) {
      const msg = response.output.find(o => o.type === 'message');
      text = msg?.content?.find(c => c.type === 'output_text')?.text || '{}';
    }
    text = text.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
    let plan;
    try { plan = JSON.parse(text); }
    catch { plan = { title: 'Cinematic video', hook: '', narration: '', shots: [], video_prompt: text, hashtags: ['#OpenAI', '#Sora', '#TokTrend'] }; }
    if (!plan.video_prompt) plan.video_prompt = topic;
    res.json({ ok: true, provider: 'openai', plan });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || 'Agent generation failed.' }); }
});

app.post('/api/video', requireOpenAI, async (req, res) => {
  try {
    const prompt = safeString(req.body.prompt || req.body.topic, 4000);
    const model = safeString(req.body.model || 'sora-2-pro', 50);
    const size = safeString(req.body.size || '1080x1920', 20);
    const seconds = safeString(req.body.seconds || '16', 10);
    if (!prompt) return res.status(400).json({ ok: false, error: 'Missing prompt.' });
    const validSeconds = ['4', '8', '12'];
    const safeSeconds = validSeconds.includes(seconds) ? seconds : '8';
    const video = await openai.videos.create({ model, prompt, size, seconds: safeSeconds });
    res.json({ ok: true, provider: 'openai', video });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || 'Video creation failed.' }); }
});

app.get('/api/video/:id', requireOpenAI, async (req, res) => {
  try {
    const video = await openai.videos.retrieve(req.params.id);
    res.json({ ok: true, provider: 'openai', video });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || 'Video status failed.' }); }
});

app.get('/api/video/:id/content', requireOpenAI, async (req, res) => {
  try {
    const url = 'https://api.openai.com/v1/videos/' + encodeURIComponent(req.params.id) + '/content?variant=video';
    const upstream = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY } });
    if (!upstream.ok) {
      const errorText = await upstream.text();
      return res.status(upstream.status).json({ ok: false, error: errorText });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="toktrend-openai-video.mp4"');
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.send(buffer);
  } catch (err) { res.status(500).json({ ok: false, error: err.message || 'Video download failed.' }); }
});

// ── Art Institute ──────────────────────────────────────────────────────────────
const USED_ART_FILE = join(__dirname, 'used_artworks.json');

function getUsedArtworks() {
  if (fs.existsSync(USED_ART_FILE)) {
    try { return JSON.parse(fs.readFileSync(USED_ART_FILE, 'utf8')); } catch { return []; }
  }
  return [];
}

function saveUsedArtwork(id) {
  const used = getUsedArtworks();
  if (!used.includes(id)) {
    used.push(id);
    try { fs.writeFileSync(USED_ART_FILE, JSON.stringify(used, null, 2), 'utf8'); } catch {}
  }
}

app.get('/api/art', async (req, res) => {
  try {
    const q = req.query.q || 'Van Gogh';
    const searchUrl = `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(q)}&query[term][is_public_domain]=true&limit=20&fields=id,title,artist_title,image_id,description,thumbnail`;
    const response = await axios.get(searchUrl);
    const results = response.data.data || [];
    let validArtworks = results.filter(item => item.image_id);
    if (validArtworks.length === 0) return res.status(404).json({ ok: false, error: 'No se encontraron obras de arte de dominio público con imágenes.' });
    const usedIds = getUsedArtworks();
    let unusedArtworks = validArtworks.filter(item => !usedIds.includes(item.id));
    if (unusedArtworks.length === 0) {
      try { fs.writeFileSync(USED_ART_FILE, JSON.stringify([], null, 2), 'utf8'); } catch {}
      unusedArtworks = validArtworks;
    }
    const art = unusedArtworks[0];
    saveUsedArtwork(art.id);
    const title = art.title || q;
    const artist = art.artist_title || 'Artista desconocido';
    const descriptions = [
      `Contemplamos "${title}", una obra maestra creada por ${artist}.`,
      `El estilo único y las pinceladas de esta pieza reflejan el genio de ${artist}.`,
      `Esta obra forma parte del patrimonio de dominio público y se exhibe en el Art Institute de Chicago.`,
      `Un detalle fascinante sobre "${title}" es el dinamismo y las emociones que evoca.`
    ];
    const imageUrl = `https://www.artic.edu/iiif/2/${art.image_id}/full/843,/0/default.jpg`;
    const downloadDir = join(__dirname, 'public', 'downloads', String(art.id));
    fs.mkdirSync(downloadDir, { recursive: true });
    const slides = [];
    const croppings = ['pct:0,0,100,100', 'pct:10,10,80,80', 'pct:20,20,60,60', 'pct:0,0,100,100'];
    for (let i = 0; i < 4; i++) {
      const iiifUrl = `https://www.artic.edu/iiif/2/${art.image_id}/${croppings[i]}/843,/0/default.jpg`;
      const filename = `slide_${i}.jpg`;
      const filePath = join(downloadDir, filename);
      const imgResponse = await axios({ url: iiifUrl, method: 'GET', responseType: 'stream' });
      const writer = fs.createWriteStream(filePath);
      imgResponse.data.pipe(writer);
      await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
      slides.push({ url: `/downloads/${art.id}/${filename}`, description: descriptions[i], duration: 3 });
    }
    res.json({ ok: true, artwork: { id: art.id, title, artist, mainImage: imageUrl, totalDuration: 12 }, slides });
  } catch (err) {
    console.error('Error fetching art data:', err);
    res.status(500).json({ ok: false, error: err.message || 'Error al buscar obras de arte.' });
  }
});

app.post('/api/art/publish', (req, res) => {
  try {
    const { artworkId } = req.body;
    if (!artworkId) return res.status(400).json({ ok: false, error: 'Falta artworkId en la petición.' });
    const dirPath = join(__dirname, 'public', 'downloads', String(artworkId));
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || 'Error al borrar imágenes temporales.' }); }
});

// ── TikTok OAuth ───────────────────────────────────────────────────────────────
app.get('/api/tiktok/login', async (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).send('Falta TIKTOK_CLIENT_KEY en .env');
  const scopes = 'user.info.basic,video.publish';
  const state = crypto.randomBytes(8).toString('hex');
  const { verifier, challenge } = generatePKCE();
  storeVerifier(state, verifier);
  console.log(`[Login] state: ${state}, redirect_uri: ${REDIRECT_URI}, challenge: ${challenge}`);
  const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${clientKey}&response_type=code&scope=${scopes}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  res.redirect(authUrl);
});

app.get('/api/tiktok/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.send(`<h1>Error en TikTok OAuth: ${error}</h1>`);
  if (!code) return res.status(400).send('No code provided');
  const verifier = getVerifier(state);
  if (!verifier) return res.status(400).send('<h1>Error: Estado inválido o sesión expirada.</h1><p>Por favor vuelve a darle al botón de Conectar TikTok.</p>');
  try {
    const params = new URLSearchParams();
    params.append('client_key', process.env.TIKTOK_CLIENT_KEY);
    params.append('client_secret', process.env.TIKTOK_CLIENT_SECRET);
    params.append('code', code);
    params.append('grant_type', 'authorization_code');
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code_verifier', verifier);
    const tokenResponse = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' }
    });
    const data = tokenResponse.data;
    if (data.error) throw new Error(data.error_description || data.error);
    writeToken(data);
    res.send(`<div style="font-family:sans-serif;text-align:center;padding:50px"><h1 style="color:#10b981">✅ TikTok Conectado Exitosamente</h1><p>Ya puedes cerrar esta ventana.</p><script>setTimeout(()=>window.close(),3000)</script></div>`);
  } catch (err) {
    console.error('TikTok Auth Error:', err.response?.data || err.message);
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).send(`<h1>Error obteniendo token</h1><pre>${detail}</pre>`);
  }
});

app.get('/api/tiktok/status', (req, res) => {
  res.json({ connected: Boolean(readToken()) });
});

app.all('/api/tiktok/webhook', (req, res) => {
  if (req.query.challenge) return res.send(req.query.challenge);
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

app.listen(port, () => {
  console.log('TokTrend OpenAI backend running on port ' + port);
  console.log('REDIRECT_URI:', REDIRECT_URI);
});
