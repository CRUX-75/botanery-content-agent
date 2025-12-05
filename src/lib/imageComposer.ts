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

    // 2️⃣ Redimensionar imagen a máximo 960x960
    const resizedProduct = await sharp(baseImage)
      .resize(960, 960, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();

    // 2️⃣.b Crear sombra (blur + opacidad reducida)
    const blurredShadow = await sharp(resizedProduct)
      .removeAlpha()
      .resize(960, 960, { fit: 'inside' })
      .blur(30)
      .modulate({ brightness: 0.4 })
      .png()
      .toBuffer();

    // 3️⃣ Buscar logo local
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
      log('[SHARP] Logo NO encontrado en ninguna ruta, se compone solo con producto', { logoCandidates });
    }

    // 4️⃣ Posiciones
    const productLeft = Math.floor((1080 - 960) / 2); // 60
    const productTop = Math.floor((1080 - 960) / 2);  // 60

    const overlays: sharp.OverlayOptions[] = [
      {
        input: resizedProduct,
        left: productLeft,
        top: productTop,
      },
    ];

    if (logoPath) {
      overlays.push({
        input: logoPath,
        gravity: 'southeast',
      });
    }

    // 5️⃣ Crear lienzo con fondo pastel (#F7EFE4)
    const composed = await sharp({
      create: {
        width: 1080,
        height: 1080,
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
