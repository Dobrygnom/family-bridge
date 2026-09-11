import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateControl } from "../src/ui/UpdateControl.js";
import type { AppState } from "../src/global.js";

const render=(update:AppState['update'])=>renderToStaticMarkup(createElement(UpdateControl,{update,version:'1.2.12',language:'ru',onCheck:async()=>{},onInstall:async()=>{}}));
test('sidebar update is always visible and highlights a ready update with install action',()=>{
  const compact=(update:AppState['update'])=>renderToStaticMarkup(createElement(UpdateControl,{compact:true,update,version:'1.2.25',language:'ru',onCheck:async()=>{},onInstall:async()=>{}}));
  assert.match(compact({available:false,downloading:false}), /Обновить приложение/);
  const ready=compact({available:true,downloading:false,ready:true,version:'1.2.26'});
  assert.match(ready,/update-available/); assert.match(ready,/Обновить сейчас/); assert.doesNotMatch(ready,/disabled/);
  const downloading=compact({available:true,downloading:true,version:'1.2.26',progress:52});
  assert.match(downloading,/52%/); assert.match(downloading,/disabled/); assert.doesNotMatch(downloading,/Готова версия/);
});
test('live update events retain installation and waiting fields in the app',()=>{
  const source=readFileSync(new URL('../src/ui/App.tsx',import.meta.url),'utf8');
  const handler=source.slice(source.indexOf('if (event.type === "update")'),source.indexOf('return () => {',source.indexOf('if (event.type === "update")')));
  for(const field of ['installRequested','installing','waitingFor']) assert.match(handler,new RegExp(`${field}:.*\\.${field}`));
});
test('a downloaded update always exposes an enabled install-now button, including after failure',()=>{
  for(const extra of [{},{error:'Installation failed'},{installRequested:true,waitingFor:'background' as const}]) {
    const html=render({available:true,downloading:false,ready:true,version:'1.2.13',...extra});
    assert.match(html,/Обновить сейчас/); assert.doesNotMatch(html,/disabled/);
    assert.match(html,/Приложение перезапустится/);
  }
});
test('download, install, and safety-block states are distinct; no unverified latest-version claim',()=>{
  assert.match(render({available:true,downloading:false,ready:true,waitingFor:'dictation'}),/Закончите или отмените запись/);
  assert.match(render({available:true,downloading:false,ready:true,waitingFor:'editing'}),/Сохраните или отмените редактирование/);
  const installing=render({available:true,downloading:false,ready:true,installing:true});
  assert.match(installing,/Устанавливаем обновление/);assert.match(installing,/disabled/);
  const idle=render({available:false,downloading:false});
  assert.match(idle,/Проверить обновления/);assert.doesNotMatch(idle,/последняя версия|Обновить сейчас/);
  assert.match(render({available:true,downloading:true,progress:52}),/52%/);
});
