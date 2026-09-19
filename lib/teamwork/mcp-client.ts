/**
 * Native Zero-Dependency JSON-RPC stdio Client for Model Context Protocol (MCP).
 * Conforms to MCP standard specification (2024-11-05).
 *
 * Runs in pure Node.js without @modelcontextprotocol/sdk or third-party dependencies.
 * Features:
 * 1. Process lifecycle supervision and clean stdio line-buffering.
 * 2. Full JSON-RPC 2.0 handshake (initialize, notifications/initialized, ping).
 * 3. Tool discovery and execution (tools/list, tools/call).
 * 4. Resource and Prompt management (resources/list, resources/read, prompts/list).
 * 5. Lifecycle cleanup with SandboxedProcessManager process tree teardown.
 */

import child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { SandboxedProcessManager } from './sandbox/process-manager';

export type McpClientState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export interface McpClientOptions {
  /** Command to execute (e.g. 'node', 'npx', 'python', or executable path) */
  command: string;
  /** Command line arguments */
  args?: string[];
  /** Environment variable overrides */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Request timeout in milliseconds (default: 30000ms) */
  requestTimeoutMs?: number;
  /** Client information advertised in initialize handshake */
  clientInfo?: {
    name: string;
    version: string;
  };
  /** Advertised client capabilities */
  capabilities?: Record<string, unknown>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallContent {
  type: 'text' | 'image' | 'resource' | string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
  };
}

