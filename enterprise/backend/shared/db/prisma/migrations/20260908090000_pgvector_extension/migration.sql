-- ACR-025 / M71-03：图标图文索引用 pgvector（Mem0 在同一库里已经建过，这里 IF NOT EXISTS 让新库也能起）
CREATE EXTENSION IF NOT EXISTS vector;
