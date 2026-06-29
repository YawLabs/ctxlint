# typed -- layout repro

## 5. Project directory layout

```
apps/
  api/        typed-api: Anthropic-compatible proxy (content/length router)
  indexer/    typed-indexer: Voyage RAG worker
packages/
  db/         Drizzle schema + forward-only migrations
  retrieval/  BM25 + Voyage embeddings + RRF
scripts/      release + build scripts
```

## Stack

- Vitest for unit/integration tests.
- Maintaining skill/agent path references when code moves.
