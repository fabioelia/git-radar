// Minimal markdown → HTML for LLM-generated reports. Input is escaped first,
// so only the tags we emit here can ever reach the DOM.

import { escapeHtml } from '../util.js';

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(md) {
  const lines = escapeHtml(md ?? '').split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let inCode = false;
  let code = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^```/.test(line.trim())) {
      flushPara(); flushList();
      if (inCode) {
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { code.push(line); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      out.push(`<h${level + 1}>${inline(heading[2])}</h${level + 1}>`); // h1→h2: report nests under app chrome
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara(); flushList();
      out.push('<hr/>');
      continue;
    }

    // table block: header row + |---| separator
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushPara(); flushList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      let j = i + 2;
      const body = [];
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        body.push(cells(lines[j]));
        j += 1;
      }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      i = j - 1;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        flushList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }

    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      flushPara(); flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }

  if (inCode) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  flushPara();
  flushList();
  return out.join('\n');
}
