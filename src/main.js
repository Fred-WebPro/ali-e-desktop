// Ali-E CRM для Windows — оболочка вокруг развёрнутого веб-приложения.
//
// Почему так, а не сборка веба внутрь: интернет у пользователей есть всегда
// (это решение владельца), а значит каждый деплой app.aliecrm.com попадает в
// десктоп сам, без выпуска новой версии установщика. Данные живые — приложение
// работает с той же Supabase, включая realtime-подписки.
const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_URL = process.env.ALIE_URL || 'https://app.aliecrm.com';

// Куда разрешено ходить внутри окна. Всё остальное (документация, соцсети,
// платёжные виджеты) открывается в системном браузере: так пользователь видит
// адресную строку и замок — это безопаснее, чем чужая страница без опознавания.
const INTERNAL_HOSTS = ['app.aliecrm.com', 'aliecrm.com', 'www.aliecrm.com'];

// Вход через Google НАМЕРЕННО не открывается внутри окна: Google распознаёт
// Electron как встроенный браузер и переводит авторизацию на урезанный сценарий
// (GeneralOAuthLite), который упирается в «этот браузер небезопасен». Правильный
// путь для настольных программ — системный браузер плюс возврат по собственной
// ссылке ali-e:// (см. PROTOCOL ниже). Так делают все взрослые приложения.
const PROTOCOL = 'ali-e';

function isInternal(host) {
  return INTERNAL_HOSTS.includes(host)
    || host.endsWith('.supabase.co');   // сам GoTrue: обмен токенами внутри окна
}

// ── возврат из браузера после входа ─────────────────────────────────────────
// Windows отдаёт ссылку аргументом командной строки. Токены приходят во
// фрагменте (#access_token=...), потому что проект настроен на implicit-поток.
function extractDeepLink(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith(PROTOCOL + '://')) || null;
}

function deliverDeepLink(url) {
  if (!url || !win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Ждём готовности страницы: ссылка может прийти раньше, чем окно догрузилось.
  const send = () => win.webContents.send('alie:auth-callback', url);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

// User-Agent намеренно НЕ содержит AliEApp / AliE-Native: эти маркеры включают
// в вебе «нативный режим» и прячут баннер открытой беты (см. utils/native.js).
// Прятать от клиентов, что продукт в бете, мы не будем.
const UA_SUFFIX = 'AliEDesktop/' + app.getVersion();

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
let win = null;
let tray = null;

// ── размеры и положение окна между запусками ────────────────────────────────
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch { /* первый запуск или файл повреждён — берём умолчания */ }
  return { width: 1440, height: 900 };
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* не критично */ }
}

function ua() {
  return app.userAgentFallback + ' ' + UA_SUFFIX;
}

// ── экран ошибки: без него при потере сети остаётся белое полотно ───────────
function showOffline(reason) {
  if (!win || win.isDestroyed()) return;
  const html = fs.readFileSync(path.join(__dirname, 'offline.html'), 'utf8')
    .replace('{{REASON}}', String(reason || '').replace(/[<>&]/g, ''));
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1013',   // тёмный фон до первой отрисовки — без белой вспышки
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.loadURL(APP_URL, { userAgent: ua() });

  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    // -3 = ERR_ABORTED, приходит при обычных переходах внутри SPA
    if (isMainFrame && code !== -3) showOffline(desc || ('код ' + code));
  });

  // Внешние ссылки — в системный браузер, а не в новое окно приложения.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (!isInternal(new URL(url).hostname)) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    } catch {
      return { action: 'deny' };   // кривой url — просто не открываем
    }
    return { action: 'allow' };
  });

  // Уводить окно на чужой домен тоже не даём.
  //
  // ВАЖНО про will-redirect: одного will-navigate мало. Переход на свой же
  // supabase.co разрешён, а дальше сервер перенаправляет на accounts.google.com
  // уже сам — это НЕ новая навигация, will-navigate второй раз не срабатывает,
  // и чужая страница спокойно открывалась внутри окна. Проверяем оба события.
  const guard = (e, url) => {
    try {
      const h = new URL(url).hostname;
      if (!isInternal(h) && !url.startsWith('data:')) {
        e.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      e.preventDefault();
    }
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);

  ['resize', 'move'].forEach((ev) => win.on(ev, saveState));
  win.on('close', saveState);
  win.on('closed', () => { win = null; });
}

