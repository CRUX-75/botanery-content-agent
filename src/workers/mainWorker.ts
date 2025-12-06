// src/workers/mainWorker.ts

import { supabaseAdmin } from '../lib/supabase';
import { log, logError } from '../lib/logger';

import { createPostJob } from '../jobs/handlers/createPostJob';
import { publishPostJob } from '../jobs/handlers/publishPostJob';
import { feedbackCollectJob } from '../jobs/handlers/feedbackCollectJob';

type JobType = 'CREATE_POST' | 'PUBLISH_POST' | 'COLLECT_FEEDBACK';

interface JobRow {
  id: string;
  job_type: JobType;
  status: string;
  payload: any;
  attempts?: number;
  created_at: string;
}

const POLL_INTERVAL_MS = Number(
  process.env.WORKER_POLL_INTERVAL_MS || '10000',
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollJobsOnce(): Promise<void> {
  // 1) Buscar un job PENDING
  const { data, error } = await supabaseAdmin
    .from('job_queue')
    .select('*')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    logError('[WORKER] Error fetching pending job', error);
    return;
  }

  if (!data || data.length === 0) {
    // Nada que procesar en este ciclo
    return;
  }

  const job = data[0] as JobRow;

  log('[WORKER] Processing job', {
    id: job.id,
    type: job.job_type,
    status: job.status,
  });

  // 2) Marcar como IN_PROGRESS + incrementar attempts
  const attempts = (job.attempts ?? 0) + 1;

  const { error: updateError } = await supabaseAdmin
    .from('job_queue')
    .update({
      status: 'IN_PROGRESS',
      attempts,
      started_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  if (updateError) {
    logError('[WORKER] Error updating job to IN_PROGRESS', updateError);
    return;
  }

  try {
    // 3) Despachar al handler correcto
    switch (job.job_type) {
      case 'CREATE_POST':
        await createPostJob(job);
        break;

      case 'PUBLISH_POST':
        await publishPostJob(job);
        break;

      case 'COLLECT_FEEDBACK':
        // feedbackCollectJob espera un tipo Job diferente → casteamos
        await feedbackCollectJob(job as any);
        break;

      default:
        logError('[WORKER] Unknown job_type, skipping', {
          job_type: job.job_type,
        });
        break;
    }

    log('[WORKER] Job completed successfully', { jobId: job.id });
    // IMPORTANTE: cada handler ya marca el job como COMPLETED / FAILED
  } catch (err) {
    logError('[WORKER] Job handler threw error', err);
  }
}

export async function startWorker(): Promise<void> {
  log('[WORKER] Starting job worker...');
  log('[WORKER] Poll interval', { intervalMs: POLL_INTERVAL_MS });

  // Bucle principal del worker
  while (true) {
    await pollJobsOnce();
    await sleep(POLL_INTERVAL_MS);
  }
}
