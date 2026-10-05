# dsh-plugin-composer-expand

在 DSH 输入框的**右上角**加一个展开按钮：点一下，输入卡片长高到**对话区高度的 65%**，
**浮在消息之上**（消息区不被推挤、不被压缩、始终可滚），并且在这个沉浸态里**回车变成换行**，
发消息只走发送按钮。再点一次、按 Esc、或把消息发出去，就收回默认高度。

## 一句话

DSH 的输入卡片默认只有一行高（写字区 36px，官方上限定死 336px），写长文时视线被压成一条。
本插件把这个上限解开：卡片由 JS 量出对话区高度后定高在 65%，座位从文档流里脱出来贴在底部，
于是卡片向上"吃"住消息区 —— 对话布局一动不动，只有一层更高的写字卡片浮在上面。
同时把键盘语义换掉：官方 `Enter = 发送`，展开态改成 `Enter = 换行`（走官方 Shift+Enter 那条新行路径），
`⌘/Ctrl+Enter` 保持官方语义，发送按钮照旧。

## 交互规格

| | 行为 |
|---|---|
| 入口 | 输入卡片右上角常驻的图标按钮（官方 `IconChevronsUpDownOutlineRegular` / `IconChevronDownOutlineRegular`），hover 落一个**圆形底** |
| 按钮落位 | 按钮中心与**第一行文字**（也就是 placeholder）垂直居中；上、右留白取**同一个值**，左上角两边的呼吸位相等 |
| 展开高度 | 对话区高度的 **65%**（窗口缩放实时跟随），下限 200px，上限为对话区高度 − 48px |
| 覆盖方式 | 座位绝对定位、贴底；消息区**不重排**（不压缩、不推挤、滚动位置由 CSS 完整保住；实测收放完全可逆） |
| 展开态 Enter | **换行**（软换行，与官方 Shift+Enter 完全同一条路径） |
| 展开态 ⌘/Ctrl+Enter | 保留官方语义（发送 / 补充指令） |
| 展开态 Shift+Enter | 官方本来就是换行，原样放行 |
| 组字（输入法）中 Enter | 完全不介入，交回输入法上屏 |
| 面板内滚动 | 文字超出时**只滚面板内部**，不会带动后面的对话列表（官方那个「滚到边就把滚轮转发给对话列表」的行为在展开态被接管；折叠态原样保留） |
| 收起 | ① 再点按钮 ② `Esc` ③ 点发送按钮（或 ⌘/Ctrl+Enter）之后自动收起 |
| `Esc` 的作用域 | **只要当前会话的面板是展开的，焦点在哪都生效**（在消息区、侧栏、页面上都行）。三种情况不抢：焦点在别的输入框（终端 / 搜索框）、有可见弹层 / 模态、输入法组字中 |
| 记忆 | **按会话记**（内存），切走再切回来仍保持；刷新页面 / 重启 App 后回到默认高度 |
| 新会话页 | 同样支持，展开时同样落到底部 |

## 展开态为什么要这么写（关键技术依据）

全部结论来自本机 app.asar 解包产物与 headless Chrome 实测，不是猜的。

**1. 输入面是 Lexical 的 contenteditable，不是 textarea。**
`[data-composer-input]` 上挂着 Lexical 编辑器（`root.__lexicalEditor = editor`）。
官方的键位表 `registerComposerKeymap` 把 `Enter` 注册成 `KEY_ENTER_COMMAND`（优先级 4）并直接
调用 `handlers.submit(...)` 发送；而 `event.shiftKey === true` 时它**明确 return false**，
把换行让给 Lexical 自己的默认 handler（优先级 0）→ `INSERT_LINE_BREAK_COMMAND`。
所以"展开态换行"用的是官方自己的新行路径，不是自己造一个。

**2. 拦截点选在 `document` 的捕获阶段。**
Lexical 的 keydown 监听挂在 contenteditable 根元素上、**冒泡阶段**
（`Fn(root,'keydown',handler)` 只传 3 个参数，第三个 `capture` 是 undefined）。
在 `document` 捕获阶段 `preventDefault + stopImmediatePropagation`，事件根本到不了根元素，
发送 100% 被阻断。换行则按两条路走，优先第一条：

