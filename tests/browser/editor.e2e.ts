/**
 * Browser regression suite for the editor (mock mode only).
 *
 *   bun run test:browser            builds the UI, then runs every scenario
 *   bun run tests/browser/editor.e2e.ts [filter]
 *
 * Covers: prompt-save failures blocking generation (Gen 1 and Gen 4), latest
 * focused text being captured, responses from another film or an obsolete
 * selection never reaching the current editor, and invalid visible
 * generation settings blocking submission.
 */
import type { Page, Route } from "playwright-core";
import path from "node:path";
import {
  api,
  check,
  deferred,
  eq,
  filmUrl,
  getView,
  launchBrowser,
  makeFilm,
  recordGenerates,
  serveVp9Copies,
  startServer,
  watchFor,
  type Server,
} from "./harness";

async function runFfmpegInTest(args: string[]) {
  const { runFfmpeg } = await import("../../server/media/ffmpeg");
  await runFfmpeg({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }, args);
}

type Scenario = { name: string; run: (ctx: { page: Page; srv: Server }) => Promise<void> };
const scenarios: Scenario[] = [];
const scenario = (name: string, run: Scenario["run"]) => scenarios.push({ name, run });

async function openFilm(page: Page, srv: Server, film: string, shot: string) {
  if (!page.url().startsWith(srv.base)) await page.goto(srv.base);
  const select = page.getByLabel("Film", { exact: true });
  await select.waitFor();
  // The film list refreshes every few seconds; wait until this film is offered.
  for (let i = 0; i < 80 && !(await select.locator("option", { hasText: film }).count()); i++) await page.waitForTimeout(100);
  await select.selectOption(film);
  await page.getByRole("heading", { name: shot }).waitFor({ timeout: 10_000 });
}

const blockBox = (page: Page, n: number) => page.getByLabel(`Prompt block ${n}`, { exact: true });
const shotBox = (page: Page, shot: string) => page.getByLabel(`Description for ${shot}`, { exact: true });
const genButton = (page: Page, count: 1 | 4) => page.getByRole("button", { name: `Gen ${count}`, exact: true });

/** Clicks if enabled; if the button stays disabled the click is skipped. Returns whether it clicked. */
async function clickIfEnabled(page: Page, count: 1 | 4): Promise<boolean> {
  const b = genButton(page, count);
  if (await b.isDisabled()) return false;
  await b.click({ timeout: 2000 });
  return true;
}

async function waitForGenerations(srv: Server, film: string, shot: string, n: number) {
  for (let i = 0; i < 100; i++) {
    const v = await getView(srv, film);
    if ((v.state.shots[shot]?.generations.length ?? 0) >= n) return v;
    await Bun.sleep(50);
  }
  throw new Error(`Expected ${n} generations for ${film}/${shot}`);
}

// -----------------------------------------------------------------------------
// Defect 2: a failed prompt-block save must stop generation
// -----------------------------------------------------------------------------

for (const count of [1, 4] as const) {
  scenario(`save failure blocks Gen ${count}; edited text kept; retry submits the edit`, async ({ page, srv }) => {
    const film = `Save Fail ${count}`;
    const shot = "shot.png";
    await makeFilm(srv, film, shot, "OLD BLOCK");
    const gens = recordGenerates(page);
    await openFilm(page, srv, film, shot);

    let failSaves = true;
    await page.route(
      (u) => u.pathname.startsWith(`/api/films/${encodeURIComponent(film)}/prompt-blocks/`),
      async (route: Route) => {
        if (failSaves && route.request().method() === "PATCH") {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "Disk is full" } }) });
        } else await route.fallback();
      },
    );

    await shotBox(page, shot).fill("the shot");
    await blockBox(page, 1).fill(`EDITED BLOCK ${count}`);
    await clickIfEnabled(page, count); // focus still in the block textarea
    await page.waitForTimeout(1500);

    eq(gens.length, 0, "generate requests after a failed block save");
    eq((await getView(srv, film)).state.shots[shot]!.generations.length, 0, "server generations after failed save");
    eq(await blockBox(page, 1).inputValue(), `EDITED BLOCK ${count}`, "edited block text still visible");
    check(await page.getByText(/not saved|wasn't saved|could not be saved/i).first().isVisible(), "an error explains the save failure");

    // The server must still hold the old block (nothing was silently replaced).
    eq((await getView(srv, film)).state.promptBlocks[0]!.text, "OLD BLOCK", "server block before retry");

    failSaves = false;
    await page.waitForTimeout(200);
    check(await clickIfEnabled(page, count), `Gen ${count} is available for a deliberate retry`);
    const v = await waitForGenerations(srv, film, shot, count);
    eq(gens.length, 1, "exactly one generate request on retry");
    const prompts = v.state.shots[shot]!.generations.map((g) => g.submittedPrompt);
    eq(prompts, Array(count).fill(`EDITED BLOCK ${count}\n\nthe shot`), "submitted prompts after retry");
  });

  scenario(`Gen ${count} while an input still has focus captures the latest text`, async ({ page, srv }) => {
    const film = `Focus ${count}`;
    const shot = "focus.png";
    await makeFilm(srv, film, shot, "BLOCK START");
    const gens = recordGenerates(page);
    await openFilm(page, srv, film, shot);
    await blockBox(page, 1).fill("BLOCK TYPED JUST NOW");
    await shotBox(page, shot).fill("shot text");
    await shotBox(page, shot).press("End");
    await page.keyboard.type(" and more"); // focus remains in the shot textarea
    await genButton(page, count).click();
    const v = await waitForGenerations(srv, film, shot, count);
    eq(gens.length, 1, "one generate request");
    eq(gens[0]!.body.text, "shot text and more", "shot text sent with the request");
    eq(
      v.state.shots[shot]!.generations.map((g) => g.submittedPrompt),
      Array(count).fill("BLOCK TYPED JUST NOW\n\nshot text and more"),
      "submitted prompt uses the latest block and shot text",
    );
  });
}

