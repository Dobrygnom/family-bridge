import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AuthStorage } from "../src/core/supabase-transport.js";

// Credentials are recovery-critical, not disposable cache. Never interpret
// an unreadable file as a new installation or truncate it in place.
export function durableAuthStorage(directory: string): AuthStorage {
  const file = path.join(directory, "supabase-auth.json"), recovery = `${file}.recovery`;
  function read(): Record<string,string> {
    let failed = false;
    for (const candidate of [file, recovery]) {
      if (!existsSync(candidate)) continue;
      try {
        const data = JSON.parse(readFileSync(candidate,"utf8"));
        if (!data || Array.isArray(data) || typeof data !== "object" || Object.values(data).some(v=>typeof v!=="string")) throw Error("Invalid auth storage");
        return data;
      } catch { failed = true; }
    }
    if (failed) throw Error("Не удалось прочитать сохранённую авторизацию; данные не сброшены.");
    return {};
  }
  function write(data: Record<string,string>) {
    mkdirSync(directory,{recursive:true});
    const text=JSON.stringify(data);
    // Recovery is committed first: a crash cannot lose a freshly rotated token.
    for(const target of [recovery,file]) {
      const temporary=`${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary,text,{encoding:"utf8",mode:0o600});
      renameSync(temporary,target);
    }
  }
  return {
    getItem:key=>read()[key]??null,
    setItem(key,value){const data=read();data[key]=value;write(data);},
    removeItem(key){const data=read();delete data[key];write(data);},
  };
}
