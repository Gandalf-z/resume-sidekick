import * as pdfjsLib from './lib/pdf.mjs';
import { parseResumeText } from './resume-parser.mjs';

'use strict';

const KEY_ITEMS = 'resumeSidecarItems';
const KEY_LAST_USED = 'resumeSidecarLastUsed';
const $ = (id) => document.getElementById(id);
const GROUPS = {
  basic: '基础信息',
  work: '工作经历',
  project: '项目经历',
  ai: 'AI 应用',
  answer: '面试问答',
  custom: '其他资料'
};
const GROUP_ORDER = ['basic', 'work', 'project', 'ai', 'answer', 'custom'];

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');

let items = [];
let lastUsed = {};
let activeGroup = 'all';
let viewMode = 'short';
let selectedMap = new Map();
let pendingImport = null;
let pdfDrafts = [];
let pdfSourceName = '';
let statusTimer = null;

function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function escapeHtml(value) {
  return toText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalize(value) {
  return toText(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function groupLabel(group) {
  return GROUPS[group] || group || '其他资料';
}

function fieldEntries(fields) {
  if (!fields || typeof fields !== 'object') return [];
  if (!Array.isArray(fields) && fields['字段'] !== undefined && fields['值'] !== undefined) {
    return [{ key: 'pair', label: toText(fields['字段']) || '字段', value: toText(fields['值']) }];
  }
  if (Array.isArray(fields)) {
    return fields.map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const label = entry.label || entry.name || entry.field || entry.key || ('字段 ' + (index + 1));
      const value = entry.value ?? entry.text ?? entry.content;
      if (value === null || value === undefined || toText(value).trim() === '') return null;
      return { key: String(index), label: toText(label), value: toText(value) };
    }).filter(Boolean);
  }
  return Object.entries(fields).map(([key, value]) => ({
    key,
    label: toText(key),
    value: toText(value)
  })).filter((entry) => entry.label && entry.value.trim() !== '');
}

function itemContent(item, mode = viewMode) {
  if (!item) return '';
  const preferred = mode === 'long' ? (item.long || item.short) : (item.short || item.long);
  if (toText(preferred).trim()) return toText(preferred).trim();
  const entries = fieldEntries(item.fields);
  if (entries.length === 1) return entries[0].value;
  return entries.map((entry) => entry.label + '：' + entry.value).join('\n');
}

function itemSearchText(item) {
  return [
    item.title, item.subtitle, groupLabel(item.group), item.short, item.long,
    ...fieldEntries(item.fields).flatMap((entry) => [entry.label, entry.value])
  ].join(' ').toLowerCase();
}

function showStatus(message, type = '') {
  const el = $('status');
  el.textContent = message;
  el.className = 'status visible' + (type ? ' ' + type : '');
  if (statusTimer) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    el.className = 'status';
    el.textContent = '';
  }, 4200);
}

async function saveState() {
  await chrome.storage.local.set({ [KEY_ITEMS]: items, [KEY_LAST_USED]: lastUsed });
}

function getItem(id) {
  return items.find((item) => String(item.id) === String(id)) || null;
}

function selectionPayload(type, itemId, index, mode) {
  const item = getItem(itemId);
  if (!item) return null;
  if (type === 'field') {
    const entry = fieldEntries(item.fields)[Number(index)];
    if (!entry) {
      const content = itemContent(item, viewMode);
      return content ? { key: 'field:' + itemId + ':fallback', label: item.title || '资料', value: content } : null;
    }
    return { key: 'field:' + itemId + ':' + entry.key, label: entry.label || item.title || '字段', value: entry.value };
  }
  const content = itemContent(item, mode || viewMode);
  if (!content) return null;
  return {
    key: 'summary:' + itemId + ':' + (mode || viewMode),
    label: (item.title || '资料') + (mode === 'long' ? '（详细版）' : '（精简版）'),
    value: content
  };
}

function renderFilters() {
  const query = normalize($('searchInput').value);
  const counts = { all: 0 };
  GROUP_ORDER.forEach((group) => { counts[group] = 0; });
  items.forEach((item) => {
    counts.all += 1;
    const group = GROUPS[item.group] ? item.group : 'custom';
    counts[group] = (counts[group] || 0) + 1;
  });
  const filters = [{ key: 'all', label: '全部', count: counts.all }]
    .concat(GROUP_ORDER.filter((group) => counts[group]).map((group) => ({ key: group, label: groupLabel(group), count: counts[group] })));
  $('groupFilters').innerHTML = filters.map((filter) =>
    '<button class="filter-chip' + (activeGroup === filter.key ? ' active' : '') +
    '" type="button" data-filter="' + escapeHtml(filter.key) + '">' +
    escapeHtml(filter.label) + ' ' + filter.count + '</button>'
  ).join('');
}

