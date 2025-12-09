// src/lib/visual-templates.ts

import sharp from 'sharp';

// ---------------------------------------------
// Interfaces necesarias para evitar errores TS
// ---------------------------------------------

export interface SlideConfig {
  layout: 'hero' | 'features' | 'usage' | 'cta';
  elements: string[];
  textPosition?: 'top-left' | 'top-right' | 'bottom' | 'center';
  backgroundColor?: string;
}

export interface OverlayConfig {
  icon?: 'medical_cross' | 'play' | 'bowl' | 'sparkle' | 'star';
  badge?: string;
  accentColor: string;
  decorations?: string[];
}

export interface BackgroundConfig {
  type: 'solid' | 'gradient' | 'solid_with_pattern';
  color?: string;
  colors?: string[];
  pattern?: 'dots' | 'paws' | 'bones';
}

// Este Product es simplificado para este archivo.
// No afecta tu modelo real de supabase.
export interface Product {
  product_category?: string | null;
  product_name?: string | null;
}

// ---------------------------------------------
// Plantillas visuales con branding BOTANERY
// ---------------------------------------------

export interface VisualTemplate {
  type: 'single' | 'carousel';
  slides?: SlideConfig[];
  overlay: OverlayConfig;
  background: BackgroundConfig;
}

/**
 * Paleta base Botanery:
 *  - Crema suave: #F7F4EF
 *  - Verde Botanery: #4F6354
 *  - Marrón cálido (granulat): #8D6E63
 *  - Lila suave (töpfe): #E8EAF6
 */
export const TEMPLATES: Record<string, VisualTemplate> = {
  orchid: {
    type: 'single',
    overlay: {
      icon: 'sparkle',
      badge: 'Phalaenopsis',
      accentColor: '#4F6354',
      decorations: ['sparkles'],
    },
    background: {
      type: 'gradient',
      colors: ['#F7F4EF', '#FFFFFF'],
    },
  },

  granulate: {
    type: 'single',
    overlay: {
      icon: 'bowl',
      badge: 'Granulat',
      accentColor: '#8D6E63',
    },
    background: {
      type: 'solid',
      color: '#F3E5D8',
    },
  },

  pot: {
    type: 'single',
    overlay: {
      icon: 'star',
      badge: 'Ziertopf',
      accentColor: '#5C6BC0',
    },
    background: {
      type: 'solid',
      color: '#E8EAF6',
    },
  },

  accessory: {
    type: 'single',
    overlay: {
      icon: 'star',
      badge: 'Botanery',
      accentColor: '#4F6354',
    },
    background: {
      type: 'solid',
      color: '#F7F4EF',
    },
  },
};

/**
 * Resolver qué plantilla aplicar según el producto.
 * Usamos mismas heurísticas que en el bucket:
 *  - Orquídeas / Phalaenopsis
 *  - Granulat / Substrat / Colomi
 *  - Ziertöpfe / Töpfe
 */
function resolveTemplateKey(product: Product): keyof typeof TEMPLATES {
  const rawCategory = (product.product_category || '').toLowerCase();
  const name = (product.product_name || '').toLowerCase();
  const text = `${rawCategory} ${name}`;

  if (
    text.includes('orchid') ||
    text.includes('orchidee') ||
    text.includes('phalaenopsis')
  ) {
    return 'orchid';
  }

  if (
    text.includes('granulat') ||
    text.includes('substrat') ||
    text.includes('colomi')
  ) {
    return 'granulate';
  }

  if (
    text.includes('ziertopf') ||
    text.includes('ziertoepf') ||
    text.includes('topf') ||
    text.includes('töpfe') ||
    text.includes('toepfe')
  ) {
    return 'pot';
  }

  return 'accessory';
}

export function getTemplateForProduct(product: Product): VisualTemplate {
  const key = resolveTemplateKey(product);
  return TEMPLATES[key] || TEMPLATES.accessory;
}

// ---------------------------------------------
// 🧩 Helper gráfico para slides de texto (Botanery)
//  → SIN fuentes externas, solo sans-serif del sistema
//  → Limpiamos caracteres no ASCII para evitar cuadrados
// ---------------------------------------------

function sanitizeText(input: string | undefined): string {
  if (!input) return '';
  // Eliminamos caracteres no-ASCII (umlauts, etc.) para evitar tofu en algunos sistemas
  return input.replace(/[^\x20-\x7E]/g, '');
}

export async function generateTemplateSlide(opts: {
  title: string;
  subtitle?: string;
}): Promise<Buffer> {
  const width = 1080;
  const height = 1080;

  const safeTitle = sanitizeText(opts.title);
  const safeSubtitle = sanitizeText(opts.subtitle || '');
  const brand = 'botanery.de';

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#F7F4EF"/>
          <stop offset="100%" stop-color="#FFFFFF"/>
        </linearGradient>
      </defs>

      <style>
        .title {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 72px;
          fill: #1F2933;
          text-anchor: middle;
        }
        .subtitle {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 40px;
          fill: #4B5563;
          text-anchor: middle;
        }
        .brand {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 28px;
          fill: #4F6354;
          text-anchor: middle;
        }
      </style>

      <!-- Fondo crema con ligero degradado -->
      <rect width="100%" height="100%" fill="url(#bg)"/>

      <!-- Franja superior sutil en verde Botanery -->
      <rect x="0" y="0" width="100%" height="40" fill="#4F6354" opacity="0.10"/>

      <text x="50%" y="42%" class="title">${safeTitle}</text>

      <text x="50%" y="60%" class="subtitle">
        ${safeSubtitle}
      </text>

      <text x="50%" y="92%" class="brand">${brand}</text>
    </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}
