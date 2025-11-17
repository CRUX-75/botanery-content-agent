import { supabaseAdmin } from '../lib/supabase';
import { metaClient } from '../lib/metaClient';
import { log, logError } from '../lib/logger';
import { GeneratedPost, PostFormat } from '../types/database';

type PublishJobPayload = {
  post_id?: string;
  force?: boolean;
};

export async function publishPostJob(payload: PublishJobPayload) {
  log('[PUBLISH_POST] Starting job', payload);

  try {
    let post: GeneratedPost | null = null;

    // Opción 1: Publicar un post específico
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
    } 
    // Opción 2: Publicar el siguiente DRAFT disponible
    else {
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

    // ✅ CORRECCIÓN: Verificar que post no sea null
    if (!post) {
      throw new Error('Post not found');
    }

    // Verificar que el post está en DRAFT (a menos que sea force)
    if (post.status !== 'DRAFT' && !payload.force) {
      log('[PUBLISH_POST] Post is not in DRAFT status', { status: post.status });
      return;
    }

    log('[PUBLISH_POST] Publishing post', {
      postId: post.id,
      format: post.format,
      channel_target: post.channel_target,
    });

    // Construir el caption completo
    const fullCaption = buildCaption(post);

    // Publicar según formato y canal
    const results = await publishToChannels(post, fullCaption);

    // Actualizar el post con los IDs de publicación
    const updateData: any = {
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      ig_media_id: results.igMediaId,
      fb_post_id: results.fbPostId,
      channel: determineChannel(results),
    };

    const { error: updateError } = await supabaseAdmin
      .from('generated_posts')
      .update(updateData)
      .eq('id', post.id);

    if (updateError) {
      throw updateError;
    }

    // Crear entrada en post_feedback para tracking
    const { error: feedbackError } = await supabaseAdmin
      .from('post_feedback')
      .insert({
        post_id: post.id,
        metrics: {},
        perf_score: 0,
        collection_count: 0,
      });

    if (feedbackError && feedbackError.code !== '23505') {
      logError('[PUBLISH_POST] Failed to create feedback entry', feedbackError);
    }

    log('[PUBLISH_POST] ✅ Post published successfully', {
      postId: post.id,
      igMediaId: results.igMediaId,
      fbPostId: results.fbPostId,
    });

    return { success: true, post, results };

  } catch (error) {
    logError('[PUBLISH_POST] Job failed', error);
    throw error;
  }
}

function buildCaption(post: GeneratedPost): string {
  const parts = [
    post.hook,
    '',
    post.body,
    '',
    post.cta,
  ];

  if (post.hashtag_block) {
    parts.push('');
    parts.push(post.hashtag_block);
  }

  return parts.join('\n');
}

async function publishToChannels(
  post: GeneratedPost,
  caption: string
): Promise<{ igMediaId?: string; fbPostId?: string }> {
  const results: { igMediaId?: string; fbPostId?: string } = {};

  const publishToIG = post.channel_target === 'IG_FB' || post.channel_target === 'IG_ONLY';
  const publishToFB = post.channel_target === 'IG_FB' || post.channel_target === 'FB_ONLY';

  if (publishToIG) {
    try {
      if (post.format === 'IG_CAROUSEL') {
        results.igMediaId = await publishInstagramCarousel(post, caption);
      } else if (post.format === 'IG_SINGLE') {
        results.igMediaId = await publishInstagramSingle(post, caption);
      } else if (post.format === 'IG_REEL') {
        log('[PUBLISH_POST] IG_REEL not implemented yet');
      }
    } catch (error) {
      logError('[PUBLISH_POST] Instagram publication failed', error);
    }
  }

  if (publishToFB) {
    try {
      if (post.format === 'FB_CAROUSEL') {
        results.fbPostId = await publishFacebookCarousel(post, caption);
      } else if (post.format === 'FB_SINGLE' || post.format === 'IG_SINGLE') {
        results.fbPostId = await publishFacebookSingle(post, caption);
      }
    } catch (error) {
      logError('[PUBLISH_POST] Facebook publication failed', error);
    }
  }

  return results;
}

async function publishInstagramCarousel(
  post: GeneratedPost,
  caption: string
): Promise<string> {
  const images = [
    { image_url: 'https://via.placeholder.com/1080x1080?text=Image+1' },
    { image_url: 'https://via.placeholder.com/1080x1080?text=Image+2' },
    { image_url: 'https://via.placeholder.com/1080x1080?text=Image+3' },
  ];

  return await metaClient.publishInstagramCarousel(images, caption);
}

async function publishInstagramSingle(
  post: GeneratedPost,
  caption: string
): Promise<string> {
  const imageUrl = 'https://via.placeholder.com/1080x1080?text=Dogonauts';

  return await metaClient.publishInstagramSingle({
    image_url: imageUrl,
    caption: caption,
  });
}

async function publishFacebookCarousel(
  post: GeneratedPost,
  message: string
): Promise<string> {
  const images = [
    'https://via.placeholder.com/1080x1080?text=Image+1',
    'https://via.placeholder.com/1080x1080?text=Image+2',
    'https://via.placeholder.com/1080x1080?text=Image+3',
  ];

  return await metaClient.publishFacebookCarousel(images, message);
}

async function publishFacebookSingle(
  post: GeneratedPost,
  message: string
): Promise<string> {
  return await metaClient.publishFacebookPost({
    message: message,
    link: 'https://dogonauts.de',
  });
}

function determineChannel(results: { igMediaId?: string; fbPostId?: string }): string {
  if (results.igMediaId && results.fbPostId) return 'BOTH';
  if (results.igMediaId) return 'IG';
  if (results.fbPostId) return 'FB';
  return 'NONE';
}