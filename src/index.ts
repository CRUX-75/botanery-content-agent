// src/index.ts

import express, { Request, Response } from 'express';
import { config } from './config';
import { log, logError } from './lib/logger';
import { supabaseAdmin } from './lib/supabase';
import { startWorker } from './workers/mainWorker';

const app = express();
app.use(express.json());

// Health check
app.get('/healthz', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('job_queue')
      .select('id')
      .limit(1)
      .single();

    // PGRST116 = "no rows", no lo tratamos como fallo grave
    if (error && (error as any).code !== 'PGRST116') {
      throw error;
    }

    // Stats básicas (si existe la función)
    const { data: stats } = await supabaseAdmin.rpc('get_system_stats');

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'botanery-content-agent',
      database: data ? 'connected' : 'no-rows',
      stats: stats || {},
    });
  } catch (error) {
    logError('Health check failed', error);
    res.status(500).json({
      status: 'error',
      message:
        error instanceof Error ? error.message : 'Database connection failed',
    });
  }
});

// Crear job de tipo CREATE_POST
app.post('/jobs/create', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};

    // 👇 Clave: si viene body.payload, lo usamos; si no, usamos body directo
    const source = body.payload ?? body;

    const {
      format = 'IG_SINGLE',      // si no viene, por defecto single
      style = 'fun',             // default razonable
      target_channel = 'IG_FB',  // por defecto IG + FB
    } = source || {};

    const payload = {
      format,
      style,
      target_channel,
    };

    const jobType = body.job_type ?? 'CREATE_POST';

    const { data, error } = await supabaseAdmin
      .from('job_queue')
      .insert({
        job_type: jobType,
        payload,
        status: 'PENDING',
      })
      .select()
      .single();

    if (error) throw error;

    log('[API] CREATE_POST job created', { jobId: data.id, payload });
    res.json({ success: true, job: data });
  } catch (error) {
    logError('[API] Failed to create job', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create job',
    });
  }
});

// Crear job de tipo PUBLISH_POST (ADAPTADO)
app.post('/jobs/publish', async (req: Request, res: Response) => {
  try {
    const { post_id, postId, force = false } = req.body || {};

    // ✅ Normalizamos a postId si viene alguno
    const finalPostId = postId || post_id;

    // ⚡ CAMBIO CLAVE: Ya no lanzamos error si no hay ID.
    // Construimos el payload dinámicamente.
    const payload: Record<string, any> = { force };

    if (finalPostId) {
      payload.postId = finalPostId;
    }
    // Si no hay finalPostId, el payload va sin ID y el Worker buscará el DRAFT más antiguo.

    const { data, error } = await supabaseAdmin
      .from('job_queue')
      .insert({
        job_type: 'PUBLISH_POST',
        payload,
        status: 'PENDING',
      })
      .select()
      .single();

    if (error) throw error;

    log('[API] PUBLISH_POST job created', {
      jobId: data.id,
      payload: data.payload,
    });
    res.json({ success: true, job: data });
  } catch (error) {
    logError('[API] Failed to create publish job', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create job',
    });
  }
});

// Crear job de tipo COLLECT_FEEDBACK
app.post('/jobs/feedback', async (req: Request, res: Response) => {
  try {
    const { post_id, min_age_hours = 24 } = req.body || {};

    const { data, error } = await supabaseAdmin
      .from('job_queue')
      .insert({
        job_type: 'COLLECT_FEEDBACK',
        payload: { post_id, min_age_hours },
        status: 'PENDING',
      })
      .select()
      .single();

    if (error) throw error;

    log('[API] COLLECT_FEEDBACK job created', { jobId: data.id });
    res.json({ success: true, job: data });
  } catch (error) {
    logError('[API] Failed to create feedback job', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create job',
    });
  }
});

// Ver posts recientes con métricas
app.get('/posts', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('v_posts_with_metrics')
      .select('*')
      .limit(20);

    if (error) throw error;

    res.json({ success: true, posts: data });
  } catch (error) {
    logError('[API] Failed to get posts', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get posts',
    });
  }
});

// Ver jobs pendientes
app.get('/jobs', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('v_pending_jobs')
      .select('*');

    if (error) throw error;

    res.json({ success: true, jobs: data });
  } catch (error) {
    logError('[API] Failed to get jobs', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get jobs',
    });
  }
});

const PORT = config.server.port;

app.listen(PORT, () => {
  log(`✅ Server running on http://localhost:${PORT}`);
  log(`Environment: ${config.server.nodeEnv}`);
  log(`Health check: http://localhost:${PORT}/healthz`);

  // Arrancar worker principal
  startWorker().catch((error: unknown) => {
    logError('[WORKER] Failed to start worker', error);
  });
});
