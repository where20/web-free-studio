// 发码前的当场验证（fresh.html）：Turnstile 过了 → 换 Cookie → 告诉嵌它的网页（同源）可以重发了
(function () {
  var msg = document.getElementById('h3c-msg');
  function say(text, ok) { msg.textContent = text; msg.className = ok ? 'ok' : ''; }
  function tell() { if (window.parent !== window) window.parent.postMessage({ h3c: 'ok' }, location.origin); }

  window.h3cDone = function (token) {
    say('验证通过', true);
    fetch('/__h3c/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok && d.ok) { tell(); return; }
        say(d.error || '验证没通过，请重试');
        if (window.turnstile) window.turnstile.reset();
      });
    }).catch(function () { say('网络出错，请重试'); });
  };

  window.h3cFail = function () { say('验证组件没加载出来，请关掉重试'); };
})();
