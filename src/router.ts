import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function sanitizeSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

export function escapeXml(s: string): string {
  if (!s) return '';
  return sanitizeSurrogates(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    if (m.is_reaction && m.reaction_emoji) {
      return `<reaction sender="${escapeXml(m.sender_name)}" emoji="${escapeXml(m.reaction_emoji)}" time="${escapeXml(displayTime)}"/>`;
    }
    let body = escapeXml(m.content);
    if (m.quote_content) {
      const sender = escapeXml(m.quote_sender_name || 'Unknown');
      const excerpt = escapeXml(m.quote_content.slice(0, 80));
      body = `&gt; ${sender}: ${excerpt}\n${body}`;
    }
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${body}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  senderName?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, senderName);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
