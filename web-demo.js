'use strict';

(() => {
  const element = id => document.getElementById(id);
  const demoLink = element('demo-link');
  const start = element('demo-start');
  const stop = element('demo-stop');
  const poster = element('demo-poster');
  const live = element('demo-live');
  const dialog = element('demo-dialog');
  const mobile = matchMedia('(max-width: 760px)');
  let activeHost;

  const exampleDemo = document.querySelector('.examples-demo a');
  if (exampleDemo) exampleDemo.href = demoLink.href;

  function mountDemo(host) {
    const status = document.createElement('p');
    status.className = 'web-demo-loading';
    status.setAttribute('role', 'status');
    status.textContent = 'Loading the demo…';

    const frame = document.createElement('iframe');
    frame.title = 'Surrogate–Newton CFD demo';
    // Request fresh Demo HTML even when an earlier iframe used the same page URL.
    const embedUrl = new URL(demoLink.href);
    embedUrl.searchParams.set('embed', Date.now().toString(36));
    frame.src = embedUrl.href;
    frame.allow = 'fullscreen';
    frame.addEventListener('load', () => { status.hidden = true; }, { once: true });
    host.append(frame, status);
    activeHost = host;
  }

  function stopDemo() {
    activeHost?.replaceChildren();
    activeHost = null;
    live.hidden = true;
    poster.hidden = false;
    start.focus({ preventScroll: true });
  }

  start.addEventListener('click', () => {
    if (activeHost) return;
    if (mobile.matches && typeof dialog.showModal === 'function') {
      dialog.showModal();
      mountDemo(element('demo-dialog-host'));
    } else {
      poster.hidden = true;
      live.hidden = false;
      mountDemo(element('demo-inline-host'));
      stop.focus({ preventScroll: true });
      live.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  stop.addEventListener('click', stopDemo);
  element('demo-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stopDemo);
})();
