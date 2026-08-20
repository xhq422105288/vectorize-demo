const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const MAX_BATCH_SIZE = 50;
const MAX_TOP_K = 20;
const MAX_VECTOR_LIST_LIMIT = 1000;
const DEFAULT_VECTOR_LIST_LIMIT = 100;

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

type DocumentInput = {
	id?: string;
	text: string;
	namespace?: string;
	metadata?: Record<string, VectorizeVectorMetadata>;
};

type BatchInput = {
	documents: DocumentInput[];
	namespace?: string;
};

type SearchInput = {
	query: string;
	topK?: number;
	namespace?: string;
	filter?: VectorizeVectorMetadataFilter;
	returnMetadata?: VectorizeMetadataRetrievalLevel;
};

type DeleteInput = {
	ids: string[];
};

type EmbeddingResponse = {
	data: number[][];
};

type VectorMutation = VectorizeVectorMutation | VectorizeAsyncMutation;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly details?: JsonValue,
	) {
		super(message);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			if (request.method === "OPTIONS") {
				return new Response(null, { headers: corsHeaders() });
			}

			const url = new URL(request.url);

			if (request.method === "GET" && url.pathname === "/") {
				const accept = request.headers.get("accept") || "";
				if (accept.includes("text/html")) {
					return html(uiPage());
				}

				return json({
					name: "vectorize-demo",
					routes: [
						"GET /health",
						"POST /documents",
						"POST /documents/batch",
						"GET /documents?id=doc-id",
						"GET /documents/ids",
						"DELETE /documents",
						"POST /search",
					],
				});
			}

			if (request.method === "GET" && url.pathname === "/ui") {
				return html(uiPage());
			}

			if (request.method === "GET" && url.pathname === "/health") {
				const index = await env.VECTORIZE.describe();
				return json({ ok: true, index });
			}

			if (request.method === "POST" && url.pathname === "/documents") {
				const input = validateDocument(await readJson(request));
				const [vector] = await embedTexts(env, [input.text]);
				const document = toVector(input, vector);
				const mutation = await env.VECTORIZE.upsert([document]);

				await syncVectorRegistry(env.DB, (db) =>
					registerVector(db, {
						id: document.id,
						namespace: document.namespace,
						text: input.text,
					}),
				);

				return json(
					{
						ok: true,
						id: document.id,
						mutation: mutationSummary(mutation),
						note: "Vectorize mutations may take a few seconds to appear in search results.",
					},
					{ status: 202 },
				);
			}

			if (request.method === "POST" && url.pathname === "/documents/batch") {
				const input = validateBatch(await readJson(request));
				const embeddings = await embedTexts(
					env,
					input.documents.map((document) => document.text),
				);
				const vectors = input.documents.map((document, index) =>
					toVector({ ...document, namespace: document.namespace ?? input.namespace }, embeddings[index]),
				);
				const mutations = [];

				for (let index = 0; index < vectors.length; index += MAX_BATCH_SIZE) {
					const mutation = await env.VECTORIZE.upsert(vectors.slice(index, index + MAX_BATCH_SIZE));
					mutations.push(mutationSummary(mutation));
				}

				await syncVectorRegistry(env.DB, (db) =>
					registerVectors(
						db,
						vectors.map((vector) => ({
							id: vector.id,
							namespace: vector.namespace,
							text: typeof vector.metadata?.text === "string" ? vector.metadata.text : "",
						})),
					),
				);

				return json(
					{
						ok: true,
						count: vectors.length,
						ids: vectors.map((vector) => vector.id),
						mutations,
						note: "Vectorize mutations may take a few seconds to appear in search results.",
					},
					{ status: 202 },
				);
			}

			if (request.method === "GET" && url.pathname === "/documents") {
				const ids = url.searchParams.getAll("id").filter(Boolean);
				if (ids.length === 0) {
					throw new HttpError(400, "Provide one or more id query parameters.");
				}

				const vectors = await env.VECTORIZE.getByIds(ids);
				return json({ count: vectors.length, vectors });
			}

			if (request.method === "GET" && url.pathname === "/documents/ids") {
				return json(await listVectorIds(env.DB, url));
			}

			if (request.method === "DELETE" && url.pathname === "/documents") {
				const input = validateDelete(await readJson(request));
				const mutation = await env.VECTORIZE.deleteByIds(input.ids);

				await syncVectorRegistry(env.DB, (db) => removeVectors(db, input.ids));

				return json(
					{
						ok: true,
						ids: input.ids,
						mutation: mutationSummary(mutation),
						note: "Vectorize mutations may take a few seconds to appear in search results.",
					},
					{ status: 202 },
				);
			}

			if (request.method === "POST" && url.pathname === "/search") {
				const input = validateSearch(await readJson(request));
				const [queryVector] = await embedTexts(env, [input.query]);
				const matches = await env.VECTORIZE.query(queryVector, {
					topK: input.topK ?? 5,
					namespace: input.namespace,
					filter: input.filter,
					returnMetadata: input.returnMetadata ?? "indexed",
				});

				return json(matches);
			}

			return json({ error: "Not found" }, { status: 404 });
		} catch (error) {
			if (error instanceof HttpError) {
				return json({ error: error.message, details: error.details }, { status: error.status });
			}

			console.error(JSON.stringify({ message: "Unhandled request error", error: String(error) }));
			return json({ error: "Internal server error" }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
	const response = (await env.AI.run(env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL, {
		text: texts,
	})) as EmbeddingResponse;

	if (!Array.isArray(response.data) || response.data.length !== texts.length) {
		throw new HttpError(502, "Embedding model returned an unexpected response.");
	}

	return response.data;
}

function mutationSummary(mutation: VectorMutation) {
	if ("mutationId" in mutation) {
		return { mutationId: mutation.mutationId };
	}

	return { ids: mutation.ids, count: mutation.count };
}

function toVector(input: Required<Pick<DocumentInput, "text">> & DocumentInput, values: number[]): VectorizeVector {
	const id = input.id?.trim() || crypto.randomUUID();
	const metadata: Record<string, VectorizeVectorMetadata> = {
		text: input.text,
		...input.metadata,
	};

	return {
		id,
		values,
		namespace: input.namespace,
		metadata,
	};
}

async function syncVectorRegistry(db: D1Database, action: (db: D1Database) => Promise<void>): Promise<void> {
	try {
		await action(db);
	} catch (error) {
		console.error(
			JSON.stringify({ message: "Failed to sync the vector ID registry", error: String(error) }),
		);
	}
}

async function registerVector(
	db: D1Database,
	vector: { id: string; namespace?: string; text: string },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO vectors (id, namespace, text, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, text = excluded.text, created_at = excluded.created_at`,
		)
		.bind(vector.id, vector.namespace ?? "", vector.text, Date.now())
		.run();
}

async function registerVectors(
	db: D1Database,
	vectors: Array<{ id: string; namespace?: string; text: string }>,
): Promise<void> {
	await db.batch(
		vectors.map((vector) =>
			db
				.prepare(
					`INSERT INTO vectors (id, namespace, text, created_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, text = excluded.text, created_at = excluded.created_at`,
				)
				.bind(vector.id, vector.namespace ?? "", vector.text, Date.now()),
		),
	);
}

async function removeVectors(db: D1Database, ids: string[]): Promise<void> {
	await db.batch(ids.map((id) => db.prepare("DELETE FROM vectors WHERE id = ?").bind(id)));
}

async function listVectorIds(db: D1Database, url: URL): Promise<unknown> {
	const namespace = optionalQueryString(url.searchParams.get("namespace"), "namespace");
	const limit = optionalBoundedInt(
		url.searchParams.get("limit"),
		"limit",
		1,
		MAX_VECTOR_LIST_LIMIT,
		DEFAULT_VECTOR_LIST_LIMIT,
	);
	const offset = optionalBoundedInt(url.searchParams.get("offset"), "offset", 0, null, 0);

	const where = namespace === undefined ? "" : " WHERE namespace = ?";
	const params = namespace === undefined ? [] : [namespace];
	const select = db
		.prepare(`SELECT id FROM vectors${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
		.bind(...params, limit, offset)
		.all<{ id: string }>();
	const count = db
		.prepare(`SELECT COUNT(*) AS total FROM vectors${where}`)
		.bind(...params)
		.first<{ total: number }>();

	const [rows, totalRow] = await Promise.all([select, count]);

	return {
		count: rows.results?.length ?? 0,
		total: totalRow?.total ?? 0,
		ids: (rows.results ?? []).map((row) => row.id),
	};
}

function optionalQueryString(value: string | null, field: string): string | undefined {
	if (value === null) {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new HttpError(400, `Query parameter ${field} must be a non-empty string when provided.`);
	}

	return trimmed;
}

function optionalBoundedInt(
	value: string | null,
	field: string,
	min: number,
	max: number | null,
	fallback: number,
): number {
	if (value === null) {
		return fallback;
	}

	const parsed = Number(value);
	const valid = Number.isInteger(parsed) && parsed >= min && (max === null || parsed <= max);
	if (!valid) {
		throw new HttpError(
			400,
			`Query parameter ${field} must be an integer ${max === null ? `greater than or equal to ${min}` : `between ${min} and ${max}`}.`,
		);
	}

	return parsed;
}

async function readJson(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") || "";
	if (!contentType.includes("application/json")) {
		throw new HttpError(415, "Request body must be application/json.");
	}

	try {
		return await request.json();
	} catch {
		throw new HttpError(400, "Request body is not valid JSON.");
	}
}

function validateDocument(value: unknown): DocumentInput {
	if (!isObject(value)) {
		throw new HttpError(400, "Expected a JSON object.");
	}

	const text = value.text;
	if (typeof text !== "string" || text.trim().length === 0) {
		throw new HttpError(400, "Field text is required.");
	}

	return {
		id: optionalString(value.id, "id"),
		text: text.trim(),
		namespace: optionalString(value.namespace, "namespace"),
		metadata: optionalMetadata(value.metadata),
	};
}

function validateBatch(value: unknown): BatchInput {
	if (!isObject(value) || !Array.isArray(value.documents)) {
		throw new HttpError(400, "Field documents must be an array.");
	}

	if (value.documents.length === 0 || value.documents.length > MAX_BATCH_SIZE) {
		throw new HttpError(400, `Batch size must be between 1 and ${MAX_BATCH_SIZE}.`);
	}

	return {
		documents: value.documents.map(validateDocument),
		namespace: optionalString(value.namespace, "namespace"),
	};
}

function validateSearch(value: unknown): SearchInput {
	if (!isObject(value)) {
		throw new HttpError(400, "Expected a JSON object.");
	}

	const query = value.query;
	if (typeof query !== "string" || query.trim().length === 0) {
		throw new HttpError(400, "Field query is required.");
	}

	const topK = value.topK === undefined ? undefined : Number(value.topK);
	if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K)) {
		throw new HttpError(400, `Field topK must be an integer between 1 and ${MAX_TOP_K}.`);
	}

	return {
		query: query.trim(),
		topK,
		namespace: optionalString(value.namespace, "namespace"),
		filter: optionalFilter(value.filter),
		returnMetadata: optionalReturnMetadata(value.returnMetadata),
	};
}

function validateDelete(value: unknown): DeleteInput {
	if (!isObject(value) || !Array.isArray(value.ids)) {
		throw new HttpError(400, "Field ids must be an array.");
	}

	const ids = value.ids.map((id) => {
		if (typeof id !== "string" || id.trim().length === 0) {
			throw new HttpError(400, "Every id must be a non-empty string.");
		}
		return id.trim();
	});

	if (ids.length === 0 || ids.length > 1000) {
		throw new HttpError(400, "Field ids must contain between 1 and 1000 values.");
	}

	return { ids };
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		throw new HttpError(400, `Field ${field} must be a non-empty string when provided.`);
	}

	return value.trim();
}

function optionalReturnMetadata(value: unknown): VectorizeMetadataRetrievalLevel | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (value === "none" || value === "indexed" || value === "all") {
		return value;
	}

	throw new HttpError(400, "Field returnMetadata must be one of none, indexed, or all.");
}

