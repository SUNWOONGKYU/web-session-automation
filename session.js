// web-session-automation — engine (deterministic browser automation, no LLM)
//
// Attach over CDP to a dedicated automation Chrome (your own profile + remote debugging port),
// reuse its logged-in sessions, and: upload files / download artifacts / chat (post & read).
//
// Verbs:
//   status / tabs                            CDP connection, open tabs, per-site login (JSON)
//   download --out <dir> [--url <chat>] [--artifacts all|names|none] [--names "a|b|c"] [--text none|handoff|full|both] [--kakao] [--limit N]
//   upload   --file <path> [--url <chat>] [--input-index N] [--kakao]
//   youtube  --file <mp4> --title-file <path>|--title <s> [--desc-file <path>] [--visibility public|unlisted|private] [--publish] [--shot-dir <dir>]
//   chat     --site <chatgpt|gemini> --prompt-file <path> [--url <conversation URL>] [--out <file>] [--timeout <seconds>]
//   facebook status | stats --url <post> | insights --url <insights> | draft ... | schedule ...
//   agent    --goal "<plain-English goal>" [--url <start URL>] [--max-steps N] [--run-dir <dir>]
//            General-purpose LLM decision loop (your `claude` subscription session, no API key).
//            download/upload/chat retry through this automatically when their fixed path fails
//            structurally. Human-only actions (login/2FA, payment, deletion, e-signature,
//            CAPTCHA) are refused both by the prompt and, independently, in code.
//
// Verified know-how:
//   · Over connectOverCDP, CDP Browser.setDownloadBehavior conflicts with Playwright saveAs ('canceled').
//     → Listen to the Playwright 'download' event and call download.saveAs() to write the file.
//   · claude.ai artifact download buttons have aria-label ending in the download word (visible text is an icon font).
//   · For chat input, insert text via execCommand('insertText') to avoid keyboard.type '\n' early-submit.
//   · Collect the answer after it is stable and generation has finished.
//   · chat used to mis-report success. Three traps, all fixed:
//     1) Nothing verified the submit, so a failed insert/Enter still fell through to the
//        collector, which returned the PREVIOUS answer with ok:true. Submission is now
//        confirmed (new user message | emptied composer | generation started), and the
//        answer must differ from a baseline snapshot before ok can be true.
//     2) Message counts are unusable for that baseline — ChatGPT virtualises the DOM, so the
//        rendered message count does not grow monotonically. Compare the last answer's text.
//     3) ChatGPT reuses one submit button (#composer-submit-button) and flips its data-testid
//        between send-button and stop-button, so matching [data-testid="send-button"] alone
//        never finds it; generation state is read from that toggle too.
//   · Login cannot be inferred from the URL: signed out, the site still redirects to its root.
//     Check for a sign-in affordance on the page (SITES[*].loggedOut).
//
// Config via env:  CDP_URL (default http://localhost:9222) · PW_PATH (path to the playwright module if not resolvable)

const fs = require('fs');
const path = require('path');
const os = require('os');

function loadPlaywright() {
  const tries = ['playwright', process.env.PW_PATH].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) {} }
  throw new Error('playwright module not found. Run `npm i playwright` (and `npx playwright install chromium`), or set PW_PATH to the module path.');
}
const CDP = process.env.CDP_URL || 'http://localhost:9222';
const SUFFIX = '다운로드'; // claude.ai download-button aria-label suffix (Korean UI). Adjust for other locales.
const HANDOFF_KEYS = ['클로드 코드에게 전달', '전달 사항', '전달사항', 'Code에 줄', '핸드오프'];

function emit(o) { process.stdout.write(JSON.stringify(o, null, 1) + '\n'); }
function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; o[k] = v; }
    else o._.push(a);
  }
  return o;
}

// Site profiles for the `chat` verb — extend with more sites here.
const SITES = {
  chatgpt: {
    url: 'https://chatgpt.com/', input: '#prompt-textarea',
    answer: '[data-message-author-role="assistant"]',
    user: '[data-message-author-role="user"]',
    stop: '[data-testid="stop-button"]',
    submit: '#composer-submit-button, [data-testid="send-button"]',
    // Only present when signed out. A signed-out visit still lands on the root URL,
    // so the URL alone cannot tell you whether you are logged in.
    loggedOut: 'button:has-text("Log in"), button:has-text("로그인"), a[href*="/auth/login"]',
  },
  gemini: {
    url: 'https://gemini.google.com/app', input: 'div.ql-editor[contenteditable="true"]',
    answer: '.model-response-text, message-content',
    user: 'user-query, .query-text',
    stop: 'button[aria-label*="중지"], button[aria-label*="Stop"]',
    submit: 'button[aria-label*="Send"], button[aria-label*="보내기"], button.send-button',
    loggedOut: 'a[href*="ServiceLogin"], a[href*="accounts.google.com/signin"]',
  },
};

// Generating? Either the stop selector is present, or the submit button has toggled
// into its stop state. ChatGPT reuses one button (#composer-submit-button) and flips
// its data-testid between send-button and stop-button.
async function isGenerating(page, site) {
  try {
    if (await page.locator(site.stop).count() > 0) return true;
  } catch (e) {}
  try {
    return await page.evaluate(() => {
      const b = document.querySelector('#composer-submit-button');
      if (!b) return false;
      return b.getAttribute('data-testid') === 'stop-button'
        || /Stop|중지/i.test(b.getAttribute('aria-label') || '');
    });
  } catch (e) { return false; }
}

async function lastAnswer(page, site) {
  const n = await page.locator(site.answer).count();
  if (!n) return '';
  return (await page.locator(site.answer).nth(n - 1).innerText().catch(() => '')) || '';
}

// connectOverCDP can time out even when Chrome is fine — it's just momentarily busy (many tabs,
// heavy workers). A single long-timeout attempt used to be mistaken for "Chrome is dead" and led
// to restarting the browser (losing every logged-in tab) when simply retrying would have worked.
async function getCtx(pw, tries) {
  const attempts = tries || 4;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const b = await pw.chromium.connectOverCDP(CDP, { timeout: 20000 });
      const ctx = b.contexts()[0];
      if (!ctx) throw new Error('No browser context available');
      return { b, ctx };
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
  throw new Error(`CDP connect failed after ${attempts} attempts: ${String(lastErr && lastErr.message || lastErr).slice(0, 200)}`);
}
function findTab(ctx, re) { return ctx.pages().find(p => { try { return re.test(p.url()); } catch (e) { return false; } }); }
async function withBrowser(fn) {
  const pw = loadPlaywright();
  const { b, ctx } = await getCtx(pw);
  try { return await fn(ctx); } finally { try { await b.close(); } catch (e) {} }
}

// ───────────────────────── status / tabs ─────────────────────────
async function cmdStatus() {
  await withBrowser(async (ctx) => {
    const tabs = [];
    for (const p of ctx.pages()) {
      let url = '(err)', title = '(unknown)';
      try { url = p.url(); title = await p.title(); } catch (e) {}
      tabs.push({ url, title });
    }
    // Login state from the tab URL alone gives false positives: a signed-out visit is
    // redirected to the site root, which passes a /login|accounts|auth/ test. When a tab
    // for the site is open, check the page for a sign-in affordance instead.
    const logins = {};
    for (const [k, v] of Object.entries(SITES)) {
      const host = new URL(v.url).host;
      const pg = ctx.pages().find(p => { try { return p.url().includes(host); } catch (e) { return false; } });
      if (!pg) { logins[k] = null; continue; }   // null = no tab open, cannot tell
      if (/login|accounts|auth|signin|ServiceLogin/i.test(pg.url())) { logins[k] = false; continue; }
      if (v.loggedOut) {
        const out = await pg.locator(v.loggedOut).count().catch(() => 0);
        logins[k] = out === 0;
      } else logins[k] = true;
    }
    logins['claude.ai'] = tabs.some(t => /claude\.ai\/chat/.test(t.url));
    logins['business.kakao'] = tabs.some(t => /business\.kakao/.test(t.url) && !/login|accounts/i.test(t.url));
    emit({
      cdp: true, tab_count: tabs.length, tabs, logins,
      note: 'logins[site] === null means no tab for that site is open, so login state is unknown. true means a sign-in button was actually absent from the page.',
    });
  });
}

