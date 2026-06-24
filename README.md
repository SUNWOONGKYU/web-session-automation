# web-session-automation

One small engine that attaches over **CDP** to a single **dedicated automation Chrome** (your own profile + a remote‑debugging port), reuses the **logged‑in sessions** inside it, and does three things that are really the *same* technique with a different verb:

| Verb | What it does | Example |
|---|---|---|
| **upload** | inject a file into a page's `<input type=file>` and wait for it to finish | send a file to a KakaoTalk Business chat |
| **download** | save a web app's artifacts/text to a folder | grab claude.ai artifacts + the conversation |
| **chat** | type a prompt, submit, and collect the streamed answer | ask ChatGPT / Gemini on the web and read the reply |
| **status** | report the CDP connection, open tabs and per‑site login | health check |

No LLM, no API keys, no credential handling — it drives **your** already‑logged‑in browser. You log in once in the dedicated Chrome; the engine just reuses the session.

> Originally built as a Claude Code skill (`SKILL.md` included), but `session.js` is a standalone Node CLI you can run anywhere.

---

## Why "one engine"

Downloading a file, uploading a file, and chatting with a web LLM look like different jobs, but they share one foundation: **connect to a logged‑in browser session and drive the DOM**. So they live in one tool with different verbs instead of three near‑identical scripts.

---

## Requirements

- **Node.js** 18+
- **Playwright**: `npm i playwright && npx playwright install chromium`
- A **dedicated Chrome** launched with remote debugging (see below). Do **not** point this at your everyday Chrome — an elevated/admin Chrome refuses CDP attach, and you don't want automation touching your main profile.

## Setup

1) Launch a dedicated automation Chrome with a separate profile and a debugging port:

```bash
# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:USERPROFILE\.automation_chrome" `
  --remote-debugging-port=9222 --no-first-run --no-default-browser-check
```
```bash
# macOS / Linux
google-chrome --user-data-dir="$HOME/.automation_chrome" \
  --remote-debugging-port=9222 --no-first-run --no-default-browser-check
```

2) In that Chrome, **log in once** to whatever you'll automate (claude.ai, chatgpt.com, gemini.google.com, your KakaoTalk Business chat, …). The session persists in the profile.

3) Check the connection:

```bash
node session.js status
```

Configuration via env vars: `CDP_URL` (default `http://localhost:9222`), `PW_PATH` (path to the `playwright` module if it isn't resolvable from the working dir).

---

## Usage

```bash
# status — connection, tabs, per-site login
node session.js status

# upload — inject a file into a chat's file input (KakaoTalk Business example)
node session.js upload --file "/path/to/video.mp4" --url "https://business.kakao.com/.../chats/<id>" --kakao

# download — claude.ai artifacts + full conversation text to a folder
node session.js download --out "./out" --artifacts all --text full

# chat — ask a web LLM and save the answer
node session.js chat --site gemini --prompt-file "./prompt.txt" --out "./answer.txt"
node session.js chat --site chatgpt --prompt-file "./prompt.txt"
```

Every command prints a single JSON line. `upload`/`download` include a `verify`/`screenshot` so you can confirm the result actually landed — **"the call returned" is not "it worked."**

### Notes per verb
- **upload** picks the first `input[type=file]` by default (`--input-index N` to choose another). `--kakao` adds KakaoTalk‑specific completion polling and blocker detection (admin re‑auth expired / recipient withdrew). For a chat that sends a file on selection, attaching = sending — confirm the target before you run it.
- **download** uses the Playwright `download` event + `saveAs()` (the CDP `setDownloadBehavior` path conflicts with Playwright and cancels the save). Artifact buttons are matched by `aria-label`; the selectors target claude.ai's Korean UI — adjust `SUFFIX`/selectors for other locales.
- **chat** inserts the prompt with `execCommand('insertText')` (so multi‑line prompts don't submit early) and waits until the answer is **stable** (≥6 unchanged polls + no stop button). Add more sites in the `SITES` map.

---

## Safety

- Logins, 2FA and any "extra authentication" steps are done **by you** in the browser. The engine never types passwords.
- `upload` and `chat` send things to the outside world — **confirm the target and content before running.**
- This drives a real logged‑in browser. Treat it accordingly.

## Limitations

- Selector‑dependent: when a target site changes its DOM, update the selectors in `session.js`.
- Works against **web** apps only. Native desktop apps (e.g. the KakaoTalk desktop client) are out of scope — for Kakao, use the **Business web chat**.

## License

MIT — see [LICENSE](LICENSE).