function itemMatches(item, query) {
  if (activeGroup !== 'all' && (GROUPS[item.group] ? item.group : 'custom') !== activeGroup) return false;
  return !query || normalize(itemSearchText(item)).includes(query);
}

function renderBasicCard(item) {
  const entries = fieldEntries(item.fields);
  const entry = entries[0] || { key: 'fallback', label: item.title || '资料', value: itemContent(item) };
  const index = entries.length ? 0 : -1;
  const selection = index >= 0 ? selectionPayload('field', item.id, index) : selectionPayload('summary', item.id, null, viewMode);
  const selectKey = selection ? selection.key : 'field:' + item.id + ':fallback';
  const value = entry.value || itemContent(item);
  const selected = selectedMap.has(selectKey);
  return '<article class="quick-card" data-item-id="' + escapeHtml(item.id) + '" data-field-index="' + index + '">' +
    '<div class="quick-card-top"><span class="quick-card-title">' + escapeHtml(entry.label || item.title) + '</span>' +
    '<label class="select-check" title="勾选后可批量复制"><input type="checkbox" data-select-key="' + escapeHtml(selectKey) +
    '" data-select-type="' + (index >= 0 ? 'field' : 'summary') + '" data-item-id="' + escapeHtml(item.id) +
    '" data-field-index="' + index + '" data-mode="' + viewMode + '"' + (selected ? ' checked' : '') + '>勾选</label></div>' +
    '<div class="quick-value' + (!value ? ' empty' : '') + '">' + escapeHtml(value || '还没有填写内容') + '</div>' +
    '<div class="quick-actions"><button class="btn field-copy-btn" type="button" data-action="copy-field" data-item-id="' +
    escapeHtml(item.id) + '" data-field-index="' + index + '">' + (value ? '复制' : '复制内容') + '</button>' +
    '<button class="btn btn-quiet btn-small" type="button" data-action="fill-field" data-item-id="' + escapeHtml(item.id) + '" data-field-index="' + index + '">填入</button>' +
    '<button class="btn btn-quiet btn-small" type="button" data-action="edit" data-item-id="' + escapeHtml(item.id) + '">编辑</button></div>' +
    '</article>';
}

function renderExperienceCard(item) {
  const entries = fieldEntries(item.fields);
  const summary = itemContent(item, viewMode);
  const summaryPayload = selectionPayload('summary', item.id, null, viewMode);
  const summaryKey = summaryPayload ? summaryPayload.key : 'summary:' + item.id + ':' + viewMode;
  const isSummarySelected = selectedMap.has(summaryKey);
  const fieldHtml = entries.map((entry, index) => {
    const payload = selectionPayload('field', item.id, index);
    const key = payload ? payload.key : 'field:' + item.id + ':' + entry.key;
    const checked = selectedMap.has(key);
    return '<div class="experience-field"><div class="experience-field-main">' +
      '<label class="select-check" title="勾选此字段"><input type="checkbox" data-select-key="' + escapeHtml(key) +
      '" data-select-type="field" data-item-id="' + escapeHtml(item.id) + '" data-field-index="' + index + '"' +
      (checked ? ' checked' : '') + '></label>' +
      '<div class="experience-field-text"><div class="experience-field-label">' + escapeHtml(entry.label) +
      '</div><div class="experience-field-value">' + escapeHtml(entry.value) + '</div></div></div>' +
      '<div class="field-row-actions"><button class="btn field-copy-btn" type="button" data-action="copy-field" data-item-id="' +
      escapeHtml(item.id) + '" data-field-index="' + index + '">复制</button><button class="btn btn-quiet btn-small" type="button" data-action="fill-field" data-item-id="' +
      escapeHtml(item.id) + '" data-field-index="' + index + '">填入</button></div></div>'; 
  }).join('');
  const summaryHtml = summary ? '<div class="record-summary"><div class="summary-heading">' +
    '<span>经历文本 · ' + escapeHtml(viewMode === 'long' ? '详细版' : '精简版') + '</span>' +
    '<span>勾选上方复选框可批量复制</span></div>' +
    '<div class="summary-text">' + escapeHtml(summary) + '</div>' +
    '<div class="summary-actions"><button class="btn field-copy-btn" type="button" data-action="copy-summary" data-item-id="' +
    escapeHtml(item.id) + '">复制经历内容</button><button class="btn btn-quiet btn-small" type="button" data-action="fill-record" data-item-id="' +
    escapeHtml(item.id) + '">填入网页</button></div></div>' : '';
  return '<article class="experience-card"><div class="experience-header"><div class="experience-title-wrap">' +
    '<label class="select-check" title="勾选整段经历"><input type="checkbox" data-select-key="' + escapeHtml(summaryKey) +
    '" data-select-type="summary" data-item-id="' + escapeHtml(item.id) + '" data-mode="' + viewMode + '"' +
    (isSummarySelected ? ' checked' : '') + '></label><div><h3 class="experience-title">' +
    escapeHtml(item.title || '未命名资料') + '</h3><p class="experience-subtitle">' +
    escapeHtml(item.subtitle || groupLabel(item.group)) + '</p></div></div><div class="experience-actions">' +
    '<button class="icon-button' + (item.favorite ? ' favorite' : '') + '" type="button" data-action="favorite" data-item-id="' +
    escapeHtml(item.id) + '" title="' + (item.favorite ? '取消收藏' : '收藏') + '" aria-label="' +
    (item.favorite ? '取消收藏' : '收藏') + '">' + (item.favorite ? '★' : '☆') + '</button>' +
    '<button class="icon-button" type="button" data-action="edit" data-item-id="' + escapeHtml(item.id) +
    '" title="编辑资料" aria-label="编辑资料">✎</button></div></div>' +
    (fieldHtml ? '<div class="experience-fields">' + fieldHtml + '</div>' : '') + summaryHtml + '</article>';
}

