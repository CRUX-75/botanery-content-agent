import { supabaseAdmin } from '../lib/supabase';
import { metaClient } from '../lib/metaClient';
import { log, logError } from '../lib/logger';
import { PostMetrics } from '../types/database';

type FeedbackJobPayload = {
  post_id?: string;
  min_age_hours?: number; // Solo recolectar métricas de posts con X horas de antigüedad
};

/**
 * Recolectar métricas de posts publicados
 */
export async function collectFeedbackJob(payload: FeedbackJobPayload = {}) {
  log('[COLLECT_FEEDBACK] Starting job', payload);

  try {
    // Configuración
    const minAgeHours = payload.min_age_hours || 24; // Por defecto, posts con al menos 24h
    const minAgeDate = new Date();
    minAgeDate.setHours(minAgeDate.getHours() - minAgeHours);

    let query = supabaseAdmin
      .from('generated_posts')
      .select(`
        id,
        product_id,
        format,
        style,
        angle,
        channel,
        ig_media_id,
        fb_post_id,
        published_at,
        post_feedback (
          id,
          metrics,
          perf_score,
          collected_at,
          collection_count
        )
      `)
      .eq('status', 'PUBLISHED')
      .lt('published_at', minAgeDate.toISOString());

    // Si se especifica un post_id, solo ese
    if (payload.post_id) {
      query = query.eq('id', payload.post_id);
    } else {
      // Ordenar por posts que no se han recolectado o hace más tiempo
      query = query.order('published_at', { ascending: true }).limit(10);
    }

    const { data: posts, error } = await query;

    if (error) {
      throw error;
    }

    if (!posts || posts.length === 0) {
      log('[COLLECT_FEEDBACK] No posts to collect feedback from');
      return;
    }

    log(`[COLLECT_FEEDBACK] Collecting feedback for ${posts.length} posts`);

    // Procesar cada post
    for (const post of posts) {
      try {
        await collectPostMetrics(post);
      } catch (error) {
        logError(`[COLLECT_FEEDBACK] Failed to collect metrics for post ${post.id}`, error);
        // Continuar con el siguiente post
      }
    }

    log('[COLLECT_FEEDBACK] ✅ Feedback collection completed');

  } catch (error) {
    logError('[COLLECT_FEEDBACK] Job failed', error);
    throw error;
  }
}

/**
 * Recolectar métricas de un post individual
 */
async function collectPostMetrics(post: any) {
  log(`[COLLECT_FEEDBACK] Collecting metrics for post ${post.id}`);

  const metrics: PostMetrics = {};
  let hasData = false;

  // Recolectar métricas de Instagram
  if (post.ig_media_id && post.channel !== 'FB') {
    try {
      const igMetrics = await metaClient.getInstagramMediaInsights(post.ig_media_id);
      
      metrics.likes = igMetrics.likes || 0;
      metrics.comments = igMetrics.comments || 0;
      metrics.saves = igMetrics.saved || 0;
      metrics.shares = igMetrics.shares || 0;
      metrics.reach = igMetrics.reach || 0;
      metrics.impressions = igMetrics.impressions || 0;
      
      hasData = true;
      log(`[COLLECT_FEEDBACK] IG metrics collected for ${post.id}`, igMetrics);
    } catch (error) {
      logError(`[COLLECT_FEEDBACK] Failed to get IG metrics for ${post.id}`, error);
    }
  }

  // Recolectar métricas de Facebook
  if (post.fb_post_id && post.channel !== 'IG') {
    try {
      const fbMetrics = await metaClient.getFacebookPostInsights(post.fb_post_id);
      
      // Combinar o promediar si también hay datos de IG
      if (hasData) {
        metrics.likes = (metrics.likes || 0) + fbMetrics.likes;
        metrics.comments = (metrics.comments || 0) + fbMetrics.comments;
        metrics.shares = (metrics.shares || 0) + fbMetrics.shares;
      } else {
        metrics.likes = fbMetrics.likes;
        metrics.comments = fbMetrics.comments;
        metrics.shares = fbMetrics.shares;
        metrics.reach = fbMetrics.reactions; // FB usa reactions como proxy de reach
      }
      
      hasData = true;
      log(`[COLLECT_FEEDBACK] FB metrics collected for ${post.id}`, fbMetrics);
    } catch (error) {
      logError(`[COLLECT_FEEDBACK] Failed to get FB metrics for ${post.id}`, error);
    }
  }

  if (!hasData) {
    log(`[COLLECT_FEEDBACK] No metrics available for post ${post.id}`);
    return;
  }

  // Calcular performance score
  const perfScore = calculatePerformanceScore(metrics);

  // Actualizar o insertar en post_feedback
  const feedbackExists = post.post_feedback && post.post_feedback.length > 0;
  
  if (feedbackExists) {
    const currentFeedback = post.post_feedback[0];
    await supabaseAdmin
      .from('post_feedback')
      .update({
        metrics: metrics,
        perf_score: perfScore,
        collected_at: new Date().toISOString(),
        collection_count: currentFeedback.collection_count + 1,
      })
      .eq('post_id', post.id);
  } else {
    await supabaseAdmin
      .from('post_feedback')
      .insert({
        post_id: post.id,
        metrics: metrics,
        perf_score: perfScore,
        collected_at: new Date().toISOString(),
        collection_count: 1,
      });
  }

  // Actualizar product_performance
  await updateProductPerformance(post.product_id, metrics, perfScore);

  // Actualizar style_performance
  await updateStylePerformance(post.style, post.channel, post.format, metrics, perfScore);

  log(`[COLLECT_FEEDBACK] ✅ Metrics saved for post ${post.id}`, {
    perfScore: perfScore.toFixed(4),
    likes: metrics.likes,
    reach: metrics.reach,
  });
}

