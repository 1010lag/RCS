import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";

const densities = [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [folder, density] of densities) {
    const generated = await page.evaluate((density) => {
      function drawMark(context, size, width) {
        context.fillStyle = "#ffffff";
        context.textAlign = "left";
        context.textBaseline = "alphabetic";
        context.font = `900 ${size * 0.3}px Arial`;
        const first = context.measureText("RCS.");
        const firstWidth = first.actualBoundingBoxLeft + first.actualBoundingBoxRight;
        context.font = `900 ${(size * 0.3 * width) / firstWidth}px Arial`;
        const bounds = context.measureText("RCS.");
        // Center the visible glyphs, including the dot, rather than the font's advance box.
        context.fillText("RCS.", size / 2 + (bounds.actualBoundingBoxLeft - bounds.actualBoundingBoxRight) / 2, size / 2 + (bounds.actualBoundingBoxAscent - bounds.actualBoundingBoxDescent) / 2);
      }
      const foreground = document.createElement("canvas");
      foreground.width = foreground.height = Math.round(108 * density);
      const foregroundContext = foreground.getContext("2d");
      drawMark(foregroundContext, foreground.width, 50 * density);
      const pixels = foregroundContext.getImageData(0, 0, foreground.width, foreground.height).data;
      let ink = 0;
      for (let y = 0; y < foreground.height; y++) for (let x = 0; x < foreground.width; x++) {
        if (pixels[(y * foreground.width + x) * 4 + 3] > 0) {
          ink++;
          if (Math.hypot((x + 0.5) / density - 54, (y + 0.5) / density - 54) > 33) throw new Error("Logo escapes Android's 66dp safe circle");
        }
      }
      if (!ink || pixels[3] !== 0) throw new Error("Adaptive foreground must contain a logo on transparency");
      function legacy(round) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.round(48 * density);
        const context = canvas.getContext("2d"), size = canvas.width;
        context.fillStyle = "#e10600";
        context.beginPath();
        if (round) context.arc(size / 2, size / 2, size * 0.46, 0, Math.PI * 2);
        else context.roundRect(size * 0.04, size * 0.04, size * 0.92, size * 0.92, size * 0.2);
        context.fill();
        drawMark(context, size, size * 0.64);
        return canvas.toDataURL("image/png").split(",")[1];
      }
      const preview = document.createElement("canvas");
      preview.width = 640; preview.height = 190;
      const p = preview.getContext("2d");
      p.fillStyle = "#f4f4f6"; p.fillRect(0, 0, 640, 190);
      ["circle", "squircle", "rounded square"].forEach((shape, index) => {
        const x = 53 + index * 211, y = 24, size = 112;
        p.save(); p.beginPath();
        if (shape === "circle") p.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        else p.roundRect(x, y, size, size, shape === "squircle" ? 37 : 22);
        p.clip(); p.fillStyle = "#e10600"; p.fillRect(x, y, size, size);
        // Android displays the center 72dp of the 108dp foreground layer.
        p.drawImage(foreground, 18 * density, 18 * density, 72 * density, 72 * density, x, y, size, size);
        p.restore(); p.fillStyle = "#77777f"; p.font = "14px Arial"; p.textAlign = "center"; p.fillText(shape, x + size / 2, 169);
      });
      return { foreground: foreground.toDataURL("image/png").split(",")[1], square: legacy(false), round: legacy(true), preview: preview.toDataURL("image/png").split(",")[1] };
    }, density);
    const directory = `android/app/src/main/res/mipmap-${folder}`;
    await mkdir(directory, { recursive: true });
    for (const [name, data] of [["ic_launcher", generated.square], ["ic_launcher_round", generated.round], ["ic_launcher_foreground", generated.foreground]]) await writeFile(`${directory}/${name}.png`, Buffer.from(data, "base64"));
    if (density === 4) { await mkdir(".data/qa", { recursive: true }); await writeFile(".data/qa/android-icon-masks.png", Buffer.from(generated.preview, "base64")); }
    console.log(`${folder}: ${Math.round(108 * density)}px transparent foreground; logo stays inside 66dp safe circle`);
  }
} finally { await browser.close(); }