function renderCards() {
  const query = normalize($('searchInput').value);
  const visible = items.filter((item) => itemMatches(item, query));
  $('visibleCount').textContent = '显示 ' + visible.length + ' / ' + items.length + ' 条资料';
  if (!visible.length) {
    $('cardsContainer').innerHTML = '<div class="group-section"><div class="empty-list">没有找到匹配资料。试试其他关键词，或切换分类。</div></div>';
    return;
  }
  const groupKeys = activeGroup === 'all' ? GROUP_ORDER : [activeGroup];
  const html = groupKeys.map((group) => {
    const groupItems = visible.filter((item) => (GROUPS[item.group] ? item.group : 'custom') === group);
    if (!groupItems.length) return '';
    const countLabel = groupItems.length + ' 条';
    if (group === 'basic') {
      return '<section class="group-section"><div class="group-heading"><div><h2>' + escapeHtml(groupLabel(group)) +
        '</h2><p class="group-subtitle">常用信息直接复制，不用进入详情</p></div><span class="group-count">' + countLabel +
        '</span></div><div class="quick-grid">' + groupItems.map(renderBasicCard).join('') + '</div></section>';
    }
    return '<section class="group-section"><div class="group-heading"><div><h2>' + escapeHtml(groupLabel(group)) +
      '</h2><p class="group-subtitle">可复制单个字段，也可复制整段经历</p></div><span class="group-count">' + countLabel +
      '</span></div><div class="experience-list">' + groupItems.map(renderExperienceCard).join('') + '</div></section>';
  }).join('');
  $('cardsContainer').innerHTML = html || '<div class="group-section"><div class="empty-list">当前分类没有资料。</div></div>';
}

function renderSelectionBar() {
  const count = selectedMap.size;
  $('selectedCount').textContent = '已选 ' + count + ' 项';
  $('copySelectedBtn').disabled = count === 0;
  $('copySelectedBtn').textContent = count ? '复制已选 ' + count : '复制已选';
}

function renderAll() {
  renderFilters();
  renderCards();
  renderSelectionBar();
  document.querySelectorAll('[data-mode]').forEach((button) => {
    if (button.classList.contains('mode-button')) {
      button.classList.toggle('active', button.getAttribute('data-mode') === viewMode);
    }
  });
}

