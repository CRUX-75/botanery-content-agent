// src/jobs/handlers/feedbackCollectJob.ts

import { supabaseAdmin } from '../../lib/supabase';
import { metaClient } from '../../lib/metaClient';

interface JobLike {
  id: string;
  attempts?: number;
  payload?: {
    max_posts?: number;
    [key: string]: any;
  };
}

type IgInsights = {
  likes: number;
  comments: number;
  saves: number | null;
  reach: number | null;
  impressions: number | null;
};

/**
 * Calcula un perf_score sencillo a partir de las métricas.
 */
function computePerfScore(m: IgInsights): number {
  const likes = m.likes || 0;
  const comments = m.comments || 0;
  const saves = m.saves || 0;
  const reach = m.reach || 0;

  // MVP de scoring:
  return Math.round(
    likes * 2 +
      comments * 3 +
      saves * 4 +
      reach * 0.01, // 100 reach ≈ +1 punto
  );
}

/**
 * Wrapper alrededor de metaClient.getInstagramMediaInsights
 * para normalizar el shape.
 */
async function fetchIgInsights(igMediaId: string): Promise<IgInsights> {
  const raw = await metaClient.getInstagramMediaInsights(igMediaId);

  return {
    likes: raw.likes ?? 0,
    comments: raw.comments ?? 0,
    saves: raw.saves ?? null,
    reach: raw.reach ?? null,
    impressions: raw.impressions ?? null,
  };
}

export async function feedbackCollectJob(job: JobLike): Promise<void> {
  console.log('\n--- FEEDBACK COLLECT JOB START ---');
  console.log(`Job ID: ${job.id}`);
  console.log('Job payload:', job.payload ?? {});

  const attempts = job.attempts ?? 0;
  const maxPosts = job.payload?.max_posts ?? 20;

  try {
    // 1) Buscar posts IG publicados con ig_media_id
    const { data: posts, error } = await supabaseAdmin
      .from('generated_posts')
      .select(
        `
        id,
        product_id,
        channel,
        ig_media_id,
        published_at
      `,
      )
      .eq('status', 'PUBLISHED')
      .eq('channel', 'IG')
      .not('ig_media_id', 'is', null)
      .order('published_at', { ascending: false })
      .limit(maxPosts);

    if (error) throw error;

    if (!posts || posts.length === 0) {
      console.log(
        '[FEEDBACK] No hay posts IG publicados pendientes de métricas. Nada que hacer.',
      );

      await supabaseAdmin
        .from('job_queue')
        .update({
          status: 'COMPLETED',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      console.log('--- FEEDBACK COLLECT JOB END (EMPTY) ---\n');
      return;
    }

    console.log(`[FEEDBACK] Posts candidatos: ${posts.length}`);

    for (const post of posts) {
      const {
        id: generatedPostId,
        ig_media_id,
        product_id,
      } = post as {
        id: string;
        ig_media_id: string | null;
        product_id: string;
      };

      if (!ig_media_id) {
        console.warn(
          `[FEEDBACK] Post ${generatedPostId} no tiene ig_media_id, saltando...`,
        );
        continue;
      }

      // 1.1 Comprobar si ya recolectamos métricas antes (collection_count > 0)
      const { data: existingFeedback, error: fbError } = await supabaseAdmin
        .from('post_feedback')
        .select('id, collection_count')
        .eq('post_id', generatedPostId)
        .maybeSingle();

      if (fbError && fbError.code !== 'PGRST116') {
        // PGRST116 = "No rows found", la ignoramos
        console.warn(
          `[FEEDBACK] Error leyendo post_feedback para ${generatedPostId}:`,
          fbError.message || fbError,
        );
      }

      const alreadyCollected =
        existingFeedback && (existingFeedback as any).collection_count > 0;

      if (alreadyCollected) {
        console.log(
          `[FEEDBACK] Post ${generatedPostId} ya tiene métricas (collection_count > 0), saltando...`,
        );
        continue;
      }

      try {
        console.log(
          `[FEEDBACK] Recuperando insights para IG media ${ig_media_id}...`,
        );
        const insights = await fetchIgInsights(ig_media_id);
        const perfScore = computePerfScore(insights);

        // 2) Upsert en post_feedback usando post_id (tu esquema real)
        const { error: pfError } = await supabaseAdmin
          .from('post_feedback')
          .upsert(
            {
              post_id: generatedPostId,
              metrics: insights as any,
              perf_score: perfScore,
              collection_count: 1, // marcamos que ya hemos recolectado
            },
            {
              onConflict: 'post_id',
            },
          );

        if (pfError) throw pfError;

        // 3) Actualizar product_performance (MVP: acumulativo)
        const { data: existingPerf, error: existingPerfError } =
          await supabaseAdmin
            .from('product_performance')
            .select('metrics, perf_score')
            .eq('product_id', product_id)
            .maybeSingle();

        if (existingPerfError && existingPerfError.code !== 'PGRST116') {
          throw existingPerfError;
        }

        const prevMetrics = (existingPerf?.metrics as any) || {};
        const prevScore = existingPerf?.perf_score ?? 0;

        const newMetrics = {
          total_likes: (prevMetrics.total_likes ?? 0) + insights.likes,
          total_comments:
            (prevMetrics.total_comments ?? 0) + insights.comments,
          total_saves: (prevMetrics.total_saves ?? 0) + (insights.saves ?? 0),
          total_reach: (prevMetrics.total_reach ?? 0) + (insights.reach ?? 0),
          total_posts: (prevMetrics.total_posts ?? 0) + 1,
        };

        const newPerfScore = prevScore + perfScore;

        const { error: upsertPerfError } = await supabaseAdmin
          .from('product_performance')
          .upsert(
            {
              product_id,
              metrics: newMetrics,
              perf_score: newPerfScore,
            },
            { onConflict: 'product_id' },
          );

        if (upsertPerfError) throw upsertPerfError;

        console.log(
          `[FEEDBACK] OK post ${generatedPostId} → perf_score=${perfScore}`,
        );
      } catch (err: any) {
        console.error(
          `[FEEDBACK] Error procesando post ${generatedPostId}:`,
          err?.message || String(err),
        );

        // Guardamos el error en post_feedback para poder verlo luego
        await supabaseAdmin
          .from('post_feedback')
          .upsert(
            {
              post_id: generatedPostId,
              metrics: {
                error: err?.message || String(err),
              } as any,
            },
            { onConflict: 'post_id' },
          );
      }
    }

    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'COMPLETED',
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    console.log('--- FEEDBACK COLLECT JOB END ---\n');
  } catch (err: any) {
    console.error('❌ Error en feedbackCollectJob:', err);

    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'FAILED',
        error_message: err?.message || String(err),
        attempts: attempts + 1,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    throw err;
  }
}
