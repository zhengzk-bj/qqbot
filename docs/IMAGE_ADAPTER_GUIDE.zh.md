# 其他聊天平台图片发送适配指南

本文档说明如何为其他聊天平台（Telegram、Discord、微信等）实现类似 QQ Bot 的图片发送功能。

## 🎯 快速开始

### 核心思路

QQ Bot 使用 **3 步机制**实现图片发送：

1. **系统提示**：告诉 AI 如何使用 `<qqimg>` 标签
2. **标签解析**：从 AI 回复中提取图片路径
3. **平台发送**：调用平台 API 发送图片

### 架构图

```
用户消息 → Gateway 接收 
         ↓
         注入系统提示（告诉 AI 如何发图片）
         ↓
         AI 处理 → 生成回复（包含 <qqimg> 标签）
         ↓
         解析标签 → 提取文本和图片
         ↓
         按顺序发送 → 调用平台 API
```

---

## 📝 适配步骤

### Step 1: 设计平台标签

为每个平台设计独特的图片标签：

```
QQ Bot:    <qqimg>path</qqimg>
Telegram:  <tgimg>path</tgimg>
Discord:   <dcimg>path</dcimg>
微信:       <wximg>path</wximg>
Slack:     <slackimg>path</slackimg>
```

### Step 2: 注入系统提示

在 Gateway 的消息处理中添加：

```typescript
// 示例：Telegram Gateway
let systemPrompt = `
【发送图片】
使用 <tgimg> 标签发送图片：

<tgimg>图片路径</tgimg>

示例：
- <tgimg>/Users/me/photo.jpg</tgimg>  （本地文件）
- <tgimg>https://example.com/img.png</tgimg>  （网络图片）

规则：
1. 本地文件必须是绝对路径
2. 支持 jpg、png、gif、webp 格式
3. 文件大小不超过 50MB
`;

// 传递给 AI
const body = pluginRuntime.channel.reply.formatInboundEnvelope({
  systemPrompt,
  // ... 其他参数
});
```

### Step 3: 解析标签

在 `deliver` 回调中解析 AI 回复：

```typescript
// 提取 <tgimg> 标签
const tgimgRegex = /<tgimg>([^<>]+)<\/(?:tgimg|img)>/gi;
const matches = [...replyText.matchAll(tgimgRegex)];

if (matches.length > 0) {
  // 构建发送队列（保持顺序）
  const queue: Array<{ type: "text" | "image"; content: string }> = [];
  
  let lastIndex = 0;
  let match;
  while ((match = tgimgRegex.exec(replyText)) !== null) {
    // 标签前的文本
    const textBefore = replyText.slice(lastIndex, match.index).trim();
    if (textBefore) {
      queue.push({ type: "text", content: textBefore });
    }
    
    // 图片路径
    const imagePath = match[1]?.trim();
    if (imagePath) {
      queue.push({ type: "image", content: imagePath });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // 标签后的文本
  const textAfter = replyText.slice(lastIndex).trim();
  if (textAfter) {
    queue.push({ type: "text", content: textAfter });
  }
  
  // 按顺序发送
  for (const item of queue) {
    if (item.type === "text") {
      await sendText(chatId, item.content);
    } else {
      await sendImage(chatId, item.content);
    }
  }
  
  return; // 处理完成
}

// 无图片标签，正常发送文本
await sendText(chatId, replyText);
```

### Step 4: 实现图片发送

根据平台特点实现发送逻辑：

```typescript
async function sendImage(chatId: string, imagePath: string) {
  const isLocal = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
  const isUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
  
  if (isLocal) {
    // 本地文件
    if (!fs.existsSync(imagePath)) {
      await sendText(chatId, `❌ 图片不存在: ${imagePath}`);
      return;
    }
    
    // 方案 A: 文件流上传（Telegram、Discord）
    await bot.sendPhoto(chatId, fs.createReadStream(imagePath));
    
    // 方案 B: Base64 上传（QQ Bot）
    const buffer = fs.readFileSync(imagePath);
    const base64 = buffer.toString("base64");
    const mimeType = getMimeType(imagePath);
    await sendPhotoAPI(chatId, `data:${mimeType};base64,${base64}`);
    
    // 方案 C: 媒体服务器（微信）
    const mediaId = await uploadToMediaServer(imagePath);
    await sendImageMessage(chatId, mediaId);
    
  } else if (isUrl) {
    // 网络图片
    await bot.sendPhoto(chatId, imagePath);
  } else {
    await sendText(chatId, `❌ 无效路径: ${imagePath}`);
  }
}
```

---

## 🚀 平台快速参考

### Telegram

```typescript
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

// 发送本地文件
await bot.sendPhoto(chatId, fs.createReadStream(imagePath));

// 发送网络图片
await bot.sendPhoto(chatId, imageUrl);

// 限制：50MB
```

### Discord

```typescript
import { AttachmentBuilder } from 'discord.js';

// 发送本地文件
const attachment = new AttachmentBuilder(imagePath);
await message.reply({ files: [attachment] });

// 发送网络图片（Embed）
await message.reply({
  embeds: [{ image: { url: imageUrl } }]
});

// 限制：25MB（非 Nitro）
```

### 微信（企业微信）

```typescript
import axios from 'axios';
import FormData from 'form-data';

// 1. 上传到媒体服务器
const form = new FormData();
form.append('media', fs.createReadStream(imagePath));

const uploadRes = await axios.post(
  `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`,
  form,
  { headers: form.getHeaders() }
);

const mediaId = uploadRes.data.media_id;

// 2. 发送图片消息
await axios.post(
  `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
  {
    touser: userId,
    msgtype: "image",
    agentid: agentId,
    image: { media_id: mediaId }
  }
);

