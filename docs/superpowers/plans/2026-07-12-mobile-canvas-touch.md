# 无限画布触控实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏桌面鼠标操作的前提下，让手机用户使用单指操作节点和空白画布、使用双指缩放移动，并通过底部工具栏完成节点动作。

**Architecture:** 将缩放和平移数学抽到无界面的手势模块，`InfiniteCanvas` 只负责维护活动触点和把计算结果传给现有 viewport；节点拖动由鼠标事件升级为 Pointer Events，并在第二个触点出现时显式取消节点拖动。手机节点动作使用选中状态驱动的底部工具栏，桌面继续使用现有悬浮工具栏。

**Tech Stack:** React Pointer Events、TypeScript、现有 canvas store、Ant Design Drawer、Tailwind、Bun test。

## Global Constraints

- 单指触摸节点拖动节点，单指触摸空白区域移动画布。
- 双指触摸任意画布区域缩放并移动画布，以双指中点为缩放中心。
- 第二个触点出现时取消尚未提交的节点拖动，不能同时移动节点和缩放画布。
- 鼠标滚轮缩放、中键平移、空格键和框选行为保持不变。
- 手机点击节点后显示底部工具栏，不依赖 hover；桌面悬浮工具栏保持现状。
- 手机默认隐藏小地图，主工具栏只保留添加、撤销、重做和更多。
- 连接点、缩放控制点和主操作区域的触控命中范围至少 44 像素，但视觉尺寸可以保持轻量。
- 不把手势状态放进 Zustand；它是组件生命周期内的瞬时状态。
- 不执行构建；核心数学和状态机必须先通过测试，再做真实设备验收。

---

## File Map

```text
web/src/lib/canvas/canvas-gesture.ts                 手势几何与状态转换
web/src/components/canvas/infinite-canvas.tsx        触点管理和 viewport 更新
web/src/pages/canvas/project.tsx                     节点 Pointer Events 与取消协调
web/src/components/canvas/canvas-node.tsx            触控命中区和 touch-action
web/src/components/canvas/mobile-node-toolbar.tsx    手机节点底部工具栏
web/src/components/canvas/mobile-canvas-toolbar.tsx  手机主工具栏
web/src/components/canvas/mobile-canvas-sheet.tsx    添加与更多底部抽屉
web/src/components/canvas/canvas-context-menu.tsx    长按菜单适配
web/src/components/canvas/canvas-connections.tsx     连接点触控命中区
web/src/styles/globals.css                           画布 touch-action 通用规则
```

### Task 1: 双指手势数学与状态机

**Files:**
- Create: `web/src/lib/canvas/canvas-gesture.ts`
- Test: `web/tests/canvas-gesture.test.ts`

**Interfaces:**
- Produces: `createPinchStart`、`updatePinchViewport`、`shouldStartLongPress`。

```ts
export type ScreenPoint = { x: number; y: number };
export type PinchStart = {
  first: ScreenPoint;
  second: ScreenPoint;
  midpoint: ScreenPoint;
  distance: number;
  viewport: ViewportTransform;
};
```

- [ ] **Step 1: 写缩放中心测试**

```ts
const start = createPinchStart(
  { x: 100, y: 100 },
  { x: 200, y: 100 },
  { x: 10, y: 20, k: 1 },
);
const next = updatePinchViewport(start, { x: 50, y: 100 }, { x: 250, y: 100 }, 0.05, 5);
assert.equal(next.k, 2);
assert.deepEqual(next, { x: -130, y: -60, k: 2 });
```

补充：两指同时平移 20 像素时 viewport 同步平移 20；距离为 0 时不产生无穷值；比例限制在 0.05 到 5。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/canvas-gesture.test.ts`

Expected: FAIL，手势模块不存在。

- [ ] **Step 3: 实现纯函数**

计算顺序固定为：读取起始中点对应的世界坐标、计算当前距离比例、限制新缩放值、让该世界坐标落在当前双指中点。不能依赖 DOM 或 React。

```ts
const worldX = (start.midpoint.x - start.viewport.x) / start.viewport.k;
const worldY = (start.midpoint.y - start.viewport.y) / start.viewport.k;
const scale = clamp(start.viewport.k * currentDistance / start.distance, minScale, maxScale);
return { x: currentMidpoint.x - worldX * scale, y: currentMidpoint.y - worldY * scale, k: scale };
```

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/canvas-gesture.test.ts`

Expected: PASS，缩放、平移、零距离和边界用例通过。

```bash
git add web/src/lib/canvas/canvas-gesture.ts web/tests/canvas-gesture.test.ts
git commit -m "feat(canvas): 增加双指画布手势算法"
```

### Task 2: InfiniteCanvas 维护活动触点

**Files:**
- Modify: `web/src/components/canvas/infinite-canvas.tsx`
- Test: `web/tests/canvas-pointer-state.test.ts`

**Interfaces:**
- Consumes: Task 1 手势函数。
- Produces: `onMultiTouchStart?: () => void` 回调和统一 pointer 生命周期。

