// web-session-automation — engine (deterministic browser automation, no LLM)
//
// Attach over CDP to a dedicated automation Chrome (your own profile + remote debugging port),
// reuse its logged-in sessions, and: upload files / download artifacts / chat (post & read).
//
// Verbs:
//   status / tabs                            CDP connection, open tabs, per-site login (JSON)
//   download --out <dir> [--url <chat>] [--artifacts all|names|none] [--names "a|b|c"] [--text none|handoff|full|both]
//   upload   --file <path> [--url <chat>] [--input-index N] [--kakao]
//   chat     --site <chatgpt|gemini> --prompt-file <path> [--out <file>]
//
// Verified know-how:
//   · Over connectOverCDP, CDP Browser.setDownloadBehavior conflicts with Playwright saveAs ('canceled').
//     → Listen to the Playwright 'download' event and call download.saveAs() to write the file.
//   · claude.ai artifact download buttons have aria-label ending in the download word (visible text is an icon font).
//   · For chat input, insert text via execCommand('insertText') to avoid keyboard.type '\n' early-submit.
//   · Collect the answer after it is stable (>=6 unchanged polls) and the stop button is gone.
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
  chatgpt: { url: 'https://chatgpt.com/', input: '#prompt-textarea', answer: '[data-message-author-role="assistant"]', stop: '[data-testid="stop-button"]' },
  gemini:  { url: 'https://gemini.google.com/app', input: 'div.ql-editor[contenteditable="true"]', answer: '.model-response-text, message-content', stop: 'button[aria-label*="중지"], button[aria-label*="Stop"]' },
};

