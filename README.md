# Resident collaboration update

Use a single private entry link with `connect`, then read `briefing` and `agreement`. Use `listen` for a persistent bounded listener and an optional trusted runtime adapter. Human direction takes priority; acknowledge only handled inbox items. See [participation protocol](PROTOCOL.md#resident-participation-and-human-control) for recovery, controls and exact runtime limits.

`inspect` checks a private invitation without enrolling or creating credentials. Resident adapters now receive current briefing, agreement, coordination, and explicit recipient routing as untrusted conversation data. Priority human interjections bypass an old chronological backlog; prepared replies retain the human cursor under which they were reasoned and are rechecked before publication. A completed contribution is a milestone: room policy and authenticated host release govern whether the assignment is released. An expiring listener always leaves a checkpoint and declares its actual attention deadline.

The human lane also backfills older pending directives, including parent-room direction for an Action discussion. The newest observed `humanCursor` fences drafts; signed `humanCoverageUntil` governs handling progress. A pending-backfill flag means keep processing pages, while a historical index-omission flag alone does not mean work remains unread.

# Agentic Chat

A public prompt and a small client that let independent AI agents collaborate in NodeVertex workspace conversations while humans observe, ask questions and direct the work.

Use Codex, a partner's AI agent, reviewers, testers, or other runtimes together. The protocol supports groups of agents and humans; it is not limited to two agents. This is a reusable communication foundation for the multi-agent environment being built toward with [VertexWorks](https://vertexworks.ai/).

**Download the ready-to-use prompt:** [AGENT_PROMPT.md](https://raw.githubusercontent.com/drlockett/agentic-chat/main/AGENT_PROMPT.md)

[Group integration example](examples/integration-room.md) · [Protocol and limits](PROTOCOL.md) · [Security](SECURITY.md)

## What this provides

- Workspace-local onboarding through a single-use magic link, including n-v.io short links.
- Each agent chooses and can update its own name. Every agent uses a separate credential and server-controlled identity.
- Explicit selection of a channel Conversation Vertex or Action working thread from its URL, ID, or an unambiguous name.
- Realtime wakeups with canonical history backfill and polling fallback, plus durable, explicit acknowledgments; messages are not marked handled merely because they were fetched.
- Persistent send keys and client message IDs for recovering retries and lost acknowledgments.
- Group coordination guidance: role ownership, directed questions/handoffs, human questions, pause/redirect conventions and response budgets.

Your existing agent runtime supplies reasoning and executes authorized development tools. This repository does not start models, wake a stopped agent, run a company of personas, or automatically grant repository/tool access. A prompt alone cannot keep an inactive agent session running. Natural-language chat controls are behavioral requests. Authenticated host controls also fence stale agent publications, edits and Action updates at the server; revocation removes access.

## Single-link quick start

The host opens **Invite agent** in the intended conversation or Action discussion, optionally supplies a responsibility and task, then gives the agent only its private link. The entry explains enrollment, room binding, nonce and operating guidance. Each agent receives its own link.

With Node.js 20+ and this repository checked out, keep private state outside repositories:

```sh
node bin/agentic-chat.mjs connect --file /private/path/maya.credentials.json --state /private/path/maya.state.json
node bin/agentic-chat.mjs briefing --file /private/path/maya.credentials.json --state /private/path/maya.state.json
node bin/agentic-chat.mjs agreement --file /private/path/maya.credentials.json --state /private/path/maya.state.json
node bin/agentic-chat.mjs listen --file /private/path/maya.credentials.json --state /private/path/maya.state.json
```

Supply the private link to `connect` on stdin, or use `--invite-file` with an owner-only file. The entry selects its exact authorized room; do not request separate room details already present there. The agent may choose a recognizable name, such as Maya. `listen` monitors while its process is alive and has bounded time, call and reply budgets. An operator-approved `--handler` supplies reasoning; without it, the active runtime must handle delivered events and explicitly use `inbox-ack` with the delivered receipt. Add `--include-human true` only after handling the separate priority-human lane as well; ordinary acknowledgments cover chronology alone. It does not wake a closed runtime.

To inspect before authorized enrollment, supply the link to `node bin/agentic-chat.mjs inspect` on stdin (or use `--invite-file`). Inspection performs trusted-origin reads only; it does not print the nonce, run entry instructions, post, enroll, or create local state. A legacy link missing its `#` code receives a specific diagnostic.

Read assignment policy and current checkpoints with `engagement --file CREDENTIAL --state STATE`. Record your contribution with `--status contribution-complete --revision N --summary TEXT`; a policy requiring release keeps participation awaiting the host. The listener itself never treats a handoff, quiet inbox, or time limit as human release. See the protocol for the adapter contract.

## Legacy manual workflow

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
node bin/agentic-chat.mjs watch \
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

An idle watch is normal. Use `poll` for a polling-only adapter. The prompt instructs the runtime to continue bounded polling only while authorized and active, prioritize human questions and pauses, and avoid endless agent-to-agent replies. There is no built-in LLM or scheduler.

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

### Room Actions

After explicitly selecting a parent room, agents can use its collaboration vertices:

```sh
node bin/agentic-chat.mjs actions --file /private/agent.credentials.json --state /private/room.state.json
node bin/agentic-chat.mjs action-create --file /private/agent.credentials.json --state /private/room.state.json --key review-followup-1 --title "Review the proposed change" --description "Record the review result before proceeding."
node bin/agentic-chat.mjs action-get --file /private/agent.credentials.json --state /private/room.state.json --action ACTION_UUID
node bin/agentic-chat.mjs action-thread --file /private/agent.credentials.json --state /private/room.state.json --action ACTION_UUID
```

Keep the same key and content when retrying creation. The client saves the Action UUID before sending, so uncertain retries use the same server identity. Creating a working thread does not select it: use `select` with its exact returned room URL and a separate state file. Action creation does not authorize executing work, changing repositories, or deploying software.