function optionalMetadata(value: unknown): Record<string, VectorizeVectorMetadata> | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!isObject(value)) {
		throw new HttpError(400, "Field metadata must be an object.");
	}

	return value as Record<string, VectorizeVectorMetadata>;
}

function optionalFilter(value: unknown): VectorizeVectorMetadataFilter | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!isObject(value)) {
		throw new HttpError(400, "Field filter must be an object.");
	}

	return value as VectorizeVectorMetadataFilter;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, {
		...init,
		headers: {
			...corsHeaders(),
			...init.headers,
		},
	});
}

function html(body: string, init: ResponseInit = {}): Response {
	return new Response(body, {
		...init,
		headers: {
			"content-type": "text/html; charset=utf-8",
			...corsHeaders(),
			...init.headers,
		},
	});
}

function corsHeaders(): HeadersInit {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
		"access-control-allow-headers": "content-type",
	};
}

function uiPage(): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vectorize-demo · 控制台</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0d1117; color: #e6edf3; line-height: 1.5; }
	header { padding: 24px 32px; border-bottom: 1px solid #21262d; background: #161b22; }
	header h1 { margin: 0; font-size: 22px; }
	header p { margin: 6px 0 0; color: #8b949e; font-size: 13px; }
	main { padding: 24px 32px; max-width: 1080px; margin: 0 auto; }
	#routes { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
	.route { padding: 6px 10px; border-radius: 6px; background: #161b22; border: 1px solid #30363d; font: 12px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; color: #8b949e; }
	.route b { color: #79c0ff; }
	.card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
	.card h2 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 8px; }
	.card .desc { margin: 0 0 16px; color: #8b949e; font-size: 13px; }
	.badge { font: 12px/1.4 ui-monospace, "Cascadia Code", Consolas, monospace; padding: 2px 8px; border-radius: 999px; }
	.badge.get { background: rgba(46,160,67,.15); color: #56d364; }
	.badge.post { background: rgba(88,166,255,.15); color: #79c0ff; }
	.badge.delete { background: rgba(248,81,73,.15); color: #f85149; }
	.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
	label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8b949e; }
	input, select, textarea { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; font: 13px/1.4 inherit; width: 100%; }
	textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
	button { background: #238636; color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
	button:hover { background: #2ea043; }
	button.secondary { background: #1f6feb; }
	button.secondary:hover { background: #388bfd; }
	.row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
	.hint { font-size: 12px; color: #484f58; }
	pre { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; margin: 12px 0 0; overflow: auto; font: 12px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; white-space: pre-wrap; word-break: break-word; max-height: 340px; }
	pre:empty { display: none; }
	pre.error { color: #f85149; }
</style>
</head>
<body>
<header>
	<h1>vectorize-demo · 控制台</h1>
	<p>基于 Cloudflare Workers + Vectorize + Workers AI 的语义检索演示。下方每个工具都会即时调用对应的 REST API。</p>
</header>
<main>
	<section id="routes"></section>

	<div class="card">
		<h2><span class="badge get">GET</span> /health 健康检查</h2>
		<p class="desc">查看索引名称、维度与当前向量数量。</p>
		<div class="row"><button class="secondary" id="btn-health">检查</button><span class="hint">读取 GET /health</span></div>
		<pre id="out-health"></pre>
	</div>

	<div class="card">
		<h2><span class="badge post">POST</span> /documents 单条入库</h2>
		<p class="desc">将文本嵌入为向量后写入索引（异步生效，返回 202）。</p>
		<div class="grid">
			<label>text * <input id="doc-text" placeholder="要入库的文本内容"></label>
			<label>id <input id="doc-id" placeholder="缺省自动生成 UUID"></label>
			<label>namespace <input id="doc-ns" placeholder="可选"></label>
			<label>metadata (JSON) <input id="doc-meta" placeholder='{"tag":"cloudflare"}'></label>
		</div>
		<div class="row"><button id="btn-doc">入库</button><span class="hint">text 必填</span></div>
		<pre id="out-doc"></pre>
	</div>

	<div class="card">
		<h2><span class="badge post">POST</span> /documents/batch 批量入库</h2>
		<p class="desc">最多 50 条，JSON 数组格式。</p>
		<label>documents (JSON 数组) *
			<textarea id="batch-docs">[{ "id": "doc-1", "text": "Vectorize is a vector database." }, { "id": "doc-2", "text": "Workers AI provides embedding models." }]</textarea>
		</label>
		<div class="grid" style="margin-top:10px">
			<label>namespace <input id="batch-ns" placeholder="可选"></label>
		</div>
		<div class="row"><button id="btn-batch">批量入库</button></div>
		<pre id="out-batch"></pre>
	</div>

	<div class="card">
		<h2><span class="badge get">GET</span> /documents?id=... 按 ID 查询</h2>
		<p class="desc">多个 id 用逗号分隔。</p>
		<label>ids * <input id="get-ids" placeholder="doc-1, doc-2"></label>
		<div class="row"><button class="secondary" id="btn-get">查询</button></div>
		<pre id="out-get"></pre>
	</div>

	<div class="card">
		<h2><span class="badge get">GET</span> /documents/ids 列出所有向量 ID</h2>
		<p class="desc">从 D1 登记表返回全部向量 ID，支持 namespace 过滤与分页。</p>
		<div class="grid">
			<label>namespace <input id="ids-ns" placeholder="可选"></label>
			<label>limit <input id="ids-limit" value="100" placeholder="1-1000"></label>
			<label>offset <input id="ids-offset" value="0" placeholder="0"></label>
		</div>
		<div class="row"><button class="secondary" id="btn-ids">列出</button></div>
		<pre id="out-ids"></pre>
	</div>

	<div class="card">
		<h2><span class="badge delete">DELETE</span> /documents 删除</h2>
		<p class="desc">按 id 删除，最多 1000 个，逗号分隔。</p>
		<label>ids * <input id="del-ids" placeholder="doc-1, doc-2"></label>
		<div class="row"><button id="btn-del">删除</button></div>
		<pre id="out-del"></pre>
	</div>

	<div class="card">
		<h2><span class="badge post">POST</span> /search 语义搜索</h2>
		<p class="desc">按语义相似度返回最相关的文档。</p>
		<div class="grid">
			<label>query * <input id="s-query" placeholder="搜索查询文本"></label>
			<label>topK <input id="s-topk" value="5" placeholder="1-20"></label>
			<label>namespace <input id="s-ns" placeholder="可选"></label>
			<label>returnMetadata
				<select id="s-rm">
					<option value="" selected>indexed (默认)</option>
					<option value="none">none</option>
					<option value="indexed">indexed</option>
					<option value="all">all</option>
				</select>
			</label>
			<label>filter (JSON) <input id="s-filter" placeholder='{"tag":"cloudflare"}'></label>
		</div>
		<div class="row"><button id="btn-search">搜索</button></div>
		<pre id="out-search"></pre>
	</div>
</main>
<script>
	(function () {
		'use strict';
		function el(id) { return document.getElementById(id); }

		function parseJson(raw) {
			return raw ? JSON.parse(raw) : null;
		}

		function show(id, status, data) {
			var pre = el(id);
			var text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
			pre.textContent = status + ' - ' + text;
			pre.classList.toggle('error', status >= 400);
		}

		function callApi(method, path, body, outId) {
			var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
			if (body !== null) {
				opts.body = JSON.stringify(body);
			}
			fetch(path, opts)
				.then(function (res) {
					return res.json().then(function (data) {
						return { status: res.status, data: data };
					});
				})
				.then(function (result) { show(outId, result.status, result.data); })
				.catch(function (err) { show(outId, 0, String(err)); });
		}

		function splitIds(inputId) {
			return el(inputId).value.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
		}

		fetch('/')
			.then(function (res) { return res.json(); })
			.then(function (info) {
				var host = document.getElementById('routes');
				info.routes.forEach(function (r) {
					var parts = r.split(' ', 2);
					var badge = '<span class="badge ' + parts[0].toLowerCase() + '">' + parts[0] + '</span>';
					var node = document.createElement('div');
					node.className = 'route';
					node.innerHTML = badge + ' <b>' + parts[1] + '</b>';
					host.appendChild(node);
				});
			})
			.catch(function () {});

		el('btn-health').addEventListener('click', function () {
			fetch('/health').then(function (res) { return res.json(); }).then(function (data) {
				show('out-health', 200, data);
			}).catch(function (err) { show('out-health', 0, String(err)); });
		});

		el('btn-doc').addEventListener('click', function () {
			var body = { text: el('doc-text').value.trim() };
			if (!body.text) { show('out-doc', 400, { error: 'text 必填' }); return; }
			var id = el('doc-id').value.trim();
			var ns = el('doc-ns').value.trim();
			var metaRaw = el('doc-meta').value.trim();
			if (id) body.id = id;
			if (ns) body.namespace = ns;
			if (metaRaw) {
				try { body.metadata = parseJson(metaRaw); }
				catch (e) { show('out-doc', 400, { error: 'metadata 不是合法 JSON' }); return; }
			}
			callApi('POST', '/documents', body, 'out-doc');
		});

		el('btn-batch').addEventListener('click', function () {
			var docsRaw = el('batch-docs').value.trim();
			if (!docsRaw) { show('out-batch', 400, { error: 'documents 必填' }); return; }
			var ns = el('batch-ns').value.trim();
			var body;
			try { body = { documents: parseJson(docsRaw) }; }
			catch (e) { show('out-batch', 400, { error: 'documents 不是合法 JSON' }); return; }
			if (!Array.isArray(body.documents) || body.documents.length === 0) {
				show('out-batch', 400, { error: 'documents 必须是数组' });
				return;
			}
			if (ns) body.namespace = ns;
			callApi('POST', '/documents/batch', body, 'out-batch');
		});

		el('btn-get').addEventListener('click', function () {
			var ids = splitIds('get-ids');
			if (ids.length === 0) { show('out-get', 400, { error: '请输入至少一个 id' }); return; }
			var qs = ids.map(function (id) { return 'id=' + encodeURIComponent(id); }).join('&');
			callApi('GET', '/documents?' + qs, null, 'out-get');
		});

		el('btn-ids').addEventListener('click', function () {
			var qs = [];
			var ns = el('ids-ns').value.trim();
			var limit = el('ids-limit').value.trim();
			var offset = el('ids-offset').value.trim();
			if (ns) qs.push('namespace=' + encodeURIComponent(ns));
			if (limit) qs.push('limit=' + encodeURIComponent(limit));
			if (offset) qs.push('offset=' + encodeURIComponent(offset));
			callApi('GET', '/documents/ids' + (qs.length ? '?' + qs.join('&') : ''), null, 'out-ids');
		});

		el('btn-del').addEventListener('click', function () {
			var ids = splitIds('del-ids');
			if (ids.length === 0) { show('out-del', 400, { error: '请输入至少一个 id' }); return; }
			callApi('DELETE', '/documents', { ids: ids }, 'out-del');
		});

		el('btn-search').addEventListener('click', function () {
			var body = { query: el('s-query').value.trim() };
			if (!body.query) { show('out-search', 400, { error: 'query 必填' }); return; }
			var topk = el('s-topk').value.trim();
			var ns = el('s-ns').value.trim();
			var rm = el('s-rm').value;
			var filterRaw = el('s-filter').value.trim();
			if (topk) body.topK = Number(topk);
			if (ns) body.namespace = ns;
			if (rm) body.returnMetadata = rm;
			if (filterRaw) {
				try { body.filter = parseJson(filterRaw); }
				catch (e) { show('out-search', 400, { error: 'filter 不是合法 JSON' }); return; }
			}
			callApi('POST', '/search', body, 'out-search');
		});
	})();
</script>
</body>
</html>`;
}