// -----------------------------------------------------------------------------
// Defect 3: responses for another film / an obsolete selection must be ignored
// -----------------------------------------------------------------------------

async function twoFilms(srv: Server, suffix: string) {
  const A = `Alpha ${suffix}`;
  const B = `Beta ${suffix}`;
  await makeFilm(srv, A, "alpha-only.png", "ALPHA BLOCK");
  await makeFilm(srv, B, "beta-only.png", "BETA BLOCK");
  return { A, B };
}

scenario("a delayed save + Gen in film A never shows A's content after switching to B", async ({ page, srv }) => {
  const { A, B } = await twoFilms(srv, "1");
  const gens = recordGenerates(page);
  await openFilm(page, srv, A, "alpha-only.png");
  const hold = deferred();
  let held = false;
  await page.route(
    (u) => u.pathname.startsWith(`/api/films/${encodeURIComponent(A)}/prompt-blocks/`),
    async (route) => {
      if (route.request().method() === "PATCH") {
        held = true;
        await hold.promise;
      }
      await route.fallback();
    },
  );
  await blockBox(page, 1).fill("ALPHA EDIT");
  await genButton(page, 1).click();
  for (let i = 0; i < 50 && !held; i++) await page.waitForTimeout(20);
  check(held, "the block save for A was held");

  await page.getByLabel("Film", { exact: true }).selectOption(B);
  await page.getByRole("heading", { name: "beta-only.png" }).waitFor();
  const seen = await watchFor(page, ["alpha-only.png", "ALPHA BLOCK", "ALPHA EDIT"], { scope: "editor" });
  hold.resolve();
  await page.waitForTimeout(3000);

  eq(await seen(), [], "Film A content seen in the editor while Film B is selected");
  // The only mention of A allowed is the notification saying its Gen was cancelled.
  check(
    await page.locator(".toast", { hasText: /cancelled because you switched films/ }).first().isVisible(),
    "a notice explains that A's generation was cancelled",
  );
  eq(await page.getByLabel("Film", { exact: true }).inputValue(), B, "selected film");
  check(await page.getByRole("heading", { name: "beta-only.png" }).isVisible(), "Film B's shot is shown");
  eq(gens.filter((g) => g.film === A).length, 0, "generate requests sent for A after leaving it");

  // Subsequent edits go only to B. A keeps its own saved edit and nothing else.
  await shotBox(page, "beta-only.png").fill("BETA EDIT");
  await shotBox(page, "beta-only.png").blur();
  await page.waitForTimeout(1200);
  const [va, vb] = await Promise.all([getView(srv, A), getView(srv, B)]);
  eq(vb.state.shots["beta-only.png"]!.text, "BETA EDIT", "B's shot text");
  eq(vb.state.promptBlocks[0]!.text, "BETA BLOCK", "B's block untouched");
  eq(va.state.shots["alpha-only.png"]!.text, "", "A's shot text untouched");
  eq(va.state.promptBlocks[0]!.text, "ALPHA EDIT", "A's own edit saved to A");
  eq(va.state.shots["alpha-only.png"]!.generations.length, 0, "no generation created for A");
});

scenario("a stale polling error for film A does not replace film B", async ({ page, srv }) => {
  const { A, B } = await twoFilms(srv, "2");
  await openFilm(page, srv, A, "alpha-only.png");
  const hold = deferred();
  const caught = deferred();
  let armed = true;
  await page.route(
    (u) => u.pathname === `/api/films/${encodeURIComponent(A)}`,
    async (route) => {
      if (armed && route.request().method() === "GET") {
        armed = false;
        caught.resolve();
        await hold.promise;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "STATE_UNREADABLE", message: "STALE ERROR FOR ALPHA" } }),
        });
        return;
      }
      await route.fallback();
    },
  );
  await caught.promise; // the next background poll for A is now in flight and held
  await page.getByLabel("Film", { exact: true }).selectOption(B);
  await page.getByRole("heading", { name: "beta-only.png" }).waitFor();
  const seen = await watchFor(page, ["STALE ERROR FOR ALPHA", "can't be opened"]);
  hold.resolve();
  await page.waitForTimeout(3000);
  eq(await seen(), [], "stale error shown");
  check(await page.getByRole("heading", { name: "beta-only.png" }).isVisible(), "Film B still shown");
  eq(await page.getByLabel("Film", { exact: true }).inputValue(), B, "selected film");
});

scenario("switching A → B → A rejects a response from the obsolete A session", async ({ page, srv }) => {
  const { A, B } = await twoFilms(srv, "3");
  const gens = recordGenerates(page);
  await openFilm(page, srv, A, "alpha-only.png");
  const hold = deferred();
  let held = false;
  await page.route(
    (u) => u.pathname.startsWith(`/api/films/${encodeURIComponent(A)}/prompt-blocks/`),
    async (route) => {
      if (route.request().method() === "PATCH" && !held) {
        held = true;
        await hold.promise;
      }
      await route.fallback();
    },
  );
  // If the obsolete session ever submits, its response carries a marker.
  await page.route(
    (u) => u.pathname.startsWith(`/api/films/${encodeURIComponent(A)}/shots/`) && u.pathname.endsWith("/generate"),
    async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.view.state.promptBlocks[0].text = "STALE MARKER";
      await route.fulfill({ response: res, body: JSON.stringify(body) });
    },
  );
  await blockBox(page, 1).fill("ALPHA SESSION ONE");
  await genButton(page, 1).click();
  for (let i = 0; i < 50 && !held; i++) await page.waitForTimeout(20);
  check(held, "the session-one save was held");

  await page.getByLabel("Film", { exact: true }).selectOption(B);
  await page.getByRole("heading", { name: "beta-only.png" }).waitFor();
  await page.getByLabel("Film", { exact: true }).selectOption(A);
  await page.getByRole("heading", { name: "alpha-only.png" }).waitFor();
  const seen = await watchFor(page, ["STALE MARKER"]);
  hold.resolve();
  await page.waitForTimeout(3000);
  eq(await seen(), [], "obsolete-session response applied");
  eq(gens.length, 0, "generate requests from the obsolete session");
  // The editor still works for the new A session.
  await shotBox(page, "alpha-only.png").fill("SESSION TWO TEXT");
  await shotBox(page, "alpha-only.png").blur();
  await page.waitForTimeout(1200);
  eq((await getView(srv, A)).state.shots["alpha-only.png"]!.text, "SESSION TWO TEXT", "edit in the new A session saved");
});

