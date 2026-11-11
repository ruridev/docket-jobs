// Sign-in page. The same file in docket, docket-gits and docket-jobs: keep them identical.
// What differs per app is on <html>: data-theme-key, data-lang-key (the app's own localStorage
// keys), data-header (the app's anti-CSRF request header) and data-reset (the reset command).
(function () {
  var root = document.documentElement;
  var cfg = root.dataset;
  var THEMES = ['light', 'dark', 'green', 'g6'];

  function stored(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  // Apply the app's saved theme before the first paint (this script is in <head>).
  var theme = stored(cfg.themeKey);
  if (THEMES.indexOf(theme) >= 0) root.dataset.theme = theme;

  var TEXT = {
    ko: {
      setupTitle: '계정 만들기', setupHelp: '이 앱에 로그인할 이름과 비밀번호를 정하세요. 이 PC에만 저장됩니다.',
      loginTitle: '로그인', name: '이름', password: '비밀번호 (8자 이상)', confirm: '비밀번호 확인',
      create: '만들기', signIn: '로그인',
      errName: '이름을 입력해 주세요 (64자 이내).', errPassword: '비밀번호는 8자 이상이어야 합니다.', errConfirm: '비밀번호가 서로 다릅니다.',
      errWrong: '이름 또는 비밀번호가 맞지 않습니다.', errWait: '너무 많이 틀렸습니다. {n}초 뒤에 다시 시도해 주세요.',
      errExists: '이미 계정이 있습니다. 로그인해 주세요.', errNetwork: '서버에 연결할 수 없습니다.',
      forgot: '비밀번호를 잊었다면 이 PC에서 아래 명령을 실행하세요. 계정만 지워지고 데이터는 그대로이며, 다시 열면 계정을 새로 만들 수 있습니다.',
    },
    ja: {
      setupTitle: 'アカウントの作成', setupHelp: 'このアプリにサインインする名前とパスワードを決めてください。この PC にだけ保存されます。',
      loginTitle: 'サインイン', name: '名前', password: 'パスワード (8 文字以上)', confirm: 'パスワードの確認',
      create: '作成', signIn: 'サインイン',
      errName: '名前を入力してください (64 文字以内)。', errPassword: 'パスワードは 8 文字以上にしてください。', errConfirm: 'パスワードが一致しません。',
      errWrong: '名前またはパスワードが違います。', errWait: '失敗が続きました。{n} 秒後にもう一度お試しください。',
      errExists: 'アカウントはすでにあります。サインインしてください。', errNetwork: 'サーバーに接続できません。',
      forgot: 'パスワードを忘れたときは、この PC で次のコマンドを実行してください。アカウントだけが消え、データはそのままです。開き直すとアカウントを作り直せます。',
    },
    en: {
      setupTitle: 'Create your account', setupHelp: 'Choose the name and password to sign in to this app. They are kept on this PC only.',
      loginTitle: 'Sign in', name: 'Name', password: 'Password (8 characters or more)', confirm: 'Confirm password',
      create: 'Create', signIn: 'Sign in',
      errName: 'Enter a name (up to 64 characters).', errPassword: 'The password needs 8 characters or more.', errConfirm: "The passwords don't match.",
      errWrong: 'The name or password is wrong.', errWait: 'Too many tries. Try again in {n} seconds.',
      errExists: 'An account already exists. Please sign in.', errNetwork: "Can't reach the server.",
      forgot: 'Forgot the password? Run this command on this PC. Only the account is removed, your data stays, and you can create the account again.',
    },
  };
  var lang = stored(cfg.langKey);
  if (!TEXT[lang]) lang = (navigator.language || 'en').slice(0, 2);
  if (!TEXT[lang]) lang = 'en';
  root.lang = lang;
  var t = TEXT[lang];

  function call(path, body) {
    var headers = {};
    headers[cfg.header] = '1';
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: body ? 'POST' : 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; }); });
  }

  function start() {
    var $ = function (id) { return document.getElementById(id); };
    var form = $('authForm');
    var err = $('authErr');
    var setup = false;

    $('authNameLabel').textContent = t.name;
    $('authPassLabel').textContent = t.password;
    $('authConfirmLabel').textContent = t.confirm;
    $('authForgot').textContent = t.forgot;
    $('authCmd').textContent = cfg.reset;

    function mode(isSetup) {
      setup = isSetup;
      $('authTitle').textContent = isSetup ? t.setupTitle : t.loginTitle;
      $('authHelp').textContent = isSetup ? t.setupHelp : '';
      $('authHelp').hidden = !isSetup;
      $('authConfirmRow').hidden = !isSetup;
      $('authNote').hidden = isSetup;
      $('authSubmit').textContent = isSetup ? t.create : t.signIn;
      $('authPass').autocomplete = isSetup ? 'new-password' : 'current-password';
      form.hidden = false;
      $('authName').focus();
    }

    call('api/auth').then(function (r) {
      if (r.data.user) return location.replace('./');
      mode(!r.data.account);
    }, function () { mode(false); err.textContent = t.errNetwork; });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = '';
      var name = $('authName').value.trim();
      var password = $('authPass').value;
      if (!name || name.length > 64) { err.textContent = t.errName; return; }
      if (password.length < 8) { err.textContent = t.errPassword; return; }
      if (setup && password !== $('authConfirm').value) { err.textContent = t.errConfirm; return; }
      $('authSubmit').disabled = true;
      call(setup ? 'api/auth/setup' : 'api/auth/login', { name: name, password: password }).then(function (r) {
        $('authSubmit').disabled = false;
        if (r.status === 200) return location.replace('./');
        var code = r.data.error;
        if (code === 'exists') { mode(false); err.textContent = t.errExists; return; }
        if (code === 'no_account') { mode(true); return; }
        err.textContent = code === 'wait' ? t.errWait.replace('{n}', r.data.seconds)
          : code === 'name' ? t.errName : code === 'password' ? t.errPassword : t.errWrong;
      }, function () { $('authSubmit').disabled = false; err.textContent = t.errNetwork; });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
