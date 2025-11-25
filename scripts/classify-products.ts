// scripts/classify-products.ts
import { openai } from '../src/lib/openai';
import { supabaseAdmin } from '../src/lib/supabase';

async function classifyProduct(product: any) {
  const prompt = `Clasifica este producto para visuales dinámicos:

Nombre: ${product.product_name}
Descripción: ${product.description || 'N/A'}
Precio: ${product.verkaufspreis ?? 'N/A'}€
Imagen: ${product.image_url}

Categorías válidas:
- emergency_kit
- toy
- food
- hygiene
- accessory

Complejidad visual:
- simple
- complex
- lifestyle_needed

Punto de venta:
- safety
- fun
- health
- convenience
- quality

Formato recomendado:
- single
- carousel_3
- carousel_4

Responde SOLO con JSON:
{
  "product_category": "...",
  "visual_complexity": "...",
  "selling_point": "...",
  "recommended_format": "...",
  "rationale": "explicación breve"
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.choices[0].message.content ?? '{}';
const classification = JSON.parse(raw);


  await supabaseAdmin
    .from('products')
    .update({
      product_category: classification.product_category,
      visual_complexity: classification.visual_complexity,
      selling_point: classification.selling_point,
      recommended_format: classification.recommended_format
    })
    .eq('id', product.id);

  console.log(`✅ Clasificado: ${product.product_name} → ${classification.product_category}`);

  return classification;
}

async function classifyAllProducts() {
 const { data: products, error } = await supabaseAdmin
  .from('products')
  .select('*')
  .eq('is_active', true);

  if (error) {
    console.error('❌ Error seleccionando productos:', error);
    return;
  }

  console.log(`📦 Clasificando ${products.length} productos...`);

  for (const product of products) {
    await classifyProduct(product);
    await new Promise((res) => setTimeout(res, 900)); // rate limit seguro
  }

  console.log('🎉 Clasificación finalizada');
}

classifyAllProducts();
