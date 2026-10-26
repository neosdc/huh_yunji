/* 파닉스 놀이터
   index.html 의 놀이터 탭 중 하나로 붙는 모듈입니다. 로그인·프로필·저장은 앱이 맡고, 이 파일은 게임과 출제만 맡습니다.
   앱이 createPhonics(host) 로 불러 쓰며, 진행 상황은 앱의 store.ph 에 두어 profile_state 로 함께 저장됩니다.
   문제 콘텐츠는 phonics/data/*.json, 음원은 phonics/audio/ 에 있습니다. */
(function () {
  'use strict';

  var CFG = {
    base: 'phonics/',
    dataBase: 'phonics/data/',
    questionsPerRound: 10,   /* 한 판 문제 수 */
    sightQuestions: 6,       /* 사이트 워드 게임은 짧게 */
    reviewRatio: 0.3,        /* 이전 단계 항목 비율 */
    masteryStreak: 3,        /* 연속 3회 정답 = 숙달 */
    masteredWeight: 0.3,     /* 숙달 항목은 출제 빈도를 낮춤 */
    retryGap: 3,             /* 오답은 N문제 뒤에 다시 출제 */
    extraTiles: 3,           /* 단어 만들기: 단어에 쓰이는 글자 외에 섞는 타일 수 */
    optionCount: 3,          /* 보기 개수 */
    minSightPool: 3,         /* 사이트 워드 게임이 열리는 최소 누적 단어 수 */
    hue: 7
  };
  var GAME_META = {
    A: { name: '소리 듣고 고르기', desc: '들려주는 소리에 맞는 글자를 찾아요', icon: '🔊', hue: 7, prefix: 'p:' },
    B: { name: '단어 만들기',     desc: '단어를 듣고 글자 타일로 만들어요',   icon: '🧩', hue: 8, prefix: 'w:' },
    C: { name: '소리 합치기',     desc: '소리를 이어 듣고 단어를 찾아요',     icon: '🔗', hue: 5, prefix: 'c:' },
    D: { name: '사이트 워드',     desc: '소리 내어 읽는 단어를 찾아요',       icon: '👀', hue: 3, prefix: 's:' }
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function randOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function byId(id) { return document.getElementById(id); }

  window.createPhonics = function (host) {
    var esc = host.esc;

    /* ---------- 콘텐츠 데이터 ---------- */
    var STAGES = [];
    var SND = {};        /* 소리 id → {id, ipa, audio, hint, stage, graphemes[]} */
    var LET = {};        /* 글자 → 소리 id (c, k 처럼 여러 글자가 한 소리일 수 있다) */
    var LETSTAGE = {};   /* 글자 → 도입 단계 */
    var WORDS = {};      /* 단어 → {word, tiles[], audio, emoji, stage} */
    var SIGHT = {};      /* 사이트 워드 → {word, audio, hint, stage} */
    var loadP = null, loaded = false;

    function fetchJson(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(url + ' (' + r.status + ')');
        return r.json();
      });
    }
    function load() {
      if (loadP) return loadP;
      loadP = fetchJson(CFG.dataBase + 'stages.json').then(function (idx) {
        return Promise.all(idx.stages.map(function (f) { return fetchJson(CFG.dataBase + f); }));
      }).then(function (files) {
        STAGES = files.sort(function (a, b) { return a.stage - b.stage; });
        loaded = true;
        return indexAndValidate();
      });
      loadP.catch(function () { loadP = null; });   /* 실패하면 다음에 다시 시도 */
      return loadP;
    }
    /* 색인을 만들면서 데이터 오류를 모은다. 오류가 있으면 게임 대신 목록을 보여 준다. */
    function indexAndValidate() {
      var errs = [];
      STAGES.forEach(function (st) {
        var n = st.stage;
        (st.sounds || []).forEach(function (s) {
          if (SND[s.id]) errs.push('소리 id 중복: ' + s.id + ' (' + n + '단계)');
          if (!s.audio) errs.push('소리 ' + s.id + ': audio 경로가 없습니다');
          SND[s.id] = Object.assign({}, s, { stage: n, graphemes: [] });
        });
        (st.letters || []).forEach(function (l) {
          if (LET[l.g]) errs.push('글자 중복: ' + l.g + ' (' + n + '단계)');
          if (!SND[l.sound]) errs.push('글자 ' + l.g + ': 알 수 없는 소리 ' + l.sound);
          else SND[l.sound].graphemes.push(l.g);
          LET[l.g] = l.sound; LETSTAGE[l.g] = n;
        });
        (st.words || []).forEach(function (w) {
          if (WORDS[w.word]) errs.push('단어 중복: ' + w.word + ' (' + n + '단계)');
          if ((w.tiles || []).join('') !== w.word) errs.push('단어 ' + w.word + ': tiles 를 이으면 철자와 같아야 합니다');
          (w.tiles || []).forEach(function (t) {
            if (!(t in LET)) errs.push('단어 ' + w.word + ': 글자 ' + t + ' 가 letters 에 없습니다');
            else if (LETSTAGE[t] > n) errs.push('단어 ' + w.word + ': 글자 ' + t + ' 는 아직 배우지 않았습니다 (' + LETSTAGE[t] + '단계)');
          });
          WORDS[w.word] = Object.assign({}, w, { stage: n });
        });
        (st.sightWords || []).forEach(function (s) {
          if (SIGHT[s.word]) errs.push('사이트 워드 중복: ' + s.word);
          SIGHT[s.word] = Object.assign({}, s, { stage: n });
        });
      });
      return errs;
    }
    function values(map) { return Object.keys(map).map(function (k) { return map[k]; }); }
    function upto(n, map) { return values(map).filter(function (x) { return x.stage <= n; }); }
    function stageOf(n) { return STAGES.filter(function (s) { return s.stage === n; })[0]; }
    function soundOfLetter(g) { return SND[LET[g]]; }
    function soundLabel(id) { return SND[id].graphemes.join(' · '); }

    /* ---------- 진행 상태 (앱의 store.ph, 프로필별로 서버에 저장됨) ----------
       items: "p:m"(소리) "w:sat"(단어 만들기) "c:sat"(소리 합치기) "s:the"(사이트 워드) → [연속 정답, 틀린 횟수]
       stars: "2:C" → 최고 별 개수 */
    function P() {
      var s = host.getStore();
      var p = s.ph;
      if (!p || typeof p !== 'object') p = s.ph = {};
      if (!p.items || typeof p.items !== 'object') p.items = {};
      if (!p.stars || typeof p.stars !== 'object') p.stars = {};
      p.unlockAll = p.unlockAll === true;
      return p;
    }
    function stat(key) {
      var it = P().items[key];
      if (!Array.isArray(it)) it = P().items[key] = [0, 0];
      return it;
    }
    function streakOf(key) { var it = P().items[key]; return Array.isArray(it) ? it[0] : 0; }
    function missOf(key) { var it = P().items[key]; return Array.isArray(it) ? it[1] : 0; }
    function isMastered(key) { return streakOf(key) >= CFG.masteryStreak; }
    function record(key, ok) {
      var it = stat(key);
      if (ok) it[0]++; else { it[0] = 0; it[1]++; }
      host.save();
    }
    function starsOf(n, kind) { return P().stars[n + ':' + kind] || 0; }
    function cleared(n) {
      var st = stageOf(n);
      return !!st && (st.mainGames || ['A']).every(function (k) { return starsOf(n, k) > 0; });
    }
    function unlocked(n) {
      if (P().unlockAll) return true;
      var i = -1;
      STAGES.forEach(function (s, idx) { if (s.stage === n) i = idx; });
      return i <= 0 || cleared(STAGES[i - 1].stage);
    }

    /* ---------- 오디오: 파일 우선 → 실패하면 TTS, 효과음은 앱의 tone ----------
       소리 켜기/끄기 버튼은 효과음에만 적용된다. 파닉스 소리는 학습 내용이라 항상 재생한다. */
    var seq = 0, curAudio = null, usedFallback = false, unlockedAudio = false, actx = null;
    var missing = {};     /* 로드 실패한 파일 경로 (다시 시도하지 않음) */
    var voices = [];
    if ('speechSynthesis' in window) {
      var loadVoices = function () { voices = speechSynthesis.getVoices(); };
      loadVoices(); speechSynthesis.onvoiceschanged = loadVoices;
    }
    function stopAudio() {
      seq++;
      if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
      if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
    }
    /* iOS Safari 등의 자동재생 제한: 첫 사용자 터치에서 오디오를 한 번 활성화한다. */
    function unlockAudio() {
      if (unlockedAudio) return;
      unlockedAudio = true;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
      } catch (e) {}
      try {
        if ('speechSynthesis' in window) { var u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
      } catch (e) {}
    }
    document.addEventListener('pointerdown', unlockAudio, { once: true });

    function playFile(src) {
      return new Promise(function (res) {
        var a = new Audio(src);
        curAudio = a;
        var done = false;
        function fin(v) { if (!done) { done = true; res(v); } }
        a.onended = function () { fin('ok'); };
        a.onerror = function () { fin('fail'); };
        a.onpause = function () { fin('stopped'); };
        var pr = a.play();
        if (pr && pr.catch) pr.catch(function (err) { fin(err && err.name === 'NotAllowedError' ? 'blocked' : 'fail'); });
      });
    }
    function tts(text, rate) {
      return new Promise(function (res) {
        if (!('speechSynthesis' in window)) return res();
        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US'; u.rate = rate;
        var v = voices.filter(function (x) { return /en[-_]US/i.test(x.lang); })[0] || voices.filter(function (x) { return /^en/i.test(x.lang); })[0];
        if (v) u.voice = v;
        var done = false;
        function fin() { if (!done) { done = true; res(); } }
        u.onend = fin; u.onerror = fin;
        setTimeout(fin, 3500);
        speechSynthesis.speak(u);
      });
    }
    /* 오디오 재생은 이 함수 한 곳으로 모았다. 파일이 없을 때만 브라우저 음성으로 임시 대체한다.
       주의: speechSynthesis 는 단독 음소(/b/ 등)를 정확히 발음하지 못한다. 학습용으로는 녹음 파일이 있어야 한다.
       kind: "sound" | "word" | "sight". 단어는 철자 그대로 읽고, 소리와 사이트 워드는 hint 로 읽는다. */
    function sayItem(item, kind) {
      var t = seq, src = CFG.base + item.audio;
      var first = missing[src] ? Promise.resolve('fail') : playFile(src);
      return first.then(function (r) {
        if (r === 'ok' || r === 'stopped') return;
        if (r === 'fail') missing[src] = true;   /* 파일이 없을 때만 기록 (재생 차단은 제외) */
        if (t !== seq) return;
        usedFallback = true;
        updateNote();
        return tts(kind === 'word' ? item.word : (item.hint || item.word), kind === 'sound' ? 0.6 : 0.75);
      });
    }
    function updateNote() {
      var f = byId('phNote');
      if (!f) return;
      f.textContent = usedFallback ? '음원 파일을 찾지 못해 브라우저 음성으로 임시 재생 중이에요. 자음 소리는 부정확할 수 있어요.' : '';
    }
    function sfxOk() { host.tone([660, 880], 0.13); }
    function sfxNo() { host.tone([300, 260], 0.16, 'triangle', 0.08); }   /* 부드러운 낮은 소리, 큰 실패 연출 없음 */

    /* ---------- 출제: 새 항목 70% + 이전 단계 복습 30% ---------- */
    function weightOf(key) {
      var it = P().items[key];
      if (!Array.isArray(it)) return 1;
      if (it[0] >= CFG.masteryStreak) return CFG.masteredWeight;
      return it[1] > 0 ? 2 : 1;     /* 틀린 적 있는 항목은 더 자주 */
    }
    function pickWeighted(items, keyFn) {
      var ws = items.map(function (x) { return weightOf(keyFn(x)); });
      var r = Math.random() * ws.reduce(function (a, b) { return a + b; }, 0);
      for (var i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
      return items[items.length - 1];
    }
    function poolsFor(stage, kind) {
      var all = kind === 'A' ? values(SND) : kind === 'D' ? values(SIGHT) : values(WORDS);
      var key = function (x) { return kind === 'A' ? x.id : x.word; };
      return {
        fresh: all.filter(function (x) { return x.stage === stage; }).map(key),
        review: all.filter(function (x) { return x.stage < stage; }).map(key)
      };
    }
    function sightPoolSize(stage) { return upto(stage, SIGHT).length; }
    function drawFrom(pool, count, prefix) {
      var out = [], avail = pool.slice();
      while (out.length < count && pool.length) {
        if (!avail.length) avail = pool.slice();      /* 풀이 작으면 다시 채워 반복 출제 */
        var pick = pickWeighted(avail, function (x) { return prefix + x; });
        out.push(pick);
        avail = avail.filter(function (x) { return x !== pick; });
      }
      return out;
    }
    function buildQueue(stage, kind) {
      var N = kind === 'D' ? CFG.sightQuestions : CFG.questionsPerRound;
      var prefix = GAME_META[kind].prefix;
      var pools = poolsFor(stage, kind);
      var nRev = pools.review.length ? Math.round(N * CFG.reviewRatio) : 0;
      if (!pools.fresh.length) nRev = N;
      var keys = drawFrom(pools.fresh, N - nRev, prefix).concat(drawFrom(pools.review, nRev, prefix));
      var q = shuffle(keys), tries = 0;
      var adjacent = function (a) { return a.some(function (x, i) { return i && x === a[i - 1]; }); };
      while (adjacent(q) && tries++ < 100) q = shuffle(keys);   /* 같은 항목이 연달아 나오지 않게 (풀이 작아 불가능하면 포기) */
      return q.map(function (key) { return { key: key, retry: false }; });
    }

    /* ---------- 화면 틀 ---------- */
    var G = null;
    function body() { return byId('phBody'); }
    function alive(g) { return G === g; }
    function headerHtml(title, backAct, backLabel, withBar) {
      return '<header class="top">' +
        (backAct ? '<button class="btn small" data-ph="' + backAct + '">' + backLabel + '</button>' : '<span></span>') +
        '<h2 class="title">' + esc(title) + '</h2>' + host.sndBtn() + '</header>' +
        (withBar ? '<div class="ph-prog"><div class="prog" role="progressbar" aria-label="진행"><i id="phBar" style="width:0"></i></div><span class="ph-count" id="phCount"></span></div>' : '');
    }
    function frame(title, backAct, backLabel, withBar) {
      host.show('ph');
      byId('ph').innerHTML = headerHtml(title, backAct, backLabel, withBar) + '<div id="phBody"></div><p class="note" id="phNote" aria-live="polite"></p>';
      updateNote();
    }
    function showProblem(el, lines, retry) {
      el.innerHTML = '<div class="card ph-err"><h3>앗!</h3>' + lines.map(function (l) { return '<p>• ' + esc(l) + '</p>'; }).join('') +
        (retry ? '<button class="btn wide" data-ph="retry">다시 시도</button>' : '<p class="note">phonics/data/*.json 을 고쳐 주세요.</p>') + '</div>';
    }

    /* ---------- 게임 공통 ---------- */
    function startGame(stage, kind) {
      stopAudio();
      var queue = buildQueue(stage, kind);
      G = { stage: stage, kind: kind, queue: queue, i: 0, initial: queue.length, firstTryOk: 0, missed: [], locked: false, fill: [], on: {} };
      host.setHue(GAME_META[kind].hue);
      frame(GAME_META[kind].name, 'quit', '← 그만하기', true);
      renderQuestion();
    }
    function updateProgress() {
      var c = byId('phCount'), b = byId('phBar');
      if (c) c.textContent = Math.min(G.i + 1, G.queue.length) + ' / ' + G.queue.length;
      if (b) b.style.width = (G.i / G.queue.length * 100) + '%';
    }
    function requeue(entry) {
      var at = Math.min(G.i + CFG.retryGap, G.queue.length);
      G.queue.splice(at, 0, { key: entry.key, retry: true });
    }
    function hit(entry) {
      record(GAME_META[G.kind].prefix + entry.key, true);
      if (!entry.retry) G.firstTryOk++;
    }
    function miss(entry) {
      record(GAME_META[G.kind].prefix + entry.key, false);
      if (!entry.retry) G.missed.push(entry.key);
      requeue(entry);
      updateProgress();
    }
    function nextQuestion(g) {
      if (!alive(g)) return;
      G.i++;
      G.locked = false;
      if (G.i >= G.queue.length) return showResult();
      renderQuestion();
    }
    function renderQuestion() {
      updateProgress();
      G.on = {};
      ({ A: renderA, B: renderB, C: renderC, D: renderD })[G.kind]();
    }
    function msg(text) { var m = byId('phMsg'); if (m) m.textContent = text; }
    function cards(sel) { return body().querySelectorAll(sel); }

    /* ---------- 게임 A: 소리 듣고 글자 고르기 ----------
       보기는 소리 기준으로 만든다. c 와 k 처럼 같은 소리를 내는 글자는 한 보기에 함께 나오지 않는다. */
    function renderA() {
      var g = G, entry = g.queue[g.i], target = SND[entry.key];
      var others = shuffle(upto(g.stage, SND).map(function (s) { return s.id; }).filter(function (x) { return x !== target.id; })).slice(0, CFG.optionCount - 1);
      var opts = shuffle([target.id].concat(others)).map(function (id) { return { id: id, g: randOf(SND[id].graphemes) }; });
      body().innerHTML =
        '<p class="ph-prompt">소리를 듣고 알맞은 글자를 골라요</p>' +
        '<button class="ph-speaker" data-ph="spk" aria-label="소리 듣기">🔊</button>' +
        '<div class="ph-options">' + opts.map(function (o) {
          return '<button class="ph-card letter ph-en" data-ph="pick" data-phv="' + esc(o.id) + '">' + esc(o.g) + '</button>';
        }).join('') + '</div><div class="ph-msg" id="phMsg" aria-live="polite"></div>';
      var spk = body().querySelector('.ph-speaker');
      var play = function () {
        stopAudio();
        spk.classList.add('playing');
        return sayItem(target, 'sound').then(function () { spk.classList.remove('playing'); });
      };
      g.on.spk = play;
      g.on.pick = function (btn) { answerA(g, btn, entry); };
      setTimeout(function () { if (alive(g) && g.queue[g.i] === entry) play(); }, 350);
    }
    function answerA(g, btn, entry) {
      if (g.locked) return;
      g.locked = true;
      var snd = SND[entry.key];
      stopAudio();
      var flow;
      if (btn.dataset.phv === entry.key) {
        btn.classList.add('ok');
        sfxOk();
        msg('맞아요! ' + snd.ipa);
        hit(entry);
        flow = sleep(250).then(function () { return sayItem(snd, 'sound'); }).then(function () { return sleep(350); });   /* 정답 즉시 소리 재생 */
      } else {
        btn.classList.add('no');
        sfxNo();
        miss(entry);
        cards('.ph-card').forEach(function (b) { if (b.dataset.phv === entry.key) b.classList.add('hint'); });
        msg('이 소리는 ' + soundLabel(entry.key) + ' 예요');
        flow = sleep(500).then(function () {
          if (!alive(g)) return;
          return sayItem(snd, 'sound').then(function () { return sleep(500); });   /* 정답 소리 다시 들려주고 넘어감 */
        });
      }
      flow.then(function () { nextQuestion(g); });
    }

    /* ---------- 게임 B: 단어 만들기 (소리를 듣고 글자 타일로 단어 만들기) ----------
       타일은 단어에 쓰이는 글자 + 섞는 글자 3개. 같은 소리의 다른 철자(c/k)는 섞지 않는다. */
    function pickTiles(w, stage) {
      var need = w.tiles.filter(function (x, i, a) { return a.indexOf(x) === i; });
      var needSounds = {};
      need.forEach(function (g) { needSounds[LET[g]] = true; });
      var pool = Object.keys(LET).filter(function (g) { return LETSTAGE[g] <= stage && need.indexOf(g) < 0 && !needSounds[LET[g]]; });
      var extra = [], used = Object.assign({}, needSounds);
      shuffle(pool).forEach(function (g) {                   /* 섞는 글자끼리도 같은 소리(c/k)가 겹치지 않게 */
        if (extra.length >= CFG.extraTiles) return;
        if (!used[LET[g]]) { used[LET[g]] = true; extra.push(g); }
      });
      return shuffle(need.concat(extra));
    }
    function renderB() {
      var g = G, entry = g.queue[g.i], w = WORDS[entry.key];
      g.fill = [];
      body().innerHTML =
        '<p class="ph-prompt">단어를 듣고 글자 타일로 만들어요</p>' +
        '<div class="ph-pic' + (w.emoji ? '' : ' none') + '">' + (w.emoji || '🔊') + '</div>' +
        '<div class="ph-listen"><button class="ph-pill" data-ph="hear">🔊 단어 듣기</button><button class="ph-pill alt" data-ph="undo">↩ 지우기</button></div>' +
        '<div class="ph-slots">' + w.tiles.map(function (_, i) { return '<button class="ph-slot ph-en" data-ph="slot" data-phv="' + i + '" aria-label="' + (i + 1) + '번째 칸"></button>'; }).join('') + '</div>' +
        '<div class="ph-tiles">' + pickTiles(w, g.stage).map(function (l) { return '<button class="ph-tile ph-en" data-ph="tile" data-phv="' + esc(l) + '">' + esc(l) + '</button>'; }).join('') + '</div>' +
        '<div class="ph-wordshow ph-en" id="phWord"></div><div class="ph-msg" id="phMsg" aria-live="polite"></div>';
      g.on.hear = function () { stopAudio(); sayItem(w, 'word'); };
      g.on.undo = function () { if (!g.locked) { g.fill.pop(); drawSlots(); } };
      g.on.slot = function (s) {                 /* 채워진 칸을 누르면 그 칸부터 지움 */
        if (g.locked) return;
        var i = +s.dataset.phv;
        if (i < g.fill.length) { g.fill.length = i; drawSlots(); }
      };
      g.on.tile = function (t) { tapTile(g, t.dataset.phv, entry, w); };
      setTimeout(function () { if (alive(g) && g.queue[g.i] === entry) { stopAudio(); sayItem(w, 'word'); } }, 350);
    }
    function drawSlots() {
      cards('.ph-slot').forEach(function (s, i) {
        var l = G.fill[i];
        s.textContent = l || '';
        s.classList.toggle('filled', !!l);
        s.classList.remove('ok', 'no', 'lit');
      });
    }
    function tapTile(g, letter, entry, w) {
      if (g.locked || g.fill.length >= w.tiles.length) return;
      g.fill.push(letter);
      drawSlots();
      stopAudio();
      var t = seq;
      var sayP = sayItem(soundOfLetter(letter), 'sound');       /* 글자 이름이 아니라 그 글자의 소리 */
      if (g.fill.length === w.tiles.length) {
        g.locked = true;
        sayP.then(function () {
          if (t !== seq || !alive(g)) return;
          return sleep(250).then(function () { return checkB(g, entry, w); });
        });
      }
    }
    /* 소리를 하나씩 들려주며 칸/점을 밝힌다. 중간에 stopAudio() 되면 false */
    function blendSounds(w) {
      var t = ++seq;
      var marks = [].slice.call(body().querySelectorAll('.ph-slot, .ph-dots i'));
      var i = 0;
      function step() {
        if (i >= w.tiles.length) {
          marks.forEach(function (m) { m.classList.remove('lit'); });
          return Promise.resolve(t === seq);
        }
        marks.forEach(function (m, j) { m.classList.toggle('lit', j === i); });
        return sayItem(soundOfLetter(w.tiles[i]), 'sound').then(function () {
          if (t !== seq) return false;
          return sleep(200).then(function () { i++; return step(); });
        });
      }
      return step();
    }
    function blendWord(w) {
      return blendSounds(w).then(function (ok) {
        if (!ok) return false;
        var t = seq;
        return sleep(150).then(function () {
          if (t !== seq) return false;
          return sayItem(w, 'word').then(function () { return t === seq; });
        });
      });
    }
    function checkB(g, entry, w) {
      var ok = g.fill.join('') === w.word;
      var slots = [].slice.call(cards('.ph-slot'));
      var flow;
      if (ok) {
        slots.forEach(function (s) { s.classList.add('ok'); });
        sfxOk();
        byId('phWord').textContent = w.word;
        msg('잘 만들었어요!');
        hit(entry);
        flow = sleep(300).then(function () {
          if (!alive(g)) return;
          stopAudio();
          return blendWord(w).then(function () { return sleep(500); });
        });
      } else {
        slots.forEach(function (s) { s.classList.add('no'); });
        sfxNo();
        miss(entry);
        flow = sleep(600).then(function () {
          if (!alive(g)) return;
          g.fill = w.tiles.slice();                     /* 정답을 채워서 보여주고 소리를 하나씩 들려줌 */
          drawSlots();
          slots.forEach(function (s) { s.classList.add('ok'); });
          byId('phWord').textContent = w.word;
          msg('이렇게 만들어요');
          stopAudio();
          return blendWord(w).then(function () { return sleep(600); });
        });
      }
      return flow.then(function () { nextQuestion(g); });
    }

    /* ---------- 게임 C: 소리 합치기 (이어서 들려주는 소리를 듣고 단어 카드 고르기) ----------
       오답 보기는 철자가 비슷한 단어(한 글자만 다른 쌍 우선)로 만든다. */
    function similarWords(w, stage) {
      var score = function (x) {
        var m = 0;
        for (var i = 0; i < Math.min(x.tiles.length, w.tiles.length); i++) {
          if (x.tiles[i] === w.tiles[i] || LET[x.tiles[i]] === LET[w.tiles[i]]) m++;
        }
        return m + (x.tiles.length === w.tiles.length ? 0.5 : 0) + Math.random() * 0.4;
      };
      return upto(stage, WORDS).filter(function (x) { return x.word !== w.word; })
        .map(function (x) { return { x: x, s: score(x) }; }).sort(function (a, b) { return b.s - a.s; })
        .slice(0, CFG.optionCount - 1).map(function (o) { return o.x; });
    }
    function renderC() {
      var g = G, entry = g.queue[g.i], w = WORDS[entry.key];
      var opts = shuffle([w].concat(similarWords(w, g.stage)));
      body().innerHTML =
        '<p class="ph-prompt">소리를 이어 듣고 단어를 찾아요</p>' +
        '<button class="ph-speaker" data-ph="spk" aria-label="소리 듣기">🔊</button>' +
        '<div class="ph-dots" aria-hidden="true">' + w.tiles.map(function () { return '<i></i>'; }).join('') + '</div>' +
        '<div class="ph-options">' + opts.map(function (o) { return '<button class="ph-card wordcard ph-en" data-ph="pick" data-phv="' + esc(o.word) + '">' + esc(o.word) + '</button>'; }).join('') + '</div>' +
        '<div class="ph-msg" id="phMsg" aria-live="polite"></div>';
      var spk = body().querySelector('.ph-speaker');
      var play = function () {
        stopAudio();
        spk.classList.add('playing');
        return blendSounds(w).then(function () { spk.classList.remove('playing'); });
      };
      g.on.spk = play;
      g.on.pick = function (btn) { answerWordPick(g, btn, entry, WORDS[entry.key], 'word', '이 단어예요', true); };
      setTimeout(function () { if (alive(g) && g.queue[g.i] === entry) play(); }, 350);
    }

    /* ---------- 게임 D: 사이트 워드 고르기 (규칙대로 읽히지 않는 단어를 통째로 익히기) ---------- */
    function renderD() {
      var g = G, entry = g.queue[g.i], w = SIGHT[entry.key];
      var others = shuffle(upto(g.stage, SIGHT).map(function (s) { return s.word; }).filter(function (x) { return x !== w.word; })).slice(0, CFG.optionCount - 1);
      var opts = shuffle([w.word].concat(others));
      body().innerHTML =
        '<p class="ph-prompt">들은 단어를 찾아요</p>' +
        '<button class="ph-speaker" data-ph="spk" aria-label="소리 듣기">🔊</button>' +
        '<div class="ph-options">' + opts.map(function (o) { return '<button class="ph-card wordcard ph-en" data-ph="pick" data-phv="' + esc(o) + '">' + esc(o) + '</button>'; }).join('') + '</div>' +
        '<div class="ph-msg" id="phMsg" aria-live="polite"></div>';
      var spk = body().querySelector('.ph-speaker');
      var play = function () {
        stopAudio();
        spk.classList.add('playing');
        return sayItem(w, 'sight').then(function () { spk.classList.remove('playing'); });
      };
      g.on.spk = play;
      g.on.pick = function (btn) { answerWordPick(g, btn, entry, w, 'sight', '이 단어는 ' + w.word + ' 예요', false); };
      setTimeout(function () { if (alive(g) && g.queue[g.i] === entry) play(); }, 350);
    }
    /* C 와 D 는 단어 카드 고르기라 정답 처리가 같다. blend: 오답일 때 소리를 이어서 다시 들려줄지(C) 그냥 다시 읽어 줄지(D) */
    function answerWordPick(g, btn, entry, w, kind, wrongMsg, blend) {
      if (g.locked) return;
      g.locked = true;
      stopAudio();
      var flow;
      if (btn.dataset.phv === entry.key) {
        btn.classList.add('ok');
        sfxOk();
        msg('맞아요!');
        hit(entry);
        flow = sleep(250).then(function () { return sayItem(w, kind); }).then(function () { return sleep(400); });
      } else {
        btn.classList.add('no');
        sfxNo();
        miss(entry);
        cards('.ph-card').forEach(function (b) { if (b.dataset.phv === entry.key) b.classList.add('hint'); });
        msg(wrongMsg);
        flow = sleep(500).then(function () {
          if (!alive(g)) return;
          var say = blend ? blendWord(w) : sayItem(w, kind);     /* 소리를 다시 이어서 들려주고 단어를 읽어 줌 */
          return say.then(function () { return sleep(500); });
        });
      }
      flow.then(function () { nextQuestion(g); });
    }

    /* ---------- 결과 화면 ---------- */
    function showResult() {
      var g = G;
      stopAudio();
      var n = g.initial, ok = g.firstTryOk, ratio = ok / n;
      var stars = ratio >= 0.9 ? 3 : ratio >= 0.6 ? 2 : 1;        /* 최소 별 1개: 실패 연출 없음 */
      var sk = g.stage + ':' + g.kind, p = P();
      if (stars > (p.stars[sk] || 0)) p.stars[sk] = stars;
      host.save();
      var label = function (k) { return g.kind === 'A' ? soundLabel(k) : k; };
      var uniq = g.missed.filter(function (x, i, a) { return a.indexOf(x) === i; });
      frame(GAME_META[g.kind].name, 'stage', '← ' + g.stage + '단계', false);
      body().innerHTML =
        '<div class="card result">' +
          '<h2>수고했어요!</h2>' +
          '<div class="stars">' + host.starSvg(stars >= 1, 0) + host.starSvg(stars >= 2, 1) + host.starSvg(stars >= 3, 2) + '</div>' +
          '<p>' + n + '문제 중 ' + ok + '문제를 바로 맞혔어요.</p>' +
          (uniq.length ? '<div><h3>다시 연습하면 좋은 것</h3><div class="miss-list">' + uniq.map(function (k) { return '<span class="chip ph-en">' + esc(label(k)) + '</span>'; }).join('') + '</div></div>' : '') +
          '<div class="row"><button class="btn primary" data-ph="again">한 판 더</button><button class="btn" data-ph="stage">' + g.stage + '단계로</button></div>' +
        '</div>';
      host.tone([523, 659, 784, 1047], 0.14);
    }

    /* ---------- 단계 목록(홈 탭) / 단계 화면 ---------- */
    function totalStars() {
      var s = P().stars;
      return Object.keys(s).reduce(function (a, k) { return a + (+s[k] || 0); }, 0);
    }
    function starRow(n) { return host.starSvg(n >= 1, 0) + host.starSvg(n >= 2, 1) + host.starSvg(n >= 3, 2); }
    function paintHome(el) {
      var p = P();
      el.innerHTML =
        '<div class="stats"><span class="stat">' + host.starSvg(true, 0) + '모은 별 <b>' + totalStars() + '</b></span></div>' +
        '<div class="box"><h3>단계 고르기</h3><p class="sub" style="margin:0;font-size:.9rem">글자 이름이 아니라 글자가 내는 소리를 익혀요.</p><div class="lvls">' +
        STAGES.map(function (st) {
          var open = unlocked(st.stage);
          var best = Object.keys(GAME_META).reduce(function (a, k) { return a + starsOf(st.stage, k); }, 0);
          return '<button class="ph-stage" data-ph="stage" data-phv="' + st.stage + '"' + (open ? '' : ' disabled') + '>' +
            '<span class="lvbadge">' + st.stage + '단계</span>' +
            '<span class="lvtext"><b class="ph-en">' + esc(st.title) + '</b><span>' + (open ? (best ? '모은 별 ' + best + '개' : '추천 게임부터 시작해요') : '앞 단계의 추천 게임을 모두 한 번씩 마치면 열려요') + '</span></span>' +
            (open ? '' : '<span aria-hidden="true">🔒</span>') + '</button>';
        }).join('') + '</div></div>' +
        '<div class="row" style="margin:0"><button class="ph-link" data-ph="unlock-all">' + (p.unlockAll ? '단계 잠금 되돌리기' : '모든 단계 열기') + '</button></div>' +
        '<p class="note">소리 버튼은 효과음만 켜고 꺼요. 파닉스 소리는 학습 내용이라 항상 나와요.</p>';
    }
    function renderHome() {
      var el = byId('phHome');
      if (!el) return;
      if (!loaded) el.innerHTML = '<p class="note">불러오는 중이에요…</p>';
      load().then(function (errs) {
        if (errs.length) showProblem(el, errs, false);
        else paintHome(el);
      }).catch(function (e) {
        showProblem(el, ['데이터를 불러오지 못했어요: ' + e.message], true);
      });
    }
    var currentStage = 1;   /* 지금 보고 있는 단계 (단계 화면에서 게임을 시작할 때 씀) */
    function showStage(n) {
      stopAudio();
      G = null;
      var st = stageOf(n);
      if (!st) return;
      currentStage = n;
      host.setHue(CFG.hue);
      frame(n + '단계', 'home', '← 처음으로', false);
      var main = st.mainGames || ['A'];
      var kinds = main.concat(Object.keys(GAME_META).filter(function (k) { return main.indexOf(k) < 0; }));
      var sightOk = sightPoolSize(n) >= CFG.minSightPool;
      var chip = function (key, text) {
        var s = streakOf(key), done = s >= CFG.masteryStreak;
        return '<div class="ph-chip' + (done ? ' done' : '') + '"><span class="ph-en">' + esc(text) + '</span><small>' + (done ? '숙달 ✓' : s + '/' + CFG.masteryStreak) + '</small></div>';
      };
      var words = values(WORDS).filter(function (w) { return w.stage === n; });
      var wordsMastered = words.filter(function (w) { return isMastered('w:' + w.word); }).length;
      var sights = values(SIGHT).filter(function (w) { return w.stage === n; });
      body().innerHTML =
        '<div class="panel-head" style="margin-bottom:.8rem"><h2 class="ph-en">' + n + '단계 · ' + esc(st.title) + '</h2></div>' +
        '<div class="ph-modes">' + kinds.map(function (k) {
          var m = GAME_META[k], off = k === 'D' && !sightOk;
          return '<button class="ph-mode" style="--c:var(--d' + m.hue + ')" data-ph="game" data-phv="' + k + '"' + (off ? ' disabled' : '') + '>' +
            '<span class="ph-ico" aria-hidden="true">' + m.icon + '</span>' +
            '<span class="lvtext"><b>' + m.name + (main.indexOf(k) >= 0 ? ' <span class="ph-tag">추천</span>' : '') + '</b><span>' + (off ? '사이트 워드가 ' + CFG.minSightPool + '개 이상 모이면 열려요' : m.desc) + '</span></span>' +
            (off ? '<span aria-hidden="true">🔒</span>' : '<span class="lvstars" role="img" aria-label="최고 별 ' + starsOf(n, k) + '개">' + starRow(starsOf(n, k)) + '</span>') + '</button>';
        }).join('') + '</div>' +
        '<div class="card box ph-mastery">' +
          '<h3>이번 단계 소리 (3번 연속 정답이면 숙달)</h3>' +
          '<div class="ph-mrow">' + st.sounds.map(function (s) { return chip('p:' + s.id, soundLabel(s.id)); }).join('') + '</div>' +
          '<h3>단어 숙달 ' + wordsMastered + ' / ' + words.length + '</h3>' +
          (sights.length ? '<h3>사이트 워드</h3><div class="ph-mrow">' + sights.map(function (s) { return chip('s:' + s.word, s.word); }).join('') + '</div>' : '') +
        '</div>';
    }

    /* ---------- 눌렀을 때 ---------- */
    function onClick(e) {
      var t = e.target.closest ? e.target.closest('[data-ph]') : null;
      if (!t || t.disabled) return;
      var act = t.dataset.ph, v = t.dataset.phv;
      if (act === 'stage') { if (v) { if (unlocked(+v)) showStage(+v); } else if (G) showStage(G.stage); }
      else if (act === 'game') startGame(currentStage, v);
      else if (act === 'quit') { if (G) showStage(G.stage); }
      else if (act === 'again') { if (G) startGame(G.stage, G.kind); }
      else if (act === 'home') { host.goHome(); }
      else if (act === 'unlock-all') { P().unlockAll = !P().unlockAll; host.save(); renderHome(); }
      else if (act === 'retry') { renderHome(); }
      else if (G && G.on && G.on[act]) G.on[act](t);
    }
    byId('phHome').addEventListener('click', onClick);
    byId('ph').addEventListener('click', onClick);

    return {
      renderHome: renderHome,
      stopAudio: stopAudio,          /* 소리만 멈춘다 (소리 끄기 버튼 등) */
      leave: function () { G = null; stopAudio(); }   /* 파닉스 화면을 떠난다 */
    };
  };
})();
