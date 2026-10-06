# dsh-ofm-model-manager

DSH 的**全体模型管理**插件：在「设置 → 模型」页底部加一块面板，管理 provider 目录里
**每一个**提供商的**每一条**模型 —— 逐条启用/停用、逐条自定义显示名。

- 停用的模型从主界面「选择模型」栏与 `/model` 弹窗里消失（分组因此在选择器里整组消失）；
- 自定义名称直接换掉选择器里显示的名字；
- 偏好持久化在 profile，**改完立即生效**：不用刷新页面，也不用重启 DSH。

> v2（本版）把 v1 的「只管 Our Free Model」升级成「管全部提供商」。v1 的配置
> **零迁移**继续生效，详见下文「v1 兼容」。

---

## 目录

- [安装 / 升级](#安装--升级)
- [界面](#界面)
- [怎么实现的](#怎么实现的)
- [偏好键的口径](#偏好键的口径)
- [v1 兼容](#v1-兼容)
- [离线验证台](#离线验证台)
- [端到端验证](#端到端验证)
- [与别的插件的兼容](#与别的插件的兼容)
- [已知边界](#已知边界)
- [故障排查](#故障排查)

---

<a id="安装--升级"></a>
## 安装 / 升级

本插件零运行时依赖，只需要目录联接，**不跑 pnpm**（DSH 运行时跑 pnpm 会重建
node_modules、打断正在跑的会话）：

```powershell
# 默认 desktop profile
node install.mjs

# 指定 profile
node install.mjs --profile web

# 只看要做哪些改动
node install.mjs --dry

# 卸载（移除 junction 与两条清单记录，保留插件目录）
node install.mjs --uninstall
```

做三件事（全部可重复执行）：

1. 在 `<profile>/node_modules/` 下建 junction → 本目录；
2. 在 `<profile>/package.json` 的 `dependencies` 里加 `"link:<本目录>"`；
3. 在 `dsh.profile.bundles` 末尾追加 `dsh-ofm-model-manager`。

改 profile 清单前会先备份成 `<profile>/package.json.bak-ofm-model-manager-<时间戳>`。

**装完必须完全退出 DSH（含托盘）再启动**：bundle 列表与 client 模块表都是启动期读的，
HMR 不会热加载**新**包。（已经装过的插件，之后改 `client.js` 会被 HMR 热重载；
改 `index.js` 仍然要重启。）

---

<a id="界面"></a>
## 界面

落点只有一处：「设置 → 模型」页底部的面板（`settings.models.footer` 席位，list 类型，
按 id 与别的注册方共存）。用户正是在这个页面上管模型，面板放在这里最顺手。

### 三层控件各管一段

| 控件 | 管什么 |
| --- | --- |
| 搜索框 | 精确匹配：名称、自定义名、模型 id、描述、提供商名 |
| 状态 chips | 属性筛选：全部 / 已启用 / 地区受限 / 已停用，各带计数 |
| 提供商下拉 | 分组筛选：`全部提供商` 或某一条路由（带模型数） |

三个条件同时生效，都是 AND。三者都空时显示全部。

### 分组、折叠与批量

- 列表按**提供商分组**（provider 是用户的心智单位），组头显示 `名称 · 已启用/总数`
  与一个**组级开关**：全部停用时写「全部启用」，否则写「全部停用」。
- 组头可折叠，折叠状态只影响渲染，不影响筛选与计数。
- 行级批量按钮写的是**当前视图（筛选结果）**：文案带数量，下面还有一行小字说明
  「批量操作只影响上面筛选出来的结果，不会动没显示出来的模型」。刻意不做无声的
  「全选全库」，避免误关。

### 每行有什么

`生效名（= 选择器里显示的名字） + 状态徽标 / 模型 id / 描述` —— 右侧是同一容器里的
一组控件，顺序就是阅读顺序：**模型开关 → 自定义名称勾选框 → 名称输入框**（勾上才可编辑，
未勾选时输入框禁用并灰显系统默认名）。自定义名生效时行上会打一个「自定义」标记；
如果这条名字是**通配**的（对所有提供商下同名模型生效，见下文），标记里还会显示「通配」。

### 空态与错误态

三种空态分开处理，都不留白：

1. **一条模型都没有**：说明可能是「所有提供商都还没列出模型（比如没配密钥）」或
   「提供商被整体关掉了」+「重新读取」；
2. **全部被停用**：给一句「你把所有模型都停用了」+ 一键「全部恢复启用」；
3. **筛选无结果**：回显关键词 +「清除筛选」。

读失败（清单接口 / settings 文档）进错误态，带原因与「重试」；写失败（拨开关 / 改名）
只在面板上挂一条提示并把乐观更新回滚。

### 大清单

首屏只渲染 **40** 行（`PAGE_SIZE`），下面给「显示更多（还有 N 个）」与一行说明，
筛选条件一变就重置额度。这样几百上千条模型也不会把设置页拖住 —— 代价是不引虚拟滚动库
（本插件是手写 ModuleLoader bundle，除 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`
之外没有依赖）。若将来条目真的到几千条，再考虑把 PAGE_SIZE 换成窗口化渲染。

---

<a id="怎么实现的"></a>
## 怎么实现的

### host 半端（`index.js`）

**1. 改写模型目录。** 包一层 `ctx.llm.listModels()`：被停用的模型从返回值里滤掉，带自定义
名称的模型的 `name` 换成用户填的那个（浅拷贝，**不在原地改** provider 交出来的对象）。

DSH 的模型目录 `buildModelCatalog()`（`@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js`）
里有一句

```js
groups.filter(group => group.models.length > 0)
```

模型数为 0 的 provider 分组会被整组丢弃 —— 所以「停用某条路由的最后一个模型」会让这个
分组从选择器里消失，这正是需求要的语义。做法与 `dsh-provider-toggle` 同源，区别只在这里
是**逐模型**而不是整个 provider。

边界（dsh-llm 源码原话）：`Core routing accepts unlisted model ids; catalog-driven entry
points such as the GUI may require membership.` 也就是说，已经选着这个模型的旧会话不会被
弄坏，请求照常发；只是选择器里不再提供它。这与「停用」的直觉一致。

**2. 只读清单接口** `GET /api/ofm-model-manager/models`。被停用的模型在模型目录里已经
看不见了，管理面板必须另有一条数据来源 —— 而且 `LlmModelInfo` 只给
`id/name/description/inputModalities`，拿不到「这个模型属于哪条路由（是不是地区受限）」。
这条路由一次性给全（`routes` / `models` / `counts` / `disabled` / `names` / 失效名单 /
`generatedAt` / `cached`）。只读、只认 `GET`/`HEAD`，走 `src/trust.js` 的信任闸门
（回环 Host + 拒绝跨站 fetch + Origin/Referer 同源；组合里挂了 `connection` 服务时用
它自己的准入判断）。`?force=1` 让面板上的「重新读取」绕开缓存。

**3. 状态持久化与热生效。** 偏好存在本插件自己的 settings 命名空间（就是 profile 里那条
entry 的 id），两个 `.volatile()` 字段：`disabled` 与 `names`。

- volatile 是硬要求：只有 volatile 字段才允许被 settings 服务写入
  （`dsh-settings` 的 `write()` 里有 `isVolatilePath` 检查），也只有 volatile 字段走热更新
  而不是重启插件；
- 浏览器半端用现成的 `ctx.remote.settings.describe()/mutate()` 读写，不自己造远程接口；
- 写入触发 `loader/volatile-update` → 本插件重读配置并广播 `llm/adapters-updated` →
  浏览器的模型目录当场重载。

**4. 清单缓存。** 面板一次要读**所有** provider 的清单，而每次拨开关 / 敲名字都会触发一轮
重读。`src/manager.js` 的 `createModelCache` 按 TTL（60s）缓存每条路由的清单：TTL 内复用，
`llm/adapters-updated`（别处改了路由/目录）与「重新读取」按钮会让它失效。

### client 半端（`client.js`）

**乐观更新。** 拨开关 / 敲名字时本地立刻改（`publish`），再写 settings；失败回滚到
**最后一次确认落盘**的那份（不是回滚到写之前的内存值 —— 后者已经被乐观值改过了），
并把错误挂到面板上。

**改名防抖。** 敲字本地立即生效，停手 500ms 才写一次盘 —— 一次写会把整份 volatile 表单
写回 profile 的 `cordis.patch.yml`，而且每次写都会让 loader 广播 `llm/adapters-updated`
（模型目录重载），连打会把界面拖住。写入串行化：两次写撞同一个 `revision` 会被 settings
判 conflict。

**输入框的状态机。** 勾选框是「这条自定义名称在不在」的唯一表示：未勾选 → 输入框禁用、
显示系统默认名；勾选 → 用默认名打底、可编辑；「恢复默认」/ 取消勾选 / 清空后失焦 → 删掉
这条。空串是**合法值**（用户清空了、开关还勾着），取用时才回落默认名 —— 否则清空输入的
瞬间勾选框会自己弹回去，等于打字打到一半被抢走。

**名字永不自动清理。** 上游下线一个模型、provider 暂时没列出模型，用户手填的名字都留着
（需求原话：「系统升级或模型更新时需保留用户自定义名称设置」）。面板只把它们点名出来，
清不清由用户决定。停用记录同理，但多给一个「清理」按钮。

### 过渡态保护

浏览器半端是**热重载**的（client-hmr 每 500ms 比对 `client.js` 的 mtime/ctime/size，变了就
通过 `/plugins/events` 的 SSE 推一次 `rebuilt`，页面重新拉一份带新 `rev` 的 bundle），host
半端不是（要完全退出 DSH 再启动）。所以「界面是新的、宿主还是旧的」这个过渡态真实存在：此时
settings 命名空间里根本没有 `names` 字段，勾选框点了只会写失败。

> 顺带一个好处：改了 `client.js` **不需要重启 DSH**——HMR 自己会在 500ms 内发现并热替换。
> 但 HMR 换版时旧实例可能还挂着一个防抖写盘，所以卸载回调里会先把它落盘再交班（见「已知边界」第 9 条）。

判据：宿主半端在 `webserver/index-inject` 里注入 `apiVersion: 2`；浏览器半端也检查
settings 命名空间里有没有 `names` 字段。过渡态里**不显示**自定义名称这组控件，并在面板上
说清怎么让它可用（完全退出 DSH 含托盘再启动）。

---

<a id="偏好键的口径"></a>
## 偏好键的口径

每一条偏好（停用 / 自定义名称）的键都是**一个字符串**：

```
provider|modelId      只对这一条路由下的这个模型生效
modelId               不带分隔符 = 对**所有** provider 生效（通配）
```

为什么是这个形状：

- **模型 id 会重名。** `deepseek-v4.1-flash` 同时出现在 `deepseek-official`、
  `our-free-model`、`z-ai` 下，v1 只按模型 id 记账，停用一个会把三家的全停掉 ——
  这是 v2 修掉的核心问题；
- **通配桶让 v1 配置原样兼容**（裸 id 就是通配），不需要任何迁移动作；
- **一个字段、一种元素类型**，schema 简单到不会踩 schemastery 的类型坑；
- **分隔符选竖线**：provider id（`z-ai`、`our-free-model`）与模型 id
  （`z-ai/glm-5.3-flash`、`gpt-oss:20b`）都不会含它，而且它是 YAML 不用转义的普通字符 ——
  键直接写进 `cordis.patch.yml` 也可读（不选 NUL 就是为了这一点）。

优先级：**精确键 > 通配键**。所以「通配改名 + 某一条单独改名」能共存。

---

<a id="v1-兼容"></a>
## v1 兼容

v1 只用两个字段：`hidden`（裸模型 id 数组）与扁平的 `names`（模型 id → 名称）。在本版的
键口径下它们**原样读得动**（裸 id = 通配）：

| v1 配置 | v2 读到的效果 |
| --- | --- |
| `hidden: ['jev-1.13-free']` | 所有 provider 下 id 为 `jev-1.13-free` 的模型都停用 |
| `names: {'mimo-v2.6-flash-free': '小咪'}` | 所有 provider 下同名模型都显示「小咪」 |

写回时：

- 权威字段是 `disabled` / `names`；
- 每次写偏好都会把其中的**通配部分**镜像回 `hidden` —— 万一回退到 v1，旧版照样
  认得出自己那份设置（精确键旧版读不懂，不放进去污染它）。

用户什么都不用做。想一键恢复「全部启用、全部默认名」，把 profile 里那条
`id: dsh-ofm-model-manager` 的 `config` 删掉即可。

---

<a id="离线验证台"></a>
## 离线验证台

四个测试文件，**不启动 DSH、不碰网络、不开浏览器**：

```powershell
node test/all.mjs
```

（`test/all.mjs` 把四个文件按顺序 import 到同一个进程里跑。等价于
`node --test --test-isolation=none test/manager.test.mjs test/host.test.mjs
test/client.test.mjs test/manifest.test.mjs`，但 DSH 的文件沙箱下 `node --test` 给每个文件
开子进程会被拒（EPERM），所以默认入口是前者。）

| 文件 | 咬什么 |
| --- | --- |
| `test/manager.test.mjs` | 纯逻辑：偏好键口径、通配/精确优先级、路由认领、清单合成、三态、搜索口径、TTL 缓存 |
| `test/host.test.mjs` | 把 `apply()` 挂到假 ctx 上：停用是否真的从模型目录消失、面板是否仍看得到、广播、只读接口、信任闸门、与 `provider-toggle` 共用补丁槽 |
| `test/client.test.mjs` | 按 ModuleLoader 协议加载 `client.js`，用最小 React 替身**真的渲染**面板：分组/计数/折叠/空态/批量范围/部分渲染，以及写入形状与回滚 |
| `test/manifest.test.mjs` | 清单一致性：包名、bundle、席位、字段名、分隔符、自包含性（无反引号） |

口径独立实现：测试里的「可见分组」复刻的是 DSH `buildModelCatalog()` 里那句
`groups.filter(group => group.models.length > 0)`，而不是引用被测代码的判断 —— 否则等于自证。

---

<a id="端到端验证"></a>
## 端到端验证

离线台替代不了下面这些，装好后请手工过一遍：

1. **重启后**打开「设置 → 模型」，确认页底出现管理面板，且列出的 provider 覆盖你实际接的
   全部家（DeepSeek / Our Free Model / Z.ai / …）；
2. 停用一个模型 → 打开 composer 的「选择模型」，确认它**不见了**，同名的别的家的还在；
3. 在**已经选着**那个模型的旧会话里发一条消息，确认请求照常（停用只影响目录，不影响路由）；
4. 勾上自定义名称填一个名字 → 选择器里显示的名字**当场**变（不用刷新页面）；
5. 改一个几百条模型的情况：搜索 / 筛选 / 折叠是否跟手，滚到底点「显示更多」；
6. 手改 profile 的 `cordis.patch.yml` 里那条 entry（比如删掉 `config`），确认面板收敛成
   「全部启用 / 全部默认名」。

---

<a id="与别的插件的兼容"></a>
## 与别的插件的兼容

**`dsh-provider-toggle`（整个 provider 一键开关）** —— 两边争用同一个补丁槽：llm 实例上的
自有属性 `listModels`。`provider-toggle` 卸载时用的是 `Reflect.deleteProperty(llm,
'listModels')`，自有属性同名，删一次会把**我们**的包装一起带走，那一刻之后逐模型过滤会
静默失效（用户看到的是「开关点了没用」）。

对策是 `ensureFilter()`：每次重读配置时，只要发现自有属性**整个消失**就补装一次。判据刻意
收得很紧 —— 别人只是又包了一层（自有属性还在）时不补装，否则包装会越堆越多。两侧的措辞都
在测试里钉住了（`test/host.test.mjs` 的「兼容」两条）。

**`dsh-opencode-go-model-list` 这类「往 pi-ai 目录里塞模型」的插件** —— 它们在更底层
（pi-ai 的 `getModels`）动手，本插件在 `listModels` 出口过滤，顺序无冲突：
新塞进来的模型同样会被本插件管理与展示。

**命名空间不撞车** —— `provider-toggle` 用 `disabled`（字符串数组，provider id），本插件
的 `disabled` 是偏好键数组（含竖线，或裸模型 id）。为保险起见，浏览器半端找命名空间时
首选注入进来的 id，兜底按「值里带 `disabled` 数组」反查 —— 但那个判据用的是本插件自己
注入的 id 优先，实际不会串。

**核心的模型目录** —— 不修改任何内核文件，只包一层运行期方法，卸载时原样还原（引用计数，
重复 apply 不叠加包装）。

---

<a id="已知边界"></a>
## 已知边界

1. **停用只影响目录，不影响路由。** 已选着该模型的会话继续可用；新会话在选择器里选不到它。
   这是内核的既定行为，本插件没有改变它。
2. **改名只改显示名，不改模型 id。** 配置、会话记录、凭据引用全部仍用原始 id（这是对的）。
3. **不接管 provider 级开关。** 「整个提供商关掉」是 `dsh-provider-toggle` 的职责；本插件
   只管逐模型。两者可以同时装、同时生效。
4. **settings 写入整份 volatile 表单。** 因此偏好是**最后写入者胜**，两个标签页同时改会有一方
   收到 `settings/conflict`（面板会提示并回滚，不会静默丢数据）。
5. **通配键是全局广播。** 面板写入的永远是精确键；通配键只从 v1 配置或手改文件里来。
   通配名会在每一行显示「通配」标记，通配停用同理，避免「我只改了一个怎么全变了」的困惑。
6. **部分渲染而非虚拟滚动。** 超过 40 行的清单需要点「显示更多」；筛选是解决长清单的主要
   手段。
7. **只读接口跑在 `/api/ofm-model-manager` 前缀上**（比内核 `/api` 长，webServer 最长前缀
   优先 → 跑在 connection 自己的准入检查之前），所以自己实现了等价的信任闸门；组合里挂了
   `connection` 时优先用它的准入判断，保证不比应用本身更弱。
8. **改名期间的写回不锁面板、不重画。** 名称写回走独立路径：不置 `busy`（否则每一行的
   勾选框与「恢复默认」在打字期间反复变灰再变回来），并且只有**界面上真的会显示**的字段
   变化才通知订阅者（`RENDER_KEYS`，见 `client.js`）。纯记账字段（`revision`、`namesSeq`、
   `savedNames`）更新不重画 —— 它们面板一处都不读。往面板加新字段时必须同步登记进
   `RENDER_KEYS`，否则该字段更新会静默不重画（有用例钉住这条）。
9. **热重载（HMR）换版时，挂着的防抖写盘会先落盘再交班。** 浏览器半端是 HMR 换版的：
   宿主每 500ms 比对 `client.js` 的 mtime/size，变了就推一次 `rebuilt`，页面用**新的**模块
   实例替换旧的。旧实例的防抖定时器如果只是被丢掉，用户刚敲、还没到 500ms 的内容就没了；
   如果不管，它到点会拿旧实例的 state 去写盘。所以卸载回调里先 `clearTimeout`，再**立刻
   落盘一次**（`flushNames()`），写完才交班。这条对「正在打字时恰好触发 HMR」是必需的。

---

<a id="故障排查"></a>
## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板不出现 | bundle 没加载。确认 profile `package.json` 的 `dsh.profile.bundles` 里有它，然后**完全退出 DSH（含托盘）再启动** |
| 面板显示「读不到本插件的 settings 命名空间」 | 同上；另外确认 profile 的 `cordis.patch.yml` 里那条 entry 的 `id` 与注入的 ns 一致 |
| 开关点了没用 | 多半是补丁被别的插件卸载时带走了。本插件会在下次重读配置时自动补装；若持续，重启 DSH |
| 输入框不显示 | 宿主半端还是 v1（命名空间里没有 `names`）。完全退出 DSH 再启动 |
| 改名后选择器没变 | 等一次防抖（500ms）；仍不变就看浏览器控制台有没有 `settings.mutate` 失败 |
| 打字时面板闪 / 卡 / 吞字 | 已修复（见「已知边界」第 8 条）。浏览器半端热重载即可生效；若仍复现，看控制台有没有本插件的 `listener failed` 或 `settings/conflict` |
| 想彻底重来 | 删掉 profile `cordis.patch.yml` 里 `id: dsh-ofm-model-manager` 那条的 `config` |

---

## 文件

```
index.js            host 半端：目录过滤 + 只读接口 + 状态读取
client.js           浏览器半端：设置页面板
src/manager.js      纯逻辑：键口径、清单合成、缓存、搜索口径
src/trust.js        只读接口的信任闸门
cordis.patch.yml    插件自带挂载声明
install.mjs         安装 / 卸载 / 干跑
test/               离线验证台（见上）
```