// 限制：2MB
```

### Slack

```typescript
import { WebClient } from '@slack/web-api';

// 发送本地文件
await client.files.upload({
  channels: channelId,
  file: fs.createReadStream(imagePath),
  filename: path.basename(imagePath),
});

// 发送网络图片（Block Kit）
await client.chat.postMessage({
  channel: channelId,
  blocks: [{
    type: "image",
    image_url: imageUrl,
    alt_text: "Image"
  }]
});

// 限制：1GB
```

---

## ✅ 最佳实践

### 1. 文件检查

```typescript
// 检查存在性
if (!fs.existsSync(imagePath)) {
  throw new Error("文件不存在");
}

// 检查大小
const stats = fs.statSync(imagePath);
const MAX_SIZE = 50 * 1024 * 1024; // 50MB
if (stats.size > MAX_SIZE) {
  throw new Error("文件超过 50MB");
}

// 检查格式
const ext = path.extname(imagePath).toLowerCase();
const SUPPORTED = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
if (!SUPPORTED.includes(ext)) {
  throw new Error(`不支持的格式: ${ext}`);
}
```

### 2. 错误处理

```typescript
try {
  await sendImage(chatId, imagePath);
  log?.info(`✅ 图片发送成功: ${imagePath}`);
} catch (err) {
  log?.error(`❌ 图片发送失败: ${err}`);
  await sendErrorMessage(`发送失败: ${err.message}`);
}
```

### 3. 临时文件清理

```typescript
const tempFiles: string[] = [];

try {
  // 下载网络图片到临时文件
  const tempFile = `/tmp/img_${Date.now()}.jpg`;
  tempFiles.push(tempFile);
  await downloadImage(url, tempFile);
  
  // 发送
  await sendLocalImage(chatId, tempFile);
} finally {
  // 清理
  for (const file of tempFiles) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
```

### 4. 日志记录

```typescript
log?.info(`[${platform}] 处理图片: ${imagePath}`);
log?.info(`[${platform}] 类型: ${isLocal ? '本地' : 'URL'}`);
log?.info(`[${platform}] 大小: ${stats.size} bytes`);
log?.info(`[${platform}] 发送至: ${chatId}`);
```

---

## 📊 平台对比表

| 平台 | 标签 | 本地文件 | 网络图片 | 大小限制 | 上传方式 |
|------|------|----------|----------|----------|----------|
| QQ Bot | `<qqimg>` | ✅ | ✅ | 10MB | Base64 |
| Telegram | `<tgimg>` | ✅ | ✅ | 50MB | Stream |
| Discord | `<dcimg>` | ✅ | ✅ | 25MB | Attachment |
| 微信 | `<wximg>` | ✅ | ❌* | 2MB | Media Server |
| Slack | `<slackimg>` | ✅ | ✅ | 1GB | files.upload |

*微信不支持直接发送 URL，需先下载再上传

---

## 🔧 测试清单

在部署前，确保测试以下场景：

- [ ] 发送本地文件（绝对路径）
- [ ] 发送网络图片（HTTP URL）
- [ ] 混合文本和图片（多张）
- [ ] 文件不存在错误处理
- [ ] 文件超过大小限制
- [ ] 不支持的文件格式
- [ ] 相对路径错误处理
- [ ] 无效 URL 错误处理

---

## 📚 参考资料

### QQ Bot 实现

- 系统提示注入：`src/gateway.ts` 第 486-503 行
- 标签解析逻辑：`src/gateway.ts` 第 748-779 行
- 图片发送实现：`src/gateway.ts` 第 806-869 行

### 平台 API 文档

- [Telegram Bot API](https://core.telegram.org/bots/api#sendphoto)
- [Discord.js 文档](https://discord.js.org/#/docs/discord.js/main/class/TextChannel?scrollTo=send)
- [企业微信 API](https://developer.work.weixin.qq.com/document/path/90236)
- [Slack API](https://api.slack.com/methods/files.upload)

### 详细指南

完整实现示例和代码，请参考：
- [IMAGE_ADAPTER_GUIDE.md](./IMAGE_ADAPTER_GUIDE.md)（英文详细版）

---

## 💡 常见问题

### Q: 为什么每个平台要用不同的标签？

**A**: 避免冲突。如果 AI 在 Telegram 回复中使用了 `<qqimg>`，会导致解析失败。使用平台专属标签可以确保在正确的平台处理图片。

### Q: 可以支持视频或其他媒体类型吗？

**A**: 可以！参考图片的实现模式：
- 设计标签：`<tgvideo>`, `<qqvideo>` 等
- 添加系统提示
- 解析标签并调用对应 API

### Q: 如何处理大文件？

**A**: 根据平台限制：
1. **压缩**：使用 Sharp、ImageMagick 等工具
2. **分片上传**：对于支持的平台（如 Slack）
3. **提示用户**：文件过大时建议使用外部链接

### Q: 网络图片下载失败怎么办？

**A**: 实现超时和重试机制：

```typescript
async function downloadImage(url: string, savePath: string, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 30000, // 30秒超时
      });
      
      const writer = fs.createWriteStream(savePath);
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(1000 * (i + 1)); // 递增延迟
    }
  }
}
```

---

## 🎉 完成

按照本指南，您可以为任何聊天平台实现图片发送功能！

关键步骤回顾：
1. ✅ 设计平台标签
2. ✅ 注入系统提示
3. ✅ 解析标签
4. ✅ 实现发送逻辑
5. ✅ 测试和优化

如有疑问，请参考 QQ Bot 的完整实现或查看详细文档。
