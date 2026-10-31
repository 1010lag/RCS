import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [192, 512]) {
    const data = await page.evaluate((size) => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const x = c.getContext("2d");
      x.fillStyle = "#e10600";
      x.fillRect(0, 0, size, size);
      x.fillStyle = "white";
      x.font = `900 ${size * 0.3}px Arial`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText("RCS.", size * 0.5, size * 0.51);
      return c.toDataURL("image/png").split(",")[1];
    }, size);
    await writeFile(`public/icon-${size}.png`, Buffer.from(data, "base64"));
  }
} finally {
  await browser.close();
}
