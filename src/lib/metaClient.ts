// src/lib/metaClient.ts
import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { log, logError } from "./logger";

class MetaGraphClient {
  private igClient: AxiosInstance;
  private fbClient: AxiosInstance;

  private IG_TOKEN: string;
  private IG_ACCOUNT_ID: string;

  private FB_PAGE_ID: string;
  private FB_PAGE_TOKEN: string;
  private facebookEnabled: boolean;

  constructor() {
    // --------------------------
    // READ ENV VARIABLES
    // --------------------------
    this.IG_TOKEN = config.meta.accessToken;
    this.IG_ACCOUNT_ID = config.meta.instagramBusinessAccountId;

    this.FB_PAGE_ID = config.meta.facebookPageId;
    this.FB_PAGE_TOKEN = config.meta.facebookPageAccessToken;

    // Facebook solo funciona si ambos están presentes
    this.facebookEnabled = !!(this.FB_PAGE_ID && this.FB_PAGE_TOKEN);

    // --------------------------
    // LOG INIT
    // --------------------------
    log("[META] MetaGraphClient initialized", {
      instagramAccountId: this.IG_ACCOUNT_ID || "(none)",
      fbPageId: this.FB_PAGE_ID || "(disabled)",
      igTokenPrefix: this.IG_TOKEN?.slice(0, 10),
      fbPageTokenPrefix: this.FB_PAGE_TOKEN?.slice(0, 10),
      facebookEnabled: this.facebookEnabled,
    });

    // --------------------------
    // IG Client
    // --------------------------
    this.igClient = axios.create({
      baseURL: "https://graph.facebook.com/v24.0",
      params: { access_token: this.IG_TOKEN },
    });

    // --------------------------
    // FB Client
    // --------------------------
    this.fbClient = axios.create({
      baseURL: "https://graph.facebook.com/v24.0",
      params: this.facebookEnabled ? { access_token: this.FB_PAGE_TOKEN } : {},
    });
  }

  private getErrorPayload(error: any) {
    if (error?.response?.data) return error.response.data;
    return error;
  }

  // ---------------------------------------------------------------------
  // FACEBOOK: imagen + texto
  // ---------------------------------------------------------------------

  async publishFacebookImage({
    image_url,
    caption,
  }: {
    image_url: string;
    caption: string;
  }): Promise<string> {
    if (!this.facebookEnabled) {
      log("[META] Facebook disabled — skipping publishFacebookImage");
      return "fb_disabled";
    }

    try {
      log("[META] Publishing to Facebook Page...", {
        pageId: this.FB_PAGE_ID,
        image_url,
      });

      const { data } = await this.fbClient.post(`/${this.FB_PAGE_ID}/photos`, {
        url: image_url,
        caption,
        published: true,
      });

      const postId = data?.post_id || data?.id;
      if (!postId) throw new Error("Facebook image publish returned no postId");

      log("[META] ✅ Facebook image published", { postId });
      return postId;
    } catch (error) {
      logError("[META] ❌ Failed FB image publish", this.getErrorPayload(error));
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // IG: SINGLE IMAGE
  // ---------------------------------------------------------------------

  async publishInstagramSingle({
    image_url,
    caption,
  }: {
    image_url: string;
    caption: string;
  }): Promise<string> {
    try {
      log("[META] Publishing Instagram single image", { image_url });

      const { data: container } = await this.igClient.post(
        `/${this.IG_ACCOUNT_ID}/media`,
        { image_url, caption }
      );

      const creationId = container?.id;
      if (!creationId) throw new Error("No IG container ID returned");

      const { data: publish } = await this.igClient.post(
        `/${this.IG_ACCOUNT_ID}/media_publish`,
        { creation_id: creationId }
      );

      if (!publish?.id) throw new Error("No IG media ID returned");

      log("[META] ✅ Instagram single image published", { mediaId: publish.id });
      return publish.id;
    } catch (error) {
      logError("[META] IG publish error", this.getErrorPayload(error));
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // IG: CAROUSEL (4+ imágenes)
  // ---------------------------------------------------------------------

  /**
   * Publica un carrusel en Instagram:
   *  1) Crea un media container por cada imagen (children)
   *  2) Crea un container padre de tipo CAROUSEL
   *  3) Llama a /media_publish con el creation_id del carrusel
   *
   * Devuelve el mediaId final (para guardarlo en generated_posts.ig_media_id)
   */
  async publishInstagramCarousel(
    imageUrls: string[],
    caption: string,
  ): Promise<string> {
    if (!this.IG_ACCOUNT_ID || !this.IG_TOKEN) {
      throw new Error(
        "Instagram no está configurado correctamente para publicar carruseles."
      );
    }

    if (!imageUrls || imageUrls.length === 0) {
      throw new Error("No se proporcionaron imágenes para el carrusel de Instagram.");
    }

    try {
      log("[META] Publishing Instagram carousel", {
        imageCount: imageUrls.length,
      });

      // 1) Crear containers para cada child (is_carousel_item = true)
      const childrenIds: string[] = [];
      for (const url of imageUrls) {
        const { data } = await this.igClient.post(
          `/${this.IG_ACCOUNT_ID}/media`,
          {
            image_url: url,
            is_carousel_item: true,
          }
        );

        const childId = data?.id;
        if (!childId) {
          throw new Error("No se pudo crear un container de carrusel para una imagen.");
        }

        childrenIds.push(childId);
        log("[META] Created carousel item container", { containerId: childId });
      }

      if (childrenIds.length === 0) {
        throw new Error("No se pudieron crear containers de carrusel en Instagram.");
      }

      // 2) Crear container padre de tipo CAROUSEL
      const { data: parentData } = await this.igClient.post(
        `/${this.IG_ACCOUNT_ID}/media`,
        {
          media_type: "CAROUSEL",
          children: childrenIds.join(","),
          caption: caption ?? "",
        }
      );

      const carouselContainerId = parentData?.id;
      log("[META] Created carousel container", {
        containerId: carouselContainerId,
      });

      if (!carouselContainerId) {
        throw new Error("No se obtuvo un creation_id para el carrusel.");
      }

      // 3) Publicar el carrusel
      const { data: publishData } = await this.igClient.post(
        `/${this.IG_ACCOUNT_ID}/media_publish`,
        {
          creation_id: carouselContainerId,
        }
      );

      const mediaId = publishData?.id;
      if (!mediaId) {
        throw new Error("No se obtuvo mediaId al publicar carrusel en Instagram.");
      }

      log("[META] ✅ Instagram carousel published", { mediaId });
      return mediaId;
    } catch (error) {
      logError(
        "[META] IG carousel publish error",
        this.getErrorPayload(error)
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // IG: INSIGHTS (para Feedback Worker)
  // ---------------------------------------------------------------------

  /**
   * Devuelve los insights de un media de IG:
   * likes, comments, impressions, reach, saved, etc.
   */
  async getInstagramMediaInsights(igMediaId: string): Promise<any> {
    if (!this.IG_TOKEN) {
      throw new Error("Instagram no está configurado para leer insights.");
    }

    try {
      const { data } = await this.igClient.get(`/${igMediaId}/insights`, {
        params: {
          metric: "impressions,reach,likes,comments,saved",
        },
      });

      log("[META] Fetched Instagram media insights", {
        igMediaId,
        metricsCount: Array.isArray(data?.data) ? data.data.length : 0,
      });

      return data;
    } catch (error) {
      logError("[META] IG insights error", this.getErrorPayload(error));
      throw error;
    }
  }
}

export const metaClient = new MetaGraphClient();
