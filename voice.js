/* voice.js - 천만냥냥 음성 재생 (일반 스크립트, 의존 라이브러리 없음)

   비공개 버킷(protected-assets)의 mp3를 로그인한 사용자의 권한으로 내려받아 재생한다.
   버킷의 읽기 정책이 승인된 사용자(public.is_approved())만 허용하므로, 승인되지 않은 계정은 받을 수 없다.
   파일을 받지 못하거나 브라우저가 자동재생을 막고 있으면 소리 없이 지나간다(게임 진행에는 영향 없음).

   window.createVoice({ supabase, manifest }) -> { unlock, preload, play, playText, findKey, pick, stop, clearCache }
   manifest: manifest.json 내용 { key: { path, text } } */
(function (root) {
  'use strict';

  function createVoice(opts) {
    var supabase = opts.supabase;
    var manifest = opts.manifest || {};
    var bucket = opts.bucket || 'protected-assets';
    var concurrency = opts.concurrency || 4;
    var cacheName = opts.cacheName || 'voice-clips';

    var ctx = null;
    var buffers = {};          /* key -> AudioBuffer */
    var pending = {};          /* key -> 진행 중인 로딩 Promise */
    var failed = {};           /* 이번 세션에서 실패한 key (매번 다시 시도하지 않기 위해) */
    var lastPicked = {};
    var current = null;        /* 재생 중인 AudioBufferSourceNode */
    var byText = {};
    Object.keys(manifest).forEach(function (k) {
      var t = manifest[k].text;
      if (!Object.prototype.hasOwnProperty.call(byText, t)) byText[t] = k;
    });

    function cacheKey(path) { return '/__voice__/' + path; }

    function ensureCtx() {
      if (!ctx) {
        var AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      return ctx;
    }

    /* 모바일 브라우저는 사용자 제스처 안에서 resume해야 소리가 난다. 클릭 핸들러에서 부른다. */
    function unlock() {
      var c = ensureCtx();
      if (!c) return false;
      if (c.state === 'suspended') { try { var p = c.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
      return true;
    }

    function decode(bytes) {   /* 오래된 Safari는 콜백 방식만 지원한다 */
      return new Promise(function (resolve, reject) {
        var p = ctx.decodeAudioData(bytes, resolve, reject);
        if (p && p.catch) p.catch(function () {});
      });
    }

    async function fetchBytes(path) {
      var cache = typeof root.caches !== 'undefined' ? await root.caches.open(cacheName) : null;
      if (cache) {
        var hit = await cache.match(cacheKey(path));
        if (hit) return hit.arrayBuffer();
      }
      var res = await supabase.storage.from(bucket).download(path);
      if (res.error || !res.data) return null;
      if (cache) {
        try { await cache.put(cacheKey(path), new Response(res.data)); } catch (e) { /* 저장 실패는 무시 */ }
      }
      return res.data.arrayBuffer();
    }

    function load(key) {
      if (buffers[key]) return Promise.resolve(buffers[key]);
      var entry = manifest[key];
      if (!entry || failed[key] || !ensureCtx()) return Promise.resolve(null);
      if (!pending[key]) {
        pending[key] = (async function () {
          try {
            var bytes = await fetchBytes(entry.path);
            if (!bytes) throw new Error('download failed');
            var buf = await decode(bytes);
            buffers[key] = buf;
            return buf;
          } catch (e) {
            failed[key] = true;
            return null;
          } finally {
            delete pending[key];
          }
        })();
      }
      return pending[key];
    }

    /* keys를 생략하면 매니페스트 전체를 받는다. 동시에 받는 개수는 concurrency로 제한한다. */
    async function preload(keys) {
      var queue = (keys || Object.keys(manifest)).slice();
      var workers = [];
      var n = Math.min(concurrency, queue.length);
      for (var i = 0; i < n; i++) {
        workers.push((async function () {
          while (queue.length) await load(queue.shift());
        })());
      }
      await Promise.all(workers);
    }

    function stop() {
      var s = current;
      current = null;
      if (s) { try { s.stop(); } catch (e) { /* 이미 끝남 */ } }
    }

    /* 재생이 끝나면 true로 resolve. 재생하지 못했으면(클립 없음, 자동재생 차단) 즉시 false. */
    async function play(key) {
      if (!manifest[key]) return false;
      var buf = await load(key);
      if (!buf || !ctx) return false;
      if (ctx.state !== 'running') {
        /* 사용자 동작 없이 시작된 상태면 resume이 끝나지 않을 수 있어 잠깐만 기다린다 */
        try {
          await Promise.race([ctx.resume(), new Promise(function (r) { setTimeout(r, 150); })]);
        } catch (e) {}
        if (ctx.state !== 'running') return false;   /* 자동재생이 막힘: 나중에 엉뚱하게 터지지 않도록 소리 내지 않는다 */
      }
      stop();   /* 이전 대사가 남아 있으면 끊고 새로 재생 */
      return new Promise(function (resolve) {
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.onended = function () {
          if (current === src) current = null;
          resolve(true);
        };
        current = src;
        src.start();
      });
    }

    function findKey(text) {
      return Object.prototype.hasOwnProperty.call(byText, text) ? byText[text] : null;
    }

    /* 대사 텍스트로 재생. 매니페스트에 없는 문장(이름이 들어간 대사 등)은 false. */
    function playText(text) {
      var key = findKey(text);
      return key ? play(key) : Promise.resolve(false);
    }

    /* prefix로 시작하는 key 중 하나를 무작위로 고른다. 직전에 고른 것은 가능하면 피한다. */
    function pick(prefix) {
      var keys = Object.keys(manifest).filter(function (k) { return k.indexOf(prefix) === 0; });
      if (!keys.length) return null;
      var key;
      do {
        key = keys[Math.floor(Math.random() * keys.length)];
      } while (keys.length > 1 && key === lastPicked[prefix]);
      lastPicked[prefix] = key;
      return key;
    }

    /* 로그아웃 시 호출: 메모리와 디바이스에 저장된 클립을 지운다. */
    async function clearCache() {
      stop();
      buffers = {};
      pending = {};
      failed = {};
      if (typeof root.caches !== 'undefined') {
        try { await root.caches.delete(cacheName); } catch (e) {}
      }
    }

    return { unlock: unlock, preload: preload, play: play, playText: playText, findKey: findKey, pick: pick, stop: stop, clearCache: clearCache };
  }

  root.createVoice = createVoice;
  if (typeof module !== 'undefined' && module.exports) module.exports = createVoice;   /* Node 테스트용 */
})(typeof window !== 'undefined' ? window : globalThis);
