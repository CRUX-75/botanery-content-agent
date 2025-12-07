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

    // 2) Leer feature flag (si peta, forzamos false)
    let useAdvancedVisual = false;
    try {
      useAdvancedVisual = await featureFlags.shouldUseFeature(
        'advanced_visuals_enabled',
        product.id.toString(),
      );
    } catch (e) {
      console.warn(
        '⚠️ Error leyendo feature flag advanced_visuals_enabled, usando false:',
        e,
      );
      useAdvancedVisual = false;
    }
    console.log(`🎛️ advanced_visual flag = ${useAdvancedVisual}`);

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
  const adv = await generateAdvancedVisuals(
    product as ProductLike,
    template,
  );

  visualAssets = {
    mainImage: adv.mainImage,
    carouselImages: adv.carouselImages ?? null,
  };
  visualFormat = template.type; // p.ej. 'single_modern' | 'carousel_4'
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

// Normalizamos carouselImages:
// - Si el pipeline avanzado ya da slides → las usamos.
// - Si NO, pero el job pide IG_CAROUSEL → fallback: 4x la misma imagen.
let carouselImages: string[] | null = null;

if (wantsCarousel) {
  if (
    Array.isArray(visualAssets.carouselImages) &&
    visualAssets.carouselImages.length >= 2
  ) {
    carouselImages = visualAssets.carouselImages;
  } else {
    console.log(
      '[CREATE_POST] No carouselImages from advanced pipeline. Using fallback (4x mainImage).',
    );
    carouselImages = Array(4).fill(visualAssets.mainImage);
    if (visualFormat === 'single_legacy') {
      visualFormat = 'carousel_4';
    }
  }
} else {
  carouselImages = visualAssets.carouselImages;
}

const hasCarousel =
  Array.isArray(carouselImages) && carouselImages.length >= 2;

const format: 'IG_SINGLE' | 'IG_CAROUSEL' = hasCarousel
  ? 'IG_CAROUSEL'
  : 'IG_SINGLE';

const slideCount = hasCarousel ? carouselImages!.length : 1;

console.log('[CREATE_POST] Visual decision', {
  useAdvancedVisual,
  visualFormat,
  templateVersion,
  requestedFormat,
  wantsCarousel,
  hasCarousel,
  format,
  slideCount,
  carouselImagesLength: carouselImages?.length ?? 0,
  carouselImages: carouselImages, // 👈 Agregué esto para debug
});
    // 4) Generar copy
    const postContent = await generatePostContent(product);

    // 5) Canal objetivo (por defecto BOTH)
    const channelTarget = requestedChannel ?? 'BOTH';

    // 6) Insertar DRAFT
    const { data: post, error } = await supabaseAdmin
      .from('generated_posts')
      .insert({
        product_id: product.id,
        caption_ig: postContent.caption_ig,
        caption_fb: postContent.caption_fb,
        composed_image_url: visualAssets.mainImage,
        carousel_images: carouselImages,
        visual_format: visualFormat, // 'single_legacy' o 'carousel_4'
        template_version: templateVersion,
        use_advanced_visual: useAdvancedVisual,
        format, // 'IG_SINGLE' o 'IG_CAROUSEL'
        slide_count: slideCount,
        status: 'DRAFT',
        style: postContent.style,
        channel_target: channelTarget,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log(`✅ DRAFT creado correctamente: ${post.id}`);
    console.log('--- CREATE POST JOB END ---\n');

    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'COMPLETED',
      })
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
