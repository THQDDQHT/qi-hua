# 前端公众模式与统一生图调用实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有自部署直连能力的前提下，让生图页和画布在公众模式统一调用服务端接口、显示匿名额度，并移除未开放能力的路由和入口。

**Architecture:** `VITE_APP_MODE` 只决定公开功能边界，不承载任何密钥；公众会话 store 从 `/api/session` 获取服务端白名单和额度。新增统一生图客户端，公众模式调用 `/api/images/*`，自部署模式调用现有 `requestGeneration` / `requestEdit`，页面和画布不再直接选择传输实现。

**Tech Stack:** React 19、Vite、TypeScript、Zustand、axios、Ant Design、localforage、Bun test。

## Global Constraints

- `VITE_APP_MODE` 只允许 `public` 和 `self-hosted`，缺省为 `self-hosted`。
- 任何 `VITE_` 变量、构建产物和浏览器状态都不得包含公众部署的上游地址或密钥。
- 公众模式每次最多 4 张，页面额度以服务端响应为准，不自行推算扣费。
- 自部署模式继续支持现有渠道、模型、视频、WebDAV 和本地 Codex。
- 公众模式保留生图、画布、素材、生成记录和提示词库；隐藏视频、WebDAV、渠道配置和 Codex。
- 公众模式的画布只暴露图片生成路径；视频、音频、在线文本问答和蒙版上游编辑入口隐藏。
- 不把公众模式判断散落在每个按钮里，集中到部署能力配置和统一服务边界。
- 不执行构建；运行针对性测试并检查差异。

---

## File Map

```text
web/src/constant/deployment.ts                 部署模式和能力矩阵
web/src/types/public-generation.ts             会话、额度、生成请求与响应类型
web/src/services/api/public-generation.ts      同域名公众接口
web/src/services/image-generation-client.ts    公众/自部署统一生图边界
web/src/stores/use-public-session-store.ts      会话、额度和初始化状态
web/src/components/layout/public-session-init.tsx 公众会话初始化
web/src/constant/navigation-tools.ts            按能力生成导航
web/src/router.tsx                              按部署模式注册路由
web/src/layouts/user-layout.tsx                 公众模式移除 Agent 面板
web/src/components/layout/app-top-nav.tsx       公众顶栏裁剪和额度显示
web/src/components/layout/user-status-actions.tsx 隐藏公众配置入口
web/src/pages/image/index.tsx                   统一客户端和额度状态
web/src/pages/canvas/project.tsx                画布生图切换与能力裁剪
web/src/components/canvas/canvas-node-prompt-panel.tsx 公众图片参数
web/src/components/canvas/canvas-config-node-panel.tsx 公众图片参数
```

### Task 1: 部署模式、公众类型和会话 store

**Files:**
- Create: `web/src/constant/deployment.ts`
- Create: `web/src/types/public-generation.ts`
- Create: `web/src/stores/use-public-session-store.ts`
- Test: `web/tests/public-deployment.test.ts`
- Test: `web/tests/public-session-store.test.ts`

**Interfaces:**
- Produces: `APP_MODE`、`appCapabilities`、`PublicSessionResponse`、`PublicQuota`、`usePublicSessionStore`。

- [ ] **Step 1: 写部署能力失败测试**

```ts
import assert from "node:assert/strict";
import { capabilitiesForMode } from "../src/constant/deployment";

const publicMode = capabilitiesForMode("public");
assert.equal(publicMode.publicGeneration, true);
assert.equal(publicMode.video, false);
assert.equal(publicMode.webdav, false);
assert.equal(publicMode.codex, false);
assert.equal(publicMode.providerConfig, false);

const selfHosted = capabilitiesForMode("self-hosted");
assert.equal(selfHosted.publicGeneration, false);
assert.equal(selfHosted.video, true);
assert.equal(selfHosted.providerConfig, true);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/public-deployment.test.ts`

Expected: FAIL，无法导入部署配置。

- [ ] **Step 3: 实现集中能力矩阵**

