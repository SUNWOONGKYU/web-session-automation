---
name: web-session-automation
description: "Attach over CDP to one dedicated automation Chrome (your own profile + remote-debugging port) and reuse its logged-in sessions to upload files, download artifacts, chat (post & read), upload videos to YouTube Studio, and draft/schedule/measure Facebook posts. One engine, different verbs. For any other site or task, the agent verb drives the same browser from a plain-English goal using your existing claude CLI login (still no API key) — download/upload/chat retry through it automatically when their fixed script fails. Use when asked to upload a file to a web chat, upload a video to YouTube, download claude.ai results, ask ChatGPT/Gemini on the web, draft or schedule a Facebook post, or drive a logged-in browser through a site this tool doesn't have a dedicated verb for. (Local browser automation. Six verbs are deterministic, no LLM, no API keys; the agent verb uses your claude subscription session, still no API key.)"
---

# Web session automation

Attach to **one dedicated automation Chrome** over CDP and reuse the logged-in sessions inside it. Uploading, downloading and chatting are the **same technique with a different verb**.

> Foundation = one automation Chrome. Launch Chrome with your own profile dir + `--remote-debugging-port=9222`; log in once to the sites you'll use (claude.ai, chatgpt.com, gemini.google.com, a KakaoTalk Business chat, …). Every verb connects with `connectOverCDP` and drives the relevant tab.

This skill follows the open Agent Skills format and is host-neutral. Use it from Claude Code, Codex/ChatGPT desktop, Codex CLI, or Antigravity CLI. Resolve `<SKILL_ROOT>` to the absolute directory containing this `SKILL.md`; do not assume the current working directory is the skill directory.

| Verb | Does |
|---|---|
| **status** | CDP connection, open tabs, per-site login (JSON) |
| **upload** | inject a file into `<input type=file>` + wait for completion |
| **youtube** | drive the YouTube Studio upload wizard end to end (file→title/desc→audience→visibility→publish) |
| **download** | save claude.ai artifacts/conversation text to a folder, or files from a KakaoTalk Business chat |
| **chat** | type a prompt, submit, collect the stable answer (ChatGPT/Gemini) |
| **facebook** | save a draft / schedule a post on your own profile, and read back its stats & insights |
| **agent** | look at the screen, decide the next action, repeat — for any site/task the six verbs above don't cover |

- **No LLM, no API keys** for the six fixed verbs. It reuses *your* browser login; you log in, it never types passwords.
- **agent** is the exception: it shells out to your already-logged-in `claude` CLI session (still no API key — same subscription, no extra cost beyond normal usage) to decide each step. `download`/`upload`/`chat` fall back to it automatically when their fixed script fails structurally; a `blocked` result (login/credentials needed) never triggers that fallback, since agent can't get past that wall either.
- An elevated/admin everyday Chrome refuses CDP attach — use a **dedicated profile** automation Chrome.

## Files
```
web-session-automation/
  ├─ SKILL.md       ← this orchestration file
  └─ session.js     ← engine: status / download / upload / youtube / chat / facebook / agent (Node + Playwright)
```
Config: env `CDP_URL` (default `http://localhost:9222`), `PW_PATH` (playwright module path if unresolved).

## 0. Pre-check
```
node "<SKILL_ROOT>/session.js" status
```
If `cdp:false`, launch the automation Chrome (own profile + `--remote-debugging-port=9222`) and log in once to the target sites.

## 1. upload
```
node "<SKILL_ROOT>/session.js" upload --file "<abs path>" [--url "<chat URL>"] [--kakao] [--input-index 0]
```
`--kakao` adds KakaoTalk Business completion polling + blocker detection. **Outward action — confirm target & file before running**, then verify via the returned `ok`/screenshot.

