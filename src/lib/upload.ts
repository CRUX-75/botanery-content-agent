// src/lib/upload.ts
import { supabaseAdmin } from './supabase';

const BUCKET_NAME = 'dogonauts-assets'; // ajusta si tu bucket se llama distinto

export async function uploadToSupabase(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const { error } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .upload(filename, buffer, {
      contentType: 'image/png',
      upsert: true
    });

  if (error) {
    console.error('❌ Error subiendo imagen a Supabase:', error);
    throw error;
  }

  const { data } = supabaseAdmin.storage
    .from(BUCKET_NAME)
    .getPublicUrl(filename);

  if (!data?.publicUrl) {
    throw new Error('No se pudo obtener publicUrl de la imagen subida');
  }

  return data.publicUrl;
}
