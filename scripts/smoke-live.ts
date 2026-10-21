/**
 * OPTIONAL live smoke test against fal.ai. This makes ONE real, billable
 * generation request. It is never run by `bun test` or `bun run check`.
 *
 *   bun run smoke:live -- path\to\image.jpg --yes-spend-money
 *
 * Uses the cheapest settings this app offers (5 s, 480P). Needs FAL_KEY in .env.
 * Writes smoke-output.mp4 in the current folder. Does not touch your films.
 */
import path from "node:path";
import { loadConfig } from "../server/config";
import { createFalProvider } from "../server/generation/providers/fal";
import { probeMedia } from "../server/media/probe";
import { MINIMAX_H3_MAX_I2V } from "../shared/models";

const args = process.argv.slice(2);
const image = args.find((a) => !a.startsWith("--"));
if (!args.includes("--yes-spend-money") || !image) {
  console.log(
    "This sends one paid request to fal.ai (minimax/h3-max/image-to-video, 5 s, 480P).\n" +
      "Run it only if you accept the charge:\n\n  bun run smoke:live -- <image.jpg|png|webp> --yes-spend-money\n",
  );
  process.exit(1);
}

const config = loadConfig();
if (!config.falKey) {
  console.error("FAL_KEY is not set in .env.");
  process.exit(1);
}
const model = MINIMAX_H3_MAX_I2V;
const fal = createFalProvider({ apiKey: config.falKey });
const abs = path.resolve(image);
const ext = path.extname(abs).toLowerCase();
const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext];
if (!mime) {
  console.error("Use a .jpg, .png or .webp image.");
  process.exit(1);
}

const settings = { durationSec: 5, resolution: "480P", seed: null };
const prompt = "A gentle, slow camera push-in. Subtle natural motion. Keep the scene faithful to the image.";
console.log("Uploading source image…");
const sourceUrl = await fal.uploadSource(model, { path: abs, filename: path.basename(abs), mimeType: mime });
console.log("Submitting (one paid request)…");
const { requestId, request } = await fal.submit(model, { prompt, sourceUrl, settings });
console.log(`Accepted as ${requestId}. Polling…`);
const job = { requestId, providerRequest: request };
for (;;) {
  const s = await fal.status(model, job);
  process.stdout.write(`  ${s}\n`);
  if (s === "completed") break;
  await new Promise((r) => setTimeout(r, 5000));
}
const result = await fal.result(model, job);
const out = path.resolve("smoke-output.mp4");
await fal.download(model, job, result, out);
const probe = await probeMedia({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }, out);
console.log(`\nSaved ${out}`);
console.log(`Duration ${probe.durationSec}s, ${probe.width}×${probe.height}, audio: ${probe.hasAudio}`);
console.log(`Expanded prompt reported: ${result.expandedPrompt ? "yes" : "no"}`);
