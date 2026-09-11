// A small, offline renderer regression for the real context-page CSS.
const { app, BrowserWindow, session } = require('electron');
const { readFileSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'fb-layout-')));
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) }));
  const css = readFileSync(process.argv[2] || path.join(__dirname, '../src/ui/styles.css'), 'utf8').replace(/@import[^;]+;/g, '');
  const rows = Array.from({ length: 20 }, (_, i) => `<div class="topic-row"><div class="topic-row-main"><label class="topic-approval"><input type="checkbox"><span class="topic-approval-copy"><strong>Предложение ${i + 1}</strong><small>Контекст нового разговора</small></span></label><span class="topic-about">О собеседнике</span><button>×</button><button>⌄</button></div></div>`).join('');
  const html = `<style>${css}</style><div class="shell"><aside class="sidebar">Family Bridge</aside><main class="context-main"><header><h1>Исходный чат и темы</h1></header><div class="grid single-screen"><section class="panel context-panel"><h3>Контекст агента</h3></section><section class="panel analysis-panel"><div class="panel-title"><h3>Подготовлено из базового чата</h3></div><p class="analysis-status">Подготовка завершена</p><details class="people-block"><summary>Люди в контексте · 26</summary></details><div class="topic-registry"><p class="registry-hint">Здесь только ещё не начатые темы.</p><div class="person-tabs"><button>Собеседник</button></div><div class="registry-heading"><h4>Разговоры с собеседником</h4></div><div class="registry-toolbar">Выбрано 0</div><div class="topic-rows">${rows}</div></div></section></div></main></div>`;
  const window = new BrowserWindow({ show: false, width: 1166, height: 773, useContentSize: true, webPreferences: { offscreen: true } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  try {
    for (const [width, height] of [[1166, 773], [1280, 720], [1920, 1080]]) {
      window.setContentSize(width, height);
      const result = await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
        const main=document.querySelector('main'), list=document.querySelector('.topic-rows');
        main.scrollTop=0; main.scrollTop=200;
        resolve({height:list.getBoundingClientRect().height, rowHeight:list.firstElementChild.getBoundingClientRect().height, scrollTop:main.scrollTop, overflow:main.scrollWidth-main.clientWidth});
      }))`);
      assert.ok(result.height >= 1200, `Topic list collapsed at ${width}x${height}: ${result.height}px`);
      assert.ok(result.rowHeight >= 68, 'Topic rows are unreadable');
      assert.ok(result.scrollTop > 0, 'Context page cannot scroll');
      assert.ok(result.overflow <= 1, 'Horizontal page overflow');
      console.log(JSON.stringify({ viewport: `${width}x${height}`, ...result }));
    }
  } finally { window.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