```ts
export type AppMode = "public" | "self-hosted";

export function capabilitiesForMode(mode: AppMode) {
  return {
    publicGeneration: mode === "public",
    video: mode === "self-hosted",
    audio: mode === "self-hosted",
    textGeneration: mode === "self-hosted",
    webdav: mode === "self-hosted",
    codex: mode === "self-hosted",
    providerConfig: mode === "self-hosted",
  } as const;
}
```

`APP_MODE` 从 `import.meta.env.VITE_APP_MODE` 读取，非法值在开发环境抛出错误，未配置时使用 `self-hosted`。

- [ ] **Step 4: 实现公众会话 store 测试和最小状态**

Store 状态固定为：

```ts
type PublicSessionState = {
  status: "idle" | "loading" | "ready" | "error";
  session: PublicSessionResponse | null;
  errorCode: string;
  initialize: () => Promise<void>;
  refreshQuota: () => Promise<void>;
  applyQuota: (quota: PublicQuota) => void;
};
```

测试通过依赖注入的 API 替身断言并发 `initialize()` 只发一次请求、失败可重试、`applyQuota` 使用完整服务端快照覆盖旧额度。

- [ ] **Step 5: 运行测试并提交**

Run: `cd web && bun tests/public-deployment.test.ts && bun tests/public-session-store.test.ts`

Expected: 两个脚本输出通过信息并以 0 退出。

```bash
git add web/src/constant/deployment.ts web/src/types/public-generation.ts web/src/stores/use-public-session-store.ts web/tests/public-deployment.test.ts web/tests/public-session-store.test.ts
git commit -m "feat(web): 增加公众部署模式和额度状态"
```

### Task 2: 公众接口与统一生图客户端

**Files:**
- Create: `web/src/services/api/public-generation.ts`
- Create: `web/src/services/image-generation-client.ts`
- Modify: `web/src/services/api/image.ts`
- Test: `web/tests/image-generation-client.test.ts`

**Interfaces:**
- Produces: `generateImages(input): Promise<GenerationBatch>`、`generateSingleImage(input): Promise<GeneratedImageResult>`。

```ts
export type GenerateImagesInput = {
  config: AiConfig;
  prompt: string;
  references?: ReferenceImage[];
  mask?: ReferenceImage;
  count: number;
  signal?: AbortSignal;
};

export type GenerationBatch = {
  requestId: string;
  replayed: boolean;
  results: Array<
    | { index: number; status: "success"; image: { id: string; dataUrl: string } }
    | { index: number; status: "failed"; errorCode: string; message: string }
  >;
  quota?: PublicQuota;
};
```

- [ ] **Step 1: 写双模式客户端失败测试**

