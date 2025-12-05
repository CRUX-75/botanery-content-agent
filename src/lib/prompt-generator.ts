// src/lib/prompt-generator.ts

import { openai } from './openai';
import { ProductRow } from './product-selector';

interface PostContent {
  caption_ig: string;
  caption_fb: string;
  style: string;
}

export async function generatePostContent(product: ProductRow): Promise<PostContent> {
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
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.choices[0].message.content ?? '{}';
  const parsed = JSON.parse(raw);

  return {
    caption_ig: parsed.caption_ig || '',
    caption_fb: parsed.caption_fb || parsed.caption_ig || '',
    style: parsed.style || 'elegant-natural'
  };
}
