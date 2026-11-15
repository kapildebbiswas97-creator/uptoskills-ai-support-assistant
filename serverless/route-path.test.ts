import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreRewrittenApiPath, VERCEL_ORIGINAL_API_PATH } from './route-path.js';

test('restores rewritten nested paths while preserving duplicate and encoded query parameters', () => {
  const url = `/api/index?${VERCEL_ORIGINAL_API_PATH}=chat%2Fstream&filter=a+b&filter=c%2Fd&empty=`;
  assert.equal(restoreRewrittenApiPath(url), '/api/chat/stream?filter=a+b&filter=c%2Fd&empty=');
});

test('restores requester, HR, conversation, document, and escalation path shapes', () => {
  const paths = [
    'meeting-requests/mine',
    'meeting-requests/mine/request-123',
    'meeting-requests/mine/request-123/cancel',
    'admin/meeting-requests',
    'admin/meeting-requests/request-123',
    'admin/meeting-requests/request-123/confirm',
    'admin/meeting-requests/request-123/reject',
    'escalations/mine',
    'escalations/mine/ticket-123',
    'escalations/admin/escalations',
    'escalations/admin/escalations/ticket-123',
    'escalations/admin/escalations/ticket-123/notes',
    'conversations/conversation-123/messages',
    'documents/document-123',
    'not-a-real-route',
  ];
  for (const path of paths) {
    const rewritten = `/api/index?${VERCEL_ORIGINAL_API_PATH}=${encodeURIComponent(path)}`;
    assert.equal(restoreRewrittenApiPath(rewritten), `/api/${path}`);
  }
});

test('rejects invalid rewrite markers and leaves ordinary function URLs untouched', () => {
  assert.equal(restoreRewrittenApiPath(undefined), undefined);
  assert.equal(restoreRewrittenApiPath('/api/index'), undefined);
  assert.equal(restoreRewrittenApiPath(`/api/index?${VERCEL_ORIGINAL_API_PATH}=`), undefined);
  assert.equal(restoreRewrittenApiPath(`/api/index?${VERCEL_ORIGINAL_API_PATH}=../admin`), undefined);
});
