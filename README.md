# web-session-automation

> ## 🇰🇷 한국어 소개
>
> **내가 로그인해 둔 Chrome 인터넷 창을 AI가 대신 움직여 주는 스킬입니다.**
>
> Chrome에 한 번만 로그인해 두면, 그다음부터는 컴퓨터가 그 창을 대신 클릭하고 입력해 줍니다. 비밀번호는 전혀 건드리지 않고, 이미 로그인돼 있는 화면을 그대로 빌려 쓰는 방식이죠.
>
> 하는 일은 여러 가지인데 원리는 똑같습니다 — ① 카카오톡 비즈니스 채팅에 **파일 올리기**(upload) ② 클로드(Claude)에서 만든 결과물 **내려받기**(download) ③ ChatGPT·Gemini 같은 AI 사이트에 **질문을 써넣고 답 받아오기**(chat) ④ 유튜브에 **영상 올리기**(youtube) ⑤ 페이스북 내 프로필에 **글 임시저장·예약하고 성과 읽어오기**(facebook). API나 유료 키 없이, 그냥 내가 띄워 둔 Chrome 창만 컴퓨터가 대신 움직여서 처리합니다.
>
> 이 저장소는 개방형 **Agent Skills** 형식을 사용하므로 **Claude Code, Codex/ChatGPT 데스크탑, Codex CLI, Gemini CLI**에서 같은 스킬을 사용할 수 있습니다. `session.js`는 특정 AI에 종속되지 않은 Node.js 실행 파일입니다.
>
> **▶ 한 번 설치해서 세 AI에서 함께 쓰는 법**
> 1. [Node.js 18 이상](https://nodejs.org/)과 Git을 설치합니다.
> 2. 터미널에서 아래 명령을 차례로 실행합니다.
>
> ```bash
> git clone https://github.com/SUNWOONGKYU/web-session-automation.git
> cd web-session-automation
> npm install
> npm run install-skill
> ```
>
> 설치 프로그램은 현재 저장소를 `~/.agents/skills/`와 `~/.claude/skills/`에 연결합니다. 따라서 저장소 폴더를 설치 후 옮기거나 지우지 마세요. 기존에 같은 이름의 스킬 폴더가 있으면 덮어쓰지 않고 멈춥니다.
>
> 3. 아래 **Setup**의 명령으로 '자동화 전용' Chrome을 하나 띄우고, 쓸 사이트(카카오 비즈니스·Claude·ChatGPT·Gemini·유튜브·페이스북)에 **로그인 한 번** 합니다.
> 4. Claude Code·Codex·Gemini에서 “웹세션 자동화 스킬을 사용해서 … 해줘”라고 요청합니다. AI는 `session.js`를 실행하고, 되돌릴 수 없는 마지막 동작 전에는 멈춰 확인을 요청합니다.
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
| **facebook** | draft / schedule a post on your own profile, and read its stats & insights back | queue a post for tomorrow, then measure it |
| **status** | report the CDP connection, open tabs and per‑site login | health check |

No LLM, no API keys, no credential handling — it drives **your** already‑logged‑in browser. You log in once in the dedicated Chrome; the engine just reuses the session.

> The `SKILL.md` follows the open Agent Skills format. The same repository works with Claude Code, Codex/ChatGPT desktop, Codex CLI, and Gemini CLI; `session.js` remains a standalone Node CLI.

---

## Why "one engine"

Downloading a file, uploading a file, and chatting with a web LLM look like different jobs, but they share one foundation: **connect to a logged‑in browser session and drive the DOM**. So they live in one tool with different verbs instead of three near‑identical scripts.

---

## Requirements

- **Node.js** 18+
- **Playwright**: run `npm install` in this repository. A separate Playwright browser download is not required because the engine attaches to your installed Chrome over CDP.
- A **dedicated Chrome** launched with remote debugging (see below). Do **not** point this at your everyday Chrome — an elevated/admin Chrome refuses CDP attach, and you don't want automation touching your main profile.

## Install as an Agent Skill

Clone the repository, install the Node dependency, and link the same working copy into the common Agent Skills locations:

```bash
git clone https://github.com/SUNWOONGKYU/web-session-automation.git
cd web-session-automation
npm install
npm run install-skill
```

The installer links this folder to:

- `~/.agents/skills/web-session-automation` for Codex and Gemini CLI
- `~/.claude/skills/web-session-automation` for Claude Code

It works on macOS, Linux, and Windows. It never overwrites an existing skill folder. Keep the cloned repository in place after installation; run `git pull` there to update all three hosts at once.

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

2) In that Chrome, **log in once** to whatever you'll automate (claude.ai, chatgpt.com, gemini.google.com, your KakaoTalk Business chat, studio.youtube.com, facebook.com, …). The session persists in the profile.

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

