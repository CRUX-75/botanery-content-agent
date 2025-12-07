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
  // IG
  private igClient: AxiosInstance;
  private igAccessToken: string;
  private instagramAccountId: string;

  // FB Page
  private fbClient: AxiosInstance;
  private fbPageAccessToken: string;
  private facebookPageId: string;
  private facebookEnabled: boolean;

  constructor() {
    // Tokens de entorno
    this.igAccessToken = config.meta.accessToken; // META_ACCESS_TOKEN
    this.instagramAccountId = config.meta.instagramBusinessAccountId;

    const pageId = config.meta.facebookPageId;
    const pageToken = config.meta.facebookPageAccessToken || '';

    this.facebookPageId = pageId;
    this.fbPageAccessToken = pageToken;
    this.facebookEnabled = !!(this.facebookPageId && this.fbPageAccessToken);

    if (!this.igAccessToken) {
      throw new Error('[META] META_ACCESS_TOKEN is not configured');
    }
    if (!this.instagramAccountId) {
      throw new Error('[META] INSTAGRAM_BUSINESS_ACCOUNT_ID is not configured');
    }

    if (!this.facebookEnabled) {
      log(
        '[META] Facebook is NOT fully configured. Facebook calls will be skipped.',
      );
    } else {
      log('[META] Facebook is enabled for page publishing.', {
        fbPageId: this.facebookPageId,
      });
    }

    // Cliente para IG (usa token IG)
    this.igClient = axios.create({
      baseURL: 'https://graph.facebook.com/v24.0',
      params: {
        access_token: this.igAccessToken,
      },
    });

    // Cliente para Facebook Page (usa PAGE ACCESS TOKEN si está habilitado)
    this.fbClient = axios.create({
      baseURL: 'https://graph.facebook.com/v24.0',
      params: this.facebookEnabled
        ? { access_token: this.fbPageAccessToken }
        : {},
    });

    log('[META] MetaGraphClient initialized', {
      igAccountId: this.instagramAccountId,
      fbPageId: this.facebookPageId || '(disabled)',
      igTokenPrefix: this.igAccessToken.slice(0, 10),
      fbPageTokenPrefix: this.fbPageAccessToken
        ? this.fbPageAccessToken.slice(0, 10)
        : '(none)',
      facebookEnabled: this.facebookEnabled,
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
   * (Usa IG client, porque es para Instagram.)
   */
  private async waitForMediaReady(creationId: string): Promise<void> {
    const maxAttempts = 10;
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { data } = await this.igClient.get(`/${creationId}`, {
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
          `[META] Media container ${creationId} entered ERROR status`,
        );
      }

      if (attempt === maxAttempts) {
        throw new Error(
          `[META] Media container ${creationId} not ready after ${maxAttempts} attempts`,
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

  async publishInstagramCarousel(
    images: InstagramCarouselImage[],
    caption: string,
  ): Promise<string> {
    try {
      log('[META] Publishing Instagram carousel', {
        imageCount: images.length,
      });

      const containerIds: string[] = [];

      for (const image of images) {
        const { data } = await this.igClient.post(
          `/${this.instagramAccountId}/media`,
          {
            image_url: image.image_url,
            is_carousel_item: true,
          },
        );

        if (!data?.id) {
          throw new Error(
            '[META] Failed to create carousel item container (no id)',
          );
        }

        containerIds.push(data.id);
        log('[META] Created carousel item container', {
          containerId: data.id,
        });
      }

      const { data: carouselData } = await this.igClient.post(
        `/${this.instagramAccountId}/media`,
        {
          media_type: 'CAROUSEL',
          children: containerIds,
          caption: caption,
        },
      );

      if (!carouselData?.id) {
        throw new Error(
          '[META] Failed to create carousel container (no id)',
        );
      }

      const carouselCreationId = carouselData.id;
      log('[META] Created carousel container', {
        containerId: carouselCreationId,
      });

      await this.waitForMediaReady(carouselCreationId);

      const { data: publishData } = await this.igClient.post(
        `/${this.instagramAccountId}/media_publish`,
        {
          creation_id: carouselCreationId,
        },
      );

      if (!publishData?.id) {
        throw new Error(
          '[META] Failed to publish Instagram carousel (no media id)',
        );
      }

      log('[META] ✅ Instagram carousel published', {
        mediaId: publishData.id,
      });

      return publishData.id;
    } catch (error) {
      logError(
        '[META] Failed to publish Instagram carousel',
        this.getErrorPayload(error),
      );
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Instagram – Single image
  // ────────────────────────────────────────────────────────────────

  async publishInstagramSingle(
    params: InstagramSingleImageParams,
  ): Promise<string> {
    try {
      log('[META] Publishing Instagram single image', {
        image_url: params.image_url,
      });

      const { data: containerData } = await this.igClient.post(
        `/${this.instagramAccountId}/media`,
        {
          image_url: params.image_url,
          caption: params.caption,
        },
      );

      if (!containerData?.id) {
        throw new Error(
          '[META] Failed to create IG media container (no id)',
        );
      }

      const creationId = containerData.id;
      log('[META] Created IG media container', { containerId: creationId });

      await this.waitForMediaReady(creationId);

      const { data: publishData } = await this.igClient.post(
        `/${this.instagramAccountId}/media_publish`,
        {
          creation_id: creationId,
        },
      );

      if (!publishData?.id) {
        throw new Error(
          '[META] Failed to publish Instagram single image (no media id)',
        );
      }

      log('[META] ✅ Instagram single image published', {
        mediaId: publishData.id,
      });

      return publishData.id;
    } catch (error) {
      logError(
        '[META] Failed to publish Instagram single image',
        this.getErrorPayload(error),
      );
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Facebook – Posts & Photos (NO-OP si FB no está habilitado)
  // ────────────────────────────────────────────────────────────────

  async publishFacebookPost(params: FacebookPostParams): Promise<string> {
    if (!this.facebookEnabled) {
      log(
        '[META] Facebook publishing is disabled. Skipping publishFacebookPost.',
        { messagePreview: params.message?.slice(0, 50) },
      );
      return 'fb_disabled';
    }

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
        },
      );

      if (!data?.id) {
        throw new Error('[META] Failed to publish Facebook post (no id)');
      }

      log('[META] ✅ Facebook post published', { postId: data.id });
      return data.id;
    } catch (error) {
      logError(
        '[META] Failed to publish Facebook post',
        this.getErrorPayload(error),
      );
      throw error;
    }
  }

  async publishFacebookImage({
    image_url,
    caption,
  }: {
    image_url: string;
    caption: string;
  }): Promise<string> {
    if (!this.facebookEnabled) {
      log(
        '[META] Facebook publishing is disabled. Skipping publishFacebookImage.',
        { image_url },
      );
      return 'fb_disabled';
    }

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
        },
      );

      const postId = data?.post_id || data?.id;
      if (!postId) {
        throw new Error(
          '[META] Failed to publish Facebook image (no id/post_id)',
        );
      }

      log('[META] ✅ Facebook image published', { postId });
      return postId;
    } catch (error) {
      logError(
        '[META] Failed to publish Facebook image',
        this.getErrorPayload(error),
      );
      throw error;
    }
  }

  async publishFacebookCarousel(
    images: string[],
    message: string,
  ): Promise<string> {
    if (!this.facebookEnabled) {
      log(
        '[META] Facebook publishing is disabled. Skipping publishFacebookCarousel.',
        { imageCount: images.length },
      );
      return 'fb_disabled';
    }

    try {
      log('[META] Publishing Facebook carousel', {
        pageId: this.facebookPageId,
        imageCount: images.length,
      });

      // En producción: subir imágenes primero y usar media_fbid reales.
      const attachedMedia = images.map((url) => ({
        media_fbid: url,
      }));

      const { data } = await this.fbClient.post(
        `/${this.facebookPageId}/feed`,
        {
          message,
          attached_media: JSON.stringify(attachedMedia),
        },
      );

      if (!data?.id) {
        throw new Error(
          '[META] Failed to publish Facebook carousel (no id)',
        );
      }

      log('[META] ✅ Facebook carousel published', { postId: data.id });
      return data.id;
    } catch (error) {
      logError(
        '[META] Failed to publish Facebook carousel',
        this.getErrorPayload(error),
      );
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Insights
  // ────────────────────────────────────────────────────────────────

  async getInstagramMediaInsights(mediaId: string): Promise<any> {
    try {
      const [insightsRes, mediaRes] = await Promise.all([
        this.igClient.get(`/${mediaId}/insights`, {
          params: {
            metric: 'reach,saved',
          },
        }),
        this.igClient.get(`/${mediaId}`, {
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

      const impressions = reach;

      return {
        impressions,
        reach,
        saves: saved,
        likes,
        comments,
        shares: 0,
      };
    } catch (error) {
      logError('[META] Failed to get Instagram insights', {
        mediaId,
        error: this.getErrorPayload(error),
      });
      throw error;
    }
  }

  async getFacebookPostInsights(postId: string): Promise<any> {
    if (!this.facebookEnabled) {
      log(
        '[META] Facebook insights are disabled. Returning zero metrics.',
        { postId },
      );
      return {
        likes: 0,
        comments: 0,
        shares: 0,
        reactions: 0,
      };
    }

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

  private parseInsights(insightsData: any[]): Record<string, number> {
    const metrics: Record<string, number> = {};

    for (const insight of insightsData) {
      metrics[insight.name] = insight.values[0]?.value || 0;
    }

    return metrics;
  }
}

export const metaClient = new MetaGraphClient();
