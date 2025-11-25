// src/jobs/handlers/createPostJob.ts

import { featureFlags } from '../../lib/feature-flags';
import { supabaseAdmin } from '../../lib/supabase';
import { getTemplateForProduct } from '../../lib/visual-templates';
import { generateBasicImage } from '../../lib/visual-generator';
import { uploadToSupabase } from '../../lib/upload';
import { generatePostContent } from '../../lib/prompt-generator';
import { selectProduct, ProductRow } from '../../lib/product-selector';

// ✨ STUB seguro para advanced visuals (Sprint 3.5C lo implementamos real)
async function generateAdvancedVisualStub(product: ProductRow, template: any) {
  console.log(`🧪 Stub visuals para producto ${product.id} → modo seguro`);

  // Usamos el generador legacy pero marcándolo como "advanced" a nivel metadata
  const buffer = await generateBasicImage(product);
  const imageUrl = await uploadToSupabase(
    buffer,
    `stub-advanced-${product.id}-${Date.now()}.png`
  );

  return {
    mainImage: imageUrl,
    carouselImages: null as string[] | null,
    templateVersion: 'v2_stub'
  };
}

export async function createPostJob(job: any) {
  try {
    console.log(`\n--- CREATE POST JOB START ---`);
    console.log(`Job ID: ${job?.id}`);

    // 1. Selección de producto
    const product = await selectProduct();
    console.log(
      `📦 Producto seleccionado: ${product.product_name} (${product.id})`
    );

    // 2. Decidir si usamos el nuevo sistema visual
    const useAdvancedVisual = await featureFlags.shouldUseFeature(
      'advanced_visuals_enabled',
      product.id.toString()
    );

    console.log(`🎛️ advanced_visual flag = ${useAdvancedVisual}`);

    // 3. Obtener template (aunque de momento solo lo usamos en el stub)
    const template = getTemplateForProduct(product);
    console.log(
      `📐 Template detectado: ${product.product_category || 'accessory'} → ${
        template.type
      }`
    );

    let visualAssets: any;
    let visualFormat: string = 'single_legacy';
    let templateVersion: string = 'v1_basic';

    // 4. Flujo avanzado (por ahora STUB seguro)
    if (useAdvancedVisual) {
      console.log(`🚀 Usando pipeline avanzado (STUB)`);

      visualAssets = await generateAdvancedVisualStub(product, template);
      visualFormat = template.type; // 'single' o 'carousel'
      templateVersion = visualAssets.templateVersion;
    } else {
      // 5. Flujo legacy (actual)
      console.log(`📦 Usando pipeline legacy`);

      const buffer = await generateBasicImage(product);
      const imageUrl = await uploadToSupabase(
        buffer,
        `legacy-${product.id}-${Date.now()}.png`
      );

      visualAssets = { mainImage: imageUrl, carouselImages: null };
    }

    // 6. Generar copy (tu lógica de prompt actual)
    const postContent = await generatePostContent(product);

    // 7. Guardar DRAFT en Supabase
    const { data: post, error } = await supabaseAdmin
      .from('generated_posts')
      .insert({
        product_id: product.id,
        caption_ig: postContent.caption_ig,
        caption_fb: postContent.caption_fb,
        composed_image_url: visualAssets.mainImage,
        carousel_images: visualAssets.carouselImages,
        visual_format: visualFormat,
        template_version: templateVersion,
        use_advanced_visual: useAdvancedVisual,
        status: 'DRAFT',
        style: postContent.style,
        channel_target: 'BOTH'
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log(`✅ DRAFT creado correctamente: ${post.id}`);
    console.log(`--- CREATE POST JOB END ---\n`);

    // 8. Actualizar estado del job
    if (job?.id) {
      await supabaseAdmin
        .from('job_queue')
        .update({
          status: 'COMPLETED',
          finished_at: new Date().toISOString()
        })
        .eq('id', job.id);
    }
  } catch (err: any) {
    console.error('❌ Error en createPostJob:', err);

    if (job?.id) {
      await supabaseAdmin
        .from('job_queue')
        .update({
          status: 'FAILED',
          error: err?.message || String(err),
          attempts: (job.attempts ?? 0) + 1,
          finished_at: new Date().toISOString()
        })
        .eq('id', job.id);
    }

    throw err;
  }
}
