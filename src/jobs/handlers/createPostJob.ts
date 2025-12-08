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

const IMAGE_BUCKET = 'botanery-assets';
const MAX_CAROUSEL_SLIDES = 4;

/**
 * Determina posibles prefijos de carpeta en el bucket según el producto.
 * La idea es soportar:
 *  - Carpetas por producto (p.ej.: "orchids/sku-1234")
 *  - Carpetas por familia: "orchids", "sukkulenten", "colomi_granulat"
 */
function getBucketPrefixesForProduct(product: ProductLike): string[] {
  const prefixes: string[] = [];
  const p: any = product;

  // Si en el futuro añades un campo dedicado, lo usamos primero
  if (p.image_folder && typeof p.image_folder === 'string') {
    prefixes.push(p.image_folder);
  }

  // Intento con handle / slug si existe
  if (p.handle && typeof p.handle === 'string') {
    // Ejemplo: orchids/<handle>
    prefixes.push(`orchids/${p.handle}`);
    prefixes.push(`sukkulenten/${p.handle}`);
    prefixes.push(`colomi_granulat/${p.handle}`);
  }

  // Mapear por categoría
  const rawCategory =
    (p.product_category ||
      p.category ||
      p.product_type ||
      '') as string;
  const category = rawCategory.toLowerCase();

  if (category.includes('orchid') || category.includes('orchidee')) {
    prefixes.push('orchids');
  }
  if (category.includes('sukkul')) {
    prefixes.push('sukkulenten');
  }
  if (category.includes('granulat') || category.includes('substrat') || category.includes('colomi')) {
    prefixes.push('colomi_granulat');
  }

  // Fallback muy seguro: familia principal
  if (prefixes.length === 0) {
    prefixes.push('orchids');
  }

  // Quitar duplicados
  return Array.from(new Set(prefixes));
}

function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

/**
 * Devuelve hasta `maxSlides` URLs públicas de imágenes desde el bucket
 * siguiendo esta lógica:
 *  1) Probar carpetas más específicas (producto)
 *  2) Luego carpetas de familia (orchids / sukkulenten / colomi_granulat)
 *  3) Si no hay resultados, devuelve []
 */
async function getCarouselImagesFromBucket(
  product: ProductLike,
  maxSlides: number = MAX_CAROUSEL_SLIDES,
): Promise<string[]> {
  const prefixes = getBucketPrefixesForProduct(product);

  console.log('[BUCKET] Buscando imágenes para producto en prefijos:', prefixes);

  for (const prefix of prefixes) {
    try {
      const { data, error } = await supabaseAdmin.storage
        .from(IMAGE_BUCKET)
        .list(prefix, {
          limit: 50,
          sortBy: { column: 'name', order: 'asc' },
        });

      if (error) {
        console.warn(
          `[BUCKET] Error listando carpeta "${prefix}" en ${IMAGE_BUCKET}:`,
          error.message || error,
        );
        continue;
      }

      if (!data || data.length === 0) {
        console.log(
          `[BUCKET] Carpeta "${prefix}" vacía o sin ficheros, probando siguiente...`,
        );
        continue;
      }

      const files = data
        .filter((f) => !f.name.startsWith('.'))
        .filter((f) => isImageFile(f.name))
        .slice(0, maxSlides);

      if (files.length === 0) {
        console.log(
          `[BUCKET] Carpeta "${prefix}" sin imágenes válidas, probando siguiente...`,
        );
        continue;
      }

      const urls = files.map((file) => {
        const path = `${prefix}/${file.name}`;
        const { data: publicData } = supabaseAdmin.storage
          .from(IMAGE_BUCKET)
          .getPublicUrl(path);

        return publicData.publicUrl;
      });

      if (urls.length > 0) {
        console.log(
          `[BUCKET] Encontradas ${urls.length} imágenes en "${prefix}"`,
        );
        return urls.slice(0, maxSlides);
      }
    } catch (err: any) {
      console.warn(
        `[BUCKET] Excepción leyendo carpeta "${prefix}" en ${IMAGE_BUCKET}:`,
        err?.message || String(err),
      );
    }
  }

  console.log(
    '[BUCKET] No se encontraron imágenes en ninguna carpeta candidata, devolviendo [].',
  );
  return [];
}

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

    // 3.1) Intentar obtener imágenes reales desde el bucket
    let bucketImages: string[] = [];
    try {
      bucketImages = await getCarouselImagesFromBucket(
        product as ProductLike,
        MAX_CAROUSEL_SLIDES,
      );
    } catch (err: any) {
      console.warn(
        '[CREATE_POST] Error al intentar cargar imágenes desde el bucket:',
        err?.message || String(err),
      );
    }

    console.log('[CREATE_POST] Resultado búsqueda bucket', {
      bucketImagesCount: bucketImages.length,
      bucketImages,
    });

    // 3.2) Modo bestia: SIEMPRE queremos carrusel (máx. 4 slides)
    const wantsCarousel = true;

    let carouselImages: string[] | null = null;
    let format: 'IG_SINGLE' | 'IG_CAROUSEL' = 'IG_CAROUSEL';
    let slideCount = 4;

    if (wantsCarousel) {
      // PRIORIDAD 1 → Bucket (imágenes reales de producto/familia)
      if (Array.isArray(bucketImages) && bucketImages.length >= 2) {
        carouselImages = bucketImages.slice(0, MAX_CAROUSEL_SLIDES);
        format = 'IG_CAROUSEL';
        slideCount = carouselImages.length;
        visualFormat = `carousel_${slideCount}_bucket`;
        console.log(
          `[CREATE_POST] Usando ${slideCount} imágenes del bucket para el carrusel.`,
        );
      }
      // PRIORIDAD 2 → Pipeline avanzado (si trajo varias imágenes)
      else if (
        Array.isArray(visualAssets.carouselImages) &&
        visualAssets.carouselImages.length >= 2
      ) {
        carouselImages = visualAssets.carouselImages.slice(
          0,
          MAX_CAROUSEL_SLIDES,
        );
        format = 'IG_CAROUSEL';
        slideCount = carouselImages.length;
        console.log(
          `[CREATE_POST] Usando ${slideCount} imágenes del pipeline avanzado.`,
        );
      }
      // PRIORIDAD 3 → Fallback: duplicar mainImage 4 veces
      else {
        console.log(
          '[CREATE_POST] Fallback carrusel: duplicando mainImage 4 veces.',
        );
        carouselImages = Array(MAX_CAROUSEL_SLIDES).fill(visualAssets.mainImage);
        format = 'IG_CAROUSEL';
        slideCount = MAX_CAROUSEL_SLIDES;
        if (visualFormat === 'single_legacy') {
          visualFormat = `carousel_${MAX_CAROUSEL_SLIDES}`;
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

    const channelTarget: 'IG_FB' | 'IG_ONLY' | 'FB_ONLY' = 'IG_ONLY';

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
        slide_count: slideCount,
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
