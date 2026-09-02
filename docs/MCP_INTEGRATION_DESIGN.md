# Vyen MCP Integration Architecture Design v2 (Deep Dive)

## 1. Kiến trúc tham khảo - Deep Findings

### 1.1 Goose: IPC ≠ MCP Communication ⚡ KEY INSIGHT

**Phát hiện quan trọng nhất**: Goose KHÔNG dùng Electron IPC cho MCP/tool execution.

```
┌─────────────┐   Electron IPC    ┌──────────────┐   spawn    ┌──────────┐
│  Renderer    │ ──get-acp-url──►  │  Main Process │ ─────────► │  goosed   │
│  (React)     │ ◄──ws://url+tok── │              │            │  (Rust)   │
│             │                    │              │            │           │
│             │ ═══ ACP/WebSocket (KHÔNG phải IPC) ════════════►│           │
│             │  initialize()      │              │  stdio     │           │
│             │  prompt()          │              │◄───────────│  MCP srvs │
│             │  requestPermission │              │            │           │
└─────────────┘                    └──────────────┘            └──────────┘
```

- **Electron IPC chỉ bootstrap**: `get-acp-url`, `get-secret-key`, `react-ready`
- **ACP over WebSocket**: Toàn bộ tool calls, permissions, extensions qua WS trực tiếp renderer → backend
- **Lợi ích**: Backend độc lập với Electron, test dễ, serve nhiều clients
- **IPC channels**: Không có channel nào tên `mcp-*`, `tool-*`, `permission-*`

**Permission flow qua ACP:**
1. Backend gửi `requestPermission` qua WS
2. Renderer tạo Promise pending trong Map key=sessionId+toolCallId + generation UUID chống stale
3. User click → resolve Promise → response trả về qua WS
4. 4 levels: allow_once, always_allow, deny_once, always_deny

### 1.2 Codex: Exec-Policy Engine

**Decision hierarchy**: `forbidden > prompt > allow` (strictest wins)

**SandboxMode enum**: read-only | workspace-write | danger-full-access

**Approval policy** (`AskForApproval`):
- `on-request`: Model tự quyết khi cần hỏi user
- `granular`: Fine-grained controls per category  
- `never`: Auto-reject tất cả (CI mode)

**Rule matching**: PrefixPattern first token fixed, rest là alternatives. Multiple rules match → strictest decision wins.

**Sandbox fallback chain**: bwrap → bundled bwrap → landlock → none

### 1.3 Vyen: Existing Tool Architecture

**Tool definition** (`lib/agent-tools.ts`):
- Vercel AI SDK `tool()` helper với Zod schemas
- Tools: web_search, web_fetch, weather, exchange_rates, memory_search
- Guard layers: dedupe/loop-guard, provenance tracking, injection guard
- Budget: MAX_TOOL_CALLS_PER_TURN, TOOL_RESULT_MAX_CHARS

**Emulated tools** (`lib/emulated-agent.ts`):
- Cho models KHÔNG hỗ trợ native function calling
- Render tool schema thành text trong system prompt
- Model trả `<tool_call>{json}</tool_call>` → parse → execute → feed back
- Loop protection: round budget, per-round call cap, dedupe, anti-hallucination

**Orchestrator** (`lib/orchestrator/engine.ts`):
- Plan → Spawn N agents song song → Review/Synthesize
- Mỗi agent context RIÊNG, không thấy transcript của nhau
- Stream events: planning → sweeping → ranking → synthesizing → done
- WorkerContext inject LLM implementation (deps injection pattern)

## 2. Architecture Design cho Vyen (Revised)

### 2.1 Decision: KHÔNG theo Goose ACP pattern

Goose dùng Rust backend riêng (goosed) + ACP protocol vì họ cần performance cao và multi-client. Vyen là Next.js app, không cần layer phức tạp đó.

**Vyen approach**: MCP Client chạy TRONG Electron main process, communicate qua IPC (đơn giản hơn, phù hợp scale).

