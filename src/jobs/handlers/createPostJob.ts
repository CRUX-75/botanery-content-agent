// src/jobs/handlers/createPostJob.ts

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

    // 2) Template
    const template = getTemplateForProduct(product);
    console.log(
      `📐 Template detectado: ${product.product_category ?? 'n/a'} → ${
        template.type
      }`,
    );

    // 3) Generar visual base (mainImage)
    let visualAssets: VisualAssets = {
      mainImage: '',
      carouselImages: null,
    };
    let visualFormat = 'single_legacy';
    let templateVersion = 'v1_basic';

    try {
      console.log('🚀 Intentando pipeline avanzado (v2)');
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
    } catch (e) {
      console.warn(
        '⚠️ Pipeline avanzado falló o está en stub, usando legacy:',
        e,
      );
      const buffer = await generateBasicImage(product as ProductLike);
      const url = await uploadToSupabase(buffer, `legacy-${product.id}.png`);

      visualAssets = {
        mainImage: url,
        carouselImages: null,
      };
      visualFormat = 'single_legacy';
      templateVersion = 'v1_basic';
    }

    // 3.1) Modo bestia: SIEMPRE queremos carrusel de 4 slides
    const wantsCarousel = true; // 👈 ignoramos lo que diga el payload

    let carouselImages: string[] | null = null;
    let format: 'IG_SINGLE' | 'IG_CAROUSEL' = 'IG_CAROUSEL';
    let slideCount = 4;

    if (wantsCarousel) {
      // 1º Intentamos usar imágenes del pipeline avanzado
      if (
        Array.isArray(visualAssets.carouselImages) &&
        visualAssets.carouselImages.length >= 2
      ) {
        carouselImages = visualAssets.carouselImages;
        format = 'IG_CAROUSEL';
        slideCount = carouselImages.length;
      } else {
        // 2º Fallback: duplicar la imagen principal 4 veces
        console.log(
          '[CREATE_POST] Fallback carrusel: duplicando mainImage 4 veces.',
        );
        carouselImages = Array(4).fill(visualAssets.mainImage);
        format = 'IG_CAROUSEL';
        slideCount = 4;
        if (visualFormat === 'single_legacy') {
          visualFormat = 'carousel_4';
        }
      }
    } else {
      // (no se usará, pero lo dejamos por claridad)
      format = 'IG_SINGLE';
      slideCount = 1;
      carouselImages = null;
    }

    console.log('[CREATE_POST] Visual decision', {
      requestedFormat,
      wantsCarousel,
      format,
      slideCount,
      carouselImagesLength: carouselImages?.length ?? 0,
    });

    // 4) Generar copy
    const postContent = await generatePostContent(product);

    // 5) Canal objetivo – forzado a IG_ONLY
    const rawChannel = requestedChannel ?? 'IG_ONLY';

    const channelTarget: 'IG_FB' | 'IG_ONLY' | 'FB_ONLY' = 'IG_ONLY'; // 👈 ignoramos IG_FB del payload

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
        carousel_images: carouselImages,
        visual_format: visualFormat,
        template_version: templateVersion,
        format, // IG_CAROUSEL
        slide_count: slideCount, // 4
        status: 'DRAFT',
        style: postContent.style,
        channel_target: channelTarget, // IG_ONLY
        use_advanced_visual: visualFormat !== 'single_legacy',
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
