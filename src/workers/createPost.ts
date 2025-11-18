// src/workers/createPost.ts

import { supabaseAdmin } from '../lib/supabase';
import { openai } from '../lib/openai';
import { log, logError } from '../lib/logger';
import { DOGONAUTS_CONTENT_SYSTEM_PROMPT } from '../agent/systemPrompt';
import { composeImageForPost } from '../lib/imageComposer';

type JobPayload = {
  target_channel?: 'IG_FB' | 'IG_ONLY' | 'FB_ONLY';
};

export async function createPostJob(payload: JobPayload) {
  log('[CREATE_POST] Starting job with payload', payload);

  // 1) Elegir producto desde tabla `products`
  const { data: products, error: productError } = await supabaseAdmin
    .from('products')
    .select('*')
    .eq('is_active', true)
    .gt('stock', 0)
    .limit(50); // cogemos varios para poder randomizar

  if (productError) {
    logError('[CREATE_POST] Error fetching products', productError);
    throw productError;
  }

  if (!products || products.length === 0) {
    logError('[CREATE_POST] No active products with stock > 0 found');
    throw new Error('No active products with stock > 0 found');
  }

  // Elegir uno al azar (más adelante Epsilon-Greedy)
  const randomIndex = Math.floor(Math.random() * products.length);
  const product = products[randomIndex];

  log('[CREATE_POST] Selected product', {
    productId: product.id,
    productName: product.product_name,
    price: product.verkaufspreis,
  });

  // Parámetros fijos por ahora (luego los usaremos para Epsilon-Greedy / A/B)
  const style = 'fun' as const;
  const format = 'IG_CAROUSEL' as const;
  const angle = 'xmas_gift' as const;

  const shortDescription =
    (product.description as string | null)?.slice(0, 400) ||
    'Keine Beschreibung verfügbar';

  const category =
    (product.kategorie as string | null) ||
    (product.category as string | null) ||
    'Allgemein';

  const price =
    typeof product.verkaufspreis === 'number'
      ? product.verkaufspreis
      : parseFloat(String(product.verkaufspreis ?? '0')) || 0;

  const imageUrl =
    (product.image_url as string | null) ||
    (product.image as string | null) ||
    null;

  // 2) Llamar a OpenAI con System Prompt de Dogonauts
  const userContent = `
Du erhältst jetzt die Produktdaten und den Kampagnenkontext für einen Social-Media-Post.

Produktdaten:
- Name: ${product.product_name}
- Kategorie: ${category}
- Kurzbeschreibung: ${shortDescription}
- Preis: ${price.toFixed(2)} €
- Bild-URL (falls vorhanden): ${imageUrl ?? 'keine Bild-URL angegeben'}

Kampagnenkontext:
- format: ${format}
- style: ${style}
- angle: ${angle}
- Zielplattformen: Instagram & Facebook
- Ziel: Scroll stoppen, Weihnachts-/Geschenkstimmung erzeugen, klar zur Handlung (Kauf im Dogonauts-Shop) führen.

WICHTIG:
- Schreibe IMMER in lockerer Du-Form auf Deutsch.
- Kein "Sie", keine formelle Anrede.
- Kein Markdown, keine Erklärungen.
- Verwende KEINE anderen Preise oder Rabatte als oben angegeben.
- Wenn nichts zu Rabatt/Aktion angegeben ist, erfinde keine Rabatte.

Erzeuge auf Basis dieser Daten einen einzigen Social-Media-Post (für IG/FB)
im Branding von Dogonauts und halte dich GENAU an das JSON-Format,
das im System Prompt beschrieben ist.
  `.trim();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: DOGONAUTS_CONTENT_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new Error('No content received from OpenAI');
  }

  let json: any;
  try {
    json = JSON.parse(content);
  } catch (err) {
    logError('[CREATE_POST] Failed to parse JSON from OpenAI', { err, content });
    throw err;
  }

  // Validación básica del JSON recibido
  if (!json.hook || !json.body || !json.cta || !json.hashtag_block || !json.image_prompt) {
    logError('[CREATE_POST] Invalid JSON structure from OpenAI', json);
    throw new Error('Invalid JSON structure received from OpenAI');
  }

  // 3) Insertar en generated_posts (incluyendo image_prompt e image_url)
  const { data: insertData, error: insertError } = await supabaseAdmin
    .from('generated_posts')
    .insert({
      product_id: product.id,
      style,
      format,
      angle,
      hook: json.hook,
      body: json.body,
      cta: json.cta,
      hashtag_block: json.hashtag_block,
      image_prompt: json.image_prompt, // para uso futuro (Image Styler / templates)
      image_url: imageUrl,             // imagen base del producto
      status: 'DRAFT',
      channel_target: payload.target_channel || 'IG_FB',
    })
    .select('*')
    .single();

  if (insertError || !insertData) {
    logError('[CREATE_POST] Error inserting generated_post', insertError);
    throw insertError || new Error('Failed to insert generated_post');
  }

  log('[CREATE_POST] Draft created successfully', {
    postId: insertData.id,
    productId: product.id,
    productName: product.product_name,
  });

  // 4) Componer imagen con Sharp y guardar composed_image_url
  try {
    const composedUrl = await composeImageForPost(insertData);

    await supabaseAdmin
      .from('generated_posts')
      .update({ composed_image_url: composedUrl })
      .eq('id', insertData.id);

    log('[CREATE_POST] Imagen compuesta guardada', {
      postId: insertData.id,
      composed_image_url: composedUrl,
    });
  } catch (error) {
    logError(
      '[CREATE_POST] Falló la composición Sharp (fallback a image_url)',
      error
    );
    // No rompemos el job: el post sigue siendo usable con image_url
  }

  return { product, post: json, generatedPost: insertData };
}
