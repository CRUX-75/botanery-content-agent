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
    // 1) postId es OPCIONAL: Si viene lo usamos, si no, buscamos el primer DRAFT
    const explicitPostId = job.payload?.postId || job.payload?.post_id || null;

    let query = supabaseAdmin
      .from('generated_posts')
      .select('*')
      .eq('status', 'DRAFT')
      .order('created_at', { ascending: true }) // El más antiguo primero (FIFO)
      .limit(1)
      .single();

    if (explicitPostId) {
      // Si n8n envió un ID explícito, lo usamos
      query = supabaseAdmin
        .from('generated_posts')
        .select('*')
        .eq('id', explicitPostId)
        .eq('status', 'DRAFT')
        .single();
    }

    console.log(
      explicitPostId
        ? `🔍 Buscando post ${explicitPostId} en estado DRAFT...`
        : '🔍 No se recibió ID. Buscando el PRIMER post disponible en estado DRAFT...'
    );

    const { data: post, error: postError } = await query;

    if (postError || !post) {
      console.error('❌ Error fetching post:', postError);
      throw new Error(
        explicitPostId
          ? `Post ${explicitPostId} no encontrado o no está en estado DRAFT`
          : 'No hay posts en estado DRAFT para publicar'
      );
    }

    console.log(
      `📝 Post encontrado para publicar: ${post.id} (Formato: ${post.visual_format})`
    );

    // Marcamos como QUEUED para evitar que otro proceso lo tome
    await supabaseAdmin
      .from('generated_posts')
      .update({ status: 'QUEUED' })
      .eq('id', post.id);

    // --- Lógica de Target (IG vs FB) ---
    const rawTarget: string = post.channel_target || 'IG_FB';
    const channelTarget: 'IG' | 'FB' | 'BOTH' =
      rawTarget === 'IG_ONLY' ? 'IG' : rawTarget === 'FB_ONLY' ? 'FB' : 'BOTH';

    const publishToIG = channelTarget === 'IG' || channelTarget === 'BOTH';
    const publishToFB = channelTarget === 'FB' || channelTarget === 'BOTH';

    let igMediaId: string | null = null;
    let fbPostId: string | null = null;

    // Helper simple para caption
    const captionIG = post.caption_ig || post.body || '';
    const captionFB = post.caption_fb || post.body || '';
    
    // URL de la imagen (prioridad a la compuesta, luego la simple)
    const imageUrl = (post.composed_image_url && post.composed_image_url.trim()) || 
                     (post.image_url && post.image_url.trim());

    if (!imageUrl) throw new Error(`El post ${post.id} no tiene imagen válida.`);

    // --- Publicar en Instagram ---
    if (publishToIG) {
        console.log('🖼️ Publicando en Instagram...');
        // Asumimos imagen simple por ahora para simplificar
        igMediaId = await metaClient.publishInstagramSingle({
          image_url: imageUrl,
          caption: captionIG,
        });
        console.log(`✅ Instagram OK: ${igMediaId}`);
    }

    // --- Publicar en Facebook ---
    if (publishToFB) {
        console.log('🖼️ Publicando en Facebook...');
        fbPostId = await metaClient.publishFacebookImage({
          image_url: imageUrl,
          caption: captionFB,
        });
        console.log(`✅ Facebook OK: ${fbPostId}`);
    }

    // --- Actualizar Post a PUBLISHED ---
    await supabaseAdmin
      .from('generated_posts')
      .update({
        status: 'PUBLISHED',
        published_at: new Date().toISOString(),
        ig_media_id: igMediaId,
        fb_post_id: fbPostId,
      })
      .eq('id', post.id);

    // ─────────────────────────────────────
    // Crear registro base en post_feedback (si no existe)
    // ─────────────────────────────────────
    // CORRECCIÓN: Usamos upsert con opciones en lugar de .onConflict() encadenado
    await supabaseAdmin
      .from('post_feedback')
      .upsert(
        {
          post_id: post.id,
          metrics: {},
          perf_score: 0,
          collection_count: 0,
        },
        { onConflict: 'post_id', ignoreDuplicates: true }
      );

    // --- Actualizar Job a COMPLETED ---
    await supabaseAdmin
      .from('job_queue')
      .update({ status: 'COMPLETED', completed_at: new Date().toISOString() })
      .eq('id', job.id);

    console.log(`✅ Proceso finalizado con éxito para post ${post.id}`);
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