/**
 * Calcular el performance score
 * Formula: (likes + 2*comments + 3*saves + 3*shares) / reach
 */
function calculatePerformanceScore(metrics: PostMetrics): number {
  const { likes = 0, comments = 0, saves = 0, shares = 0, reach = 1 } = metrics;
  
  // Evitar división por cero
  const safeReach = reach > 0 ? reach : 1;
  
  // Fórmula ponderada
  const engagement = likes + (2 * comments) + (3 * saves) + (3 * shares);
  const score = engagement / safeReach;
  
  return score;
}

/**
 * Actualizar performance del producto
 */
async function updateProductPerformance(
  productId: string,
  metrics: PostMetrics,
  perfScore: number
) {
  try {
    // Obtener performance actual
    const { data: current } = await supabaseAdmin
      .from('product_performance')
      .select('*')
      .eq('product_id', productId)
      .single();

    if (current) {
      // Actualizar existente (promedio incremental)
      const newTotalPosts = current.total_posts + 1;
      const newAvgScore = (
        (current.avg_perf_score * current.total_posts + perfScore) / newTotalPosts
      );

      await supabaseAdmin
        .from('product_performance')
        .update({
          total_posts: newTotalPosts,
          total_impressions: current.total_impressions + (metrics.impressions || 0),
          total_engagement: current.total_engagement + (metrics.likes || 0) + (metrics.comments || 0) + (metrics.saves || 0),
          avg_perf_score: newAvgScore,
          perf_score: newAvgScore, // Para Epsilon-Greedy
          last_used_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        })
        .eq('product_id', productId);
    } else {
      // Crear nuevo
      await supabaseAdmin
        .from('product_performance')
        .insert({
          product_id: productId,
          total_posts: 1,
          total_impressions: metrics.impressions || 0,
          total_engagement: (metrics.likes || 0) + (metrics.comments || 0) + (metrics.saves || 0),
          avg_perf_score: perfScore,
          perf_score: perfScore,
          last_used_at: new Date().toISOString(),
        });
    }

    log(`[COLLECT_FEEDBACK] Updated product performance for ${productId}`);
  } catch (error) {
    logError(`[COLLECT_FEEDBACK] Failed to update product performance`, error);
  }
}

/**
 * Actualizar performance de estilo/formato/canal
 */
async function updateStylePerformance(
  style: string,
  channel: string,
  format: string,
  metrics: PostMetrics,
  perfScore: number
) {
  try {
    // Normalizar formato (quitar prefijos IG_/FB_)
    const normalizedFormat = format.replace(/^(IG|FB)_/, '');
    
    // Normalizar canal
    const normalizedChannel = channel === 'BOTH' ? 'IG' : channel; // Tratamos BOTH como IG para simplificar

    // Obtener performance actual
    const { data: current } = await supabaseAdmin
      .from('style_performance')
      .select('*')
      .eq('style', style)
      .eq('channel', normalizedChannel)
      .eq('format', normalizedFormat)
      .single();

    if (current) {
      // Actualizar existente
      const newTotalPosts = current.total_posts + 1;
      const newAvgScore = (
        (current.avg_perf_score * current.total_posts + perfScore) / newTotalPosts
      );

      await supabaseAdmin
        .from('style_performance')
        .update({
          total_posts: newTotalPosts,
          total_impressions: current.total_impressions + (metrics.impressions || 0),
          total_engagement: current.total_engagement + (metrics.likes || 0) + (metrics.comments || 0) + (metrics.saves || 0),
          avg_perf_score: newAvgScore,
          perf_score: newAvgScore,
          last_updated: new Date().toISOString(),
        })
        .eq('style', style)
        .eq('channel', normalizedChannel)
        .eq('format', normalizedFormat);
    } else {
      // Crear nuevo
      await supabaseAdmin
        .from('style_performance')
        .insert({
          style: style,
          channel: normalizedChannel,
          format: normalizedFormat,
          total_posts: 1,
          total_impressions: metrics.impressions || 0,
          total_engagement: (metrics.likes || 0) + (metrics.comments || 0) + (metrics.saves || 0),
          avg_perf_score: perfScore,
          perf_score: perfScore,
        });
    }

    log(`[COLLECT_FEEDBACK] Updated style performance for ${style}/${normalizedChannel}/${normalizedFormat}`);
  } catch (error) {
    logError(`[COLLECT_FEEDBACK] Failed to update style performance`, error);
  }
}