测试公众模式只请求相对路径 `/api/images/generations`，请求带 `requestKey` 且不包含 `baseUrl`、`apiKey`、`model`；有参考图时使用 `/api/images/edits`。自部署模式继续调用现有直连函数，并把每个槽位转换为统一结果。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/image-generation-client.test.ts`

Expected: FAIL，统一客户端不存在。

- [ ] **Step 3: 实现公众 API 序列化**

文生图请求只发送：

```ts
const body = {
  requestKey,
  prompt,
  count,
  size: config.size,
  quality: config.quality,
};
```

参考图先通过现有 `imageToDataUrl` 解析，再转 Blob 附加到 `FormData`。公众模式遇到 `mask` 时返回明确的“公众试用暂不支持蒙版编辑”，不能退回浏览器直连。

- [ ] **Step 4: 实现自部署适配**

自部署批量生成继续按槽位调用 `requestGeneration({ ...config, count: "1" })` 或 `requestEdit`，用 `Promise.allSettled` 保留部分成功。`generateSingleImage` 调用 `generateImages(...count: 1)`，失败时抛出第一个稳定中文错误。

- [ ] **Step 5: 运行测试并提交**

Run: `cd web && bun tests/image-generation-client.test.ts`

Expected: PASS，公众请求无密钥字段，自部署结果保持原语义。

```bash
git add web/src/services/api/public-generation.ts web/src/services/image-generation-client.ts web/src/services/api/image.ts web/tests/image-generation-client.test.ts
git commit -m "feat(web): 统一公众和自部署生图调用"
```

### Task 3: 会话初始化、路由和导航裁剪

**Files:**
- Create: `web/src/components/layout/public-session-init.tsx`
- Modify: `web/src/components/layout/app-providers.tsx`
- Modify: `web/src/constant/navigation-tools.ts`
- Modify: `web/src/router.tsx`
- Modify: `web/src/layouts/user-layout.tsx`
- Modify: `web/src/components/layout/app-top-nav.tsx`
- Modify: `web/src/components/layout/mobile-nav-drawer.tsx`
- Modify: `web/src/components/layout/user-status-actions.tsx`
- Modify: `web/src/components/layout/client-root-init.tsx`
- Test: `web/tests/public-navigation.test.ts`

**Interfaces:**
- Consumes: `APP_MODE`、`appCapabilities`、`usePublicSessionStore`。
- Produces: 公众模式固定路由集和初始化门禁。

- [ ] **Step 1: 写公众路由清单测试**

```ts
assert.deepEqual(publicNavigationTools.map((tool) => tool.slug), ["image", "canvas", "prompts", "assets"]);
assert.equal(publicRoutePaths.includes("/video"), false);
assert.equal(publicRoutePaths.includes("/config"), false);
assert.equal(selfHostedRoutePaths.includes("/video"), true);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/public-navigation.test.ts`

Expected: FAIL，当前导航始终包含视频和配置。

- [ ] **Step 3: 实现能力驱动的路由和布局**

`router.tsx` 在模块初始化时根据 `APP_MODE` 组装 children；公众模式 `/` 重定向 `/image`，不注册 `/video` 和 `/config`。`UserLayout` 在 `codex=false` 时不挂载 `AgentPanel`。顶栏不渲染 Codex 状态按钮和配置按钮，不能只隐藏视觉样式。

`PublicSessionInit` 只在公众模式调用 `initialize()`；加载失败时显示可重试的全页错误，避免页面在没有额度状态时发起生成。自部署模式直接渲染 children。

- [ ] **Step 4: 运行导航测试并提交**

Run: `cd web && bun tests/public-navigation.test.ts`

Expected: PASS，两个模式路由集合符合断言。

```bash
git add web/src/components/layout web/src/constant/navigation-tools.ts web/src/router.tsx web/src/layouts/user-layout.tsx web/tests/public-navigation.test.ts
git commit -m "feat(web): 裁剪公众模式路由和导航"
```

### Task 4: 生图工作台接入额度和统一批次

**Files:**
- Modify: `web/src/pages/image/index.tsx`
- Test: `web/tests/public-image-page-state.test.ts`

**Interfaces:**
- Consumes: `generateImages`、`usePublicSessionStore`。
- Produces: 服务端批次驱动的结果槽位、额度展示和禁用规则。

- [ ] **Step 1: 抽取并测试生成按钮状态函数**

在页面同目录建立可测试纯函数：

```ts
export function resolveGenerateDisabled(input: {
  prompt: string;
  running: boolean;
  publicMode: boolean;
  remaining?: number;
  count: number;
}) {
  if (!input.prompt.trim() || input.running) return true;
  if (!input.publicMode) return false;
  return input.remaining === undefined || input.remaining < input.count;
}
```

测试剩余 1 张时不能申请 2 张、剩余 0 张时禁用、失败结果不改变本地推算值。

- [ ] **Step 2: 运行状态测试确认失败**

Run: `cd web && bun tests/public-image-page-state.test.ts`

Expected: FAIL，纯函数不存在。

- [ ] **Step 3: 将页面改为一次批次调用**

删除页面对 `requestGeneration` / `requestEdit` 的直接导入和逐槽上游调用。点击生成时创建一个 `requestKey`，调用一次 `generateImages`，按响应 `results[index]` 更新现有 `GenerationResult[]`，并用 `applyQuota(batch.quota)` 覆盖额度。

自部署模式仍由统一客户端内部逐槽调用。公众模式数量选项来自会话 `generation.counts` 且不超过 `quota.remaining`。公众模式隐藏模型选择器和“打开渠道配置”动作，保留比例、质量和数量。

- [ ] **Step 4: 处理错误码和重试**

`QUOTA_EXHAUSTED` 显示“今日 10 张额度已用完，明天北京时间零点恢复”；`IP_QUOTA_EXHAUSTED` 显示“当前网络今日试用额度已用完”；`PUBLIC_GENERATION_OFF` 显示“免费生图暂时关闭”。失败槽位重试生成新的 `requestKey` 和单张请求。

- [ ] **Step 5: 运行测试并提交**

Run: `cd web && bun tests/public-image-page-state.test.ts`

Expected: PASS，按钮、数量和额度规则正确。

```bash
git add web/src/pages/image/index.tsx web/tests/public-image-page-state.test.ts
git commit -m "feat(image): 接入公众生图额度"
```

### Task 5: 画布生图接入统一客户端并裁剪节点能力

**Files:**
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/src/components/canvas/canvas-node-prompt-panel.tsx`
- Modify: `web/src/components/canvas/canvas-config-node-panel.tsx`
- Modify: `web/src/components/canvas/canvas-toolbar.tsx`
- Modify: `web/src/constant/canvas.ts`
- Test: `web/tests/public-canvas-capabilities.test.ts`

