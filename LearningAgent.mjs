import fs from 'fs';
import path from 'path';

export class LearningAgent {
  constructor(storageDir) {
    this.memoryFile = path.join(storageDir, 'learning_memory.json');
    this.lessonsFile = path.join(storageDir, 'lessons_learned.json');
    
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    if (!fs.existsSync(this.memoryFile)) fs.writeFileSync(this.memoryFile, '[]');
    if (!fs.existsSync(this.lessonsFile)) fs.writeFileSync(this.lessonsFile, '[]');
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

  calculateScore(record) {
    let score = 0;
    if (record.scriptData && record.scriptData.script) score += 10;
    if (record.renderStatus === 'success') score += 20;
    if (record.publishStatus === 'success') score += 30;
    
    // Simulate TikTok metrics scoring if available
    if (record.tiktokMetrics) {
      if (record.tiktokMetrics.views > 100) score += 20;
      if (record.tiktokMetrics.likes > 10) score += 20;
    }

    if (record.error) score -= 20;
    if (record.publishError) score -= 10;
    
    return Math.max(0, score);
  }

  async recordVideoData(sessionData, llmCallback, logCallback) {
    const memory = this._readJSON(this.memoryFile);
    
    const record = {
      sessionId: sessionData.sessionId,
      timestamp: new Date().toISOString(),
      topic: sessionData.topic,
      scriptData: sessionData.scriptData || null,
      renderStatus: sessionData.renderStatus || 'pending',
      publishStatus: sessionData.publishStatus || 'pending',
      error: sessionData.error || null,
      publishError: sessionData.publishError || null,
      tiktokMetrics: sessionData.tiktokMetrics || null
    };

    record.score = this.calculateScore(record);
    memory.push(record);
    
    // Keep only last 100 records
    if (memory.length > 100) memory.shift();
    this._writeJSON(this.memoryFile, memory);

    if (logCallback) logCallback(`[LearningAgent] Video registrado. Score interno: ${record.score}`);

    // Si el video tuvo mucho exito (>50), reflexionamos sobre el para aprender
    if (record.score >= 50 && llmCallback) {
      // Disparamos la reflexion en background para no bloquear
      setImmediate(() => this.reflectAndLearn(record, llmCallback, logCallback));
    }
  }

  async reflectAndLearn(record, llmCallback, logCallback) {
    try {
      if (logCallback) logCallback(`[LearningAgent] Reflexionando sobre el exito del video: "${record.topic}"`);
      
      const prompt = `Eres un Agente Analista (Learning Agent).
Analiza este guion de video de TikTok que tuvo mucho exito y obtén UNA (1) lección clara y directa sobre por qué funcionó bien.
Fíjate en el "Hook" (gancho inicial), la estructura, y el Call to Action.

Tema: ${record.topic}
Título: ${record.scriptData.title}
Hashtags: ${(record.scriptData.hashtags || []).join(' ')}
Guion:
${record.scriptData.script}

Escribe SOLO LA LECCIÓN en 1 o 2 oraciones breves, en español, formulada como una directriz (ej: "Empieza con una pregunta desafiante sobre el tema"). No saludes, no añadas comillas.`;

      const lesson = await llmCallback(prompt);
      if (lesson && lesson.length > 5 && lesson.length < 300) {
        const lessons = this._readJSON(this.lessonsFile);
        lessons.push({ timestamp: new Date().toISOString(), lesson, fromTopic: record.topic });
        
        // Keep top 10 recent lessons
        if (lessons.length > 10) lessons.shift();
        this._writeJSON(this.lessonsFile, lessons);
        
        if (logCallback) logCallback(`[LearningAgent] Nueva leccion aprendida: ${lesson}`);
      }
    } catch (e) {
      if (logCallback) logCallback(`[LearningAgent] Error al reflexionar: ${e.message}`);
    }
  }

  getLearningContext() {
    const lessons = this._readJSON(this.lessonsFile);
    if (lessons.length === 0) return '';
    const text = lessons.map(l => `- ${l.lesson}`).join('\n');
    return `DIRECTRICES APRENDIDAS DE VIDEOS ANTERIORES EXITOSOS:\n${text}`;
  }
}
