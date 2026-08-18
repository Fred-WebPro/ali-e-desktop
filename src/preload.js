// Мост между окном и приложением. Держим его узким: открываем наружу только то,
// без чего вход не работает.
const { contextBridge, ipcRenderer } = require('electron');

// Слушаем ВСЕГДА, с самого создания окна, и придерживаем последнюю ссылку.
// Иначе возникает гонка: браузер возвращает пользователя быстрее, чем страница
// успевает подписаться, и вход молча теряется — человек видит форму входа,
// хотя в браузере всё прошло успешно.
let pending = null;
let listener = null;

ipcRenderer.on('alie:auth-callback', (_e, url) => {
  const value = String(url || '');
  if (listener) listener(value);
  else pending = value;
});

contextBridge.exposeInMainWorld('aliEDesktop', {
  isDesktop: true,
  platform: process.platform,

  // Открыть страницу входа в СИСТЕМНОМ браузере. Внутри окна Google не пускает:
  // он распознаёт Electron как встроенный браузер и режет авторизацию.
  // Главный процесс проверяет адрес, произвольные ссылки так не откроешь.
  openAuth: (url) => ipcRenderer.invoke('alie:open-auth', url),

  // Подписка на возврат из браузера. Если ссылка уже пришла — отдаём сразу.
  onAuthCallback: (cb) => {
    if (typeof cb !== 'function') return () => {};
    listener = cb;
    if (pending) {
      const v = pending;
      pending = null;
      queueMicrotask(() => cb(v));
    }
    return () => { listener = null; };
  },
});
