// src/jobs/handlers/publishPostJob.ts

import { supabaseAdmin } from '../../lib/supabase';
import { metaClient } from '../../lib/metaClient';
import { log, logError } from '../../lib/logger';

interface JobRow {
  id: string;
  payload: any;
  attempts?: number;
}

export async function publishPostJob(job: JobRow): Promise<void> {
  log('\n--- PUBLISH POST JOB START ---');
  log(`Job ID: ${job.id}`);

  const attempts = job.attempts ?? 0;

  try {
    // Acepta postId y post_id
    const postId =
      job.payload?.postId ||
      job.payload?.post_id ||
      null;

    if (!postId) {
      throw new Error('publishPostJob: payload.postId es obligatorio');
    }

    log(`🔍 Buscando post ${postId} en estado DRAFT...`);

    const { data: post, error: postError } = await supabaseAdmin
      .from('generated_posts')
      .select('*')
      .eq('id', postId)
      .eq('status', 'DRAFT')
      .single();

    if (postError || !post) {
      throw new Error(`Post ${postId} no encontrado o no está en estado DRAFT`);
    }

    log(`📝 Post encontrado: ${postId} — visual_format=${post.visual_format}`);

    // Marcar como QUEUED
    await supabaseAdmin
      .from('generated_posts')
      .update({ status: 'QUEUED' })
      .eq('id', postId);

    // Captions listos
    const captionIG = post.caption_ig || '';
    const captionFB = post.caption_fb || captionIG;

    const carouselImages =
      Array.isArray(post.carousel_images) ? post.carousel_images : null;

    const isCarousel =
      carouselImages && carouselImages.length >= 2;

    let igMediaId: string | null = null;
    let fbPostId: string | null = null;

    const channelTarget = post.channel_target || 'BOTH';
    const publishIG = ['IG', 'IG_ONLY', 'IG_FB', 'BOTH'].includes(channelTarget);
    const publishFB = ['FB', 'FB_ONLY', 'IG_FB', 'BOTH'].includes(channelTarget);

    log(`📡 channel_target=${channelTarget} | isCarousel=${isCarousel}`);

    // --------------- Instagram ---------------
    if (publishIG) {
      if (isCarousel) {
        log(`📸 Publicando CARRUSEL en Instagram con ${carouselImages!.length} imágenes...`);

        igMediaId = await metaClient.publishInstagramCarousel(
          carouselImages!.map((url: string) => ({ image_url: url })),
          captionIG
        );
      } else {
        log('🖼️ Publicando SINGLE en Instagram...');

        const imageUrl =
          post.composed_image_url?.trim() ||
          post.image_url?.trim();

        if (!imageUrl) {
          throw new Error(`Post ${postId} no tiene imagen válida`);
        }

        igMediaId = await metaClient.publishInstagramSingle({
          image_url: imageUrl,
          caption: captionIG,
        });
      }

      log(`✅ Instagram media_id = ${igMediaId}`);
    }

    // --------------- Facebook ---------------
    if (publishFB) {
      if (isCarousel) {
        log(`📸 Publicando CARRUSEL en Facebook...`);

        fbPostId = await metaClient.publishFacebookCarousel(
          carouselImages!,
          captionFB
        );
      } else {
        log('🖼️ Publicando SINGLE en Facebook...');

        const imageUrl =
          post.composed_image_url?.trim() ||
          post.image_url?.trim();

        fbPostId = await metaClient.publishFacebookImage({
          image_url: imageUrl!,
          caption: captionFB,
        });
      }

      log(`✅ FB post_id = ${fbPostId}`);
    }

    // --------------- Actualizar post ---------------
    await supabaseAdmin
      .from('generated_posts')
      .update({
        status: 'PUBLISHED',
        published_at: new Date().toISOString(),
        ig_media_id: igMediaId,
        fb_post_id: fbPostId,
        channel: channelTarget,
      })
      .eq('id', postId);

    // --------------- Feedback ---------------
    try {
  await supabaseAdmin
    .from('post_feedback')
    .insert({
      generated_post_id: postId,
      channel: channelTarget,
      ig_media_id: igMediaId,
      fb_post_id: fbPostId,
      metrics: {},
    });
} catch (e) {
  // Ignoramos duplicados u otros errores no críticos
  log('[PUBLISH_POST] Warning: feedback insert failed (no crítico)', e);
}


    // --------------- Marcar job como COMPLETED ---------------
    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'COMPLETED',
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    log(`✅ Post ${postId} publicado correctamente`);
    log('--- PUBLISH POST JOB END ---\n');
  } catch (err: any) {
    logError('❌ Error en publishPostJob:', err);

    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'FAILED',
        error: err?.message || String(err),
        attempts: attempts + 1,
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    throw err;
  }
}
