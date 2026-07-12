# 手机生图与可安装网页应用实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让公众用户在手机浏览器中顺畅完成提示词、参考图、生成、预览、下载和本地保存，并可把站点安装到主屏幕。

**Architecture:** 手机端使用三入口固定底部导航和生图页固定操作栏，次要参数与历史记录进入 Ant Design Drawer；结果沿用现有 IndexedDB 存储并增加全屏预览。`vite-plugin-pwa` 只缓存网页外壳和同源静态资源，所有 `/api` 请求明确使用网络且不进入运行时缓存。

**Tech Stack:** React 19、Ant Design、Tailwind、Zustand、localforage、vite-plugin-pwa、sharp、Bun test。

## Global Constraints

- 页面文案使用中文，样式复用主题变量和 Ant Design token，不硬编码浅色/深色分支。
- 手机底部导航只显示“生图、画布、素材”；提示词库从生图输入区打开。
- 主要触控区域最小 44 像素，适配 `env(safe-area-inset-top)` 和 `env(safe-area-inset-bottom)`。
- 生成按钮和提示词输入不能被软键盘遮挡。
- 参考图支持 `accept="image/*"` 和 `capture="environment"` 的拍照入口。
- 网页应用不缓存 `/api`、生成图片响应或用户本地业务数据，不宣称支持离线生图。
- 画布、素材和记录继续保存在当前浏览器；首次使用必须说明清理浏览器数据会丢失内容。
- 不引入 Capacitor，不创建应用商店工程。
- 不执行构建；使用针对性测试、清单检查和真实设备人工验证。

---

## File Map

```text
web/src/hooks/use-mobile-layout.ts                    手机断点状态
web/src/components/layout/mobile-bottom-nav.tsx       三入口底部导航
web/src/layouts/user-layout.tsx                       手机底部留白
web/src/components/layout/app-top-nav.tsx             手机公众顶栏
web/src/pages/image/components/mobile-generation-bar.tsx 固定生成操作栏
web/src/pages/image/components/image-result-grid.tsx  响应式结果网格
web/src/pages/image/components/image-result-preview.tsx 全屏结果预览
web/src/pages/image/components/local-data-notice.tsx  本地保存提示
web/src/pages/image/index.tsx                          手机页面编排
web/src/services/local-backup.ts                      本地画布/素材/记录备份
web/src/lib/mobile-viewport.ts                        软键盘可视区域变量
web/src/styles/globals.css                            安全区域和可视高度变量
web/src/components/layout/pwa-install-prompt.tsx      安装提示
web/src/pwa.ts                                        服务工作线程注册
web/vite.config.ts                                    PWA 配置
web/index.html                                        移动网页元信息
web/scripts/generate-pwa-icons.ts                     从现有 SVG 导出图标
web/public/pwa-192.png                                 标准图标
web/public/pwa-512.png                                 标准图标
web/public/pwa-maskable-512.png                        可遮罩图标
```

### Task 1: 手机断点与底部导航

**Files:**
- Create: `web/src/hooks/use-mobile-layout.ts`
- Create: `web/src/components/layout/mobile-bottom-nav.tsx`
- Modify: `web/src/layouts/user-layout.tsx`
- Modify: `web/src/components/layout/app-top-nav.tsx`
- Modify: `web/src/styles/globals.css`
- Test: `web/tests/mobile-navigation.test.ts`

**Interfaces:**
- Produces: `useMobileLayout()`、`MobileBottomNav`、全局 `--app-safe-bottom`。

- [ ] **Step 1: 写手机导航清单测试**

```ts
import assert from "node:assert/strict";
import { mobileNavigationItems } from "../src/components/layout/mobile-bottom-nav";

assert.deepEqual(mobileNavigationItems.map((item) => item.path), ["/image", "/canvas", "/assets"]);
assert.ok(mobileNavigationItems.every((item) => item.label.length <= 2));
console.log("mobile navigation tests passed");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/mobile-navigation.test.ts`

Expected: FAIL，底部导航模块不存在。

- [ ] **Step 3: 实现断点和底部导航**

