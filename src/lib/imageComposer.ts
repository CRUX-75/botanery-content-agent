// src/lib/imageComposer.ts

import sharp from 'sharp';
import axios from 'axios';
import path from 'path';
import { supabaseAdmin } from './supabase';
import { log, logError } from './logger';

export async function composeImageForPost(post: any): Promise<string> {
  try {
    log('[SHARP] Componiendo imagen para post', { postId: post.id });

    const sourceUrl = post.image_url as string | null;
    if (!sourceUrl) {
      throw new Error('El post no tiene image_url para componer.');
    }

    // 1️⃣ Descargar la imagen base desde la URL del producto
    const response = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
    const baseImage = Buffer.from(response.data);

    // 2️⃣ Resolver ruta del logo (asumimos /public/logo.png en la raíz del proyecto)
    const logoPath = path.resolve(__dirname, '../../public/logo.png');

    // 3️⃣ Componer imagen:
    //    - Lienzo 1080x1080 con fondo claro
    //    - Producto centrado
    //    - Logo Dogonauts abajo a la derecha
    const composed = await sharp({
      create: {
        width: 1080,
        height: 1080,
        channels: 3,
        background: '#F3F3F3', // fondo claro
      },
    })
      .composite([
        {
          input: baseImage,
          gravity: 'center',
        },
        {
          input: logoPath,
          gravity: 'southeast',
          // sin opacity: OverlayOptions de sharp no la expone en los tipos
        },
      ])
      .png()
      .toBuffer();

    // 4️⃣ Subir a Supabase Storage (bucket: dogonauts-assets)
    const filePath = `composed/${post.id}.png`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('dogonauts-assets')
      .upload(filePath, composed, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { data: urlData } = supabaseAdmin.storage
      .from('dogonauts-assets')
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