// ── меню приложения ─────────────────────────────────────────────────────────
function buildMenu() {
  const go = (p) => () => win && win.loadURL(APP_URL + p, { userAgent: ua() });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Файл',
      submenu: [
        { label: 'Обновить', accelerator: 'F5', click: () => win && win.reload() },
        { label: 'На главную', accelerator: 'Alt+Home', click: go('/') },
        { type: 'separator' },
        { label: 'Выход', role: 'quit' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', role: 'undo' },
        { label: 'Повторить', role: 'redo' },
        { type: 'separator' },
        { label: 'Вырезать', role: 'cut' },
        { label: 'Копировать', role: 'copy' },
        { label: 'Вставить', role: 'paste' },
        { label: 'Выделить всё', role: 'selectAll' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Крупнее', role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        { label: 'Мельче', role: 'zoomOut' },
        { label: 'Обычный размер', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Во весь экран', role: 'togglefullscreen' },
        { label: 'Инструменты разработчика', role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'Поддержка в Telegram', click: () => shell.openExternal('https://t.me/aliecrm') },
        { label: 'Сайт', click: () => shell.openExternal('https://aliecrm.com') },
        { type: 'separator' },
        {
          label: 'О программе',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'О программе',
            message: 'Ali-E CRM',
            detail: 'Версия ' + app.getVersion()
              + '\nElectron ' + process.versions.electron
              + '\n\nПриложение работает с ' + APP_URL,
            buttons: ['Закрыть'],
          }),
        },
      ],
    },
  ]));
}

// ── иконка в трее: окно закрыли, а приложение осталось под рукой ────────────
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.ico'));
  if (img.isEmpty()) return;   // без картинки трей создавать нечем
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Ali-E CRM');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Открыть Ali-E CRM',
      click: () => { if (win) { win.show(); win.focus(); } else createWindow(); },
    },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]));
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

// Второй запуск не плодит окна, а поднимает уже открытое.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Браузер после входа зовёт ali-e://... — Windows передаёт ссылку сюда,
    // потому что приложение уже запущено (сработал single-instance lock).
    const link = extractDeepLink(argv);
    if (link) { deliverDeepLink(link); return; }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // macOS отдаёт ссылку отдельным событием, а не аргументом.
  app.on('open-url', (e, url) => { e.preventDefault(); deliverDeepLink(url); });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.aliecrm.desktop');   // уведомления идут от имени приложения

    // Регистрируем ali-e:// за приложением. В режиме разработки Windows должна
    // знать, что запускать: сам electron.exe с путём к проекту.
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    // Страница просит открыть вход в системном браузере. Пускаем только адреса
    // авторизации своего проекта — иначе это дыра: любая страница смогла бы
    // открыть у пользователя что угодно.
    ipcMain.handle('alie:open-auth', (_e, url) => {
      try {
        const u = new URL(String(url));
        const ok = u.protocol === 'https:'
          && (u.hostname.endsWith('.supabase.co') || u.hostname === 'accounts.google.com');
        if (!ok) return false;
        shell.openExternal(u.toString());
        return true;
      } catch { return false; }
    });

    // Electron по умолчанию отклоняет запросы к камере, микрофону и экрану —
    // без этого обработчика видеозвонки и голосовой ввод в AI-чате не работают.
    // Разрешаем только своим доменам, чужим страницам доступа не даём.
    const ALLOWED_PERMS = new Set([
      'media', 'audioCapture', 'videoCapture', 'display-capture',
      'notifications', 'clipboard-sanitized-write', 'fullscreen',
    ]);
    const fromOurSite = (url) => {
      try { return isInternal(new URL(url).hostname); } catch { return false; }
    };
    session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
      done(ALLOWED_PERMS.has(permission) && fromOurSite(wc.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
      return ALLOWED_PERMS.has(permission) && fromOurSite(origin);
    });
    createWindow();
    buildMenu();
    createTray();

    // Автообновление работает только у собранного приложения и при наличии
    // опубликованного релиза. В режиме разработки молча пропускаем.
    if (app.isPackaged) {
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = true;
        autoUpdater.on('update-downloaded', async () => {
          const { response } = await dialog.showMessageBox(win, {
            type: 'info',
            title: 'Обновление готово',
            message: 'Загружена новая версия Ali-E CRM.',
            detail: 'Установить сейчас? Приложение перезапустится.',
            buttons: ['Установить', 'Позже'],
            defaultId: 0,
          });
          if (response === 0) autoUpdater.quitAndInstall();
        });
        autoUpdater.checkForUpdates().catch(() => {});
      } catch { /* обновления не настроены — не мешаем работе */ }
    }

    // Ссылка могла прийти уже первым запуском (приложение было закрыто).
    const first = extractDeepLink(process.argv);
    if (first) deliverDeepLink(first);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
