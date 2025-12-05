// src/lib/compose-branded-single.ts
import sharp from 'sharp';
import { supabaseAdmin } from './supabase';
import { log, logError } from './logger';

// Fondo Botanery: verde elegante profundo
const BOTANERY_GREEN = { r: 8, g: 40, b: 30, alpha: 1 };

// Medidas estándar para IG portrait (1080x1350).
// Si luego quieres formato cuadrado 1080x1080, solo cambiamos CANVAS_HEIGHT.
const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1350;

// Tamaño de la “tarjeta” del producto (cuadro blanco)
const PRODUCT_CARD_SIZE = 960;

// Usamos el bucket definido por env, con fallback a botanery-assets.
const STORAGE_BUCKET =
  process.env.SUPABASE_STORAGE_BUCKET || 'botanery-assets';

export async function composeBrandedSingle(originalUrl: string): Promise<string> {
  if (!originalUrl) {
    throw new Error('composeBrandedSingle: originalUrl is required');
  }

  // Aunque la env se llame DOGONAUTS_LOGO_URL, aquí la usamos para el logo de Botanery.
  const logoUrl = process.env.DOGONAUTS_LOGO_URL;

  if (!logoUrl) {
    log('[BRANDED_SINGLE] DOGONAUTS_LOGO_URL (logo Botanery) not set, composing without logo');
  } else {
    log('[BRANDED_SINGLE] Using logo from', logoUrl);
  }

  try {
    // 1) Descargar imagen del producto y logo (si existe)
    const [productRes, logoRes] = await Promise.all([
      fetch(originalUrl),
      logoUrl ? fetch(logoUrl) : Promise.resolve(null as any),
    ]);

    if (!productRes.ok) {
      throw new Error(
        `Failed to fetch product image: ${productRes.status} ${productRes.statusText}`,
      );
    }

    const productBuffer = Buffer.from(await productRes.arrayBuffer());

    // 2) Preparar imagen del producto dentro de una “tarjeta” blanca grande
    // - fit: 'contain' para no cortar flores / maceta
    // - fondo blanco para look “catálogo / premium”
    const productCard = await sharp(productBuffer)
      .resize({
        width: PRODUCT_CARD_SIZE,
        height: PRODUCT_CARD_SIZE,
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .jpeg({ quality: 95 })
      .toBuffer();

    // 2.1) Sombra suave para la tarjeta del producto
    const shadowSize = PRODUCT_CARD_SIZE + 60;
    const shadow = await sharp({
      create: {
        width: shadowSize,
        height: shadowSize,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.35 },
      },
    })
      .blur(40)
      .png()
      .toBuffer();

    // Posición del producto: centrado horizontalmente, un poco más arriba
    // para dejar espacio abajo a futuro (texto / badges / etc.)
    const productLeft = Math.round((CANVAS_WIDTH - PRODUCT_CARD_SIZE) / 2);
    const productTop = 150;

    const composites: sharp.OverlayOptions[] = [
      // Sombra primero (debajo de la tarjeta)
      {
        input: shadow,
        left: productLeft - Math.round((shadowSize - PRODUCT_CARD_SIZE) / 2),
        top: productTop - Math.round((shadowSize - PRODUCT_CARD_SIZE) / 2),
      },
      // Tarjeta del producto encima
      {
        input: productCard,
        left: productLeft,
        top: productTop,
      },
    ];

    // 3) Preparar logo (si está configurado y se pudo descargar)
    if (logoUrl && logoRes && logoRes.ok) {
      try {
        const logoBuffer = Buffer.from(await logoRes.arrayBuffer());

        const logoPng = await sharp(logoBuffer)
          .resize({ width: 200 }) // tamaño discreto, elegante
          .png()
          .toBuffer();

        composites.push({
          input: logoPng,
          top: 60,
          left: 60,
        });
      } catch (err) {
        logError(
          '[BRANDED_SINGLE] Failed to process logo, continuing without it',
          err,
        );
      }
    }

    // 4) Crear fondo elegante: verde Botanery uniforme (limpio y pro)
    const finalBuffer = await sharp({
      create: {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        channels: 4,
        background: BOTANERY_GREEN,
      },
    })
      .composite(composites)
      .jpeg({ quality: 90 })
      .toBuffer();

    // 5) Subir a Supabase
    const filename = `branded/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.jpg`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(filename, finalBuffer, {
        upsert: true,
        contentType: 'image/jpeg',
      });

    if (uploadError) {
      throw uploadError;
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(filename);

    log('[BRANDED_SINGLE] Branded image created and uploaded', {
      path: filename,
      publicUrl,
    });

    return publicUrl;
  } catch (err) {
    logError('[BRANDED_SINGLE] Failed to compose branded single', err);
    // Fallback: devolvemos la imagen original para no romper el flujo
    return originalUrl;
  }
}
