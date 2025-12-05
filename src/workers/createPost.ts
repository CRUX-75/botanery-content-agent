// src/workers/createPost.ts

import { supabaseAdmin } from '../lib/supabase';
import { openai } from '../lib/openai';
import { log, logError } from '../lib/logger';
import {  BOTANERY_CONTENT_SYSTEM_PROMPT } from '../agent/systemPrompt';
import { composeBrandedSingle } from '../lib/compose-branded-single';

type JobPayload = {
  target_channel?: 'IG_FB' | 'IG_ONLY' | 'FB_ONLY';
};

export async function createPostJob(payload: JobPayload) {
  try {
    log('[CREATE_POST] Starting job with payload', payload);

    // Normalizar target_channel para respetar el CHECK de generated_posts
    const targetChannel = payload.target_channel || 'IG_FB';

    const channelTargetDb =
      targetChannel === 'IG_ONLY'
        ? 'IG'
        : targetChannel === 'FB_ONLY'
        ? 'FB'
        : 'BOTH';

    // 1) Elegir producto
    const { data: products, error: productError } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('is_active', true)
      .gt('stock', 0)
      .not('image_url', 'is', null)
      .not('image_url', 'eq', '')
      .limit(50);

    if (productError) {
      logError('[CREATE_POST] Error fetching products', productError);
      throw productError;
    }

    if (!products || products.length === 0) {
      logError('[CREATE_POST] No valid products found');
      throw new Error('No valid products with image_url and stock > 0');
    }

    const randomIndex = Math.floor(Math.random() * products.length);
    const product = products[randomIndex];

    log('[CREATE_POST] Selected product', {
      productId: product.id,
      productName: product.product_name,
      price: product.verkaufspreis,
    });

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
        { role: 'system', content:  BOTANERY_CONTENT_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('No content received from OpenAI');

    let json: any;
    try {
      json = JSON.parse(content);
    } catch (err) {
      logError('[CREATE_POST] Failed to parse JSON', { err, content });
      throw err;
    }

    if (
      !json.hook ||
      !json.body ||
      !json.cta ||
      !json.hashtag_block ||
      !json.image_prompt
    ) {
      logError('[CREATE_POST] Invalid JSON structure', json);
      throw new Error('Invalid JSON structure received from OpenAI');
    }

    // Insertar en generated_posts
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
        image_prompt: json.image_prompt,
        image_url: imageUrl,
        status: 'DRAFT',
        channel_target: channelTargetDb,
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
    });

    // ⭐ NUEVO BLOQUE: Composición visual (Fase 0)
    try {
      if (!imageUrl) {
        // No hay imagen disponible → no intentamos componer nada
        logError(
          '[CREATE_POST] No imageUrl available for branded composition, skipping.',
          null,
        );
      } else {
        const composedUrl = await composeBrandedSingle(imageUrl);

        await supabaseAdmin
          .from('generated_posts')
          .update({ composed_image_url: composedUrl })
          .eq('id', insertData.id);

        log('[CREATE_POST] Imagen compuesta Dogonauts guardada', {
          postId: insertData.id,
          composed_image_url: composedUrl,
        });
      }
    } catch (err) {
      logError(
        '[CREATE_POST] Falló la composición Branded (fallback a image_url)',
        err,
      );

      await supabaseAdmin
        .from('generated_posts')
        .update({ composed_image_url: imageUrl })
        .eq('id', insertData.id);
    }

    return { product, post: json, generatedPost: insertData };
  } catch (error) {
    logError('[CREATE_POST] Error en createPostJob', error);
    throw error;
  }
}
