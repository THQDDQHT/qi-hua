# 公众免费生图改造执行索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按可独立验收的五个阶段，把现有个人自部署画布改造成同时支持公众匿名免费生图、手机浏览器和后续应用封装的产品。

**Architecture:** 公众模式通过同域名 Bun 接口服务代理现有生图供应商，PostgreSQL 以事务预占方式执行设备与网络地址双重额度；自部署模式继续由浏览器直连。前端在统一生图客户端之上逐步完成公众功能裁剪、手机生图、可安装网页应用和画布触控，最后由 Cloudflare 与 Nginx 完成源站保护和请求频率限制。

**Tech Stack:** Bun、Hono、PostgreSQL、React 19、Vite、TypeScript、Ant Design、Tailwind、Zustand、localforage、Docker、Nginx、Cloudflare。

## Global Constraints

- 每个匿名设备每天成功生成 10 张，单个网络地址每天成功生成 30 张，按 `Asia/Shanghai` 日期结算。
- 单次最多生成 4 张，失败槽位释放预占，只按实际成功图片数扣减。
- 第一阶段不注册、不启用人机验证，也不设置全站每日生成总量上限。
- 必须提供 `PUBLIC_GENERATION_ENABLED` 运行时止损开关。
- 服务端不长期保存提示词、参考图或生成图片；网络响应丢失后的图片不可恢复是已接受限制。
- 公众模式不向浏览器提供上游地址、密钥和真实模型标识。
- `self-hosted` 模式必须保留当前浏览器直连、渠道配置和本地数据行为。
- 画布、素材和生成记录继续保存在浏览器本地，不宣称支持云同步。
- 不引入 Redis、消息队列、微服务、浏览器指纹或 Capacitor。
- 不修改或提交用户现有的 `web/bun.lock` 改动；依赖安装产生的锁文件变化必须先确认其来源再纳入对应任务。
- 每个阶段只修改本阶段相关文件；用户可感知改动先更新 `CHANGELOG.md`、`docs/content/docs/progress/todo.mdx` 和 `docs/content/docs/progress/pending-test.mdx`，用户确认测试通过后再更新正式功能说明。
- 按项目约束不执行构建；计划中的验证以针对性测试、静态差异检查和人工验收为主。

---

## 执行顺序

### Task 1: 服务端匿名配额与生图代理

**Plan:** `docs/superpowers/plans/2026-07-12-public-image-server.md`

**Produces:** `/api/session`、`/api/quota`、`/api/images/generations`、`/api/images/edits`、数据库迁移、健康检查和公众生图开关。

- [ ] 完成该计划全部任务并通过服务端测试。
- [ ] 记录测试数据库启动方式、迁移命令和接口环境变量。
- [ ] 确认没有前端文件依赖未实现的服务端字段。

### Task 2: 前端公众模式与统一生图调用

**Plan:** `docs/superpowers/plans/2026-07-12-public-image-web-mode.md`

**Consumes:** Task 1 的公开接口和错误码。

**Produces:** `public` / `self-hosted` 双模式、统一生图客户端、额度状态、公众路由和功能裁剪。

- [ ] 完成该计划全部任务并通过前端针对性测试。
- [ ] 在生图页和画布中分别验证公众接口与自部署直连。
- [ ] 检查公众构建配置中不存在密钥变量。

### Task 3: 手机生图与可安装网页应用

**Plan:** `docs/superpowers/plans/2026-07-12-mobile-image-pwa.md`

**Consumes:** Task 2 的公众会话、额度状态和统一生图客户端。

**Produces:** 手机底部导航、固定生成区、结果预览、相机上传、本地数据提示和可安装网页应用。

- [ ] 完成该计划全部任务并通过移动布局相关测试。
- [ ] 在 iPhone Safari 与 Android Chrome 完成主流程人工验收。
- [ ] 验证离线状态只打开网页外壳，不缓存生图请求。

### Task 4: 无限画布触控

**Plan:** `docs/superpowers/plans/2026-07-12-mobile-canvas-touch.md`

**Consumes:** Task 2 的公众模式能力开关和统一生图客户端，Task 3 的手机导航与安全区域变量。

**Produces:** 单指节点操作、空白画布移动、双指缩放移动、底部节点工具栏和手机工具栏收敛。

- [ ] 完成该计划全部任务并通过手势状态机测试。
- [ ] 验证鼠标桌面交互没有回归。
- [ ] 在真实手机上验证节点、画布、底部抽屉和软键盘交互。

### Task 5: Docker、Cloudflare 与上线加固

**Plan:** `docs/superpowers/plans/2026-07-12-public-image-deployment.md`

**Consumes:** Task 1 的接口服务和健康检查，Task 2 的公众构建模式，Task 3 的网页应用静态资源。

**Produces:** 双容器镜像、Nginx 反向代理与频率限制、Cloudflare 源站保护检查、部署说明和试运行清单。

- [ ] 完成该计划全部任务并验证配置文件。
- [ ] 先关闭公众生成部署，再完成迁移和健康检查。
- [ ] 开启小范围流量，验证日志、额度、频率限制和止损开关。

## 阶段门禁

- [ ] Task 1 未稳定前，不改造前端为默认公众调用。
- [ ] Task 2 未同时验证两种模式前，不开始移动端视觉收敛。
- [ ] Task 3 未完成真实手机主流程前，不宣称手机端可用。
- [ ] Task 4 未验证桌面鼠标回归前，不替换现有画布事件处理。
- [ ] Task 5 未完成源站保护前，不对公网开放带额度的接口。

## 最终验收

- [ ] 匿名设备和网络地址的并发请求不能突破 10/30 张额度。
- [ ] 重复 `requestKey` 不重复扣费，失败和超时释放预占。
- [ ] 公众模式没有渠道、视频、WebDAV、Codex 和密钥配置入口。
- [ ] 自部署模式维持现有能力。
- [ ] 手机可完成提示词、拍照或相册参考图、生成、预览、下载和插入画布。
- [ ] 画布可完成单指操作和双指缩放移动。
- [ ] 源站只接受 Cloudflare 流量，生图接口超频返回 429。
- [ ] `PUBLIC_GENERATION_ENABLED=false` 能停止新生成且不影响本地作品使用。
