/**
 * dsh-ofm-model-manager / test/all.mjs
 * ============================================================================
 * 进程内跑全部离线断言。
 *
 * 为什么不用 `node --test`：DSH 的文件沙箱下 node 的子进程 spawn 会被拒
 * （EPERM），而 node --test 默认给每个测试文件开一个子进程。这个入口把四个
 * 测试文件按顺序 import 进来跑在同一个进程里（--test-isolation=none 的等价物），
 * 沙箱里也能全绿。
 *
 * 跑：node test/all.mjs
 */

const FILES = [
  './manager.test.mjs',
  './manifest.test.mjs',
  './host.test.mjs',
  './client.test.mjs',
]

for (const file of FILES) {
  process.stdout.write('\n── ' + file + ' ──\n')
  await import(file)
}
