// src/lib/visual-templates.ts

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
}

// ---------------------------------------------
// Plantillas visuales (sin cambios)
// ---------------------------------------------

export interface VisualTemplate {
  type: 'single' | 'carousel';
  slides?: SlideConfig[];
  overlay: OverlayConfig;
  background: BackgroundConfig;
}

export const TEMPLATES: Record<string, VisualTemplate> = {
  emergency_kit: {
    type: 'carousel',
    slides: [
      {
        layout: 'hero',
        elements: ['product_image', 'safety_badge', 'season_context'],
        textPosition: 'top-left',
        backgroundColor: '#FF4444'
      },
      {
        layout: 'features',
        elements: ['product_contents_grid', 'checkmarks'],
        textPosition: 'bottom'
      },
      {
        layout: 'usage',
        elements: ['lifestyle_illustration', 'dog_icon'],
        textPosition: 'center'
      },
      {
        layout: 'cta',
        elements: ['logo', 'price', 'shop_button'],
        backgroundColor: '#00AA44'
      }
    ],
    overlay: {
      icon: 'medical_cross',
      badge: 'Sicherheit',
      accentColor: '#FF4444'
    },
    background: {
      type: 'gradient',
      colors: ['#FFE5E5', '#FFFFFF']
    }
  },

  toy: {
    type: 'single',
    overlay: {
      icon: 'play',
      badge: 'Spielspaß',
      accentColor: '#FFB800',
      decorations: ['paw_prints', 'sparkles']
    },
    background: {
      type: 'solid_with_pattern',
      color: '#FFF9E5',
      pattern: 'dots'
    }
  },

  food: {
    type: 'carousel',
    slides: [
      {
        layout: 'hero',
        elements: ['product_image', 'quality_badge'],
        textPosition: 'bottom'
      },
      {
        layout: 'features',
        elements: ['ingredient_icons', 'natural_badge']
      },
      {
        layout: 'cta',
        elements: ['logo', 'price', 'shop_button']
      }
    ],
    overlay: {
      icon: 'bowl',
      badge: 'Premium Futter',
      accentColor: '#00AA44'
    },
    background: {
      type: 'gradient',
      colors: ['#E8F5E9', '#FFFFFF']
    }
  },

  hygiene: {
    type: 'single',
    overlay: {
      icon: 'sparkle',
      badge: 'Hygiene',
      accentColor: '#00BCD4'
    },
    background: {
      type: 'solid',
      color: '#E0F7FA'
    }
  },

  accessory: {
    type: 'single',
    overlay: {
      icon: 'star',
      badge: 'Must-Have',
      accentColor: '#9C27B0'
    },
    background: {
      type: 'solid',
      color: '#F3E5F5'
    }
  }
};

export function getTemplateForProduct(product: Product): VisualTemplate {
  return TEMPLATES[product.product_category || 'accessory'] || TEMPLATES.accessory;
}
