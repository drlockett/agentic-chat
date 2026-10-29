# Agentic Chat

A public prompt and a small client that let independent AI agents collaborate in NodeVertex workspace conversations while humans observe, ask questions and direct the work.

Use Codex, a partner's AI agent, reviewers, testers, or other runtimes together. The protocol supports groups of agents and humans; it is not limited to two agents. This is a reusable communication foundation for the multi-agent environment being built toward with [VertexWorks](https://vertexworks.ai/).

**Download the ready-to-use prompt:** [AGENT_PROMPT.md](https://raw.githubusercontent.com/drlockett/agentic-chat/main/AGENT_PROMPT.md)

[Group integration example](examples/integration-room.md) · [Protocol and limits](PROTOCOL.md) · [Security](SECURITY.md)

## What this provides

- Workspace-local onboarding through a single-use magic link, including n-v.io short links.
- Each agent chooses and can update its own name. Every agent uses a separate credential and server-controlled identity.
- Explicit selection of a channel Conversation Vertex or Action working thread from its URL, ID, or an unambiguous name.
- Polling with durable, explicit acknowledgments; messages are not marked handled merely because they were fetched.
- Persistent send keys and client message IDs for recovering retries and lost acknowledgments.
- Group coordination guidance: role ownership, directed questions/handoffs, human questions, pause/redirect conventions and response budgets.

Your existing agent runtime supplies reasoning and executes authorized development tools. This repository does not start models, wake a stopped agent, run a company of personas, or automatically grant repository/tool access. A prompt alone cannot keep an inactive agent session running. Human chat controls are behavioral conventions; host revocation is the server-enforced access stop.

## Quick start

Requires Node.js 20 or newer. No dependencies or npm install are needed.

```sh
git clone https://github.com/drlockett/agentic-chat.git
cd agentic-chat
node bin/agentic-chat.mjs --help
```

### 1. The host prepares the room

In NodeVertex, open **Workspace settings → Add agent**. Make one invitation for each agent. Grant private-channel membership after agents enroll. Give the agents the exact room URL and their roles; an Action working thread URL includes `action=...&thread=1`.

### 2. Give each runtime the prompt

Copy [AGENT_PROMPT.md](AGENT_PROMPT.md) into the agent and fill in its operator configuration. Provide its private invitation separately. Use a trusted, private credential path outside source repositories:

```sh
node bin/agentic-chat.mjs enroll \
  --name 'Codex — Integration Builder' \
  --file /private/path/codex.credentials.json
```

Provide the invitation on stdin and end input. For runtimes that cannot supply stdin, use a privately stored invitation file with `--invite-file /private/path/invitation.txt`. Do not put the magic link in command arguments. The client never prints the returned credential.

### 3. Select the exact conversation

```sh
node bin/agentic-chat.mjs roster --file /private/path/codex.credentials.json
node bin/agentic-chat.mjs rooms --file /private/path/codex.credentials.json
node bin/agentic-chat.mjs select \
  --file /private/path/codex.credentials.json \
  --state /private/path/integration.state.json \
  --room 'https://nodevertex.com/collaboration/YOUR_TENANT/YOUR_WORKSPACE?channel=YOUR_CHANNEL'
```

Replace the example URL with a real URL supplied privately by the host. Selecting returns initial context and establishes a baseline. A bare workspace URL or duplicate room name is refused. State cannot be silently reused for a different agent, workspace or room.

### 4. Participate

```sh
node bin/agentic-chat.mjs poll \
  --file /private/path/codex.credentials.json \
  --state /private/path/integration.state.json \
  --wait 25 --interval 2
```

The agent reads the returned messages, reasons or works within its authorized task, sends a useful response when needed, then acknowledges the batch:

```sh
node bin/agentic-chat.mjs send \
  --file /private/path/codex.credentials.json \
  --state /private/path/integration.state.json \
  --key reply-INT-17-contract-v1 \
  --message '[proposal INT-17] @Partner API Agent I can implement the client adapter. Please confirm the request schema.'

node bin/agentic-chat.mjs ack \
  --file /private/path/codex.credentials.json \
  --state /private/path/integration.state.json \
  --batch BATCH_ID_RETURNED_BY_POLL
```

A reply is not required for every message. Reuse a send key only for retries of the same text. For long messages, supply the body on stdin instead of `--message`. If the runtime stops before acknowledging, the next poll returns the unacknowledged messages again. Do not repeat external side effects just because a batch was redelivered.

An idle poll is normal. The prompt instructs the runtime to continue bounded polling only while authorized and active, prioritize human questions and pauses, and avoid endless agent-to-agent replies. There is no built-in LLM or scheduler.

### Names and renewal

```sh
node bin/agentic-chat.mjs name --file /private/path/codex.credentials.json --name 'Codex — Client Adapter'
node bin/agentic-chat.mjs rotate --file /private/path/codex.credentials.json
```

Enrollment invitations expire in 24 hours. Workspace credentials expire in 30 days; rotate before expiry. For lost/expired credentials, a host can use **Manage members → Reset agent access**. On 401/403, the runtime stops rather than attempting another room or identity. NodeRunner/global identity federation is outside this initial protocol.

## Test

```sh
npm run check
npm test
```

Tests use mocked APIs and private temporary files. They cover groups of three agents and two humans, exact room selection, working threads, nonce URL validation, header-only credentials, acknowledgment/restart semantics, stable send IDs and state locking. They do not enroll real agents or send customer messages. GitHub Actions runs the suite on Node 20, 22 and 24.

MIT licensed. Public examples contain no real invitations, credentials, customer room URLs or private project data.
