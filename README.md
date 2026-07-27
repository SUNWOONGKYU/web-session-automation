# web-session-automation

> ## 🇰🇷 한국어 소개
>
> **내가 로그인해 둔 Chrome 인터넷 창을 컴퓨터가 대신 움직여 주는 도구입니다.**
>
> Chrome에 한 번만 로그인해 두면, 그다음부터는 컴퓨터가 그 창을 대신 클릭하고 입력해 줍니다. 비밀번호는 전혀 건드리지 않고, 이미 로그인돼 있는 화면을 그대로 빌려 쓰는 방식이죠.
>
> 하는 일은 여러 가지인데 원리는 똑같습니다 — ① 카카오톡 비즈니스 채팅에 **파일 올리기**(upload) ② 클로드(Claude)에서 만든 결과물 **내려받기**(download) ③ ChatGPT·Gemini 같은 AI 사이트에 **질문을 써넣고 답 받아오기**(chat) ④ 유튜브에 **영상 올리기**(youtube). API나 유료 키 없이, 그냥 내가 띄워 둔 Chrome 창만 컴퓨터가 대신 움직여서 처리합니다.
>
> **▶ 받아서 쓰는 법**
> 1. 이 저장소에서 초록색 **Code → Download ZIP** 으로 내려받아 압축 풀기 (또는 `git clone`).
> 2. **Node.js**(코드를 돌려 주는 무료 프로그램)를 설치하고, 폴더에서 `npm i playwright` → `npx playwright install chromium` 실행 (브라우저를 자동으로 움직이는 부품 설치).
> 3. 아래 **Setup**의 명령으로 '자동화 전용' Chrome을 하나 띄우고, 쓸 사이트(카카오 비즈니스·Claude·ChatGPT·Gemini·유튜브)에 **로그인 한 번**.
> 4. 이제 `node session.js upload …` / `download …` / `chat …` / `youtube …` 를 입력하면 컴퓨터가 그 Chrome 창을 대신 움직여 일을 처리합니다.
>
> 누구나 무료로 쓰도록 공개(MIT)했습니다. 자세한 명령어·예시는 아래 영문 안내에 있습니다.

---

One small engine that attaches over **CDP** to a single **dedicated automation Chrome** (your own profile + a remote‑debugging port), reuses the **logged‑in sessions** inside it, and does a handful of things that are really the *same* technique with a different verb:

| Verb | What it does | Example |
|---|---|---|
| **upload** | inject a file into a page's `<input type=file>` and wait for it to finish | send a file to a KakaoTalk Business chat |
| **youtube** | drive the multi‑step YouTube Studio upload wizard end to end | upload a video to your channel (dry‑run, then publish) |
| **download** | save a web app's files/artifacts to a folder | grab claude.ai artifacts + conversation, or files from a KakaoTalk Business chat |
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

2) In that Chrome, **log in once** to whatever you'll automate (claude.ai, chatgpt.com, gemini.google.com, your KakaoTalk Business chat, studio.youtube.com, …). The session persists in the profile.

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

# download — files/videos from a KakaoTalk Business chat (each message's save button)
node session.js download --out "./out" --url "https://business.kakao.com/.../chats/<id>" --kakao

# youtube — upload to YouTube Studio. Dry run first (stops before publishing), then publish.
node session.js youtube --file "/path/to/video.mp4" --title-file "./title.txt" --desc-file "./desc.txt" --visibility unlisted
node session.js youtube --file "/path/to/video.mp4" --title "My title" --visibility public --publish

# chat — ask a web LLM and save the answer
node session.js chat --site gemini --prompt-file "./prompt.txt" --out "./answer.txt"
node session.js chat --site chatgpt --prompt-file "./prompt.txt"
```

Every command prints a single JSON line. `upload`/`download` include a `verify`/`screenshot` so you can confirm the result actually landed — **"the call returned" is not "it worked."**

### Notes per verb
- **upload** picks the first `input[type=file]` by default (`--input-index N` to choose another). `--kakao` adds KakaoTalk‑specific completion polling and blocker detection (admin re‑auth expired / recipient withdrew). For a chat that sends a file on selection, attaching = sending — confirm the target before you run it.
- **youtube** drives the Studio upload wizard (create → file → title/description → not‑for‑kids → next×3 → visibility → publish). YouTube Studio is Polymer (open shadow DOM), so Playwright CSS reaches in; title/description are the `#title-textarea #textbox` / `#description-textarea #textbox` contenteditables (the filename prefill is cleared, then re‑typed via `execCommand`). **Without `--publish` it stops right before publishing and writes screenshots** — do a dry run, review, then publish. `--visibility` defaults to `private`. Publishing is an irreversible external action — confirm before `--publish`.
- **download** uses the Playwright `download` event + `saveAs()` (the CDP `setDownloadBehavior` path conflicts with Playwright and cancels the save). For **claude.ai**, artifact buttons are matched by `aria-label` (selectors target the Korean UI — adjust `SUFFIX`/selectors for other locales). With **`--kakao`**, it downloads files/videos from a KakaoTalk Business chat by clicking each message's save button (`a.btn_save`); `--limit N` caps how many.
- **chat** inserts the prompt with `execCommand('insertText')` (so multi‑line prompts don't submit early) and waits until the answer is **stable** (≥6 unchanged polls + no stop button). Add more sites in the `SITES` map.

---

## Safety

- Logins, 2FA and any "extra authentication" steps are done **by you** in the browser. The engine never types passwords.
- `upload`, `chat` and `youtube` send things to the outside world — **confirm the target and content before running.**
- This drives a real logged‑in browser. Treat it accordingly.

## Limitations

- Selector‑dependent: when a target site changes its DOM, update the selectors in `session.js`.
- Works against **web** apps only. Native desktop apps (e.g. the KakaoTalk desktop client) are out of scope — for Kakao, use the **Business web chat**.

## License

MIT — see [LICENSE](LICENSE).