## 1-Y. youtube (YouTube Studio upload wizard)
```
node "<SKILL_ROOT>/session.js" youtube --file "<mp4>" --title-file "<title.txt>"|--title "<s>" [--desc-file "<desc.txt>"] --visibility public|unlisted|private [--publish] [--shot-dir "<dir>"]
```
YouTube upload is a multi-step wizard (details → elements → checks → visibility), not a plain file input, so it has its own verb. Flow: create → upload video → set file → title/description (clear filename prefill, then type) → not-for-kids → next×3 → visibility → (publish). **Without `--publish` it stops right before publishing and saves screenshots (`yt_details.png`, `yt_visibility.png`)** — do a dry run, review, then publish. `--visibility` defaults to `private`. If not logged in, returns `blocked` → log in to `studio.youtube.com` in the browser. **Publishing is an irreversible external action — confirm before `--publish`.** (Selectors target YouTube Studio's Polymer DOM; some text selectors assume the Korean UI.)

## 2. download (claude.ai / KakaoTalk Business)
```
# claude.ai artifacts + conversation text
node "<SKILL_ROOT>/session.js" download --out "<dir>" [--url "<chat URL>"] --artifacts all|names|none [--names "a|b|c"] --text none|handoff|full|both
# files/videos from a KakaoTalk Business chat (each message's save button)
node "<SKILL_ROOT>/session.js" download --out "<dir>" --url "<kakao chat URL>" --kakao [--limit N]
```
claude.ai artifact buttons matched by `aria-label`; with `--kakao`, save buttons matched by `a.btn_save` (`--limit N` caps count). Saved via Playwright `download` event + `saveAs()`. Verify via `_result.json` (`verify.ok`, sizes > 0). Ask the user what to save before running.

## 3. chat (ChatGPT / Gemini)
```
node "<SKILL_ROOT>/session.js" chat --site chatgpt|gemini --prompt-file "<file>" [--url "<conversation URL>"] [--out "<file>"] [--timeout <seconds>]
```
Pass the prompt as a file (avoids escaping / early submit). Waits for a stable answer. If not logged in, returns `blocked: login required` → log in once in the browser.

- `--url` targets an **existing conversation** (e.g. `https://chatgpt.com/c/<id>`). If that conversation is not reachable — wrong account, deleted — the verb returns `blocked` instead of posting into a different or brand-new chat.
- **The submit is verified.** The inserted text is checked, then Enter, then the send button as a fallback. With no evidence of a send (new user message / emptied composer / generation started) you get `ok:false, reason:'submit failed …'`.
- **Only a new answer counts.** The last answer is snapshotted before sending; `ok:true` requires the collected text to differ from that snapshot. Previously a failed send would return the *previous* answer as if it were fresh.
- Do not baseline on message counts — ChatGPT virtualises the DOM and the rendered count is not monotonic. Also note ChatGPT reuses one submit button whose `data-testid` toggles `send-button` ↔ `stop-button`, so matching only `[data-testid="send-button"]` never finds it.
- `status` reports `logins[site] === null` when no tab for that site is open (state unknown); `true` means a sign-in button was actually absent from the page, not merely that the URL looked fine.

## 4. facebook (own profile: draft / schedule / read stats)
```
node "<SKILL_ROOT>/session.js" facebook status
node "<SKILL_ROOT>/session.js" facebook stats    --url "<post URL>" [--shot-dir "<dir>"]
node "<SKILL_ROOT>/session.js" facebook insights --url "<content/insights URL>" [--shot-dir "<dir>"]
node "<SKILL_ROOT>/session.js" facebook draft    --text-file "<body.txt>" [--image "<img>"] [--shot-dir "<dir>"]
node "<SKILL_ROOT>/session.js" facebook schedule --text-file "<body.txt>" [--image "<img>"] --date "Jul 23, 2026" --time "11:00 AM"
```
Read modes (`status`/`stats`/`insights`) only look; write modes (`draft`/`schedule`) never publish immediately — **`Post` is never clicked**, only `Save` or `Schedule for later` → `Schedule`. `schedule` re-reads the date/time fields and **aborts before committing** if they didn't set cleanly. Everything lands in Content Library → Drafts / Scheduled; screenshots (`fb_staged.png`, `fb_draft_done.png`, `fb_schedule_pre.png`, …) go to `--shot-dir`. Selectors assume the English UI. **Automating your account is at your own risk under Meta's terms — use it on your own profile, at human pace.**

## 5. agent (general-purpose fallback)
```
node "<SKILL_ROOT>/session.js" agent --goal "<plain-English goal>" [--url "<start URL>"] [--max-steps N] [--run-dir "<dir>"]
```
Loop: screenshot + interactive-element list → ask `claude -p` (your existing CLI login, structured JSON output) for one next action → click/type/select/attach_file/scroll/navigate → repeat, up to `--max-steps` (default 25). Stops itself (`blocked`) on anything a human must do — login, identity verification/e-signature, CAPTCHA, payment, or an irreversible final confirmation — enforced both by the prompt and, independently, in code (a hard refusal on `input[type=password]` and on button text matching a sensitive-action pattern, regardless of what the model decided). `download`/`upload`/`chat` retry through this automatically when their fixed path fails structurally. Every run logs to `graduation_log.json`; a host with 3 successful runs gets flagged `graduation_candidate: true` — a nudge to write it a dedicated fixed verb, not an automatic rewrite.

**🗣️ Confirm before acting** — same rule as the fixed verbs: confirm the target/content with the user before giving `agent` a goal that sends, publishes, pays, or deletes something.

## Adding sites
Add `{url, input, answer, stop}` selectors to the `SITES` map in `session.js` to support more chat targets. Upload/download depend on the target page's file input / download-button pattern (locale-specific selectors may need adjusting).

## Do not
1. Type credentials for the user — logins / 2FA / extra-auth are theirs to do.
2. Send (upload/chat) without confirming the target and content.
3. Attach to the everyday admin Chrome — dedicated profile only.
4. Treat "the call returned" as success — verify with the result JSON / screenshot / received message.

## Host tools
- Use the host's shell tool to run `node <SKILL_ROOT>/session.js ...` and, when needed, launch the dedicated Chrome.
- Use the host's file and image-reading tools to inspect result JSON and screenshots.
- Use the host's normal confirmation mechanism before sending, publishing, paying, deleting, or making another irreversible change.
