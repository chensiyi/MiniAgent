// 构建时把 README 安装直链中的 jsDelivr @ref 同步为"当前分支最新发布 tag"。
//
// 背景：jsDelivr 对分支引用（@tampermonkey）会长期缓存陈旧构建，purge 无效；
//       改用 immutable tag 引用后，每次发版都让 README 指向最新 tag，避免用户装到陈旧构建。
//
// 分支感知：tampermonkey 分支 → tampermonkey*；bookmarklet 分支 → bookmarklet*；
//           basement 分支 → basement-*；其余回退到分支名本身。
// 无 tag 时回退到分支引用，保证 URL 仍然有效（首次发版前）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function getCurrentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function tagPrefixForBranch(branch) {
  if (branch === 'tampermonkey') return 'tampermonkey';
  if (branch === 'bookmarklet') return 'bookmarklet';
  if (branch === 'basement') return 'basement-';
  return branch || 'tampermonkey';
}

function getLatestTag(prefix) {
  try {
    const out = execFileSync('git', ['tag', '--list', `${prefix}*`, '--sort=-version:refname'], {
      encoding: 'utf-8',
    }).trim();
    const tags = out.split('\n').map((t) => t.trim()).filter(Boolean);
    return tags[0] || '';
  } catch {
    return '';
  }
}

function main() {
  const branch = getCurrentBranch();
  const prefix = tagPrefixForBranch(branch);
  const latestTag = getLatestTag(prefix);
  // 没有 tag 时回退到分支引用，保证 URL 仍然有效（首次发版前）。
  const ref = latestTag || branch || 'tampermonkey';

  const readmePath = path.resolve(process.cwd(), 'README.md');
  if (!fs.existsSync(readmePath)) {
    console.log('[sync-readme-tag] README.md not found, skip');
    return;
  }
  const content = fs.readFileSync(readmePath, 'utf-8');
  const updated = content.replace(/(gh\/chensiyi\/MiniAgent@)[^/)\s]+/g, `$1${ref}`);
  if (updated === content) {
    console.log(`[sync-readme-tag] README install link unchanged (already @${ref} or no match)`);
  } else {
    fs.writeFileSync(readmePath, updated, 'utf-8');
    console.log(`[sync-readme-tag] README install link → @${ref}`);
  }
}

main();
