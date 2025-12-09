// src/jobs/handlers/createPostJob.ts

import { supabaseAdmin } from '../../lib/supabase';
import { getTemplateForProduct, generateTemplateSlide } from '../../lib/visual-templates';
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
 * Resuelve las carpetas del bucket donde buscar imágenes según el producto.
 *
 * Estructura actual del bucket:
 *
 * botanery-assets/
 *   products/
 *     orchids/
 *     sukkulenten/
 *     colomi_granulat/
 *     ziertoepfe/
 */
function getBucketPrefixesForProduct(product: ProductLike): string[] {
  const prefixes: string[] = [];

  // Normalizamos texto para buscar palabras clave
  const name = (product as any).product_name?.toLowerCase?.() ?? '';
  const rawCategory =
    ((product as any).product_category ||
      (product as any).category ||
      (product as any).product_type ||
      '') as string;
  const category = rawCategory.toLowerCase();

  const text = `${name} ${category}`;

  // 🪴 ORCHIDS
  if (
    text.includes('orchid') ||
    text.includes('orchidee') ||
    text.includes('phalaenopsis')
  ) {
    prefixes.push('products/orchids');
  }

  // 🌵 SUKKULENTEN
  if (text.includes('sukkul')) {
    prefixes.push('products/sukkulenten');
  }

  // 🪨 COLOMI / GRANULAT / SUBSTRAT
  if (
    text.includes('granulat') ||
    text.includes('substrat') ||
    text.includes('colomi')
  ) {
    prefixes.push('products/colomi_granulat');
  }

  // 🏺 ZIERTÖPFE
  if (
    text.includes('ziertopf') ||
    text.includes('ziertoepf') || // por si acaso
    text.includes('topf') ||
    text.includes('töpfe') ||
    text.includes('toepfe') ||
    text.includes('gummy') ||
    text.includes('travertine')
  ) {
    prefixes.push('products/ziertoepfe');
  }

  // 🛟 Fallback: mientras solo haya imágenes en orchids,
  // usamos esa carpeta si nada matchea.
  if (prefixes.length === 0) {
    prefixes.push('products/orchids');
  }

  return Array.from(new Set(prefixes));
}

function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

/**
 * Devuelve hasta `maxSlides` URLs públicas de imágenes desde el bucket
 * siguiendo esta lógica:
 *  1) Probar los prefijos devueltos por getBucketPrefixesForProduct
 *  2) Si no hay resultados válidos, devuelve []
 *
 * 🔹 OJO: actualmente NO se usa en la decisión de carrusel (MVP 4-slides),
 * pero lo dejamos para futuros sprints (10-slides, etc.)
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

/**
 * 🧩 CARRUSEL 4 SLIDES — MVP
 *
 * Slide 1 → Imagen principal del producto
 * Slide 2 → Zoom / detalle (o misma que la 1 si no hay)
 * Slide 3 → Beneficio clave (template gráfico Botanery)
 * Slide 4 → CTA (template gráfico Botanery + “logo” tipográfico)
 */
async function buildCarousel4(
  product: ProductLike,
  mainImageUrl: string,
): Promise<string[]> {
  const slides: string[] = [];

  const primary =
    (product as any).image_primary_url ||
    (product as any).image_url ||
    mainImageUrl;

  const secondary =
    (product as any).image_secondary_url ||
    (product as any).image_detail_url ||
    primary;

  // Slide 1 → imagen principal
  slides.push(primary);

  // Slide 2 → detalle / secondary (si no hay, repite la principal de forma segura)
  slides.push(secondary);

  // Slide 3 → template gráfica con beneficio clave
  const slide3Buffer = await generateTemplateSlide({
    title: 'Warum Orchideen?',
    subtitle: 'Pflegeleicht, langlebig und ideal für jedes Zuhause.',
    variant: 'benefit',
  });
  const slide3Url = await uploadToSupabase(
    slide3Buffer,
    `carousel/benefit-${product.id}.png`,
  );
  slides.push(slide3Url);

  // Slide 4 → CTA con branding Botanery
  const slide4Buffer = await generateTemplateSlide({
    title: 'Entdecke mehr',
    subtitle: 'Deine Lieblingspflanzen auf botanery.de',
    variant: 'cta',
  });
  const slide4Url = await uploadToSupabase(
    slide4Buffer,
    `carousel/cta-${product.id}.png`,
  );
  slides.push(slide4Url);

  return slides;
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

    // 3.1) Decisión de formato + construcción del carrusel 4-slides (MVP)
    let format: 'IG_SINGLE' | 'IG_CAROUSEL';
    let slideCount: number;
    let carouselImages: string[] | null = null;

    if (requestedFormat === 'IG_SINGLE') {
      // Si explícitamente se pide SINGLE, respetamos
      format = 'IG_SINGLE';
      slideCount = 1;
      carouselImages = null;
      if (!visualFormat.startsWith('single')) {
        visualFormat = 'single';
      }
      console.log(
        '[CREATE_POST] requestedFormat=IG_SINGLE → se fuerza SINGLE POST.',
      );
    } else {
      try {
        // Por defecto apuntamos a carrusel 4-slides
        carouselImages = await buildCarousel4(
          product as ProductLike,
          visualAssets.mainImage,
        );
        format = 'IG_CAROUSEL';
        slideCount = carouselImages.length;
        visualFormat = `carousel_${slideCount}_mvp`;

        console.log(
          `[CREATE_POST] Carrusel 4-slides generado correctamente (slides=${slideCount}).`,
        );
      } catch (err: any) {
        console.warn(
          '[CREATE_POST] Error generando carrusel 4-slides, fallback a SINGLE:',
          err?.message || String(err),
        );
        format = 'IG_SINGLE';
        slideCount = 1;
        carouselImages = null;
        if (!visualFormat.startsWith('single')) {
          visualFormat = 'single';
        }
      }
    }

    console.log('[CREATE_POST] Visual decision', {
      requestedFormat,
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
        format, // IG_SINGLE o IG_CAROUSEL
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
