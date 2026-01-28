import WebSocket from "ws";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl } from "./api.js";

// QQ Bot intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 25,
  // C2C 私聊在 PUBLIC_GUILD_MESSAGES 里
};

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  onMessage: (event: GatewayMessageEvent) => void;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

export interface GatewayMessageEvent {
  type: "c2c" | "guild" | "dm";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  raw: unknown;
}

/**
 * 启动 Gateway WebSocket 连接
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, onMessage, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  const accessToken = await getAccessToken(account.appId, account.clientSecret);
  const gatewayUrl = await getGatewayUrl(accessToken);

  log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

  const ws = new WebSocket(gatewayUrl);
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let lastSeq: number | null = null;

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  abortSignal.addEventListener("abort", cleanup);

  ws.on("open", () => {
    log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
  });

  ws.on("message", async (data) => {
    try {
      const payload = JSON.parse(data.toString()) as WSPayload;
      const { op, d, s, t } = payload;

      if (s) lastSeq = s;

      log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

      switch (op) {
        case 10: // Hello
          log?.info(`[qqbot:${account.accountId}] Hello received, starting heartbeat`);
          // Identify
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: `QQBot ${accessToken}`,
                intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE,
                shard: [0, 1],
              },
            })
          );
          // Heartbeat
          const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
          heartbeatInterval = setInterval(() => {
            ws.send(JSON.stringify({ op: 1, d: lastSeq }));
          }, interval);
          break;

        case 0: // Dispatch
          if (t === "READY") {
            log?.info(`[qqbot:${account.accountId}] Ready`);
            onReady?.(d);
          } else if (t === "C2C_MESSAGE_CREATE") {
            const event = d as C2CMessageEvent;
            onMessage({
              type: "c2c",
              senderId: event.author.user_openid,
              content: event.content,
              messageId: event.id,
              timestamp: event.timestamp,
              raw: event,
            });
          } else if (t === "AT_MESSAGE_CREATE") {
            const event = d as GuildMessageEvent;
            onMessage({
              type: "guild",
              senderId: event.author.id,
              senderName: event.author.username,
              content: event.content,
              messageId: event.id,
              timestamp: event.timestamp,
              channelId: event.channel_id,
              guildId: event.guild_id,
              raw: event,
            });
          } else if (t === "DIRECT_MESSAGE_CREATE") {
            const event = d as GuildMessageEvent;
            onMessage({
              type: "dm",
              senderId: event.author.id,
              senderName: event.author.username,
              content: event.content,
              messageId: event.id,
              timestamp: event.timestamp,
              guildId: event.guild_id,
              raw: event,
            });
          }
          break;

        case 11: // Heartbeat ACK
          log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
          break;

        case 9: // Invalid Session
          log?.error(`[qqbot:${account.accountId}] Invalid session`);
          onError?.(new Error("Invalid session"));
          cleanup();
          break;
      }
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
    }
  });

  ws.on("close", (code, reason) => {
    log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason}`);
    cleanup();
  });

  ws.on("error", (err) => {
    log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
    onError?.(err);
  });

  // 等待 abort 信号
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