1. 拿 `[data-composer-input].__lexicalEditor`，在 `editor._commands` 里找
   `type === 'INSERT_LINE_BREAK_COMMAND'` 的命令对象，直接 `dispatchCommand(cmd, false)`；
2. 失败则回退：在写字区上派发一个**合成的 Shift+Enter**（`isTrusted=false`，
   Lexical 全产物从不检查这个字段），让它走官方的新行路径。

`editor._commands` 的键就是命令对象本身，命令对象是 `{ type }` 这种普通记录
（`Pe$2 = (t) => ({ type: t })`），所以这条直连不依赖压缩后的变量名。

**3. 覆盖态：座位绝对定位，但滚动容器必须保持 `static`。**
这是本插件最容易写错、也最值钱的一条。官方产物里有一段 CSS 钩子
`[data-conversation-composer-overlay]`，看起来正是为这件事准备的，**但它实测是坏的**：
它把滚动容器 `[data-conversation-scroll]` 设成 `position:relative;overflow:hidden auto`、
把消息区压成 `flex:1 1 0;overflow:hidden`，结果是 `scrollHeight == clientHeight`、
`maxScroll == 0` —— **消息彻底不可滚，最后一条被裁到滚动口下方 540px**。
根因是 DSH 会话视图真正的滚动源就是那个滚动容器（内层聊天盒是 `overflow:visible`），
把它压成 0 高就等于把唯一的滚动源废掉。

本插件的做法是：**只把座位变成绝对定位，滚动容器保持 `position:static`。**
于是座位的包含块落到 `[data-conversation-content]`（`.body`，官方已声明 `position:relative`，
且**不是**滚动容器）—— 座位既不随内容滚动，也不被裁剪，消息区照常滚动、照常可用。
座位让出来的那段高度再以 `padding-bottom` 还给消息区，滚动范围因此**完全不变**：

| 实测（1600×1000 复刻帧，长会话，已滚到底部） | 官方钩子路线 | 本插件路线 |
|---|---|---|
| `scrollTop` 漂移 | −1412（归零） | **0** |
| 末条消息位移 | 1412px | **0.00px** |
| 消息是否可滚 | ❌ `maxScroll = 0` | ✅ 照常 |
| 展开后卡片位置 | 被裁到滚动口外 | 贴底、横向也不位移 |

> **真机补充（已实测）**：在复刻帧上这套 CSS 是零位移的；真机上展开时消息区仍会有**约 55 CSS px 的上移，
> 收回时精确复原**（残差 0.00，完全可逆）。这不是插件的补偿造成的 —— 把补偿去掉反而更大（87px），
> 所以它来自应用自身的滚动管理。见「已知取舍」。

**4. `padding-bottom` 用的是官方自己的变量。**
shell 有一个 ResizeObserver 把 `seat.offsetHeight` 写成滚动容器上的 `--dsh-composer-height`
（聊天的"滚到底"也依赖它）。插件直接拿它当消息区的下内边距，所以补偿量永远等于座位的真实高度，
不需要自己算、也不会和官方打架。

**5. 高度用实测值，不用 `vh`。**
百分比需要父级有确定高度，而座位是绝对定位 `height:auto`；`vh` 又会把标题栏算进去。
所以由 JS 量出对话区 `clientHeight`，写成 `--dsh-composer-expanded-card-height`；
样式表里的 `65vh` 只是首次测量前的兜底。上限夹取是必须的：不加夹取，小窗口下卡片顶边会跑到
对话区上方、被 `.root[data-phase=active]{overflow:hidden}` 裁掉。

## 按钮为什么落在这个位置

按钮要和**第一行文字**（placeholder）垂直居中，并且上、右留白相等。第一行文字相对卡片边框盒的
中心是：

```
卡片 padding-top  8
+ 写字区 padding-top  4
+ 行高 / 2            ← 行高 = calc(24px + var(--dsh-content-font-delta))
= 24px + delta / 2
```

按钮高 26px，所以 `top = 24 + delta/2 − 13 = 11px + delta/2`；`right` 取同一个值，
两边自然相等：

```css
[data-composer-card] {
  --dsh-composer-expand-size: 26px;
  --dsh-composer-expand-inset: calc(11px + var(--dsh-content-font-delta, 0px) / 2);
}
```