**Interfaces:**
- Consumes: `generateSingleImage`、`appCapabilities`、公众额度 store。
- Produces: 公众画布中仅图片生成的节点和动作集合。

- [ ] **Step 1: 写公众画布能力测试**

断言公众模式新增节点菜单只包含图片、文本和图片配置节点，不含视频、音频、文本问答或 Agent；自部署模式维持当前节点集合。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/public-canvas-capabilities.test.ts`

Expected: FAIL，当前节点菜单没有部署能力过滤。

- [ ] **Step 3: 替换画布直接生图调用**

将裁剪、放大等纯本地操作保持不变；把蒙版上游编辑动作在公众模式禁用并显示说明；把图片生成、参考图编辑、失败重试全部改为 `generateSingleImage`。每次成功或失败后应用服务端额度快照；额度不足时不创建加载节点。

删除公众模式自动打开 Agent 面板的 effect，隐藏工具栏 Agent 按钮。配置节点和提示词面板在公众模式只显示图片模型的比例、质量和数量，不显示模型选择器、视频、音频和文本模式。

- [ ] **Step 4: 运行能力测试并提交**

Run: `cd web && bun tests/public-canvas-capabilities.test.ts`

Expected: PASS，公众和自部署能力集合分离。

```bash
git add web/src/pages/canvas/project.tsx web/src/components/canvas/canvas-node-prompt-panel.tsx web/src/components/canvas/canvas-config-node-panel.tsx web/src/components/canvas/canvas-toolbar.tsx web/src/constant/canvas.ts web/tests/public-canvas-capabilities.test.ts
git commit -m "feat(canvas): 接入公众图片生成服务"
```

### Task 6: 文档、回归清单和阶段提交

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `docs/index.md`

- [ ] **Step 1: 更新真实能力说明**

在待测试文档中明确区分公众模式和自部署模式；公众模式密钥只在服务端，自部署模式仍保存在浏览器本地。不得把本地画布写成云同步。正式 `features.mdx` 暂不修改，等待用户确认测试通过。

- [ ] **Step 2: 写待测试项目**

记录：公众会话失败门禁、10/30 额度显示、图片页部分成功、画布单张扣费、公众路由不可达、自部署渠道回归、关闭生成开关提示。

- [ ] **Step 3: 运行前端针对性测试**

Run: `cd web && bun tests/public-deployment.test.ts && bun tests/public-session-store.test.ts && bun tests/image-generation-client.test.ts && bun tests/public-navigation.test.ts && bun tests/public-image-page-state.test.ts && bun tests/public-canvas-capabilities.test.ts`

Run: `git diff --check`

Expected: 全部测试脚本以 0 退出，差异无空白错误；不执行构建。

- [ ] **Step 4: 提交阶段二文档**

```bash
git add CHANGELOG.md docs/content/docs/progress/todo.mdx docs/content/docs/progress/pending-test.mdx docs/index.md
git commit -m "docs(web): 记录公众生图模式待测试项"
```

- [ ] **Step 5: 用户确认后更新正式功能说明**

用户逐项确认 `pending-test.mdx` 中本阶段内容通过后，再把已确认能力整理进 `docs/content/docs/overview/features.mdx`，并从待测试文档移除对应条目；未确认项继续保留。
