const PDF_HEADINGS = [
  { regex: /^(个人信息|基本信息|个人资料|联系方式)\s*[:：]?$/i, group: 'basic', title: '基本信息' },
  { regex: /^(工作经历|工作经验|职业经历|任职经历|工作履历)\s*[:：]?$/i, group: 'work', title: '工作经历' },
  { regex: /^(项目经历|项目经验|项目实践|项目履历)\s*[:：]?$/i, group: 'project', title: '项目经历' },
  { regex: /^(AI项目|AI应用|人工智能项目|智能体项目|Agent项目)\s*[:：]?$/i, group: 'ai', title: 'AI 项目经历' },
  { regex: /^(教育经历|教育背景|学历)\s*[:：]?$/i, group: 'custom', title: '教育经历' },
  { regex: /^(专业技能|技能清单|技术栈|核心技能)\s*[:：]?$/i, group: 'custom', title: '专业技能' },
  { regex: /^(自我评价|个人优势|个人简介|职业目标)\s*[:：]?$/i, group: 'custom', title: '个人简介' }
];

export function parseResumeText(text) {
  const clean = String(text ?? '').replace(/\r/g, '\n').replace(/\u0000/g, '');
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  const drafts = [];
  const addDraft = (title, group, content) => {
    const value = String(content ?? '').trim();
    if (!value) return;
    const key = normalize(title) + ':' + normalize(value.slice(0, 80));
    if (drafts.some((draft) => draft._dedupe === key)) return;
    drafts.push({ id: 'draft-' + drafts.length, title, group, content: value, checked: true, _dedupe: key });
  };
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

  const phone = clean.match(/(?:\+?86[-\s]?)?1[3-9]\d{9}/);
  const email = clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const nameCandidate = lines.slice(0, 12).find((line) =>
    /^[\u4e00-\u9fa5·]{2,5}$/.test(line) && !/(简历|个人|求职|工作|项目|经历|资料|信息)/.test(line)
  );
  if (nameCandidate) addDraft('姓名', 'basic', nameCandidate);
  if (phone) addDraft('手机号', 'basic', phone[0].replace(/[\s-]/g, ''));
  if (email) addDraft('邮箱', 'basic', email[0]);

  const headingPositions = [];
  lines.forEach((line, index) => {
    const match = PDF_HEADINGS.find((heading) => heading.regex.test(line));
    if (match) headingPositions.push({ index, heading: match });
  });
  if (headingPositions.length) {
    headingPositions.forEach((position, index) => {
      const start = position.index + 1;
      const end = index + 1 < headingPositions.length ? headingPositions[index + 1].index : lines.length;
      const content = lines.slice(start, end).join('\n').trim();
      if (!content) return;
      if (position.heading.group === 'basic') addDraft('其他基础信息', 'basic', content);
      else addDraft(position.heading.title, position.heading.group, content);
    });
  } else if (clean.trim()) {
    addDraft('简历全文（请检查分类）', 'custom', clean.trim());
  }
  if (!drafts.length && clean.trim()) addDraft('简历全文（请检查分类）', 'custom', clean.trim());
  return drafts.map(({ _dedupe, ...draft }) => draft);
}
