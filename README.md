# TypingMind Private Sync

独立开发的 TypingMind 扩展，使用自己的 WebDAV 或 S3 兼容存储，实现加密同步、备份与恢复，不修改 TypingMind 本体。

**实验性软件，不要直接用于正式聊天或作为唯一备份。** 日常使用 S3 同步不需要安装 Node.js 或运行本地服务；Node.js 仅用于开发和构建。某些 WebDAV 服务可能需要自行部署网关，但网关不能修复存储服务缺少安全条件写的问题。

## 两种同步协议

| 协议 | 适用存储 | 并发保护 |
|---|---|---|
| Snapshot（默认） | WebDAV、S3 | 三方合并、删除标记和强 ETag 条件写；不支持条件写的服务会被拒绝 |
| Immutable S3 log（实验模式） | S3 | 加密、内容寻址的不可变提交与因果关系；同记录冲突必须明确选择版本 |

日志模式不使用共享可变索引，也不依赖条件 PUT。同一记录的不同并发修改及删除/编辑冲突不会静默覆盖；不同记录的独立修改可以合并。恢复备份先只影响本地，后续同步才发布恢复结果。

## 开发与验证

需要 Node.js 24+：

```powershell
npm ci
npx playwright install chromium --only-shell
npm run check
```

`check` 包含类型检查、ESLint、构建、单元测试、HTTP 集成测试和隔离 Chromium 测试。测试使用虚构数据与本机模拟存储，不使用个人存储凭据。

可选的真实 TypingMind 页面验收：

```powershell
npm run test:live
```

这些测试访问 TypingMind 网站，但使用全新、非持久化浏览器上下文和模拟存储，不读取日常浏览器、不输入许可证或模型密钥、不调用模型。测试依赖上游网页 UI 和网络，不等于真实存储兼容性或完整数据覆盖的证明。

## 构建和 GitHub Pages

普通开发构建：

```powershell
npm run build
```

输出扩展 `dist\typingmind-private-sync.js` 和可选网关 `dist\koofr-gateway.mjs`。

只构建可公开托管的扩展：

```powershell
npm run build:pages
```

`pages-dist` 中只生成扩展 JS，不包含 source map、网关、配置文件或测试记录。目录内出现其他文件或链接时会停止，不会自动删除它们。

仓库提供手动 GitHub Pages 工作流：

1. 在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 在 **Actions → Publish extension to GitHub Pages → Run workflow** 手动运行。
3. 等待检查、构建和部署通过，从工作流摘要复制完整 JS URL。

push 不会自动发布。工作流不需要任何存储或加密口令等 Actions secrets，只上传 `pages-dist`，不运行真实存储测试。GitHub Pages 的脚本是公开文件，不要把任何凭据或个人配置写进源码、构建变量或发布目录。

典型脚本地址：

```text
https://<GitHub-owner>.github.io/<repository>/typingmind-private-sync.js
```

站点只发布 JS，没有首页，因此根路径可能返回 `404`。部署后必须独立验证完整脚本 URL 的 HTTPS、响应状态、JavaScript MIME 和浏览器 CORS。

## 首次安装与隔离试用

1. 在正式 TypingMind 中使用官方 **Settings → App data & storage → Export**，独立保存备份。不要清空日常浏览器数据。
2. 新建隔离的浏览器配置，只创建少量虚构聊天和附件；关闭官方 Cloud Sync 和其他同步扩展。
3. 在 **Preferences → Advanced Settings → Extensions** 添加托管脚本 URL，刷新页面。
4. 点击右下角 **Private Sync**，选择存储和协议。所有设备必须使用相同的端点、bucket、专用 prefix、排除列表和加密口令。
5. 日志模式还需相同 dataset ID：只生成一次，复制到其他设备，不要每台设备单独生成。
6. 点击 **Unlock / connect**，再运行 **Test storage**。日志模式此操作仅验证枚举和已有提交读取，不验证写入权限。
7. 使用虚构数据手动 **Sync now**，在第二个隔离浏览器验证聊天、附件、修改、删除、冲突选择和备份恢复。
8. **接收远端写入、冲突应用、恢复或回滚后立即刷新 TypingMind。** 操作期间停止聊天并关闭其他 TypingMind 标签页。每次刷新后需重新输入凭据和口令。

