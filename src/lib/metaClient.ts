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
  private client: AxiosInstance;
  private accessToken: string;
  private instagramAccountId: string;
  private facebookPageId: string;

  constructor() {
    this.accessToken = config.meta.accessToken;
    this.instagramAccountId = config.meta.instagramBusinessAccountId;
    this.facebookPageId = config.meta.facebookPageId;

    this.client = axios.create({
      baseURL: 'https://graph.facebook.com/v18.0',
      params: {
        access_token: this.accessToken,
      },
    });
  }

  /**
   * Publicar un carousel en Instagram
   */
  async publishInstagramCarousel(
    images: InstagramCarouselImage[],
    caption: string
  ): Promise<string> {
    try {
      log('[META] Publishing Instagram carousel', { imageCount: images.length });

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
        containerIds.push(data.id);
        log('[META] Created carousel item container', { containerId: data.id });
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

      log('[META] Created carousel container', { containerId: carouselData.id });

      // Paso 3: Publicar el carousel
      const { data: publishData } = await this.client.post(
        `/${this.instagramAccountId}/media_publish`,
        {
          creation_id: carouselData.id,
        }
      );

      log('[META] ✅ Instagram carousel published', { mediaId: publishData.id });
      return publishData.id;

    } catch (error) {
      logError('[META] Failed to publish Instagram carousel', error);
      throw error;
    }
  }

  /**
   * Publicar una imagen simple en Instagram
   */
  async publishInstagramSingle(params: InstagramSingleImageParams): Promise<string> {
    try {
      log('[META] Publishing Instagram single image');

      // Paso 1: Crear media container
      const { data: containerData } = await this.client.post(
        `/${this.instagramAccountId}/media`,
        {
          image_url: params.image_url,
          caption: params.caption,
        }
      );

      log('[META] Created media container', { containerId: containerData.id });

      // Paso 2: Publicar
      const { data: publishData } = await this.client.post(
        `/${this.instagramAccountId}/media_publish`,
        {
          creation_id: containerData.id,
        }
      );

      log('[META] ✅ Instagram single image published', { mediaId: publishData.id });
      return publishData.id;

    } catch (error) {
      logError('[META] Failed to publish Instagram single image', error);
      throw error;
    }
  }

  /**
   * Publicar en Facebook (page post)
   */
  async publishFacebookPost(params: FacebookPostParams): Promise<string> {
    try {
      log('[META] Publishing Facebook post');

      const { data } = await this.client.post(
        `/${this.facebookPageId}/feed`,
        {
          message: params.message,
          link: params.link,
          published: params.published !== false,
        }
      );

      log('[META] ✅ Facebook post published', { postId: data.id });
      return data.id;

    } catch (error) {
      logError('[META] Failed to publish Facebook post', error);
      throw error;
    }
  }

  /**
   * Publicar carousel en Facebook (múltiples imágenes)
   */
  async publishFacebookCarousel(
    images: string[],
    message: string
  ): Promise<string> {
    try {
      log('[META] Publishing Facebook carousel', { imageCount: images.length });

      // Crear attached_media array
      const attachedMedia = images.map(url => ({
        media_fbid: url, // En producción, primero subes las imágenes y obtienes sus IDs
      }));

      const { data } = await this.client.post(
        `/${this.facebookPageId}/feed`,
        {
          message: message,
          attached_media: JSON.stringify(attachedMedia),
        }
      );

      log('[META] ✅ Facebook carousel published', { postId: data.id });
      return data.id;

    } catch (error) {
      logError('[META] Failed to publish Facebook carousel', error);
      throw error;
    }
  }

  /**
   * Obtener métricas de un post de Instagram
   */
  async getInstagramMediaInsights(mediaId: string): Promise<any> {
    try {
      const { data } = await this.client.get(
        `/${mediaId}/insights`,
        {
          params: {
            metric: 'engagement,impressions,reach,saved,likes,comments,shares',
          },
        }
      );

      return this.parseInsights(data.data);

    } catch (error) {
      logError('[META] Failed to get Instagram insights', { mediaId, error });
      throw error;
    }
  }

  /**
   * Obtener métricas de un post de Facebook
   */
  async getFacebookPostInsights(postId: string): Promise<any> {
    try {
      const { data } = await this.client.get(
        `/${postId}`,
        {
          params: {
            fields: 'likes.summary(true),comments.summary(true),shares,reactions.summary(true)',
          },
        }
      );

      return {
        likes: data.likes?.summary?.total_count || 0,
        comments: data.comments?.summary?.total_count || 0,
        shares: data.shares?.count || 0,
        reactions: data.reactions?.summary?.total_count || 0,
      };

    } catch (error) {
      logError('[META] Failed to get Facebook insights', { postId, error });
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