async function copyText(text, label = '内容') {
  if (!toText(text).trim()) {
    showStatus('“' + label + '”没有可复制的内容。', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(toText(text));
    showStatus('已复制：' + label, 'success');
  } catch (_) {
    showStatus('复制失败。请检查剪贴板权限，或手动选中内容复制。', 'error');
  }
}

async function copyField(itemId, fieldIndex) {
  const item = getItem(itemId);
  if (!item) return;
  const entries = fieldEntries(item.fields);
  const entry = entries[Number(fieldIndex)];
  if (entry) return copyText(entry.value, entry.label || item.title);
  return copyText(itemContent(item), item.title || '资料');
}

async function copySummary(itemId) {
  const item = getItem(itemId);
  if (!item) return;
  const content = itemContent(item, viewMode);
  lastUsed[item.id] = new Date().toISOString();
  await saveState();
  await copyText(content, (item.title || '资料') + (viewMode === 'long' ? '（详细版）' : '（精简版）'));
}

async function copySelected() {
  const selected = Array.from(selectedMap.values()).filter((entry) => toText(entry.value).trim());
  if (!selected.length) return;
  const text = selected.length === 1 ? selected[0].value : selected.map((entry) => entry.label + '：\n' + entry.value).join('\n\n');
  await copyText(text, selected.length === 1 ? selected[0].label : selected.length + ' 个字段');
}

function updateSelection(input) {
  const type = input.getAttribute('data-select-type');
  const itemId = input.getAttribute('data-item-id');
  const index = input.getAttribute('data-field-index');
  const mode = input.getAttribute('data-mode') || viewMode;
  const payload = selectionPayload(type, itemId, index, mode);
  if (!payload) return;
  if (input.checked) selectedMap.set(payload.key, { label: payload.label, value: payload.value });
  else selectedMap.delete(payload.key);
  renderSelectionBar();
}

function selectVisible() {
  selectedMap.clear();
  document.querySelectorAll('#cardsContainer input[data-select-key]').forEach((input) => {
    const payload = selectionPayload(input.getAttribute('data-select-type'), input.getAttribute('data-item-id'),
      input.getAttribute('data-field-index'), input.getAttribute('data-mode') || viewMode);
    if (payload) {
      selectedMap.set(payload.key, { label: payload.label, value: payload.value });
      input.checked = true;
    } else {
      input.checked = false;
    }
  });
  renderSelectionBar();
  showStatus('已勾选当前显示的字段与经历。', 'success');
}

function openEditor(item) {
  $('editDialogTitle').textContent = item ? '编辑资料' : '新增资料';
  $('editId').value = item ? toText(item.id) : '';
  $('editTitle').value = item ? toText(item.title) : '';
  $('editSubtitle').value = item ? toText(item.subtitle) : '';
  $('editGroup').value = item ? (item.group || 'custom') : 'custom';
  $('editShort').value = item ? toText(item.short) : '';
  $('editLong').value = item ? toText(item.long) : '';
  $('editFields').value = JSON.stringify(item && item.fields ? item.fields : {}, null, 2);
  $('editError').textContent = '';
  $('editDialog').showModal();
  $('editTitle').focus();
}

async function saveEditor(event) {
  event.preventDefault();
  $('editError').textContent = '';
  let fields;
  try {
    fields = JSON.parse($('editFields').value || '{}');
    if (!fields || typeof fields !== 'object') throw new Error('字段必须是 JSON 对象或数组');
  } catch (_) {
    $('editError').textContent = '结构化字段不是有效 JSON，请检查括号、引号和逗号。';
    return;
  }
  const title = $('editTitle').value.trim();
  if (!title) {
    $('editError').textContent = '请填写资料名称。';
    $('editTitle').focus();
    return;
  }
  const id = $('editId').value || ('custom-' + Date.now());
  const old = getItem(id);
  const updated = {
    id, title, subtitle: $('editSubtitle').value.trim(), group: $('editGroup').value || 'custom',
    short: $('editShort').value, long: $('editLong').value, fields, favorite: old ? !!old.favorite : false
  };
  if (old) items = items.map((item) => String(item.id) === String(id) ? updated : item);
  else items.unshift(updated);
  selectedMap.clear();
  await saveState();
  $('editDialog').close();
  renderAll();
  showStatus('已保存“' + title + '”。', 'success');
}

async function toggleFavorite(itemId) {
  const item = getItem(itemId);
  if (!item) return;
  item.favorite = !item.favorite;
  await saveState();
  renderAll();
  showStatus(item.favorite ? '已收藏这条资料。' : '已取消收藏。', 'success');
}

async function exportBackup() {
  const data = { [KEY_ITEMS]: items, [KEY_LAST_USED]: lastUsed, exportedAt: new Date().toISOString(), version: '1.2.0' };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '求职随身简历-V1.2.0-本地备份-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  showStatus('已生成本地 JSON 备份。该文件包含个人简历资料，请妥善保存。', 'success');
}

function closeImportDialog() {
  pendingImport = null;
  $('importDialog').close();
}

async function confirmImport() {
  if (!pendingImport) return;
  const byId = new Map(items.map((item) => [String(item.id), item]));
  pendingImport.items.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const id = toText(raw.id || ('imported-' + Date.now() + '-' + index));
    byId.set(id, { ...raw, id });
  });
  items = Array.from(byId.values());
  if (pendingImport.lastUsed && typeof pendingImport.lastUsed === 'object') {
    lastUsed = { ...lastUsed, ...pendingImport.lastUsed };
  }
  const count = pendingImport.items.length;
  selectedMap.clear();
  await saveState();
  closeImportDialog();
  renderAll();
  showStatus('已导入 ' + count + ' 条资料；其他本地资料已保留。', 'success');
}

