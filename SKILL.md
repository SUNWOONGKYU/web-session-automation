---
description: "Attach over CDP to one dedicated automation Chrome (your own profile + remote-debugging port) and reuse its logged-in sessions to upload files, download artifacts, and chat (post & read) on web apps. One engine, different verbs. Use when asked to upload a file to a web chat, download claude.ai results, ask ChatGPT/Gemini on the web, or otherwise drive a logged-in browser. (Local, deterministic browser automation, no LLM, no API keys.)"
user-invocable: true
version: "1.0"
last_updated: "2026-06-24"
---

# /web-session-automation — drive a logged-in browser: upload · download · chat

Attach to **one dedicated automation Chrome** over CDP and reuse the logged-in sessions inside it. Uploading, downloading and chatting are the **same technique with a different verb**.

> Foundation = one automation Chrome. Launch Chrome with your own profile dir + `--remote-debugging-port=9222`; log in once to the sites you'll use (claude.ai, chatgpt.com, gemini.google.com, a KakaoTalk Business chat, …). Every verb connects with `connectOverCDP` and drives the relevant tab.

| Verb | Does |
|---|---|
| **status** | CDP connection, open tabs, per-site login (JSON) |
| **upload** | inject a file into `<input type=file>` + wait for completion |
| **download** | save claude.ai artifacts/conversation text to a folder |
| **chat** | type a prompt, submit, collect the stable answer (ChatGPT/Gemini) |

- **No LLM, no API keys.** It reuses *your* browser login; you log in, it never types passwords.
- An elevated/admin everyday Chrome refuses CDP attach — use a **dedicated profile** automation Chrome.

## Files
```
web-session-automation/
  ├─ SKILL.md       ← this orchestration file
  └─ session.js     ← engine: status / download / upload / chat (Node + Playwright)
```
Config: env `CDP_URL` (default `http://localhost:9222`), `PW_PATH` (playwright module path if unresolved).

## 0. Pre-check
```
node "{SKILL_DIR}/session.js" status
```
If `cdp:false`, launch the automation Chrome (own profile + `--remote-debugging-port=9222`) and log in once to the target sites.

## 1. upload
```
node "{SKILL_DIR}/session.js" upload --file "<abs path>" [--url "<chat URL>"] [--kakao] [--input-index 0]
```
`--kakao` adds KakaoTalk Business completion polling + blocker detection. **Outward action — confirm target & file before running**, then verify via the returned `ok`/screenshot.

## 2. download (claude.ai / KakaoTalk Business)
```
# claude.ai artifacts + conversation text
node "{SKILL_DIR}/session.js" download --out "<dir>" [--url "<chat URL>"] --artifacts all|names|none [--names "a|b|c"] --text none|handoff|full|both
# files/videos from a KakaoTalk Business chat (each message's save button)
node "{SKILL_DIR}/session.js" download --out "<dir>" --url "<kakao chat URL>" --kakao [--limit N]
```
claude.ai artifact buttons matched by `aria-label`; with `--kakao`, save buttons matched by `a.btn_save` (`--limit N` caps count). Saved via Playwright `download` event + `saveAs()`. Verify via `_result.json` (`verify.ok`, sizes > 0). Ask the user what to save before running.

## 3. chat (ChatGPT / Gemini)
```
node "{SKILL_DIR}/session.js" chat --site chatgpt|gemini --prompt-file "<file>" [--out "<file>"]
```
Pass the prompt as a file (avoids escaping / early submit). Waits for a stable answer. If not logged in, returns `blocked: login required` → log in once in the browser.

## Adding sites
Add `{url, input, answer, stop}` selectors to the `SITES` map in `session.js` to support more chat targets. Upload/download depend on the target page's file input / download-button pattern (locale-specific selectors may need adjusting).

## Do not
1. Type credentials for the user — logins / 2FA / extra-auth are theirs to do.
2. Send (upload/chat) without confirming the target and content.
3. Attach to the everyday admin Chrome — dedicated profile only.
4. Treat "the call returned" as success — verify with the result JSON / screenshot / received message.

## Tools
- Bash / shell (`node session.js ...`, launch Chrome)
- Read (inspect result JSON / screenshots)
- AskUserQuestion (verb, target, send confirmation)