// -----------------------------------------------------------------------------
// Defect 4: invalid visible settings must block generation
// -----------------------------------------------------------------------------

scenario("invalid duration or seed blocks generation; valid visible settings are sent exactly", async ({ page, srv }) => {
  const film = "Settings Film";
  const shot = "set.png";
  await makeFilm(srv, film, shot, "style");
  const gens = recordGenerates(page);
  await openFilm(page, srv, film, shot);
  await shotBox(page, shot).fill("settings test");
  const duration = page.getByLabel("Duration", { exact: true });
  const seed = page.getByLabel("Seed", { exact: true });

  for (const bad of ["", "6.5", "2", "16", "0", "-3"]) {
    await duration.fill(bad);
    const g1 = await clickIfEnabled(page, 1);
    const g4 = await clickIfEnabled(page, 4);
    await page.waitForTimeout(300);
    eq({ gen1Clicked: g1, gen4Clicked: g4 }, { gen1Clicked: false, gen4Clicked: false }, `buttons with duration "${bad}"`);
    check(await page.getByText(/fix the generation settings/i).first().isVisible(), `explanation shown for duration "${bad}"`);
  }
  eq(gens.length, 0, "generate requests while duration was invalid");

  await duration.fill("9");
  await page.getByLabel("Resolution", { exact: true }).selectOption("480P");
  for (const bad of ["-1", "1.5", "99999999999", "1e3"]) {
    await seed.fill(bad);
    eq(await clickIfEnabled(page, 1), false, `Gen 1 clickable with seed "${bad}"`);
    check(await page.getByText(/fix the generation settings/i).first().isVisible(), `explanation shown for seed "${bad}"`);
  }
  eq(gens.length, 0, "generate requests while seed was invalid");

  // Gen 4 never uses the seed field (it always picks four random seeds), so it stays available.
  check(await genButton(page, 4).isEnabled(), "Gen 4 available while only the seed is invalid");
  await genButton(page, 4).click();
  let v = await waitForGenerations(srv, film, shot, 4);
  eq(gens.at(-1)!.body.settings, { durationSec: 9, resolution: "480P", seed: null }, "Gen 4 settings sent");
  const g4seeds = v.state.shots[shot]!.generations.map((g) => g.settings.seed);
  eq(new Set(g4seeds).size, 4, "four distinct seeds");
  check(v.state.shots[shot]!.generations.every((g) => g.settings.durationSec === 9 && g.settings.resolution === "480P"), "Gen 4 records use the visible duration and resolution");

  await seed.fill("4242");
  await page.waitForTimeout(100);
  await genButton(page, 1).click();
  v = await waitForGenerations(srv, film, shot, 5);
  eq(gens.at(-1)!.body.settings, { durationSec: 9, resolution: "480P", seed: 4242 }, "Gen 1 settings sent");
  eq(v.state.shots[shot]!.generations.at(-1)!.settings, { durationSec: 9, resolution: "480P", seed: 4242 }, "Gen 1 settings recorded");

  await seed.fill("");
  await duration.fill("12");
  await page.waitForTimeout(100);
  await genButton(page, 1).click();
  v = await waitForGenerations(srv, film, shot, 6);
  eq(gens.at(-1)!.body.settings, { durationSec: 12, resolution: "480P", seed: null }, "blank seed means random");
});

// -----------------------------------------------------------------------------
// Description edits made while a Gen response is pending
// -----------------------------------------------------------------------------

/**
 * Intercepts this film's generate request.
 *  "after-server":  the server processes it, then delivery of the response is held.
 *  "before-server": the request itself is held before it reaches the server.
 */
async function holdGenerate(page: Page, film: string, mode: "after-server" | "before-server") {
  const intercepted = deferred();
  const processed = deferred();
  const release = deferred();
  const delivered = deferred();
  await page.route(
    (u) => u.pathname.startsWith(`/api/films/${encodeURIComponent(film)}/shots/`) && u.pathname.endsWith("/generate"),
    async (route) => {
      intercepted.resolve();
      if (mode === "before-server") await release.promise;
      const res = await route.fetch();
      processed.resolve();
      if (mode === "after-server") await release.promise;
      await route.fulfill({ response: res });
      delivered.resolve();
    },
  );
  return { intercepted, processed, release, delivered };
}

/** Records description saves (PATCH .../shots/<shot>) for a film: sent and finished. */
function recordShotSaves(page: Page, film: string) {
  const prefix = `/api/films/${encodeURIComponent(film)}/shots/`;
  const isSave = (url: string, method: string) => {
    const p = new URL(url).pathname;
    return method === "PATCH" && p.startsWith(prefix) && !p.endsWith("/generate");
  };
  const sent: string[] = [];
  const done: { text: string; status: number }[] = [];
  page.on("request", (r) => {
    if (isSave(r.url(), r.method())) sent.push((r.postDataJSON() as { text: string }).text);
  });
  page.on("response", (r) => {
    const q = r.request();
    if (isSave(r.url(), q.method())) done.push({ text: (q.postDataJSON() as { text: string }).text, status: r.status() });
  });
  return { sent, done };
}

