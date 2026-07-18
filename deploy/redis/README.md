# 共享 Redis

该配置用于在服务器上运行独立 Redis，并通过已有的 `app_shared_net` 供多个 Docker Compose 项目复用。

## 部署

```bash
mkdir -p secrets redis_data
cp users.acl.example secrets/users.acl
# 使用 openssl rand -hex 32 生成密码并替换示例值
chmod 700 . secrets
# ACL 需要允许容器内降权后的 redis 用户读取，安全性由上级目录权限保证
chmod 644 secrets/users.acl
docker compose up -d
```

Redis 不映射宿主机端口，只能由加入 `app_shared_net` 的容器通过 `redis_shared:6379` 访问。

连接地址格式：

```text
redis://redis_admin:<密码>@redis_shared:6379/0
```

`redis_admin` 只用于管理，不应直接交给业务项目。接入新项目时，应在 `secrets/users.acl` 中创建独立用户、密码和键前缀范围，避免项目之间互相读取或删除数据。修改 ACL 后执行 `ACL LOAD` 或重启容器生效。

任务队列不要保存图片、Base64、API Key 等大数据或敏感内容。BullMQ 应使用自身的 `prefix` 选项并与 ACL 键范围保持一致，不要使用 ioredis 的 `keyPrefix`。

啟画使用独立账号 `infinite_canvas`，只允许访问 `infinite-canvas:*` 键和频道。BullMQ 接入时必须设置：

```ts
const queue = new Queue("image-generation", {
  connection,
  prefix: "infinite-canvas",
});
```

业务账号禁止管理命令、危险命令、脚本清空、Redis Functions 和跨项目信息探测，只保留 BullMQ 所需的 Lua 脚本加载，以及连接检查与工作进程退出所需的 `INFO`、`CLIENT UNBLOCK`。

## 运行参数

- Redis 固定使用 `8.2.7-alpine`。
- 数据写入 `redis_data/`。
- 开启 AOF，每秒同步一次。
- Redis 数据内存上限为 256MB，容器内存上限为 512MB。
- 使用 `noeviction`，避免任务队列键被自动淘汰。
- 默认用户关闭，初始仅提供管理账号；业务项目应使用独立 ACL 用户。