// ───────────────────────── handoff text extraction (claude.ai) ─────────────────────────
async function handoffText(pg) {
  const sels = ['.font-claude-message', 'div.font-claude-response', '[data-testid="assistant-message"]'];
  let blocks = [];
  for (const s of sels) {
    for (const el of await pg.$$(s)) { const t = ((await el.innerText().catch(() => '')) || '').trim(); if (t) blocks.push(t); }
    if (blocks.length) break;
  }
  for (let i = blocks.length - 1; i >= 0; i--) if (HANDOFF_KEYS.some(k => blocks[i].includes(k))) return blocks[i];
  if (blocks.length) return blocks[blocks.length - 1];
  const body = await pg.innerText('body');
  for (const k of HANDOFF_KEYS) { const idx = body.lastIndexOf(k); if (idx >= 0) return body.slice(Math.max(0, idx - 200), idx + 3000).trim(); }
  return '';
}

// ───────────────────────── download (claude.ai) ─────────────────────────
async function cmdDownload(o) {
  const OUT = o.out; if (!OUT || OUT === true) throw new Error('--out <dir> required');
  if (o.artifacts === undefined || o.artifacts === true) o.artifacts = 'all';
  if (o.text === undefined || o.text === true) o.text = 'none';
  fs.mkdirSync(OUT, { recursive: true });
  return withBrowser(async (ctx) => {
    // ── KakaoTalk Business chat: download files/videos via each message's save button (a.btn_save) ──
    if (o.kakao) {
      let kp = o.url && o.url !== true ? findTab(ctx, new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) : findTab(ctx, /\/chats?\//);
      if (!kp && o.url && o.url !== true) { kp = await ctx.newPage(); await kp.goto(o.url, { waitUntil: 'domcontentloaded' }); await kp.waitForTimeout(4000); }
      if (!kp) return { ok: false, error: 'KakaoTalk chat tab not found. Pass --url <chat URL> or open the chat in the automation Chrome.' };
      await kp.bringToFront(); await kp.waitForTimeout(1500);
      const kb = await kp.evaluate(() => document.body.innerText || '');
      if (/추가인증|탈퇴/.test(kb)) return { ok: false, blocked: true, reason: (kb.match(/추가인증|탈퇴/) || [])[0], hint: 'KakaoTalk admin re-auth required — handle in the browser yourself' };
      const res = { out: OUT, downloaded: [], failed: [], verify: {} };
      const dlP = [];
      kp.on('download', d => dlP.push(d.saveAs(path.join(OUT, d.suggestedFilename())).then(() => ({ file: d.suggestedFilename(), ok: true })).catch(e => ({ file: d.suggestedFilename(), ok: false, err: String(e).slice(0, 120) }))));
      const listK = () => fs.readdirSync(OUT).filter(f => !f.endsWith('.crdownload'));
      const beforeK = new Set(listK());
      const saves = await kp.$$('a.btn_save');
      const limit = o.limit && o.limit !== true ? parseInt(o.limit, 10) : saves.length;
      let clicked = 0;
      for (const el of saves.slice(0, limit)) {
        try { await el.scrollIntoViewIfNeeded(); await el.click(); clicked++; await kp.waitForTimeout(1500); }
        catch (e) { res.failed.push({ err: String(e).slice(0, 120) }); }
      }
      await kp.waitForTimeout(2500);
      const settledK = await Promise.all(dlP);
      for (const s of settledK) if (!s.ok) res.failed.push({ name: s.file, err: s.err });
      for (const f of listK().filter(f => !beforeK.has(f)).sort()) res.downloaded.push({ file: f, bytes: fs.statSync(path.join(OUT, f)).size });
      res.verify = { save_buttons: saves.length, clicked, new_files: res.downloaded.length, ok: res.downloaded.length > 0 && res.downloaded.every(d => d.bytes > 0) };
      fs.writeFileSync(path.join(OUT, '_result.json'), JSON.stringify(res, null, 2), 'utf-8');
      return res;
    }
    let page = o.url && o.url !== true ? findTab(ctx, new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) : findTab(ctx, /\/chat\//);
    if (!page) page = ctx.pages()[0];
    if (!page) return { ok: false, error: 'No claude.ai /chat/ tab found. Open a claude.ai session in the automation Chrome.' };
    await page.bringToFront();
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(250); }
    await page.waitForTimeout(600);
    const res = { out: OUT, downloaded: [], failed: [], text_saved: [], verify: {} };
    const want = (o.artifacts === 'names' && o.names && o.names !== true) ? new Set(String(o.names).split('|').filter(Boolean)) : null;
    // Over connectOverCDP, CDP setDownloadBehavior conflicts with Playwright saveAs ('canceled').
    // → Capture the Playwright 'download' event and write via download.saveAs().
    const dlPromises = [];
    page.on('download', d => {
      dlPromises.push(
        d.saveAs(path.join(OUT, d.suggestedFilename()))
          .then(() => ({ file: d.suggestedFilename(), ok: true }))
          .catch(e => ({ file: d.suggestedFilename(), ok: false, err: String(e).slice(0, 120) }))
      );
    });
    const listed = () => fs.readdirSync(OUT).filter(f => !f.endsWith('.crdownload'));
    const before = new Set(listed());
    let clicked = 0;
    if (o.artifacts !== 'none') {
      for (const el of await page.$$('button')) {
        const al = (await el.getAttribute('aria-label')) || '';
        if (!al.endsWith(SUFFIX)) continue;
        const nm = al.slice(0, -SUFFIX.length).trim();
        if (o.artifacts === 'all' || (want && want.has(nm))) {
          try { await el.scrollIntoViewIfNeeded(); await el.click(); clicked++; await page.waitForTimeout(1500); }
          catch (e) { res.failed.push({ name: nm, err: String(e).slice(0, 140) }); }
        }
      }
      await page.waitForTimeout(2500);
      const settled = await Promise.all(dlPromises);
      for (const s of settled) if (!s.ok) res.failed.push({ name: s.file, err: s.err });
    }
    for (const f of listed().filter(f => !before.has(f)).sort()) res.downloaded.push({ file: f, bytes: fs.statSync(path.join(OUT, f)).size });
    if (o.text === 'handoff' || o.text === 'both') {
      const t = await handoffText(page);
      if (t) { fs.writeFileSync(path.join(OUT, '_handoff.md'), t, 'utf-8'); res.text_saved.push({ file: '_handoff.md', bytes: Buffer.byteLength(t, 'utf-8') }); }
    }
    if (o.text === 'full' || o.text === 'both') {
      const full = await page.innerText('body');
      fs.writeFileSync(path.join(OUT, '_conversation.txt'), full, 'utf-8'); res.text_saved.push({ file: '_conversation.txt', bytes: Buffer.byteLength(full, 'utf-8') });
    }
    const zero = res.downloaded.filter(d => d.bytes === 0);
    let ok = zero.length === 0;
    if (o.artifacts !== 'none') ok = ok && res.downloaded.length > 0 && !(clicked > 0 && res.downloaded.length === 0);
    if (o.text !== 'none') ok = ok && res.text_saved.length > 0;
    res.verify = { clicked, new_files: res.downloaded.length, zero_byte: zero.length, text_files: res.text_saved.length, clicked_eq_files: clicked === res.downloaded.length, ok };
    fs.writeFileSync(path.join(OUT, '_result.json'), JSON.stringify(res, null, 2), 'utf-8');
    return res;
  });
}

// ───────────────────────── upload (e.g. KakaoTalk Business chat) ─────────────────────────
async function cmdUpload(o) {
  if (!o.file || o.file === true) throw new Error('--file <path> required (file to upload)');
  if (!fs.existsSync(o.file)) throw new Error('--file path does not exist: ' + o.file);
  return withBrowser(async (ctx) => {
    let page = o.url && o.url !== true ? findTab(ctx, new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) : findTab(ctx, /\/chats?\//);
    if (!page && o.url && o.url !== true) { page = await ctx.newPage(); await page.goto(o.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000); }
    if (!page) return { ok: false, error: 'Target chat tab not found. Pass --url <chat URL> or open the chat in the automation Chrome.' };
    await page.bringToFront(); await page.waitForTimeout(800);
    const pre = await page.evaluate(() => document.body.innerText || '');
    // --kakao: detect KakaoTalk Business blockers (admin re-auth expired / recipient withdrew). These need manual action by you.
    if (o.kakao && /추가인증|탈퇴|보낼 수 없습니다/.test(pre)) {
      return { ok: false, blocked: true, reason: (pre.match(/추가인증|탈퇴|보낼 수 없습니다/) || [])[0], hint: 'KakaoTalk admin re-auth / recipient withdrawn — handle in the browser yourself' };
    }
    const baseCancel = (pre.match(/취소/g) || []).length;          // upload-in-progress 'cancel' baseline (Kakao)
    const errRe = /업로드 실패|전송 실패|오류가 발생|failed|error/i;
    const idx = o['input-index'] && o['input-index'] !== true ? parseInt(o['input-index'], 10) : 0;
    await page.locator('input[type=file]').nth(idx).setInputFiles(o.file);
    let done = false, sawProgress = false, uploaded = false;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(3000);
      const t = await page.evaluate(() => document.body.innerText || '');
      if (/탈퇴|보낼 수 없습니다/.test(t)) return { ok: false, blocked: true, reason: 'cannot send (withdrawn/blocked)' };
      if (!pre.match(errRe) && errRe.test(t)) return { ok: false, error: 'upload/send error detected', detail: (t.match(errRe) || [])[0] };
      const cur = (t.match(/취소/g) || []).length;
      if (o.kakao) {
        if (cur > baseCancel) sawProgress = true;
        if (sawProgress && cur <= baseCancel) { done = true; uploaded = true; break; }
        if (!sawProgress && i >= 3) { done = true; uploaded = true; break; }   // instant upload
      } else if (i >= 2) { done = true; uploaded = true; break; }              // non-kakao: settle (verify via screenshot)
    }
    const shot = path.join(os.tmpdir(), 'websession_upload.png');
    await page.screenshot({ path: shot });
    return { ok: done, file: path.basename(o.file), uploaded, verify_hint: 'confirm delivery via the screenshot / received message', screenshot: shot };
  });
}

// ───────────────────────── youtube (YouTube Studio upload wizard) ─────────────────────────
// YouTube upload is a multi-step wizard, not a plain input[type=file], so the upload verb can't do it.
//   create -> upload video -> set file -> title/description -> not-for-kids -> next x3 -> visibility -> (publish)
// Safety: without --publish it stops right before publishing (screenshots). Do a dry run first.
// Note: some selectors target YouTube Studio's Korean UI text ("동영상 업로드"); adjust for other locales.
async function cmdYoutube(o) {
  // --publish-current: click only "Publish" on an already-open dialog left by a dry run (no re-upload). Two-step dry -> confirm -> publish.
  if (o['publish-current']) {
    const shotDir0 = (o['shot-dir'] && o['shot-dir'] !== true) ? o['shot-dir'] : os.tmpdir();
    fs.mkdirSync(shotDir0, { recursive: true });
    await withBrowser(async (ctx) => {
      const page = findTab(ctx, /studio\.youtube\.com/);
      if (!page) { emit({ ok: false, error: 'No studio.youtube.com tab found (an open upload dialog is required)' }); return; }
      await page.bringToFront(); await page.waitForTimeout(800);
      try { await page.locator('#done-button').first().click({ timeout: 15000 }); await page.waitForTimeout(4000); }
      catch (e) { try { await page.screenshot({ path: path.join(shotDir0, 'yt_err_publish.png') }); } catch (e2) {} emit({ ok: false, error: 'Publish click failed (the visibility-step dialog must be open): ' + String(e).slice(0, 120) }); return; }
      let videoUrl = '';
      try { videoUrl = (await page.locator('a[href*="youtu.be/"], a[href*="watch?v="]').first().getAttribute('href', { timeout: 8000 })) || ''; } catch (e) {}
      const pubShot = path.join(shotDir0, 'yt_published.png'); try { await page.screenshot({ path: pubShot }); } catch (e) {}
      emit({ ok: true, published: true, mode: 'publish-current', video_url: videoUrl, screenshot: pubShot });
    });
    return;
  }
  if (!o.file || o.file === true) throw new Error('--file <mp4> required');
  if (!fs.existsSync(o.file)) throw new Error('--file path does not exist: ' + o.file);
  const title = (o['title-file'] && o['title-file'] !== true) ? fs.readFileSync(o['title-file'], 'utf-8').trim()
              : (o.title && o.title !== true ? String(o.title) : '');
  if (!title) throw new Error('--title-file or --title required');
  const desc = (o['desc-file'] && o['desc-file'] !== true) ? fs.readFileSync(o['desc-file'], 'utf-8')
             : (o.desc && o.desc !== true ? String(o.desc) : '');
  const vis = (o.visibility && o.visibility !== true ? String(o.visibility) : 'private').toLowerCase();
  const VIS = { public: 'PUBLIC', unlisted: 'UNLISTED', private: 'PRIVATE' };
  if (!VIS[vis]) throw new Error('--visibility must be public|unlisted|private');
  const shotDir = (o['shot-dir'] && o['shot-dir'] !== true) ? o['shot-dir'] : os.tmpdir();
  fs.mkdirSync(shotDir, { recursive: true });
  const doPublish = !!o.publish;
  const oneLineTitle = title.replace(/\s*\n\s*/g, ' ').slice(0, 100); // YouTube title: single line, <=100 chars
  const steps = [];
  const shot = async (page, name) => { const p = path.join(shotDir, `yt_${name}.png`); try { await page.screenshot({ path: p }); } catch (e) {} return p; };

  await withBrowser(async (ctx) => {
    let page = findTab(ctx, /studio\.youtube\.com/);
    if (!page) { page = await ctx.newPage(); await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000); }
    await page.bringToFront(); await page.waitForTimeout(1500);
    if (/accounts\.google\.com|ServiceLogin|\/signin/i.test(page.url())) {
      emit({ ok: false, blocked: true, reason: 'Google/YouTube login required', hint: 'Log in to studio.youtube.com with the channel account in the automation Chrome, then retry', url: page.url() });
      return;
    }
    steps.push('studio_open');

    // 1) open the upload dialog (create -> upload video); fall back to /upload
    try {
      await page.locator('#create-icon, ytcp-button#create-icon').first().click({ timeout: 15000 });
      await page.waitForTimeout(1200);
      await page.locator('tp-yt-paper-item:has-text("동영상 업로드"), tp-yt-paper-item:has-text("업로드"), tp-yt-paper-item:has-text("Upload video")').first().click({ timeout: 8000 });
      await page.waitForTimeout(1500);
      steps.push('upload_dialog');
    } catch (e) {
      try { await page.goto('https://www.youtube.com/upload', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000); steps.push('upload_dialog_fallback'); }
      catch (e2) { await shot(page, 'err_open'); emit({ ok: false, error: 'Failed to open upload dialog: ' + String(e).slice(0, 120), steps }); return; }
    }

    // 2) set the file
    try {
      const fileInput = page.locator('input[type=file]').last();
      await fileInput.waitFor({ state: 'attached', timeout: 20000 });
      await fileInput.setInputFiles(o.file);
      steps.push('file_set');
    } catch (e) { await shot(page, 'err_file'); emit({ ok: false, error: 'File input failed: ' + String(e).slice(0, 140), steps }); return; }

    // 3) details dialog — title / description / audience
    try {
      await page.locator('#title-textarea #textbox').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
    } catch (e) { await shot(page, 'err_details'); emit({ ok: false, error: 'Details dialog did not appear: ' + String(e).slice(0, 120), steps }); return; }

    try { // title (clear the filename prefill, then type)
      const titleBox = page.locator('#title-textarea #textbox').first();
      await titleBox.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
      await page.evaluate((t) => document.execCommand('insertText', false, t), oneLineTitle);
      steps.push('title_set');
    } catch (e) { steps.push('title_fail:' + String(e).slice(0, 50)); }

    try { // description
      if (desc.trim()) {
        const descBox = page.locator('#description-textarea #textbox').first();
        await descBox.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
        await page.evaluate((t) => document.execCommand('insertText', false, t), desc);
        steps.push('desc_set');
      }
    } catch (e) { steps.push('desc_fail:' + String(e).slice(0, 50)); }

    try { // not made for kids
      await page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').first().click({ timeout: 8000 });
      steps.push('audience_set');
    } catch (e) { steps.push('audience_fail:' + String(e).slice(0, 50)); }

    await shot(page, 'details');
    await page.waitForTimeout(800);

    // 4) Next x3 (details -> elements -> checks -> visibility)
    for (let i = 0; i < 3; i++) {
      try { await page.locator('#next-button').first().click({ timeout: 10000 }); await page.waitForTimeout(1500); }
      catch (e) { steps.push(`next${i + 1}_fail:` + String(e).slice(0, 40)); }
    }
    steps.push('reached_visibility');

    // 5) visibility
    try {
      await page.locator(`tp-yt-paper-radio-button[name="${VIS[vis]}"]`).first().click({ timeout: 10000 });
      steps.push('visibility_' + vis);
    } catch (e) { steps.push('visibility_fail:' + String(e).slice(0, 50)); }
    const visShot = await shot(page, 'visibility');

    // 6) publish, or stop right before publishing (dry)
    if (!doPublish) {
      emit({ ok: true, published: false, mode: 'dry', file: path.basename(o.file), title: oneLineTitle, visibility: vis, steps,
        screenshot_details: path.join(shotDir, 'yt_details.png'), screenshot_visibility: visShot,
        note: 'Stopped before publishing (no --publish). Review the screenshots, then publish in the window or re-run with --publish.' });
      return;
    }
    try { await page.locator('#done-button').first().click({ timeout: 15000 }); await page.waitForTimeout(4000); }
    catch (e) { await shot(page, 'err_publish'); emit({ ok: false, error: 'Publish click failed: ' + String(e).slice(0, 120), steps }); return; }

    let videoUrl = '';
    try { videoUrl = (await page.locator('a[href*="youtu.be/"], a[href*="watch?v="]').first().getAttribute('href', { timeout: 8000 })) || ''; } catch (e) {}
    const pubShot = await shot(page, 'published');
    emit({ ok: true, published: true, file: path.basename(o.file), title: oneLineTitle, visibility: vis, video_url: videoUrl, steps, screenshot: pubShot });
  });
}

