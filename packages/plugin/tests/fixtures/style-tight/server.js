// style-tight 文风插件（服务端钩子，沙箱执行，CJS 风格 exports.hooks）
// 演示：onMessageSend 注入文风指令 / onProsePostProcess 链式改写 / storage 计数 / onSessionStart/End

exports.hooks = {
  onMessageSend: function (payload) {
    var style = ctx.storage.get('style') || '冷冽叙事';
    return {
      promptInject: '（本会话启用【' + style + '】文风插件：正文多用短句、动词驱动，禁用形容词堆砌与 AI 八股腔。）',
    };
  },

  onProsePostProcess: function (payload) {
    var prose = String(payload.prose || '');
    // 剔除出戏符号
    var cleaned = prose
      .replace(/（笑）/g, '')
      .replace(/\(笑\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { prose: cleaned };
  },

  onSessionStart: function (payload) {
    var count = ctx.storage.get('sessionCount') || 0;
    ctx.storage.set('sessionCount', count + 1);
    ctx.log('会话开始 #' + (count + 1) + '，卡片=' + (payload.card || '?'));
  },

  onSessionEnd: function () {
    ctx.log('会话结束');
  },
};
