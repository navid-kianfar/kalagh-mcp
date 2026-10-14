# kalagh-mcp

An MCP server for one **Kalagh provider** (WhatsApp, Telegram, Instagram, email, …). Every
provider operation — channels, contacts, chats, messages, media, logs — is a tool for Claude,
carried over the transport you pick: **REST**, **Socket.IO** or **gRPC**.

- **The tools are the provider's own API.** At startup the server reads the running provider's
  `/api/docs-json` and turns each operation into a tool with its real request schema. A newer
  provider, an older one, or another platform's gets matching tools with no change here. When
  the provider can't be reached at startup, the bundled snapshot (`schema/openapi.json`) is
  used instead.
- **One tool surface, three carriers.** The provider publishes one surface over three
  transports: the REST path *is* the socket event name, and the controller method *is* the
  gRPC rpc. So each tool runs unchanged on whichever transport you configure.
- **Safe by default where it matters.** Arguments are validated against the schema before they
  leave, and unknown fields are refused, exactly as REST refuses them. Sends, edits, deletions,
  blocks and group changes are annotated *destructive*. `KALAGH_READ_ONLY=true` hides every
  tool that writes.

## Install

```bash
cd kalagh-mcp
pnpm install
pnpm build
```

### Claude Code (CLI, and the Code tab of the desktop app)

Register it once at **user** scope and it is available in every project. The Code tab of the
Claude desktop app runs Claude Code, so it picks up the same registration:

```bash
claude mcp add kalagh --scope user \
  -e KALAGH_API_URL=https://kalagh.smg.tr \
  -e KALAGH_API_KEY="$KALAGH_API_KEY" \
  -e KALAGH_TRANSPORT=grpc \
  -e KALAGH_GRPC_URL=kalagh-grpc.smg.tr:443 \
  -e KALAGH_WS_URL=https://kalagh-ws.smg.tr \
  -- node /Users/aslan_nejad/Desktop/DEV/achasoft/kalagh-mcp/dist/index.js
```

`claude mcp list` should show `kalagh` as connected. Inside a session, `/mcp` shows its tools,
and the `status` tool reports how it is connected.

To keep the key out of the config file, use a project `.mcp.json`. Claude Code expands
environment variables in it, so the key stays in your shell profile:

```json
{
  "mcpServers": {
    "kalagh": {
      "command": "node",
      "args": ["/Users/aslan_nejad/Desktop/DEV/achasoft/kalagh-mcp/dist/index.js"],
      "env": {
        "KALAGH_API_URL": "https://kalagh.smg.tr",
        "KALAGH_API_KEY": "${KALAGH_API_KEY}",
        "KALAGH_TRANSPORT": "http"
      }
    }
  }
}
```

**Don't paste the API key into a chat.** Anything typed into a conversation is kept in its
transcript, and nothing in a chat can register an MCP server. Configuration belongs in the
MCP config (above) or the extension's settings (below).

### Claude Desktop (chat) — a desktop extension with a settings form

```bash
pnpm pack:mcpb          # → kalagh.mcpb
```

Double-click `kalagh.mcpb`, or drag it onto **Settings → Extensions**. Claude Desktop shows a
form for the provider URL, the API key (stored in the OS keychain), the transport, the socket
and gRPC addresses, read-only mode and the download folder. No JSON editing is needed. The
extension carries the whole server in one file and runs on the Node.js that ships with Claude
Desktop.

### Several providers

Each provider is its own server instance with its own URL and key. Register one per provider
under different names, e.g. `kalagh-whatsapp` and `kalagh-telegram`. Their tools stay apart
as `mcp__kalagh-whatsapp__messages_send` and so on.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `KALAGH_API_URL` | *(required)* | REST base, e.g. `https://kalagh.smg.tr` (no `/api/kalagh`). Always needed: the tool list, uploads and `/storage` downloads use it. |
| `KALAGH_API_KEY` | *(required)* | The provider's `API_KEY`. Sent as `x-api-key` (REST), in the handshake (Socket.IO), or as `x-api-key` metadata (gRPC). |
| `KALAGH_TRANSPORT` | `http` | `http`, `ws` or `grpc`. |
| `KALAGH_WS_URL` | — | Socket.IO URL, e.g. `https://kalagh-ws.smg.tr`. Required for `ws`. When set, provider events are buffered for `events_recent`. |
| `KALAGH_GRPC_URL` | — | `host:port`, e.g. `kalagh-grpc.smg.tr:443`. Required for `grpc`. |
| `KALAGH_GRPC_TLS` | on for `:443` | TLS on the gRPC channel. |
| `KALAGH_READ_ONLY` | `false` | Only the tools that read are listed. |
| `KALAGH_DOWNLOAD_DIR` | `$TMPDIR/kalagh-mcp` | Where avatars, media and storage downloads are written. |
| `KALAGH_TIMEOUT_MS` | `60000` | Per-call timeout. |