// ───────────────────────── chat (chatgpt/gemini) ─────────────────────────
async function cmdChat(o) {
  const site = SITES[o.site]; if (!site) throw new Error('--site must be chatgpt|gemini');
  const prompt = (o['prompt-file'] && o['prompt-file'] !== true) ? fs.readFileSync(o['prompt-file'], 'utf-8') : (o.prompt && o.prompt !== true ? o.prompt : '');
  if (!prompt) throw new Error('--prompt-file <path> or --prompt <text> required');
  const timeoutMs = (parseInt(o.timeout, 10) || 420) * 1000;
  return withBrowser(async (ctx) => {
    // Target tab: --url picks a specific conversation, otherwise any tab on the site, otherwise open one.
    let page = null;
    if (o.url && o.url !== true) {
      const re = new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      page = findTab(ctx, re);
      if (!page) { page = await ctx.newPage(); await page.goto(o.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000); }
    }
    if (!page) page = findTab(ctx, new RegExp(new URL(site.url).host.replace(/\./g, '\\.')));
    if (!page) { page = await ctx.newPage(); await page.goto(site.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000); }
    await page.bringToFront(); await page.waitForTimeout(1500);

    // Login: the URL alone is not enough (a signed-out visit redirects to the root), so
    // also look for a sign-in affordance on the page.
    if (/login|accounts|auth|signin|ServiceLogin/i.test(page.url())) return { ok: false, blocked: true, reason: 'login required', site: o.site, url: page.url() };
    if (site.loggedOut && await page.locator(site.loggedOut).count().catch(() => 0) > 0) {
      return { ok: false, blocked: true, reason: 'login required — sign in to this site once in the automation Chrome, then retry (this tool never types credentials)', site: o.site, url: page.url() };
    }
    // If --url was given but we did not land on it, stop. Never silently write the prompt
    // into a different or brand-new conversation.
    // NOTE: comparing the URL is not sufficient (observed): navigating to a non-existent
    // conversation id can leave /c/<id> in the address bar while rendering an EMPTY new chat,
    // which passes a URL check. Decide reachability by conversation history instead — an
    // existing conversation always has at least one message.
    if (o.url && o.url !== true) {
      const id = String(o.url).split('?')[0].split('/').pop();
      const urlOk = !id || page.url().includes(id);
      const msgs = (await page.locator(site.user).count().catch(() => 0))
                 + (await page.locator(site.answer).count().catch(() => 0));
      const needHistory = /\/c\//.test(String(o.url));   // an existing-conversation URL was given
      if (!urlOk || (needHistory && msgs === 0)) {
        return {
          ok: false, blocked: true,
          reason: 'requested conversation is not reachable (different account, deleted, or empty); refused to post into another conversation',
          want: o.url, got: page.url(), messages_found: msgs,
        };
      }
    }

    // Baseline. Message counts are not usable: ChatGPT virtualises the DOM, so the number of
    // rendered messages does not grow monotonically. Use the text of the last answer instead.
    const baseUser = await page.locator(site.user).count().catch(() => 0);
    const prevAnswer = await lastAnswer(page, site);

    // Insert the prompt and verify it actually landed.
    const input = page.locator(site.input).first();
    await input.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.evaluate((t) => document.execCommand('insertText', false, t), prompt);
    await page.waitForTimeout(800);
    const typed = await input.innerText().catch(() => '');
    if (typed.length < Math.min(200, Math.floor(prompt.length * 0.5))) {
      return { ok: false, reason: 'failed to insert the prompt into the composer', typed_len: typed.length, prompt_len: prompt.length, site: o.site };
    }

    // Submit, then verify. Evidence: a new user message, an emptied composer, or generation started.
    const submittedEvidence = async () => {
      if (await page.locator(site.user).count().catch(() => 0) > baseUser) return 'user-count';
      if (await isGenerating(page, site)) return 'generating';
      const empty = await input.innerText().then(t => t.trim().length === 0).catch(() => false);
      if (empty) return 'composer-empty';
      return null;
    };
    let submitted = null;
    for (const how of ['enter', 'button']) {
      if (how === 'enter') await page.keyboard.press('Enter');
      else {
        const btn = page.locator(site.submit).first();
        if (await btn.count().catch(() => 0)) await btn.click({ timeout: 5000 }).catch(() => {});
      }
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(1000);
        const ev = await submittedEvidence();
        if (ev) { submitted = how + ':' + ev; break; }
      }
      if (submitted) break;
    }
    if (!submitted) {
      return { ok: false, reason: 'submit failed — no sign the prompt was sent (tried Enter and the send button)', site: o.site };
    }

    // Wait for a NEW answer: different from the baseline, generation finished, length stable.
    const t0 = Date.now();
    let text = '', lastLen = -1, stable = 0, appeared = false;
    while (Date.now() - t0 < timeoutMs) {
      await page.waitForTimeout(2500);
      const cur = await lastAnswer(page, site);
      if (cur && cur !== prevAnswer) { appeared = true; text = cur; }
      const gen = await isGenerating(page, site);
      if (appeared && !gen && text.length === lastLen) { if (++stable >= 4) break; } else stable = 0;
      lastLen = text.length;
    }

    if (o.out && o.out !== true && text) fs.writeFileSync(o.out, text, 'utf-8');
    // ok is true only for a NEW answer. Never report the previous answer as a fresh one.
    return {
      ok: appeared && text.length > 0,
      new_answer: appeared,
      site: o.site,
      submitted_by: submitted,
      chars: text.length,
      elapsed_sec: Math.round((Date.now() - t0) / 1000),
      out: (o.out && o.out !== true) ? o.out : null,
      answer_preview: text.slice(0, 400),
      ...(appeared ? {} : { reason: 'submitted, but no new answer within the timeout — raise --timeout or check the browser' }),
    };
  });
}

