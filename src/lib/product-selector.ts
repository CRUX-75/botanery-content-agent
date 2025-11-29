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
  is_flagship?: boolean | null;
}

// --- Configuración Epsilon-Greedy ---

interface SelectionConfig {
  epsilon: number;              // Prob. de EXPLORAR (0.0 - 1.0). 0.2 = 20% explore / 80% exploit
  cooldownDays: number;         // Días mínimos sin repetir producto
  diversityByCategory: boolean; // Evitar repetir categoría del último post
}

function clampEpsilon(value: number): number {
  if (Number.isNaN(value)) return 0.2;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function getDefaultEpsilon(): number {
  const raw = process.env.EPSILON_PRODUCT;
  if (!raw) return 0.2;
  const parsed = Number(raw);
  return clampEpsilon(parsed);
}

const DEFAULT_CONFIG: SelectionConfig = {
  epsilon: getDefaultEpsilon(),
  cooldownDays: 14,
  diversityByCategory: true,
};

// --- Helpers internos ---

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

type ProductWithPerf = ProductRow & {
  product_performance?: { perf_score: number | null }[];
};

async function getEligibleProducts(config: SelectionConfig): Promise<ProductWithPerf[]> {
  // 1) Cargar productos activos (igual que antes, pero con relación product_performance)
  const { data, error } = await supabaseAdmin
    .from('products')
    .select(
      `
      *,
      product_performance (perf_score)
    `,
    )
    .eq('is_active', true);

  if (error) {
    console.error('❌ Error cargando productos:', error);
    throw error;
  }

  if (!data || data.length === 0) {
    throw new Error('No hay productos activos en la tabla products');
  }

  let products = (data as ProductWithPerf[]).filter((p) =>
    isLikelyValidUrl(p.image_url ?? null),
  );

  if (products.length === 0) {
    throw new Error(
      'No hay productos activos con image_url válida. Revisa la columna image_url en Supabase.',
    );
  }

  // 2) Cooldown por producto (no reutilizar productos de los últimos X días)
  const cooldownDate = new Date();
  cooldownDate.setDate(cooldownDate.getDate() - config.cooldownDays);

  const { data: recentPosts, error: recentErr } = await supabaseAdmin
    .from('generated_posts')
    .select('product_id, created_at')
    .gte('created_at', cooldownDate.toISOString());

  if (recentErr) {
    console.warn('⚠️ Error leyendo generated_posts para cooldown, se ignora cooldown:', recentErr);
  } else if (recentPosts && recentPosts.length > 0) {
    const usedIds = new Set<string>(recentPosts.map((p: any) => p.product_id));
    products = products.filter((p) => !usedIds.has(p.id));
  }

  if (products.length === 0) {
    console.warn(
      '⚠️ Después de aplicar cooldown no quedan productos; se usará el set original sin cooldown.',
    );
    products = (data as ProductWithPerf[]).filter((p) =>
      isLikelyValidUrl(p.image_url ?? null),
    );
  }

  // 3) Diversidad por categoría (no repetir categoría del último post)
  if (config.diversityByCategory) {
    const { data: lastPost, error: lastPostErr } = await supabaseAdmin
      .from('generated_posts')
      .select('product_id')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastPostErr && lastPost?.product_id) {
      const { data: lastProduct, error: lastProdErr } = await supabaseAdmin
        .from('products')
        .select('product_category')
        .eq('id', lastPost.product_id)
        .maybeSingle();

      if (!lastProdErr && lastProduct?.product_category) {
        const original = products;
        products = products.filter(
          (p) => p.product_category !== lastProduct.product_category,
        );

        if (products.length === 0) {
          // Si nos quedamos sin productos por diversidad, usamos el original
          products = original;
        }
      }
    }
  }

  if (products.length === 0) {
    throw new Error('No hay productos elegibles después de filtros de selección');
  }

  return products;
}

function selectBestPerformingProduct(products: ProductWithPerf): ProductWithPerf;
function selectBestPerformingProduct(products: ProductWithPerf[]): ProductWithPerf;
function selectBestPerformingProduct(products: ProductWithPerf[] | ProductWithPerf): ProductWithPerf {
  const list = Array.isArray(products) ? products : [products];

  const sorted = [...list].sort((a, b) => {
    const scoreA = Number(a.product_performance?.[0]?.perf_score ?? 0);
    const scoreB = Number(b.product_performance?.[0]?.perf_score ?? 0);
    return scoreB - scoreA;
  });

  // Boost ligero a productos "flagship"
  const flagship = sorted.filter((p) => !!p.is_flagship);
  if (flagship.length > 0 && Math.random() < 0.3) {
    console.log('⭐ Prioridad a producto flagship en modo EXPLOIT');
    return flagship[0];
  }

  return sorted[0];
}

// --- API pública: selectProduct (usada por createPostJob) ---

export async function selectProduct(
  customConfig?: Partial<SelectionConfig>,
): Promise<ProductRow> {
  const config: SelectionConfig = {
    ...DEFAULT_CONFIG,
    ...customConfig,
    epsilon:
      customConfig?.epsilon !== undefined
        ? clampEpsilon(customConfig.epsilon)
        : DEFAULT_CONFIG.epsilon,
  };

  console.log(
    `🎯 Selección de producto (Epsilon-Greedy) con ε=${config.epsilon}, cooldown=${config.cooldownDays} días, diversidad=${config.diversityByCategory}`,
  );

  const eligibleProducts = await getEligibleProducts(config);

  if (!eligibleProducts || eligibleProducts.length === 0) {
    throw new Error('No hay productos elegibles para selección');
  }

  const shouldExploit = Math.random() > config.epsilon;

  let chosen: ProductWithPerf;
  if (shouldExploit) {
    chosen = selectBestPerformingProduct(eligibleProducts);
    const bestScore = chosen.product_performance?.[0]?.perf_score ?? 'N/A';
    console.log(
      `✅ EXPLOIT: ${chosen.product_name} (${chosen.id}) — perf_score=${bestScore}`,
    );
  } else {
    const idx = Math.floor(Math.random() * eligibleProducts.length);
    chosen = eligibleProducts[idx];
    console.log(`🔍 EXPLORE: ${chosen.product_name} (${chosen.id})`);
  }

  // Devolvemos como ProductRow (es compatible estructuralmente)
  return chosen as ProductRow;
}