切换协议、存储、prefix 或 dataset ID 不会自动迁移数据。不要把已有日志当作快照数据集使用，也不要删除仍有设备依赖的提交历史。

## S3 配置与权限

采用 path-style 寻址。endpoint 不要重复包含 bucket 或 prefix，例如使用通用占位配置：

```text
Endpoint: https://s3.example.com
Bucket: example-bucket
Region: <your-region>
Prefix: typingmind-isolated-test
```

日志模式在 `<prefix>/commits/` 和 `<prefix>/backups/` 下保存加密对象，需要这些命名空间的限定枚举以及对象 GET/PUT 权限。S3 为 `ListBucket`（使用 `s3:prefix` 限制范围）、`GetObject` 和 `PutObject`；某些服务将枚举权限称为 `listFiles`。

浏览器签名请求需要存储服务允许相应 CORS。日志模式示例：

```json
[
  {
    "AllowedOrigins": ["https://www.typingmind.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": [
      "authorization",
      "content-type",
      "x-amz-content-sha256",
      "x-amz-date"
    ],
    "MaxAgeSeconds": 600
  }
]
```

如使用临时凭据，还需允许相应 session token 请求头。此示例不能代替特定服务的配置文档和实测，也不授予公开读取权限。

快照模式另需安全的 `If-Match` / `If-None-Match` 条件写、可读取的强 ETag，以及探测清理所需 DELETE 权限和相应 CORS。不要为兼容某个服务而移除条件头或降低安全检查。

## WebDAV 和可选网关

WebDAV 需要 HTTPS、Basic 认证、GET/PUT/DELETE/MKCOL、正确的条件写及浏览器 CORS。HTTPS TypingMind 页面不能直接访问不安全的 HTTP NAS。

如果服务不允许浏览器跨域访问，可选网关会固定上游位置、限制路径并隔离浏览器和上游凭据。先复制 `gateway.env.example` 为被忽略的 `.env.gateway.local`，在本机填写专用凭据，再运行：

```powershell
npm run build
npm run gateway
```

该命令用于明确选择网关方案的部署，不是 S3 日常使用的要求。网关默认只用于本机监听，外部使用需自行配置受信任的 HTTPS 反向代理。不要开放未加 TLS 的公网端口、使用陌生公共代理或关闭浏览器安全检查。

## 隐私与恢复

数据在浏览器加密后上传，使用 PBKDF2 派生密钥和 AES-GCM。口令遗失无法由本项目恢复；加密也不能防止受感染设备或其他恶意扩展读取已解锁数据。

不要提交 `.env*`、`*.local`、真实聊天、凭据、个人 endpoint/bucket 配置或本机验收记录。`.gitignore` 不会保护已经被 Git 跟踪的文件。

异常时先从 TypingMind 扩展设置移除脚本 URL 并刷新，停止后续加载。这不会撤销已同步的数据。可通过 Pages 设置取消公开托管，或重新发布已知正常版本；真实数据恢复应独立审阅备份，不由部署工作流自动执行。

## 已知限制

- 没有稳定公开的 TypingMind 内部存储 schema；项目资料、记忆、RAG 文件及额外数据库未确认完整覆盖。
- 日志模式读取全部历史，最多允许 1000 个提交，尚无历史压缩或清理，不适合长期大规模使用。
- 扩展不会自动删除历史提交或备份；存储服务的版本保留可能继续占用空间。
- 缺失历史、错误口令、密文损坏、数据集不匹配和不安全条件写都会明确停止，不应绕过保护。
- 本地回滚和写后验证不能阻止其他标签页或应用旧内存状态随后覆盖数据，因此接收结果后必须立即刷新。
- 存储服务是否“S3 兼容”不足以证明可用；须独立验证权限、CORS、分页、读写和并发行为。