// ───────────────────────── facebook (personal profile: read stats / save draft / schedule) ─────────────────────────
// facebook status
// facebook stats    --url <post URL> [--shot-dir <dir>]
// facebook insights --url <content/insights URL> [--shot-dir <dir>]
// facebook draft    --text-file <path> [--image <path>] [--url <fb URL>] [--shot-dir <dir>]
// facebook schedule --text-file <path> [--image <path>] --date "Jul 23, 2026" --time "11:00 AM" [--url] [--shot-dir]
//
// FB-specific traps and how this handles them (verified in practice):
//  · On a personal profile, "text + image draft" is NOT saved by just closing the composer (the image only
//    uploads at post time) → you must go through Next → Save.
//  · FB mounts several composer dialogs at once and state fragments across them → reload first, then finish
//    the whole flow atomically in one process.
//  · Scheduling: real clicks on the date/time fields get eaten by the calendar overlay → JS focus + keyboard
//    type + Tab, and only commit once the values read back exactly.
//  · Confirm buttons are matched by exact text ("Save" / "Schedule for later" / "Schedule").
//    "Post" is never clicked automatically — that would publish immediately.
//  · Where to manage results: Dashboard → Content → Content Library → Scheduled / Draft tabs.
//  · Selectors assume the English UI; some regex also accept the Korean strings.
async function cmdFacebook(o) {
  const mode = o._[0];
  const shotDir = (o['shot-dir'] && o['shot-dir'] !== true) ? o['shot-dir'] : os.tmpdir();
  try { fs.mkdirSync(shotDir, { recursive: true }); } catch (e) {}
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await withBrowser(async (ctx) => {
    let page = ctx.pages().find(p => /facebook\.com/.test(p.url()));
    if (!page) { page = await ctx.newPage(); await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }); }
    await page.bringToFront().catch(() => {});
    const shot = async (name) => { try { await page.screenshot({ path: path.join(shotDir, 'fb_' + name + '.png') }); } catch (e) {} };
    const clickExact = (label) => page.evaluate(l => { const btn = [...document.querySelectorAll('[role="dialog"] [role="button"]')].find(x => (x.innerText || '').trim() === l && x.offsetParent !== null); if (btn) { btn.click(); return true; } return false; }, label);

    if (mode === 'status') {
      const st = await page.evaluate(() => ({
        loggedIn: !document.querySelector('input[name="email"],input[type="password"]'),
        hasComposer: [...document.querySelectorAll('[role="button"]')].some(e => /What's on your mind|무슨 생각/.test(e.textContent || '')),
      }));
      return emit({ ok: true, url: page.url(), ...st });
    }

    if (mode === 'stats') {
      const url = (o.url && o.url !== true) ? o.url : null;
      if (!url) return emit({ ok: false, error: 'facebook stats requires --url <post URL>' });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4500);
      // The post opens in a dialog and the metric bar sits below the body — scroll the inner container to load it.
      await page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const dlg = [...document.querySelectorAll('[role="dialog"]')].filter(d => d.offsetParent !== null).pop();
        const scroller = dlg ? [...dlg.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 80) : null;
        for (let i = 0; i < 8; i++) { if (scroller) scroller.scrollTop += scroller.clientHeight * 0.8; else window.scrollBy(0, 600); await sleep(450); }
      });
      await sleep(1200);
      await shot('stats');
      const num = (s) => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KMB만천]?)/); if (!m) return null; let v = parseFloat(m[1]); const u = m[2]; if (u === 'K') v *= 1e3; else if (u === 'M') v *= 1e6; else if (u === 'B') v *= 1e9; else if (u === '천') v *= 1e3; else if (u === '만') v *= 1e4; return Math.round(v); };
      const raw = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const pick = (re) => { const m = body.match(re); return m ? m[1] : null; };
        const labels = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(Boolean);
        const lbl = (re) => { for (const l of labels) { const m = l.match(re); if (m) return m[1]; } return null; };
        // Reactions: sum the reaction-breakdown tooltips ("Like: 8 people", "Love: 1 person"), de-duplicated.
        let reactSum = 0, reactHit = false; const seenR = new Set();
        for (const l of [...new Set(labels)]) { const m = l.match(/:\s*([\d,]+)\s*(?:people|person|명)/i); if (m && !seenR.has(l)) { seenR.add(l); reactSum += parseInt(m[1].replace(/,/g, ''), 10); reactHit = true; } }
        return {
          views: pick(/([\d.,]+\s*[KMB만천]?)\s*(?:views|조회)/i) || lbl(/([\d.,]+\s*[KMB만천]?)\s*(?:views|조회)/i),
          reactions: reactHit ? String(reactSum) : (lbl(/(?:All reactions?|모든 반응):?\s*([\d.,]+\s*[KMB만천]?)/i)),
          comments: pick(/([\d.,]+\s*[KMB만천]?)\s*(?:comments?|댓글)/i) || lbl(/([\d.,]+)\s*comments?/i),
          shares: pick(/([\d.,]+\s*[KMB만천]?)\s*(?:shares?|공유)/i) || lbl(/([\d.,]+)\s*shares?/i),
          loggedIn: !document.querySelector('input[name="email"],input[type="password"]'),
        };
      });
      const out = { views: num(raw.views), reactions: num(raw.reactions), comments: num(raw.comments), shares: num(raw.shares) };
      const engagement = (out.reactions || 0) + (out.comments || 0) + (out.shares || 0);
      const got = out.views != null || out.reactions != null || out.comments != null || out.shares != null;
      const ok = raw.loggedIn && got;
      return emit({ ok, mode: 'stats', url, ...out, engagement, viewsAvailable: out.views != null, raw, loggedIn: raw.loggedIn, checkedAt: new Date().toISOString(), shot: path.join(shotDir, 'fb_stats.png'), note: ok ? (out.views != null ? 'scraped, views included' : 'views not shown (personal profile) → track reactions/comments/shares instead. Check fb_stats.png') : (raw.loggedIn ? 'no metrics found — check fb_stats.png' : 'login required — log in to facebook.com in the automation Chrome') });
    }

    if (mode === 'insights') {
      const url = (o.url && o.url !== true) ? o.url : null;
      if (!url) return emit({ ok: false, error: 'facebook insights requires --url <content/insights URL>' });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      // Wait for the insights content to render (Meta splash → render). Poll up to ~30s for "Views".
      let insReady = false;
      for (let i = 0; i < 30; i++) { await sleep(1000); insReady = await page.evaluate(() => { const t = document.body.innerText || ''; return /(^|\n)Views(\n|$)/.test(t) || /조회수|조회 수/.test(t); }); if (insReady) break; }
      await sleep(1500);
      await page.evaluate(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 6; i++) { window.scrollBy(0, 900); await sleep(500); } window.scrollTo(0, 0); await sleep(300); });
      await sleep(1500);
      await shot('insights');
      const d = await page.evaluate(() => {
        const lines = (document.body.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const idx = t => lines.findIndex(l => l === t);
        const N = s => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/^([\d.]+)$/); return m ? parseFloat(m[1]) : null; };
        const after = (t, k = 4) => { const i = idx(t); if (i < 0) return null; for (let j = i + 1; j < Math.min(i + k, lines.length); j++) { const v = N(lines[j]); if (v != null) return v; } return null; };
        const before = (t, k = 4) => { const i = idx(t); if (i < 0) return null; for (let j = i - 1; j >= Math.max(0, i - k); j--) { const v = N(lines[j]); if (v != null) return v; } return null; };
        let reactByType = null; const ri = idx('Reaction by type');
        if (ri >= 0) { const nums = []; for (let j = ri + 1; j < lines.length && nums.length < 7; j++) { const v = N(lines[j]); if (v != null) nums.push(v); } if (nums.length >= 2) reactByType = { like: nums[0], love: nums[1], care: nums[2], haha: nums[3], wow: nums[4], sad: nums[5], angry: nums[6] }; }
        const age = {}; for (let i = 0; i < lines.length; i++) { if (/^\d{2}-\d{2}$|^65\+$|^18-24$/.test(lines[i])) { const m = (lines[i + 1] || '').match(/^([\d.]+)%$/); if (m) age[lines[i]] = parseFloat(m[1]); } }
        return {
          views: after('Views'), viewers: after('Viewers'),
          reactions: before('Reactions'), clicks: before('Clicks'), comments: before('Comments'), shares: before('Shares'),
          linkClicks: before('Link clicks'), followers: before('Followers'), nonFollowers: before('Non-followers'),
          reactByType, age, loggedIn: !document.querySelector('input[name="email"],input[type="password"]'),
        };
      });
      const eng = (d.reactions || 0) + (d.clicks || 0) + (d.comments || 0) + (d.shares || 0);
      const ok = d.loggedIn && d.views != null;
      return emit({ ok, mode: 'insights', url, ...d, engagement: eng, checkedAt: new Date().toISOString(), shot: path.join(shotDir, 'fb_insights.png'), note: ok ? 'insights scraped' : (d.loggedIn ? 'no metrics found — check fb_insights.png (layout may have changed)' : 'login required') });
    }

    if (mode !== 'draft' && mode !== 'schedule') return emit({ ok: false, error: 'facebook mode must be status|stats|insights|draft|schedule', got: mode || '(none)' });

    const textFile = o['text-file'];
    if (!textFile || textFile === true) return emit({ ok: false, error: '--text-file <path> required' });
    const text = fs.readFileSync(textFile, 'utf8').replace(/\r\n/g, '\n').trim();

    // 1) Reload so we start from a single, unfragmented composer state
    await page.goto((o.url && o.url !== true) ? o.url : 'https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(3500);
    // 2) Open the composer
    const opened = await page.evaluate(() => { const t = [...document.querySelectorAll('[role="button"]')].find(e => /What's on your mind|무슨 생각/.test(e.textContent || '')); if (t) { t.click(); return true; } return false; });
    if (!opened) return emit({ ok: false, error: 'composer trigger not found — check that the automation Chrome is logged in to Facebook' });
    await sleep(2500);
    // 3) Type the body
    const ed = page.locator('div[contenteditable="true"][role="textbox"]').first();
    await ed.click(); await sleep(300);
    await page.keyboard.insertText(text); await sleep(800);
    const textLen = await ed.innerText().then(t => t.length).catch(() => 0);
    // 4) Attach an image (optional)
    let blob = 0;
    if (o.image && o.image !== true) {
      await page.locator('input[type="file"]').nth(1).setInputFiles(o.image);
      for (let i = 0; i < 12; i++) { await sleep(800); blob = await page.evaluate(() => document.querySelectorAll('[role="dialog"] img[src^="blob:"]').length); if (blob) break; }
    }
    await shot('staged');
    // 5) Next → Post settings
    await page.evaluate(() => { const ds = [...document.querySelectorAll('[role="dialog"]')].filter(d => d.offsetParent !== null); const s1 = ds.find(d => [...d.querySelectorAll('[role="button"]')].some(x => (x.innerText || '').trim() === 'Add to your post')); const nx = s1 && [...s1.querySelectorAll('[role="button"]')].find(x => (x.innerText || '').trim() === 'Next' && x.offsetParent !== null); if (nx) nx.click(); });
    await sleep(2800);

    if (mode === 'draft') {
      const saved = await clickExact('Save'); await sleep(3500);
      await shot('draft_done');
      const ok = await page.evaluate(() => /saved as a draft|임시 보관|draft/i.test(document.body.innerText));
      return emit({ ok, mode: 'draft', textLen, imageStaged: blob > 0, savedClicked: saved, note: ok ? 'draft saved (check Content Library → Drafts)' : 'no draft confirmation toast — verify manually' });
    }

    // mode === 'schedule'
    const date = (o.date && o.date !== true) ? o.date : null;
    const time = (o.time && o.time !== true) ? o.time : null;
    if (!date || !time) return emit({ ok: false, error: 'schedule requires --date "Jul 23, 2026" --time "11:00 AM"' });
    await page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while (n = w.nextNode()) { if (n.textContent.trim() === 'Scheduling options') { let el = n.parentElement; for (let i = 0; i < 8 && el; i++) { if ((el.getAttribute && el.getAttribute('role') === 'button') || el.tabIndex >= 0) { el.click(); return; } el = el.parentElement; } n.parentElement.click(); return; } } });
    await sleep(2600);
    const setInput = async (m, val) => { const h = await page.evaluateHandle(mm => { const i = [...document.querySelectorAll('[role="dialog"] input')].find(x => new RegExp(mm).test(x.value || '')); if (i) i.focus(); return i || null; }, m); if (!h.asElement()) return; await sleep(250); await page.keyboard.press('Control+A'); await sleep(120); await page.keyboard.press('Delete'); await sleep(120); await page.keyboard.type(val, { delay: 60 }); await sleep(350); await page.keyboard.press('Tab'); await sleep(500); };
    await setInput('202\\d', date); await sleep(400);
    await setInput('(AM|PM)', time); await sleep(700);
    const vals = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input')].filter(i => /202\d|AM|PM/.test(i.value || '')).map(i => i.value));
    const nDialogs = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input')].filter(i => /202\d/.test(i.value || '')).length);
    await shot('schedule_pre');
    const norm = s => s.replace(/\s/g, '').toUpperCase();
    const dateOK = vals.some(v => norm(v) === norm(date));
    const timeOK = vals.some(v => norm(v) === norm(time));
    if (!(dateOK && timeOK && nDialogs === 1)) return emit({ ok: false, mode: 'schedule', error: 'date/time did not set cleanly — aborting before commit', vals, nDialogs });
    const commit = await clickExact('Schedule for later'); await sleep(2500);
    const finalize = await clickExact('Schedule'); await sleep(4500);
    await shot('schedule_done');
    const ok = await page.evaluate(() => /Your post is scheduled|예약/i.test(document.body.innerText));
    return emit({ ok, mode: 'schedule', date, time, textLen, imageStaged: blob > 0, commit, finalize, note: ok ? 'scheduled (check Content Library → Scheduled)' : 'no scheduling confirmation — verify in Content Library → Scheduled' });
  });
}

