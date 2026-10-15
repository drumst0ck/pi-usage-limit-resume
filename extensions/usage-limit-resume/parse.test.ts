import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCliWindows } from './claude-cli.ts';
import { codexWindowsFromUsage } from './codex-usage.ts';
import { headerWindows, isUsageLimitError, parseResetHeaders, parseResetTime } from './parse.ts';

const NOW = new Date('2026-10-14T11:00:00Z');


const iso=(ms:number)=>new Date(ms).toISOString();

const anth=(five:number,fiveReset:number,week:number,weekReset:number)=>({'anthropic-ratelimit-unified-5h-utilization':String(five),'anthropic-ratelimit-unified-5h-reset':String(fiveReset),
 'anthropic-ratelimit-unified-7d-utilization':String(week),'anthropic-ratelimit-unified-7d-reset':String(weekReset)});

const sec=(ms:number)=>Math.floor(ms/1000);

const wham=(pct:number,reset:number)=>({rate_limit:{primary_window:{used_percent:pct,limit_window_seconds:18000,reset_at:reset},secondary_window:{used_percent:18,limit_window_seconds:604800,reset_at:reset+500000}}});

const cliText=`You are currently using your subscription to power your Claude Code usage

Current session: 56% used · resets Oct 14 at 6:50pm (Europe/Madrid)
Current week (all models): 38% used · resets Oct 20 at 6pm (Europe/Madrid)

What's contributing to your limits usage?`;

test('Codex headers: resets the exhausted window, not the latest one',()=>{
 const primary=Math.floor(NOW.getTime()/1000)+3*3600, weekly=Math.floor(NOW.getTime()/1000)+5*86400;
 const at=parseResetHeaders({'x-codex-primary-used-percent':'100','x-codex-primary-reset-at':String(primary),
  'x-codex-secondary-used-percent':'40','x-codex-secondary-reset-at':String(weekly)},NOW);
 assert.equal(at,primary*1000);
});

test('Anthropic headers: resets the exhausted window, not the latest one',()=>{
 const five=Math.floor(NOW.getTime()/1000)+2*3600, week=Math.floor(NOW.getTime()/1000)+6*86400;
 const at=parseResetHeaders({'anthropic-ratelimit-unified-5h-utilization':'1.0','anthropic-ratelimit-unified-5h-reset':String(five),
  'anthropic-ratelimit-unified-7d-utilization':'0.4','anthropic-ratelimit-unified-7d-reset':String(week)},NOW);
 assert.equal(at,five*1000);
});

test('relative reset formats in error messages',()=>{
 assert.equal(parseResetTime('You have hit your ChatGPT usage limit. Try again in ~236 min.',NOW),NOW.getTime()+236*60_000);
 assert.equal(parseResetTime('usage limit reached, try again in 2h 13m',NOW),NOW.getTime()+(2*60+13)*60_000);
 assert.equal(parseResetTime('limit reached, resets in 45 minutes',NOW),NOW.getTime()+45*60_000);
});

test('near-exhausted window (>=90%) is the one that sets the reset',()=>{
 const five=Math.floor(NOW.getTime()/1000)+2*3600, week=Math.floor(NOW.getTime()/1000)+6*86400;
 assert.equal(parseResetHeaders({'anthropic-ratelimit-unified-5h-utilization':'0.95','anthropic-ratelimit-unified-5h-reset':String(five),
  'anthropic-ratelimit-unified-7d-utilization':'0.3','anthropic-ratelimit-unified-7d-reset':String(week)},NOW),five*1000);
});

test('healthy windows alone never invent a reset (burst limit falls back to probe)',()=>{
 const week=Math.floor(NOW.getTime()/1000)+6*86400;
 assert.equal(parseResetHeaders({'anthropic-ratelimit-unified-7d-utilization':'0.3','anthropic-ratelimit-unified-7d-reset':String(week)},NOW),undefined);
});