async function handleImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data[KEY_ITEMS];
    if (!Array.isArray(incoming)) throw new Error('没有找到简历资料列表');
    pendingImport = {
      items: incoming,
      lastUsed: !Array.isArray(data) && data[KEY_LAST_USED] && typeof data[KEY_LAST_USED] === 'object' ? data[KEY_LAST_USED] : {}
    };
    $('importSummary').textContent = '检测到 ' + incoming.length + ' 条资料。导入将更新相同 ID 的资料，并保留其他本地资料。';
    $('importDialog').showModal();
  } catch (_) {
    showStatus('导入失败：文件格式不正确，或其中没有求职随身简历资料。', 'error');
  }
}

function fillIntoPage(payload) {
  const norm = (value) => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const isEditable = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return !el.disabled && !el.readOnly;
    if (el.tagName === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      return !el.disabled && !el.readOnly && !['hidden', 'button', 'submit', 'reset', 'file', 'checkbox', 'radio', 'password', 'image'].includes(type);
    }
    return false;
  };
  const visible = (el) => isEditable(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const elements = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]')).filter(visible);
  const fields = payload && payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  let pairs = [];
  if (!Array.isArray(fields) && fields['字段'] !== undefined && fields['值'] !== undefined) {
    pairs = [[String(fields['字段']), String(fields['值'])]];
  } else if (!Array.isArray(fields)) {
    pairs = Object.entries(fields).filter((entry) => entry[1] !== null && entry[1] !== undefined && typeof entry[1] !== 'object' && String(entry[1]).trim() !== '')
      .map((entry) => [String(entry[0]), String(entry[1])]);
  } else {
    pairs = fields.map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const key = entry.label || entry.name || entry.field || entry.key;
      const value = entry.value ?? entry.text ?? entry.content;
      return key && value !== undefined ? [String(key), String(value)] : null;
    }).filter(Boolean);
  }
  const aliases = {
    '姓名': ['姓名', '名字', 'name', 'fullname', '真实姓名'],
    '手机': ['手机号', '手机', '电话', 'mobile', 'phone', '联系电话'],
    '邮箱': ['邮箱', 'email', 'mail', '电子邮件'],
    '公司名称': ['公司名称', '公司', '企业', '工作单位', '所属公司', 'company', 'employer'],
    '职位': ['职位', '岗位', '职务', 'position', 'jobtitle', '职位名称'],
    '部门': ['部门', 'department', '团队'],
    '工作地点': ['工作地点', '工作城市', '城市', '地点', 'location', 'city'],
    '开始时间': ['开始时间', '入职时间', '开始日期', 'startdate', 'fromdate'],
    '结束时间': ['结束时间', '离职时间', '结束日期', 'enddate', 'todate'],
    '项目名称': ['项目名称', '项目名', 'projectname'],
    '项目描述': ['项目描述', '项目介绍', '项目背景', 'projectdescription', 'projectintro'],
    '项目职责': ['项目职责', '负责内容', '项目责任', 'responsibility'],
    '个人职责': ['个人职责', '工作职责', '工作内容', 'responsibility', 'duties'],
    '项目成果': ['项目成果', '成果', '业绩', 'achievement', 'results'],
    '技术栈': ['技术栈', '技术', '技能', 'technology', 'techstack', 'skills']
  };
  const candidatesFor = (el) => {
    const values = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('title')];
    if (el.labels) Array.from(el.labels).forEach((label) => values.push(label.innerText || label.textContent));
    const parentLabel = el.closest('label');
    if (parentLabel) values.push(parentLabel.innerText || parentLabel.textContent);
    return values.filter(Boolean).map(norm);
  };
  const setValue = (el, value) => {
    if (el.isContentEditable) el.textContent = value;
    else if (el.tagName === 'SELECT') {
      const wanted = norm(value);
      const option = Array.from(el.options).find((opt) => norm(opt.value) === wanted || norm(opt.textContent) === wanted ||
        norm(opt.textContent).includes(wanted) || wanted.includes(norm(opt.textContent)));
      if (option) el.value = option.value;
      else return false;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  let filled = 0;
  const unmatched = [];
  const used = new Set();
  pairs.forEach(([key, value]) => {
    const keyNorm = norm(key);
    const aliasesForKey = aliases[key] || [key];
    const aliasNorms = aliasesForKey.map(norm).filter(Boolean);
    let best = null;
    let bestScore = 0;
    elements.forEach((el) => {
      if (used.has(el)) return;
      const candidates = candidatesFor(el);
      let score = 0;
      candidates.forEach((candidate) => {
        if (!candidate) return;
        if (candidate === keyNorm) score = Math.max(score, 10);
        else if (keyNorm && candidate.includes(keyNorm)) score = Math.max(score, 8);
        else if (keyNorm && keyNorm.includes(candidate) && candidate.length > 2) score = Math.max(score, 5);
        aliasNorms.forEach((alias) => {
          if (alias && candidate === alias) score = Math.max(score, 9);
          else if (alias && candidate.includes(alias)) score = Math.max(score, 7);
        });
      });
      if (score > bestScore) { bestScore = score; best = el; }
    });
    if (best && bestScore >= 5) {
      if (setValue(best, value)) { used.add(best); filled += 1; } else unmatched.push(key);
    } else unmatched.push(key);
  });
  if (filled === 0) {
    const fallbackText = String((payload && payload.text) || '');
    let target = document.activeElement;
    if (!visible(target)) target = elements.find((el) => el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (!visible(target)) target = elements.find((el) => el.tagName === 'INPUT' && (el.type || 'text') === 'text');
    if (target && fallbackText) {
      setValue(target, fallbackText);
      filled = 1;
      return { filled, total: pairs.length, unmatched, message: '没有识别到对应字段，已把内容填入当前可编辑输入框。请检查后再提交。' };
    }
  }
  if (filled > 0) return { filled, total: pairs.length, unmatched, message: '已尝试填入 ' + filled + ' 个字段，请检查内容对应关系，确认无误后再提交。' };
  return { filled: 0, total: pairs.length, unmatched, message: '没有找到匹配字段。可以先点招聘页面的目标输入框，再点“填入网页”，或直接复制。' };
}

async function fillPayload(payload, label) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return showStatus('没有找到当前网页标签页。', 'error');
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillIntoPage, args: [payload] });
    const result = results && results[0] ? results[0].result : null;
    if (result && result.filled > 0) showStatus(result.message, 'success');
    else showStatus(result && result.message ? result.message : '没有找到可填写的字段。', 'error');
  } catch (_) {
    showStatus('当前页面不允许扩展填入。请切换到招聘表单页面后重试。', 'error');
  }
}