Locally a provider serves REST on `http://localhost:4000`, Socket.IO on `http://localhost:4001`
and gRPC on `localhost:4002` (plaintext).

## Tools

There is one tool per provider operation, named after its REST path: `channels_list`,
`chats_get`, `messages_send`, `messages_send_poll`, `contacts_block`, `logs_webhooks`, … The
provider's three back-compat aliases (`messages/sync-chat`, `messages/download-media`,
`messages/mark-messages-as-read`) are left out, since each has a canonical twin.

Each description ends with how the operation is carried, e.g.
`(POST /api/kalagh/messages/send · gRPC SendMessage · socket "messages/send")`.

Special handling:

| Tool | What it does |
| --- | --- |
| `messages_send_media` | Takes **local file paths** (`files: [{ path, filename?, mimeType? }]`) and uploads them as one message, via REST multipart on every transport. |
| `channels_create`, `channels_request_qr` | The pairing QR comes back as an **image** the client shows, ready to scan. |
| `messages_get_media`, `contacts_get_avatar`, `chats_get_avatar` | The file is saved to the download folder and its path is returned; images are also shown inline. gRPC answers the bytes in-band. On REST/socket, media is fetched from the provider's storage, and an avatar needs gRPC. |
| `storage_get` | Downloads a stored object, from a `/storage/...` path or an attachment's URL. |
| `events_recent` | The provider events received since the server started (needs `KALAGH_WS_URL` or `KALAGH_GRPC_URL`). `afterSeq` reads only newer ones, and `waitSeconds` waits for the next match, e.g. a channel connecting after its QR is scanned. |
| `status` | Transport, endpoints, where the schemas came from, the event subscription, and the provider's health and info. |

## How each transport carries a call

| | REST | Socket.IO | gRPC |
| --- | --- | --- | --- |
| Operations | `POST /api/kalagh/<path>` | event `<path>` + ack | rpc on `kalagh.KalaghService` |
| `health`, `info`, `storage_get` | ✓ | via REST | via REST |
| `messages_send_media` | multipart | via REST | via REST |
| Media bytes | via `/storage` | via `/storage` | in-band |
| Avatar bytes | — | — | in-band |
| Events | — | `event` broadcast | `StreamEvents` |

On gRPC, arguments are shaped onto the proto from the proto itself: free-form objects
(`credentials`, every `metadata`) travel as JSON strings, and `map<string,string>` values are
stringified. A field REST takes but the proto doesn't declare is never dropped. That call goes
over REST instead. Today the one such field is `channels/update.metadata`.

## Development

```bash
pnpm test            # unit tests: catalog, gRPC shaping, validation, output, events
pnpm sync-schema     # copy openapi.json + kalagh.proto from ../kalagh (--check to verify)
pnpm inspect         # the MCP Inspector against dist/index.js
pnpm pack:mcpb       # bundle/ + kalagh.mcpb for Claude Desktop

# read-only smoke test against a running provider, through a real MCP client
KALAGH_API_URL=https://kalagh.smg.tr KALAGH_API_KEY=… \
  KALAGH_TRANSPORT=grpc KALAGH_GRPC_URL=kalagh-grpc.smg.tr:443 node scripts/smoke.mjs
```

The snapshot's source of record is the kalagh repo. `pnpm --filter @kalagh/core postman:generate`
writes `providers/docs/openapi.json` alongside the Postman collection, and the provider's drift
test fails when either is stale. Run `pnpm sync-schema` here after it changes.

### Known provider gaps (as of kalagh `4bd8e82f4`)

- gRPC `StreamEvents` answers UNIMPLEMENTED: the handler is registered as client-streaming. With
  `KALAGH_WS_URL` set, events come from the socket instead. Without it, `status` reports the error.
- gRPC `UpdateChannelRequest` has no `metadata`, so that call goes over REST
  (`KNOWN_PROTO_GAPS` in `test/surface.test.ts`).
- gRPC media and avatar bytes and gRPC `SendMedia` were fixed in kalagh `73aa17fe0`. A
  provider deployed before that answers empty bytes over gRPC. Media then falls back to
  `/storage`, and uploads always go over REST.