test('"out of extra usage" is a usage limit',()=>{
 assert.equal(isUsageLimitError(`400 {"error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}`),true);
});

test('headerWindows: Anthropic fractions and Codex percents become 5h/weekly windows',()=>{
 const n=NOW.getTime();
 assert.deepEqual(headerWindows(anth(0.48,sec(n)+3600,0.37,sec(n)+86400),n),{fiveHour:{usedPercent:48,resetsAt:(sec(n)+3600)*1000},weekly:{usedPercent:37,resetsAt:(sec(n)+86400)*1000}});
 assert.deepEqual(headerWindows({'x-codex-primary-used-percent':'100','x-codex-primary-window-minutes':'300','x-codex-primary-reset-at':String(sec(n)+900),
  'x-codex-secondary-used-percent':'18','x-codex-secondary-window-minutes':'10080','x-codex-secondary-reset-after-seconds':'3600'},n),
  {fiveHour:{usedPercent:100,resetsAt:(sec(n)+900)*1000},weekly:{usedPercent:18,resetsAt:n+3600_000}});
 assert.equal(headerWindows({'content-type':'x'},n),undefined);
});

test('codex usage payload becomes 5h and weekly windows',()=>{
 const r=sec(NOW.getTime())+3600;
 assert.deepEqual(codexWindowsFromUsage(wham(100,r)),{fiveHour:{usedPercent:100,resetsAt:r*1000},weekly:{usedPercent:18,resetsAt:(r+500000)*1000}});
 assert.equal(codexWindowsFromUsage({}),undefined);
});

test('reset text with "Mon D at H:MMpm (Zone)" is understood',()=>{
 assert.equal(parseResetTime('resets Oct 14 at 6:50pm (Europe/Madrid)',NOW),Date.parse('2026-10-14T16:50:00Z'));
 assert.equal(parseResetTime('resets Oct 20 at 6pm (Europe/Madrid)',NOW),Date.parse('2026-10-20T16:00:00Z'));
 assert.equal(parseResetTime('Resets 6:50pm (Europe/Madrid)',NOW),Date.parse('2026-10-14T16:50:00Z'));
});

test('claude /usage text becomes 5h and weekly windows',()=>{
 assert.deepEqual(claudeCliWindows(cliText,NOW.getTime()),{fiveHour:{usedPercent:56,resetsAt:Date.parse('2026-10-14T16:50:00Z')},weekly:{usedPercent:38,resetsAt:Date.parse('2026-10-20T16:00:00Z')}});
 assert.deepEqual(claudeCliWindows('Current week (Opus): 90% used · resets Oct 20 at 6pm (Europe/Madrid)\nCurrent week (all models): 38% used · resets Oct 20 at 6pm (Europe/Madrid)',NOW.getTime())!.weekly!.usedPercent,38);
 assert.equal(claudeCliWindows('Not logged in',NOW.getTime()),undefined);
 assert.equal(claudeCliWindows(undefined,NOW.getTime()),undefined);
});


test('weekday resets: next occurrence of that day, in the stated zone',()=>{
 assert.equal(iso(parseResetTime('Your limit resets Mon 7pm (UTC)',NOW)!),'2026-10-19T19:00:00.000Z');
 assert.equal(iso(parseResetTime('resets Monday at 7:30 PM (UTC)',NOW)!),'2026-10-19T19:30:00.000Z');
 assert.equal(iso(parseResetTime('resets Wed 3pm (UTC)',NOW)!),'2026-10-14T15:00:00.000Z');
 assert.equal(iso(parseResetTime('resets Wed 9am (UTC)',NOW)!),'2026-10-21T09:00:00.000Z');
 assert.equal(iso(parseResetTime('resets Tues, 8am (Europe/Madrid)',NOW)!),'2026-10-20T06:00:00.000Z');
});
test('month-day resets still work and a weekday word never breaks them',()=>{
 assert.equal(iso(parseResetTime('resets Oct 20 at 6pm (UTC)',NOW)!),'2026-10-20T18:00:00.000Z');
 assert.equal(parseResetTime('resets Foo 7pm (UTC)',NOW),undefined);
});

