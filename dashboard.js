/* 기록 대시보드
   index.html 에 붙는 화면 모듈입니다. 로그인·프로필·저장은 앱이 맡고, 이 파일은 조회와 화면만 맡습니다.
   앱이 createDashboard(host) 로 불러 쓰며, 데이터는 Supabase 에서 로그인한 계정의 RLS 범위 안에서만 읽습니다.
   - 푼 문제 수: attempts(구구단·덧셈뺄셈·곱셈) + ph_attempts(파닉스) 에 기록된 풀이를 dashboard_activity() 로 집계
   - 진도율: profile_state.progress (숙련도·단계별 별) */
(function () {
  'use strict';

  var DAYS = 200;   /* 일·주·월 차트가 쓰는 기간 (월간 6개월이 들어가도록) */
  var KINDS = [
    { k: 'mul', name: '구구단',    icon: '✖️', hue: 2 },
    { k: 'as',  name: '덧셈·뺄셈', icon: '➕', hue: 4 },
    { k: 'ml',  name: '곱셈',      icon: '🔢', hue: 6 },
    { k: 'ph',  name: '파닉스',    icon: '🔤', hue: 8 }
  ];
  var MODE_NAME = { practice: '연습', challenge: '도전', play: '놀이' };
  var RANGES = [
    { r: 'day', name: '일간' },
    { r: 'week', name: '주간' },
    { r: 'month', name: '월간' }
  ];
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  var MASTERY = 3;   /* 파닉스: 연속 3번 맞히면 숙달 (phonics.js 의 masteryStreak 과 같은 값) */

  /* ---------- 날짜 계산 (문자열 'YYYY-MM-DD' 로만 다뤄 시간대·썸머타임 영향을 받지 않게 한다) ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function parse(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function ymd(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function addDays(s, n) { var d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
  function mondayOf(s) { return addDays(s, -((parse(s).getUTCDay() + 6) % 7)); }   /* 주는 월요일에 시작 */
  function monthOf(s) { return s.slice(0, 7); }
  function addMonths(m, n) {
    var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + n;
    y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
    return y + '-' + pad(mo + 1);
  }
  function todayIn(tz) {
    var d = new Date();
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d), o = {};
      parts.forEach(function (p) { o[p.type] = p.value; });
      if (o.year && o.month && o.day) return o.year + '-' + o.month + '-' + o.day;
    } catch (e) {}
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function browserTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul'; } catch (e) { return 'Asia/Seoul'; }
  }

  /* ---------- 기간 묶음 ---------- */
  function buckets(range, today) {
    var out = [], i;
    if (range === 'day') for (i = 13; i >= 0; i--) out.push(addDays(today, -i));
    else if (range === 'week') { var m = mondayOf(today); for (i = 7; i >= 0; i--) out.push(addDays(m, -7 * i)); }
    else { var mo = monthOf(today); for (i = 5; i >= 0; i--) out.push(addMonths(mo, -i)); }
    return out;
  }
  function keyOf(range, d) { return range === 'day' ? d : range === 'week' ? mondayOf(d) : monthOf(d); }
  function md(s) { var p = s.split('-'); return (+p[1]) + '/' + (+p[2]); }
  function shortLabel(range, key, i) {
    if (range === 'day') return (i === 0 || key.slice(8) === '01') ? md(key) : '' + (+key.slice(8));
    if (range === 'week') return md(key);
    return (+key.slice(5, 7)) + '월';
  }
  function longLabel(range, key) {
    function mdk(s) { return (+s.slice(5, 7)) + '월 ' + (+s.slice(8, 10)) + '일'; }
    if (range === 'day') return mdk(key) + ' (' + DOW[parse(key).getUTCDay()] + ')';
    if (range === 'week') return mdk(key) + ' ~ ' + mdk(addDays(key, 6));
    return key.slice(0, 4) + '년 ' + (+key.slice(5, 7)) + '월';
  }

  /* rows(서버가 준 하루×놀이터×모드 집계) → { 기간키: { 놀이터: {n,c,f,fc,m:{모드:n}} } } */
  function aggregate(rows, range) {
    var map = {};
    (rows || []).forEach(function (r) {
      var key = keyOf(range, r.d), b = map[key] || (map[key] = {});
      var k = b[r.k] || (b[r.k] = { n: 0, c: 0, f: 0, fc: 0, m: {} });
      k.n += r.n; k.c += r.c; k.f += r.f; k.fc += r.fc;
      k.m[r.m] = (k.m[r.m] || 0) + r.n;
    });
    return map;
  }
  function sumOf(b) {
    var t = { n: 0, c: 0 };
    if (b) Object.keys(b).forEach(function (k) { t.n += b[k].n; t.c += b[k].c; });
    return t;
  }

  /* ---------- 진도율 ---------- */
  function num(v) { return +v || 0; }
  function obj(v) { return v && typeof v === 'object' ? v : {}; }

  function mulProgress(pg) {
    var facts = obj(pg.facts), dans = [], started = 0, perfect = 0, a, b;
    for (a = 2; a <= 9; a++) {
      var s = 0, p = 0;
      for (b = 1; b <= 9; b++) {
        var l = num(facts[a + 'x' + b]);
        if (l > 0) s++;
        if (l >= 3) p++;
      }
      dans.push({ a: a, started: s, perfect: p });
      started += s; perfect += p;
    }
    return { done: started, total: 72, perfect: perfect, dans: dans };
  }
  function bestProgress(best, lvs, keyFn) {
    var out = [], done = 0, stars = 0;
    lvs.forEach(function (lv) {
      var v = keyFn(best, lv);
      out.push({ lv: lv, stars: v });
      if (v > 0) done++;
      stars += v;
    });
    return { done: done, total: lvs.length, stars: stars, lvs: out };
  }
  function asProgress(pg) {
    var best = obj(obj(pg.as).best);
    return bestProgress(best, [1, 2, 3, 4, 5, 6], function (bs, lv) {   /* 덧셈·뺄셈·섞어서 중 가장 높은 별 */
      return Math.max(num(bs['+:' + lv]), num(bs['-:' + lv]), num(bs['m:' + lv]));
    });
  }
  function mlProgress(pg) {
    var best = obj(obj(pg.ml).best);
    return bestProgress(best, [1, 2, 3, 4, 5], function (bs, lv) { return num(bs[lv]); });
  }
  /* stages: phonics/data/stage*.json 내용(없으면 null). 단계는 추천 게임(mainGames)에서 별을 모두 받으면 클리어 */
  function phProgress(pg, stages) {
    var ph = obj(pg.ph), items = obj(ph.items), stars = obj(ph.stars);
    if (!stages || !stages.length) return null;
    function mastered(key) { var it = items[key]; return Array.isArray(it) && num(it[0]) >= MASTERY; }
    var out = [], cleared = 0, snd = 0, sndAll = 0, wd = 0, wdAll = 0;
    stages.forEach(function (st) {
      var main = st.mainGames && st.mainGames.length ? st.mainGames : ['A'];
      var ok = main.every(function (g) { return num(stars[st.stage + ':' + g]) > 0; });
      var any = ['A', 'B', 'C', 'D'].some(function (g) { return num(stars[st.stage + ':' + g]) > 0; });
      if (ok) cleared++;
      out.push({ stage: st.stage, cleared: ok, started: any });
      (st.sounds || []).forEach(function (s) { sndAll++; if (mastered('p:' + s.id)) snd++; });
      (st.words || []).forEach(function (w) { wdAll++; if (mastered('w:' + w.word) || mastered('c:' + w.word)) wd++; });
    });
    return { done: cleared, total: stages.length, stages: out, sounds: snd, soundsAll: sndAll, words: wd, wordsAll: wdAll };
  }

  function pct(done, total) { return total ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0; }
  function starText(n) { n = Math.max(0, Math.min(3, n)); return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }

  /* ---------- 모듈 ---------- */
  var api = {
    addDays: addDays, mondayOf: mondayOf, addMonths: addMonths, buckets: buckets, keyOf: keyOf,
    aggregate: aggregate, sumOf: sumOf, mulProgress: mulProgress, asProgress: asProgress,
    mlProgress: mlProgress, phProgress: phProgress, shortLabel: shortLabel, longLabel: longLabel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   /* 테스트용 */
  window.dashboardLogic = api;

  window.createDashboard = function (host) {
    var esc = host.esc;
    var el = document.getElementById('dash');
    var seq = 0;
    var stagesP = null;
    var st = { from: 'home', profiles: [], pid: '', range: 'day', sel: '', data: null, progress: null, stages: null, today: '', tz: '', loading: false, err: '' };

    function sb() { return host.getSb(); }

    function loadStages() {   /* 파닉스 단계 정보. 실패해도 대시보드의 나머지는 보여 준다 */
      if (stagesP) return stagesP;
      var base = 'phonics/data/';
      function get(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }
      stagesP = get(base + 'stages.json').then(function (idx) {
        return Promise.all(idx.stages.map(function (f) { return get(base + f); }));
      }).then(function (files) {
        return files.sort(function (a, b) { return a.stage - b.stage; });
      }).catch(function () { stagesP = null; return null; });
      return stagesP;
    }

    function fetchActivity(pid, tz) {
      return Promise.resolve(sb().rpc('dashboard_activity', { p_profile: pid, p_days: DAYS, p_tz: tz })).then(function (r) {
        if (r && r.error) {
          if (r.error.code === '22023' && tz !== 'Asia/Seoul') return fetchActivity(pid, 'Asia/Seoul');   /* 모르는 시간대 */
          throw r.error;
        }
        st.tz = tz;
        return r.data || { days: [], totals: [] };
      });
    }
    function fetchProgress(pid) {
      if (pid === host.getProfileId()) return Promise.resolve(host.getStore());   /* 지금 하고 있는 프로필은 가장 최신 값을 쓴다 */
      return Promise.resolve(sb().from('profile_state').select('progress').eq('profile_id', pid).maybeSingle()).then(function (r) {
        if (r && r.error) throw r.error;
        return (r && r.data && r.data.progress) || {};
      });
    }

    function load() {
      var my = ++seq, pid = st.pid;
      st.loading = true; st.err = ''; st.data = null; st.progress = null; st.sel = '';
      render();
      Promise.all([fetchActivity(pid, browserTz()), fetchProgress(pid), loadStages()]).then(function (r) {
        if (my !== seq) return;
        st.data = r[0]; st.progress = r[1] || {}; st.stages = r[2];
        st.today = todayIn(st.tz || browserTz());
        st.loading = false;
        render();
      }).catch(function (e) {
        if (my !== seq) return;
        var msg = e && (e.code + ' ' + (e.message || '')) || '';
        st.err = /PGRST202|42883|dashboard_activity|ph_attempts|42P01/.test(msg) ? 'setup' : 'fail';
        st.loading = false;
        render();
      });
    }

    function open(from) {
      var my = ++seq;
      st.from = from || 'home';
      st.err = ''; st.loading = true; st.data = null;
      render();
      host.show('dash');
      Promise.resolve(host.listProfiles()).then(function (list) {
        if (my !== seq) return;
        st.profiles = list || [];
        var cur = host.getProfileId();
        var pick = st.profiles.filter(function (p) { return p.id === cur; })[0] || st.profiles[0];
        if (!pick) { st.loading = false; st.pid = ''; render(); return; }
        st.pid = pick.id;
        load();
      }).catch(function () {
        if (my !== seq) return;
        st.err = 'fail'; st.loading = false; render();
      });
    }

    /* ---------- 그리기 ---------- */
    function kindOf(k) { return KINDS.filter(function (x) { return x.k === k; })[0]; }

    function statPills(rows, totals) {
      var today = st.today;
      var d = aggregate(rows, 'day'), w = aggregate(rows, 'week'), m = aggregate(rows, 'month');
      var all = 0;
      (totals || []).forEach(function (t) { all += t.n; });
      function pill(label, n) { return '<span class="stat">' + label + ' <b>' + n + '</b>문제</span>'; }
      return '<div class="stats dstats">' +
        pill('오늘', sumOf(d[today]).n) +
        pill('이번 주', sumOf(w[mondayOf(today)]).n) +
        pill('이번 달', sumOf(m[monthOf(today)]).n) +
        pill('전체', all) + '</div>';
    }

    function chart(map, keys) {
      var max = 10, i;
      keys.forEach(function (k) { max = Math.max(max, sumOf(map[k]).n); });
      var cols = '';
      for (i = 0; i < keys.length; i++) {
        var key = keys[i], b = map[key], tot = sumOf(b).n, segs = '';
        KINDS.forEach(function (kd) {
          if (b && b[kd.k] && b[kd.k].n) segs += '<i style="flex:' + b[kd.k].n + ' 1 0;background:var(--d' + kd.hue + ')"></i>';
        });
        var on = key === st.sel;
        cols += '<button class="dcol" data-d="bucket" data-v="' + key + '" aria-pressed="' + on + '" aria-label="' + esc(longLabel(st.range, key)) + ', ' + tot + '문제">' +
          '<span class="dnum">' + (tot || '') + '</span>' +
          '<span class="dwrap">' + (tot ? '<span class="dstack" style="height:' + Math.max(6, Math.round(tot / max * 100)) + '%">' + segs + '</span>' : '<span class="dzero"></span>') + '</span>' +
          '<span class="dlab">' + esc(shortLabel(st.range, key, i)) + '</span></button>';
      }
      var legend = KINDS.map(function (kd) {
        return '<span><i class="dot" style="background:var(--d' + kd.hue + ')"></i>' + kd.icon + ' ' + kd.name + '</span>';
      }).join('');
      return '<div class="dchart" role="group" aria-label="기간별 푼 문제 수">' + cols + '</div><div class="legend dlegend">' + legend + '</div>';
    }

    function detail(map) {
      var b = map[st.sel], tot = sumOf(b), rows = '';
      KINDS.forEach(function (kd) {
        var k = b && b[kd.k];
        if (!k || !k.n) return;
        var modes = Object.keys(k.m).map(function (m) { return (MODE_NAME[m] || m) + ' ' + k.m[m]; }).join(' · ');
        var first = k.f ? '처음에 맞힌 비율 ' + Math.round(k.fc / k.f * 100) + '%' : '';
        rows += '<div class="drow" style="--c:var(--d' + kd.hue + ')">' +
          '<span class="dico" aria-hidden="true">' + kd.icon + '</span>' +
          '<span class="dname"><b>' + kd.name + '</b><small>' + esc(modes) + '</small></span>' +
          '<span class="dcount"><b>' + k.n + '</b>문제<small>맞힌 문제 ' + k.c + (first ? ' · ' + first : '') + '</small></span></div>';
      });
      return '<div class="card box dcard"><h3>' + esc(longLabel(st.range, st.sel)) + '</h3>' +
        (tot.n
          ? '<p class="dsum">푼 문제 <b>' + tot.n + '</b>개 · 맞힌 문제 <b>' + tot.c + '</b>개</p><div class="drows">' + rows + '</div>'
          : '<p class="msg">이 기간에는 푼 문제가 없어요.</p>') +
        '</div>';
    }

    function bar(hue, done, total, label) {
      var p = pct(done, total);
      return '<div class="prog" style="--h:var(--d' + hue + ')" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + p + '"><i style="width:' + p + '%"></i></div>';
    }
    function dchip(text, sub, hue, on) {
      return '<span class="dchip' + (on ? ' on' : '') + '" style="--c:var(--d' + hue + ')"><b>' + text + '</b><small>' + sub + '</small></span>';
    }

    function progressCard() {
      var pg = st.progress || {}, h = '';
      var mul = mulProgress(pg), as = asProgress(pg), ml = mlProgress(pg), ph = phProgress(pg, st.stages);

      h += '<div class="dprog"><div class="dprog-head"><b>' + kindOf('mul').icon + ' 구구단</b><span>익힌 칸 ' + mul.done + '/' + mul.total + ' · 완벽 ' + mul.perfect + '칸</span></div>' +
        bar(2, mul.done, mul.total, '구구단 진도') +
        '<div class="dchips">' + mul.dans.map(function (d) { return dchip(d.a + '단', d.started + '/9', d.a, d.started === 9); }).join('') + '</div></div>';

      h += '<div class="dprog"><div class="dprog-head"><b>' + kindOf('as').icon + ' 덧셈·뺄셈</b><span>' + as.total + '단계 중 ' + as.done + '단계 · 별 ' + as.stars + '개</span></div>' +
        bar(4, as.done, as.total, '덧셈·뺄셈 진도') +
        '<div class="dchips">' + as.lvs.map(function (l) { return dchip(l.lv + '단계', starText(l.stars), 4, l.stars > 0); }).join('') + '</div></div>';

      h += '<div class="dprog"><div class="dprog-head"><b>' + kindOf('ml').icon + ' 곱셈</b><span>' + ml.total + '단계 중 ' + ml.done + '단계 · 별 ' + ml.stars + '개</span></div>' +
        bar(6, ml.done, ml.total, '곱셈 진도') +
        '<div class="dchips">' + ml.lvs.map(function (l) { return dchip(l.lv + '단계', starText(l.stars), 6, l.stars > 0); }).join('') + '</div></div>';

      if (ph) {
        h += '<div class="dprog"><div class="dprog-head"><b>' + kindOf('ph').icon + ' 파닉스</b><span>' + ph.total + '단계 중 ' + ph.done + '단계 클리어</span></div>' +
          bar(8, ph.done, ph.total, '파닉스 진도') +
          '<div class="dchips">' + ph.stages.map(function (s) { return dchip(s.stage + '단계', s.cleared ? '클리어 ✓' : s.started ? '도전 중' : '아직', 8, s.cleared); }).join('') + '</div>' +
          '<p class="dsub">숙달한 소리 ' + ph.sounds + '/' + ph.soundsAll + ' · 숙달한 단어 ' + ph.words + '/' + ph.wordsAll + '</p></div>';
      } else {
        h += '<div class="dprog"><div class="dprog-head"><b>' + kindOf('ph').icon + ' 파닉스</b><span>단계 정보를 불러오지 못했어요</span></div></div>';
      }
      return '<div class="card box dcard"><h3>진도율</h3>' + h + '</div>';
    }

    function render() {
      var head = '<header class="top"><div><h1>활동 기록</h1><p class="sub">푼 문제와 진도를 한눈에 봐요.</p></div></header>';
      var back = '<button class="btn wide" data-d="back">' + (st.from === 'profiles' ? '← 프로필로' : '← 놀이터로') + '</button>';
      var body = '';

      if (st.err === 'setup') {
        body = '<div class="card box"><p class="msg"><b>기록 보기를 쓰려면 DB 설정이 한 번 더 필요해요.</b></p>' +
          '<p class="msg">관리하는 분은 Supabase SQL Editor에서 <code>supabase/schema.sql</code> 전체를 다시 실행해 주세요. 다시 실행해도 안전해요.</p>' +
          '<button class="btn primary wide" data-d="retry">다시 시도</button></div>';
      } else if (st.err) {
        body = '<div class="card box"><p class="msg">기록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.</p><button class="btn primary wide" data-d="retry">다시 시도</button></div>';
      } else if (!st.loading && !st.pid) {
        body = '<div class="card box"><p class="msg">아직 프로필이 없어요. 프로필을 먼저 만들어 주세요.</p></div>';
      } else {
        var profs = '<div class="dprofs" role="group" aria-label="프로필 고르기">' + st.profiles.map(function (p) {
          return '<button class="btn small dprof" data-d="prof" data-v="' + esc(p.id) + '" aria-pressed="' + (p.id === st.pid) + '">' + esc(p.name) + '</button>';
        }).join('') + '</div>';
        if (st.loading || !st.data) {
          body = profs + '<p class="msg" role="status" style="margin-top:1rem">불러오는 중이에요…</p>';
        } else {
          var rows = st.data.days || [], map = aggregate(rows, st.range), keys = buckets(st.range, st.today);
          if (!st.sel || keys.indexOf(st.sel) < 0) st.sel = keys[keys.length - 1];
          var tabs = '<div class="dtabs" role="group" aria-label="기간 고르기">' + RANGES.map(function (r) {
            return '<button class="tab" data-d="range" data-v="' + r.r + '" aria-pressed="' + (r.r === st.range) + '">' + r.name + '</button>';
          }).join('') + '</div>';
          var empty = !(st.data.totals && st.data.totals.length)
            ? '<p class="note">아직 기록이 없어요. 놀이터에서 연습하기나 도전하기를 하면 여기에 쌓여요.</p>' : '';
          body = profs + statPills(rows, st.data.totals) + empty + tabs +
            '<div class="card dcard">' + chart(map, keys) + '</div>' + detail(map) + progressCard();
        }
      }
      el.innerHTML = head + '<div class="dash-body">' + body + '</div>' + '<div style="margin-top:1rem">' + back + '</div>';
    }

    el.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button[data-d]') : null;
      if (!t || t.disabled) return;
      e.stopPropagation();   /* 앱의 공용 클릭 처리로 넘어가지 않게 */
      var act = t.dataset.d, v = t.dataset.v;
      if (act === 'back') { seq++; host.back(st.from); }
      else if (act === 'retry') { if (st.pid) load(); else open(st.from); }
      else if (act === 'prof') { if (v !== st.pid) { st.pid = v; load(); } }
      else if (act === 'range') { st.range = v; st.sel = ''; render(); }
      else if (act === 'bucket') {
        st.sel = v; render();
        var again = el.querySelector('.dcol[data-v="' + v + '"]');
        if (again) again.focus({ preventScroll: true });
      }
    });

    return { open: open };
  };
})();
