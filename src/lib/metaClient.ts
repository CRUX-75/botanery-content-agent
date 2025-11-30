// src/lib/metaClient.ts

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { log, logError } from './logger';

interface InstagramCarouselImage {
  image_url: string;
  caption?: string;
}

interface InstagramSingleImageParams {
  image_url: string;
  caption: string;
}

interface FacebookPostParams {
  message: string;
  link?: string;
  published?: boolean;
}

class MetaGraphClient {
  private client: AxiosInstance;              // IG / general (user token)
  private fbClient: AxiosInstance;           // FB Page (page token)
  private accessToken: string;
  private instagramAccountId: string;
  private facebookPageId: string;
  private facebookPageAccessToken: string;

  constructor() {
    // Token base (user) para IG y llamadas generales
    this.accessToken = config.meta.accessToken;
    this.instagramAccountId = config.meta.instagramBusinessAccountId;

    // Page ID + Page Token específicos para Facebook
    this.facebookPageId = config.meta.facebookPageId;
    this.facebookPageAccessToken =
      config.meta.facebookPageAccessToken || this.accessToken;

    if (!this.accessToken) {
      throw new Error('[META] META_ACCESS_TOKEN is not configured');
    }
    if (!this.instagramAccountId) {
      throw new Error('[META] INSTAGRAM_BUSINESS_ACCOUNT_ID is not configured');
    }
    if (!this.facebookPageId) {
      log('[META] Warning: FACEBOOK_PAGE_ID is not configured, FB posts will fail');
    }
    if (!this.facebookPageAccessToken) {
      log(
        '[META] Warning: FACEBOOK_PAGE_ACCESS_TOKEN is not configured, using META_ACCESS_TOKEN for FB (may fail)'
      );
    }

    // Cliente para IG (user token)
    this.client = axios.create({
      baseURL: 'https://graph.facebook.com/v18.0',
      params: {
        access_token: this.accessToken,
      },
    });

    // Cliente para FB página (page token)
    this.fbClient = axios.create({
      baseURL: 'https://graph.facebook.com/v18.0',
      params: {
        access_token: this.facebookPageAccessToken,
      },
    });

    log('[META] MetaGraphClient initialized', {
      igAccountId: this.instagramAccountId,
      fbPageId: this.facebookPageId,
      igTokenPrefix: this.accessToken.slice(0, 12),
      fbPageTokenPrefix: this.facebookPageAccessToken.slice(0, 12),
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Espera a que un media container esté listo (status_code = FINISHED).
   * Lanza error si entra en ERROR o si no está listo tras N reintentos.
   */
  private async waitForMediaReady(creationId: string): Promise<void> {
    const maxAttempts = 10;
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { data } = await this.client.get(`/${creationId}`, {
        params: {
          fields: 'status_code',
        },
      });

      const statusCode = data?.status_code as string | undefined;

      log('[META] Media status check', {
        creationId,
        attempt,
        statusCode,
      });

      if (statusCode === 'FINISHED') {
        return;
      }

      if (statusCode === 'ERROR') {
        throw new Error(
          `[META] Media container ${creationId} entered ERROR status`
        );
      }

      if (attempt === maxAttempts) {
        throw new Error(
          `[META] Media container ${creationId} not ready after ${maxAttempts} attempts`
        );
      }

      await this.sleep(delayMs);
    }
  }

  private getErrorPayload(error: any) {
    if (error?.response?.data) return error.response.data;
    return error;
  }

  // ────────────────────────────────────────────────────────────────
  // Instagram – Carousel
  // ────────────────────────────────────────────────────────────────

  /**
   * Publicar un carousel en Instagram:
   * 1) Crear containers de cada imagen (is_carousel_item)
   * 2) Crear container principal CAROUSEL
   * 3) Esperar a que el container CAROUSEL esté FINISHED
   * 4) /media_publish
   */
  async publishInstagramCarousel(
    images: InstagramCarouselImage[],
    caption: string
  ): Promise<string> {
    try {
      log('[META] Publishing Instagram carousel', {
        imageCount: images.length,
      });

      // Paso 1: Crear containers para cada imagen
      const containerIds: string[] = [];

      for (const image of images) {
        const { data } = await this.client.post(
          `/${this.instagramAccountId}/media`,
          {
            image_url: image.image_url,
            is_carousel_item: true,
          }
        );

        if (!data?.id) {
          throw new Error(
            '[META] Failed to create carousel item container (no id)'
          );
        }

        containerIds.push(data.id);
        log('[META] Created carousel item container', {
          containerId: data.id,
        });
      }

      // Paso 2: Crear el carousel container principal
      const { data: carouselData } = await this.client.post(
        `/${this.instagramAccountId}/media`,
        {
          media_type: 'CAROUSEL',
          children: containerIds,
          caption: caption,
        }
      );

      if (!carouselData?.id) {
        throw new Error(
          '[META] Failed to create carousel container (no id)'
        );
      }

      const carouselCreationId = carouselData.id;
      log('[META] Created carousel container', {
        containerId: carouselCreationId,
      });

      // Paso 3: Esperar a que el carousel esté listo
      await this.waitForMediaReady(carouselCreationId);

      // Paso 4: Publicar el carousel
      const { data: publishData } = await this.client.post(
        `/${this.instagramAccountId}/media_publish`,
        {
          creation_id: carouselCreationId,
        }
      );

      if (!publishData?.id) {
        throw new Error(
          '[META] Failed to publish Instagram carousel (no media id)'
        );
      }

      log('[META] ✅ Instagram carousel published', {
        mediaId: publishData.id,
      });

      return publishData.id;
    } catch (error) {
      logError(
        '[META] Failed to publish Instagram carousel',
        this.getErrorPayload(error)
      );
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Instagram – Single image
  // ────────────────────────────────────────────────────────────────

  /**
   * Publicar una imagen simple en Instagram:
   * 1) Crear media container
   * 2) Esperar a que status_code = FINISHED
   * 3) /media_publish
   */
  async publishInstagramSingle(
    params: InstagramSingleImageParams
  ): Promise<string> {
    try {
      log('[META] Publishing Instagram single image', {
        image_url: params.image_url,
      });

      // Paso 1: Crear media container
      const { data: containerData } = await this.client.post(
        `/${this.instagramAccountId}/media`,
        {
          image_url: params.image_url,
          caption: params.caption,
        }
      );

      if (!containerData?.id) {
        throw new Error(
          '[META] Failed to create IG media container (no id)'
        );
      }

      const creationId = containerData.id;
      log('[META] Created IG media container', { containerId: creationId });

      // Paso 2: Esperar a que el media esté listo
      await this.waitForMediaReady(creationId);

      // Paso 3: Publicar
      const { data: publishData } = await this.client.post(
        `/${this.instagramAccountId}/media_publish`,
        {
          creation_id: creationId,
        }
      );

      if (!publishData?.id) {
        throw new Error(
          '[META] Failed to publish Instagram single image (no media id)'
        );
      }

      log('[META] ✅ Instagram single image published', {
        mediaId: publishData.id,
      });

      return publishData.id;
    } catch (error) {
      logError(
        '[META] Failed to publish Instagram single image',
        this.getErrorPayload(error)
      );
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Facebook – Posts
  // ────────────────────────────────────────────────────────────────

  /**
   * Publicar en Facebook (page post)
   */
  async publishFacebookPost(params: FacebookPostParams): Promise<string> {
    try {
      log('[META] Publishing Facebook post', {
        pageId: this.facebookPageId,
      });

      const { data } = await this.fbClient.post(
        `/${this.facebookPageId}/feed`,
        {
          message: params.message,
          link: params.link,
          published: params.published !== false,
        }
      );

      if (!data?.id) {
        throw new Error('[META] Failed to publish Facebook post (no id)');
      }

      log('[META] ✅ Facebook post published', { postId: data.id });
      return data.id;
    } catch (error) {
      logError(
        '[META] Failed to publish Facebook post',
        this.getErrorPayload(error)
      );
      throw error;
    }
  }

  /**
   * Publicar una imagen en Facebook (single image con caption)
   */
  async publishFacebookImage({
    image_url,
    caption,
  }: {
    image_url: string;
    caption: string;
  }): Promise<string> {
    try {
      log('[META] Publishing Facebook image', {
        pageId: this.facebookPageId,
        image_url,
      });

      const { data } = await this.fbClient.post(
        `/${this.facebookPageId}/photos`,
        {
          url: image_url,
          caption,
          published: true,
        }
      );

      if (!data?.post_id) {
        throw new Error('[META] Failed to publish Facebook image (no post_id)');
      }

      log('[META] ✅ Facebook image published', { postId: data.post_id });
      return data.post_id;
    } catch (error) {
      logError(
        '[META] Failed to publish Facebook image',
        this.getErrorPayload(error)
      );
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Facebook – Carousel (placeholder/simple)
  // ────────────────────────────────────────────────────────────────

  /**
   * Publicar carousel en Facebook (múltiples imágenes).
   * Versión simplificada: por ahora publica solo la primera imagen
   * como post de foto normal con el mensaje.
   */
  async publishFacebookCarousel(
    images: string[],
    message: string
  ): Promise<string> {
    try {
      log('[META] Publishing Facebook carousel', {
        pageId: this.facebookPageId,
        imageCount: images.length,
      });

      const firstImage = images[0];

      const { data } = await this.fbClient.post(
        `/${this.facebookPageId}/photos`,
        {
          url: firstImage,
          caption: message,
          published: true,
        }
      );

      if (!data?.post_id) {
        throw new Error('[META] Failed to publish Facebook carousel (no post_id)');
      }

      log('[META] ✅ Facebook "carousel" (single photo) published', {
        postId: data.post_id,
      });

      return data.post_id;
    } catch (error) {
      logError(
        '[META] Failed to publish Facebook carousel',
        this.getErrorPayload(error)
      );
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Insights (Instagram)
  // ────────────────────────────────────────────────────────────────

  /**
   * Obtener métricas de un post de Instagram (v24+ compatible)
   *
   * Notas:
   * - "impressions" ya no está soportado en /insights para este tipo de media.
   * - Usamos:
   *    - reach, saved  → desde /insights
   *    - likes, comments → desde /{mediaId}?fields=like_count,comments_count
   * - Aproximamos impressions = reach para no romper el cálculo de perf_score.
   */
  async getInstagramMediaInsights(mediaId: string): Promise<any> {
    try {
      // 1) Insights válidos para v22+ (sin impressions)
      const [insightsRes, mediaRes] = await Promise.all([
        this.client.get(`/${mediaId}/insights`, {
          params: {
            metric: 'reach,saved',
          },
        }),
        this.client.get(`/${mediaId}`, {
          params: {
            fields: 'like_count,comments_count',
          },
        }),
      ]);

      const insightsArray = insightsRes.data?.data || [];
      const insights = this.parseInsights(insightsArray);
      const media = mediaRes.data || {};

      const reach = insights.reach || 0;
      const saved = insights.saved || 0;
      const likes = media.like_count || 0;
      const comments = media.comments_count || 0;

      // No hay "impressions", usamos reach como proxy para tu scoring
      const impressions = reach;

      return {
        impressions, // proxy para tu calculatePerformanceScore
        reach,
        saves: saved,
        likes,
        comments,
        shares: 0, // IG no expone shares estándar de forma directa
      };
    } catch (error) {
      logError('[META] Failed to get Instagram insights', {
        mediaId,
        error: this.getErrorPayload(error),
      });
      throw error;
    }
  }

  /**
   * Obtener métricas de un post de Facebook
   */
  async getFacebookPostInsights(postId: string): Promise<any> {
    try {
      const { data } = await this.fbClient.get(`/${postId}`, {
        params: {
          fields:
            'likes.summary(true),comments.summary(true),shares,reactions.summary(true)',
        },
      });

      return {
        likes: data.likes?.summary?.total_count || 0,
        comments: data.comments?.summary?.total_count || 0,
        shares: data.shares?.count || 0,
        reactions: data.reactions?.summary?.total_count || 0,
      };
    } catch (error) {
      logError('[META] Failed to get Facebook insights', {
        postId,
        error: this.getErrorPayload(error),
      });
      throw error;
    }
  }

  /**
   * Helper para parsear insights de Instagram
   */
  private parseInsights(insightsData: any[]): Record<string, number> {
    const metrics: Record<string, number> = {};

    for (const insight of insightsData) {
      metrics[insight.name] = insight.values[0]?.value || 0;
    }

    return metrics;
  }
}

export const metaClient = new MetaGraphClient();