// ───────────────────────── agent (general-purpose LLM decision loop) ─────────────────────────
// The verbs above are "fixed" — deterministic, hand-built for one site's DOM, fast, free. The
// `agent` verb is the opposite: it looks at the screen and decides the next action itself, one
// step at a time, so it can handle a site it has never seen before from a plain-English goal.
// It never uses an API key — it shells out to the locally installed `claude` CLI (your existing
// subscription session), so a step costs whatever your normal Claude Code usage costs, nothing more.
//
// Five categories of action are for a human only — logging in, identity verification / signing a
// certificate, CAPTCHAs, payments, and any irreversible final confirmation (submit an application,
// finalize a purchase, delete an account). The prompt tells the model to stop itself, and the code
// enforces it a second time regardless of what the model decides (SENSITIVE_RE below, plus a hard
// refusal on any `input[type=password]`).

const SENSITIVE_RE = /password|비밀번호|pay|checkout|purchase|구매\s*확정|결제|송금|wire\s*transfer|계좌\s*이체|submit application|신청\s*완료|final(?:ize)?\s*submit|제출하기|sign(?:ature)?|서명|verify\s*identity|본인\s*인증|공동인증서|captcha|캡차|otp|delete\s*account|영구\s*삭제|탈퇴하기|close\s*account|해지하기/i;

