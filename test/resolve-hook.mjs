/**
 * dsh-ofm-model-manager / test/resolve-hook.mjs
 * ============================================================================
 * 给离线测试台用的解析钩子：普通 Node 没有 DSH 的 resolveFromAnchor，
 * 裸包名 @deepseek-ai/schemastery 会 ERR_MODULE_NOT_FOUND。
 *
 * 查找顺序（和 DSH 一致：先 profile，再 app 兜底）：
 *   1. <DSH_PROFILE_DIR>/node_modules（默认 ~/.dsh/profiles/desktop/node_modules）
 *   2. <DSH_APP_DIR>/node_modules（默认 F:/DSH/DSH Desktop/resources/app/node_modules）
 *
 * 必须先放行 Node 内置模块：profile 的 node_modules 里装着 npm 上的 events 垫片，
 * 让它先命中会顶掉内置模块。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';

const ROOTS = [
  process.env.DSH_PROFILE_DIR
    ? path.join(process.env.DSH_PROFILE_DIR, 'node_modules')
    : path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules'),
  process.env.DSH_APP_DIR
    ? path.join(process.env.DSH_APP_DIR, 'node_modules')
    : 'F:/DSH/DSH Desktop/resources/app/node_modules',
].filter(root => root.length > 0);

function resolveIn(root, specifier) {
  const match = /^((?:@[^/]+\/)?[^/]+)(\/.+)?$/.exec(specifier);
  if (match === null) return null;
  const [, packageName, sub] = match;
  const dir = path.join(root, ...packageName.split('/'));
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (sub !== undefined) {
    const target = manifest.exports?.['.' + sub];
    const file = typeof target === 'string' ? target : (target?.import ?? target?.default ?? target?.require);
    return file === undefined ? null : pathToFileURL(path.join(dir, file)).href;
  }
  const dot = manifest.exports?.['.'];
  const entry = (typeof dot === 'string' ? dot : (dot?.import ?? dot?.default ?? dot?.require))
    ?? manifest.module
    ?? manifest.main
    ?? 'index.js';
  const absolute = path.join(dir, entry);
  return fs.existsSync(absolute) ? pathToFileURL(absolute).href : null;
}

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('file:')
    || specifier.startsWith('node:')
    || specifier.startsWith('data:')
  ) {
    return nextResolve(specifier, context);
  }
  if (isBuiltin(specifier)) return nextResolve(specifier, context);
  for (const root of ROOTS) {
    try {
      const url = resolveIn(root, specifier);
      if (url !== null) return { url, shortCircuit: true };
    } catch {
      // 换下一个根
    }
  }
  return nextResolve(specifier, context);
}
