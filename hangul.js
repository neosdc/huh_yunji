/* 한글 놀이터 (유치원 프로필용)
   낱말 그림을 보고, 글자를 눌러 소리로 들으며 한글을 익힙니다. 로그인·프로필·저장은 앱이 맡고, 이 파일은 낱말 카드 화면만 맡습니다.
   앱이 createHangul(host) 로 불러 쓰며, 본 낱말은 앱의 store.hg.seen 에 두어 profile_state 로 함께 저장됩니다. */
(function () {
  'use strict';

  /* 그림은 이모지로 보여 준다. 낱말은 받침 없는 쉬운 것부터 */
  var TOPICS = [
    { id: 'animal', name: '동물', icon: '🐶', words: [
      ['강아지', '🐶'], ['고양이', '🐱'], ['토끼', '🐰'], ['곰', '🐻'], ['돼지', '🐷'], ['닭', '🐔'],
      ['소', '🐮'], ['말', '🐴'], ['호랑이', '🐯'], ['원숭이', '🐵'], ['개구리', '🐸'], ['오리', '🦆'],
      ['나비', '🦋'], ['물고기', '🐟'], ['새', '🐦'] ] },
    { id: 'food', name: '먹을 것', icon: '🍎', words: [
      ['사과', '🍎'], ['바나나', '🍌'], ['포도', '🍇'], ['딸기', '🍓'], ['수박', '🍉'], ['귤', '🍊'],
      ['당근', '🥕'], ['감자', '🥔'], ['빵', '🍞'], ['우유', '🥛'], ['달걀', '🥚'], ['아이스크림', '🍦'] ] },
    { id: 'ride', name: '탈 것', icon: '🚗', words: [
      ['자동차', '🚗'], ['버스', '🚌'], ['기차', '🚆'], ['비행기', '✈️'], ['배', '🚢'], ['자전거', '🚲'] ] },
    { id: 'thing', name: '물건', icon: '📖', words: [
      ['책', '📖'], ['모자', '🎩'], ['신발', '👟'], ['공', '⚽'], ['시계', '⏰'], ['우산', '☂️'],
      ['집', '🏠'], ['의자', '🪑'], ['가방', '🎒'] ] },
    { id: 'nature', name: '자연', icon: '🌳', words: [
      ['해', '☀️'], ['달', '🌙'], ['별', '⭐'], ['구름', '☁️'], ['비', '🌧️'], ['꽃', '🌸'], ['나무', '🌳'], ['눈사람', '⛄'] ] }
  ];

  /* 사진은 hangul/img/<낱말>.jpg (없으면 jpeg, png, webp 순). 하나도 없으면 이모지로 보여 준다 */
  var IMG_DIR = 'hangul/img/', IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
  function imgSrc(word, k) { return IMG_DIR + encodeURIComponent(word.normalize('NFC')) + '.' + IMG_EXTS[k]; }
  /* 사진이 있을 것으로 보고 먼저 <img>를 그린다. 못 불러오면 아래 error 처리가 다음 확장자나 이모지로 바꾼다 */
  function picHtml(word, emoji) {
    return '<img class="hg-img" src="' + imgSrc(word, 0) + '" data-k="0" data-w="' + word + '" data-e="' + emoji + '" alt="">';
  }
  function onImgError(e) {
    var im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.classList.contains('hg-img')) return;
    var k = +im.dataset.k + 1;
    if (k < IMG_EXTS.length) { im.dataset.k = k; im.src = imgSrc(im.dataset.w, k); return; }
    var sp = document.createElement('span');
    sp.className = 'hg-emoji'; sp.setAttribute('aria-hidden', 'true'); sp.textContent = im.dataset.e;
    im.replaceWith(sp);
  }

  function byId(id) { return document.getElementById(id); }
  function isSyl(ch) { var c = ch.charCodeAt(0); return c >= 0xAC00 && c <= 0xD7A3; }

  window.createHangul = function (host) {
    var esc = host.esc;
    var view = { topic: 0, card: -1 };   /* card: 열어 본 낱말 번호(없으면 -1) */

    function store() { var s = host.getStore(); if (!s.hg || typeof s.hg !== 'object') s.hg = {}; if (!s.hg.seen || typeof s.hg.seen !== 'object') s.hg.seen = {}; return s.hg; }
    function total() { return TOPICS.reduce(function (n, t) { return n + t.words.length; }, 0); }
    function seenCount() { var seen = store().seen; return Object.keys(seen).length; }
    function mark(word) {
      var seen = store().seen;
      if (!seen[word]) { seen[word] = 1; host.save(); }
    }

    function topicTabs() {
      return '<div class="hg-topics" role="group" aria-label="낱말 묶음 고르기">' + TOPICS.map(function (t, i) {
        return '<button class="tab" data-hg="topic" data-i="' + i + '" aria-pressed="' + (i === view.topic) + '"><span aria-hidden="true">' + t.icon + '</span> ' + esc(t.name) + '</button>';
      }).join('') + '</div>';
    }

    function renderList() {
      var seen = store().seen, t = TOPICS[view.topic];
      var cards = t.words.map(function (w, i) {
        return '<button class="hg-card' + (seen[w[0]] ? ' seen' : '') + '" data-hg="open" data-i="' + i + '" aria-label="' + esc(w[0]) + '">' +
          '<span class="hg-pic" aria-hidden="true">' + picHtml(w[0], w[1]) + '</span><span class="hg-word">' + esc(w[0]) + '</span></button>';
      }).join('');
      byId('hgHome').innerHTML =
        '<div class="stats"><span class="stat">본 낱말 <b>' + seenCount() + '</b>/' + total() + '</span></div>' +
        topicTabs() +
        '<p class="note">그림을 누르면 낱말을 읽어 줘요.</p>' +
        '<div class="hg-grid">' + cards + '</div>';
    }

    function renderCard(speakIt) {
      var t = TOPICS[view.topic], list = t.words, w = list[view.card];
      var sylls = w[0].split('').map(function (ch) {
        return isSyl(ch) ? '<button class="hg-syl" data-hg="syl" data-s="' + esc(ch) + '" aria-label="' + esc(ch) + ' 듣기">' + esc(ch) + '</button>' : '<span class="hg-syl">' + esc(ch) + '</span>';
      }).join('');
      byId('hgHome').innerHTML =
        '<div class="card hg-big">' +
          '<button class="hg-pic big" data-hg="hear" aria-label="' + esc(w[0]) + ' 듣기">' + picHtml(w[0], w[1]) + '</button>' +
          '<div class="hg-word big" aria-label="' + esc(w[0]) + '">' + sylls + '</div>' +
          '<p class="note">글자를 하나씩 눌러도 읽어 줘요.</p>' +
          '<button class="btn primary wide" data-hg="hear">🔊 다시 듣기</button>' +
        '</div>' +
        '<div class="hg-nav">' +
          '<button class="btn" data-hg="prev"' + (view.card === 0 ? ' disabled' : '') + '>← 이전</button>' +
          '<button class="btn" data-hg="list">목록</button>' +
          '<button class="btn" data-hg="next"' + (view.card === list.length - 1 ? ' disabled' : '') + '>다음 →</button>' +
        '</div>';
      window.scrollTo(0, 0);
      mark(w[0]);
      if (speakIt) host.speak(w[0]);
    }

    function render() { if (view.card >= 0) renderCard(false); else renderList(); }

    function onClick(e) {
      var t = e.target.closest('[data-hg]');
      if (!t || t.disabled) return;
      var act = t.dataset.hg, list = TOPICS[view.topic].words;
      if (act === 'topic') { view.topic = +t.dataset.i; view.card = -1; renderList(); }
      else if (act === 'open') { view.card = +t.dataset.i; renderCard(true); }
      else if (act === 'list') { view.card = -1; host.stop(); renderList(); }
      else if (act === 'prev') { if (view.card > 0) { view.card--; renderCard(true); } }
      else if (act === 'next') { if (view.card < list.length - 1) { view.card++; renderCard(true); } }
      else if (act === 'hear') host.hear(list[view.card][0]);
      else if (act === 'syl') host.hear(t.dataset.s);
    }
    byId('hgHome').addEventListener('click', onClick);
    byId('hgHome').addEventListener('error', onImgError, true);   /* error 는 올라가지 않아서 캡처로 받는다 */

    return {
      /* 홈이 다시 그려질 때마다 부른다. 열어 둔 카드는 목록으로 돌려보낸다 */
      renderHome: function () { view.card = -1; renderList(); },
      render: render
    };
  };
})();
