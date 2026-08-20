import { createExecutionContext, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function createEnv(): Env {
	const vectorize = {
		describe: async () => ({ vectorCount: 2, dimensions: 768 }),
		upsert: async (vectors: VectorizeVector[]) => ({
			ids: vectors.map((vector) => vector.id),
			count: vectors.length,
		}),
		insert: async (vectors: VectorizeVector[]) => ({
			ids: vectors.map((vector) => vector.id),
			count: vectors.length,
		}),
		deleteByIds: async (ids: string[]) => ({ ids, count: ids.length }),
		getByIds: async (ids: string[]) =>
			ids.map((id) => ({
				id,
				values: [0.1, 0.2, 0.3],
				metadata: { text: `stored ${id}` },
			})),
		query: async () => ({
			count: 1,
			matches: [
				{
					id: "doc-1",
					score: 0.92,
					metadata: { text: "Cloudflare Workers run at the edge." },
				},
			],
		}),
		queryById: async () => ({ count: 0, matches: [] }),
	};

	const ai = {
		run: async (_model: string, input: { text: string[] }) => ({
			data: input.text.map(() => [0.1, 0.2, 0.3]),
		}),
	};

	return {
		VECTORIZE: vectorize,
		AI: ai,
		EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
		DB: testEnv.DB,
	};
}

async function fetchWorker(request: Request, env = createEnv()) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("vectorize demo worker", () => {
	it("returns the route index", async () => {
		const response = await fetchWorker(new IncomingRequest("http://example.com/"));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ name: "vectorize-demo" });
	});

	it("serves the HTML console for browser requests", async () => {
		const response = await fetchWorker(
			new IncomingRequest("http://example.com/", {
				headers: { accept: "text/html" },
			}),
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(body).toContain("vectorize-demo");
		expect(body).toContain("btn-search");
	});

	it("serves the HTML console at /ui", async () => {
		const response = await fetchWorker(new IncomingRequest("http://example.com/ui"));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
	});

	it("describes the Vectorize index", async () => {
		const response = await fetchWorker(new IncomingRequest("http://example.com/health"));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			ok: true,
			index: { vectorCount: 2, dimensions: 768 },
		});
	});

	it("upserts one document", async () => {
		const response = await fetchWorker(
			new IncomingRequest("http://example.com/documents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "doc-1", text: "Workers can use Vectorize." }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(202);
		expect(body).toMatchObject({
			ok: true,
			id: "doc-1",
			mutation: { ids: ["doc-1"], count: 1 },
		});
	});

	it("searches by query text", async () => {
		const response = await fetchWorker(
			new IncomingRequest("http://example.com/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "edge vector search", topK: 3 }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			count: 1,
			matches: [{ id: "doc-1", score: 0.92 }],
		});
	});

	it("rejects invalid search payloads", async () => {
		const response = await fetchWorker(
			new IncomingRequest("http://example.com/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "x", topK: 100 }),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "Field topK must be an integer between 1 and 20.",
		});
	});

	it("lists all vector ids from the D1 registry", async () => {
		for (const id of ["doc-1", "doc-2"]) {
			await fetchWorker(
				new IncomingRequest("http://example.com/documents", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id, text: `hello ${id}` }),
				}),
			);
		}

		const response = await fetchWorker(new IncomingRequest("http://example.com/documents/ids"));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			count: 2,
			total: 2,
			ids: expect.arrayContaining(["doc-1", "doc-2"]),
		});
	});

	it("filters ids by namespace and supports pagination", async () => {
		await fetchWorker(
			new IncomingRequest("http://example.com/documents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "eng-1", text: "english doc", namespace: "eng" }),
			}),
		);
		await fetchWorker(
			new IncomingRequest("http://example.com/documents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "fra-1", text: "french doc", namespace: "fra" }),
			}),
		);

		const response = await fetchWorker(
			new IncomingRequest("http://example.com/documents/ids?namespace=eng&limit=1&offset=0"),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ count: 1, total: 1, ids: ["eng-1"] });
	});

	it("rejects invalid list query parameters", async () => {
		const response = await fetchWorker(
			new IncomingRequest("http://example.com/documents/ids?limit=100000"),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "Query parameter limit must be an integer between 1 and 1000.",
		});
	});

	it("removes ids from the registry on delete", async () => {
		await fetchWorker(
			new IncomingRequest("http://example.com/documents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "doc-1", text: "to be deleted" }),
			}),
		);

		const del = await fetchWorker(
			new IncomingRequest("http://example.com/documents", {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids: ["doc-1"] }),
			}),
		);
		expect(del.status).toBe(202);

		const list = await fetchWorker(new IncomingRequest("http://example.com/documents/ids"));
		const body = await list.json();

		expect(body).toMatchObject({ count: 0, total: 0, ids: [] });
	});
});
