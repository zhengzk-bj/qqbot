# 如何为其他 Chat 平台适配图片发送功能

本文档说明如何将 QQ Bot 的图片发送机制扩展到其他聊天平台（如 Telegram、Discord、Slack、WeChat 等）。

## 📋 目录

1. [核心架构](#核心架构)
2. [QQ Bot 实现原理](#qq-bot-实现原理)
3. [适配步骤](#适配步骤)
4. [平台特定实现](#平台特定实现)
5. [最佳实践](#最佳实践)

---

## 核心架构

OpenClaw 的 Channel Plugin 系统采用统一接口设计，主要包括：

```typescript
ChannelPlugin {
  id: string;              // 频道标识，如 "qqbot", "telegram"
  meta: {...};             // 频道元信息
  capabilities: {...};      // 支持的功能（media, reactions 等）
  gateway: {...};          // 入站消息处理（接收消息）
  outbound: {...};         // 出站消息处理（发送消息）
  messaging: {...};        // 消息路由和目标解析
}
```

### 关键组件

1. **Gateway（入站）**：接收用户消息，解析内容，触发 AI 处理
2. **Outbound（出站）**：发送 AI 回复给用户
3. **System Prompt（系统提示）**：告诉 AI 如何使用平台特定功能

---

## QQ Bot 实现原理

### 1. 系统提示注入（System Prompt）

**位置**：`src/gateway.ts` 第 486-503 行

```typescript
builtinPrompt += `

【发送图片】
你可以直接发送图片给用户！使用 <qqimg> 标签包裹图片路径：

<qqimg>图片路径</qqimg>

示例：
- <qqimg>/Users/xxx/images/photo.jpg</qqimg>  （本地文件）
- <qqimg>https://example.com/image.png</qqimg>  （网络图片）

⚠️ 注意：
- 必须使用 <qqimg>路径</qqimg> 格式
- 本地路径必须是绝对路径，支持 png、jpg、jpeg、gif、webp 格式
- 图片文件/URL 必须有效，否则发送失败
- Markdown格式下，也必须使用该方式发送图片`;
```

**作用**：告诉 AI 如何在回复中包含图片。

### 2. 标签解析（Tag Parsing）

**位置**：`src/gateway.ts` 第 748-779 行

```typescript
const qqimgRegex = /<qqimg>([^<>]+)<\/(?:qqimg|img)>/gi;
const qqimgMatches = [...replyText.matchAll(qqimgRegex)];

if (qqimgMatches.length > 0) {
  const sendQueue: Array<{ type: "text" | "image"; content: string }> = [];
  
  // 按原文顺序提取文本和图片
  let lastIndex = 0;
  while ((match = qqimgRegexWithIndex.exec(replyText)) !== null) {
    // 添加标签前的文本
    const textBefore = replyText.slice(lastIndex, match.index).trim();
    if (textBefore) {
      sendQueue.push({ type: "text", content: textBefore });
    }
    
    // 添加图片
    const imagePath = match[1]?.trim();
    if (imagePath) {
      sendQueue.push({ type: "image", content: imagePath });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // 按顺序发送
  for (const item of sendQueue) {
    if (item.type === "text") {
      await sendC2CMessage(...);
    } else if (item.type === "image") {
      await sendC2CImageMessage(...);
    }
  }
}
```

**作用**：从 AI 回复中提取图片标签，按顺序发送文本和图片。

### 3. 本地文件转换（Local File Conversion）

**位置**：`src/gateway.ts` 第 816-842 行

```typescript
if (isLocalPath) {
  // 本地文件：转换为 Base64 Data URL
  if (!fs.existsSync(imagePath)) {
    await sendErrorMessage(`图片文件不存在: ${imagePath}`);
    continue;
  }
  
  const fileBuffer = fs.readFileSync(imagePath);
  const base64Data = fileBuffer.toString("base64");
  const ext = path.extname(imagePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  const mimeType = mimeTypes[ext];
  imageUrl = `data:${mimeType};base64,${base64Data}`;
}
```

**作用**：将本地图片转换为 Base64，无需图床服务器。

### 4. 平台 API 调用（Platform API）

**位置**：`src/gateway.ts` 第 849-863 行 + `src/api.ts`

```typescript
// 发送图片
await sendWithTokenRetry(async (token) => {
  if (event.type === "c2c") {
    await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
  } else if (event.type === "group") {
    await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
  } else if (event.channelId) {
    // 频道使用 Markdown 格式（如果是公网 URL）
    if (isHttpUrl) {
      await sendChannelMessage(token, event.channelId, `![](${imagePath})`, event.messageId);
    }
  }
});
```

**作用**：调用平台特定的 API 发送图片。

---

## 适配步骤

### Step 1: 设计平台专属标签

每个平台使用独特的标签名，避免冲突：

| 平台 | 标签格式 | 示例 |
|------|----------|------|
| QQ Bot | `<qqimg>path</qqimg>` | `<qqimg>/path/to/image.jpg</qqimg>` |
| Telegram | `<tgimg>path</tgimg>` | `<tgimg>https://example.com/photo.png</tgimg>` |
| Discord | `<dcimg>path</dcimg>` | `<dcimg>/Users/me/screenshot.png</dcimg>` |
| Slack | `<slackimg>path</slackimg>` | `<slackimg>file.jpg</slackimg>` |
| WeChat | `<wximg>path</wximg>` | `<wximg>media_id</wximg>` |

**设计原则**：
- ✅ 简短易记（平台缩写 + img）
- ✅ 符合 XML 标签规范
- ✅ 不与 Markdown 冲突

### Step 2: 注入系统提示（System Prompt）

在 Gateway 的消息处理逻辑中添加图片发送指南：

```typescript
// 示例：Telegram Gateway (telegram-gateway.ts)
let builtinPrompt = "";

builtinPrompt += `

【发送图片 - Telegram】
当用户要求发送图片时，使用 <tgimg> 标签：

<tgimg>图片路径或URL</tgimg>

示例：
- <tgimg>/Users/me/photo.jpg</tgimg>  （本地文件）
- <tgimg>https://example.com/image.png</tgimg>  （网络图片）

规则：
1. 本地文件必须是绝对路径
2. 支持 jpg, png, gif, webp 格式
3. 图片大小不超过 10MB（Telegram 限制）
4. 可以在文本前后插入多张图片
`;

// 将提示传递给 AI
const body = pluginRuntime.channel.reply.formatInboundEnvelope({
  // ... 其他参数
  systemPrompt: builtinPrompt,
});
```

### Step 3: 实现标签解析（Tag Parsing）

在 `deliver` 回调中解析 AI 回复：

```typescript
// 示例：Telegram 图片解析
const tgimgRegex = /<tgimg>([^<>]+)<\/(?:tgimg|img)>/gi;
const matches = [...replyText.matchAll(tgimgRegex)];

if (matches.length > 0) {
  const sendQueue: Array<{ type: "text" | "image"; content: string }> = [];
  
  let lastIndex = 0;
  let match;
  const regexWithIndex = /<tgimg>([^<>]+)<\/(?:tgimg|img)>/gi;
  
  while ((match = regexWithIndex.exec(replyText)) !== null) {
    // 文本部分
    const textBefore = replyText.slice(lastIndex, match.index).trim();
    if (textBefore) {
      sendQueue.push({ type: "text", content: textBefore });
    }
    
    // 图片部分
    const imagePath = match[1]?.trim();
    if (imagePath) {
      sendQueue.push({ type: "image", content: imagePath });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // 添加最后的文本
  const textAfter = replyText.slice(lastIndex).trim();
  if (textAfter) {
    sendQueue.push({ type: "text", content: textAfter });
  }
  
  // 按顺序发送
  for (const item of sendQueue) {
    if (item.type === "text") {
      await bot.sendMessage(chatId, item.content);
    } else if (item.type === "image") {
      await sendImage(chatId, item.content);
    }
  }
  
  return; // 处理完成，不再走普通文本发送流程
}

// 如果没有图片标签，走正常文本发送
await bot.sendMessage(chatId, replyText);
```

### Step 4: 实现图片发送逻辑

根据平台 API 特点实现发送：

```typescript
async function sendImage(chatId: string, imagePath: string) {
  const isLocalPath = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
  const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
  
  if (isLocalPath) {
    // 本地文件：检查存在性
    if (!fs.existsSync(imagePath)) {
      await bot.sendMessage(chatId, `❌ 图片文件不存在: ${imagePath}`);
      return;
    }
    
    // 平台特定处理
    // 方案 A：直接上传（Telegram, Discord）
    const fileStream = fs.createReadStream(imagePath);
    await bot.sendPhoto(chatId, fileStream);
    
    // 方案 B：转 Base64（QQ Bot）
    const fileBuffer = fs.readFileSync(imagePath);
    const base64Data = fileBuffer.toString("base64");
    const mimeType = getMimeType(imagePath);
    const dataUrl = `data:${mimeType};base64,${base64Data}`;
    await sendPhotoViaAPI(chatId, dataUrl);
    
    // 方案 C：上传到媒体服务器（WeChat）
    const mediaId = await uploadToMediaServer(imagePath);
    await sendImageMessage(chatId, mediaId);
    
  } else if (isHttpUrl) {
    // 网络图片：直接使用 URL
    await bot.sendPhoto(chatId, imagePath);
  } else {
    await bot.sendMessage(chatId, `❌ 无效的图片路径: ${imagePath}`);
  }
}
```

### Step 5: 更新全局工具文档（可选）

在 `~/.openclaw/workspace/TOOLS.md` 添加通用说明：

```markdown
## Image Sending - Universal Guide

Different chat platforms use different tags for sending images:

| Platform | Tag Format | Example |
|----------|------------|---------|
| QQ Bot | `<qqimg>path</qqimg>` | `<qqimg>/path/image.jpg</qqimg>` |
| Telegram | `<tgimg>path</tgimg>` | `<tgimg>https://example.com/photo.png</tgimg>` |
| Discord | `<dcimg>path</dcimg>` | `<dcimg>/Users/me/screenshot.png</dcimg>` |

### General Rules

1. **Always use absolute paths** for local files
2. **Include protocol** for web images (`http://` or `https://`)
3. **Check file size limits** (varies by platform)
4. **Mix text and images** naturally in your response

### Example

```
这是你要的文件：
<qqimg>/Users/me/report.png</qqimg>
报告已生成！
```
```

---

## 平台特定实现

### Telegram

**特点**：
- 支持文件流上传（最大 50MB）
- 支持公网 URL 直接发送
- 支持批量发送（MediaGroup）

**实现示例**：

```typescript
// telegram-gateway.ts
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

async function handleTelegramImage(bot: TelegramBot, chatId: number, imagePath: string) {
  const isLocalPath = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
  
  if (isLocalPath) {
    // 本地文件：使用文件流
    if (!fs.existsSync(imagePath)) {
      await bot.sendMessage(chatId, `❌ 图片不存在: ${imagePath}`);
      return;
    }
    
    // 检查文件大小（Telegram 限制 50MB）
    const stats = fs.statSync(imagePath);
    if (stats.size > 50 * 1024 * 1024) {
      await bot.sendMessage(chatId, `❌ 图片超过 50MB，无法发送`);
      return;
    }
    
    await bot.sendPhoto(chatId, fs.createReadStream(imagePath));
  } else {
    // 网络图片：直接发送 URL
    await bot.sendPhoto(chatId, imagePath);
  }
}
```

### Discord

**特点**：
- 使用 AttachmentBuilder 发送本地文件
- 支持 Embed 嵌入网络图片
- 单条消息最多 10 个附件

**实现示例**：

```typescript
// discord-gateway.ts
import { AttachmentBuilder, Message } from 'discord.js';
import fs from 'fs';

async function handleDiscordImage(message: Message, imagePath: string) {
  const isLocalPath = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
  
  if (isLocalPath) {
    // 本地文件：使用 AttachmentBuilder
    if (!fs.existsSync(imagePath)) {
      await message.reply(`❌ 图片不存在: ${imagePath}`);
      return;
    }
    
    const attachment = new AttachmentBuilder(imagePath);
    await message.reply({ files: [attachment] });
  } else {
    // 网络图片：使用 Embed
    const embed = {
      image: { url: imagePath }
    };
    await message.reply({ embeds: [embed] });
  }
}
```

### WeChat（企业微信）

**特点**：
- 需先上传到媒体服务器获取 media_id
- 媒体文件有效期 3 天
- 图片大小限制 2MB

**实现示例**：

```typescript
// wechat-gateway.ts
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';

async function handleWeChatImage(userId: string, imagePath: string, accessToken: string) {
  const isLocalPath = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
  
  if (isLocalPath) {
    // 本地文件：上传到微信媒体服务器
    if (!fs.existsSync(imagePath)) {
      await sendTextMessage(userId, `❌ 图片不存在: ${imagePath}`, accessToken);
      return;
    }
    
    // 检查文件大小（微信限制 2MB）
    const stats = fs.statSync(imagePath);
    if (stats.size > 2 * 1024 * 1024) {
      await sendTextMessage(userId, `❌ 图片超过 2MB，无法发送`, accessToken);
      return;
    }
    
    // 上传到媒体服务器
    const form = new FormData();
    form.append('media', fs.createReadStream(imagePath));
    
    const uploadResponse = await axios.post(
      `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=image`,
      form,
      { headers: form.getHeaders() }
    );
    
    const mediaId = uploadResponse.data.media_id;
    
    // 发送图片消息
    await axios.post(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
      {
        touser: userId,
        msgtype: "image",
        agentid: YOUR_AGENT_ID,
        image: { media_id: mediaId }
      }
    );
  } else {
    // 网络图片：需要先下载再上传
    // 微信不支持直接发送 URL
    const tempFile = `/tmp/wechat_${Date.now()}.jpg`;
    await downloadImage(imagePath, tempFile);
    await handleWeChatImage(userId, tempFile, accessToken);
    fs.unlinkSync(tempFile); // 清理临时文件
  }
}

async function downloadImage(url: string, savePath: string) {
  const response = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(savePath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}
```

### Slack

**特点**：
- 使用 `files.upload` API 上传文件
- 支持添加标题和注释
- 图片自动生成缩略图

**实现示例**：

```typescript
// slack-gateway.ts
import { WebClient } from '@slack/web-api';
import fs from 'fs';

async function handleSlackImage(client: WebClient, channelId: string, imagePath: string) {
  const isLocalPath = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
  
  if (isLocalPath) {
    // 本地文件：上传
    if (!fs.existsSync(imagePath)) {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ 图片不存在: ${imagePath}`
      });
      return;
    }
    
    await client.files.upload({
      channels: channelId,
      file: fs.createReadStream(imagePath),
      filename: imagePath.split('/').pop(),
    });
  } else {
    // 网络图片：使用 Block Kit 显示
    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: "image",
          image_url: imagePath,
          alt_text: "Image"
        }
      ]
    });
  }
}
```

---

## 最佳实践

### 1. 错误处理

```typescript
try {
  await sendImage(chatId, imagePath);
  log?.info(`✅ 图片发送成功: ${imagePath}`);
} catch (err) {
  log?.error(`❌ 图片发送失败: ${err}`);
  await sendErrorMessage(`图片发送失败: ${err instanceof Error ? err.message : String(err)}`);
}
```

### 2. 文件大小检查

```typescript
const MAX_SIZE_MAP = {
  qqbot: 10 * 1024 * 1024,    // 10MB
  telegram: 50 * 1024 * 1024,  // 50MB
  wechat: 2 * 1024 * 1024,     // 2MB
  discord: 25 * 1024 * 1024,   // 25MB (非 Nitro)
  slack: 1024 * 1024 * 1024,   // 1GB
};

const stats = fs.statSync(imagePath);
if (stats.size > MAX_SIZE_MAP[platform]) {
  throw new Error(`图片超过 ${MAX_SIZE_MAP[platform] / 1024 / 1024}MB`);
}
```

### 3. 格式验证

```typescript
const SUPPORTED_FORMATS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const ext = path.extname(imagePath).toLowerCase();

if (!SUPPORTED_FORMATS.includes(ext)) {
  throw new Error(`不支持的图片格式: ${ext}`);
}
```

### 4. 临时文件清理

```typescript
const tempFiles: string[] = [];

try {
  const tempFile = `/tmp/image_${Date.now()}.jpg`;
  tempFiles.push(tempFile);
  await downloadImage(url, tempFile);
  await sendLocalImage(chatId, tempFile);
} finally {
  // 清理临时文件
  for (const file of tempFiles) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
```

### 5. 日志记录

```typescript
log?.info(`[${platform}] Processing image: ${imagePath}`);
log?.info(`[${platform}] Image type: ${isLocalPath ? 'local' : 'url'}`);
log?.info(`[${platform}] File size: ${stats.size} bytes`);
log?.info(`[${platform}] Sending to: ${chatId}`);
```

---

## 完整示例：Telegram 插件

```typescript
// telegram-gateway.ts
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';

export async function startTelegramGateway(ctx: GatewayStartContext) {
  const { account, cfg, log } = ctx;
  const bot = new TelegramBot(account.token, { polling: true });
  
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    
    log?.info(`[telegram] Received message: ${msg.text}`);
    
    // 构建系统提示
    const systemPrompt = `
【发送图片 - Telegram】
使用 <tgimg> 标签发送图片：
<tgimg>图片路径或URL</tgimg>

示例：
- <tgimg>/Users/me/photo.jpg</tgimg>
- <tgimg>https://example.com/image.png</tgimg>
`;
    
    // 格式化消息并发送给 AI
    const body = pluginRuntime.channel.reply.formatInboundEnvelope({
      channel: "telegram",
      from: msg.from?.username || String(msg.from?.id),
      timestamp: msg.date * 1000,
      body: msg.text,
      chatType: msg.chat.type === "private" ? "direct" : "group",
      systemPrompt,
    });
    
    // 处理 AI 回复
    await pluginRuntime.channel.reply.handleIncomingMessage({
      Body: body,
      From: `telegram:${msg.chat.id}`,
      To: `telegram:${msg.chat.id}`,
      // ... 其他参数
      
      // deliver 回调：发送回复
      deliver: async (info, payload) => {
        const replyText = payload.text ?? "";
        
        // 解析 <tgimg> 标签
        const tgimgRegex = /<tgimg>([^<>]+)<\/(?:tgimg|img)>/gi;
        const matches = [...replyText.matchAll(tgimgRegex)];
        
        if (matches.length > 0) {
          const sendQueue: Array<{ type: "text" | "image"; content: string }> = [];
          
          let lastIndex = 0;
          let match;
          const regexWithIndex = /<tgimg>([^<>]+)<\/(?:tgimg|img)>/gi;
          
          while ((match = regexWithIndex.exec(replyText)) !== null) {
            const textBefore = replyText.slice(lastIndex, match.index).trim();
            if (textBefore) {
              sendQueue.push({ type: "text", content: textBefore });
            }
            
            const imagePath = match[1]?.trim();
            if (imagePath) {
              sendQueue.push({ type: "image", content: imagePath });
            }
            
            lastIndex = match.index + match[0].length;
          }
          
          const textAfter = replyText.slice(lastIndex).trim();
          if (textAfter) {
            sendQueue.push({ type: "text", content: textAfter });
          }
          
          // 按顺序发送
          for (const item of sendQueue) {
            try {
              if (item.type === "text") {
                await bot.sendMessage(msg.chat.id, item.content);
              } else if (item.type === "image") {
                await sendTelegramImage(bot, msg.chat.id, item.content, log);
              }
            } catch (err) {
              log?.error(`[telegram] Send error: ${err}`);
            }
          }
          
          return;
        }
        
        // 没有图片标签，直接发送文本
        await bot.sendMessage(msg.chat.id, replyText);
      }
    });
  });
}

async function sendTelegramImage(
  bot: TelegramBot,
  chatId: number,
  imagePath: string,
  log?: any
) {
  const isLocalPath = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
  const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
  
  if (isLocalPath) {
    // 本地文件
    if (!fs.existsSync(imagePath)) {
      log?.error(`[telegram] Image not found: ${imagePath}`);
      await bot.sendMessage(chatId, `❌ 图片文件不存在: ${imagePath}`);
      return;
    }
    
    // 检查文件大小
    const stats = fs.statSync(imagePath);
    if (stats.size > 50 * 1024 * 1024) {
      log?.error(`[telegram] Image too large: ${stats.size} bytes`);
      await bot.sendMessage(chatId, `❌ 图片超过 50MB，无法发送`);
      return;
    }
    
    // 检查格式
    const ext = path.extname(imagePath).toLowerCase();
    const supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!supportedFormats.includes(ext)) {
      log?.error(`[telegram] Unsupported format: ${ext}`);
      await bot.sendMessage(chatId, `❌ 不支持的图片格式: ${ext}`);
      return;
    }
    
    // 发送图片
    await bot.sendPhoto(chatId, fs.createReadStream(imagePath));
    log?.info(`[telegram] Sent local image: ${imagePath}`);
    
  } else if (isHttpUrl) {
    // 网络图片
    await bot.sendPhoto(chatId, imagePath);
    log?.info(`[telegram] Sent URL image: ${imagePath}`);
    
  } else {
    log?.error(`[telegram] Invalid image path: ${imagePath}`);
    await bot.sendMessage(chatId, `❌ 无效的图片路径: ${imagePath}`);
  }
}
```

---

## 总结

### 适配清单

- [ ] 1. 设计平台专属标签（如 `<tgimg>`）
- [ ] 2. 在 Gateway 中注入系统提示
- [ ] 3. 实现标签解析逻辑
- [ ] 4. 实现图片发送逻辑（本地/URL）
- [ ] 5. 添加错误处理和日志
- [ ] 6. 测试各种场景（本地文件、URL、混合文本）
- [ ] 7. 更新文档和示例

### 关键要点

1. **每个平台使用独特标签**，避免冲突
2. **系统提示要清晰**，告诉 AI 如何使用
3. **处理本地文件和 URL**，根据平台特点选择方案
4. **完善错误处理**，文件不存在、格式不支持、大小超限等
5. **按顺序发送**，保持文本和图片的原始顺序

### 参考资料

- QQ Bot 实现：`src/gateway.ts` (第 486-879 行)
- Platform API 文档：
  - [Telegram Bot API](https://core.telegram.org/bots/api)
  - [Discord.js Guide](https://discordjs.guide/)
  - [企业微信 API](https://developer.work.weixin.qq.com/document/)
  - [Slack API](https://api.slack.com/messaging/sending)

---

如有疑问，请参考 QQ Bot 的完整实现或联系开发团队。
