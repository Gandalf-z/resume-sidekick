import assert from 'node:assert/strict';
import { createCareerSyncPayload } from '../career-sync.mjs';

const item = {
  id: 'work-001',
  title: 'Java 工作经历',
  group: 'work',
  short: '负责 Java 服务端开发',
  long: '负责 Spring Boot 服务开发，使用 Redis 与 Kafka。',
  fields: { 公司: '示例公司', 职位: 'Java 工程师' }
};
const payload = createCareerSyncPayload([item], '1.3.0', '2026-11-04T00:00:00.000Z');
assert.equal(payload.version, '1.3.0');
assert.equal(payload.exportedAt, '2026-11-04T00:00:00.000Z');
assert.deepEqual(payload.resumeSidecarItems, [item]);
assert.throws(() => createCareerSyncPayload(null), /array/);
assert.throws(() => createCareerSyncPayload(new Array(501).fill(item)), /500/);
console.log('PASS: OpportunityRadar sync payload preserves original Sidekick facts (5 assertions)');
