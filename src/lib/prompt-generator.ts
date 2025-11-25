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
Eres el copywriter de Dogonauts, una tienda online de productos para perros.

PRODUCTO:
- Nombre: ${product.product_name}
- Descripción: ${product.description || 'N/A'}
- Precio: ${product.verkaufspreis ?? 'N/A'}€
- Categoría: ${product.product_category || 'N/A'}
- Punto de venta: ${product.selling_point || 'N/A'}

Escribe texto para redes sociales en ALEMÁN.

Requisitos:
- Tono: cercano, alegre, útil para dueños de perros
- Incluye un hook fuerte en la primera línea
- Menciona 2–3 beneficios concretos
- CTA: "Jetzt im Shop sichern 🐾"
- Máximo 150 palabras
- 5–7 hashtags relevantes para perros, bienestar y Dogonauts.

Responde SOLO con JSON:
{
  "caption_ig": "texto para Instagram",
  "caption_fb": "texto para Facebook (puede ser casi igual)",
  "style": "breve descripción del tono/estilo usado"
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
    style: parsed.style || 'default'
  };
}
