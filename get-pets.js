#!/usr/bin/env node
// 치이카와 Codex 펫 스프라이트를 GitHub에서 이 폴더의 pets/ 로 받는다. Codex 폴더는 건드리지 않는다.
// 출처: https://github.com/heelee912/chiikawa-dots-pets (비공식 팬 프로젝트, 재배포 금지라서 직접 받아 쓴다)
// 사용법: node get-pets.js            모두 받기
//         node get-pets.js chiikawa usagi   일부만 받기

const fs = require('fs');
const path = require('path');

const RAW = 'https://raw.githubusercontent.com/heelee912/chiikawa-dots-pets/main/pets';
const ALL = ['chiikawa', 'hachiware', 'usagi', 'momonga', 'shisa', 'rakko', 'kurimanju', 'siren', 'furuhonya', 'anoko', 'dekatsuyo'];

(async () => {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
  for (const id of wanted) {
    if (!ALL.includes(id)) { console.error(`모르는 펫: ${id} (가능: ${ALL.join(', ')})`); process.exitCode = 1; continue; }
    const dir = path.join(__dirname, 'pets', id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const name of ['pet.json', 'spritesheet.png']) {
        const res = await fetch(`${RAW}/${id}/${name}`);
        if (!res.ok) throw new Error(`${name} 받기 실패 (HTTP ${res.status})`);
        fs.writeFileSync(path.join(dir, name), Buffer.from(await res.arrayBuffer()));
      }
      console.log(`받음: ${id}`);
    } catch (e) {
      console.error(`${id}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log('끝. node server.js 를 (다시) 실행하고 브라우저를 새로고침하세요.');
})();
