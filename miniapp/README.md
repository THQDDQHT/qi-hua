# 啟画微信小程序（miniapp/）

啟画的微信小程序裁剪版：打开即用的单页生图应用。AI 请求全部经过 `server/` 中转（服务端托管 AI key、匿名设备配额），小程序用户无需填 key。

## 功能

- 打开即生图：文生图 / 图生图（单张、参考图 ≤1 张），尺寸/质量选择，任务轮询，历史记录仅存本机
- 保存到相册、设为参考图、长按操作菜单、底部清除本地记录
- 导出图片由服务端写入 AI 生成文件元数据；结果卡片和预览页展示生成内容声明，首次生成前展示使用规则

## 快速开始

```bash
cd miniapp
bun install          # 或 npm install
bun run dev:weapp    # 监听构建到 dist/
```

然后用微信开发者工具「导入项目」选择 `miniapp/` 目录（项目根指向这里，小程序代码在 `dist/`）。

## 上线前配置清单

1. **AppID**：把 `project.config.json` 的 `appid` 从 `touristappid` 换成你的小程序 AppID（或用 `.env.development` / `.env.production` 里的 `TARO_APP_ID`）。
2. **服务地址**：把 `src/shared/config.ts` 里的 `DEFAULT_SERVER_BASE_URL` 改成部署了 `server/` 的正式域名（域名写死在代码里，终端用户无感知，小程序内没有设置页）。
3. **合法域名**：小程序后台「开发管理 → 服务器域名」把同一服务域名加入 `request`、`uploadFile` 与 `downloadFile` 合法域名（需 HTTPS + 已备案）。
4. **隐私保护指引**：在小程序后台声明“选中的照片或视频信息”（选择参考图）和“相册（仅写入）”（保存生成图），说明提示词和参考图会上传至啟画服务端并发送给实际使用的生图服务供应商；任务结束后提示词会从任务数据清除，参考图和结果文件默认在 24 小时内清理，小程序历史记录和已下载图片保存在本机。按实际供应商补充第三方处理说明，提交审核前必须发布指引。
5. **生成内容规则**：保留首次生成前的使用规则确认、结果图下方的生成内容声明和页面底部入口；服务端继续写入 AI 生成文件元数据。
6. **类目与资质**：涉及生成式人工智能内容，按主体实际资质选择类目并准备审核材料；小程序名称/简介继续使用“啟画”，避免“AI 绘画”等审核敏感词。
7. **server 端**：重新构建并部署 `server/` 镜像（小程序用到 `POST /api/miniapp/session` 和 `/api/images/*`）。

## 参考 nginx 配置（已备案域名 → server）

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;
    # ssl_certificate / ssl_certificate_key 略

    client_max_body_size 22m;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        add_header Cache-Control "no-store" always;
    }
}
```

小程序请求自带 `X-Miniapp-Token` 头，server 端会豁免 Origin / CF-Connecting-IP 校验，按设备维度限额（每日 10 张，与公众版共用 `anonymous_clients` 表）。

## 本地开发提示

- 真机预览前：微信开发者工具「详情 → 本地设置」勾选「不校验合法域名」，可用 http 局域网地址联调。
- 图片存于小程序用户文件目录（`wx.env.USER_DATA_PATH/gen-images/`），删除单条记录或底部「清除本地记录」会连带删除文件。
- 构建与真机验证由人工执行；提交代码前不需要本地跑构建。
