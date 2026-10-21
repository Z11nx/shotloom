/**
 * Layout check and screenshot tool (mock mode, disposable films only).
 *
 *   bun run build && bun run tests/browser/screens.ts <output folder> [label]
 *
 * Builds a film with six original images (made with FFmpeg), runs Gen 4 on each
 * with the mock provider, puts 12 clips on the timeline, then screenshots the
 * editor at 1774×887, 1920×1080 and 1366×768 and writes layout measurements.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../../server/media/ffmpeg";
import { api, getView, launchBrowser, serveVp9Copies, startServer, type Server } from "./harness";

const out = path.resolve(process.argv[2] ?? "tests/.tmp/screens");
const label = process.argv[3] ?? "ui";
const tools = { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };

const SHOTS: { file: string; src: string; text: string }[] = [
  { file: "Harbor at dusk.png", src: "gradients=s=1280x720:c0=0x0d2742:c1=0xe9a15b:c2=0x5d7fa3:n=3:speed=0.00001", text: "Slow push toward the water. Lights flicker on." },
  { file: "Fractal coast.png", src: "mandelbrot=s=1280x720:start_scale=2.4:end_scale=2.4", text: "Waves fold in slowly; the camera holds." },
  { file: "Signal field.png", src: "cellauto=s=1280x720:rule=30:random_fill_ratio=0.5", text: "Static pattern, light grain, no movement." },
  { file: "Night bars.png", src: "smptehdbars=s=1280x720", text: "Test card flickers once, then steadies." },
  { file: "Tall window.png", src: "testsrc2=s=720x1280", text: "Portrait source: kept whole, letterboxed." },
  { file: "Morning grid.png", src: "testsrc2=s=1280x720", text: "Pan right across the grid at walking pace." },
];

async function buildFilm(srv: Server): Promise<string> {
  const film = "Quiet Coast";
  await api(srv, "POST", "/api/films", { name: film });
  for (const s of SHOTS) {
    await runFfmpeg(tools, ["-f", "lavfi", "-i", s.src, "-frames:v", "1", path.join(srv.root, film, s.file)]);
  }
  await runFfmpeg(tools, ["-f", "lavfi", "-i", "sine=f=196:d=20", path.join(srv.root, film, "Score sketch.mp3")]);
  await getView(srv, film); // discover files
  for (const s of SHOTS) {
    await api(srv, "POST", `/api/films/${encodeURIComponent(film)}/shots/${encodeURIComponent(s.file)}/generate`, {
      text: s.text,
      settings: { durationSec: 6, resolution: "768P", seed: null },
      count: 4,
    });
  }
  type V = { state: { shots: Record<string, { generations: { id: string; status: string }[] }> } };
  const deadline = Date.now() + 240_000;
  for (;;) {
    const v = (await getView(srv, film)) as unknown as V;
    const all = Object.values(v.state.shots).flatMap((s) => s.generations);
    if (all.length === 24 && all.every((g) => g.status === "completed" || g.status === "failed")) break;
    if (Date.now() > deadline) throw new Error("Mock generations did not finish in time.");
    await Bun.sleep(500);
  }
  const v = (await getView(srv, film)) as unknown as V;
  for (const s of SHOTS) {
    for (const g of v.state.shots[s.file]!.generations.slice(0, 2)) {
      await api(srv, "POST", `/api/films/${encodeURIComponent(film)}/timeline`, { generationId: g.id });
    }
  }
  await api(srv, "PUT", `/api/films/${encodeURIComponent(film)}/soundtrack`, { filename: "Score sketch.mp3", offsetSec: 0 });
  return film;
}

const MEASURE = () => {
  const r = (el: Element) => el.getBoundingClientRect();
  const frames = [...document.querySelectorAll(".shot .media-frame")].map((el) => {
    const b = r(el);
    return { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10, ratio: b.width / b.height, visibleTop: b.top };
  });
  // Rendered content box of each source image (object-fit: contain keeps its own aspect).
  const sources = [...document.querySelectorAll(".shot .source-frame img")].map((el) => {
    const img = el as HTMLImageElement;
    const box = r(img);
    const natural = img.naturalWidth / img.naturalHeight;
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    return {
      natural: `${img.naturalWidth}x${img.naturalHeight}`,
      drawn: `${Math.round(img.naturalWidth * scale)}x${Math.round(img.naturalHeight * scale)}`,
      objectFit: getComputedStyle(img).objectFit,
      aspectPreserved: Math.abs((img.naturalWidth * scale) / (img.naturalHeight * scale) - natural) < 0.01,
    };
  });
  const textareas = [...document.querySelectorAll(".shot textarea")].map((el) => Math.round(r(el).width));
  const tiles = [...document.querySelectorAll(".clips > li")].map((el) => ({ w: Math.round(r(el).width), h: Math.round(r(el).height) }));
  const clips = document.querySelector(".clips");
  const list = document.querySelector(".shot-list");
  const rows = [...document.querySelectorAll(".shot")];
  const rowRight = Math.max(...[...document.querySelectorAll(".shot .media-cell")].map((x) => r(x).right));
  const listBox = list ? r(list) : null;
  // Overlap check: interactive controls inside each row must not overlap one another.
  const overlaps: string[] = [];
  for (const row of rows) {
    const ctrls = [...row.querySelectorAll("button, textarea, select, input")].filter((el) => {
      const b = r(el);
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).opacity !== "0";
    });
    for (let i = 0; i < ctrls.length; i++)
      for (let j = i + 1; j < ctrls.length; j++) {
        const a = r(ctrls[i]!);
        const b = r(ctrls[j]!);
        const ov = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        const nested = ctrls[i]!.contains(ctrls[j]!) || ctrls[j]!.contains(ctrls[i]!);
        if (ov && !nested) overlaps.push(`${(ctrls[i] as HTMLElement).getAttribute("aria-label") ?? ctrls[i]!.textContent?.trim()} × ${(ctrls[j] as HTMLElement).getAttribute("aria-label") ?? ctrls[j]!.textContent?.trim()}`);
      }
  }
  // Clipped text: buttons whose content is wider than the button.
  const clipped = [...document.querySelectorAll("button")]
    .filter((b) => b.offsetParent !== null && b.scrollWidth > b.clientWidth + 1)
    .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
  const lastRow = rows.at(-1);
  return {
    viewport: { w: innerWidth, h: innerHeight },
    pageScrollsHorizontally: document.documentElement.scrollWidth > innerWidth,
    frames,
    sources,
    textareas,
    tiles,
    timeline: clips ? { visibleTiles: tiles.length, scrollWidth: clips.scrollWidth, clientWidth: clips.clientWidth, scrolls: clips.scrollWidth > clips.clientWidth + 1 } : null,
    workspace: listBox ? { listLeft: listBox.left, listRight: listBox.right, rowRight, blankRight: Math.round(listBox.right - rowRight) } : null,
    // Space between the bottom of the last row's content and the bottom of the scrolled list.
    lastRowClearance: lastRow && list ? Math.round(list.scrollHeight - (r(lastRow).bottom - r(list).top + list.scrollTop)) : null,
    overlaps,
    clipped,
  };
};

/**
 * Clips are served to the test browser as VP9 copies (see serveVp9Copies in
 * harness.ts) unless SHOTLOOM_SCREENS_H264=1. The app and server are unchanged.
 */
