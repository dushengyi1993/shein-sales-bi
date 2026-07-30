function clean(value) {
  return String(value || '').trim();
}

export function resolveLarkDeliveryTarget({config = {}, chatId = '', userId = ''} = {}) {
  const resolvedChatId = clean(chatId || process.env.SHEIN_LARK_RECIPIENT_CHAT_ID || config.recipientChatId);
  const resolvedUserId = clean(userId || process.env.SHEIN_LARK_RECIPIENT_USER_ID || config.recipientUserId);
  if (resolvedChatId) {
    if (!/^oc_[A-Za-z0-9]+$/.test(resolvedChatId)) throw new Error('Invalid Feishu recipientChatId');
    return Object.freeze({
      type: 'chat',
      id: resolvedChatId,
      cliArgs: Object.freeze(['--chat-id', resolvedChatId]),
    });
  }
  if (resolvedUserId) {
    if (!/^ou_[A-Za-z0-9]+$/.test(resolvedUserId)) throw new Error('Invalid Feishu recipientUserId');
    return Object.freeze({
      type: 'user',
      id: resolvedUserId,
      cliArgs: Object.freeze(['--user-id', resolvedUserId]),
    });
  }
  return null;
}

export function maskLarkDeliveryTarget(target) {
  if (!target?.id) return null;
  return `${target.type}:${target.id.slice(0, 5)}...${target.id.slice(-4)}`;
}
