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

    // 1) Obtener el post por ID o el primer DRAFT
    if (payload.post_id) {
      const { data, error } = await supabaseAdmin
        .from('generated_posts')
        .select('*')
        .eq('id', payload.post_id)
        .single();

      if (error || !data) {
        logError('[PUBLISH_POST] Post not found by post_id', {
          post_id: payload.post_id,
          error,
        });
        throw new Error(`Post ${payload.post_id} not found`);
      }

      post = data as GeneratedPost;
    } else {
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

      post = data as GeneratedPost;
    }

    if (!post) throw new Error('Post not found');

    // 2) Validar estado
    if (post.status !== 'DRAFT' && !payload.force) {
      log('[PUBLISH_POST] Skipping because post is not DRAFT', {
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

    // 3) Construir caption
    const caption = buildCaption(post);

    // 4) Publicar en los canales correspondientes
    const results = await publishToChannels(post, caption);

    if (!results.igMediaId && !results.fbPostId) {
      throw new Error(
        `[PUBLISH_POST] No channel was published successfully for post ${post.id}`,
      );
    }

    // 5) Actualizar DB (sin meter null en campos opcionales)
    const updateData: Partial<GeneratedPost> = {
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      ig_media_id: results.igMediaId ?? post.ig_media_id,
      fb_post_id: results.fbPostId ?? post.fb_post_id,
      channel: determineChannel(results),
    };

    const { error: updateError } = await supabaseAdmin
      .from('generated_posts')
      .update(updateData)
      .eq('id', post.id);

    if (updateError) {
      throw new Error(
        `[PUBLISH_POST] Failed to update generated_posts: ${updateError.message}`,
      );
    }

    // 6) Crear registro en feedback (si no existe)
    const { error: feedbackError } = await supabaseAdmin
      .from('post_feedback')
      .insert({
        post_id: post.id,
        metrics: {},
        perf_score: 0,
        collection_count: 0,
      });

    // ignoramos duplicado (23505)
    if (feedbackError && (feedbackError as any).code !== '23505') {
      logError(
        '[PUBLISH_POST] Failed to create feedback entry',
        feedbackError,
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

/* -------------------------------------------------------
   CAPTION BUILDER
------------------------------------------------------- */
function buildCaption(post: GeneratedPost): string {
  const parts = [post.hook, '', post.body, '', post.cta];

  if (post.hashtag_block) {
    parts.push('');
    parts.push(post.hashtag_block);
  }

  return parts.filter((p) => p !== undefined && p !== null).join('\n');
}

/* -------------------------------------------------------
   PUBLICAR EN IG / FB
------------------------------------------------------- */
async function publishToChannels(
  post: GeneratedPost,
  caption: string,
): Promise<PublishResults> {
  const results: PublishResults = {};

  // channel_target en types puede ser un enum raro, así que lo pasamos a string
  const ct = (post.channel_target as any) as string;

  const publishToIG = ct === 'IG' || ct === 'BOTH' || ct === 'IG_FB' || ct === 'IG_ONLY';
  const publishToFB = ct === 'FB' || ct === 'BOTH' || ct === 'IG_FB' || ct === 'FB_ONLY';

  log('[PUBLISH_POST] Channel resolve', {
    postId: post.id,
    channel_target: post.channel_target,
    normalized: ct,
    publishToIG,
    publishToFB,
  });

  /* ---------- INSTAGRAM ---------- */
  if (publishToIG) {
    try {
      results.igMediaId = await publishInstagram(post, caption);

      if (!results.igMediaId) {
        throw new Error(
          `[PUBLISH_POST] metaClient.publishInstagramSingle returned empty igMediaId for post ${post.id}`,
        );
      }
    } catch (error: any) {
      logError(
        '[PUBLISH_POST] Instagram publication failed',
        error?.response?.data || error,
      );
    }
  }

  /* ---------- FACEBOOK ---------- */
  if (publishToFB) {
    try {
      results.fbPostId = await publishFacebook(post, caption);

      if (!results.fbPostId) {
        logError('[PUBLISH_POST] Facebook returned empty fbPostId', {
          postId: post.id,
        });
      }
    } catch (error: any) {
      logError(
        '[PUBLISH_POST] Facebook publication failed',
        error?.response?.data || error,
      );
    }
  }

  return results;
}

/* -------------------------------------------------------
   IG PUBLISH
------------------------------------------------------- */
async function publishInstagram(
  post: GeneratedPost,
  caption: string,
): Promise<string> {
  const composedImageUrl =
    ((post as any).composed_image_url as string | null) ?? null;
  const baseImageUrl =
    ((post as any).image_url as string | null) ?? null;

  const postImageUrl = composedImageUrl || baseImageUrl;

  if (!postImageUrl || !postImageUrl.trim().length) {
    throw new Error(
      `[PUBLISH_POST] Post ${post.id} has no composed_image_url or image_url set.`,
    );
  }

  log('[PUBLISH_POST] Using image for IG publish', {
    postId: post.id,
    used: composedImageUrl ? 'composed_image_url' : 'image_url',
    imageUrl: postImageUrl,
  });

  const igMediaId = await metaClient.publishInstagramSingle({
    image_url: postImageUrl,
    caption,
  });

  if (!igMediaId) {
    throw new Error(
      `[PUBLISH_POST] metaClient.publishInstagramSingle did not return igMediaId for post ${post.id}`,
    );
  }

  return igMediaId;
}

/* -------------------------------------------------------
   FB PUBLISH
------------------------------------------------------- */
async function publishFacebook(
  post: GeneratedPost,
  caption: string,
): Promise<string> {
  const composedImageUrl =
    ((post as any).composed_image_url as string | null) ?? null;
  const baseImageUrl =
    ((post as any).image_url as string | null) ?? null;

  const postImageUrl = composedImageUrl || baseImageUrl;

  if (!postImageUrl || !postImageUrl.trim().length) {
    throw new Error(
      `[PUBLISH_POST] Post ${post.id} has no composed_image_url or image_url set.`,
    );
  }

  log('[PUBLISH_POST] Using image for FB publish', {
    postId: post.id,
    used: composedImageUrl ? 'composed_image_url' : 'image_url',
    imageUrl: postImageUrl,
  });

  const fbPostId = await metaClient.publishFacebookImage({
    image_url: postImageUrl,
    caption,
  });

  return fbPostId;
}

/* -------------------------------------------------------
   CHANNEL RESOLUTION
------------------------------------------------------- */
function determineChannel(results: PublishResults): 'IG' | 'FB' | 'BOTH' {
  if (results.igMediaId && results.fbPostId) return 'BOTH';
  if (results.igMediaId) return 'IG';
  if (results.fbPostId) return 'FB';

  throw new Error(
    '[PUBLISH_POST] determineChannel called with no igMediaId or fbPostId',
  );
}