async function serveCopies(page: import("playwright-core").Page) {
  if (process.env.SHOTLOOM_SCREENS_H264 === "1") return;
  await serveVp9Copies(page, path.join(out, ".vp9"));
}

async function main() {
  await mkdir(out, { recursive: true });
  const srv = await startServer();
  const { browser, label: browserLabel } = await launchBrowser();
  try {
    const film = await buildFilm(srv);
    const report: Record<string, unknown> = { browser: `${browserLabel} ${browser.version()}` };
    const sizes: [number, number][] = process.env.SHOTLOOM_SIZES
      ? process.env.SHOTLOOM_SIZES.split(",").map((x) => x.split("x").map(Number) as [number, number])
      : [[1774, 887], [1920, 1080], [1366, 768]];
    for (const [w, h] of sizes) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await serveCopies(page);
      await page.goto(srv.base);
      await page.getByRole("heading", { name: SHOTS[0]!.file }).waitFor();
      // Wait until every on-screen video has a decoded frame (or reports an error).
      await page
        .waitForFunction(
          () =>
            [...document.querySelectorAll("video")]
              .filter((v) => {
                const r = v.getBoundingClientRect();
                return r.bottom > 0 && r.top < innerHeight && r.width > 0;
              })
              .every((v) => v.readyState >= 2 || v.error),
          undefined,
          { timeout: 120_000, polling: 250 },
        )
        .catch(() => console.warn("Some videos had not decoded a frame before the screenshot."));
      await page.waitForTimeout(300);
      const name = `${label}-${w}x${h}`;
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      report[name] = await page.evaluate(MEASURE);
      // Scrolled to the end: the last row must be fully reachable above the timeline.
      await page.locator(".shot-list").evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(out, `${name}-bottom.png`) });
      (report[name] as Record<string, unknown>).lastRowFullyVisibleWhenScrolled = await page.evaluate(() => {
        const rows = document.querySelectorAll(".shot");
        const last = rows[rows.length - 1]!.getBoundingClientRect();
        const list = document.querySelector(".shot-list")!.getBoundingClientRect();
        const tl = document.querySelector(".timeline")!.getBoundingClientRect();
        return { lastRowBottom: Math.round(last.bottom), listBottom: Math.round(list.bottom), timelineTop: Math.round(tl.top), ok: last.bottom <= Math.min(list.bottom, tl.top) };
      });
      await ctx.close();
    }
    // Interaction states at the reference size: hover + More actions menu, then the lightbox.
    if (!process.env.SHOTLOOM_SIZES) {
      const ctx = await browser.newContext({ viewport: { width: 1774, height: 887 } });
      const page = await ctx.newPage();
      await serveCopies(page);
      await page.goto(srv.base);
      await page.getByRole("heading", { name: SHOTS[0]!.file }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll(".shot video")].slice(0, 2).every((v) => (v as HTMLVideoElement).readyState >= 2), undefined, { timeout: 120_000 });
      const vid = page.locator(".shot video").first();
      const box = (await vid.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2); // hover scrub
      await page.waitForTimeout(500);
      await page.locator(".shot").first().getByRole("button", { name: "More actions" }).click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(out, `${label}-menu.png`) });
      report.menuOpen = (await page.getByRole("group", { name: "More actions" }).count()) === 1;
      await page.keyboard.press("Escape");
      await vid.hover();
      await page.getByRole("button", { name: "Enlarge clip" }).first().click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(out, `${label}-lightbox.png`) });
      await page.keyboard.press("Escape");
      report.lightboxClosesOnEscape = (await page.getByRole("dialog").count()) === 0;
      // Keyboard: tabbing into a timeline tile reveals its tools.
      await page.locator(".clips > li").first().getByRole("button", { name: /Play clip 1/ }).focus();
      await page.keyboard.press("Tab");
      await page.waitForTimeout(250); // tools fade in over 0.1s
      report.clipToolsVisibleOnFocus = await page.evaluate(() => ({
        focused: document.activeElement?.getAttribute("aria-label"),
        opacity: getComputedStyle(document.querySelector(".clips > li .clip-tools")!).opacity,
      }));
      await ctx.close();
    }
    await writeFile(path.join(out, `${label}-metrics.json`), JSON.stringify(report, null, 2));
    console.log(`Wrote screenshots and ${label}-metrics.json to ${out} (film "${film}")`);
  } finally {
    await browser.close();
    await srv.stop();
  }
}

await main();
