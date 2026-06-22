import fs from 'fs';
import path from 'path';

export class LearningAgent {
  constructor(storageDir, db = null) {
    this.storageDir = storageDir;
    this.db = db;
    
    // JSON fallbacks
    this.videosFile = path.join(storageDir, 'learning_videos.json');
    this.metricsFile = path.join(storageDir, 'learning_metrics.json');
    this.notesFile = path.join(storageDir, 'learning_notes.json');
    this.experimentsFile = path.join(storageDir, 'learning_experiments.json');
  }

  _ensureLocalJSON(file) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '[]');
    }
  }

  _readJSON(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  }

  _writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  initLearningAgent() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    if (this.db) {
      console.log('[Learning Agent] Initialized with Firestore');
    } else {
      console.log('[Learning Agent] Initialized with Local JSON Fallback');
      this._ensureLocalJSON(this.videosFile);
      this._ensureLocalJSON(this.metricsFile);
      this._ensureLocalJSON(this.notesFile);
      this._ensureLocalJSON(this.experimentsFile);
    }
  }

  async _saveDoc(collection, docId, data) {
    if (this.db) {
      await this.db.collection(collection).doc(docId).set(data, { merge: true });
    } else {
      let file = this.videosFile;
      if (collection === 'learning_metrics') file = this.metricsFile;
      if (collection === 'learning_notes') file = this.notesFile;
      if (collection === 'experiments') file = this.experimentsFile;

      const items = this._readJSON(file);
      const idx = items.findIndex(i => i.id === docId);
      if (idx !== -1) items[idx] = { ...items[idx], ...data };
      else items.push({ id: docId, ...data });
      this._writeJSON(file, items);
    }
  }

  async _getCollection(collection) {
    if (this.db) {
      const snap = await this.db.collection(collection).get();
      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } else {
      let file = this.videosFile;
      if (collection === 'learning_metrics') file = this.metricsFile;
      if (collection === 'learning_notes') file = this.notesFile;
      if (collection === 'experiments') file = this.experimentsFile;
      return this._readJSON(file);
    }
  }

  async recordGeneratedVideo(videoData) {
    try {
      const videoId = `vid_${Date.now()}_${Math.random().toString(36).substring(2,9)}`;
      
      const data = {
        id: videoId,
        topic: videoData.topic || '',
        style: videoData.style || 'default',
        language: videoData.language || 'es',
        duration: videoData.duration || null,
        voice: videoData.voice || 'es-ES-AlvaroNeural',
        hook: videoData.hook || '',
        hook_type: videoData.hook_type || 'unknown',
        script: videoData.script || '',
        scenes_json: videoData.scenes_json || '[]',
        visual_prompts_json: videoData.visual_prompts_json || '[]',
        title: videoData.title || '',
        description: videoData.description || '',
        hashtags_json: videoData.hashtags_json || '[]',
        video_path: null,
        render_status: 'pending',
        publish_status: 'pending',
        tiktok_video_id: null,
        downloaded: false,
        created_at: new Date().toISOString(),
        published_at: null,
        error_message: null,
        score: 0,
        performance_class: 'unknown'
      };

      await this._saveDoc('videos', videoId, data);
      console.log(`[Learning Agent] Video registered: ${videoId}`);
      return videoId;
    } catch (err) {
      console.warn(`[Learning Agent] Failed to register video: ${err.message}`);
      return null;
    }
  }

  async recordRenderResult(videoId, renderData) {
    if (!videoId) return;
    try {
      const update = {
        render_status: renderData.status,
        duration: renderData.duration || null,
        video_path: renderData.path || null,
        error_message: renderData.error || null
      };
      await this._saveDoc('videos', videoId, update);
      console.log(`[Learning Agent] Render result registered for ${videoId}: ${renderData.status}`);
    } catch (err) {
      console.warn(`[Learning Agent] Failed to register render result: ${err.message}`);
    }
  }

  async recordPublishResult(videoId, publishData) {
    if (!videoId) return;
    try {
      const update = {
        publish_status: publishData.status,
        tiktok_video_id: publishData.tiktok_video_id || null,
        published_at: new Date().toISOString(),
        error_message: publishData.error || null
      };
      await this._saveDoc('videos', videoId, update);
      console.log(`[Learning Agent] Publish result registered for ${videoId}: ${publishData.status}`);
    } catch (err) {
      console.warn(`[Learning Agent] Failed to register publish result: ${err.message}`);
    }
  }

  async recordDownload(videoId) {
    if (!videoId) return;
    try {
      await this._saveDoc('videos', videoId, { downloaded: true });
      console.log(`[Learning Agent] Download registered for ${videoId}`);
    } catch (err) {
      console.warn(`[Learning Agent] Failed to register download: ${err.message}`);
    }
  }

  async collectMetrics(videoId) {
    // Preparado para consultar métricas oficiales si hubiera permisos
    console.log(`[Learning Agent] Metrics unavailable: missing TikTok permission for ${videoId}`);
    return null; 
  }

  scoreVideo(videoData, metrics = null) {
    // Si hay métricas reales
    if (metrics) {
      const views = metrics.views || 0;
      const eng = (metrics.likes + metrics.comments + metrics.shares + metrics.saves);
      const engagement_rate = views > 0 ? eng / views : 0;
      
      let cls = 'failed';
      if (views > 1000 && engagement_rate > 0.1) cls = 'high_performer';
      else if (views > 100) cls = 'average_performer';
      else if (views > 0) cls = 'low_performer';
      
      return { score: engagement_rate * 100, class: cls };
    }

    // Scoring interno
    let score = 0;
    
    const hookLength = videoData.hook ? videoData.hook.split(' ').length : 0;
    const hasQuestionHook = videoData.hook && videoData.hook.includes('?');
    
    // hook_score
    if (hookLength > 3 && hookLength < 15) score += 10;
    if (hasQuestionHook) score += 5;

    // metadata_score
    const hashtags = JSON.parse(videoData.hashtags_json || '[]');
    if (hashtags.length > 2 && hashtags.length <= 6) score += 10;

    // render & publish
    if (videoData.render_status === 'success') score += 20;
    if (videoData.publish_status === 'success') score += 30;
    
    // download_signal
    if (videoData.downloaded) score += 20;

    // penalties
    if (videoData.render_status === 'failed' || videoData.publish_status === 'failed') score -= 30;

    let cls = 'failed';
    if (score >= 70) cls = 'high_performer';
    else if (score >= 40) cls = 'average_performer';
    else if (score >= 0 && videoData.render_status === 'success') cls = 'low_performer';

    console.log(`[Learning Agent] Video score calculated: ${score} (${cls})`);
    return { score, class: cls };
  }

  async analyzePerformance() {
    try {
      const videos = await this._getCollection('videos');
      if (videos.length === 0) return null;
      
      // Update scores for unscored videos
      for (const v of videos) {
        if (v.score === 0 && v.performance_class === 'unknown') {
          const { score, class: pClass } = this.scoreVideo(v);
          v.score = score;
          v.performance_class = pClass;
          await this._saveDoc('videos', v.id, { score, performance_class: pClass });
        }
      }

      console.log(`[Learning Agent] Pattern detected: Analizados ${videos.length} videos`);
      return videos;
    } catch (e) {
      console.warn(`[Learning Agent] Failed to analyze performance: ${e.message}`);
      return null;
    }
  }

  async generateLearningNotes(llmCallback) {
    try {
      const videos = await this.analyzePerformance();
      if (!videos) return;

      const highPerformers = videos.filter(v => v.performance_class === 'high_performer').slice(-5);
      if (highPerformers.length === 0) return;

      const recentHigh = highPerformers[highPerformers.length - 1];
      
      const prompt = `Eres un Agente Analista (Learning Agent).
Analiza este video de TikTok que tuvo alto rendimiento ("high_performer") y obtén UNA (1) recomendación accionable.
Tema: ${recentHigh.topic}
Hook: ${recentHigh.hook}
Hashtags: ${recentHigh.hashtags_json}

Escribe SOLO la recomendación breve en español en una línea.
Ejemplo: "Usar hooks en forma de pregunta directa mejora la retención."`;

      const recommendation = await llmCallback(prompt);
      if (recommendation && recommendation.length > 5) {
        const noteId = `note_${Date.now()}`;
        const note = {
          id: noteId,
          lesson: recommendation,
          evidence: `Basado en el video exitoso: ${recentHigh.topic}`,
          recommendation: recommendation,
          confidence: 'medium',
          created_at: new Date().toISOString()
        };
        await this._saveDoc('learning_notes', noteId, note);
        console.log(`[Learning Agent] Learning note generated: ${recommendation}`);
      }
    } catch (e) {
      console.warn(`[Learning Agent] Failed to generate learning notes: ${e.message}`);
    }
  }

  async getPromptImprovements(topic, style = 'default') {
    try {
      const notes = await this._getCollection('learning_notes');
      if (notes.length === 0) {
        return "Learning guidance not available yet. Apply best standard practices.";
      }

      // Tomar las últimas 5 notas para construir una guía condensada
      const recentNotes = notes.slice(-5).map(n => `- ${n.recommendation}`);
      const guidance = recentNotes.join('\n');
      console.log(`[Learning Agent] Prompt improvement applied for topic: ${topic}`);
      return guidance;
    } catch (e) {
      console.warn(`[Learning Agent] Learning Agent failed, continuing with fallback: ${e.message}`);
      return null;
    }
  }

  async buildNextVideoGuidance(topic, style = 'default') {
    const improvements = await this.getPromptImprovements(topic, style);
    if (!improvements || improvements.includes("not available yet")) return null;
    
    return `Learning guidance:\n${improvements}\n- No repitas estructuras de videos con bajo score.`;
  }
}
