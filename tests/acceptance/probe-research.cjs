'use strict';
// 科研文献：真实查询公开元数据和下载公开 PDF；主服务故障用注入模拟，回退到真实 Crossref 时必须明确标注来源。
const path = require('node:path');
const { createResearchBroker } = require('../../isolation/research');
const { fetchPublic, checkedUrl } = require('../../isolation/public-network');
const { begin, finish } = require('./common.cjs');
const run = begin('research'), { result, root } = run;
const text = value => (value.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
(async () => {
  try {
    const config = path.join(root, 'mcp-servers.json');
    // 外部文献服务偶尔限流（HTTP 429，2026-11-23 两次遇到）：隔 90 秒再试，最多三次。别的错误照旧立即失败
    let real;
    for (let attempt = 1; ; attempt++) {
      try { real = await createResearchBroker(config).callTool('lookup_reference', { ident: '10.1038/nmeth.4509' }); break; }
      catch (error) { if (attempt >= 3 || !/HTTP 429/.test(String(error.message))) throw error; result.retriedAfter429 = attempt; await new Promise(resolve => setTimeout(resolve, 90000)); }
    }
    const found = JSON.parse(text(real));
    result.lookup = { found: found.found, doi: found.doi };
    result.checks.lookup = found.found === true && String(found.doi).toLowerCase() === '10.1038/nmeth.4509';
    const broken = createResearchBroker(config, { transport: async () => ({ status: 429, headers: {}, body: '' }) });
    const fallback = JSON.parse(text(await broken.callTool('search_works', { query: 'single molecule localization microscopy', limit: 3 })));
    result.fallback = { source: fallback.source, count: fallback.results?.length, notice: fallback.notice };
    result.checks.fallbackLabelled = fallback.source === 'Crossref' && fallback.results?.length > 0 && !!fallback.primaryError;
    const pdf = await fetchPublic('https://arxiv.org/pdf/1706.03762', { maxBytes: 20 * 1024 * 1024 });
    result.download = { status: pdf.status, bytes: pdf.bytes?.length };
    result.checks.download = pdf.status === 200 && pdf.bytes?.subarray(0, 5).toString() === '%PDF-';
    let refused = false;
    try { checkedUrl('http://127.0.0.1/secret'); await fetchPublic('http://127.0.0.1/secret', { maxBytes: 1024 }); } catch { refused = true; }
    result.checks.privateAddressRefused = refused;
  } catch (error) { await finish(run, error); return; }
  await finish(run);
})();
