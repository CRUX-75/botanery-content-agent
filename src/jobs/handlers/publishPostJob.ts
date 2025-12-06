// src/jobs/handlers/publishPostJob.ts

import { supabaseAdmin } from '../../lib/supabase';
import { metaClient } from '../../lib/metaClient';

interface JobLike {
  id: string;
  attempts?: number;
  payload: {
    postId?: string;
    [key: string]: any;
  };
}

type ChannelTarget = 'IG' | 'FB' | 'BOTH';

type GeneratedPostRow = {
  id: string;
  status: string;
  product_id?: string | null;
  channel_target?: string | null;
  visual_format?: string | null;
  carousel_images?: string[] | null;
  composed_image_url?: string | null;
  image_url?: string | null;
  caption_ig?: string | null;
  caption_fb?: string | null;
  hook?: string | null;
  body?: string | null;
  cta?: string | null;
  hashtag_block?: string | null;
  ig_media_id?: string | null;
  fb_post_id?: string | null;
  channel?: string | null;
};

export async function publishPostJob(job: JobLike): Promise<void> {
  console.log('\n--- PUBLISH POST JOB START ---');
  console.log(`Job ID: ${job.id}`);

  const attempts = job.attempts ?? 0;

  try {
    const postId = job.payload?.postId;

    if (!postId) {
      throw new Error('publishPostJob: payload.postId es obligatorio');
    }

    console.log(`🔍 Buscando post ${postId} en estado DRAFT...`);

    const { data: postData, error: postError } = await supabaseAdmin
      .from('generated_posts')
      .select('*')
      .eq('id', postId)
      .eq('status', 'DRAFT')
      .single();

    if (postError || !postData) {
      console.error('❌ Error fetching post:', postError);
      throw new Error(`Post ${postId} no encontrado o no está en estado DRAFT`);
    }

    const post = postData as unknown as GeneratedPostRow;

    console.log(
      `📝 Post encontrado: ${postId} — producto_id=${post.product_id ?? 'null'}, visual_format=${post.visual_format ?? 'null'}`
    );

    // Pasar a estado QUEUED antes de publicar
    await supabaseAdmin
      .from('generated_posts')
      .update({ status: 'QUEUED' })
      .eq('id', postId);

    // ─────────────────────────────────────
    // Canal objetivo
    // ─────────────────────────────────────
    const rawTarget = (post.channel_target ?? 'BOTH') as string;

    const publishToIG =
      rawTarget === 'IG' ||
      rawTarget === 'IG_ONLY' ||
      rawTarget === 'BOTH' ||
      rawTarget === 'IG_FB';

    const publishToFB =
      rawTarget === 'FB' ||
      rawTarget === 'FB_ONLY' ||
      rawTarget === 'BOTH' ||
      rawTarget === 'IG_FB';

    const channelTarget: ChannelTarget =
      publishToIG && publishToFB ? 'BOTH' : publishToIG ? 'IG' : 'FB';

    // ─────────────────────────────────────
    // Caption
    // ─────────────────────────────────────
    const captionIG = buildCaption(post, 'IG');
    const captionFB = buildCaption(post, 'FB');

    // ─────────────────────────────────────
    // Detectar carrusel
    // ─────────────────────────────────────
    const carouselImages = (post.carousel_images ?? null) as string[] | null;
    const isCarousel =
      Array.isArray(carouselImages) && carouselImages.length >= 2;

    console.log(
      `📡 channel_target=${rawTarget} → resolved=${channelTarget} | isCarousel=${isCarousel}`
    );

    let igMediaId: string | null = null;
    let fbPostId: string | null = null;

    // ─────────────────────────────────────
    // Instagram
    // ─────────────────────────────────────
    if (publishToIG) {
      if (isCarousel) {
        console.log(
          `📸 Publicando CARRUSEL en Instagram con ${carouselImages!.length} imágenes...`
        );

        const imagesPayload = carouselImages!.map((url) => ({
          image_url: url,
        }));

        igMediaId = await metaClient.publishInstagramCarousel(
          imagesPayload,
          captionIG
        );
      } else {
        console.log('🖼️ Publicando imagen simple en Instagram...');

        const imageUrl =
          (post.composed_image_url && post.composed_image_url.trim()) ||
          (post.image_url && post.image_url.trim());

        if (!imageUrl) {
          throw new Error(
            `Post ${postId} no tiene composed_image_url ni image_url para Instagram`
          );
        }

        igMediaId = await metaClient.publishInstagramSingle({
          image_url: imageUrl,
          caption: captionIG,
        });
      }

      console.log(`✅ Instagram media_id = ${igMediaId}`);
    }

    // ─────────────────────────────────────
    // Facebook
    // ─────────────────────────────────────
    if (publishToFB) {
      if (isCarousel && metaClient.publishFacebookCarousel) {
        console.log(
          `📸 Publicando CARRUSEL en Facebook con ${carouselImages!.length} imágenes...`
        );

        fbPostId = await metaClient.publishFacebookCarousel(
          carouselImages!,
          captionFB
        );
      } else {
        console.log('🖼️ Publicando imagen simple en Facebook...');

        const imageUrl =
          (post.composed_image_url && post.composed_image_url.trim()) ||
          (post.image_url && post.image_url.trim());

        if (!imageUrl) {
          throw new Error(
            `Post ${postId} no tiene composed_image_url ni image_url para Facebook`
          );
        }

        fbPostId = await metaClient.publishFacebookImage({
          image_url: imageUrl,
          caption: captionFB,
        });
      }

      console.log(`✅ Facebook post_id = ${fbPostId}`);
    }

    // ─────────────────────────────────────
    // Actualizar generated_posts
    // ─────────────────────────────────────
    const { error: updatePostError } = await supabaseAdmin
      .from('generated_posts')
      .update({
        status: 'PUBLISHED',
        published_at: new Date().toISOString(),
        ig_media_id: igMediaId,
        fb_post_id: fbPostId,
        channel: channelTarget,
      })
      .eq('id', postId);

    if (updatePostError) {
      console.error('❌ Error actualizando generated_posts:', updatePostError);
      throw updatePostError;
    }

    // ─────────────────────────────────────
    // Crear registro base en post_feedback
    // (dejamos tu esquema tal cual)
    // ─────────────────────────────────────
    const { error: feedbackError } = await supabaseAdmin
      .from('post_feedback')
      .insert({
        generated_post_id: postId,
        channel: channelTarget,
        ig_media_id: igMediaId,
        fb_post_id: fbPostId,
        metrics: {},
      });

    if (feedbackError) {
      console.error('⚠️ Error creando post_feedback:', feedbackError);
      // no tiramos el job por esto, solo log
    }

    // ─────────────────────────────────────
    // Marcar job como COMPLETED
    // ─────────────────────────────────────
    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'COMPLETED',
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    console.log(
      `✅ Post ${postId} publicado correctamente (IG: ${igMediaId}, FB: ${fbPostId})`
    );
    console.log('--- PUBLISH POST JOB END ---\n');
  } catch (err: any) {
    console.error('❌ Error en publishPostJob:', err);

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

/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

function buildCaption(post: GeneratedPostRow, target: 'IG' | 'FB'): string {
  const direct =
    target === 'IG'
      ? post.caption_ig || post.caption_fb
      : post.caption_fb || post.caption_ig;

  if (direct && direct.trim().length > 0) {
    return direct;
  }

  const parts: (string | null | undefined)[] = [];

  if (post.hook) parts.push(post.hook);
  if (post.body) {
    if (parts.length) parts.push('');
    parts.push(post.body);
  }
  if (post.cta) {
    parts.push('');
    parts.push(post.cta);
  }
  if (post.hashtag_block) {
    parts.push('');
    parts.push(post.hashtag_block);
  }

  const caption = parts
    .filter((p) => p !== undefined && p !== null)
    .join('\n');

  return caption || '';
}
