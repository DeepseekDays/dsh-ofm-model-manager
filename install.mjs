/**
 * dsh-ofm-model-manager / install.mjs
 * ============================================================================
 * 把本插件挂进 DSH 的 profile。**不跑 pnpm**（DSH 运行时跑 pnpm 会重建
 * node_modules、打断正在跑的会话），用目录联接就够了 —— 本插件零运行时依赖，
 * 只 import DSH 自带的 @deepseek-ai/schemastery（走 DSH 的 resolveFromAnchor 兜底）。
 *
 * 做三件事（全部可重复执行）：
 *   1. 在 <profile>/node_modules/ 下建 junction → 本目录；
 *   2. 在 <profile>/package.json 的 dependencies 里加
 *      "dsh-ofm-model-manager": "link:<本目录>"；
 *   3. 在 dsh.profile.bundles 末尾追加 dsh-ofm-model-manager
 *      （末尾 = patch 最后叠加；本插件只 insert 自己的 entry，不覆盖别人）。
 *
 * 用法：
 *   node install.mjs                  安装 / 修复（默认 desktop profile）
 *   node install.mjs --profile web    指定 profile 目录名
 *   node install.mjs --dry            只看要做哪些改动
 *   node install.mjs --uninstall      卸载（移除 junction 与两条清单记录，保留插件目录）
 *
 * 装完必须**完全退出 DSH（含托盘）再启动**：bundle 列表与 client 模块表都是
 * 启动期读的，HMR 不会热加载新包。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = 'dsh-ofm-model-manager';

const argv = process.argv.slice(2);
const UNINSTALL = argv.includes('--uninstall');
const DRY = argv.includes('--dry');
const profileFlag = argv.indexOf('--profile');
const PROFILE_NAME = profileFlag >= 0 && typeof argv[profileFlag + 1] === 'string' ? argv[profileFlag + 1] : 'desktop';
const PROFILE = process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', PROFILE_NAME);

const manifestPath = path.join(PROFILE, 'package.json');
const modulesDir = path.join(PROFILE, 'node_modules');
const linkPath = path.join(modulesDir, PACKAGE_NAME);
const linkTarget = HERE.replaceAll('\\', '/');

function log(...args) {
  console.log(...args);
}

if (!fs.existsSync(manifestPath)) {
  console.error('找不到 profile 清单：' + manifestPath);
  console.error('用 --profile <名字> 或 DSH_PROFILE_DIR 指定别的 profile 目录。');
  process.exit(1);
}

const original = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(original);

// --------------------------------------------------------------- 1. junction
const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined;
if (UNINSTALL) {
  if (existing) {
    if (DRY) log('[dry] 删除 junction ' + linkPath);
    else {
      fs.rmSync(linkPath, { force: true });
      log('已删除 junction：' + linkPath);
    }
  } else {
    log('junction 不存在，跳过：' + linkPath);
  }
} else if (existing) {
  const stat = fs.lstatSync(linkPath);
  log('junction 已存在（' + (stat.isSymbolicLink() ? 'symlink' : 'real') + '）：' + linkPath);
} else if (DRY) {
  log('[dry] 创建 junction ' + linkPath + ' -> ' + linkTarget);
} else {
  fs.mkdirSync(modulesDir, { recursive: true });
  fs.symlinkSync(HERE, linkPath, 'junction');
  log('已创建 junction：' + linkPath + ' -> ' + HERE);
}

// --------------------------------------------------------- 2. dependencies
manifest.dependencies ??= {};
const wantedSpec = 'link:' + linkTarget;
if (UNINSTALL) {
  if (manifest.dependencies[PACKAGE_NAME] !== undefined) {
    delete manifest.dependencies[PACKAGE_NAME];
    log('已从 dependencies 移除 ' + PACKAGE_NAME);
  }
} else if (manifest.dependencies[PACKAGE_NAME] !== wantedSpec) {
  manifest.dependencies[PACKAGE_NAME] = wantedSpec;
  log('dependencies.' + PACKAGE_NAME + ' = ' + wantedSpec);
} else {
  log('dependencies.' + PACKAGE_NAME + ' 已是 ' + wantedSpec);
}

// ------------------------------------------------------- 3. bundle 清单
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
const lists = [manifest.dsh.profile.bundles];
// 有的 profile 还会在顶层再列一份（dsh-memory 就是这样），有的话一起维护
if (Array.isArray(manifest.dsh.bundles)) lists.push(manifest.dsh.bundles);

for (const list of lists) {
  const at = list.indexOf(PACKAGE_NAME);
  if (UNINSTALL) {
    if (at >= 0) {
      list.splice(at, 1);
      log('已从 bundles 移除 ' + PACKAGE_NAME);
    }
  } else if (at < 0) {
    list.push(PACKAGE_NAME);
    log('bundles 末尾追加 ' + PACKAGE_NAME);
  } else {
    log('bundles 里已有 ' + PACKAGE_NAME + '（位置 ' + at + '）');
  }
}

// ------------------------------------------------------------------ 写回
const next = JSON.stringify(manifest, null, 2) + '\n';
if (next === original) {
  log('清单无需改动。');
} else if (DRY) {
  log('[dry] package.json 有新内容，未写入。');
} else {
  const backup = manifestPath + '.bak-ofm-model-manager-' + Date.now();
  fs.copyFileSync(manifestPath, backup);
  fs.writeFileSync(manifestPath, next);
  log('已写入 ' + manifestPath + '（备份：' + path.basename(backup) + '）');
}

log('');
log(UNINSTALL ? '卸载完成。' : '安装完成。');
log('接下来：完全退出 DSH（含托盘）再重新启动，面板才会出现。');
log('验证：设置 → 模型（页面底部应出现「全体模型管理」面板）。');