function resolveClaudeExe() {
  if (process.env.CLAUDE_EXE_PATH && fs.existsSync(process.env.CLAUDE_EXE_PATH)) return { exe: process.env.CLAUDE_EXE_PATH, shell: false };
  try {
    const where = require('child_process').execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { encoding: 'utf-8' });
    const candidates = where.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const cmdPath = candidates.find(s => /\.cmd$/i.test(s));
    if (cmdPath && fs.existsSync(cmdPath)) {
      // On Windows the npm shim is a .cmd batch file; going through it via a shell can mangle a
      // multi-line --json-schema argument. Resolve the real .exe it wraps and call that directly.
      const body = fs.readFileSync(cmdPath, 'utf-8');
      const m = body.match(/"%dp0%([^"]+\.exe)"/i);
      if (m) { const exe = path.join(path.dirname(cmdPath), m[1]); if (fs.existsSync(exe)) return { exe, shell: false }; }
    }
    if (candidates[0]) return { exe: candidates[0], shell: process.platform === 'win32' };
  } catch (e) {}
  return { exe: 'claude', shell: process.platform === 'win32' };
}

// One decision call — prompt via stdin, output forced to JSON via --json-schema.
function decide(dir, schema, promptText) {
  const { exe, shell } = resolveClaudeExe();
  const schemaStr = JSON.stringify(schema); // single line — safe even through a shell fallback
  const cliArgs = ['-p', '--allowedTools', 'Read', '--add-dir', dir, '--output-format', 'json', '--json-schema', schemaStr];
  const r = require('child_process').spawnSync(exe, cliArgs, { encoding: 'utf-8', input: promptText, maxBuffer: 20 * 1024 * 1024, shell });
  if (r.error) throw new Error('failed to run claude: ' + r.error.message);
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ` + String(r.stderr || '').slice(0, 300));
  let outer;
  try { outer = JSON.parse(r.stdout); } catch (e) { throw new Error('failed to parse claude output: ' + String(r.stdout).slice(0, 300)); }
  if (outer.is_error) throw new Error('claude error: ' + String(outer.result || '').slice(0, 300));
  return outer.structured_output || JSON.parse(outer.result);
}

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', description: 'one line: why this action' },
    action: { type: 'string', enum: ['click', 'type', 'select', 'attach_file', 'scroll', 'navigate', 'extract', 'done', 'blocked'] },
    target_index: { type: ['integer', 'null'], description: 'the i value from elements.json (target for click/type/select/attach_file); null otherwise' },
    value: { type: ['string', 'null'], description: 'type: text to type. select: one of the option texts. navigate: a URL. scroll: up|down. extract/done/blocked: the result or reason' },
  },
  required: ['reasoning', 'action', 'target_index', 'value'],
};

// Tags every candidate element with data-agent-i so 'select' and 'attach_file' can re-locate the
// exact node later — coordinate clicks can't drive a native <select> popup or a file chooser.
async function collectElements(page) {
  return page.evaluate(() => {
    const sel = 'button, a, input, textarea, select, [role="button"], [contenteditable="true"]';
    return Array.from(document.querySelectorAll(sel)).slice(0, 150).map((el, i) => {
      el.setAttribute('data-agent-i', String(i));
      const r = el.getBoundingClientRect();
      const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 60);
      const tag = el.tagName.toLowerCase();
      const options = tag === 'select' ? Array.from(el.options).slice(0, 30).map(o => o.text.trim().slice(0, 40)) : null;
      return { i, tag, type: el.getAttribute('type') || null, text, options, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }).filter(e => e.w > 0 && e.h > 0 && e.y >= -50 && e.y < 20000);
  });
}

function buildPrompt(goal, history, shotPath, elPath, attachFile) {
  const histTxt = history.length
    ? history.map(h => `- [${h.step}] ${h.action}(i=${h.target_index}) -> ${h.reasoning}${h.result ? ' | result: ' + h.result : ''}`).join('\n')
    : '(none — first step)';
  return [
    `Goal: ${goal}`, ``,
    `Steps so far:`, histTxt, ``,
    `Current screenshot: ${shotPath}`,
    `Current interactive elements (JSON, i = index for click/type/select/attach_file): ${elPath}`, ``,
    `Read both files, then output exactly one next action per the JSON schema.`, ``,
    `Rules (never violate):`,
    `- If you hit anything a human must do themselves — login, password entry, identity`,
    `  verification / e-signature certificates, CAPTCHA, payment, wire transfer, a final`,
    `  "confirm purchase / submit application / delete account" step — do not click or type it.`,
    `  Stop with action:"blocked" and explain why in value.`,
    `- Never click a payment/delete/confirmation button unrelated to the goal.`,
    `- For a "select" (dropdown) element, don't click/type it — use action:"select" with value set`,
    `  to one of its options' text verbatim.`,
    attachFile ? `- A file is already staged (${attachFile}). When you find the file-attach input,` : null,
    attachFile ? `  use action:"attach_file" — the real path is supplied by the system, value can be empty.` : null,
    `- If the goal is already achieved, use action:"done"; if you found the requested info, use`,
    `  action:"extract" with the result in value.`,
    `- If the goal is open-ended ("find the best/most/all of X"), you may run out of steps —`,
    `  when you're reasonably confident, extract/done early rather than exhausting the budget.`,
    `- If an action doesn't change the screen when repeated, try something else or stop as blocked.`,
  ].filter(Boolean).join('\n');
}