- [ ] **Step 1: 写活动触点 reducer 测试**

抽取纯函数 `updateActivePointers(map, event)`，覆盖 touch down/move/up/cancel、mouse 不进入双指集合、第二指加入后返回两个最新坐标。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/canvas-pointer-state.test.ts`

Expected: FAIL，活动触点函数不存在。

- [ ] **Step 3: 集成 Pointer Events**

容器设置 `touchAction: "none"`。触摸指针 down 时写入 `Map<pointerId, ScreenPoint>`；只有一个指针且目标为空白时进入现有平移；第二个触点出现时停止单指平移、调用 `onMultiTouchStart`、记录 `PinchStart`；move 时用 `requestAnimationFrame` 合并 viewport 更新；up/cancel 删除触点并清理 pinch。

鼠标仍走现有 button、空格键、框选和滚轮逻辑。触摸不能调用 `document.body.style.cursor`。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/canvas-pointer-state.test.ts && bun tests/canvas-gesture.test.ts`

Expected: PASS。

```bash
git add web/src/components/canvas/infinite-canvas.tsx web/tests/canvas-pointer-state.test.ts
git commit -m "feat(canvas): 接入双指缩放和移动"
```

### Task 3: 节点拖动升级为 Pointer Events

**Files:**
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/src/components/canvas/canvas-node.tsx`
- Test: `web/tests/canvas-node-pointer.test.ts`

**Interfaces:**
- Consumes: `InfiniteCanvas.onMultiTouchStart`。
- Produces: `beginNodeDrag(event: PointerEventLike, nodeId)`、`cancelNodeDrag()`。

- [ ] **Step 1: 写节点拖动判定测试**

```ts
assert.equal(canStartNodeDrag({ pointerType: "touch", button: 0, isPrimary: true }), true);
assert.equal(canStartNodeDrag({ pointerType: "touch", button: 0, isPrimary: false }), false);
assert.equal(canStartNodeDrag({ pointerType: "mouse", button: 2, isPrimary: true }), false);
```

覆盖输入框、按钮、连接点和 `data-canvas-no-zoom` 子元素不启动节点拖动。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/canvas-node-pointer.test.ts`

Expected: FAIL，判定函数不存在。

- [ ] **Step 3: 替换节点鼠标入口**

把 `handleNodeMouseDown` 改为 Pointer Event，记录 `pointerId` 并调用 `setPointerCapture`。window move/up 处理只接受当前拖动指针；`pointercancel` 与 `onMultiTouchStart` 都调用 `cancelNodeDrag()`，恢复初始节点位置且不写入历史记录。

触摸拖动超过 6 像素才视为移动，鼠标维持 3 像素阈值。点击选择与双击标题编辑保持现状。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/canvas-node-pointer.test.ts`

Expected: PASS，触摸、鼠标、交互子元素和取消规则通过。

```bash
git add web/src/pages/canvas/project.tsx web/src/components/canvas/canvas-node.tsx web/tests/canvas-node-pointer.test.ts
git commit -m "feat(canvas): 支持触摸拖动节点"
```

### Task 4: 手机节点底部工具栏

**Files:**
- Create: `web/src/components/canvas/mobile-node-toolbar.tsx`
- Modify: `web/src/components/canvas/canvas-node-hover-toolbar.tsx`
- Modify: `web/src/pages/canvas/project.tsx`
- Test: `web/tests/mobile-node-toolbar.test.ts`

**Interfaces:**
- Produces: `mobileNodeActions(node, capabilities)` 和 `MobileNodeToolbar`。

- [ ] **Step 1: 写节点动作清单测试**

公众图片节点有查看、下载、存素材、编辑、删除；公众文本节点有编辑、生图、字号和删除；失败图片节点额外有重试；公众模式不出现视频、音频、反推文本问答和 Agent 动作。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/mobile-node-toolbar.test.ts`

Expected: FAIL，手机动作生成器不存在。

- [ ] **Step 3: 实现底部工具栏**

工具栏由唯一选中节点驱动，固定在手机底部主工具栏上方；最多显示 4 个常用动作和“更多”，更多动作进入 Drawer。工具栏按钮使用现有动作回调，不复制下载、保存、重试和删除逻辑。

桌面继续渲染 `CanvasNodeHoverToolbar`；手机不渲染悬浮工具栏，避免屏幕坐标和缩放导致遮挡。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/mobile-node-toolbar.test.ts`

Expected: PASS。

```bash
git add web/src/components/canvas/mobile-node-toolbar.tsx web/src/components/canvas/canvas-node-hover-toolbar.tsx web/src/pages/canvas/project.tsx web/tests/mobile-node-toolbar.test.ts
git commit -m "feat(canvas): 增加手机节点工具栏"
```

### Task 5: 手机主工具栏、抽屉和小地图裁剪

**Files:**
- Create: `web/src/components/canvas/mobile-canvas-toolbar.tsx`
- Create: `web/src/components/canvas/mobile-canvas-sheet.tsx`
- Modify: `web/src/components/canvas/canvas-toolbar.tsx`
- Modify: `web/src/pages/canvas/project.tsx`
- Test: `web/tests/mobile-canvas-toolbar.test.ts`

**Interfaces:**
- Produces: 手机主工具集合 `add`、`undo`、`redo`、`more`。

- [ ] **Step 1: 写工具集合测试**

公众手机只显示 4 个主工具；添加抽屉包含图片、文本、图片配置、上传图片和素材；不包含视频、音频和 Agent。桌面工具集合不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/mobile-canvas-toolbar.test.ts`