async function eventually(what: string, cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const serverText = async (srv: Server, film: string, shot: string) => (await getView(srv, film)).state.shots[shot]!.text;

/** Saves `text` as the shot's description through the UI and waits until the server has it. */
async function saveDescription(page: Page, srv: Server, film: string, shot: string, text: string) {
  await shotBox(page, shot).fill(text);
  await shotBox(page, shot).blur();
  await eventually(`server description "${text}"`, async () => (await serverText(srv, film, shot)) === text);
}

/** Waits until this row's Gen buttons are no longer busy ("Sending…"). */
async function genSettled(page: Page) {
  await page.getByRole("button", { name: "Sending…" }).waitFor({ state: "detached", timeout: 10_000 });
}

async function reloadAndRead(page: Page, srv: Server, film: string, shot: string): Promise<string> {
  await page.reload();
  await openFilm(page, srv, film, shot);
  return shotBox(page, shot).inputValue();
}

for (const count of [1, 4] as const) {
  scenario(`Gen ${count}: a description edited while the response is pending is saved and survives reload`, async ({ page, srv }) => {
    const film = `Pending Edit ${count}`;
    const shot = "race.png";
    await makeFilm(srv, film, shot, "STYLE");
    await openFilm(page, srv, film, shot);
    await saveDescription(page, srv, film, shot, "ORIGINAL TEXT SENT");
    const saves = recordShotSaves(page, film);
    const gen = await holdGenerate(page, film, "after-server");

    await genButton(page, count).click();
    await gen.processed.promise; // the server has created the jobs; the response is held
    await shotBox(page, shot).fill("NEW EDIT WHILE SAVING");
    // Precondition for the race: the new edit's autosave has not been sent yet.
    eq(saves.sent.length, 0, "description saves sent before the generate response was released (race precondition)");
    gen.release.resolve();
    await gen.delivered.promise;
    await genSettled(page);
    eq(saves.sent.length, 0, "the response arrived before the new edit's autosave (race precondition)");

    await shotBox(page, shot).blur();
    await eventually(
      'the newer description "NEW EDIT WHILE SAVING" is persisted',
      async () => (await serverText(srv, film, shot)) === "NEW EDIT WHILE SAVING",
    );
    eq(await reloadAndRead(page, srv, film, shot), "NEW EDIT WHILE SAVING", "description after reload");
    const v = await getView(srv, film);
    eq(
      v.state.shots[shot]!.generations.map((g) => g.submittedPrompt),
      Array(count).fill("STYLE\n\nORIGINAL TEXT SENT"),
      "generation records keep the original submitted prompt",
    );
  });
}

scenario("the newer edit finishes saving before the delayed Gen response arrives", async ({ page, srv }) => {
  const film = "Save First";
  const shot = "first.png";
  await makeFilm(srv, film, shot, "STYLE");
  await openFilm(page, srv, film, shot);
  await saveDescription(page, srv, film, shot, "ORIGINAL TEXT SENT");
  const gen = await holdGenerate(page, film, "after-server");

  await genButton(page, 1).click();
  await gen.processed.promise;
  // Wait for the browser to receive the newer save's response (not just for the
  // server to have it) before releasing the older generate response.
  const newerSaved = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      new URL(r.url()).pathname === `/api/films/${encodeURIComponent(film)}/shots/${encodeURIComponent(shot)}` &&
      (r.request().postDataJSON() as { text: string }).text === "NEWER, ALREADY SAVED",
    { timeout: 10_000 },
  );
  await shotBox(page, shot).fill("NEWER, ALREADY SAVED");
  await shotBox(page, shot).blur();
  const saveRes = await newerSaved;
  eq(saveRes.status(), 200, "the newer save's status");
  eq(await serverText(srv, film, shot), "NEWER, ALREADY SAVED", "server has the newer text before release");

  gen.release.resolve(); // the older generate response (still carrying the original text) arrives now
  await gen.delivered.promise;
  await genSettled(page);
  await page.waitForTimeout(2500); // allow polls and any re-render
  eq(await shotBox(page, shot).inputValue(), "NEWER, ALREADY SAVED", "visible description after the stale response");
  eq(await serverText(srv, film, shot), "NEWER, ALREADY SAVED", "persisted description after the stale response");
  await eventually("the new generation appears in the editor", async () => (await page.locator(".variation-nav .tabular").first().textContent()) === "1 / 1");
  eq(await reloadAndRead(page, srv, film, shot), "NEWER, ALREADY SAVED", "description after reload");
  eq((await getView(srv, film)).state.shots[shot]!.generations[0]!.submittedPrompt, "STYLE\n\nORIGINAL TEXT SENT", "generation record");
});

scenario("a newer edit saved before a delayed Gen request reaches the server is not overwritten", async ({ page, srv }) => {
  const film = "Server Order";
  const shot = "order.png";
  await makeFilm(srv, film, shot, "STYLE");
  await openFilm(page, srv, film, shot);
  await saveDescription(page, srv, film, shot, "ORIGINAL TEXT SENT");
  const gen = await holdGenerate(page, film, "before-server");

  await genButton(page, 1).click();
  await gen.intercepted.promise; // the request has left the page but not reached the server
  await saveDescription(page, srv, film, shot, "NEWER, SAVED EARLIER");
  gen.release.resolve(); // now the server applies the generate, which writes the original text
  await gen.delivered.promise;
  await genSettled(page);
  await eventually(
    "the newer description is restored on the server",
    async () => (await serverText(srv, film, shot)) === "NEWER, SAVED EARLIER",
  );
  eq(await reloadAndRead(page, srv, film, shot), "NEWER, SAVED EARLIER", "description after reload");
  eq((await getView(srv, film)).state.shots[shot]!.generations[0]!.submittedPrompt, "STYLE\n\nORIGINAL TEXT SENT", "generation record");
});

