// src/lib/select-product.ts
import { supabaseAdmin } from './supabase';
import { log, logError } from './logger';

export async function selectProductForPost(productId?: string) {
  try {
    if (productId) {
      const { data, error } = await supabaseAdmin
        .from('products')
        .select('*')
        .eq('id', productId)
        .single();

      if (error) throw error;
      return data;
    }

    const { data, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('is_active', true)
      .gt('stock', 0)
      .not('image_url', 'is', null)
      .limit(50);

    if (error) throw error;

    if (!data || data.length === 0) {
      throw new Error('No valid products found');
    }

    const index = Math.floor(Math.random() * data.length);
    return data[index];
  } catch (err) {
    logError('[selectProductForPost] Failed', err);
    return null;
  }
}
