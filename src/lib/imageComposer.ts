// src/lib/imageComposer.ts

import sharp from 'sharp';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { supabaseAdmin } from './supabase';
import { log, logError } from './logger';

export async function composeImageForPost(post: any): Promise<string> {
  try {
    log('[SHARP] Componiendo imagen para post', { postId: post.id });

    const sourceUrl = post.image_url as string | null;
    if (!sourceUrl || !sourceUrl.trim()) {
      throw new Error('El post no tiene image_url válida para componer.');
    }

    // 1️⃣ Descargar imagen del producto
    const response = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
    const baseImage = Buffer.from(response.data);

    // 2️⃣ Redimensionar imagen a máximo 960x960 (manteniendo proporción)
    const resizedProduct = await sharp(baseImage)
      .resize(960, 960, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();

    // 2️⃣.b Crear sombra suave (blur + oscurecer) a partir del producto
    const blurredShadow = await sharp(resizedProduct)
      .removeAlpha()
      .resize(960, 960, { fit: 'inside' })
      .blur(30)
      .modulate({ brightness: 0.4 })
      .png()
      .toBuffer();

    // 3️⃣ Buscar logo local (mantengo tus rutas)
    const logoCandidates = [
      path.resolve(process.cwd(), 'public/logo.png'),
      path.resolve(process.cwd(), 'app/public/logo.png'),
      path.resolve(__dirname, '../../public/logo.png'),
    ];

    let logoPath: string | null = null;
    for (const candidate of logoCandidates) {
      if (fs.existsSync(candidate)) {
        logoPath = candidate;
        break;
      }
    }

    if (logoPath) {
      log('[SHARP] Logo encontrado, se usará en la composición', { logoPath });
    } else {
      log('[SHARP] Logo NO encontrado en ninguna ruta, se compone solo con producto', {
        logoCandidates,
      });
    }

    // 4️⃣ Posiciones en lienzo 1080x1080
    const canvasWidth = 1080;
    const canvasHeight = 1080;
    const productMaxSize = 960;

    const productLeft = Math.floor((canvasWidth - productMaxSize) / 2); // 60
    const productTop = Math.floor((canvasHeight - productMaxSize) / 2); // 60

    const overlays: sharp.OverlayOptions[] = [];

    // 4.a Primero la sombra (ligeramente desplazada hacia abajo)
    overlays.push({
      input: blurredShadow,
      left: productLeft,
      top: productTop + 40, // un poco más abajo para que parezca sombra real
    });

    // 4.b Luego el producto encima
    overlays.push({
      input: resizedProduct,
      left: productLeft,
      top: productTop,
    });

    // 4.c Logo opcional en esquina inferior derecha (como antes)
    if (logoPath) {
      const logoBuffer = await sharp(logoPath)
        .resize(220, 220, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();

      overlays.push({
        input: logoBuffer,
        gravity: 'southeast', // mantiene el comportamiento original
        // si quisieras afinar margen:
        // left / top pueden combinarse con gravity usando Sharp >=0.32,
        // pero lo dejamos simple por estabilidad.
      });
    }

    // 5️⃣ Crear lienzo con fondo pastel (#F7EFE4)
    const composed = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: '#F7EFE4',
      },
    })
      .composite(overlays)
      .png()
      .toBuffer();

    // 6️⃣ Subir a Supabase Storage
    const filePath = `composed/${post.id}.png`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('botanery-assets') // asegúrate de usar tu bucket correcto
      .upload(filePath, composed, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadError) {
      throw uploadError;
    }

    // 7️⃣ Obtener URL pública
    const { data: urlData } = supabaseAdmin.storage
      .from('botanery-assets')
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;

    log('[SHARP] Imagen compuesta lista', {
      postId: post.id,
      url: publicUrl,
    });

    return publicUrl;
  } catch (error: any) {
    logError('[SHARP] Error componiendo imagen', error);
    throw error;
  }
}