scenario("with no edits while pending, the Gen response acknowledges the sent description", async ({ page, srv }) => {
  const film = "Plain Ack";
  const shot = "ack.png";
  await makeFilm(srv, film, shot, "STYLE");
  await openFilm(page, srv, film, shot);
  const saves = recordShotSaves(page, film);
  const gen = await holdGenerate(page, film, "after-server");

  // Typed but not yet autosaved; Gen is triggered without moving focus, so only the
  // generate request carries this text.
  await shotBox(page, shot).fill("SENT WITH GEN");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Gen 1") as HTMLButtonElement;
    b.click();
  });
  await gen.processed.promise;
  eq(saves.sent.length, 0, "no separate description save before the response (precondition)");
  gen.release.resolve();
  await gen.delivered.promise;
  await genSettled(page);
  await page.waitForTimeout(1500); // longer than the autosave delay
  eq(saves.sent, [], "redundant description saves after acknowledgement");
  check(!(await page.getByText(/^Not saved:/).first().isVisible().catch(() => false)), "no unsaved-description error");
  eq(await serverText(srv, film, shot), "SENT WITH GEN", "persisted description");
  eq(await reloadAndRead(page, srv, film, shot), "SENT WITH GEN", "description after reload");

  // Editing still saves normally afterwards.
  await saveDescription(page, srv, film, shot, "EDITED AFTER");
  eq((await getView(srv, film)).state.shots[shot]!.generations[0]!.submittedPrompt, "STYLE\n\nSENT WITH GEN", "generation record");
});

scenario("switching films while a Gen response is pending does not affect the new film", async ({ page, srv }) => {
  const A = "Pending Alpha";
  const B = "Pending Beta";
  await makeFilm(srv, A, "alpha-only.png", "ALPHA BLOCK");
  await makeFilm(srv, B, "beta-only.png", "BETA BLOCK");
  await openFilm(page, srv, A, "alpha-only.png");
  await saveDescription(page, srv, A, "alpha-only.png", "ALPHA ORIGINAL");
  const gen = await holdGenerate(page, A, "after-server");

  await genButton(page, 1).click();
  await gen.processed.promise;
  await shotBox(page, "alpha-only.png").fill("ALPHA NEWER");
  await page.getByLabel("Film", { exact: true }).selectOption(B);
  await page.getByRole("heading", { name: "beta-only.png" }).waitFor();
  const seen = await watchFor(page, ["alpha-only.png", "ALPHA"], { scope: "editor" });
  gen.release.resolve();
  await gen.delivered.promise;
  await page.waitForTimeout(2500);

  eq(await seen(), [], "Film A content in Film B's editor");
  eq(await page.getByLabel("Film", { exact: true }).inputValue(), B, "selected film");
  eq(await shotBox(page, "beta-only.png").inputValue(), "", "B's description");
  const vb = await getView(srv, B);
  eq(vb.state.shots["beta-only.png"]!.text, "", "B's persisted description");
  eq(vb.state.promptBlocks.map((b) => b.text), ["BETA BLOCK"], "B's prompt blocks");
  eq(vb.state.shots["beta-only.png"]!.generations.length, 0, "B's generations");

  // A keeps both its generation (original prompt) and its newer description.
  await eventually("A's newer description is persisted", async () => (await serverText(srv, A, "alpha-only.png")) === "ALPHA NEWER");
  const va = await getView(srv, A);
  eq(va.state.shots["alpha-only.png"]!.generations.map((g) => g.submittedPrompt), ["ALPHA BLOCK\n\nALPHA ORIGINAL"], "A's generation record");
  await page.getByLabel("Film", { exact: true }).selectOption(A);
  await page.getByRole("heading", { name: "alpha-only.png" }).waitFor();
  eq(await shotBox(page, "alpha-only.png").inputValue(), "ALPHA NEWER", "A's description after switching back");
});

// -----------------------------------------------------------------------------
// Compact layout (redesign): geometry, menus and the save indicator
// -----------------------------------------------------------------------------

scenario("layout: exact 16:9 previews, contained media, narrow descriptions, small timeline tiles", async ({ page, srv }) => {
  const film = "Layout Film";
  await makeFilm(srv, film, "wide.png", "style");
  // A portrait source must be letterboxed inside its 16:9 frame, never cropped or stretched.
  await runFfmpegInTest(["-f", "lavfi", "-i", "testsrc2=s=720x1280", "-frames:v", "1", `${srv.root}/${film}/tall.png`]);
  await page.setViewportSize({ width: 1774, height: 887 });
  await page.goto(srv.base);
  await openFilm(page, srv, film, "tall.png");
  await genButton(page, 1).first().click();
  await waitForGenerations(srv, film, "tall.png", 1);
  await eventually("the generated clip is ready", async () =>
    (await page.locator(".shot").first().getByRole("button", { name: "Add to timeline" }).count()) > 0, 20_000);
  await page.locator(".shot").first().getByRole("button", { name: "Add to timeline" }).click();
  await page.locator(".clips > li").first().waitFor();

  const m = await page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect();
    const frames = [...document.querySelectorAll(".shot .media-frame")].map((el) => r(el));
    const imgs = [...document.querySelectorAll(".shot .source-frame img")].map((el) => {
      const img = el as HTMLImageElement;
      const box = r(img);
      const frame = r(img.parentElement!);
      return { inside: box.width <= frame.width + 0.5 && box.height <= frame.height + 0.5, fit: getComputedStyle(img).objectFit };
    });
    const tile = r(document.querySelector(".clips > li")!);
    return {
      ratios: frames.map((b) => b.width / b.height),
      widths: frames.map((b) => Math.round(b.width)),
      imgs,
      textarea: Math.round(r(document.querySelector(".shot textarea")!).width),
      tile: { w: Math.round(tile.width), h: Math.round(tile.height) },
      rowRight: Math.max(...[...document.querySelectorAll(".shot .media-cell")].map((e) => r(e).right)),
      listRight: r(document.querySelector(".shot-list")!).right,
    };
  });
  check(m.ratios.length >= 4 && m.ratios.every((x) => Math.abs(x - 16 / 9) < 0.002), `every preview frame is 16:9 (${m.ratios.map((x) => x.toFixed(4))})`);
  check(new Set(m.widths).size === 1, `source and generated frames share one width (${m.widths})`);
  check(m.imgs.every((x) => x.inside && x.fit === "contain"), `source images are contained in their frames (${JSON.stringify(m.imgs)})`);
  check(m.textarea >= 190 && m.textarea <= 220, `description stays narrow (${m.textarea}px)`);
  check(m.tile.w <= 140 && m.tile.h <= 90, `timeline tile stays small (${m.tile.w}×${m.tile.h})`);
  check(m.listRight - m.rowRight > 300, `wide screens keep blank space to the right (${Math.round(m.listRight - m.rowRight)}px)`);
  const tallFit = await page.locator(".shot").first().locator("video").evaluate((v) => getComputedStyle(v).objectFit);
  eq(tallFit, "contain", "a portrait generated clip is letterboxed, not cropped");
});

