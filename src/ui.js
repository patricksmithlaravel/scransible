// Shared UI pieces: menus, dialogs, toasts, form controls and the YAML viewer.
(function () {
  const SX = window.Scransible;
  const { el, icon } = SX;
  const ui = SX.ui = {};

  // ---- Menus -------------------------------------------------------------------------

  let openMenu = null;

  ui.closeMenu = () => {
    if (!openMenu) return;
    openMenu.node.remove();
    document.removeEventListener('pointerdown', openMenu.outside, true);
    document.removeEventListener('keydown', openMenu.keys, true);
    openMenu.anchor?.focus?.({ preventScroll: true });
    openMenu = null;
  };

  // items: [{ label, hint, onClick, danger, current, disabled } | 'sep' | { heading }]
  ui.menu = function menu(anchor, items, { align = 'left' } = {}) {
    ui.closeMenu();
    const node = el('div', { class: 'menu', attrs: { role: 'menu' } }, items.map(item => {
      if (item === 'sep') return el('div', { class: 'menu-sep', attrs: { role: 'separator' } });
      if (item.heading) return el('div', { class: 'menu-label', text: item.heading });
      return el('button', {
        class: `menu-item${item.danger ? ' danger' : ''}${item.current ? ' current' : ''}`,
        type: 'button', disabled: item.disabled, attrs: { role: 'menuitem' },
        onclick: () => { ui.closeMenu(); item.onClick?.(); }
      }, [item.icon ? icon(item.icon, 15) : null, el('span', { text: item.label }), item.hint ? el('span', { class: 'hint', text: item.hint }) : null]);
    }));
    document.body.append(node);
    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let left = align === 'right' ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    const outside = e => { if (!node.contains(e.target) && !anchor.contains(e.target)) ui.closeMenu(); };
    const keys = e => {
      const buttons = [...node.querySelectorAll('.menu-item:not(:disabled)')];
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); ui.closeMenu(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys, true);
    openMenu = { node, outside, keys, anchor };
    node.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
    return node;
  };

  // ---- Dialogs -----------------------------------------------------------------------

  // actions: [{ label, primary, danger, value }]; resolves with the chosen value (or null).
  ui.dialog = function dialog({ title, body = [], actions = [{ label: 'OK', primary: true, value: true }], onOpen }) {
    return new Promise(resolve => {
      const node = el('dialog', { class: 'dialog' });
      let result = null;
      const finish = value => { result = value; node.close(); };
      node.append(
        el('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); const primary = actions.find(a => a.primary); finish(primary ? (typeof primary.value === 'function' ? primary.value() : primary.value) : true); } }, [
          el('div', { class: 'dialog-body' }, [el('h2', { class: 'dialog-title', text: title }), ...[].concat(body)]),
          el('div', { class: 'dialog-actions' }, actions.map(action => el('button', {
            class: `btn btn-md${action.primary ? ' btn-primary' : ''}${action.danger ? ' btn-warn' : ''}`,
            type: action.primary ? 'submit' : 'button', text: action.label,
            onclick: action.primary ? undefined : () => finish(typeof action.value === 'function' ? action.value() : action.value ?? null)
          })))
        ])
      );
      node.addEventListener('close', () => { node.remove(); resolve(result); });
      document.body.append(node);
      node.showModal();
      onOpen?.(node);
    });
  };

  ui.prompt = async function prompt(title, { label, value = '', placeholder = '', hint, mono = true, validate } = {}) {
    const input = el('input', { class: `input${mono ? '' : ' ui'}`, value, placeholder, attrs: { 'aria-label': label || title } });
    const error = el('div', { class: 'field-hint', style: 'color: var(--danger-text)' });
    const body = el('div', { class: 'field' }, [label ? el('label', { class: 'field-label', text: label }) : null, input, hint ? el('div', { class: 'field-hint', text: hint }) : null, error]);
    while (true) {
      const answer = await ui.dialog({
        title, body,
        actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => input.value.trim() }],
        onOpen: () => { input.focus(); input.select(); }
      });
      if (answer === null) return null;
      const problem = validate?.(answer);
      if (!problem) return answer;
      error.textContent = problem;
      input.value = answer;
    }
  };

  ui.confirm = (title, message, { confirmLabel = 'OK', danger = false } = {}) => ui.dialog({
    title, body: el('p', { class: 'empty-note', text: message }),
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, primary: true, danger, value: true }]
  }).then(Boolean);

  // ---- Toasts ------------------------------------------------------------------------

  let toastTimer;
  ui.toast = function toast(message, { action, timeout = 4200 } = {}) {
    document.querySelector('.toast')?.remove();
    clearTimeout(toastTimer);
    const node = el('div', { class: 'toast', attrs: { role: 'status' } }, [
      el('span', { text: message }),
      action ? el('button', { class: 'btn btn-sm', type: 'button', text: action.label, onclick: () => { node.remove(); action.onClick(); } }) : null
    ]);
    document.body.append(node);
    toastTimer = setTimeout(() => node.remove(), timeout);
  };

  // ---- Form controls ----------------------------------------------------------------

  ui.switchEl = (checked, onChange, labelledBy) => el('button', {
    class: 'switch', type: 'button', attrs: { role: 'switch', 'aria-checked': String(!!checked), 'aria-labelledby': labelledBy },
    onclick: e => { const next = e.currentTarget.getAttribute('aria-checked') !== 'true'; e.currentTarget.setAttribute('aria-checked', String(next)); onChange(next); }
  });

  // options: [[value, label]]
  ui.seg = (options, value, onChange, { cls = '', label } = {}) => el('div', { class: `seg ${cls}`, attrs: { role: 'group', 'aria-label': label } },
    options.map(([v, text]) => el('button', { type: 'button', text, attrs: { 'aria-pressed': String(v === value) }, onclick: () => onChange(v) })));

  // options: [[value, label]] or [{ group, options }]
  ui.select = (options, value, onChange, { cls = 'select', label, id } = {}) => {
    const make = ([v, text]) => el('option', { value: v, text, selected: String(v) === String(value) });
    return el('select', { class: cls, id, attrs: { 'aria-label': label }, onchange: e => onChange(e.target.value) },
      options.map(o => Array.isArray(o) ? make(o) : el('optgroup', { label: o.group }, o.options.map(make))));
  };

  let fieldSeq = 0;
  ui.fieldId = () => `f${++fieldSeq}`;

  ui.field = (label, control, { mono = false, required = false, hint } = {}) => {
    control.id = control.id || ui.fieldId();
    return el('div', { class: 'field' }, [
      el('label', { class: `field-label${mono ? ' mono' : ''}`, htmlFor: control.id }, [label, required ? el('span', { class: 'req', text: ' *' }) : null]),
      control,
      hint ? el('div', { class: 'field-hint', text: hint }) : null
    ]);
  };

  // Editable key/value rows for var nodes ({ id, key, value }). Values are text unless
  // they are nested data, which is edited as YAML.
  ui.varRows = function varRows(vars, { onEdit, onRemove, onAdd, addLabel = '+ Add variable', keyPrefix }) {
    const rows = vars.map(v => {
      const valueText = typeof v.value === 'object' && v.value !== null ? JSON.stringify(v.value) : String(v.value ?? '');
      const key = el('input', { class: 'input key', value: v.key, placeholder: 'name', attrs: { 'aria-label': 'Variable name' }, oninput: e => onEdit(v.id, { key: e.target.value }, `${keyPrefix}:${v.id}:k`) });
      const val = el('input', { class: 'input val', value: valueText, placeholder: 'value', attrs: { 'aria-label': `Value of ${v.key}` }, oninput: e => onEdit(v.id, { value: e.target.value }, `${keyPrefix}:${v.id}:v`) });
      return [key, val, el('button', { class: 'icon-btn sm', type: 'button', title: `Remove ${v.key}`, attrs: { 'aria-label': `Remove ${v.key}` }, onclick: () => onRemove(v.id) }, icon('x', 12))];
    });
    return el('div', { class: 'field' }, [
      rows.length ? el('div', { class: 'kv' }, rows.flat()) : null,
      el('button', { class: 'dashed-btn', type: 'button', text: addLabel, onclick: onAdd })
    ]);
  };

  // ---- YAML viewer --------------------------------------------------------------------

  // decorate(lineNumber) -> { gut, bg (category color for a highlighted range), mark, title }
  ui.codeView = function codeView(text, { decorate, onLineClick, compact = false, cls = '' } = {}) {
    const lines = text.replace(/\n$/, '').split('\n');
    return el('div', { class: `code${compact ? ' compact' : ''} ${cls}` }, lines.map((line, i) => {
      const n = i + 1;
      const d = decorate?.(n) || {};
      const row = el('div', {
        class: `code-line${d.bg ? ' in-range' : ''}${onLineClick ? ' clickable' : ''}`,
        style: `${d.bg ? `--c: ${d.bg};` : ''}${d.gut ? `--gut: ${d.gut};` : ''}`,
        title: d.title, onclick: onLineClick ? () => onLineClick(n) : undefined
      }, [
        el('span', { class: 'code-gutter' }),
        el('span', { class: 'code-num', text: String(n) }),
        el('code', { class: 'code-text' }, SX.Ansible.highlightLine(line).map(([t, c]) => el('span', { style: `color: ${c}`, text: t }))),
        compact ? null : el('span', { class: 'code-mark', text: d.mark || '' })
      ]);
      row.dataset.line = n;
      return row;
    }));
  };

  // ---- Files ----------------------------------------------------------------------------

  ui.download = (blob, filename) => {
    const link = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  // Clipboard API first; a temporary selection for browsers that refuse it.
  ui.copy = async text => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const area = el('textarea', { value: text, readOnly: true, style: 'position:fixed;top:0;left:0;opacity:0;' });
      document.body.append(area);
      area.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (execError) {
        copied = false;
      }
      area.remove();
      return copied;
    }
  };

  ui.pickFiles = ({ accept = '', multiple = true, directory = false } = {}) => new Promise(resolve => {
    const input = el('input', { type: 'file', accept, multiple, style: 'display:none' });
    if (directory) input.webkitdirectory = true;
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
})();