async function fillField(itemId, fieldIndex) {
  const item = getItem(itemId);
  if (!item) return;
  const entry = fieldEntries(item.fields)[Number(fieldIndex)];
  if (!entry) return fillPayload({ fields: item.fields || {}, text: itemContent(item) }, item.title);
  return fillPayload({ fields: { [entry.label]: entry.value }, text: entry.value }, entry.label);
}

async function fillRecord(itemId) {
  const item = getItem(itemId);
  if (!item) return;
  return fillPayload({ fields: item.fields || {}, text: itemContent(item) }, item.title);
}

async function extractPdfText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: chrome.runtime.getURL('lib/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('lib/standard_fonts/'),
    useWorkerFetch: true,
    isEvalSupported: false
  });
  const pdf = await task.promise;
  const pageTexts = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const lines = [];
    let lastY = null;
    for (const item of content.items) {
      if (!item || typeof item.str !== 'string') continue;
      const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) lines.push('\n');
      else if (lines.length && lines[lines.length - 1] !== '\n') lines.push(' ');
      lines.push(item.str);
      if (y !== null) lastY = y;
    }
    pageTexts.push(lines.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'));
  }
  if (typeof pdf.destroy === 'function') await pdf.destroy();
  return pageTexts.join('\n\n').trim();
}

