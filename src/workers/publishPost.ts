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

    // 🔹 Opción 1: publicar un post específico por ID
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
      // 🔹 Opción 2: siguiente DRAFT disponible (FIFO)
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

    // 🔒 Seguridad extra: evitar publicar algo que no sea DRAFT salvo force
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

    // 📝 Construir caption final
    const fullCaption = buildCaption(post);

    // 🚀 Publicar en IG/FB según channel_target
    const results = await publishToChannels(post, fullCaption);

    // ❗ Si no se ha publicado en ningún canal, el job debe FALLAR
    if (!results.igMediaId && !results.fbPostId) {
      throw new Error(
        `[PUBLISH_POST] No channel was published successfully for post ${post.id}`
      );
    }

   // 🗄️ Actualizar el post con los IDs de publicación
  const updateData: Partial<GeneratedPost> = {
    status: 'PUBLISHED',
    published_at: new Date().toISOString(),
    ig_media_id: results.igMediaId ?? (post as any).ig_media_id ?? null,
    fb_post_id: results.fbPostId ?? (post as any).fb_post_id ?? null,
    channel: determineChannel(results), // 'IG' | 'FB' | 'BOTH'
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

    // 📊 Crear entrada en post_feedback para tracking (si no existe ya)
    const { error: feedbackError } = await supabaseAdmin
      .from('post_feedback')
      .insert({
        post_id: post.id,
        metrics: {},
        perf_score: 0,
        collection_count: 0,
      });

    // 23505 = unique_violation → ya existe, no es crítico
    if (feedbackError && feedbackError.code !== '23505') {
      logError('[PUBLISH_POST] Failed to create feedback entry', feedbackError);
    }

    log('[PUBLISH_POST] ✅ Post published successfully', {
      postId: post.id,
      igMediaId: results.igMediaId,
      fbPostId: results.fbPostId,
    });

    return { success: true, post, results };
  } catch (error: any) {
    // 👀 Importante: aquí SÍ dejamos que el worker marque el job como FAILED
    logError('[PUBLISH_POST] Job failed', error?.response?.data || error);
    throw error;
  }
}

/**
 * Construye el caption final uniendo hook, body, cta + hashtag_block.
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
 * IG: obligatorio si está en IG_FB o IG_ONLY.
 * FB: opcional (por ahora un fallo en FB NO rompe el job si IG fue bien).
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

  // 🔹 Instagram (crítico: si falla, falla todo el job)
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
      // Re-lanzamos: el worker marcará el job como FAILED
      throw error;
    }
  }

  // 🔹 Facebook (no crítico de momento)
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
      // Por ahora SOLO logueamos; si quieres que también rompa el job, aquí puedes `throw error`
    }
  }

  return results;
}

/**
 * Helper para obtener la URL de imagen REAL del producto.
 * ❌ SIN placeholder: si no hay imagen, el job falla (así evitamos falsos positivos).
 */
/**
 * Helper para obtener la URL de imagen REAL del producto.
 * SIN placeholder: si no hay imagen o hay error de Supabase, el job falla.
 */
async function getProductImageUrl(productId: string): Promise<string> {
  const { data: product, error } = await supabaseAdmin
    .from('products')
    .select('id, product_name, image_url, image')
    .eq('id', productId)
    .maybeSingle(); // <--- importante: no trata "no row" como error automático

  if (error) {
    // Aquí queremos ver exactamente qué devuelve Supabase
    logError('[PUBLISH_POST] Supabase error loading product', {
      productId,
      error,
    });
    throw new Error(
      `[PUBLISH_POST] Supabase error while loading product ${productId}`
    );
  }

  if (!product) {
    logError('[PUBLISH_POST] Product row not found in products', { productId });
    throw new Error(`[PUBLISH_POST] Product not found for image: ${productId}`);
  }

  const imageUrl =
    (product.image_url as string | null) ||
    (product.image as string | null) ||
    null;

  if (!imageUrl) {
    logError('[PUBLISH_POST] Product has no image_url/image', {
      productId: product.id,
      productName: product.product_name,
    });
    throw new Error(
      `[PUBLISH_POST] Product ${product.id} (${product.product_name}) has no image_url/image`
    );
  }

  log('[PUBLISH_POST] Using product image', {
    productId: product.id,
    productName: product.product_name,
    imageUrl,
  });

  return imageUrl;
}

/**
 * Publicación simple en Instagram: una sola imagen + caption.
 * Usa metaClient.publishInstagramSingle con la URL REAL del producto.
 */
async function publishInstagramSingle(
  post: GeneratedPost,
  caption: string
): Promise<string> {
  const imageUrl = await getProductImageUrl(post.product_id as string);

  const igMediaId = await metaClient.publishInstagramSingle({
    image_url: imageUrl,
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
 * Publicación simple en Facebook: solo texto + link a la tienda.
 * (Más adelante se puede mejorar para usar también imagen/carrusel.)
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

  throw new Error(
    '[PUBLISH_POST] determineChannel called with no igMediaId or fbPostId'
  );
}

