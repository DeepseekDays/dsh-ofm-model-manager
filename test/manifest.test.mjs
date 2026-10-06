/**
 * dsh-ofm-model-manager / test/manifest.test.mjs
 * ============================================================================
 * 清单一致性：package.json / cordis.patch.yml / 两个半端文件必须互相说得上话。
 * 这些字段错了，DSH 启动时只会静默不加载插件（bundle 名对不上）或者界面空白
 * （client 模块 id 对不上），所以值得逐条钉住。
 *
 * 跑：node --test test/manifest.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = name => fs.readFileSync(path.join(HERE, name), 'utf8');
const manifest = JSON.parse(read('package.json'));
const patch = read('cordis.patch.yml');
const index = read('index.js');
const client = read('client.js');
const installer = read('install.mjs');

test('包名与两处挂载声明一致', () => {
  assert.equal(manifest.name, 'dsh-ofm-model-manager');
  assert.ok(patch.includes('name: dsh-ofm-model-manager'), 'cordis.patch.yml 的 name 必须是裸包名');
  assert.ok(patch.includes('id: dsh-ofm-model-manager'));
  assert.ok(installer.includes("const PACKAGE_NAME = 'dsh-ofm-model-manager'"));
});

test('bundle patch 与 client 半端都声明了', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.ok(Array.isArray(manifest.dsh.client.inject));
  // settings-models 是客户端模块行（拥有我们要用的席位）→ 声明加载顺序；
  // primitives 是 shell 的静态种子表项（无自己的模块行），声明它只是把
  // 「我 require 了它」写进清单，加载顺序上不会被卡住。
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-models'), '要注入 settings-models 的席位');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'), '要注入 primitives 的 Switch / Checkbox');
});

test('exports 指向真实存在的文件，且都在 files 白名单里', () => {
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key === './package.json') continue;
    const file = target.replace('./', '');
    assert.ok(fs.existsSync(path.join(HERE, file)), key + ' -> ' + target + ' 不存在');
    assert.ok(manifest.files.includes(file), file + ' 不在 files 白名单里');
  }
  assert.ok(manifest.files.includes('src'));
  assert.ok(manifest.files.includes('test'));
});

test('cordis.patch.yml：insert 一条自己的 entry，开箱是「全部启用 / 全部默认名」', () => {
  assert.ok(patch.includes('- insert:'));
  assert.ok(patch.includes('disabled: []'), '开箱必须是「全部启用」');
  assert.ok(patch.includes('names: {}'), '开箱必须是「全部用系统默认名」');
  assert.ok(patch.includes('routes: []'), '开箱是「管全部 provider」');
  assert.ok(patch.includes('hidden: []'), 'v1 字段兼容保留，开箱为空');
});

test('Config：disabled 与 names 是 volatile 的权威字段，hidden 兼容保留且非 volatile', () => {
  // volatile 是硬要求：非 volatile 字段写入会被 settings 服务拒绝（isVolatilePath）
  assert.ok(index.includes('disabled: z.array(z.string()).default([]).volatile()'), 'disabled 要可写 + 热更新');
  assert.ok(index.includes('names: z.dict(z.string()).default({}).volatile()'), 'names 要可写 + 热更新');
  // hidden 也要 volatile：每次写偏好都会把通配键镜像进它，
  // 而 settings 服务的 write() 会拒绝任何非 volatile 字段（真机端到端抓到的 bug）。
  assert.ok(index.includes('hidden: z.array(z.string()).default([]).volatile()'), 'hidden 要可写，否则镜像会让整次写入失败');
});

test('自定义名称：client 侧用 DSH 的 Checkbox，写回 names / disabled，并镜像 hidden', () => {
  assert.ok(client.includes("path: ['names']"), 'client 写回的是 names 字段');
  assert.ok(client.includes("path: ['disabled']"), 'client 写回的是 disabled 字段');
  assert.ok(client.includes("path: ['hidden']"), 'client 会镜像 v1 的 hidden');
  assert.ok(client.includes('primitives.Checkbox'), '勾选框用 DSH 设计系统的 Checkbox');
  assert.ok(client.includes('maxLength: NAME_MAX'), '输入框要有限长（跟随 DSH 模型名的量级）');
  assert.equal(index.includes("path: ['names']"), false, 'host 不写设置（写路径只有 settings 服务一条）');
});

test('偏好键的分隔符两个半端必须一致（否则停用/改名静默失效）', () => {
  assert.ok(index.includes("from './src/manager.js'"), 'host 从 src/manager.js 引入键口径');
  assert.ok(index.includes('  SEP,'), 'host 用的是 src/manager.js 导出的同一个分隔符');
  assert.ok(client.includes("const SEP = '|'"), 'client 侧声明同一个分隔符');
  assert.ok(client.includes('function pkey(provider, id)'), 'client 用同一个拼键函数');
  const manager = read('src/manager.js');
  assert.ok(manager.includes("export const SEP = '|'"), 'src/manager.js 是键口径的唯一出处');
});

test('client.js 的 ModuleLoader id 与包名一致', () => {
  assert.ok(client.includes("id: 'dsh-ofm-model-manager'"));
});

test('client.js 是自包含的：不含反引号/模板字符串（可安全内嵌、可离线做文本断言）', () => {
  assert.equal(client.includes(String.fromCharCode(96)), false, 'client.js 不应出现反引号');
  assert.equal(client.includes('${'), false, 'client.js 不应出现模板插值');
});

test('两个半端都声明了 apply，且 host 半端导出 Config', () => {
  assert.ok(index.includes('export function apply'));
  assert.ok(index.includes('export const Config'));
  assert.ok(client.includes('exports.apply = apply'));
});

test('host 半端的接口前缀与 client 半端的兜底前缀一致', () => {
  assert.ok(index.includes("const API_PREFIX = '/api/ofm-model-manager'"));
  assert.ok(client.includes("const API_FALLBACK = '/api/ofm-model-manager'"));
});

test('host 与 client 的兜底命名空间一致（settings 命名空间就是 profile 里那条 entry 的 id）', () => {
  assert.ok(index.includes("const NS_FALLBACK = 'dsh-ofm-model-manager'"));
  assert.ok(client.includes("const NS_FALLBACK = 'dsh-ofm-model-manager'"));
});

test('宿主半端上报 apiVersion，浏览器半端能识别「宿主还是旧版」的过渡态', () => {
  assert.ok(index.includes('apiVersion: 2'), 'index-inject 与 /models 都要带 apiVersion');
  assert.ok(client.includes('function hostApiVersion()'));
});

test('只注册一个 list 席位（settings.models.footer），且不碰 keyed 席位', () => {
  assert.ok(client.includes("ctx.slots.inject('settings.models.footer'"));
  // 独立分页 settings.section 与页脚面板内容重复，2026-10-05 按用户意见删掉
  assert.equal(client.includes("ctx.slots.inject('settings.section', () =>"), false, '不应再有重复的独立分页');
  assert.equal(client.includes("'settings.models.provider-card'"), false, 'keyed 席位同名 key 会抛异常，刻意不用');
});

test('渲染上限：面板对长清单做部分渲染 + 显示更多（不引第三方虚拟滚动）', () => {
  assert.ok(client.includes('const PAGE_SIZE = 40'), '要有渲染上限');
  assert.ok(client.includes("'showMore'"), '要有「显示更多」');
  // 手写 bundle 不能引第三方依赖
  assert.equal(/require\('[^']*virtual/.test(client), false, '不引虚拟滚动库');
});

test('install.mjs 会先备份 profile 清单再写', () => {
  assert.ok(installer.includes('.bak-ofm-model-manager-'));
  assert.ok(installer.includes('copyFileSync'));
});

test('README 存在且覆盖安装 / 实现原理 / 验证 / 边界', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('install.mjs'), '安装步骤');
  assert.ok(readme.includes('怎么实现的'), '实现原理');
  assert.ok(readme.includes('node test/all.mjs'), '离线验证台命令');
  assert.ok(readme.includes('端到端'), '离线台替代不了的那部分要说清楚');
  assert.ok(readme.includes('已知边界'), '边界');
  assert.ok(readme.includes('兼容'), '与别的插件的兼容性');
});