// ── graduation tracking: when `agent` keeps succeeding on the same host, it's worth writing a
// dedicated fixed verb for it. This only counts and recommends — it never rewrites session.js
// itself, since that's still a code change a human should review. ──
const GRAD_LOG_PATH = path.join(__dirname, 'graduation_log.json');
const GRADUATION_THRESHOLD = 3;
function recordAgentRun(host, goal, ok) {
  if (!host) return null;
  let log = {};
  try { log = JSON.parse(fs.readFileSync(GRAD_LOG_PATH, 'utf-8')); } catch (e) {}
  if (!log[host]) log[host] = [];
  log[host].push({ goal: String(goal || '').slice(0, 80), ok: !!ok, at: Date.now() });
  if (log[host].length > 50) log[host] = log[host].slice(-50);
  fs.writeFileSync(GRAD_LOG_PATH, JSON.stringify(log, null, 1), 'utf-8');
  const successCount = log[host].filter(e => e.ok).length;
  const candidate = successCount >= GRADUATION_THRESHOLD;
  return {
    host, success_count: successCount, total_runs: log[host].length, graduation_candidate: candidate,
    note: candidate
      ? `agent has succeeded ${successCount}x on this host — consider writing a dedicated fixed verb for it`
      : `${host}: ${successCount}/${GRADUATION_THRESHOLD} successes (${GRADUATION_THRESHOLD - successCount} more to become a graduation candidate)`,
  };
}