export interface McpToolCallResult {
  content: McpToolCallContent[];
  isError?: boolean;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class NativeMcpClient extends EventEmitter {
  public readonly options: McpClientOptions;
  private child: child_process.ChildProcess | null = null;
  private state: McpClientState = 'idle';
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private stdoutBuffer = '';
  private serverCapabilities: Record<string, unknown> = {};
  private serverInfo: { name: string; version: string } = { name: '', version: '' };

  constructor(options: McpClientOptions) {
    super();
    if (!options || !options.command) {
      throw new Error('NativeMcpClient requires a valid command string.');
    }
    this.options = {
      requestTimeoutMs: 30000,
      ...options,
    };
  }

  /**
   * Spawns the MCP server child process, attaches stdio handlers, and performs the MCP handshake.
   */
  public async connect(): Promise<void> {
    if (this.state === 'connected') {
      return;
    }
    if (this.state === 'connecting') {
      throw new Error('NativeMcpClient is already in connecting state.');
    }
    if (this.state === 'closed') {
      throw new Error('NativeMcpClient has been closed and cannot be reconnected.');
    }

    this.state = 'connecting';

    try {
      const isWin = process.platform === 'win32';
      const effectiveEnv: NodeJS.ProcessEnv = {
        ...(process.env as NodeJS.ProcessEnv),
        ...this.options.env,
      };

      this.child = child_process.spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: effectiveEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
      });

      if (!this.child || !this.child.stdin || !this.child.stdout) {
        throw new Error('Failed to spawn MCP server child process with stdio pipes.');
      }

      // Handle stdout line buffering
      this.child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString('utf8');
        this.processStdoutBuffer();
      });

      // Handle stderr forwarding
      this.child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.emit('stderr', text);
      });

      // Handle process errors
      this.child.on('error', (err: Error) => {
        this.state = 'error';
        this.emit('error', err);
        this.rejectAllPending(new Error(`MCP server process error: ${err.message}`));
      });

      // Handle process exit
      this.child.on('exit', (code: number | null, signal: string | null) => {
        const exitMsg = `MCP server process exited with code ${code ?? 'null'} (signal: ${signal ?? 'none'}).`;
        this.state = 'closed';
        this.emit('exit', { code, signal });
        this.rejectAllPending(new Error(exitMsg));
      });

      // Perform MCP initialize handshake
      const initResponse = await this.request<{
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: { name: string; version: string };
      }>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: this.options.capabilities || {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: this.options.clientInfo || {
          name: 'vyen-teamwork-mcp-client',
          version: '1.0.0',
        },
      });

      this.serverCapabilities = initResponse.capabilities || {};
      this.serverInfo = initResponse.serverInfo || { name: 'unknown', version: 'unknown' };

      // Send notifications/initialized as required by MCP spec
      this.notify('notifications/initialized');

      this.state = 'connected';
      this.emit('connected', { serverInfo: this.serverInfo, capabilities: this.serverCapabilities });
    } catch (err) {
      this.state = 'error';
      await this.close();
      throw err;
    }
  }

  /**
   * Processes buffered stdout lines looking for complete JSON-RPC 2.0 frames.
   */
  private processStdoutBuffer(): void {
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const parsed = JSON.parse(line) as JsonRpcResponse & JsonRpcNotification;
        this.handleIncomingMessage(parsed);
      } catch {
        // Ignore non-JSON log lines output on stdout by the server
      }
    }
  }

  /**
   * Dispatches an incoming JSON-RPC response or notification.
   */
  private handleIncomingMessage(msg: JsonRpcResponse & JsonRpcNotification): void {
    if (msg.id !== undefined && msg.id !== null) {
      // Response to a pending request
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;

      this.pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(
          new Error(
            `MCP Error [${msg.error.code}] on method "${pending.method}": ${msg.error.message}`
          )
        );
      } else {
        pending.resolve(msg.result);
      }
    } else if (msg.method) {
      // Server-to-client notification
      this.emit('notification', { method: msg.method, params: msg.params });
    }
  }

  /**
   * Sends a JSON-RPC 2.0 request and returns a Promise for the result.
   */
  public async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.state === 'closed') {
      throw new Error(`Cannot send request "${method}": MCP client is closed.`);
    }

    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`Cannot send request "${method}": MCP server stdin is not writable.`);
    }

    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 30000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request "${method}" (id: ${id}) timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
        method,
      });

      const payload: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params ? { params } : {}),
      };

      try {
        this.child!.stdin!.write(JSON.stringify(payload) + '\n');
      } catch (writeErr) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
      }
    });
  }

  /**
   * Sends a one-way JSON-RPC 2.0 notification to the server without expecting a response.
   */
  public notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return;
    }

    const payload: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };

    try {
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    } catch {
      // Best-effort notification delivery
    }
  }

  /**
   * Queries the server's registered tools via standard tools/list request.
   */
  public async listTools(): Promise<McpToolDefinition[]> {
    const res = await this.request<{ tools: McpToolDefinition[] }>('tools/list');
    return res?.tools ?? [];
  }

  /**
   * Calls an MCP tool by name with provided arguments via tools/call request.
   */
  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    const res = await this.request<McpToolCallResult>('tools/call', {
      name,
      arguments: args,
    });
    return res;
  }

  /**
   * Lists available resources via resources/list request.
   */
  public async listResources(): Promise<McpResource[]> {
    const res = await this.request<{ resources: McpResource[] }>('resources/list');
    return res?.resources ?? [];
  }

  /**
   * Reads a resource by URI via resources/read request.
   */
  public async readResource(uri: string): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string }> }> {
    return this.request<{ contents: Array<{ uri: string; text?: string; blob?: string }> }>('resources/read', {
      uri,
    });
  }

  /**
   * Lists available prompt templates via prompts/list request.
   */
  public async listPrompts(): Promise<McpPrompt[]> {
    const res = await this.request<{ prompts: McpPrompt[] }>('prompts/list');
    return res?.prompts ?? [];
  }

  /**
   * Sends a ping request to verify server liveness.
   */
  public async ping(): Promise<boolean> {
    try {
      await this.request('ping');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns whether the client is currently connected and child process is active.
   */
  public isConnected(): boolean {
    return this.state === 'connected' && this.child !== null && this.child.exitCode === null;
  }

  /**
   * Returns server information discovered during the initialize handshake.
   */
  public getServerInfo(): { name: string; version: string } {
    return { ...this.serverInfo };
  }

  /**
   * Returns server capabilities negotiated during the initialize handshake.
   */
  public getServerCapabilities(): Record<string, unknown> {
    return { ...this.serverCapabilities };
  }

  /**
   * Rejects all currently pending in-flight requests.
   */
  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  /**
   * Gracefully tears down the client connection and kills the child process tree.
   */
  public async close(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }

    this.state = 'closed';
    this.rejectAllPending(new Error('MCP client was closed.'));

    if (this.child) {
      const pid = this.child.pid;

      try {
        if (this.child.stdin && !this.child.stdin.destroyed) {
          this.child.stdin.end();
        }
      } catch {
        // Ignore stdin close error
      }

      if (pid && this.child.exitCode === null) {
        // Recursively terminate entire process tree cleanly
        SandboxedProcessManager.killProcessTree(pid, 'SIGTERM');
      }

      this.child = null;
    }

    this.emit('close');
  }

  /**
   * Alias for close() conforming to async disposable interface.
   */
  public async dispose(): Promise<void> {
    await this.close();
  }
}

/**
 * Factory function to construct and connect a NativeMcpClient in a single call.
 */
export async function createMcpClient(options: McpClientOptions): Promise<NativeMcpClient> {
  const client = new NativeMcpClient(options);
  await client.connect();
  return client;
}
