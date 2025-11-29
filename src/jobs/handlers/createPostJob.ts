// src/jobs/handlers/createPostJob.ts

import { featureFlags } from '../../lib/feature-flags';
import { supabaseAdmin } from '../../lib/supabase';
import { getTemplateForProduct } from '../../lib/visual-templates';
import { generateBasicImage, ProductLike } from '../../lib/visual-generator';
import { uploadToSupabase } from '../../lib/upload';
import { generatePostContent } from '../../lib/prompt-generator';
import { selectProduct } from '../../lib/product-selector';
import { generateAdvancedVisuals } from '../../lib/visual-generator-v2';

export async function createPostJob(job: any) {
  try {
    console.log('\n--- CREATE POST JOB START ---');
    console.log(`Job ID: ${job?.id ?? 'unknown'}`);

    // 1) Seleccionar producto válido (ahora con Epsilon-Greedy bajo el capó)
    const product = await selectProduct();
    console.log(
      `🎯 Producto recibido del selector: ${product.product_name} (${product.id})`,
    );

    // 2) Leer feature flag
    const useAdvancedVisual = await featureFlags.shouldUseFeature(
      'advanced_visuals_enabled',
      product.id.toString(),
    );
    console.log(`🎛️ advanced_visual flag = ${useAdvancedVisual}`);

    // 3) Obtener template (aunque sea single)
    const template = getTemplateForProduct(product);
    console.log(
      `📐 Template detectado: ${product.product_category ?? 'n/a'} → ${template.type}`,
    );

    let visualAssets: { mainImage: string; carouselImages: string[] | null };
    let visualFormat = 'single_legacy';
    let templateVersion = 'v1_basic';

    if (useAdvancedVisual) {
      console.log('🚀 Usando pipeline avanzado (v2)');
      const adv = await generateAdvancedVisuals(product as ProductLike, template);

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
      visualAssets = { mainImage: url, carouselImages: null };
    }

    // 4) Generar copy
    const postContent = await generatePostContent(product);

    // 5) Insertar DRAFT en generated_posts
    const { data: post, error } = await supabaseAdmin
      .from('generated_posts')
      .insert({
        product_id: product.id,
        caption_ig: postContent.caption_ig,
        caption_fb: postContent.caption_fb,
        composed_image_url: visualAssets.mainImage,
        carousel_images: visualAssets.carouselImages,
        visual_format: visualFormat, // 'single_legacy' o 'single' / 'carousel'
        template_version: templateVersion, // tracking versión del engine
        use_advanced_visual: useAdvancedVisual,
        status: 'DRAFT',
        style: postContent.style,
        channel_target: 'BOTH',
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log(`✅ DRAFT creado correctamente: ${post.id}`);
    console.log('--- CREATE POST JOB END ---\n');

    // 6) Actualizar estado del job
    await supabaseAdmin
      .from('job_queue')
      .update({
        status: 'COMPLETED',
        finished_at: new Date().toISOString(),
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
        finished_at: new Date().toISOString(),
      })
      .eq('id', job?.id);

    throw err;
  }
}