async function getCtx(pw) { const b = await pw.chromium.connectOverCDP(CDP); return { b, ctx: b.contexts()[0] }; }
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
    const logins = {};
    for (const [k, v] of Object.entries(SITES)) logins[k] = tabs.some(t => t.url.includes(new URL(v.url).host) && !/login|accounts|auth/i.test(t.url));
    logins['claude.ai'] = tabs.some(t => /claude\.ai\/chat/.test(t.url));
    logins['business.kakao'] = tabs.some(t => /business\.kakao/.test(t.url) && !/login|accounts/i.test(t.url));
    emit({ cdp: true, tab_count: tabs.length, tabs, logins });
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
  await withBrowser(async (ctx) => {
    // ── KakaoTalk Business chat: download files/videos via each message's save button (a.btn_save) ──
    if (o.kakao) {
      let kp = o.url && o.url !== true ? findTab(ctx, new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) : findTab(ctx, /\/chats?\//);
      if (!kp && o.url && o.url !== true) { kp = await ctx.newPage(); await kp.goto(o.url, { waitUntil: 'domcontentloaded' }); await kp.waitForTimeout(4000); }
      if (!kp) { emit({ ok: false, error: 'KakaoTalk chat tab not found. Pass --url <chat URL> or open the chat in the automation Chrome.' }); return; }
      await kp.bringToFront(); await kp.waitForTimeout(1500);
      const kb = await kp.evaluate(() => document.body.innerText || '');
      if (/추가인증|탈퇴/.test(kb)) { emit({ ok: false, blocked: true, reason: (kb.match(/추가인증|탈퇴/) || [])[0], hint: 'KakaoTalk admin re-auth required — handle in the browser yourself' }); return; }
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
      emit(res);
      return;
    }
    let page = o.url && o.url !== true ? findTab(ctx, new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) : findTab(ctx, /\/chat\//);
    if (!page) page = ctx.pages()[0];
    if (!page) { emit({ ok: false, error: 'No claude.ai /chat/ tab found. Open a claude.ai session in the automation Chrome.' }); return; }
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
    emit(res);
  });
}

// ───────────────────────── upload (e.g. KakaoTalk Business chat) ─────────────────────────
async function cmdUpload(o) {
  if (!o.file || o.file === true) throw new Error('--file <path> required (file to upload)');
  if (!fs.existsSync(o.file)) throw new Error('--file path does not exist: ' + o.file);
  await withBrowser(async (ctx) => {
    let page = o.url && o.url !== true ? findTab(ctx, new RegExp(String(o.url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) : findTab(ctx, /\/chats?\//);
    if (!page && o.url && o.url !== true) { page = await ctx.newPage(); await page.goto(o.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000); }
    if (!page) { emit({ ok: false, error: 'Target chat tab not found. Pass --url <chat URL> or open the chat in the automation Chrome.' }); return; }
    await page.bringToFront(); await page.waitForTimeout(800);
    const pre = await page.evaluate(() => document.body.innerText || '');
    // --kakao: detect KakaoTalk Business blockers (admin re-auth expired / recipient withdrew). These need manual action by you.
    if (o.kakao && /추가인증|탈퇴|보낼 수 없습니다/.test(pre)) {
      emit({ ok: false, blocked: true, reason: (pre.match(/추가인증|탈퇴|보낼 수 없습니다/) || [])[0], hint: 'KakaoTalk admin re-auth / recipient withdrawn — handle in the browser yourself' });
      return;
    }
    const baseCancel = (pre.match(/취소/g) || []).length;          // upload-in-progress 'cancel' baseline (Kakao)
    const errRe = /업로드 실패|전송 실패|오류가 발생|failed|error/i;
    const idx = o['input-index'] && o['input-index'] !== true ? parseInt(o['input-index'], 10) : 0;
    await page.locator('input[type=file]').nth(idx).setInputFiles(o.file);
    let done = false, sawProgress = false, uploaded = false;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(3000);
      const t = await page.evaluate(() => document.body.innerText || '');
      if (/탈퇴|보낼 수 없습니다/.test(t)) { emit({ ok: false, blocked: true, reason: 'cannot send (withdrawn/blocked)' }); return; }
      if (!pre.match(errRe) && errRe.test(t)) { emit({ ok: false, error: 'upload/send error detected', detail: (t.match(errRe) || [])[0] }); return; }
      const cur = (t.match(/취소/g) || []).length;
      if (o.kakao) {
        if (cur > baseCancel) sawProgress = true;
        if (sawProgress && cur <= baseCancel) { done = true; uploaded = true; break; }
        if (!sawProgress && i >= 3) { done = true; uploaded = true; break; }   // instant upload
      } else if (i >= 2) { done = true; uploaded = true; break; }              // non-kakao: settle (verify via screenshot)
    }
    const shot = path.join(os.tmpdir(), 'websession_upload.png');
    await page.screenshot({ path: shot });
    emit({ ok: done, file: path.basename(o.file), uploaded, verify_hint: 'confirm delivery via the screenshot / received message', screenshot: shot });
  });
}

// ───────────────────────── chat (chatgpt/gemini) ─────────────────────────
async function cmdChat(o) {
  const site = SITES[o.site]; if (!site) throw new Error('--site must be chatgpt|gemini');
  const prompt = (o['prompt-file'] && o['prompt-file'] !== true) ? fs.readFileSync(o['prompt-file'], 'utf-8') : (o.prompt && o.prompt !== true ? o.prompt : '');
  if (!prompt) throw new Error('--prompt-file <path> or --prompt <text> required');
  await withBrowser(async (ctx) => {
    let page = findTab(ctx, new RegExp(new URL(site.url).host.replace(/\./g, '\\.')));
    if (!page) { page = await ctx.newPage(); await page.goto(site.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000); }
    await page.bringToFront(); await page.waitForTimeout(1500);
    if (/login|accounts|auth/i.test(page.url())) { emit({ ok: false, blocked: true, reason: 'login required', site: o.site }); return; }
    const input = page.locator(site.input).first();
    await input.click();
    await page.evaluate((t) => document.execCommand('insertText', false, t), prompt);
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    let lastLen = -1, stable = 0, text = '';
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(2000);
      const blocks = await page.$$(site.answer);
      if (blocks.length) text = (await blocks[blocks.length - 1].innerText().catch(() => '')) || text;
      const stopping = await page.$(site.stop).then(x => !!x).catch(() => false);
      if (text.length === lastLen && !stopping) { if (++stable >= 6) break; } else stable = 0;
      lastLen = text.length;
    }
    if (o.out && o.out !== true) fs.writeFileSync(o.out, text, 'utf-8');
    emit({ ok: text.length > 0, site: o.site, chars: text.length, out: (o.out && o.out !== true) ? o.out : null, answer_preview: text.slice(0, 400) });
  });
}

// ───────────────────────── main ─────────────────────────
(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0]; const o = args(argv.slice(1));
  try {
    if (cmd === 'status' || cmd === 'tabs') await cmdStatus();
    else if (cmd === 'download') await cmdDownload(o);
    else if (cmd === 'upload') await cmdUpload(o);
    else if (cmd === 'chat') await cmdChat(o);
    else emit({ error: 'usage: status | download | upload | chat', got: cmd || '(none)' });
  } catch (e) { emit({ ok: false, error: String(e && e.message || e) }); process.exit(1); }
})();
