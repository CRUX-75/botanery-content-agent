// src/workers/mainWorker.ts
import { supabaseAdmin } from '../lib/supabase';
import { log, logError } from '../lib/logger';
import { createPostJob } from './createPost';
import { publishPostJob } from './publishPost';
import { collectFeedbackJob } from './feedbackWorker';
import { config } from '../config';

type JobRow = {
  id: string;
  job_type: string;
  payload: any;
  status: string;
  attempts: number;
};

async function pollJobs() {
  try {
    const { data: job, error } = await supabaseAdmin
      .from('job_queue')
      .select('*')
      .eq('status', 'PENDING')
      .order('created_at', { ascending: true })
      .limit(1)
      .single<JobRow>();

    // Si no hay jobs pendientes, salimos en silencio
    if (error || !job) {
      return;
    }

    log(`[WORKER] Processing job ${job.id} of type ${job.job_type}`);

    // Marcar como IN_PROGRESS
    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'IN_PROGRESS',
        started_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    try {
      // Ejecutar según tipo
      if (job.job_type === 'CREATE_POST') {
        await createPostJob(job.payload || {});
      } else if (job.job_type === 'PUBLISH_POST') {
        await publishPostJob(job.payload || {});
      } else if (job.job_type === 'COLLECT_FEEDBACK') {
        await collectFeedbackJob(job.payload || {});
      } else {
        throw new Error(`Unknown job type: ${job.job_type}`);
      }

      // Marcar como COMPLETED
      await supabaseAdmin
        .from('job_queue')
        .update({
          status: 'COMPLETED',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      log(`[WORKER] Job ${job.id} completed successfully`);
    } catch (jobError) {
      // Marcar como FAILED
      await supabaseAdmin
        .from('job_queue')
        .update({
          status: 'FAILED',
          error_message:
            jobError instanceof Error ? jobError.message : 'Unknown error',
          attempts: (job.attempts || 0) + 1,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      logError('[WORKER] Job failed', jobError);
    }
  } catch (error) {
    logError('[WORKER] Job processing failed', error);
  }
}

export async function startWorker() {
  const pollInterval =
    (config as any).worker?.pollInterval ?? 5000; // fallback 5s

  log('[WORKER] Starting job worker...');
  log(`[WORKER] Poll interval: ${pollInterval}ms`);

  // Primera ejecución inmediata
  await pollJobs();

  // Loop periódico
  setInterval(() => {
    void pollJobs();
  }, pollInterval);
}