scenario("More actions: exact trim, use full clip, details and Escape all work from the menu", async ({ page, srv }) => {
  const film = "Menu Film";
  const shot = "menu.png";
  await makeFilm(srv, film, shot, "style");
  await openFilm(page, srv, film, shot);
  await genButton(page, 1).click();
  await waitForGenerations(srv, film, shot, 1);
  await page.getByRole("button", { name: "Add to timeline" }).waitFor({ timeout: 20_000 });

  const more = page.getByRole("button", { name: "More actions" });
  await more.click();
  const menu = page.getByRole("group", { name: "More actions" });
  await menu.getByLabel("In", { exact: true }).fill("1");
  await menu.getByLabel("Out", { exact: true }).fill("3.5");
  await menu.getByRole("button", { name: "Set" }).click();
  type T = { state: { shots: Record<string, { generations: { trim: { inSec: number; outSec: number } | null }[] }> } };
  await eventually("trim saved", async () => JSON.stringify(((await getView(srv, film)) as unknown as T).state.shots[shot]!.generations[0]!.trim) === '{"inSec":1,"outSec":3.5}');
  await eventually("the trimmed range is shown under the clip", async () => (await page.locator(".trim-label").first().textContent())?.includes("0:01–0:03.5") ?? false);
  eq(await page.locator(".trim-label").first().textContent(), "0:01–0:03.5 · 2.50s", "trim label");

  await more.click();
  await page.getByRole("group", { name: "More actions" }).getByRole("button", { name: "Use full clip" }).click();
  await eventually("trim cleared", async () => ((await getView(srv, film)) as unknown as T).state.shots[shot]!.generations[0]!.trim === null);

  await more.click();
  await page.keyboard.press("Escape");
  eq(await page.getByRole("group", { name: "More actions" }).count(), 0, "menu closes on Escape");
  check(await more.evaluate((el) => el === document.activeElement), "focus returns to the menu button");

  await more.click();
  await page.getByRole("group", { name: "More actions" }).getByRole("button", { name: "Details" }).click();
  check(await page.locator(".gen-details").isVisible(), "details panel opens");
  await more.click();
  await page.getByRole("group", { name: "More actions" }).getByRole("button", { name: /text that will be sent/ }).click();
  check(await page.getByLabel("Text that will be sent").isVisible(), "sent-text preview opens");
});