# facebook — draft / schedule a post on your own profile, and read the numbers back
node session.js facebook status
node session.js facebook draft    --text-file "./post.txt" --image "./cover.png" --shot-dir "./shots"
node session.js facebook schedule --text-file "./post.txt" --date "Jul 23, 2026" --time "11:00 AM"
node session.js facebook stats    --url "<post URL>"
node session.js facebook insights --url "<content/insights URL>"
```

Every command prints a single JSON line. `upload`/`download` include a `verify`/`screenshot` so you can confirm the result actually landed — **"the call returned" is not "it worked."**

### Notes per verb
- **upload** picks the first `input[type=file]` by default (`--input-index N` to choose another). `--kakao` adds KakaoTalk‑specific completion polling and blocker detection (admin re‑auth expired / recipient withdrew). For a chat that sends a file on selection, attaching = sending — confirm the target before you run it.
- **youtube** drives the Studio upload wizard (create → file → title/description → not‑for‑kids → next×3 → visibility → publish). YouTube Studio is Polymer (open shadow DOM), so Playwright CSS reaches in; title/description are the `#title-textarea #textbox` / `#description-textarea #textbox` contenteditables (the filename prefill is cleared, then re‑typed via `execCommand`). **Without `--publish` it stops right before publishing and writes screenshots** — do a dry run, review, then publish. `--visibility` defaults to `private`. Publishing is an irreversible external action — confirm before `--publish`.
- **download** uses the Playwright `download` event + `saveAs()` (the CDP `setDownloadBehavior` path conflicts with Playwright and cancels the save). For **claude.ai**, artifact buttons are matched by `aria-label` (selectors target the Korean UI — adjust `SUFFIX`/selectors for other locales). With **`--kakao`**, it downloads files/videos from a KakaoTalk Business chat by clicking each message's save button (`a.btn_save`); `--limit N` caps how many.
- **facebook** works on **your own personal profile**. `status`/`stats`/`insights` only read (metrics are scraped from the post dialog / insights page, with a screenshot for you to check — note that views are often not exposed on a personal profile, so reactions + comments + shares are the fallback). `draft`/`schedule` go composer → Next → `Save` or `Schedule for later` → `Schedule`; **the `Post` button is never clicked**, so nothing is ever published immediately. A personal-profile draft with an image can't be saved by just closing the composer (the image only uploads at post time) — hence the Next→Save path. Scheduling types the date/time via JS focus + keyboard (real clicks get eaten by the calendar overlay) and **aborts before committing** if the fields don't read back exactly. Results land in Content Library → Drafts / Scheduled. Selectors assume the English UI. **Automating a Facebook account is at your own risk under Meta's terms — own profile, human pace.**
- **chat** inserts the prompt with `execCommand('insertText')` (so multi‑line prompts don't submit early) and waits until the answer is **stable** (≥6 unchanged polls + no stop button). Add more sites in the `SITES` map.

---

## Safety

- Logins, 2FA and any "extra authentication" steps are done **by you** in the browser. The engine never types passwords.
- `upload`, `chat`, `youtube` and `facebook` send things to the outside world — **confirm the target and content before running.**
- This drives a real logged‑in browser. Treat it accordingly.

## Limitations

- Selector‑dependent: when a target site changes its DOM, update the selectors in `session.js`.
- Works against **web** apps only. Native desktop apps (e.g. the KakaoTalk desktop client) are out of scope — for Kakao, use the **Business web chat**.

## License

MIT — see [LICENSE](LICENSE).