function renderPdfDrafts() {
  const container = $('pdfDrafts');
  if (!pdfDrafts.length) {
    container.innerHTML = '<div class="empty-list">没有识别到可导入的内容。你可以在上方修正文字后再次识别。</div>';
    $('confirmPdfBtn').disabled = true;
    return;
  }
  container.innerHTML = pdfDrafts.map((draft, index) =>
    '<article class="pdf-draft"><div class="pdf-draft-head"><input type="checkbox" data-pdf-field="checked" data-index="' + index +
    '"' + (draft.checked ? ' checked' : '') + ' aria-label="勾选导入">' +
    '<input type="text" data-pdf-field="title" data-index="' + index + '" value="' + escapeHtml(draft.title) + '" aria-label="资料名称">' +
    '<select data-pdf-field="group" data-index="' + index + '" aria-label="资料分类">' +
    GROUP_ORDER.map((group) => '<option value="' + group + '"' + (draft.group === group ? ' selected' : '') + '>' + escapeHtml(groupLabel(group)) + '</option>').join('') +
    '</select></div><textarea data-pdf-field="content" data-index="' + index + '" aria-label="导入内容">' + escapeHtml(draft.content) +
    '</textarea></article>'
  ).join('');
  $('confirmPdfBtn').disabled = !pdfDrafts.some((draft) => draft.checked);
}

function openPdfDialog() {
  $('pdfFileMeta').textContent = pdfSourceName ? '文件：' + pdfSourceName : '选择一个包含可选中文本的 PDF 简历。扫描图片版 PDF 可能需要先 OCR。';
  $('pdfParseStatus').textContent = '';
  if (!$('pdfDialog').open) $('pdfDialog').showModal();
}

async function handlePdfFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showStatus('请选择 PDF 文件。', 'error');
    return;
  }
  pdfSourceName = file.name;
  pdfDrafts = [];
  $('pdfText').value = '';
  $('pdfParseStatus').textContent = '';
  $('pdfBtn').disabled = true;
  showStatus('正在本机读取 PDF 文字，请稍候…');
  try {
    const text = await extractPdfText(file);
    $('pdfText').value = text;
    openPdfDialog();
    $('pdfFileMeta').textContent = '文件：' + file.name + ' · ' + Math.max(1, Math.ceil(file.size / 1024)) + ' KB · 文字已在本机提取';
    if (!text.trim()) {
      $('pdfParseStatus').textContent = '未提取到文字，可能是扫描图片 PDF。';
      showStatus('PDF 已打开，但没有提取到可选中文本。扫描件暂不支持 OCR。', 'error');
    } else {
      runPdfAnalysis();
      showStatus('PDF 文字提取完成，检查预览后再导入。', 'success');
    }
  } catch (error) {
    console.error('Local PDF parsing failed:', error);
    showStatus('PDF 解析失败。请确认文件没有损坏，或另存为可选中文本的 PDF 后重试。', 'error');
  } finally {
    $('pdfBtn').disabled = false;
  }
}

function runPdfAnalysis() {
  pdfDrafts = parseResumeText($('pdfText').value);
  $('pdfParseStatus').textContent = '识别到 ' + pdfDrafts.length + ' 项候选内容；导入前可以逐项修改。';
  renderPdfDrafts();
}

async function confirmPdfImport() {
  const chosen = pdfDrafts.filter((draft) => draft.checked && draft.title.trim() && draft.content.trim());
  if (!chosen.length) {
    showStatus('请至少勾选一项有效内容。', 'error');
    return;
  }
  const stamp = Date.now();
  const newItems = chosen.map((draft, index) => {
    const isBasic = draft.group === 'basic';
    const fields = isBasic ? { '字段': draft.title.trim(), '值': draft.content.trim() } : {};
    const content = draft.content.trim();
    return {
      id: 'pdf-' + stamp + '-' + index,
      title: draft.title.trim(),
      subtitle: '来自 PDF：' + pdfSourceName,
      group: draft.group,
      short: content.length > 300 ? content.slice(0, 297) + '…' : content,
      long: content,
      fields,
      favorite: false
    };
  });
  items = newItems.concat(items);
  selectedMap.clear();
  await saveState();
  $('pdfDialog').close();
  activeGroup = 'all';
  $('searchInput').value = '';
  renderAll();
  showStatus('已导入 ' + newItems.length + ' 项 PDF 内容。原有资料没有被覆盖。', 'success');
}

