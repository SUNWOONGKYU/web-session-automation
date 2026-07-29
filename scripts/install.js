#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const skillRoot = path.resolve(__dirname, '..');
const installHome = process.env.WEB_SESSION_SKILL_HOME
  ? path.resolve(process.env.WEB_SESSION_SKILL_HOME)
  : os.homedir();
const targets = [
  {
    host: 'Codex / ChatGPT desktop',
    path: path.join(installHome, '.agents', 'skills', 'web-session-automation'),
  },
  {
    host: 'Antigravity CLI',
    path: path.join(
      installHome,
      '.gemini',
      'antigravity-cli',
      'skills',
      'web-session-automation',
    ),
  },
  {
    host: 'Claude Code',
    path: path.join(installHome, '.claude', 'skills', 'web-session-automation'),
  },
];

function sameTarget(linkPath) {
  try {
    return path.resolve(fs.realpathSync(linkPath)) === path.resolve(fs.realpathSync(skillRoot));
  } catch {
    return false;
  }
}

for (const target of targets) {
  fs.mkdirSync(path.dirname(target.path), { recursive: true });

  if (fs.existsSync(target.path)) {
    if (sameTarget(target.path)) {
      console.log(`OK: ${target.host} already uses ${target.path}`);
      continue;
    }
    console.error(`STOP: ${target.path} already exists and was not changed.`);
    console.error('Move or remove that existing skill folder yourself, then run this installer again.');
    process.exitCode = 1;
    continue;
  }

  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(skillRoot, target.path, type);
  console.log(`OK: ${target.host} -> ${target.path}`);
}

if (!process.exitCode) {
  console.log('');
  console.log('Installation complete. Keep this repository folder in its current location.');
  console.log('Open a new agent session, then ask it to use web-session-automation.');
}
