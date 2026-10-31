import sharp from "sharp";
import { fail } from "./domain";

export async function prepareAvatar(image: string): Promise<string> {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match) fail("INVALID_AVATAR", "Выберите фотографию JPG, PNG или WebP");
  const input = Buffer.from(match![2], "base64");
  if (input.length > 256 * 1024) fail("AVATAR_TOO_LARGE", "Не удалось сжать фотографию. Выберите другое изображение", 413);
  try {
    const processor = sharp(input, { limitInputPixels: 16_000_000, failOn: "warning" });
    const metadata = await processor.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
      fail("INVALID_AVATAR", "Выберите обычную фотографию JPG, PNG или WebP");
    }
    const output = await processor.rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
    return `data:image/webp;base64,${output.toString("base64")}`;
  } catch {
    return fail("INVALID_AVATAR", "Не удалось открыть фотографию. Выберите другой файл");
  }
}