scenario("the save indicator reflects real autosave state", async ({ page, srv }) => {
  const film = "Status Film";
  const shot = "status.png";
  await makeFilm(srv, film, shot, "style");
  await openFilm(page, srv, film, shot);
  const status = page.locator(".save-status");
  eq(await status.textContent(), "Saved locally", "idle state");

  const hold = deferred();
  let fail = false;
  await page.route(
    (u) => u.pathname === `/api/films/${encodeURIComponent(film)}/shots/${encodeURIComponent(shot)}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await hold.promise;
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"INTERNAL","message":"Disk is full"}}' });
      else await route.fallback();
    },
  );
  await shotBox(page, shot).fill("typing");
  await eventually('"Saving…" while the edit is unsaved', async () => (await status.textContent()) === "Saving…", 3000);
  await shotBox(page, shot).blur();
  hold.resolve();
  await eventually('"Saved locally" after the save', async () => (await status.textContent()) === "Saved locally");

  fail = true;
  await shotBox(page, shot).fill("this save fails");
  await shotBox(page, shot).blur();
  await eventually('"Changes not saved" after a failed save', async () => (await status.textContent()) === "Changes not saved");
});

// -----------------------------------------------------------------------------
// Preservation: the core workflow still works end to end
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Generated previews: silent loop, sound on hover, scrub, click to enlarge
// -----------------------------------------------------------------------------

scenario("previews loop silently; hover adds sound and scrubs; click enlarges with sound", async ({ page, srv }) => {
  const film = "Loop Film";
  await makeFilm(srv, film, "one.png");
  await runFfmpegInTest(["-f", "lavfi", "-i", "testsrc2=s=640x360", "-frames:v", "1", `${srv.root}/${film}/two.png`]);
  await getView(srv, film);
  for (const shot of ["one.png", "two.png"]) {
    await api(srv, "POST", `${filmUrl(film)}/shots/${encodeURIComponent(shot)}/generate`, {
      text: "loop check",
      settings: { durationSec: 6, resolution: "768P", seed: null },
      count: 1,
    });
  }
  await eventually("both mock clips finish", async () => {
    const shots = (await getView(srv, film)).state.shots as Record<string, { generations: { status?: string }[] }>;
    return ["one.png", "two.png"].every((s) => shots[s]!.generations[0]?.status === "completed");
  }, 30_000);

  // Edge/Chrome play the H.264 originals; bundled Chromium gets VP9 copies.
  await serveVp9Copies(page, path.join(srv.root, "..", "vp9"), { onlyIfNoH264: true });
  await page.setViewportSize({ width: 1774, height: 887 });
  await page.goto(srv.base);
  await openFilm(page, srv, film, "one.png");
  type V = { paused: boolean; muted: boolean; loop: boolean; t: number; d: number };
  const states = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLVideoElement>(".shot video")].map((v) => ({ paused: v.paused, muted: v.muted, loop: v.loop, t: v.currentTime, d: v.duration })),
    ) as Promise<V[]>;

  await eventually("every preview plays on its own, muted and looping", async () => {
    const vs = await states();
    return vs.length === 2 && vs.every((v) => !v.paused && v.muted && v.loop && v.t > 0.3);
  }, 30_000);
  const t0 = (await states())[1]!.t;
  await page.waitForTimeout(600);
  check((await states())[1]!.t !== t0, "playback advances without any interaction");
  const bar = () =>
    page.evaluate(() => {
      const line = document.querySelector(".shot .scrub-line")!.getBoundingClientRect();
      const green = document.querySelector(".shot .scrub-line .trim-range")!.getBoundingClientRect();
      const head = document.querySelector(".shot .scrub-line .playhead");
      return {
        greenShare: green.width / line.width,
        head: head ? (head.getBoundingClientRect().left + 1 - line.left) / line.width : null,
        played: document.querySelectorAll(".scrub-line .played").length,
      };
    });
  // Loops at the requested 6 s: the extra tail is never shown.
  const maxT = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const v = document.querySelectorAll<HTMLVideoElement>(".shot video")[1]!;
        let max = 0;
        const timer = setInterval(() => (max = Math.max(max, v.currentTime)), 15);
        setTimeout(() => {
          clearInterval(timer);
          resolve(max);
        }, 7000);
      }),
  );
  check(maxT > 5.5 && maxT < 6.06, `preview loops at the requested length, never into the extra tail (max ${maxT.toFixed(3)} s)`);
  const fit = await page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>(".shot video")].map((v) => getComputedStyle(v).objectFit));
  eq(fit.join(","), "cover,cover", "near-16:9 clips fill the frame (no side bars)");
  const b0 = await bar();
  check(b0.greenShare > 0.99 && b0.played === 0, `the bar is solid green with no progress fill (${JSON.stringify(b0)})`);
  check(b0.head === null, "no playhead until the pointer is over the clip");

  // Sound needs one earlier click or key press on the page (browser rule).
  await page.getByRole("heading", { name: "one.png" }).click();
  const box = (await page.locator(".shot video").first().boundingBox())!;
  const at = (fx: number) => [box.x + box.width * fx, box.y + box.height / 2] as const;
  await page.mouse.move(...at(0.5));
  await eventually("hovering unmutes that preview only; both keep playing", async () => {
    const [a, b] = await states();
    return !a!.muted && !a!.paused && b!.muted && !b!.paused;
  });

  await page.mouse.move(...at(0.8), { steps: 3 });
  const s = (await states())[0]!;
  // Mock clips run ~0.3 s past the requested 6 s, like fal's; the bar spans the requested 6 s.
  check(s.d > 6.2, `mock clip overruns the request (${s.d.toFixed(2)} s)`);
  check(s.paused && Math.abs(s.t - 0.8 * 6) < 0.3, `moving the pointer scrubs to that point of the requested length (t=${s.t.toFixed(2)}, paused=${s.paused})`);
  const b1 = await bar();
  check(b1.head !== null && Math.abs(b1.head - 0.8) < 0.1, `the black playhead follows the scrub along the green bar (${JSON.stringify(b1)})`);
  await eventually("after the pointer rests, playback continues from there with sound", async () => {
    const a = (await states())[0]!;
    return !a.paused && !a.muted && a.t >= 0.8 * 6 - 0.3;
  });

  await page.mouse.move(box.x + box.width + 400, box.y + box.height / 2);
  await eventually("leaving mutes it again; it keeps looping", async () => {
    const a = (await states())[0]!;
    return a.muted && !a.paused;
  });
  check((await bar()).head === null, "the playhead hides when the pointer leaves");

  await page.mouse.click(...at(0.5));
  await page.getByRole("dialog").waitFor();
  await eventually("clicking enlarges: the large clip loops with sound and the preview behind is silent", () =>
    page.evaluate(() => {
      const big = document.querySelector<HTMLVideoElement>(".lightbox video");
      const small = document.querySelector<HTMLVideoElement>(".shot video")!;
      return !!big && !big.paused && !big.muted && big.loop && small.muted;
    }),
  );
  await page.keyboard.press("Escape");
  eq(await page.getByRole("dialog").count(), 0, "Escape closes the enlarged view");

  // Space pauses the hovered preview and resumes it.
  await page.mouse.move(...at(0.3));
  await page.waitForTimeout(500);
  await page.keyboard.press(" ");
  await eventually("Space pauses the hovered preview", async () => (await states())[0]!.paused && (await page.getByText("Paused", { exact: true }).count()) === 1);
  await page.keyboard.press(" ");
  await eventually("Space resumes it", async () => !(await states())[0]!.paused);
});

// -----------------------------------------------------------------------------
// fal credits in the top bar (status and balance answers faked in the browser;
// nothing is sent to fal)
// -----------------------------------------------------------------------------

scenario("live mode shows fal credits in the top bar, with clear fallbacks", async ({ page, srv }) => {
  await makeFilm(srv, "Credits Film", "c.png");
  let balance: unknown = { state: "ok", balance: 24.5, currency: "USD", checkedAt: new Date().toISOString() };
  const balanceCalls: string[] = [];
  await page.route("**/api/status", async (route) => {
    const real = (await (await route.fetch()).json()) as { provider: Record<string, unknown> };
    real.provider = { id: "fal", label: "fal.ai", isMock: false, ready: true, reason: null };
    await route.fulfill({ json: real });
  });
  await page.route("**/api/fal/balance*", async (route) => {
    balanceCalls.push(new URL(route.request().url()).search);
    await route.fulfill({ json: balance });
  });
  await page.goto(srv.base);
  const chip = page.getByTestId("fal-credits");
  await chip.waitFor();
  const text = (await chip.textContent())?.trim() ?? "";
  check(/^fal\.ai · \S*24[.,]50\S* credits$/.test(text), `credits chip text (${text})`); // currency format follows the browser's locale
  check((await chip.getAttribute("title"))!.includes("billed to your fal account"), "tooltip keeps the paid-generation note");
  eq(await page.getByText("Mock mode · no charges").count(), 0, "no mock label in live mode");

  // Low balance is flagged; window focus asks for a fresh read.
  balance = { state: "ok", balance: 0.42, currency: "USD", checkedAt: new Date().toISOString() };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await eventually("low balance is flagged", async () => /0[.,]42\S* credits · low$/.test((await chip.textContent()) ?? ""));
  check(balanceCalls.includes("?refresh=1"), `focus requests a refresh (${balanceCalls})`);
  check(await chip.evaluate((el) => el.classList.contains("chip-low")), "low balance uses the warning style");

  // A key without billing permission: the chip says so and the tooltip explains the fix.
  balance = { state: "unavailable", needsBillingKey: true, message: "Your FAL_KEY can generate but can't read billing (HTTP 403). Set FAL_BILLING_KEY.", checkedAt: new Date().toISOString() };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await eventually("unavailable balance is shown as such", async () => ((await chip.textContent()) ?? "").includes("credits unavailable"));
  check((await chip.getAttribute("title"))!.includes("FAL_BILLING_KEY"), "tooltip explains how to enable credits");
});

scenario("workflow preserved: generate, drag-trim, timeline reorder, export", async ({ page, srv }) => {
  const film = "Workflow Film";
  await makeFilm(srv, film, "w1.png", "style");
  await page.goto(srv.base);
  await openFilm(page, srv, film, "w1.png");
  await shotBox(page, "w1.png").fill("first");
  await genButton(page, 4).click();
  let v = await waitForGenerations(srv, film, "w1.png", 4);
  for (let i = 0; i < 200; i++) {
    v = await getView(srv, film);
    if (v.state.shots["w1.png"]!.generations.every((g) => (g as { status?: string }).status === "completed")) break;
    await Bun.sleep(100);
  }
  await page.getByRole("button", { name: "Add to timeline" }).waitFor({ timeout: 15_000 });

  // Drag across the newest variation to trim it.
  const video = page.locator("article.shot video").first();
  await video.waitFor();
  const box = (await video.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Add to timeline" }).click();
  await page.getByRole("button", { name: "Previous variation" }).click();
  await page.getByRole("button", { name: "Add to timeline" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Move clip 2 earlier" }).click();
  await page.waitForTimeout(500);
  await page.getByLabel("Frame").selectOption("9:16");
  await page.waitForTimeout(500);

  type Full = { state: { timeline: { generationId: string }[]; shots: Record<string, { generations: { id: string; trim: { inSec: number; outSec: number } | null; output: { durationSec: number } | null; settings: { durationSec: number } }[] }> } };
  const full = (await getView(srv, film)) as unknown as Full;
  const gs = full.state.shots["w1.png"]!.generations;
  const trimmed = gs.filter((g) => g.trim);
  eq(trimmed.length, 1, "one trimmed variation");
  const t = trimmed[0]!.trim!;
  check(t.outSec - t.inSec > 1 && t.outSec - t.inSec < 3.5, `drag produced a plausible trim (${t.inSec}-${t.outSec})`);
  eq(full.state.timeline.length, 2, "two clips on the timeline");
  eq(full.state.timeline[1]!.generationId, trimmed[0]!.id, "reorder moved the trimmed clip to second place");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByText(/^Exported:/).waitFor({ timeout: 60_000 });
  const line = (await page.locator(".render-line").textContent()) ?? "";
  check(line.includes("810×1440"), `export is 9:16 (${line})`);
  const untrimmed = gs.find((g) => g.id === full.state.timeline[0]!.generationId)!;
  // An untrimmed clip contributes its requested length (mock clips, like fal's, run a little over).
  const expected = Math.min(untrimmed.output!.durationSec, untrimmed.settings.durationSec) + (t.outSec - t.inSec);
  const got = Number(/· ([\d.]+)s ·/.exec(line)?.[1]);
  check(Math.abs(got - expected) < 0.15, `export length ${got}s ≈ ${expected.toFixed(2)}s`);
});

// -----------------------------------------------------------------------------

async function main() {
  const filter = process.argv[2];
  const selected = scenarios.filter((s) => !filter || s.name.includes(filter));
  const srv = await startServer();
  const { browser, label } = await launchBrowser();
  console.log(`Browser: ${label} ${browser.version()} · server ${srv.base} (mock mode)\n`);
  const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
  try {
    for (const s of selected) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      const t0 = Date.now();
      try {
        await s.run({ page, srv });
        if (pageErrors.length) throw new Error(`Uncaught page errors: ${pageErrors.join(" | ")}`);
        results.push({ name: s.name, ok: true, ms: Date.now() - t0 });
        console.log(`(pass) ${s.name} [${Date.now() - t0}ms]`);
      } catch (err) {
        const msg = (err as Error).message.split("\n")[0]!;
        await page.screenshot({ path: `${process.env.SHOTLOOM_E2E_SHOTS ?? "tests/.tmp"}/fail-${results.length + 1}.png` }).catch(() => undefined);
        results.push({ name: s.name, ok: false, error: msg, ms: Date.now() - t0 });
        console.log(`(fail) ${s.name}\n       ${msg}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await srv.stop();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n ${results.length - failed} pass\n ${failed} fail\nRan ${results.length} browser scenarios.`);
  process.exit(failed ? 1 : 0);
}

await main();
