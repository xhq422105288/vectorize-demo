-- Migration number: 0001 	initial vector id registry
CREATE TABLE IF NOT EXISTS vectors (
	id TEXT PRIMARY KEY,
	namespace TEXT NOT NULL DEFAULT '',
	text TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vectors_namespace ON vectors (namespace);
CREATE INDEX IF NOT EXISTS idx_vectors_created_at ON vectors (created_at);