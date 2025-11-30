// src/lib/compose-branded-single.ts
import sharp from 'sharp';
import { supabaseAdmin } from './supabase';
import { log, logError } from './logger';

const DOGONAUTS_BLUE = { r: 10, g: 30, b: 60, alpha: 1 };

export async function composeBrandedSingle(originalUrl: string): Promise<string> {
  if (!originalUrl) {
    throw new Error('composeBrandedSingle: originalUrl is required');
  }

  const logoUrl = process.env.DOGONAUTS_LOGO_URL;

  if (!logoUrl) {
    log('[BRANDED_SINGLE] DOGONAUTS_LOGO_URL not set, composing without logo');
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

    // 2) Preparar imagen del producto (centrada, con fondo transparente)
    const productPng = await sharp(productBuffer)
      .resize({
        width: 800,
        height: 800,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    const composites: sharp.OverlayOptions[] = [
      {
        input: productPng,
        top: Math.round((1350 - 800) / 2),
        left: Math.round((1080 - 800) / 2),
      },
    ];

    // 3) Preparar logo (si está configurado y se pudo descargar)
    if (logoUrl && logoRes && logoRes.ok) {
      try {
        const logoBuffer = Buffer.from(await logoRes.arrayBuffer());

        const logoPng = await sharp(logoBuffer)
          .resize({ width: 220 }) // ancho fijo, alto proporcional
          .png()
          .toBuffer();

        composites.push({
          input: logoPng,
          top: 40,
          left: 40,
        });
      } catch (err) {
        logError(
          '[BRANDED_SINGLE] Failed to process logo, continuing without it',
          err,
        );
      }
    }

    // 4) Crear lienzo y componer
    const finalBuffer = await sharp({
      create: {
        width: 1080,
        height: 1350,
        channels: 4,
        background: DOGONAUTS_BLUE,
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
      .from('dogonauts-assets')
      .upload(filename, finalBuffer, {
        upsert: true,
        contentType: 'image/jpeg',
      });

    if (uploadError) {
      throw uploadError;
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from('dogonauts-assets').getPublicUrl(filename);

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
