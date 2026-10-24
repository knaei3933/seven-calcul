import sharp from "sharp";
import fs from "node:fs/promises";

const targets = [
  { source: "assets/brand/kanei-trade-logo.png", width: 354 },
  { source: "assets/brand/epackage-lab-logo.png", width: 567 },
  { source: "assets/brand/kanei-trade-seal.png", width: 425 },
];

for (const target of targets) {
  const metadata = await sharp(target.source).metadata();
  const output = await sharp(target.source)
    .resize({ width: target.width, withoutEnlargement: true })
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();
  await fs.writeFile(target.source, output);
  const after = await sharp(output).metadata();
  console.log(`${target.source}: ${metadata.width}x${metadata.height} -> ${after.width}x${after.height}`);
}
