// src/lib/visual-templates.ts

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

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
// Fuente Inter embebida desde /lib/fonts/Inter-Regular.ttf
// ---------------------------------------------

let embeddedFontBase64: string | null = null;

try {
  // IMPORTANTE:
  //  - En desarrollo:  src/lib/fonts/Inter-Regular.ttf
  //  - En runtime:     dist/lib/fonts/Inter-Regular.ttf
  const fontPath = path.join(__dirname, 'fonts', 'Inter-Regular.ttf');
  const fontBuffer = fs.readFileSync(fontPath);
  embeddedFontBase64 = fontBuffer.toString('base64');
  console.log('[TEMPLATES] Inter-Regular.ttf cargada correctamente:', fontPath);
} catch (err) {
  console.warn(
    '[TEMPLATES] No se pudo cargar Inter-Regular.ttf. Se usará sans-serif del sistema.',
  );
  embeddedFontBase64 = null;
}

// ---------------------------------------------
// 🧩 Helper gráfico para slides de texto (Botanery)
// ---------------------------------------------

export async function generateTemplateSlide(opts: {
  title: string;
  subtitle?: string;
  variant?: 'benefit' | 'cta';
}): Promise<Buffer> {
  const width = 1080;
  const height = 1080;
  const variant = opts.variant ?? 'benefit';

  const fontFamily = embeddedFontBase64
    ? 'InterEmbed'
    : 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const titleColor = variant === 'cta' ? '#111827' : '#1F2933';
  const subtitleColor = '#4B5563';

  const ctaBand =
    variant === 'cta'
      ? `<rect x="0" y="${height - 180}" width="${width}" height="180" fill="#F0EADF" opacity="0.95"/>`
      : '';

  const brandBlock =
    variant === 'cta'
      ? `
        <text x="50%" y="${height - 110}" class="brand-strong">botanery</text>
        <text x="50%" y="${height - 75}" class="brand-light">.de</text>
      `
      : `
        <text x="50%" y="${height - 60}" class="brand-light">botanery.de</text>
      `;

  const fontFaceBlock = embeddedFontBase64
    ? `
      @font-face {
        font-family: 'InterEmbed';
        src: url("data:font/ttf;base64,${embeddedFontBase64}") format("truetype");
      }
    `
    : '';

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#F7F4EF"/>
          <stop offset="100%" stop-color="#FFFFFF"/>
        </linearGradient>
      </defs>

      <style>
        ${fontFaceBlock}

        .title {
          font-family: ${fontFamily};
          font-size: 72px;
          fill: ${titleColor};
          text-anchor: middle;
        }
        .subtitle {
          font-family: ${fontFamily};
          font-size: 40px;
          fill: ${subtitleColor};
          text-anchor: middle;
        }
        .brand-strong {
          font-family: ${fontFamily};
          font-size: 34px;
          font-weight: 600;
          fill: #4F6354;
          text-anchor: middle;
        }
        .brand-light {
          font-family: ${fontFamily};
          font-size: 24px;
          fill: #6B7280;
          text-anchor: middle;
        }
      </style>

      <rect width="100%" height="100%" fill="url(#bg)"/>
      <rect x="0" y="0" width="100%" height="38" fill="#4F6354" opacity="0.08"/>

      ${ctaBand}

      <text x="50%" y="42%" class="title">${opts.title}</text>
      <text x="50%" y="60%" class="subtitle">${opts.subtitle || ''}</text>

      ${brandBlock}
    </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}
