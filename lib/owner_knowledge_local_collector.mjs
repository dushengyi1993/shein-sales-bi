import {redactOwnerKnowledgeSensitiveText} from './owner_knowledge_policy.mjs';

export {redactOwnerKnowledgeSensitiveText};

export function normalizeOwnerKnowledgeSyncState() {
  return {version: 2, retired: true};
}

export async function collectOwnerKnowledgeEvents() {
  const error = new Error('旧会话扫描采集器已废弃；规则只能由负责人任务结束检查提出候选');
  error.code = 'OWNER_KNOWLEDGE_SCANNER_RETIRED';
  throw error;
}