```
┌─────────────────────────────────────────────────────┐
│                  Vyen Desktop App                    │
│                                                      │
│  ┌────────────────────┐    IPC     ┌──────────────┐ │
│  │  Renderer (React)   │◄──────────►│ Main Process │ │
│  │                     │            │              │ │
│  │  - ChatInterface    │  mcp:*     │ - McpManager │ │
│  │  - ToolApprovalUI   │  channels  │ - ToolExec   │ │
│  │  - ExtensionSettings│            │ - ApprovalMgr│ │
│  │                     │            │ - ExecPolicy │ │
│  └────────────────────┘            │              │ │
│                                     │  stdio       │ │
│                                     │◄────────────►│ MCP Servers │
│                                     │              │ - filesystem │ │
│                                     │              │ - shell      │ │
│                                     │              │ - git        │ │
│                                     └──────────────┘ └──────────┘ │
└─────────────────────────────────────────────────────┘
```

### 2.2 IPC Channel Design

```typescript
// Renderer → Main
'mcp:list-servers'        → ServerConfig[]
'mcp:add-server'          → { id: string }
'mcp:remove-server'       → void
'mcp:list-tools'          → Tool[]
'mcp:call-tool'           → ToolResult (với approval flow)
'mcp:resolve-approval'    → void
'mcp:get-config'          → McpConfig
'mcp:update-config'       → void

// Main → Renderer (events)
'mcp:approval-requested'  → PendingApproval
'mcp:server-status'       → { id, status: 'connected'|'error'|'disconnected' }
'mcp:tool-progress'       → { callId, progress }
```

### 2.3 Module Structure

```
electron/mcp/                    # Main process
├── manager.ts                   # MCP client pool lifecycle
├── ipc-handlers.ts              # Register all mcp:* IPC handlers
├── approval-manager.ts          # Pending approvals, policies
├── exec-policy.ts               # Command whitelist/blacklist engine
├── transports/
│   └── stdio.ts                 # StdioClientTransport wrapper
└── types.ts                     # Shared types

lib/mcp/                         # Shared/renderer-safe
├── types.ts                     # Zod schemas, interfaces
├── tool-mapper.ts               # MCP tools → AI SDK tool format
└── constants.ts                 # Default policies, limits

components/mcp/                  # React components
├── ToolApprovalDialog.tsx        # Approve/deny UI
├── ExtensionManager.tsx          # Add/remove/configure servers
└── ToolCallStatus.tsx            # Execution progress indicator
```

### 2.4 Integration Points với Existing Vyen

**Thay thế emulated tools bằng MCP tools:**

```typescript
// lib/mcp/tool-mapper.ts
import { tool } from 'ai';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types';

export function mapMcpToolToAiSdk(mcpTool: McpTool, callFn: CallToolFn) {
  return tool({
    description: mcpTool.description ?? '',
    parameters: jsonSchemaToZod(mcpTool.inputSchema),
    execute: async (args) => {
      const result = await callFn(mcpTool.name, args);
      // Convert MCP content[] → string for AI SDK
      return result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    },
  });
}
```

**Merge vào existing agent-tools.ts:**

```typescript
// Trong buildAgentTools(), thêm MCP tools
export function buildAgentTools(opts: AgentToolsOptions & { mcpTools?: AiSdkTool[] }) {
  const base = { web_search, web_fetch, ... }; // existing
  if (opts.mcpTools) {
    for (const t of opts.mcpTools) {
      base[t.name] = t; // MCP tools override hoặc extend
    }
  }
  return base;
}
```

**Approval flow trong chat route:**

```typescript
// app/api/chat/route.ts - trong tool execution
// Khi MCP tool cần approval → emit SSE event → client show dialog
// Client resolve → POST /api/mcp/resolve → continue execution
```

### 2.5 Security Model (Phase 1)

**Exec Policy (simplified Codex):**

