import fs from 'fs';
import path from 'path';

export class FailureStrategyAgent {
  constructor(storageDir, db = null) {
    this.storageDir = storageDir;
    this.db = db;
    
    // JSON fallbacks
    this.failuresFile = path.join(storageDir, 'failure_events.json');
    this.healthFile = path.join(storageDir, 'provider_health.json');
    this.shiftsFile = path.join(storageDir, 'strategy_shifts.json');
    
    this.providers = ['gemini', 'groq', 'pollinations', 'edge_tts', 'moviepy', 'tiktok', 'local_node'];
    
    // InMemory runtime state for circuit breakers (sync)
    this.circuitBreakers = {};
  }

  _ensureLocalJSON(file, defaultData = []) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
    }
  }

  _readJSON(file, defaultData = []) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return defaultData;
    }
  }

  _writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  initFailureStrategyAgent() {
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });

    if (this.db) {
      console.log('[Failure & Strategy Agent] Initialized with Firestore');
    } else {
      console.log('[Failure & Strategy Agent] Initialized with Local JSON Fallback');
      this._ensureLocalJSON(this.failuresFile);
      this._ensureLocalJSON(this.shiftsFile);
      
      const defaultHealth = {};
      this.providers.forEach(p => {
        defaultHealth[p] = {
          provider: p,
          status: 'healthy',
          consecutive_failures: 0,
          last_failure_at: null,
          last_success_at: null,
          circuit_state: 'closed',
          opened_until: null
        };
      });
      this._ensureLocalJSON(this.healthFile, defaultHealth);
    }
    
    // Initialize runtime circuit breakers
    const healthData = this._readJSON(this.healthFile, {});
    for (const p of this.providers) {
      if (!healthData[p]) {
        healthData[p] = { provider: p, status: 'healthy', consecutive_failures: 0, circuit_state: 'closed', opened_until: null };
      }
      this.circuitBreakers[p] = healthData[p];
    }
    this._writeJSON(this.healthFile, this.circuitBreakers);
  }

  async _saveDoc(collection, docId, data) {
    if (this.db) {
      await this.db.collection(collection).doc(docId).set(data, { merge: true });
    } else {
      let file = this.failuresFile;
      let isDict = false;
      if (collection === 'provider_health') { file = this.healthFile; isDict = true; }
      else if (collection === 'strategy_shifts') file = this.shiftsFile;

      if (isDict) {
        const items = this._readJSON(file, {});
        items[docId] = { ...items[docId], ...data };
        this._writeJSON(file, items);
      } else {
        const items = this._readJSON(file, []);
        const idx = items.findIndex(i => i.id === docId);
        if (idx !== -1) items[idx] = { ...items[idx], ...data };
        else items.push({ id: docId, ...data });
        this._writeJSON(file, items);
      }
    }
  }

  async _getCollection(collection) {
    if (this.db) {
      const snap = await this.db.collection(collection).get();
      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } else {
      let file = this.failuresFile;
      if (collection === 'provider_health') return Object.values(this._readJSON(this.healthFile, {}));
      else if (collection === 'strategy_shifts') file = this.shiftsFile;
      return this._readJSON(file, []);
    }
  }

  async recordFailure(event) {
    const id = `fail_${Date.now()}_${Math.random().toString(36).substring(2,9)}`;
    
    // Unpack structured JSON errors from Python
    if (typeof event.error_message === 'string' && event.error_message.startsWith('{')) {
      try {
        const parsed = JSON.parse(event.error_message);
        event.stage = parsed.stage || event.stage;
        event.provider = parsed.provider || event.provider;
        event.error_code = parsed.error_code || event.error_code;
        event.error_type = parsed.error_type || event.error_type;
        event.retryable = parsed.retryable !== undefined ? parsed.retryable : event.retryable;
        event.error_message = parsed.message || event.error_message;
      } catch (e) {}
    }

    const failEvent = {
      id,
      video_id: event.video_id || null,
      job_id: event.job_id || null,
      stage: event.stage || 'unknown',
      provider: event.provider || 'unknown',
      error_code: event.error_code || 'unknown',
      error_type: event.error_type || 'unknown',
      error_message: event.error_message || '',
      severity: event.severity || 'low',
      retryable: event.retryable || false,
      attempt: event.attempt || 1,
      strategy_applied: event.strategy_applied || null,
      resolved: false,
      created_at: new Date().toISOString()
    };
    
    await this._saveDoc('failure_events', id, failEvent);
    console.log(`[Failure Agent] Record failure: ${failEvent.provider} - ${failEvent.error_message}`);

    // Update circuit breaker
    if (this.providers.includes(failEvent.provider)) {
      const cb = this.circuitBreakers[failEvent.provider];
      cb.consecutive_failures += 1;
      cb.last_failure_at = failEvent.created_at;
      cb.status = 'degraded';
      
      if (cb.consecutive_failures >= 3 && cb.circuit_state === 'closed') {
        cb.circuit_state = 'open';
        cb.opened_until = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // open for 10 mins
        console.warn(`[Circuit Breaker] OPENED for provider: ${failEvent.provider}`);
      }
      this.circuitBreakers[failEvent.provider] = cb;
      await this._saveDoc('provider_health', failEvent.provider, cb);
    }
    
    return id;
  }

  async recordRecovery(event) {
    console.log(`[Failure Agent] Recovery applied successfully: ${event.strategy_applied}`);
    if (event.provider && this.providers.includes(event.provider)) {
      const cb = this.circuitBreakers[event.provider];
      cb.consecutive_failures = 0;
      cb.status = 'healthy';
      cb.circuit_state = 'closed';
      cb.opened_until = null;
      cb.last_success_at = new Date().toISOString();
      this.circuitBreakers[event.provider] = cb;
      await this._saveDoc('provider_health', event.provider, cb);
    }
  }

  classifyFailure(errorStr, context = {}) {
    const err = String(errorStr).toLowerCase();
    
    // Technical network/provider failures
    if (err.includes('503') || err.includes('unavailable') || err.includes('overloaded')) return 'provider_overloaded';
    if (err.includes('429') || err.includes('quota') || err.includes('resource_exhausted')) return 'rate_limit_failure';
    if (err.includes('timeout') || err.includes('econnrefused') || err.includes('aborted')) return 'network_failure';
    if (err.includes('api key') || err.includes('403') || err.includes('unauthorized') || err.includes('token') || err.includes('auth')) return 'auth_failure';
    
    // Tool/Render failures
    if (err.includes('moviepy') || err.includes('ffmpeg') || err.includes('render')) return 'render_failure';
    if (context.stage === 'publish') return 'publish_failure';
    
    return 'unknown_failure';
  }

  isRetryable(errorType, errorMsg = '') {
    const msg = String(errorMsg).toLowerCase();
    const noRetry = ['auth_failure', 'permission_failure', 'invalid format', 'corrupt', 'api key'];
    if (noRetry.some(n => msg.includes(n)) || noRetry.includes(errorType)) return false;
    
    const yesRetry = ['provider_overloaded', 'rate_limit_failure', 'network_failure', 'timeout', '500', '502', '503', '504'];
    if (yesRetry.includes(errorType) || yesRetry.some(y => msg.includes(y))) return true;
    
    return false;
  }

  getRetryPlan(errorType, attempt) {
    if (attempt >= 3) {
      return { retry: false, max_attempts: 3, delay_ms: 0, next_action: 'change_strategy_or_fallback' };
    }
    const baseDelay = 2000;
    const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000; // Exponential jitter
    return { retry: true, max_attempts: 3, delay_ms: Math.round(delay), next_action: 'retry_same_provider' };
  }

  chooseFallbackStrategy(stage, provider, context = {}) {
    if (stage === 'metadata' && provider === 'groq') return 'metadata_fallback';
    if (stage === 'gemini_script' && provider === 'gemini') return 'script_fallback';
    if (stage === 'image_generation' && provider === 'pollinations') return 'image_fallback';
    if (stage === 'tts_generation' && provider === 'edge_tts') return 'audio_fallback';
    if (stage === 'moviepy_render' && provider === 'moviepy') return 'render_fallback';
    if (stage === 'publish' && provider === 'tiktok') return 'download_only_fallback';
    return 'abort';
  }

  shouldChangeCreativeStrategy(videoHistory) {
    // If 3 consecutive videos are low performers
    const recent = videoHistory.slice(-3);
    if (recent.length === 3 && recent.every(v => v.performance_class === 'low_performer' || v.performance_class === 'failed')) {
      return true;
    }
    return false;
  }

  async buildStrategyShiftGuidance(context = {}) {
    // Depend on the learning agent collection being accessible here, or pass videos
    const videos = context.videoHistory || [];
    if (!this.shouldChangeCreativeStrategy(videos)) return null;

    const id = `shift_${Date.now()}`;
    const guidance = `- La estrategia anterior no está funcionando.
- Cambia el hook descriptivo por una pregunta directa.
- Reduce la introducción.
- Usa una estructura de curiosidad en lugar de explicación lineal.
- Mantén el video entre 20 y 30 segundos.
- Usa escenas más visuales y menos narración abstracta.
- Cambia hashtags genéricos por hashtags específicos.`;

    const shift = {
      id,
      reason: '3 consecutive low performers or failures',
      new_strategy: guidance,
      applied_at: new Date().toISOString()
    };
    await this._saveDoc('strategy_shifts', id, shift);
    
    return `Strategy shift guidance:\n${guidance}`;
  }

  async shouldPauseAutonomousMode(failures = []) {
    if (failures.length === 0) failures = await this._getCollection('failure_events');
    const recent = failures.slice(-3);
    
    // Check if 3 consecutive failures without recovery
    if (recent.length === 3 && recent.every(f => !f.resolved && f.severity === 'high')) {
      return true;
    }
    
    // Check specific criticals
    const criticalAuth = recent.find(f => f.error_type === 'auth_failure');
    if (criticalAuth) return true;
    
    return false;
  }

  async getHealthStatus() {
    let globalStatus = 'healthy';
    let hasDegraded = false;
    let hasCritical = false;

    for (const p of this.providers) {
      const cb = this.circuitBreakers[p];
      
      // Update half-open state dynamically
      if (cb.circuit_state === 'open' && cb.opened_until) {
        if (new Date() > new Date(cb.opened_until)) {
          cb.circuit_state = 'half_open';
        }
      }
      
      if (cb.circuit_state === 'open') hasCritical = true;
      if (cb.status === 'degraded' || cb.circuit_state === 'half_open') hasDegraded = true;
    }

    if (await this.shouldPauseAutonomousMode([])) globalStatus = 'paused';
    else if (hasCritical) globalStatus = 'critical';
    else if (hasDegraded) globalStatus = 'degraded';

    return { status: globalStatus, circuits: this.circuitBreakers };
  }
}
