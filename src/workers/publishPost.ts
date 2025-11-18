// src/workers/publishPost.ts

import { supabaseAdmin } from '../lib/supabase';
import { metaClient } from '../lib/metaClient';
import { log, logError } from '../lib/logger';
import { GeneratedPost } from '../types/database';

type PublishJobPayload = {
  post_id?: string;
  force?: boolean;
};

type PublishResults = {
  igMediaId?: string;
  fbPostId?: string;
};

export async function publishPostJob(payload: PublishJobPayload) {
  log('[PUBLISH_POST] Starting job', payload);

  try {
    let post: GeneratedPost | null = null;

    // 1) Opción A: nos pasan un post concreto por ID
    if (payload.post_id) {
      const { data, error } = await supabaseAdmin
        .from('generated_posts')
        .select('*')
        .eq('id', payload.post_id)
        .single();

      if (error || !data) {
        throw new Error(`Post ${payload.post_id} not found`);
      }

      post = data;
    } else {
      // 2) Opción B: coger el siguiente DRAFT disponible (FIFO)
      const { data, error } = await supabaseAdmin
        .from('generated_posts')
        .select('*')
        .eq('status', 'DRAFT')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

      if (error || !data) {
        log('[PUBLISH_POST] No drafts available to publish');
        return;
      }

      post = data;
    }

    if (!post) {
      throw new Error('Post not found');
    }

    // 3) Verificar estado del post
    if (post.status !== 'DRAFT' && !payload.force) {
      log('[PUBLISH_POST] Post is not in DRAFT status, skipping', {
        status: post.status,
        id: post.id,
      });
      return;
    }

    log('[PUBLISH_POST] Publishing post', {
      postId: post.id,
      format: post.format,
      channel_target: post.channel_target,
    });

    // 4) Construir caption final
    const fullCaption = buildCaption(post);

    // 5) Publicar en IG/FB según channel_target
    const results = await publishToChannels(post, fullCaption);

    // 6) Si no se ha publicado en ningún canal, el job es un FAIL
    if (!results.igMediaId && !results.fbPostId) {
      throw new Error(
        `[PUBLISH_POST] No channel was published successfully for post ${post.id}`
      );
    }

    // 7) Actualizar el post con los IDs de publicación
    const updateData: Partial<GeneratedPost> = {
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      ig_media_id: results.igMediaId ?? (post as any).ig_media_id ?? null,
      fb_post_id: results.fbPostId ?? (post as any).fb_post_id ?? null,
      channel: determineChannel(results),
    };

    const { error: updateError } = await supabaseAdmin
      .from('generated_posts')
      .update(updateData)
      .eq('id', post.id);

    if (updateError) {
      throw new Error(
        `[PUBLISH_POST] Failed to update generated_posts: ${updateError.message}`
      );
    }

    // 8) Crear entrada en post_feedback (si no existe ya)
    const { error: feedbackError } = await supabaseAdmin
      .from('post_feedback')
      .insert({
        post_id: post.id,
        metrics: {},
        perf_score: 0,
        collection_count: 0,
      });

    // 23505 = unique_violation → la fila ya existe, no es crítico
    if (feedbackError && (feedbackError as any).code !== '23505') {
      logError(
        '[PUBLISH_POST] Failed to create feedback entry',
        feedbackError
      );
    }

    log('[PUBLISH_POST] ✅ Post published successfully', {
      postId: post.id,
      igMediaId: results.igMediaId,
      fbPostId: results.fbPostId,
    });

    return { success: true, post, results };
  } catch (error: any) {
    logError('[PUBLISH_POST] Job failed', error?.response?.data || error);
    throw error;
  }
}

/**
 * Construye el caption final uniendo hook, body, cta y hashtag_block.
 */
function buildCaption(post: GeneratedPost): string {
  const parts = [post.hook, '', post.body, '', post.cta];

  if (post.hashtag_block) {
    parts.push('');
    parts.push(post.hashtag_block);
  }

  return parts.filter((p) => p !== undefined && p !== null).join('\n');
}

/**
 * Publica en IG/FB según channel_target.
 * IG es crítico (si falla, falla el job). FB por ahora es best-effort.
 */
async function publishToChannels(
  post: GeneratedPost,
  caption: string
): Promise<PublishResults> {
  const results: PublishResults = {};

  const publishToIG =
    post.channel_target === 'IG_FB' || post.channel_target === 'IG_ONLY';
  const publishToFB =
    post.channel_target === 'IG_FB' || post.channel_target === 'FB_ONLY';

  // Instagram (crítico)
  if (publishToIG) {
    try {
      results.igMediaId = await publishInstagramSingle(post, caption);

      if (!results.igMediaId) {
        throw new Error(
          `[PUBLISH_POST] metaClient.publishInstagramSingle returned empty igMediaId for post ${post.id}`
        );
      }
    } catch (error: any) {
      logError(
        '[PUBLISH_POST] Instagram publication failed',
        error?.response?.data || error
      );
      // relanzamos: el worker marcará el job como FAILED
      throw error;
    }
  }

  // Facebook (no crítico por ahora)
  if (publishToFB) {
    try {
      results.fbPostId = await publishFacebookSingle(post, caption);

      if (!results.fbPostId) {
        logError(
          '[PUBLISH_POST] Facebook returned empty fbPostId',
          { postId: post.id }
        );
      }
    } catch (error: any) {
      logError(
        '[PUBLISH_POST] Facebook publication failed',
        error?.response?.data || error
      );
      // si quisieras que también rompa el job, aquí podrías hacer: throw error;
    }
  }

  return results;
}

/**
 * Publicación simple en Instagram: una sola imagen + caption.
 * Usa image_url del propio post. Si no está, rompe.
 */
async function publishInstagramSingle(
  post: GeneratedPost,
  caption: string
): Promise<string> {
  const postImageUrl = ((post as any).image_url as string | null) ?? null;

  if (!postImageUrl || !postImageUrl.trim().length) {
    throw new Error(
      `[PUBLISH_POST] Post ${post.id} has no image_url set. Make sure generated_posts.image_url is filled when creating the draft.`
    );
  }

  log('[PUBLISH_POST] Using post image_url for IG publish', {
    postId: post.id,
    imageUrl: postImageUrl,
  });

  const igMediaId = await metaClient.publishInstagramSingle({
    image_url: postImageUrl,
    caption,
  });

  if (!igMediaId) {
    throw new Error(
      `[PUBLISH_POST] metaClient.publishInstagramSingle did not return igMediaId for post ${post.id}`
    );
  }

  return igMediaId;
}

/**
 * Publicación simple en Facebook: texto + link a la tienda.
 */
async function publishFacebookSingle(
  post: GeneratedPost,
  message: string
): Promise<string> {
  const fbPostId = await metaClient.publishFacebookPost({
    message,
    link: 'https://dogonauts.de',
  });

  return fbPostId;
}

/**
 * Devuelve qué canales se han publicado realmente en base a las IDs presentes.
 */
function determineChannel(results: PublishResults): 'IG' | 'FB' | 'BOTH' {
  if (results.igMediaId && results.fbPostId) return 'BOTH';
  if (results.igMediaId) return 'IG';
  if (results.fbPostId) return 'FB';

  // Si llega aquí, es bug lógico porque antes ya comprobamos que haya al menos un ID
  throw new Error(
    '[PUBLISH_POST] determineChannel called with no igMediaId or fbPostId'
  );
}