Expected: FAIL，手机工具集合不存在。

- [ ] **Step 3: 实现手机工具栏和抽屉**

手机默认不挂载 `Minimap`，避免仅用 CSS 隐藏仍执行计算。外观、导入导出、清空、背景和图片信息进入“更多”抽屉；节点添加进入“添加”抽屉。工具栏采用画布主题的极简扁平风格，无边框、无阴影、无胶囊背景。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/mobile-canvas-toolbar.test.ts`

Expected: PASS。

```bash
git add web/src/components/canvas/mobile-canvas-toolbar.tsx web/src/components/canvas/mobile-canvas-sheet.tsx web/src/components/canvas/canvas-toolbar.tsx web/src/pages/canvas/project.tsx web/tests/mobile-canvas-toolbar.test.ts
git commit -m "feat(canvas): 收敛手机画布工具栏"
```

### Task 6: 长按菜单与触控命中范围

**Files:**
- Modify: `web/src/components/canvas/canvas-context-menu.tsx`
- Modify: `web/src/components/canvas/canvas-connections.tsx`
- Modify: `web/src/components/canvas/canvas-node.tsx`
- Modify: `web/src/pages/canvas/project.tsx`
- Test: `web/tests/canvas-long-press.test.ts`

**Interfaces:**
- Produces: `createLongPressTracker({ delayMs: 500, moveTolerance: 8 })`。

- [ ] **Step 1: 写长按状态测试**

覆盖 500 毫秒触发、8 像素内不取消、超过 8 像素取消、第二触点取消、pointerup/cancel 取消、鼠标不走长按。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && bun tests/canvas-long-press.test.ts`

Expected: FAIL，长按追踪器不存在。

- [ ] **Step 3: 实现长按和命中区**

长按节点打开与右键相同的上下文菜单，但定位到触点附近并限制在可视区域。连接点和缩放手柄使用透明伪元素扩展到 44 像素，视觉点大小保持现有设计。拖动开始、双指开始和任何滚动都取消长按。

- [ ] **Step 4: 运行测试并提交**

Run: `cd web && bun tests/canvas-long-press.test.ts`

Expected: PASS。

```bash
git add web/src/components/canvas/canvas-context-menu.tsx web/src/components/canvas/canvas-connections.tsx web/src/components/canvas/canvas-node.tsx web/src/pages/canvas/project.tsx web/tests/canvas-long-press.test.ts
git commit -m "feat(canvas): 增加长按菜单和触控命中区"
```

### Task 7: 回归、文档与真实设备验收

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/canvas/canvas-node-manual.mdx`
- Modify: `docs/content/docs/canvas/canvas-shortcuts.mdx`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`

- [ ] **Step 1: 运行手势测试集合**

Run: `cd web && bun tests/canvas-gesture.test.ts && bun tests/canvas-pointer-state.test.ts && bun tests/canvas-node-pointer.test.ts && bun tests/mobile-node-toolbar.test.ts && bun tests/mobile-canvas-toolbar.test.ts && bun tests/canvas-long-press.test.ts`

Expected: 全部脚本以 0 退出。

- [ ] **Step 2: 桌面鼠标回归**

人工验证滚轮缩放、空白拖动、中键平移、框选、多选、节点拖动、连接、缩放、悬浮工具栏、右键菜单、撤销重做和键盘快捷键。把结果逐项写入 `pending-test.mdx`。

- [ ] **Step 3: 真实手机验收**

在 iPhone Safari 和 Android Chrome 分别验证：单指空白平移、单指节点拖动、双指从节点上开始缩放、双指平移、点击工具栏、长按菜单、连接点、缩放点、参数抽屉、软键盘和生成期间移动画布。

- [ ] **Step 4: 更新用户文档**

节点手册增加触控操作；快捷键文档单独增加“手机触控”小节；待办文档移除已完成手机画布事项，pending-test 保留所有尚未由用户确认的真实设备条目；CHANGELOG 增加 `[新增]` 或 `[优化]` 一条归纳。

- [ ] **Step 5: 检查差异并提交**

Run: `git diff --check`

Expected: 无空白错误；按项目规则不执行构建。

```bash
git add CHANGELOG.md docs/content/docs/canvas/canvas-node-manual.mdx docs/content/docs/canvas/canvas-shortcuts.mdx docs/content/docs/progress/todo.mdx docs/content/docs/progress/pending-test.mdx
git commit -m "docs(canvas): 记录手机触控待测试项"
```
