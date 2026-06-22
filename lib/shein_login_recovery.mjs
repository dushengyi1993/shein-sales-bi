function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function readSheinLoginState(evaluate) {
  return await evaluate(`
    const text = document.body?.innerText || '';
    const passwordInputs = [...document.querySelectorAll('input[type="password"]')].map(el => ({
      valueLength: String(el.value || '').length,
      placeholder: String(el.getAttribute('placeholder') || ''),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }));
    const textInputs = [...document.querySelectorAll('input:not([type]),input[type="text"],input[type="tel"],input[type="email"]')].map(el => ({
      valueLength: String(el.value || '').length,
      placeholder: String(el.getAttribute('placeholder') || ''),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }));
    const iframeSrcs = [...document.querySelectorAll('iframe')].map(el => String(el.src || '')).slice(0, 10);
    const isLogin = location.href.includes('/login/')
      || text.includes('请输入账号')
      || text.includes('请输入密码')
      || (text.includes('账号登录') && text.includes('密码') && text.includes('登录'));
    const hardBlockReason = (() => {
      if (/验证码|短信验证|手机验证|安全验证|滑块|拖动滑块|人机验证|captcha|verify/i.test(text)) return 'verification_challenge';
      if (iframeSrcs.some(src => /captcha|verify|geetest|slider/i.test(src))) return 'verification_iframe';
      const visiblePassword = passwordInputs.find(x => x.visible);
      const visibleAccount = textInputs.find(x => x.visible && /账号|手机号|邮箱|用户名|Account|Phone|Email/i.test(x.placeholder));
      if (isLogin && visiblePassword && visiblePassword.valueLength === 0) return 'password_required';
      if (isLogin && visibleAccount && visibleAccount.valueLength === 0) return 'account_required';
      return '';
    })();
    return {
      href: location.href,
      title: document.title || '',
      isLogin,
      hardBlockReason,
      passwordInputs,
      textInputs,
      iframeSrcs,
      tail: text.slice(-1000),
    };
  `).catch(err => ({
    href: '',
    title: '',
    isLogin: false,
    hardBlockReason: '',
    error: err.message,
    tail: '',
  }));
}

export async function clickSheinLoginOnce({evaluate, dispatchMouseEvent}) {
  const target = await evaluate(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const text = document.body?.innerText || '';
    const visiblePassword = [...document.querySelectorAll('input[type="password"]')]
      .find(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const visibleAccount = [...document.querySelectorAll('input:not([type]),input[type="text"],input[type="tel"],input[type="email"]')]
      .find(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
        && /账号|手机号|邮箱|用户名|Account|Phone|Email/i.test(String(el.getAttribute('placeholder') || '')));
    const credentialMissing = Boolean(
      (/验证码|短信验证|手机验证|安全验证|滑块|拖动滑块|人机验证|captcha|verify/i.test(text))
      || (visiblePassword && !String(visiblePassword.value || '').length)
      || (visibleAccount && !String(visibleAccount.value || '').length)
    );
    const buttons = [...document.querySelectorAll('button,[role=button],a')]
      .filter(visible)
      .map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
    const btn = buttons.find(x => !x.disabled && x.text === '我已知晓，继续登录')
      || buttons.find(x => !x.disabled && x.text.includes('继续登录') && x.text.length <= 20)
      || (!credentialMissing && buttons.find(x => !x.disabled && x.text === '登录'))
      || (!credentialMissing && buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12))
      || buttons.find(x => !x.disabled && /sign\\s*in/i.test(x.text) && x.text.length <= 24);
    if (!btn) {
      return {
        found: false,
        href: location.href,
        buttons: buttons.map(x => x.text).filter(Boolean).slice(0, 20),
        tail: (document.body?.innerText || '').slice(-800),
      };
    }
    btn.el.scrollIntoView({block: 'center', inline: 'center'});
    const rect = btn.el.getBoundingClientRect();
    return {found: true, href: location.href, text: btn.text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  `);
  if (!target?.found) return {clicked: false, ...target};
  if (dispatchMouseEvent) {
    await dispatchMouseEvent({type: 'mouseMoved', x: target.x, y: target.y, button: 'none'});
    await dispatchMouseEvent({type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
    await dispatchMouseEvent({type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
  } else {
    await evaluate(`
      const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const btn = [...document.querySelectorAll('button,[role=button],a')]
        .filter(visible)
        .find(el => {
          const text = textOf(el);
          return text === '我已知晓，继续登录'
            || (text.includes('继续登录') && text.length <= 20)
            || text === '登录'
            || (text.includes('登录') && text.length <= 12)
            || (/sign\\s*in/i.test(text) && text.length <= 24);
        });
      if (btn) btn.click();
      return Boolean(btn);
    `).catch(() => null);
  }
  return {clicked: true, ...target};
}

export async function recoverSheinLoginIfNeeded({
  evaluate,
  dispatchMouseEvent,
  reload,
  sleep = defaultSleep,
  maxAttempts = 3,
  initialEmptyBodyWaits = 10,
  afterClickTimeoutMs = 7000,
} = {}) {
  if (typeof evaluate !== 'function') throw new Error('recoverSheinLoginIfNeeded requires evaluate(body, arg?)');
  const attempts = [];
  let before = await readSheinLoginState(evaluate);
  for (let wait = 0; wait < initialEmptyBodyWaits && !before.isLogin && !(before.tail || '').trim(); wait += 1) {
    await sleep(500);
    before = await readSheinLoginState(evaluate);
  }
  let state = before;
  if (!state.isLogin) return {needed: false, ok: true, before, attempts, after: state};

  for (let attempt = 1; attempt <= maxAttempts && state.isLogin; attempt += 1) {
    if (state.hardBlockReason && attempt > 1) break;
    if (attempt > 1 && reload) {
      await reload().catch(() => null);
      await sleep(2500);
      state = await readSheinLoginState(evaluate);
      if (!state.isLogin) break;
      if (state.hardBlockReason) {
        attempts.push({attempt, skippedClick: true, reason: state.hardBlockReason, after: state});
        break;
      }
    }
    const click = await clickSheinLoginOnce({evaluate, dispatchMouseEvent});
    const clickStart = Date.now();
    do {
      await sleep(String(click?.text || '').includes('继续登录') ? 1000 : 1500);
      state = await readSheinLoginState(evaluate);
      if (!state.isLogin) break;
    } while (Date.now() - clickStart < afterClickTimeoutMs);
    attempts.push({attempt, click, after: state});
    if (!click?.clicked && state.hardBlockReason) break;
  }

  return {
    needed: true,
    ok: !state.isLogin,
    before,
    attempts,
    after: state,
    hardBlockReason: state.isLogin ? state.hardBlockReason || '' : '',
  };
}
