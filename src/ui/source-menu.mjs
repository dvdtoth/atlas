import { sourceMenuTarget } from './repository-links.mjs';

export function createSourceMenu({ manifest, readDocument }) {
  const menu = document.createElement('div');
  menu.id = 'source-menu';
  menu.tabIndex = -1;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Source actions');
  menu.hidden = true;
  document.body.append(menu);
  let epoch = 0,
    previousFocus;
  function hide() {
    epoch++;
    menu.hidden = true;
  }
  function place(x, y) {
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }
  function label(text) {
    const el = document.createElement('div');
    el.className = 'menu-label';
    el.textContent = text;
    menu.append(el);
  }
  function link(text, url) {
    if (!url) return;
    const el = document.createElement('a');
    el.setAttribute('role', 'menuitem');
    el.textContent = text;
    el.href = url;
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    el.onclick = hide;
    menu.append(el);
  }
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!menu.contains(e.target)) hide();
    },
    true,
  );
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  document.addEventListener('wheel', hide, { passive: true });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
      previousFocus?.focus();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menu.querySelectorAll('a')],
        i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  return {
    hide,
    get visible() {
      return !menu.hidden;
    },
    async show(x, y, address) {
      const version = ++epoch;
      previousFocus = document.activeElement;
      menu.replaceChildren();
      label(address.path);
      label('Resolving source address…');
      menu.hidden = false;
      place(x, y);
      try {
        const target = await sourceMenuTarget(manifest(), address, readDocument);
        if (version !== epoch) return;
        menu.replaceChildren();
        label(address.path + (target.line == null ? '' : ` · line ${target.line + 1}`));
        if (target.url) {
          if (target.line != null) link(`Open line ${target.line + 1} on GitHub ↗`, target.url);
          link('Open file on GitHub ↗', target.fileURL);
          label('Exact snapshot commit · ' + manifest().commit.slice(0, 10));
        } else label('Local snapshot — no verified GitHub commit.');
      } catch (error) {
        if (version !== epoch) return;
        menu.replaceChildren();
        label(address.path);
        label(error.message);
      }
      place(x, y);
      (menu.querySelector('a') || menu).focus();
    },
  };
}