`--dsh-content-font-delta` 是官方自己的变量（定义在 `body` 上，等于
`--dsh-content-font-size − 14px`），所以这个表达式**跟着主题字号自适配**：
默认 14px 字号时是 11px，本机 profile 的 15px 字号（行高 25px）时是 11.5px ——
实测两档下按钮中心与第一行文字中心的偏差都是 **0.00px**。
写字区的右内边距也由它推导（`inset + size + 6px`），所以按钮一动，正文避让跟着动。

hover 的底改成圆形：按钮 26×26，`border-radius: 999px` 即正圆。

> 注意：这条对齐锚定在**卡片上沿**。如果卡片里出现附件（附件行在写字区**上方**，
> 会把第一行文字往下推），对齐会偏；展平时（无附件）是准的。

## 两个容易踩的官方行为

**一、Esc 不能被"焦点是否在输入框里"绑住。**
点一下消息区、点一下侧栏，焦点就不在卡片里了；只认「焦点在卡片内」的话，Esc 当场失效。
现在先看焦点所在的那张卡片，找不到就退回到**屏幕上那个展开中的卡片**
（会话视图只渲染当前 tab，所以文档里最多只有一张卡片在布局）。
三条不抢的边界：焦点在别的输入框（终端 / 搜索框等）、有可见弹层或模态
（官方 `modalSelector` 是 `[role="dialog"][aria-modal="true"], [role="menu"]`）、输入法组字中。

**二、面板内的滚轮不能被官方"转发"走。**
`installDraftWheel` 监听在写字区的滚动盒上，当它滚到顶 / 底时会 `preventDefault()` 并把
`e.deltaY` 加到对话滚动容器上（`host.scrollTop += e.deltaY`）。折叠态下这是贴心设计 ——
输入框滚到头就接着看对话；展开态下就变成"滚面板里的文字，后面的对话列表也跟着滚"。
修法是在 `document` **捕获阶段**认领事件并 `stopPropagation()`：官方那个监听器挂在目标元素上，
事件根本到不了它；而滚动本身是**默认行为**、不是监听器，所以面板照常滚。
再加一条 `overscroll-behavior: contain` 兜住浏览器原生的滚动链。
两条都只在展开态生效，折叠态行为一字未改。

## 选择器为什么这么写

DSH 的类名全是 CSS-module 哈希（`yhfFVG_card`、`ST7X_W_composerSeat`），每次构建都变，不能用。
这里只用 shell 自己声明的、跨版本稳定的 data 属性：

```
[data-conversation-content]   对话身体区（.body，position:relative，非滚动容器）
[data-conversation-scroll]    滚动列（保持 static 是关键）
[data-composer-seat]          输入座位
[data-composer-card]          输入卡片
[data-input-scroll]           写字区的滚动盒
[data-composer-input]         写字区（Lexical contenteditable）
[data-slot="conversation.input.overlay"]   卡片右上角的插槽（按钮的座位）
```

`conversation.input.overlay` 是官方 `ui-conversation` 自己声明的 `list` 插槽，渲染在卡片的
`.overlayAnchor`（`position:absolute; inset:0 0 auto; height:0`）里 —— 那个盒子横跨卡片上沿、
高度为 0，所以绝对定位的按钮天然落在卡片右上角。用官方座位而不是往 DOM 里塞元素：
按钮随会话挂载/卸载，切换会话时由框架重挂载，不会泄漏。注册用 `order: 10`，
排在官方三个占用者（slash-menu 0 / command-popup 1 / feedback-dialog 2）之后。

所有选择器都要求 `:has()`（Chrome 105+）。注意 `:has()` 不能嵌套，
所以"展开中的滚动容器"这类复合选择器在文件里拼一次复用（`OPEN_SCROLL` / `OPEN_SEAT`）。

## 已知取舍

- **展开后消息区不被推挤、不被压缩、始终可滚**，但卡片会盖住下方那条。这正是"浮层覆盖"的含义：
  要读被盖住的内容，按 Esc / 点按钮收起来即可。
