// src/types/content.ts

// Define la estructura de un Slide individual
export interface CarouselSlide {
  slide_number: number;
  visual_concept: string;       // Descripción para la IA o el editor
  overlay_title?: string;       // El "Hook" visual grande
  overlay_body?: string;        // Texto secundario
  design_note?: string;         // Instrucciones extra (ej: "Flecha abajo")
}

// Define la respuesta completa que esperamos del Agente
export interface CarouselPostContent {
  caption_ig: string;
  caption_fb?: string; // Opcional, si usas el mismo para ambos
  strategy_tag: string; // Para saber si es "Venta" o "Notoriedad"
  slides: CarouselSlide[];
}

// También puedes mover aquí la interfaz antigua si quieres unificar
export interface SinglePostContent {
    caption_ig: string;
    caption_fb: string;
    style: string;
}