`useMobileLayout` 监听 `(max-width: 767px)` 并在卸载时清理 listener。`MobileBottomNav` 只在公众模式和手机断点渲染，使用 `ImagePlus`、`Maximize2`、`Images` 图标，每个入口高度至少 52 像素，外层下边距使用安全区域。

`UserLayout` 为手机公众模式内容区增加底部导航占位；桌面和自部署布局不变。手机公众顶栏只保留标识、额度和主题按钮，不显示抽屉菜单。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/mobile-navigation.test.ts`

Expected: PASS。

```bash
git add web/src/hooks/use-mobile-layout.ts web/src/components/layout/mobile-bottom-nav.tsx web/src/layouts/user-layout.tsx web/src/components/layout/app-top-nav.tsx web/src/styles/globals.css web/tests/mobile-navigation.test.ts
git commit -m "feat(mobile): 增加公众版底部导航"
```

### Task 2: 手机生图固定操作栏和参数抽屉

**Files:**
- Create: `web/src/pages/image/components/mobile-generation-bar.tsx`
- Modify: `web/src/pages/image/index.tsx`
- Test: `web/tests/mobile-generation-bar.test.ts`

**Interfaces:**
- Consumes: `PublicQuota`、生成数量、比例、运行状态和 `onGenerate`。
- Produces: `MobileGenerationBar`。

- [ ] **Step 1: 写操作栏状态测试**

建立纯函数并测试：

```ts
export function mobileGenerateLabel(input: { running: boolean; count: number; remaining: number }) {
  if (input.running) return "正在生成";
  if (input.remaining <= 0) return "今日额度已用完";
  return `生成 ${Math.min(input.count, input.remaining)} 张`;
}
```

断言剩余 1 张且选择 4 张时显示“生成 1 张”，运行中显示“正在生成”，额度为 0 时禁用。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/mobile-generation-bar.test.ts`

Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现手机布局**

手机断点下隐藏桌面左侧历史栏和右侧常驻设置栏。页面主体依次为额度、提示词、参考图和结果；底部固定栏包含数量、比例、设置和生成按钮。质量、模型展示名和完整尺寸选项进入底部 Drawer；公众模型只读。

底部栏使用页面私有 Tailwind 样式，背景和边框读取主题 token，不向 `globals.css` 添加页面私有样式。键盘打开时通过 Task 4 的可视区域变量调整底部位置。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/mobile-generation-bar.test.ts`

Expected: PASS。

```bash
git add web/src/pages/image/components/mobile-generation-bar.tsx web/src/pages/image/index.tsx web/tests/mobile-generation-bar.test.ts
git commit -m "feat(image): 优化手机生图操作区"
```

### Task 3: 结果网格、全屏预览和拍照参考图

**Files:**
- Create: `web/src/pages/image/components/image-result-grid.tsx`
- Create: `web/src/pages/image/components/image-result-preview.tsx`
- Modify: `web/src/pages/image/index.tsx`
- Test: `web/tests/mobile-image-actions.test.ts`

**Interfaces:**
- Produces: `ImageResultGrid`、`ImageResultPreview`、`buildReferenceInputProps(source)`。

- [ ] **Step 1: 写上传属性和结果动作测试**

```ts
assert.deepEqual(buildReferenceInputProps("library"), { accept: "image/*", multiple: true });
assert.deepEqual(buildReferenceInputProps("camera"), { accept: "image/*", capture: "environment", multiple: false });
assert.deepEqual(resultActionsForStatus("success"), ["download", "reference", "asset", "canvas"]);
assert.deepEqual(resultActionsForStatus("failed"), ["retry"]);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/mobile-image-actions.test.ts`

Expected: FAIL，动作函数不存在。

- [ ] **Step 3: 实现结果和预览**

手机结果使用两列等宽网格；加载、成功、失败槽位保持固定比例避免页面跳动。点击成功图片打开全屏 Modal，底部固定下载、加入参考图、保存素材和插入画布动作。插入画布时创建新画布或让用户选择已有画布，复用现有 canvas store，不上传服务端。

参考图区增加“相册”和“拍照”两个入口，仍复用 `uploadImage` 写入 IndexedDB。处理 iOS 返回空 MIME 的图片时读取文件内容推断格式，不能仅按 `file.type` 过滤掉有效照片。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/mobile-image-actions.test.ts`

