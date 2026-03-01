import net from 'net';
import path from 'path';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  accountNumber: string;
  socketPath?: string;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    groupInfo?: { groupId: string; type?: string };
  };
  syncMessage?: {
    sentMessage?: {
      timestamp?: number;
      message?: string;
      groupInfo?: { groupId: string; type?: string };
    };
  };
  typingMessage?: {
    action?: string;
    groupId?: string;
  };
}

const DEFAULT_SOCKET_PATH = '/tmp/signal-cli.sock';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

export class SignalChannel implements Channel {
  name = 'signal';

  private socket: net.Socket | null = null;
  private connected = false;
  private opts: SignalChannelOpts;
  private socketPath: string;
  private rpcId = 0;
  private pendingRpc = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
    this.socketPath = opts.socketPath || DEFAULT_SOCKET_PATH;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve, reject);
    });
  }

  private connectInternal(
    onFirstOpen?: () => void,
    onFirstError?: (err: Error) => void,
  ): void {
    const sock = net.createConnection({ path: this.socketPath });
    this.socket = sock;

    sock.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info(
        { socketPath: this.socketPath },
        'Connected to signal-cli daemon',
      );

      // Sync group metadata on connect
      this.syncGroupMetadata().catch((err) =>
        logger.warn({ err }, 'Signal group sync failed'),
      );

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
        onFirstError = undefined;
      }
    });

    sock.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    sock.on('error', (err) => {
      logger.error({ err }, 'Signal socket error');
      if (onFirstError) {
        onFirstError(err);
        onFirstError = undefined;
        onFirstOpen = undefined;
      }
    });

    sock.on('close', () => {
      this.connected = false;
      // Reject any pending RPCs
      for (const [id, pending] of this.pendingRpc) {
        pending.reject(new Error('Socket closed'));
        this.pendingRpc.delete(id);
      }

      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    if (jid.startsWith('signal:group:')) {
      const groupId = jid.slice('signal:group:'.length);
      await this.rpcCall('send', {
        account: this.opts.accountNumber,
        groupId,
        message: prefixed,
      });
    } else {
      const recipient = jid.slice('signal:'.length);
      await this.rpcCall('send', {
        account: this.opts.accountNumber,
        recipient: [recipient],
        message: prefixed,
      });
    }
    logger.info({ jid, length: prefixed.length }, 'Signal message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.socket?.destroy();
    this.socket = null;
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      if (jid.startsWith('signal:group:')) {
        const groupId = jid.slice('signal:group:'.length);
        await this.rpcCall('sendTyping', {
          account: this.opts.accountNumber,
          groupId,
          stop: !isTyping,
        });
      } else {
        const recipient = jid.slice('signal:'.length);
        await this.rpcCall('sendTyping', {
          account: this.opts.accountNumber,
          recipient: [recipient],
          stop: !isTyping,
        });
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  // --- Private ---

  private async syncGroupMetadata(): Promise<void> {
    try {
      const result = (await this.rpcCall('listGroups', {
        account: this.opts.accountNumber,
      })) as Array<{ id: string; name?: string }>;

      if (!Array.isArray(result)) return;

      for (const group of result) {
        if (group.id && group.name) {
          const chatJid = `signal:group:${group.id}`;
          this.opts.onChatMetadata(
            chatJid,
            new Date().toISOString(),
            group.name,
            'signal',
            true,
          );
        }
      }
      logger.info({ count: result.length }, 'Signal group metadata synced');
    } catch (err) {
      logger.warn({ err }, 'Failed to list Signal groups');
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id !== undefined && this.pendingRpc.has(parsed.id)) {
          // RPC response
          const pending = this.pendingRpc.get(parsed.id)!;
          this.pendingRpc.delete(parsed.id);
          const resp = parsed as JsonRpcResponse;
          if (resp.error) {
            pending.reject(
              new Error(`RPC error ${resp.error.code}: ${resp.error.message}`),
            );
          } else {
            pending.resolve(resp.result);
          }
        } else if (parsed.method) {
          // Notification
          this.handleNotification(parsed as JsonRpcNotification);
        }
      } catch (err) {
        logger.debug({ line: trimmed, err }, 'Failed to parse signal-cli JSON');
      }
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'receive' && notification.method !== 'sync')
      return;

    const envelope = notification.params?.envelope as
      | SignalEnvelope
      | undefined;
    if (!envelope) return;

    // Handle both regular messages and sync messages (self-sent)
    let dataMessage;
    let source;
    let senderName;

    if (envelope.syncMessage?.sentMessage) {
      // Sync message (your own message from another device)
      dataMessage = envelope.syncMessage.sentMessage;
      source = this.opts.accountNumber; // It's from you
      senderName = 'You';
    } else if (envelope.dataMessage) {
      // Regular message from someone else
      dataMessage = envelope.dataMessage;
      source = envelope.sourceNumber || envelope.source || '';
      senderName = envelope.sourceName || source;
    } else {
      return;
    }

    if (!dataMessage?.message) return;

    const groupId = dataMessage.groupInfo?.groupId;
    const chatJid = groupId ? `signal:group:${groupId}` : `signal:${source}`;
    const isGroup = !!groupId;

    const timestamp = dataMessage.timestamp
      ? new Date(dataMessage.timestamp).toISOString()
      : new Date().toISOString();

    // Always emit chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'signal', isGroup);

    // Deliver message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, {
        id: `signal-${dataMessage.timestamp || Date.now()}`,
        chat_jid: chatJid,
        sender: source,
        sender_name: senderName,
        content: dataMessage.message,
        timestamp,
        is_from_me: source === this.opts.accountNumber,
        is_bot_message: false,
      });
    }
  }

  private rpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Signal socket not connected'));
        return;
      }

      const id = ++this.rpcId;
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this.pendingRpc.set(id, { resolve, reject });

      this.socket.write(request + '\n', (err) => {
        if (err) {
          this.pendingRpc.delete(id);
          reject(err);
        }
      });

      // Timeout pending RPCs after 30s
      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 30000);
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    logger.info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Scheduling Signal reconnect',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting to signal-cli daemon...');
      this.connectInternal();
    }, delay);
  }
}
