// 주마다 생활과 봉사 집회 교재의 파트 이름과 시간만 가져와 programs.json에 더한다.
// 이미 받은 주는 다시 받지 않고, 요청 사이에 쉬어서 사이트에 부담을 주지 않는다.
import fs from 'node:fs';

const OUT = new URL('../programs.json', import.meta.url);
const BASE = 'https://wol.jw.org';
const LOOKAHEAD = 10; // 이번 주부터 몇 주 앞까지 볼지
const UA = 'Mozilla/5.0 (meeting-schedule weekly check)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const unescape = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = h => unescape(h.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// ISO 주차 → 그 주 월요일 (YYYY-MM-DD)
function isoWeekMonday(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return mon.toISOString().slice(0, 10);
}
function isoWeekOf(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const y = t.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4));
  return { year: y, week: 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7) };
}

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko' } });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.text();
}

// 교재 한 주 문서에서 구역별 파트 이름과 시간만 뽑기
function parseWorkbook(html) {
  const art = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
  const re = /<(h2|h3)([^>]*)>([\s\S]*?)<\/\1>/g;
  const heads = []; let m;
  while ((m = re.exec(art))) heads.push({ tag: m[1], t: text(m[3]), end: re.lastIndex });
  const SEC = { '성경에 담긴 보물': 1, '야외 봉사에 힘쓰십시오': 2, '그리스도인 생활': 3 };
  const out = { t1: null, s1: [], s2: [], s3: [], cbs: null, co: null };
  let sec = 0;
  heads.forEach((h, i) => {
    if (h.tag === 'h2') { if (SEC[h.t]) sec = SEC[h.t]; return; }
    const pm = /^(\d+)\.\s*(.+)$/.exec(h.t);
    if (!pm || !sec) return;
    const name = pm[2].trim();
    const next = heads[i + 1] ? heads[i + 1].end : art.length;
    const body = text(art.slice(h.end, next));
    const mm = /\(\s*(\d+)\s*분\s*\)/.exec(body);
    const min = mm ? +mm[1] : null;
    // 시간 뒤의 형식 (예: "(15분) 토의." → 토의, "동영상 및 토의")
    const lm = /\(\s*\d+\s*분\s*\)\s*([^.(]{1,15})\./.exec(body);
    const label = lm && /[가-힣]/.test(lm[1]) ? lm[1].trim() : null;
    if (sec === 1) { if (!out.s1.length) out.t1 = name; out.s1.push(min); } // t1: 10분 연설 주제
    else if (sec === 2) out.s2.push([name, min]);
    else if (/회중 성서 연구/.test(name)) out.cbs = min || 30;
    else if (/봉사 강연/.test(name)) out.co = [name, min || 30];
    else out.s3.push([name, min, label]);
  });
  if (!out.s2.length && !out.s3.length) return null;
  out.v = 2;
  return out;
}

const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { weeks: {} };
const now = new Date();
const { year, week } = isoWeekOf(now);
let added = 0;
for (let i = 0; i < LOOKAHEAD; i++) {
  let y = year, w = week + i;
  const lastWeek = isoWeekOf(new Date(Date.UTC(y, 11, 28))).week;
  if (w > lastWeek) { w -= lastWeek; y += 1; }
  const monday = isoWeekMonday(y, w);
  if (data.weeks[monday] && data.weeks[monday].v === 2) continue; // 이미 있음
  try {
    const page = await get(`${BASE}/ko/wol/meetings/r8/lp-ko/${y}/${w}`);
    const link = /href="(\/ko\/wol\/d\/r8\/lp-ko\/\d+)"[^>]*class="[^"]*pub-mwb/.exec(page);
    await sleep(2000);
    if (!link) { console.log(monday, '교재 아직 없음'); continue; }
    const prog = parseWorkbook(await get(BASE + link[1]));
    await sleep(2000);
    if (!prog) { console.log(monday, '파트를 읽지 못함'); continue; }
    data.weeks[monday] = prog; added++;
    console.log(monday, JSON.stringify(prog));
  } catch (e) { console.log(monday, '실패', e.message); }
}
// 지난 지 6개월 넘은 주는 정리
const cut = new Date(now); cut.setUTCMonth(cut.getUTCMonth() - 6);
for (const k of Object.keys(data.weeks)) if (k < cut.toISOString().slice(0, 10)) delete data.weeks[k];
data.weeks = Object.fromEntries(Object.entries(data.weeks).sort());
if (added) data.updated = now.toISOString();
fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
console.log('새로 더한 주', added);
