// src/jobs/handlers/createPostJob.ts

import { featureFlags } from '../../lib/feature-flags';
import { supabaseAdmin } from '../../lib/supabase';
import { getTemplateForProduct } from '../../lib/visual-templates';
import { generateBasicImage, ProductLike } from '../../lib/visual-generator';
import { uploadToSupabase } from '../../lib/upload';
import { generatePostContent } from '../../lib/prompt-generator';
import { selectProduct } from '../../lib/product-selector';
import { generateAdvancedVisuals } from '../../lib/visual-generator-v2';

type VisualAssets = {
  mainImage: string;
  carouselImages: string[] | null;
};

type CreatePostPayload = {
  format?: 'IG_SINGLE' | 'IG_CAROUSEL';
  style?: string;
  // Admite valores legacy ('IG', 'FB', 'BOTH') y los nuevos válidos para la DB
  target_channel?: 'IG' | 'FB' | 'BOTH' | 'IG_ONLY' | 'FB_ONLY' | 'IG_FB';
};

export async function createPostJob(job: any) {
  try {
    console.log('\n--- CREATE POST JOB START ---');
    console.log(`Job ID: ${job?.id ?? 'unknown'}`);
    console.log('Job payload:', job?.payload ?? {});

    const payload: CreatePostPayload = job?.payload ?? {};
    const requestedFormat = payload.format;
    const requestedChannel = payload.target_channel;

    // 1) Seleccionar producto
    const product = await selectProduct();
    console.log(
      `🎯 Producto recibido del selector: ${product.product_name} (${product.id})`,
    );

    // 2) FEATURE FLAG: FORZAMOS TRUE PARA PROBAR CARRUSELES
    // En producción deberías reactivar la lógica del flag, pero ahora queremos ver las imágenes.
    let useAdvancedVisual = true; 
    
    /* try {
      useAdvancedVisual = await featureFlags.shouldUseFeature(
        'advanced_visuals_enabled',
        product.id.toString(),
      );
    } catch (e) {
      console.warn('⚠️ Error flag, defaulting to false', e);
      useAdvancedVisual = false;
    } 
    */
    
    console.log(`🎛️ advanced_visual flag (FORZADO) = ${useAdvancedVisual}`);

    // 3) Obtener template
    const template = getTemplateForProduct(product);
    console.log(
      `📐 Template detectado: ${product.product_category ?? 'n/a'} → ${
        template.type
      }`,
    );

    let visualAssets: VisualAssets;
    let visualFormat = 'single_legacy';
    let templateVersion = 'v1_basic';

    if (useAdvancedVisual) {
      console.log('🚀 Usando pipeline avanzado (v2)');
      // Esto es lo que genera las 4 imágenes reales
      const adv = await generateAdvancedVisuals(
        product as ProductLike,
        template,
      );

      visualAssets = {
        mainImage: adv.mainImage,
        carouselImages: adv.carouselImages ?? null,
      };
      visualFormat = template.type; 
      templateVersion = adv.templateVersion;
    } else {
      console.log('📦 Usando pipeline legacy');
      const buffer = await generateBasicImage(product as ProductLike);
      const url = await uploadToSupabase(buffer, `legacy-${product.id}.png`);

      visualAssets = {
        mainImage: url,
        carouselImages: null,
      };
      visualFormat = 'single_legacy';
      templateVersion = 'v1_basic';
    }

    // 3.1) ¿Este job quiere carrusel?
    const wantsCarousel = requestedFormat === 'IG_CAROUSEL';

    let carouselImages: string[] | null = null;

    if (wantsCarousel) {
      // Si el pipeline V2 nos dio imágenes, las usamos
      if (
        Array.isArray(visualAssets.carouselImages) &&
        visualAssets.carouselImages.length >= 2
      ) {
        carouselImages = visualAssets.carouselImages;
      } else {
        // FALLBACK: Si falló V2 o estamos en legacy, repetimos la imagen 4 veces
        console.log(
          '[CREATE_POST] Fallback: Duplicando mainImage para cumplir con IG_CAROUSEL.',
        );
        carouselImages = Array(4).fill(visualAssets.mainImage);
        if (visualFormat === 'single_legacy') {
          visualFormat = 'carousel_4';
        }
      }
    } else {
      // Si no quiere carrusel, respetamos lo que venga (generalmente null)
      carouselImages = visualAssets.carouselImages;
    }

    const hasCarousel =
      Array.isArray(carouselImages) && carouselImages.length >= 2;

    const format: 'IG_SINGLE' | 'IG_CAROUSEL' = hasCarousel
      ? 'IG_CAROUSEL'
      : 'IG_SINGLE';

    const slideCount = hasCarousel ? carouselImages!.length : 1;

    console.log('[CREATE_POST] Visual decision', {
      format,
      slideCount,
      carouselImagesLength: carouselImages?.length ?? 0,
    });

    // 4) Generar copy
    const postContent = await generatePostContent(product);

    // 5) Canal objetivo – normalizado y por defecto solo IG
    const rawChannel = requestedChannel ?? 'IG_ONLY';

    // Normalizamos a los valores que acepta la DB: 'IG_FB' | 'IG_ONLY' | 'FB_ONLY'
    const channelTarget: 'IG_FB' | 'IG_ONLY' | 'FB_ONLY' =
      rawChannel === 'IG_ONLY' || rawChannel === 'FB_ONLY' || rawChannel === 'IG_FB'
        ? rawChannel
        : rawChannel === 'IG'
        ? 'IG_ONLY'
        : rawChannel === 'FB'
        ? 'FB_ONLY'
        : rawChannel === 'BOTH'
        ? 'IG_FB'
        : 'IG_ONLY';

    console.log('[CREATE_POST] Channel target decision', {
      requestedChannel,
      rawChannel,
      channelTarget,
    });

    // 6) Insertar DRAFT
    const { data: post, error } = await supabaseAdmin
      .from('generated_posts')
      .insert({
        product_id: product.id,
        caption_ig: postContent.caption_ig,
        caption_fb: postContent.caption_fb,
        composed_image_url: visualAssets.mainImage,
        carousel_images: carouselImages, // ¡AQUÍ SE GUARDAN LAS URLS!
        visual_format: visualFormat,
        template_version: templateVersion,
        use_advanced_visual: useAdvancedVisual,
        format,
        slide_count: slideCount,
        status: 'DRAFT',
        style: postContent.style,
        channel_target: channelTarget,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ DRAFT creado correctamente: ${post.id}`);
    console.log('--- CREATE POST JOB END ---\n');

    await supabaseAdmin
      .from('job_queue')
      .update({ status: 'COMPLETED' })
      .eq('id', job.id);
  } catch (err: any) {
    console.error('❌ Error en createPostJob:', err);
    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'FAILED',
        error: err?.message || String(err),
        attempts: (job?.attempts ?? 0) + 1,
      })
      .eq('id', job?.id);
    throw err;
  }
}