async function cmdAgent(o) {
  const goal = (o.goal && o.goal !== true) ? String(o.goal) : null;
  if (!goal) throw new Error('--goal "<plain-English goal>" required');
  const maxSteps = o['max-steps'] && o['max-steps'] !== true ? parseInt(o['max-steps'], 10) : 25;
  const runDir = (o['run-dir'] && o['run-dir'] !== true) ? o['run-dir'] : path.join(os.tmpdir(), 'websession_agent_' + Date.now());
  fs.mkdirSync(runDir, { recursive: true });
  const attachFile = (o['attach-file'] && o['attach-file'] !== true) ? o['attach-file'] : null;
  if (attachFile && !fs.existsSync(attachFile)) throw new Error('--attach-file path does not exist: ' + attachFile);

  const pw = loadPlaywright();
  const { b, ctx } = await getCtx(pw);
  const history = [];
  let stopped = null, stopValue = null;
  try {
    let page = null;
    let openedNewTab = false;
    if (o.url && o.url !== true) {
      page = findTab(ctx, new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      if (!page) { page = await ctx.newPage(); openedNewTab = true; await page.goto(o.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); }
    } else {
      page = ctx.pages()[ctx.pages().length - 1];
      if (!page) throw new Error('no open tab and no --url given');
    }
    await page.bringToFront();

    const downloads = [];
    const dlPromises = [];
    page.on('download', d => {
      dlPromises.push(
        d.saveAs(path.join(runDir, d.suggestedFilename()))
          .then(() => downloads.push({ file: d.suggestedFilename(), ok: true }))
          .catch(e => downloads.push({ file: d.suggestedFilename(), ok: false, err: String(e).slice(0, 120) }))
      );
    });

    for (let step = 1; step <= maxSteps; step++) {
      await page.waitForTimeout(600);
      const shotPath = path.join(runDir, `step${step}.png`);
      const elPath = path.join(runDir, `step${step}_elements.json`);
      await page.screenshot({ path: shotPath });
      const elements = await collectElements(page);
      fs.writeFileSync(elPath, JSON.stringify(elements, null, 1), 'utf-8');

      const prompt = buildPrompt(goal, history, shotPath, elPath, attachFile);
      let decision;
      try { decision = decide(runDir, AGENT_SCHEMA, prompt); }
      catch (e) { stopped = 'error'; stopValue = String(e.message || e).slice(0, 300); break; }

      // Hard guard, independent of what the model decided: elements are matched by their `i`
      // property, NOT array position (the array is filtered, so positions shift).
      const target = (decision.target_index !== null && decision.target_index !== undefined) ? elements.find(e => e.i === decision.target_index) : null;
      if (decision.action === 'click' || decision.action === 'type' || decision.action === 'select') {
        const sensitiveText = target && SENSITIVE_RE.test(target.text || '');
        const isPassword = target && target.type === 'password';
        if (!target || sensitiveText || isPassword) {
          history.push({ step, action: 'blocked', target_index: decision.target_index, reasoning: 'sensitive_action_guard', result: isPassword ? 'password field — never entered on your behalf' : (sensitiveText ? `looks like a human-only action ("${target.text}")` : 'target element not found') });
          stopped = 'blocked_sensitive';
          stopValue = isPassword ? 'password field detected — credentials are never entered automatically' : (sensitiveText ? `human-only action detected: "${target.text}"` : "the model's chosen target no longer exists on screen");
          break;
        }
      }
      if (decision.action === 'attach_file' && !target) {
        history.push({ step, action: 'blocked', target_index: decision.target_index, reasoning: 'target_not_found', result: 'target element not found' });
        stopped = 'blocked_sensitive'; stopValue = "the model's chosen file-attach target no longer exists on screen";
        break;
      }

      let stepResult = '';
      try {
        if (decision.action === 'click') {
          await page.mouse.click(target.x + target.w / 2, target.y + target.h / 2);
          stepResult = `click: ${target.text}`;
        } else if (decision.action === 'type') {
          await page.mouse.click(target.x + target.w / 2, target.y + target.h / 2);
          await page.waitForTimeout(200);
          await page.evaluate((t) => document.execCommand('insertText', false, t), decision.value || '');
          stepResult = `type: ${(decision.value || '').slice(0, 40)}`;
        } else if (decision.action === 'attach_file') {
          if (!attachFile) throw new Error('attach_file action but no --attach-file was given');
          await page.locator(`[data-agent-i="${target.i}"]`).setInputFiles(attachFile);
          stepResult = `attach_file: ${path.basename(attachFile)}`;
        } else if (decision.action === 'select') {
          const loc = page.locator(`[data-agent-i="${target.i}"]`);
          try { await loc.selectOption({ label: decision.value || '' }); }
          catch (e) { await loc.selectOption(decision.value || ''); }
          stepResult = `select: ${decision.value}`;
        } else if (decision.action === 'scroll') {
          await page.mouse.wheel(0, decision.value === 'up' ? -800 : 800);
          stepResult = 'scroll: ' + (decision.value || 'down');
        } else if (decision.action === 'navigate') {
          await page.goto(decision.value, { waitUntil: 'domcontentloaded' });
          stepResult = 'navigate: ' + decision.value;
        } else if (decision.action === 'extract') {
          stopped = 'extracted'; stopValue = decision.value;
        } else if (decision.action === 'done') {
          stopped = 'done'; stopValue = decision.value;
        } else if (decision.action === 'blocked') {
          stopped = 'blocked_by_model'; stopValue = decision.value;
        }
      } catch (e) { stepResult = 'execution error: ' + String(e.message || e).slice(0, 150); }

      history.push({ step, action: decision.action, target_index: decision.target_index, reasoning: decision.reasoning, result: stepResult || null });
      if (stopped) break;
    }
    if (!stopped) { stopped = 'max_steps'; stopValue = `hit the ${maxSteps}-step limit — goal not completed`; }

    await Promise.all(dlPromises).catch(() => {});
    const finalShot = path.join(runDir, 'final.png');
    try { await page.screenshot({ path: finalShot }); } catch (e) {}
    let host = null; try { host = new URL(page.url()).host; } catch (e) {}
    // Close a tab we opened ourselves — leaving it open across repeated runs is what made CDP
    // connections flaky in practice (Chrome gets busy with dozens of accumulated tabs).
    if (openedNewTab) { try { await page.close(); } catch (e) {} }
    const ok = stopped === 'done' || stopped === 'extracted' || (stopped === 'max_steps' && downloads.some(d => d.ok));
    const graduation = recordAgentRun(host, goal, ok);
    const res = { ok, stopped_reason: stopped, result: stopValue, steps_taken: history.length, max_steps: maxSteps, run_dir: runDir, final_screenshot: finalShot, downloads, history, graduation };
    fs.writeFileSync(path.join(runDir, '_agent_log.json'), JSON.stringify(res, null, 2), 'utf-8');
    return res;
  } finally { try { await b.close(); } catch (e) {} }
}

// ───────────────────────── fixed → agent automatic fallback ─────────────────────────
// "fixed" = the deterministic verbs above (hand-built selectors). "agent" = the LLM decision
// loop. download/upload/chat retry via agent automatically when the fixed path fails
// structurally (a selector timeout, etc.). `blocked:true` (login required, credentials) is never
// retried — the agent would hit the exact same wall. Missing required arguments are validated
// before this runs at all, so a plain usage mistake never triggers a slow agent retry.
async function withFallback(runFixed, buildAgentOpts) {
  let fixed;
  try { fixed = await runFixed(); }
  catch (e) { fixed = { ok: false, error: String(e && e.message || e) }; }
  if (!(fixed && fixed.ok === false && !fixed.blocked)) return { method: 'fixed', ...fixed };
  const agentOpts = buildAgentOpts();
  let agentRes;
  try { agentRes = await cmdAgent({ 'max-steps': 20, ...agentOpts }); }
  catch (e) { agentRes = { ok: false, error: String(e && e.message || e) }; }
  return { method: 'agent (fallback)', fixed_attempt: fixed, ...agentRes };
}

// ───────────────────────── main ─────────────────────────
(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0]; const o = args(argv.slice(1));
  try {
    // Usage mistakes (a missing required flag) are checked here, before withFallback, so they
    // fail fast instead of triggering a slow agent retry that can't succeed either.
    if (cmd === 'status' || cmd === 'tabs') await cmdStatus();
    else if (cmd === 'download') {
      if (!o.out || o.out === true) throw new Error('--out <dir> required');
      emit(await withFallback(() => cmdDownload(o), () => ({
        goal: 'On the current page (or the given chat), find every downloadable/saveable file or attachment and click to save it. Report the saved file names via extract.',
        url: (o.url && o.url !== true) ? o.url : undefined,
        'run-dir': o.out,
      })));
    }
    else if (cmd === 'upload') {
      if (!o.file || o.file === true) throw new Error('--file <path> required (file to upload)');
      if (!fs.existsSync(o.file)) throw new Error('--file path does not exist: ' + o.file);
      emit(await withFallback(() => cmdUpload(o), () => ({
        goal: (o.kakao ? 'On the KakaoTalk chat' : 'On the current page') + ', attach the file to the chat/composer and send it. The file is already staged.',
        url: (o.url && o.url !== true) ? o.url : undefined,
        'attach-file': o.file,
      })));
    }
    else if (cmd === 'youtube') await cmdYoutube(o);
    else if (cmd === 'chat') {
      const site0 = SITES[o.site]; if (!site0) throw new Error('--site must be chatgpt|gemini');
      const promptText0 = (o['prompt-file'] && o['prompt-file'] !== true) ? fs.readFileSync(o['prompt-file'], 'utf-8') : (o.prompt && o.prompt !== true ? o.prompt : '');
      if (!promptText0) throw new Error('--prompt-file <path> or --prompt <text> required');
      emit(await withFallback(() => cmdChat(o), () => ({
        goal: `On the ${o.site} web page, send the following as a new message and wait for a complete answer, then extract it:\n\n${promptText0}`,
        url: (o.url && o.url !== true) ? o.url : site0.url,
      })));
    }
    else if (cmd === 'facebook') await cmdFacebook(o);
    else if (cmd === 'agent') emit(await cmdAgent(o));
    else emit({ error: 'usage: status | download | upload | youtube | chat | facebook | agent', got: cmd || '(none)' });
  } catch (e) { emit({ ok: false, error: String(e && e.message || e) }); process.exit(1); }
})();