test('a 5xx-looking number inside a real limit message is not treated as transient (S8)',()=>{
 assert.equal(isUsageLimitError('Quota exceeded for this plan; retry in 512s'),true);
 assert.equal(isUsageLimitError('Insufficient quota: 550 requests used'),true);
 assert.equal(isUsageLimitError('HTTP 503 Service Unavailable'),false);
 assert.equal(isUsageLimitError('error 500: rate limit backend failure'),false);
});
test('a month/day reset that just passed is not rolled to next year (S6)',()=>{
 const t=parseResetTime('resets Oct 14 at 10:30am (UTC)',NOW)!;
 assert.equal(iso(t),'2026-10-14T10:30:00.000Z');
 assert.equal(iso(parseResetTime('resets Oct 10 at 10am (UTC)',NOW)!),'2027-10-10T10:00:00.000Z');
});

test('zone abbreviations and UTC/GMT offsets set the reset zone (S12)',()=>{
 // NOW = 2026-10-14T11:00:00Z
 assert.equal(iso(parseResetTime('resets 7pm (PDT)',NOW)!),'2026-10-15T02:00:00.000Z');
 assert.equal(iso(parseResetTime('resets 7pm PST',NOW)!),'2026-10-15T03:00:00.000Z');
 assert.equal(iso(parseResetTime('resets 3pm (CEST)',NOW)!),'2026-10-14T13:00:00.000Z');
 assert.equal(iso(parseResetTime('resets 3pm (GMT+2)',NOW)!),'2026-10-14T13:00:00.000Z');
 assert.equal(iso(parseResetTime('resets 3pm UTC-5',NOW)!),'2026-10-14T20:00:00.000Z');
 assert.equal(iso(parseResetTime('resets 3pm (UTC+05:30)',NOW)!),'2026-10-15T09:30:00.000Z');
 assert.equal(iso(parseResetTime('resets Mon 7pm (EDT)',NOW)!),'2026-10-19T23:00:00.000Z');
});
test('an unknown zone in parentheses yields no reset instead of a wrong one (S12)',()=>{
 assert.equal(parseResetTime('resets 7pm (XYZT)',NOW),undefined);
 assert.equal(parseResetTime('resets 7pm (Mars/Olympus)',NOW),undefined);
});
test('24-hour reset times are parsed; a bare number is not a time (S12)',()=>{
 assert.equal(iso(parseResetTime('resets 19:00 (UTC)',NOW)!),'2026-10-14T19:00:00.000Z');
 assert.equal(iso(parseResetTime('resets at 09:30 UTC',NOW)!),'2026-10-15T09:30:00.000Z');
 assert.equal(iso(parseResetTime('resets Oct 20 at 18:00 (UTC)',NOW)!),'2026-10-20T18:00:00.000Z');
 assert.equal(iso(parseResetTime('resets Monday 19:00 (UTC)',NOW)!),'2026-10-19T19:00:00.000Z');
 assert.equal(parseResetTime('resets 25:00 (UTC)',NOW),undefined);
 assert.equal(parseResetTime('resets 3 times a day',NOW),undefined);
 assert.equal(parseResetTime('resets 13pm (UTC)',NOW),undefined);
});
test('a bare word after the time is only a zone when written as an uppercase abbreviation (S12)',()=>{
 const local=parseResetTime('resets 7pm',NOW);
 assert.equal(parseResetTime('resets 7pm west',NOW),local);
 assert.equal(parseResetTime('resets 7pm today',NOW),local);
 assert.equal(iso(parseResetTime('resets 7pm WEST',NOW)!),'2026-10-14T18:00:00.000Z');
 assert.equal(parseResetTime('resets 7pm ET',NOW),undefined);
});
