// scripts/migrate-product-images.ts

import { supabaseAdmin } from '../src/lib/supabase';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// Nombre del bucket donde guardar las imágenes migradas
const BUCKET = 'product-images';

// Validar URL simple
function isValidUrl(url: string | null): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

async function migrateImage(product: any) {
  const { id, product_name, image_url } = product;

  if (!isValidUrl(image_url)) {
    console.log(`⚠️ Producto ${id} no tiene URL válida, saltando...`);
    return null;
  }

  console.log(`🔄 Descargando imagen para: ${product_name}`);

  try {
    // Descargar la imagen remota
    const res = await fetch(image_url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!res.ok) {
      console.log(`❌ Error al descargar ${image_url}: ${res.statusText}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Nombre nuevo en el bucket
    const filename = `product-${id}-${Date.now()}.jpg`;

    // Subir a Supabase
    const uploadResult = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(filename, buffer, {
        upsert: true,
        contentType: 'image/jpeg'
      });

    if (uploadResult.error) {
      console.log(`❌ Error subiendo ${filename}:`, uploadResult.error);
      return null;
    }

    // Obtener URL pública
    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(filename);

    const newUrl = urlData.publicUrl;

    console.log(`✅ Imagen subida a: ${newUrl}`);

    // Actualizar fila del producto
    const update = await supabaseAdmin
      .from('products')
      .update({ image_url: newUrl })
      .eq('id', id);

    if (update.error) {
      console.log(`❌ Error actualizando DB:`, update.error);
    } else {
      console.log(`💾 Producto actualizado: ${product_name}`);
    }

    return newUrl;

  } catch (err: any) {
    console.log(`❌ Error procesando producto ${id}:`, err.message);
    return null;
  }
}

async function migrateAll() {
  console.log(`🚀 Iniciando migración de imágenes...`);

  // 1. Cargar productos
  const { data: products, error } = await supabaseAdmin
    .from('products')
    .select('*');

  if (error) {
    console.error('❌ Error cargando productos:', error);
    return;
  }

  console.log(`📦 Productos encontrados: ${products!.length}`);

  // 2. Crear bucket si no existe
  console.log(`📁 Verificando bucket '${BUCKET}'...`);

  try {
    await supabaseAdmin.storage.createBucket(BUCKET, { public: true });
    console.log(`📁 Bucket creado.`);
  } catch {
    console.log(`📁 Bucket ya existe.`);
  }

  // 3. Procesar productos uno por uno
  for (const product of products!) {
    await migrateImage(product);

    // Pequeña pausa para evitar saturar servidores externos
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`🎉 Migración completada.`);
}

migrateAll();