- **真机展开时消息区有约 55 CSS px 的可逆上移。** 用四帧序列（折叠 → 折叠 → 展开 → 折叠）实测：
  两次折叠态之间**逐像素零差异**（残差 0.00），展开相对折叠上移约 55 CSS px，收回后**精确复原**（残差 0.00）。
  把本插件的 `padding-bottom` 补偿临时去掉后位移反而变大（87 px），所以它不是补偿引入的，
  而是应用自身对座位高度变化的滚动管理。复刻帧上这套 CSS 本身是零位移的。
  这是本插件目前唯一一处「不重排」没有做到零像素的地方，约两行文字，且完全可逆。
- **展开时卡片右上角的按钮不变成"关闭"以外的东西**（没有点击外部收起）—— 按你选的三种收起方式实现。
- **记忆不持久化**：刷新页面或重启 App 后回到默认高度（按你选的"内存记"）。
- **写字区右侧常驻一条内边距**（即使没展开），保证正文不会钻到按钮底下。它由按钮的位置推导：
  `按钮右内距 + 按钮宽 + 6px`，本 profile 下是 43.5px。这会让首行的折行点比官方左移约 35px。
- 只改视觉层与键盘语义：不接管官方组件、不注册 chain 座位、不读别的插件 DOM。

## 安装

```bash
# 方式一：直接从 GitHub 装（首次安装需要重启 App）
dsh plugin --profile desktop add github:daoyu1993-lab/dsh-plugin-composer-expand

# 方式二：从本地目录装（会写进 dsh.profile.bundles，首次需要重启 App）
dsh plugin --profile desktop add "link:$PWD"

# 方式三：补丁层装载（dsh-hmr 实时拾取，不用重启 App）
ln -s "$PWD" ~/.dsh/profiles/desktop/node_modules/dsh-plugin-composer-expand
# 然后在 ~/.dsh/profiles/desktop/cordis.patch.yml 末尾追加：
#   - insert:
#       - id: composer-expand
#         name: 'dsh-plugin-composer-expand'
```

装完**刷新页面（⌘R）**即可生效。改 `client.js` 后由 `dsh-client-hmr` 拾取（约 0.5s），
本次实测连刷新都不需要。

## 卸载 / 回滚

```bash
# 方式二装的：删掉补丁里那段 insert，以及
rm ~/.dsh/profiles/desktop/node_modules/dsh-plugin-composer-expand
```

profile 补丁有备份：`cordis.patch.yml.bak-composer-expand-*`。

## 目录

```
index.js               宿主半边（空实现：本插件只作用于浏览器）
client.js              浏览器半边：插槽按钮 + 一张样式表 + document 级键位拦截
cordis.patch.yml       bundle 装法用的 insert 行
package.json           清单（dsh.bundle.patch + dsh.client）
LICENSE                MIT
```

## 验证记录

**离线几何验证**（官方真实样式表 + 按 JSX 复刻的 DOM + headless Chrome，6 个场景 × 20 项断言全过）：
折叠态与官方逐像素一致、滚动容器保持 `static`、按钮落在卡片右上角、展开高度 = 对话区 65%、
卡片贴底且不被裁、横向不位移、展开前后滚动位置零漂移。

**真机验证**（desktop profile，1242×870 窗口，插件已装入并生效）：

| 项 | 结果 |
|---|---|
| 按钮渲染在输入卡片右上角、用官方图标 | ✅ |
| 激活后卡片长高到约对话区 65%、盖住上方消息 | ✅ |
| 按钮图标在展开/收起之间切换 | ✅ |
| 展开态按 Enter **换行而不是发送**（草稿留下两行、对话未被发出） | ✅ |
| Esc 收起卡片，**草稿完整保留** | ✅ |
| Esc 在**焦点移出卡片**后（焦点落在侧栏按钮上）仍能收起 | ✅ 真机复核 |
| 面板内滚动不带动对话列表 | ✅ 离线（复刻官方 `installDraftWheel` 同一监听器做正/负例）；真机未跑 —— 我无法在这台机器上合成滚轮事件 |
| 收起后回到官方几何（两次折叠态逐像素零差异） | ✅ |
| 改 `client.js` 热更新免刷新生效 | ✅ |
| 展开/收起的消息区位移 | ⚠️ 约 55 CSS px 可逆（见「已知取舍」） |
| ⌘/Ctrl+Enter 发送后自动收起、点发送按钮后自动收起 | ⛔ 未在真机执行（会在真实会话里发出消息）；逻辑已实现 |
| 切换会话后按会话记忆 | ⛔ 未在真机执行 |
