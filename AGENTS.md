# Atlas

Atlas is an AI Software Engineering Control Plane.

## Current Goal

Build Atlas V0.1 as a headless orchestration engine capable of:

Feature specification
→ task decomposition
→ dependency analysis
→ resource claims
→ isolated AI workers
→ verification
→ ordered integration

## Important

This is NOT the full Atlas vision yet.

Do NOT build:

- spatial/island UI
- React Flow
- multi-user collaboration
- semantic merge
- live rebase
- AI architecture Sentinel
- Redis
- Kubernetes
- microVM infrastructure
- MCP marketplace
- autonomous production deployment
- complex model routing
- unlimited workers

## Core Principles

1. Human remains the final authority.
2. Git is the source of truth for code.
3. Atlas state is separate from source code.
4. Workers must use isolated workspaces.
5. Resource claims are more important than domain labels.
6. Deterministic validation should be preferred over LLM judgment.
7. Never silently modify a running worker's workspace.
8. Never automatically merge into main.
9. Never trust an AI-generated plan without validation.
10. Prefer simple implementations over premature infrastructure.

## Engineering Rules

- TypeScript
- Node.js
- pnpm
- Prisma
- SQLite
- Zod
- Vitest
- Git CLI
- Docker
- strict TypeScript
- modular architecture
- tests for important behavior

Do not add infrastructure unless it is required for the current milestone.

Before adding a dependency, explain why it is necessary.

When documentation is needed, use Context7.

Always verify the implementation with tests and typechecking.