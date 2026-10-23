import assert from 'node:assert/strict';
import { parseResumeText } from '../resume-parser.mjs';

const sample = [
  '张三',
  '电话：13912345678',
  '邮箱：demo@example.com',
  '',
  '工作经历',
  '2022-2024 示例科技有限公司 Java 工程师',
  '负责订单系统开发与性能优化',
  '',
  '项目经历',
  '订单管理平台',
  '技术栈：Java、Spring Boot、MySQL',
  '',
  'AI项目',
  '智能客服 Agent',
  '使用 RAG 与工具调用'
].join('\n');

const drafts = parseResumeText(sample);
assert(drafts.some((item) => item.title === '姓名' && item.content === '张三'));
assert(drafts.some((item) => item.title === '手机号' && item.content === '13912345678'));
assert(drafts.some((item) => item.title === '邮箱' && item.content === 'demo@example.com'));
assert(drafts.some((item) => item.group === 'work' && item.content.includes('订单系统开发')));
assert(drafts.some((item) => item.group === 'project' && item.content.includes('订单管理平台')));
assert(drafts.some((item) => item.group === 'ai' && item.content.includes('智能客服 Agent')));

const empty = parseResumeText('   ');
assert.equal(empty.length, 0);
const fallback = parseResumeText('A simple resume body with Java and SQL');
assert.equal(fallback.length, 1);
assert.equal(fallback[0].group, 'custom');
console.log('PASS: local resume text parsing (7 assertions)');