Expected: PASS。

```bash
git add web/src/pages/image/components/image-result-grid.tsx web/src/pages/image/components/image-result-preview.tsx web/src/pages/image/index.tsx web/tests/mobile-image-actions.test.ts
git commit -m "feat(image): 增加手机结果预览和拍照上传"
```

### Task 4: 软键盘与移动可视区域

**Files:**
- Create: `web/src/lib/mobile-viewport.ts`
- Modify: `web/src/components/layout/client-root-init.tsx`
- Modify: `web/src/styles/globals.css`
- Test: `web/tests/mobile-viewport.test.ts`

**Interfaces:**
- Produces: `syncVisualViewport(viewport, root)` 和 CSS 变量 `--app-viewport-height`、`--app-keyboard-offset`。

- [ ] **Step 1: 写可视区域纯函数测试**

```ts
const values = viewportCssValues({ height: 500, offsetTop: 0 }, 800);
assert.deepEqual(values, { viewportHeight: "500px", keyboardOffset: "300px" });
```

覆盖无 `visualViewport`、键盘关闭和横屏变化。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/mobile-viewport.test.ts`

Expected: FAIL，工具不存在。

- [ ] **Step 3: 实现监听和清理**

根初始化组件监听 `visualViewport.resize` 和 `visualViewport.scroll`，同步 CSS 变量；卸载时移除监听。页面高度使用 `--app-viewport-height`，底部操作栏在键盘出现时位于可视区域底部，不通过滚动整个画布解决。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/mobile-viewport.test.ts`

Expected: PASS。

```bash
git add web/src/lib/mobile-viewport.ts web/src/components/layout/client-root-init.tsx web/src/styles/globals.css web/tests/mobile-viewport.test.ts
git commit -m "fix(mobile): 适配软键盘可视区域"
```

### Task 5: 本地数据提示和一键备份

**Files:**
- Create: `web/src/pages/image/components/local-data-notice.tsx`
- Create: `web/src/services/local-backup.ts`
- Modify: `web/src/pages/image/index.tsx`
- Modify: `web/src/pages/assets/asset-transfer.ts`
- Test: `web/tests/local-backup.test.ts`

**Interfaces:**
- Produces: `exportLocalBackup(): Promise<Blob>` 和一次性提示键 `infinite-canvas:public-local-data-notice`。

- [ ] **Step 1: 写备份清单测试**

用内存 store 替身生成一个画布、一个素材、一条生图记录和两个 Blob，断言 ZIP 包包含：

```text
manifest.json
canvas/projects.json
assets/assets.json
image-workbench/logs.json
files/<storage-key 对应文件>
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/local-backup.test.ts`

Expected: FAIL，备份服务不存在。

- [ ] **Step 3: 实现本地备份和提示**

复用现有 `fflate`、canvas store、asset store、图片存储和生图日志 store，不复制压缩算法。`manifest.json` 记录格式版本和数据域，不包含 API Key 或 WebDAV 密码。

首次公众模式进入生图页显示：“作品保存在当前设备，清理浏览器数据或更换设备不会自动同步，请及时下载或备份重要内容。”用户确认后只在当前浏览器记录已读。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/local-backup.test.ts`

Expected: PASS，备份包含全部清单且不包含密钥字段。

```bash
git add web/src/pages/image/components/local-data-notice.tsx web/src/services/local-backup.ts web/src/pages/image/index.tsx web/src/pages/assets/asset-transfer.ts web/tests/local-backup.test.ts
git commit -m "feat(data): 增加公众版本地备份"
```

### Task 6: PWA 清单、图标和网络缓存策略

**Files:**
- Modify: `web/package.json`
- Modify: `web/vite.config.ts`
- Modify: `web/index.html`
- Modify: `web/src/main.tsx`
- Create: `web/src/pwa.ts`
- Create: `web/scripts/generate-pwa-icons.ts`
- Create: `web/public/pwa-192.png`
- Create: `web/public/pwa-512.png`
- Create: `web/public/pwa-maskable-512.png`
- Create: `web/src/components/layout/pwa-install-prompt.tsx`
- Test: `web/tests/pwa-config.test.ts`

**Interfaces:**
- Produces: 可安装清单、静态资源预缓存和 `PwaInstallPrompt`。

- [ ] **Step 1: 写 PWA 配置测试**

测试读取 Vite 配置导出的清单对象，断言 `display="standalone"`、`start_url="/image"`、包含 192/512/maskable 图标，并断言 Workbox runtime caching 没有 `/api` 匹配项。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/pwa-config.test.ts`

