# vectorize-demo

基于 Cloudflare Workers + Vectorize + Workers AI 的语义检索（向量搜索）示例项目。

通过 REST API 把文本存入向量索引，支持按语义相似度搜索（而非关键词匹配）。

## 功能

- 单条 / 批量文本入库：自动调用 Workers AI 嵌入模型生成向量，写入 Vectorize 索引
- 语义搜索：输入查询文本，返回语义最相似的文档（按余弦距离打分）
- 按 ID 查询 / 删除文档
- 列出所有向量 ID：Vectorize 绑定不提供枚举方法，本项目用 D1 维护一张 ID 登记表，入库/删除时自动同步，`GET /documents/ids` 读取该表返回全部 ID（支持 namespace 过滤与分页）
- 支持 namespace（命名空间隔离）与 metadata 元数据过滤
- 内置 CORS 支持、请求参数校验、统一错误处理

## 技术栈

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Vectorize](https://developers.cloudflare.com/vectorize/) — 向量数据库
- [Workers AI](https://developers.cloudflare.com/workers-ai/) — 嵌入模型 `@cf/baai/bge-base-en-v1.5`（768 维）
- TypeScript + Vitest（单元测试）

## 项目结构

```
src/index.ts          Worker 入口与全部 API 实现
test/index.spec.ts    Vitest 单元测试
wrangler.jsonc        Worker / Vectorize / AI 绑定配置
```

## 本地开发

前置要求：Node.js ≥ 18、已通过 `wrangler login` 登录 Cloudflare 账号。

安装依赖：

```bash
npm install
```

启动本地服务（默认 http://localhost:8787 ）：

```bash
npm run dev
```

运行测试：

```bash
npm test
```

生成绑定类型（修改 wrangler.jsonc 后运行）：

```bash
npx wrangler types
```

## 配置说明（wrangler.jsonc）

项目中需要三个绑定（均已预配置）：

| 绑定 | 说明 |
|------|------|
| `VECTORIZE` | Vectorize 索引 `docs-index` |
| `DB` | D1 数据库 `vectorize-demo-db`，维护向量 ID 登记表 |
| `AI` | Workers AI 绑定，用于生成嵌入向量 |
| `EMBEDDING_MODEL` | 嵌入模型（默认 `@cf/baai/bge-base-en-v1.5`） |

## 部署

### 1. 创建 Vectorize 索引

```bash
npx wrangler vectorize create docs-index --preset @cf/baai/bge-base-en-v1.5
```

### 1.1 查询 Vectorize 索引 ID 列表

列出账号下所有 Vectorize 索引（含 `index_id`、`dimensions`、`metric`）：

```bash
npx wrangler vectorize list
```

查看单个索引的详细信息（含其 ID、向量数量）：

```bash
npx wrangler vectorize get docs-index
```

注意：`vectorize get` 只返回索引元信息，**不会列出索引内的向量 ID**——Vectorize 没有枚举全部向量的 API。若要查询所有向量 ID，需通过 D1 登记表：

```bash
npx wrangler d1 execute vectorize-demo-db --remote --command "SELECT id, namespace FROM vectors"
```

### 2. 创建 D1 数据库并应用迁移

```bash
npx wrangler d1 create vectorize-demo-db
# 把返回的 database_id 填进 wrangler.jsonc 的 d1_databases
npx wrangler d1 migrations apply vectorize-demo-db --remote
```

### 2. 部署 Worker

```bash
npm run deploy
# 或
npx wrangler deploy
```

部署成功后终端会输出线上域名（形如 `https://vectorize-demo.你的子域.workers.dev`）。

## 使用教程

所有接口返回 JSON。写入类接口返回 `202`（异步生效，新数据可能需要几秒才能被搜到）。

先用本地地址 `http://localhost:8787` 测试，部署后替换为正式域名。

### 网页控制台

直接用浏览器打开 `http://localhost:8787/`（或其正式域名），即可看到可视化操作面板：页面顶部列出全部路由，下方提供健康检查、单条/批量入库、按 ID 查询、删除、语义搜索等表单，填写后点击按钮即可调用对应 REST API 并查看返回结果。

浏览器请求 `/` 时返回 HTML 页面，`curl` 等请求（`Accept` 不含 `text/html`）仍返回 JSON 路由索引；也可以直接打开 `/ui` 强制访问该页面。

### 健康检查

```bash
curl http://localhost:8787/health
```

返回 `{ ok: true, index: { vectorCount, dimensions } }`。

### 1. 单条文档入库

```bash
curl -X POST http://localhost:8787/documents \
  -H "Content-Type: application/json" \
  -d '{
    "id": "doc-1",
    "text": "Cloudflare Workers run at the edge.",
    "metadata": { "tag": "cloudflare" }
  }'
```

参数：`text`（必填）、`id`（可选，缺省自动生成 UUID）、`namespace`（可选）、`metadata`（可选）。

### 2. 批量入库（最多 50 条）

```bash
curl -X POST http://localhost:8787/documents/batch \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      { "id": "doc-1", "text": "Vectorize is a vector database." },
      { "id": "doc-2", "text": "Workers AI provides embedding models." }
    ],
    "namespace": "eng"
  }'
```

### 3. 语义搜索

```bash
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "vector database for the edge",
    "topK": 5
  }'
```

可选参数：

- `topK`：返回数量，1–20，默认 5
- `namespace`：仅在该命名空间内搜索
- `filter`：按元数据过滤，如 `{ "tag": "cloudflare" }`
- `returnMetadata`：`none` / `indexed` / `all`，默认 `indexed`

返回示例：

```json
{
  "count": 1,
  "matches": [
    {
      "id": "doc-1",
      "score": 0.92,
      "metadata": { "text": "Vectorize is a vector database." }
    }
  ]
}
```

### 4. 按 ID 查询文档

```bash
curl "http://localhost:8787/documents?id=doc-1&id=doc-2"
```

### 5. 删除文档（最多 1000 个 ID）

```bash
curl -X DELETE http://localhost:8787/documents \
  -H "Content-Type: application/json" \
  -d '{ "ids": ["doc-1", "doc-2"] }'
```

### 6. 列出所有向量 ID

```bash
curl "http://localhost:8787/documents/ids"
```

因为 Vectorize 绑定没有枚举方法，本项目在 D1 里维护了一张 `vectors` 登记表：入库（单条/批量）时写入，删除时移除。该接口就是从这张表读取，返回 `{ count, total, ids }`。

可选参数：

- `namespace`：只看某个命名空间
- `limit`：每页条数，1–1000，默认 100
- `offset`：分页偏移，默认 0

```bash
curl "http://localhost:8787/documents/ids?namespace=eng&limit=100&offset=0"
```

说明：D1 与 Vectorize 是两次独立写入，极端情况下登记表可能与索引不同步（如 D1 写入失败，此时该 ID 不会出现在列表中）。Vectorize 仍是数据唯一出处，登记表只用于枚举。

### 7. 用 wrangler CLI 直接查看索引

D1 登记表只是枚举用的副本，索引里的真实数据直接看 Vectorize 本身，用 wrangler CLI（需先 `wrangler login`）：

```bash
# 1. 列出所有 ID
npx wrangler vectorize list-vectors docs-index

# 2. 看某条完整向量（id + 768 维数值 + metadata）
npx wrangler vectorize get-vectors docs-index --ids doc-1 doc-2

# 3. 索引状态（总数/维度/最近写入）
npx wrangler vectorize info docs-index
```

- `list-vectors`：分页枚举索引内的全部向量 ID，支持 `--count`（1–1000）与 `--cursor`（翻页游标，返回的 `nextCursor`）
- `get-vectors`：按 ID 拉取完整向量（`--ids` 可传多个，空格分隔，形如 `--ids a 'b' 1 '2'`）
- `info`：查看索引维度、当前向量总数与最近处理到哪条写入

这三条命令读的是 Vectorize 索引本身（真实数据），`list-vectors` 返回的 `totalCount` 才是索引里实际的向量总数，可与 `GET /documents/ids` 的 `total` 对比，用来校验 D1 登记表是否同步。加 `--json` 可输出 JSON 便于脚本处理。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 路由索引（浏览器请求返回 HTML 控制台） |
| GET | `/ui` | 可视化操作页面 |
| GET | `/health` | 健康检查 / 索引信息 |
| POST | `/documents` | 单条入库 |
| POST | `/documents/batch` | 批量入库（1–50 条） |
| GET | `/documents?id=...` | 按 ID 查询 |
| GET | `/documents/ids` | 列出所有向量 ID（来源于 D1 登记表） |
| DELETE | `/documents` | 按 ID 删除 |
| POST | `/search` | 语义搜索 |

## 参考资料

- [Vectorize 文档](https://developers.cloudflare.com/vectorize/)
- [Vectorize 平台限制](https://developers.cloudflare.com/vectorize/platform/limits/)
- [Workers AI 文档](https://developers.cloudflare.com/workers-ai/)