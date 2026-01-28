import type { ResolvedQQBotAccount } from "./types.js";
import { getAccessToken, sendC2CMessage, sendChannelMessage } from "./api.js";

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
}

/**
 * 发送文本消息
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account } = ctx;

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    // 判断目标类型：openid (C2C) 或 channel_id (频道)
    // openid 通常是 32 位十六进制，channel_id 通常是数字
    const isC2C = /^[A-F0-9]{32}$/i.test(to);

    if (isC2C) {
      const result = await sendC2CMessage(accessToken, to, text, replyToId ?? undefined);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else {
      const result = await sendChannelMessage(accessToken, to, text, replyToId ?? undefined);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}
