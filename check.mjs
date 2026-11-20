// Checks each service, keeps status.json (current state + hourly history, 30 days), and opens/closes an issue when one goes down/up.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const services = JSON.parse(readFileSync('services.json', 'utf8'));
const file = 'status.json';
const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { services: {} };
const now = new Date();
const hourly = now.getUTCMinutes() < 10; // one history point per hour (the schedule runs every 5 minutes, often late)
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

async function probe(url) {
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'azonation-status' } });
      if (r.ok) return { up: true, ms: Date.now() - t, code: r.status };
      if (i === 2) return { up: false, ms: null, code: r.status };
    } catch (e) {
      if (i === 2) return { up: false, ms: null, code: String(e.name || 'error') };
    }
    await new Promise((res) => setTimeout(res, 10000));
  }
}

async function gh(path, method = 'GET', body) {
  if (!token) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json() : null;
}

const out = { updated: now.toISOString(), services: {} };
let changed = false;
for (const s of services) {
  const was = old.services[s.id] || { history: [] };
  const res = await probe(s.url);
  const history = (was.history || []).slice(-24 * 30);
  if (hourly && (!history.length || now - new Date(history.at(-1)[0]) > 30 * 60000)) history.push([now.toISOString(), res.up ? res.ms : -1]);
  const flipped = was.up !== undefined && was.up !== res.up;
  const entry = { name: s.name, url: s.url, up: res.up, ms: res.ms, code: res.code, since: flipped || was.since === undefined ? now.toISOString() : was.since, issue: was.issue ?? null, history };
  if (flipped || was.up === undefined || hourly) changed = true;
  if (!res.up && !entry.issue) {
    const issue = await gh('/issues', 'POST', { title: `${s.name} is down`, body: `${s.url} did not answer (${res.code}) at ${now.toISOString()}. This issue closes itself when it is back.`, labels: ['down'] });
    entry.issue = issue?.number ?? null;
  }
  if (res.up && entry.issue) {
    await gh(`/issues/${entry.issue}/comments`, 'POST', { body: `Back up at ${now.toISOString()}.` });
    await gh(`/issues/${entry.issue}`, 'PATCH', { state: 'closed' });
    entry.issue = null;
  }
  out.services[s.id] = entry;
  console.log(`${s.id}: ${res.up ? 'up' : 'DOWN'} ${res.code} ${res.ms ?? ''}ms`);
}
if (changed) writeFileSync(file, JSON.stringify(out) + '\n');