Expected: FAIL，PWA 配置不存在。

- [ ] **Step 3: 增加成熟依赖和图标生成脚本**

安装 `vite-plugin-pwa` 和仅用于图标脚本的 `sharp`。脚本从 `public/logo.svg` 生成 192、512 和带安全内边距的 512 可遮罩 PNG；不得让生成脚本修改原始 logo。

```ts
await sharp("public/logo.svg").resize(192, 192).png().toFile("public/pwa-192.png");
await sharp("public/logo.svg").resize(512, 512).png().toFile("public/pwa-512.png");
await sharp("public/logo.svg").resize(384, 384).extend({ top: 64, bottom: 64, left: 64, right: 64, background: "#ffffff" }).png().toFile("public/pwa-maskable-512.png");
```

- [ ] **Step 4: 配置缓存边界**

`vite-plugin-pwa` 只预缓存构建静态资源；`navigateFallback` 使用 `index.html`；显式设置 `navigateFallbackDenylist: [/^\/api\//, /^\/health\//]`；不添加图片接口 runtime cache。`registerSW` 的更新提示使用现有版本弹窗风格，不强制自动刷新正在编辑的画布。

- [ ] **Step 5: 运行测试并提交**

Run: `cd web && bun tests/pwa-config.test.ts`

Expected: PASS，清单和缓存边界正确。按项目规则不执行构建。

```bash
git add web/package.json web/bun.lock web/vite.config.ts web/index.html web/src/main.tsx web/src/pwa.ts web/scripts/generate-pwa-icons.ts web/public/pwa-192.png web/public/pwa-512.png web/public/pwa-maskable-512.png web/src/components/layout/pwa-install-prompt.tsx web/tests/pwa-config.test.ts
git commit -m "feat(pwa): 增加主屏幕安装支持"
```

### Task 7: 阶段文档与真实设备验收

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`

- [ ] **Step 1: 更新文档**

在待测试文档记录手机底部导航、固定操作栏、拍照上传、全屏预览、本地备份和可安装网页应用；明确离线只能打开网页外壳，不能生图。正式功能说明等待用户完成真实设备确认后再更新。

- [ ] **Step 2: 运行针对性测试**

Run: `cd web && bun tests/mobile-navigation.test.ts && bun tests/mobile-generation-bar.test.ts && bun tests/mobile-image-actions.test.ts && bun tests/mobile-viewport.test.ts && bun tests/local-backup.test.ts && bun tests/pwa-config.test.ts`

Run: `git diff --check`

Expected: 全部脚本以 0 退出，差异无空白错误。

- [ ] **Step 3: 真实设备验收**

在 iPhone Safari 和 Android Chrome 分别验证：首次提示、相册、拍照、键盘、1/4 张生成、部分失败、全屏预览、下载、加入素材、插入画布、添加到主屏幕、离线启动外壳和恢复联网。每项结果写入 `pending-test.mdx`，未验证项不得移入正式功能说明。

- [ ] **Step 4: 提交阶段三文档**

```bash
git add CHANGELOG.md docs/content/docs/progress/todo.mdx docs/content/docs/progress/pending-test.mdx
git commit -m "docs(mobile): 记录手机生图待测试项"
```

- [ ] **Step 5: 用户确认后更新正式功能说明**

用户确认 iPhone Safari 和 Android Chrome 的待测试条目后，将已确认的手机生图和可安装网页应用能力写入 `docs/content/docs/overview/features.mdx`；未确认条目不得提前写入。