function setupEvents() {
  $('searchInput').addEventListener('input', renderAll);
  $('clearSearchBtn').addEventListener('click', () => { $('searchInput').value = ''; renderAll(); $('searchInput').focus(); });
  $('groupFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    activeGroup = button.getAttribute('data-filter');
    renderAll();
  });
  $('cardsContainer').addEventListener('change', (event) => {
    const input = event.target.closest('input[data-select-key]');
    if (input) updateSelection(input);
  });
  $('cardsContainer').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) {
      const quickCard = event.target.closest('.quick-card');
      if (quickCard && !event.target.closest('label, input, button')) {
        await copyField(quickCard.getAttribute('data-item-id'), quickCard.getAttribute('data-field-index'));
      }
      return;
    }
    const action = button.getAttribute('data-action');
    const itemId = button.getAttribute('data-item-id');
    if (action === 'copy-field') await copyField(itemId, button.getAttribute('data-field-index'));
    else if (action === 'copy-summary') await copySummary(itemId);
    else if (action === 'edit') openEditor(getItem(itemId));
    else if (action === 'favorite') await toggleFavorite(itemId);
    else if (action === 'fill-record') await fillRecord(itemId);
    else if (action === 'fill-field') await fillField(itemId, button.getAttribute('data-field-index'));
  });
  $('copySelectedBtn').addEventListener('click', copySelected);
  $('selectVisibleBtn').addEventListener('click', selectVisible);
  $('clearSelectionBtn').addEventListener('click', () => {
    selectedMap.clear();
    renderAll();
    showStatus('已清空批量选择。');
  });
  document.querySelectorAll('.mode-button').forEach((button) => {
    button.addEventListener('click', () => {
      const nextMode = button.getAttribute('data-mode');
      if (!nextMode || nextMode === viewMode) return;
      viewMode = nextMode;
      selectedMap.clear();
      renderAll();
      showStatus('经历复制版本已切换为' + (viewMode === 'long' ? '详细版' : '精简版') + '。');
    });
  });
  $('addBtn').addEventListener('click', () => openEditor(null));
  $('exportBtn').addEventListener('click', exportBackup);
  $('importFile').addEventListener('change', handleImportFile);
  $('pdfBtn').addEventListener('click', () => $('pdfFile').click());
  $('pdfFile').addEventListener('change', handlePdfFile);
  $('editForm').addEventListener('submit', saveEditor);
  $('closeEditBtn').addEventListener('click', () => $('editDialog').close());
  $('cancelEditBtn').addEventListener('click', () => $('editDialog').close());
  $('closeImportBtn').addEventListener('click', closeImportDialog);
  $('cancelImportBtn').addEventListener('click', closeImportDialog);
  $('confirmImportBtn').addEventListener('click', confirmImport);
  $('closePdfBtn').addEventListener('click', () => $('pdfDialog').close());
  $('cancelPdfBtn').addEventListener('click', () => $('pdfDialog').close());
  $('analyzePdfBtn').addEventListener('click', runPdfAnalysis);
  $('confirmPdfBtn').addEventListener('click', confirmPdfImport);
  $('pdfDrafts').addEventListener('input', (event) => {
    const el = event.target.closest('[data-pdf-field]');
    if (!el) return;
    const index = Number(el.getAttribute('data-index'));
    const field = el.getAttribute('data-pdf-field');
    if (!pdfDrafts[index]) return;
    pdfDrafts[index][field] = field === 'checked' ? el.checked : el.value;
    if (field !== 'checked') return;
    $('confirmPdfBtn').disabled = !pdfDrafts.some((draft) => draft.checked);
  });
  $('pdfDrafts').addEventListener('change', (event) => {
    const el = event.target.closest('[data-pdf-field]');
    if (!el) return;
    const index = Number(el.getAttribute('data-index'));
    const field = el.getAttribute('data-pdf-field');
    if (!pdfDrafts[index]) return;
    pdfDrafts[index][field] = field === 'checked' ? el.checked : el.value;
    $('confirmPdfBtn').disabled = !pdfDrafts.some((draft) => draft.checked);
  });
}

async function initialize() {
  setupEvents();
  try {
    const stored = await chrome.storage.local.get([KEY_ITEMS, KEY_LAST_USED]);
    items = Array.isArray(stored[KEY_ITEMS]) ? stored[KEY_ITEMS] : [];
    lastUsed = stored[KEY_LAST_USED] && typeof stored[KEY_LAST_USED] === 'object' ? stored[KEY_LAST_USED] : {};
    renderAll();
    if (items.length) showStatus('已接回本机旧资料，共 ' + items.length + ' 条。可以直接点字段复制。', 'success');
    else showStatus('暂未读取到旧资料。可导入此前导出的 JSON 备份。', 'error');
  } catch (error) {
    console.error('Unable to load local resume data:', error);
    showStatus('读取本地资料失败。请检查扩展是否有存储权限。', 'error');
  }
}

document.addEventListener('DOMContentLoaded', initialize);