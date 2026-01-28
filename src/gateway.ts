import WebSocket from "ws";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage } from "./api.js";
import { getQQBotRuntime } from "./runtime.js";

// QQ Bot intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,  // 频道公开消息
  DIRECT_MESSAGE: 1 << 12,         // 频道私信
  GROUP_AND_C2C: 1 << 25,          // 群聊和 C2C 私聊
};

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 启动 Gateway WebSocket 连接
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  const pluginRuntime = getQQBotRuntime();
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

  // 处理收到的消息
  const handleMessage = async (event: {
    type: "c2c" | "guild" | "dm" | "group";
    senderId: string;
    senderName?: string;
    content: string;
    messageId: string;
    timestamp: string;
    channelId?: string;
    guildId?: string;
    groupOpenid?: string;
  }) => {
    log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);

    pluginRuntime.channel.activity.record({
      channel: "qqbot",
      accountId: account.accountId,
      direction: "inbound",
    });

    const isGroup = event.type === "guild" || event.type === "group";
    const peerId = event.type === "guild" ? `channel:${event.channelId}` 
                 : event.type === "group" ? `group:${event.groupOpenid}`
                 : event.senderId;

    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg,
      channel: "qqbot",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: peerId,
      },
    });

    const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

    const body = pluginRuntime.channel.reply.formatInboundEnvelope({
      channel: "QQBot",
      from: event.senderName ?? event.senderId,
      timestamp: new Date(event.timestamp).getTime(),
      body: event.content,
      chatType: isGroup ? "group" : "direct",
      sender: {
        id: event.senderId,
        name: event.senderName,
      },
      envelope: envelopeOptions,
    });

    const fromAddress = event.type === "guild" ? `qqbot:channel:${event.channelId}`
                       : event.type === "group" ? `qqbot:group:${event.groupOpenid}`
                       : `qqbot:${event.senderId}`;
    const toAddress = fromAddress;

    const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: event.content,
      CommandBody: event.content,
      From: fromAddress,
      To: toAddress,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      SenderId: event.senderId,
      SenderName: event.senderName,
      Provider: "qqbot",
      Surface: "qqbot",
      MessageSid: event.messageId,
      Timestamp: new Date(event.timestamp).getTime(),
      OriginatingChannel: "qqbot",
      OriginatingTo: toAddress,
      // QQBot 特有字段
      QQChannelId: event.channelId,
      QQGuildId: event.guildId,
      QQGroupOpenid: event.groupOpenid,
    });

    // 分发到 AI 系统
    try {
      const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

      await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          responsePrefix: messagesConfig.responsePrefix,
          deliver: async (payload: { text?: string }) => {
            const replyText = payload.text ?? "";
            if (!replyText.trim()) return;

            try {
              if (event.type === "c2c") {
                await sendC2CMessage(accessToken, event.senderId, replyText, event.messageId);
              } else if (event.type === "group" && event.groupOpenid) {
                await sendGroupMessage(accessToken, event.groupOpenid, replyText, event.messageId);
              } else if (event.channelId) {
                await sendChannelMessage(accessToken, event.channelId, replyText, event.messageId);
              }
              log?.info(`[qqbot:${account.accountId}] Sent reply`);

              pluginRuntime.channel.activity.record({
                channel: "qqbot",
                accountId: account.accountId,
                direction: "outbound",
              });
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] Send failed: ${err}`);
            }
          },
          onError: (err: unknown) => {
            log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
          },
        },
        replyOptions: {},
      });
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
    }
  };

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
                intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
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
            await handleMessage({
              type: "c2c",
              senderId: event.author.user_openid,
              content: event.content,
              messageId: event.id,
              timestamp: event.timestamp,
            });
          } else if (t === "AT_MESSAGE_CREATE") {
            const event = d as GuildMessageEvent;
            await handleMessage({
              type: "guild",
              senderId: event.author.id,
              senderName: event.author.username,
              content: event.content,
              messageId: event.id,
              timestamp: event.timestamp,
              channelId: event.channel_id,
              guildId: event.guild_id,
            });
          } else if (t === "DIRECT_MESSAGE_CREATE") {
            const event = d as GuildMessageEvent;
            await handleMessage({
              type: "dm",
              senderId: event.author.id,
              senderName: event.author.username,
              content: event.content,
              messageId: event.id,
              timestamp: event.timestamp,
              guildId: event.guild_id,
            });
          } else if (t === "GROUP_AT_MESSAGE_CREATE") {
            const event = d as GroupMessageEvent;
            await handleMessage({
              type: "group",
              senderId: event.author.member_openid,
              content: event.content,
              messageId: event.id,
              timestamp: event.timestamp,
              groupOpenid: event.group_openid,
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
