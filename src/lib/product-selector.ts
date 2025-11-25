// src/lib/product-selector.ts
import { supabaseAdmin } from './supabase';
import type { ProductLike } from './visual-generator';

export interface ProductRow extends ProductLike {
  verkaufspreis: number | null;
  stock: number;
  is_active: boolean;
  description: string | null;
  product_category?: string | null;
  selling_point?: string | null;
}

function isLikelyValidUrl(value: string | null): boolean {
  if (!value) return false;
  if (!value.startsWith('http://') && !value.startsWith('https://')) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export async function selectProduct(): Promise<ProductRow> {
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('*')
    .eq('is_active', true);

  if (error) {
    console.error('❌ Error cargando productos:', error);
    throw error;
  }

  if (!data || data.length === 0) {
    throw new Error('No hay productos activos en la tabla products');
  }

  // Filtrar solo productos con image_url que parezca una URL válida
  const validProducts = (data as ProductRow[]).filter((p) =>
    isLikelyValidUrl(p.image_url)
  );

  if (validProducts.length === 0) {
    throw new Error(
      'No hay productos activos con image_url válida. Revisa la columna image_url en Supabase.'
    );
  }

  // Selección aleatoria simple dentro del conjunto válido
  const idx = Math.floor(Math.random() * validProducts.length);
  const product = validProducts[idx];

  console.log(
    `🎯 Producto elegido entre ${validProducts.length} válidos: ${product.product_name} (${product.id})`
  );

  return product;
}
