// src/jobs/handlers/publishPostJob.ts
import { supabaseAdmin } from '../../lib/supabase';
import { metaClient } from '../../lib/metaClient';

interface JobLike {
  id: string;
  attempts?: number;
  payload: {
    postId?: string;
    post_id?: string;
    force?: boolean;
    [key: string]: any;
  };
}

export async function publishPostJob(job: JobLike): Promise<void> {
  console.log('\n--- PUBLISH POST JOB START ---');
  console.log(`Job ID: ${job.id}`);

  const attempts = job.attempts ?? 0;

  try {
    const explicitPostId =
      job.payload?.postId || job.payload?.post_id || null;

    // Por defecto: coge el ÚLTIMO DRAFT (LIFO)
    let query = supabaseAdmin
      .from('generated_posts')
      .select('*')
      .eq('status', 'DRAFT')
      .order('created_at', { ascending: false }) // 👈 AHORA el más nuevo
      .limit(1)
      .single();

    if (explicitPostId) {
      query = supabaseAdmin
        .from('generated_posts')
        .select('*')
        .eq('id', explicitPostId)
        .eq('status', 'DRAFT')
        .single();
    }

    console.log(
      explicitPostId
        ? `🔍 Buscando post ${explicitPostId}...`
        : '🔍 Buscando ÚLTIMO post DRAFT (LIFO)...',
    );

    const { data: post, error: postError } = await query;

    if (postError || !post) {
      console.error('❌ Error fetching post:', postError);
      throw new Error('No hay posts DRAFT disponibles.');
    }

    console.log(
      `📝 Post encontrado para publicar: ${post.id} (Formato: ${post.format})`,
    );

    await supabaseAdmin
      .from('generated_posts')
      .update({ status: 'QUEUED' })
      .eq('id', post.id);

    // IG ONLY
    const rawTarget: string = post.channel_target || 'IG_ONLY';
    const channelTarget: 'IG' = 'IG';
    const publishToIG = true;
    const publishToFB = false;

    console.log('[PUBLISH_POST] Channel decision', {
      rawTarget,
      channelTarget,
      publishToIG,
      publishToFB,
    });

    const carouselImages = post.carousel_images as string[] | null;
    const isCarousel =
      post.format === 'IG_CAROUSEL' &&
      Array.isArray(carouselImages) &&
      carouselImages.length >= 2;

    let igMediaId: string | null = null;
    let fbPostId: string | null = null;

    const captionIG =
      (post.caption_ig as string | null) ||
      (post.body as string | null) ||
      '';
    const captionFB =
      (post.caption_fb as string | null) ||
      (post.body as string | null) ||
      '';

    const mainImageUrl: string | null =
      (post.composed_image_url?.trim?.() ||
        post.image_url?.trim?.()) ??
      null;

    // --- INSTAGRAM ---
if (publishToIG) {
  if (isCarousel) {
    console.log(
      `📸 Publicando CARRUSEL en Instagram (${carouselImages!.length} slides)...`,
    );

    // carouselImages ya es string[] con URLs públicas
    const imageUrls = carouselImages!;
    if (!imageUrls.length) {
      throw new Error('No hay imágenes para el carrusel de Instagram');
    }

    igMediaId = await metaClient.publishInstagramCarousel(
      imageUrls,
      captionIG,
    );
    console.log(`✅ IG Carousel OK: ${igMediaId}`);
  } else {
    console.log('🖼️ Publicando SINGLE en Instagram...');
    if (!mainImageUrl) {
      throw new Error('No image_url found for IG Single');
    }

    igMediaId = await metaClient.publishInstagramSingle({
      image_url: mainImageUrl,
      caption: captionIG,
    });
    console.log(`✅ IG Single OK: ${igMediaId}`);
  }
}


    // FB apagado
    if (publishToFB) {
      console.log('🖼️ Publicando en Facebook...');
      if (!mainImageUrl) throw new Error('No image_url found for FB');

      try {
        fbPostId = await metaClient.publishFacebookImage({
          image_url: mainImageUrl,
          caption: captionFB,
        });
        console.log(`✅ Facebook OK: ${fbPostId}`);
      } catch (error) {
        console.warn(
          '[PUBLISH_POST] Error publicando en Facebook, continuamos solo con IG',
          (error as any)?.message || error,
        );
      }
    }

    await supabaseAdmin
      .from('generated_posts')
      .update({
        status: 'PUBLISHED',
        published_at: new Date().toISOString(),
        ig_media_id: igMediaId,
        fb_post_id: fbPostId,
        channel: channelTarget,
      })
      .eq('id', post.id);

    await supabaseAdmin
      .from('post_feedback')
      .upsert(
        {
          post_id: post.id,
          metrics: {},
          perf_score: 0,
          collection_count: 0,
        },
        { onConflict: 'post_id', ignoreDuplicates: true },
      );

    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'COMPLETED',
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    console.log(`✅ Job completado para post ${post.id}`);
    console.log('--- PUBLISH POST JOB END ---\n');
  } catch (err: any) {
    console.error('❌ Error en publishPostJob:', err);

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
