'use strict';
// H9：固定复核请求和只影响这一轮的重答。只验证调用契约，不读取文件或启动模型。
const REVIEW_PROMPT = '请独立复核上一条回答和相关文件。先指出错误、遗漏和证据不足之处，再给出结论。先核对现有文件和已经完成的工作；除非用户明确要求修改，否则不要修改任何文件。';
function collaborationRequest(conv, body, { providerOf, model } = {}) {
  const review = body.action === 'review', retry = body.retryWithModel === true;
  const reject = error => ({ error });
  if (body.action !== undefined && !review) return reject('不支持的对话操作');
  if (!review && !retry) return { kind: null, preserveChoice: false };
  if (!conv || !Array.isArray(conv.messages) || !body.model || body.continue || (review && retry)) return reject('请重新打开要操作的回答');
  if (review) {
    const last = conv.messages.at(-1);
    if (!last || last.role !== 'assistant' || last.status === 'running' || body.reviewIndex !== conv.messages.length - 1 ||
        (last.turnId && body.reviewTurnId !== last.turnId) || Number.isInteger(body.fromIndex) || body.tool || (body.attachments?.length > 0)) return reject('这条回答已发生变化，请重新选择复核');
    if (providerOf(last.model) === providerOf(model)) return reject('请选择另一家模型来复核');
    return { kind: 'review', preserveChoice: true, text: REVIEW_PROMPT };
  }
  if (!Number.isInteger(body.fromIndex) || body.fromIndex < 0 || conv.messages[body.fromIndex]?.role !== 'user' || conv.messages[body.fromIndex + 1]?.role !== 'assistant') return reject('找不到要重答的那一轮');
  const target = conv.messages[body.fromIndex + 1];
  if (target.turnId && body.retryTurnId !== target.turnId) return reject('这条回答已发生变化，请重新选择重答');
  return { kind: 'retry', preserveChoice: true };
}
module.exports = { REVIEW_PROMPT, collaborationRequest };
