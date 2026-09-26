/* Inlined into HTML at build time; keep independent of modules and modern APIs. */
(function (window, document) {
  'use strict';

  // Supabase dependencies use globalThis during module evaluation.
  if (typeof window.globalThis === 'undefined') {
    window.globalThis = window;
  }

  var timer;
  var ready = false;
  var fatal = false;
  var retried = false;
  var failure = null;

  function updateView() {
    var root = document.getElementById('root');
    var recovery = document.getElementById('portal-recovery');
    var message = document.getElementById('portal-recovery-message');
    var retry = document.getElementById('portal-retry');
    if (root) root.hidden = !!failure;
    if (recovery) {
      recovery.hidden = !failure;
      // Fixed category only; URL parameters and client identity stay out of diagnostics.
      if (failure) recovery.setAttribute('data-failure', failure);
      else recovery.removeAttribute('data-failure');
    }
    if (message && failure === 'unsupported') {
      message.textContent = 'Este navegador não consegue abrir o portal. Tente abrir esta mesma página em um navegador atualizado, mantendo a conexão com o Wi-Fi.';
    }
    if (retry) retry.hidden = failure === 'unsupported';
  }

  function fail(reason) {
    // A stylesheet can block painting even when a different resource failed.
    // Keep the original cause, but never hide recovery after dropping styles.
    var links = document.getElementsByTagName('link');
    for (var i = links.length - 1; i >= 0; i--) {
      if (links[i].rel === 'stylesheet' && !links[i].sheet) {
        links[i].disabled = true;
        links[i].parentNode.removeChild(links[i]);
        fatal = true;
        if (reason === 'timeout') reason = 'stylesheet';
      }
    }
    if (reason === 'stylesheet' || reason === 'render' || reason === 'unsupported') {
      fatal = true;
    }
    ready = false;
    failure = reason;
    // Keep the single watchdog: a later stylesheet may still block painting.
    updateView();
  }

  function markReady() {
    if (fatal) return;
    ready = true;
    failure = null;
    window.clearTimeout(timer);
    updateView();
  }

  window.__MBPortalBoot = { ready: markReady, fail: fail };

  // A stalled module delays DOMContentLoaded. Bind recovery before that event.
  document.addEventListener('click', function (event) {
    var retry = document.getElementById('portal-retry');
    if (!retry || event.target !== retry || retried) return;
    retried = true;
    retry.disabled = true;
    // Reload the exact URL. Do not clear the attempt or start authorization.
    window.location.reload();
  });
  document.addEventListener('readystatechange', updateView);
  document.addEventListener('DOMContentLoaded', updateView);
  updateView();

  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target.tagName === 'LINK' && target.rel === 'stylesheet') {
      fail('stylesheet');
    } else if (!ready && target && target.tagName === 'SCRIPT') {
      fail('script');
    } else if (!ready && (!target || target === window)) {
      fail('javascript');
    }
  }, true);

  window.addEventListener('unhandledrejection', function () {
    if (!ready) fail('javascript');
  });

  window.addEventListener('vite:preloadError', function () {
    // Keep the error observable, and offer only a user-initiated reload.
    fail('script');
  });

  timer = window.setTimeout(function () {
    if (!ready) fail(failure || 'timeout');
  }, 10000);

  if (!('noModule' in document.createElement('script'))) fail('unsupported');
})(window, document);
