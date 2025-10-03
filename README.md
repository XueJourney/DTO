# DTO OpenAI-Compatible Proxy

```
██████╗ ████████╗ ██████╗        ██████╗ ████████╗ ██████╗
██╔══██╗╚══██╔══╝██╔═══██╗      ██╔═══██╗╚══██╔══╝██╔═══██╗
██████╔╝   ██║   ██║   ██║█████╗██║   ██║   ██║   ██║   ██║
██╔══██╗   ██║   ██║   ██║╚════╝██║   ██║   ██║   ██║   ██║
██║  ██║   ██║   ╚██████╔╝      ╚██████╔╝   ██║   ╚██████╔╝
╚═╝  ╚═╝   ╚═╝    ╚═════╝        ╚═════╝    ╚═╝    ╚═════╝
```

> **DTO Proxy** —— 将第三方模型接口瞬间伪装成 OpenAI 标准协议，让你的应用无需改动就能切换到自托管/私有模型。自带登录面板、请求审计与统计面板，即使是 0 基础的新手也能轻松上手。

## 📚 目录
- [✨ 为什么选择 DTO Proxy](#-为什么选择-dto-proxy)
- [🧭 架构速览](#-架构速览)
- [🚀 15 分钟启动指南](#-15-分钟启动指南)
- [⚙️ 环境变量配置说明](#️-环境变量配置说明)
- [🛡️ 默认安全策略](#️-默认安全策略)
- [🧠 API 调用示例](#-api-调用示例)
- [🗃️ 数据表结构](#️-数据表结构)
- [📊 监控与调试](#-监控与调试)
- [🧩 常见扩展场景](#-常见扩展场景)
- [🧑‍💻 面向 0 基础开发者的贴心提示](#-面向-0-基础开发者的贴心提示)
- [🧹 提交前自检清单](#-提交前自检清单)
- [❓ 常见问题 FAQ](#-常见问题-faq)
- [🤝 参与贡献](#-参与贡献)
- [📄 许可证](#-许可证)

## ✨ 为什么选择 DTO Proxy
- **OpenAI 协议即插即用**：完全兼容 `/v1/chat/completions`、`/v1/models` 等接口，前后端无需改动即可接入第三方模型。
- **安全优先**：支持基于 `scrypt` 的后台密码哈希、可配置 Session Secret、细粒度的请求审计，防止凭据泄露。
- **可视化管理面板**：内置登录页与日志面板，查看实时请求、状态码分布、失败原因等关键指标。
- **稳定的数据库持久化**：MySQL 连接池自动重连，支持请求日志与每日统计双表存储。
- **灵活的模型映射**：使用 `MODEL_MAPPING_JSON` 环境变量即可自定义模型别名映射，快速兼容不同供应商。
- **为团队协作而生**：附带提交前自检清单与安全审查建议，帮助团队保持高质量交付。

## 🧭 架构速览
```text
┌─────────┐      ┌──────────────┐      ┌───────────┐
│  Client │──▶──│ DTO Proxy API │──▶──│ Upstream   │
│ (OpenAI │     │  (Express)    │     │ AI Provider│
│  SDK)   │◀───▶│              │◀───▶│ API        │
└─────────┘      └──────────────┘      └───────────┘
      │                 │
      │                 └──► MySQL (request_logs & api_statistics)
      └──► 浏览器访问登录页（受 Session 保护的静态资源）
```

## 🚀 15 分钟启动指南
1. **克隆并安装依赖**
   ```bash
   git clone https://github.com/your-account/DTO.git
   cd DTO
   npm install   # 或者 yarn
   ```

2. **初始化配置文件**
   ```bash
   cp .env.example .env
   ```
   按照下一章节的说明填写数据库、上游接口和后台账号配置。

3. **为后台账户生成安全哈希**（可选但强烈推荐）
   ```bash
   npm run hash-password myStrongPassword!
   ```
   复制输出的 `AUTH_PASSWORD_SALT` 与 `AUTH_PASSWORD_HASH` 到 `.env` 中，并删除明文密码配置。

4. **启动开发环境**
   ```bash
   npm run dev
   ```
   默认监听 `http://localhost:3000`。使用生产环境时建议改用 `npm start` 并配合进程守护/反向代理。

5. **首次登录**
   - 浏览器访问 `http://localhost:3000`，根据 `.env` 中的后台账号信息登录。
   - 登录后自动跳转到日志面板，实时查看请求详情。

## ⚙️ 环境变量配置说明
`.env.example` 覆盖了常用配置项，以下为关键变量速览：

| 变量名 | 说明 | 默认值 |
| ------ | ---- | ------ |
| `PORT` | 监听端口 | `3000` |
| `SESSION_SECRET` | Session 签名密钥（强烈建议自定义） | 随机临时值 |
| `AUTH_USERNAME` | 登录用户名 | `admin` |
| `AUTH_PASSWORD` | 登录密码（明文，建议仅在本地使用） | `change-me` |
| `AUTH_PASSWORD_SALT` / `AUTH_PASSWORD_HASH` | 登录密码哈希（与上面二选一） | 空 |
| `UPSTREAM_API_URL` | 第三方模型兼容接口地址 | Demo 接口 |
| `UPSTREAM_DEFAULT_MODEL` | 默认模型别名 | `nalang-xl-10` |
| `MODEL_MAPPING_JSON` | 模型映射 JSON，例如 `{ "gpt-4": "custom-model" }` | 空 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | MySQL 连接信息 | `localhost:3306`, `dto_proxy` |
| `DB_CHARSET` | 字符集 | `utf8mb4` |
| `DB_TIMEZONE` | 时区 | `+08:00` |

> ✨ 温馨提示：未配置 `AUTH_PASSWORD_HASH` 时，系统会自动降级到安全加盐哈希对比，但仍会打印警告，提醒你尽快启用哈希存储。

## 🛡️ 默认安全策略
- **强制 Session 保护**：所有 `/api/*` 接口默认需要认证，否则返回 `401` JSON。
- **安全密码校验**：默认使用 `scrypt` + `timingSafeEqual` 校验密码哈希，防止时序攻击。
- **环境变量优先**：不在代码中硬编码任何敏感信息，全部通过 `.env` 或部署平台注入。
- **日志脱敏建议**：请求/响应全文均可存储在数据库，若包含敏感字段请在上线前进行字段脱敏或裁剪。
- **安全告警**：启动时若发现默认凭据或缺失哈希，会输出显眼的警告信息，避免误用默认配置。

更多安全审查建议请参考 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)。

## 🧠 API 调用示例
无论是后端还是浏览器，只需像调用 OpenAI 一样访问代理地址：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_UPSTREAM_TOKEN" \
  -d '{
        "model": "gpt-4",
        "stream": false,
        "messages": [
          {"role": "user", "content": "你好，帮我写一个故事大纲"}
        ]
      }'
```

- **流式响应**：设置 `"stream": true`，代理会转发 SSE 流并追加符合 OpenAI 规范的 `[DONE]` 结束标记。
- **模型映射**：`gpt-4` 会自动映射为 `.env` 中定义的第三方模型代号，可用于兼容自研模型或厂商模型。

## 🗃️ 数据表结构
### `request_logs`
| 字段 | 描述 |
| ---- | ---- |
| `id` | 自增主键 |
| `request_id` | 请求唯一 ID |
| `client_ip` | 客户端 IP（自动缓存列存在状态） |
| `request_method` / `request_path` | HTTP 方法与路径 |
| `request_headers` / `request_body` | 请求头与请求体快照 |
| `response_status` / `response_body` | 响应码与响应体（超长时会截断） |
| `response_time` | 请求耗时（毫秒） |
| `error_message` | 错误描述 |
| `created_at` / `updated_at` | 时间戳 |

### `api_statistics`
| 字段 | 描述 |
| ---- | ---- |
| `date_key` | 日期维度（唯一键） |
| `total_requests` | 当日请求总数 |
| `successful_requests` / `failed_requests` | 成功与失败次数 |
| `avg_response_time` | 平均响应时间（毫秒） |
| `total_tokens` | 估算 Token 总数 |
| `unique_ips` | 当日独立 IP 数量（若 `client_ip` 列缺失则回退为 0/1） |

## 📊 监控与调试
- `GET /api/logs`：分页查询请求日志，支持 `status`、`ip`、`search` 查询条件。
- `GET /api/stats`：返回历史统计、当日指标与 Top IP。
- `GET /health`：健康检查，返回运行状态与进程 uptime。
- `GET /v1/models`：列出当前支持的模型清单。

日志中间件会自动捕获非流式响应内容、SSE 标记与错误事件，方便排查问题。

## 🧩 常见扩展场景
- **自定义鉴权**：将 `verifyCredentials` 替换为 OAuth/JWT 校验逻辑。
- **多数据源记录**：在 `logRequest` 中追加消息队列或 ELK 管道。
- **指标上报**：在 `updateStatistics` 中追加 Prometheus/Grafana 指标。
- **模型调度**：扩展 `MODEL_MAPPING_JSON`，根据请求上下文动态选择供应商。

## 🧑‍💻 面向 0 基础开发者的贴心提示
1. **不确定怎么部署？** 先在本地验证，再使用 Docker 或 PM2 搭配 Nginx 反向代理上线。
2. **数据库不会建？** 启动时若数据库为空，程序会自动执行建表语句。把配置改成你自己的实例即可。
3. **调试遇到 401？** 检查是否已登录后台，或是否在请求头中携带了正确的 `Authorization: Bearer xxx`。
4. **想看原始响应？** 控制台会输出每次请求的状态码、耗时和 IP，数据库中则保留请求/响应快照。

## 🧹 提交前自检清单
每次准备上线或提交 PR 前，建议对照 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) 完成以下动作：
- ✅ 代码风格与逻辑自检
- ✅ 数据库迁移/兼容性确认
- ✅ 敏感信息脱敏与日志策略检查
- ✅ 环境变量、密钥与默认账号安全审查
- ✅ 手动或自动化冒烟测试记录

该清单也适合作为团队 Code Review 的辅助文档。

## ❓ 常见问题 FAQ
**Q: 没有 MySQL 可以跑吗？**
> 当前版本默认依赖 MySQL，如需使用 SQLite/PostgreSQL，请自行实现 `executeQuery` 兼容层。

**Q: 可以只读不写数据库吗？**
> 可以，将日志与统计调用替换为你自己的实现即可，但会失去面板功能。

**Q: 如何拓展更多接口？**
> 参考 `handleChatCompletion` 的实现模式，在新路由中做参数映射和响应格式化即可。

## 🤝 参与贡献
1. Fork 本仓库并创建特性分支：`git checkout -b feat/amazing-feature`
2. 完成开发后请执行 [🧹 提交前自检清单](#-提交前自检清单)
3. 提交 PR 时附上变更说明、测试情况与风险评估

欢迎通过 Issue/PR 反馈问题或分享你的使用场景！

## 📄 许可证
本项目基于 [GPL-3.0](./LICENSE) 许可证开源。使用、修改和分发时请确保遵循相关条款。

---
> Crafted with ❤️ for developers who need a trustworthy OpenAI-compatible gateway.