```typescript
// electron/mcp/exec-policy.ts
type Decision = 'allow' | 'prompt' | 'forbidden';

interface PolicyRule {
  pattern: string[];  // ["git", "status"]
  decision: Decision;
}

const DEFAULT_RULES: PolicyRule[] = [
  // Read-only commands: auto-allow
  { pattern: ['ls'], decision: 'allow' },
  { pattern: ['cat'], decision: 'allow' },
  { pattern: ['grep'], decision: 'allow' },
  { pattern: ['find'], decision: 'allow' },
  { pattern: ['git', 'status'], decision: 'allow' },
  { pattern: ['git', 'log'], decision: 'allow' },
  { pattern: ['git', 'diff'], decision: 'allow' },
  { pattern: ['git', 'branch'], decision: 'allow' },
  
  // Write commands: require approval
  { pattern: ['rm'], decision: 'prompt' },
  { pattern: ['mv'], decision: 'prompt' },
  { pattern: ['git', 'commit'], decision: 'prompt' },
  { pattern: ['git', 'push'], decision: 'prompt' },
  { pattern: ['npm', 'install'], decision: 'prompt' },
  
  // Dangerous: always block
  { pattern: ['rm', '-rf', '/'], decision: 'forbidden' },
  { pattern: ['format'], decision: 'forbidden' },
  { pattern: ['del', '/s'], decision: 'forbidden' },
];

export function evaluateCommand(cmd: string[]): Decision {
  const tokens = cmd.map(t => t.toLowerCase());
  let strictest: Decision = 'prompt'; // default: ask user
  
  for (const rule of DEFAULT_RULES) {
    if (matchesPrefix(tokens, rule.pattern)) {
      if (rule.decision === 'forbidden') return 'forbidden';
      if (rule.decision === 'allow' && strictest !== 'forbidden') strictest = 'allow';
      // 'prompt' is default, no change needed
    }
  }
  return strictest;
}
```

**Filesystem scope:**
- MCP filesystem server configured với allowedDirectories = [workingDir]
- Shell commands validated không escape workingDir (path traversal check)

### 2.6 Data Flow End-to-End

```
User message → useChat → POST /api/chat
  → route.ts buildAgentTools() includes MCP tools
  → LLM returns tool_use for MCP tool
  → AI SDK calls execute() → IPC mcp:call-tool
  → Main: exec-policy check
    → allow: execute immediately
    → prompt: emit mcp:approval-requested → renderer shows dialog
      → user approves → IPC mcp:resolve-approval → execute
    → forbidden: return error to LLM
  → MCP client.callTool() → MCP server executes
  → Result flows back through IPC → AI SDK → LLM next step
  → Stream response to client
```

## 3. Implementation Sprints (Revised)

### Sprint 1: MCP Client Core (1 tuần)
- [ ] Install @modelcontextprotocol/sdk
- [ ] electron/mcp/manager.ts: Client pool, connect/disconnect/reconnect
- [ ] electron/mcp/transports/stdio.ts: Spawn + transport wrapper
- [ ] electron/mcp/ipc-handlers.ts: Register mcp:* channels
- [ ] lib/mcp/types.ts: Zod schemas
- [ ] Unit tests

### Sprint 2: Tool Integration (1 tuần)
- [ ] lib/mcp/tool-mapper.ts: MCP → AI SDK format
- [ ] Merge MCP tools vào buildAgentTools()
- [ ] JSON Schema → Zod conversion utility
- [ ] Test end-to-end tool call flow

### Sprint 3: Approval & Security (1 tuần)
- [ ] electron/mcp/approval-manager.ts
- [ ] electron/mcp/exec-policy.ts
- [ ] components/mcp/ToolApprovalDialog.tsx
- [ ] Persist policies (localStorage/Dexie)
- [ ] Filesystem scope enforcement

### Sprint 4: UX & Polish (0.5 tuần)
- [ ] components/mcp/ExtensionManager.tsx
- [ ] components/mcp/ToolCallStatus.tsx
- [ ] Error handling, reconnection UX
- [ ] Documentation

## 4. Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^2.x",
  "zod": "^4.x"
}
```

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MCP server crash | Tool unavailable | Auto-restart + error toast + graceful degradation |
| Malicious MCP server | Security breach | Approval system + exec policy + filesystem scope |
| Electron IPC serialization | Large tool results | Chunked transfer, max size limit |
| JSON Schema → Zod edge cases | Tool validation fail | Fallback to passthrough + warning |
| Windows path handling | Sandbox bypass | Normalize paths, reject .. traversal |
| Provider API downtime | Dev blocked | Cache analysis results, offline-capable design |
