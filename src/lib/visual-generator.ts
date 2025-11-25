// src/lib/visual-generator.ts
import sharp from 'sharp';

// Tipo minimal para no depender de todos tus tipos internos
export interface ProductLike {
  id: string;
  product_name: string;
  image_url: string | null;
}

function ensureValidImageUrl(imageUrl: string | null, productId: string): string {
  if (!imageUrl) {
    throw new Error(`Producto ${productId} no tiene image_url definida`);
  }

  // Comprobación rápida: debe empezar por http
  if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
    throw new Error(
      `Producto ${productId} tiene image_url inválida (no es URL HTTP): ${imageUrl}`
    );
  }

  // Validación formal con URL()
  try {
    // eslint-disable-next-line no-new
    new URL(imageUrl);
  } catch {
    throw new Error(
      `Producto ${productId} tiene image_url con formato incorrecto: ${imageUrl}`
    );
  }

  return imageUrl;
}

// Generador legacy básico (1 imagen cuadrada centrada)
export async function generateBasicImage(product: ProductLike): Promise<Buffer> {
  const validUrl = ensureValidImageUrl(product.image_url, product.id);

  const WIDTH = 1080;
  const HEIGHT = 1080;

  // Descargar imagen remota del producto
  const res = await fetch(validUrl);
  if (!res.ok) {
    throw new Error(
      `No se pudo descargar la imagen para el producto ${product.id} desde ${validUrl}`
    );
  }
  const originalBuffer = Buffer.from(await res.arrayBuffer());

  // Crear lienzo base
  const canvas = sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  // Redimensionar producto
  const resizedProduct = await sharp(originalBuffer)
    .resize(900, 900, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    })
    .toBuffer();

  const layers = [
    {
      input: resizedProduct,
      top: Math.floor((HEIGHT - 900) / 2),
      left: Math.floor((WIDTH - 900) / 2)
    }
  ];

  // En 3.5C: logo, badges, patrones, etc.
  const finalBuffer = await canvas.composite(layers).png().toBuffer();

  return finalBuffer;
}
