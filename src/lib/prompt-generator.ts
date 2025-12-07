// src/lib/prompt-generator.ts

import { openai } from './openai';
import { ProductRow } from './product-selector';
import { BOTANERY_CONTENT_SYSTEM_PROMPT } from '../agent/systemPrompt';
// Importamos los tipos que definimos en el paso anterior
import { CarouselPostContent, SinglePostContent } from '../types/content'; 

/**
 * GENERADOR DE SINGLE POST (La función original)
 * Genera un post estático (1 imagen + caption)
 */
export async function generatePostContent(product: ProductRow): Promise<SinglePostContent> {
  const prompt = `
Du bist Copywriter:in für Botanery – eine moderne Marke für stilvolle, dekorative Pflanzen im Interior-Bereich.

PRODUKT:
- Name: ${product.product_name}
- Beschreibung: ${product.description || 'N/A'}
- Preis: ${product.verkaufspreis ?? 'N/A'} €
- Kategorie: ${product.product_category || 'N/A'}
- Stil oder Nutzen: ${product.selling_point || 'N/A'}

Bitte schreibe zwei kurze Social-Media-Texte auf DEUTSCH – einen für Instagram, einen für Facebook.

Anforderungen:
- Max. 150 Wörter.
- Hook zu Beginn (visuell, ruhig, ästhetisch, inspirierend).
- 2–3 konkrete Nutzen oder Designaspekte.
- CTA: z.B. "Jetzt entdecken auf botanery.de"
- Tono: elegant, ruhig, hochwertig, verständlich.
- Zielgruppe: Menschen mit Interesse an schönem Wohnen, Pflanzenästhetik, minimalistischem Design.
- Stil: ästhetisch, leicht emotional, aber nicht übertrieben.

Füge am Ende 5–7 passende Hashtags hinzu (z. B. #Botanery, #InteriorLovers, #Pflanzenliebe).

Antworte ausschließlich im folgenden JSON-Format:
{
  "caption_ig": "Text für Instagram",
  "caption_fb": "Text für Facebook",
  "style": "kurze Beschreibung des verwendeten Stils"
}
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
        { role: 'system', content: BOTANERY_CONTENT_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
    ]
  });

  const raw = response.choices[0].message.content ?? '{}';
  const parsed = JSON.parse(raw);

  return {
    caption_ig: parsed.caption_ig || '',
    caption_fb: parsed.caption_fb || parsed.caption_ig || '',
    style: parsed.style || 'elegant-natural'
  };
}

/**
 * GENERADOR DE CARRUSELES (Nueva función unificada)
 * Soporta estrategias de 4 slides (Venta) und 10 slides (Notoriedad/Seamless)
 */
export async function generateCarousel(
    product: ProductRow, 
    slideCount: 4 | 10
): Promise<CarouselPostContent> {

  // Definimos la estrategia según el número de slides
  const strategyContext = slideCount === 10 
    ? `ESTRATEGIA: 'Notoriedad & Educación' (Seamless Carousel).
       - Ziel: Hohe Verweildauer (Retention) und "Saves".
       - Struktur: Hook (1) -> Problem/Mythos (2-3) -> Lösung/Wert (4-8) -> Zusammenfassung (9) -> Starker CTA (10).
       - Design: Muss sich wie eine zusammenhängende Geschichte anfühlen ("Seamless").`
    : `ESTRATEGIA: 'Venta Rápida & Produktfokus' (Conversion).
       - Ziel: Klicks und Kauf.
       - Struktur: Visueller Hook (1) -> Produktdetail (2) -> Hauptvorteil (3) -> Kaufaufforderung (4).`;

  const prompt = `
  TASK: Erstelle ein Konzept für ein Instagram-Karussell mit exakt ${slideCount} Slides.
  
  WICHTIG: Ignoriere das Standard-JSON-Format aus dem System-Prompt. Nutze für diese Aufgabe NUR das unten angegebene Karussell-JSON-Format.

  PRODUKT DATEN:
  - Name: ${product.product_name}
  - Beschreibung: ${product.description || 'N/A'}
  - Preis: ${product.verkaufspreis ?? 'N/A'} €
  - USP: ${product.selling_point || 'Stilvolles Wohnen'}

  ${strategyContext}

  ANFORDERUNGEN AN DEN INHALT (SLIDES):
  - Slide 1: Muss einen starken "Overlay Title" (Hook) im Bild haben.
  - Letzter Slide: Muss einen klaren CTA haben.
  - Overlay-Texte: Kurz und prägnant für das Bilddesign (max 10-15 Wörter pro Slide).
  - Visual Concept: Beschreibe für den Designer genau, was auf dem Bild zu sehen ist. Bei 10 Slides: Achte auf "Seamless"-Übergänge.

  FORMAT (JSON ONLY):
  Antworte ausschließlich mit diesem JSON-Objekt:
  {
    "caption_ig": "Der Text für die Instagram Caption (unter dem Post), inkl. Hashtags.",
    "strategy_tag": "${slideCount === 10 ? 'Notoriedad' : 'Venta Rápida'}",
    "slides": [
      {
        "slide_number": 1,
        "visual_concept": "Beschreibung des Bildes (Englisch oder Deutsch)",
        "overlay_title": "Große Überschrift auf dem Bild",
        "overlay_body": "Kleinerer Text auf dem Bild (optional)",
        "design_note": "Hinweis für das Design (z.B. Pfeil nach rechts, Übergang zu Slide 2)"
      }
      // ... (für alle ${slideCount} Slides)
    ]
  }
  `;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini', // Usamos mini para rapidez, cambiar a gpt-4o si quieres más creatividad narrativa
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: BOTANERY_CONTENT_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  });

  const raw = response.choices[0].message.content ?? '{}';
  // Aquí podríamos añadir validación con Zod si fuera necesario en el futuro
  return JSON.parse(raw) as CarouselPostContent;
}