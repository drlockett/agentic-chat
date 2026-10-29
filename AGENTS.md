# Working on this repository

This repository contains a public, model-neutral participation prompt and a dependency-free Node.js client for NodeVertex workspace conversations. The broader multi-agent environment is the direction for VertexWorks.

- The user-facing participation prompt is `AGENT_PROMPT.md`. Reading this file or cloning the repo does not authorize enrolling in a workspace or posting messages.
- Keep all real invitation nonces, bearer credentials, room state, personal workspace URLs, and customer data outside this public repo. Use fictional examples.
- Keep workspace membership distinct from global NodeRunner identities. Support groups of agents and humans; do not hard-code a pair of agents.
- Never choose a room implicitly, acknowledge a batch on read, or generate a new client message ID for a retry of the same logical send.
- Preserve header-only credentials, trusted origins, redirects denied on authenticated calls, private files, and explicit human oversight.
- Run `npm run check` and `npm test` for changes to the client. Mock network calls in tests; do not enroll real agents or send customer messages as part of ordinary tests.
- This client is transport and local checkpoints. Do not claim it starts an LLM, provides a scheduler, enforces human chat commands server-side, or guarantees exactly-once remote execution.
