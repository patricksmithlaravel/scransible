// Renders model nodes as blocks: hats for plays, stacks for tasks, C-shapes for
// blocks and play sections, pills for task keywords, slots for values. Used by the
// builder canvas, the palette, the role editor and the import preview.
(function () {
  const SX = window.Scransible;
  const { el, icon } = SX;
  const B = SX.Blocks = {};

  // Which node types each list accepts.
  B.ACCEPT = {
    items: 'play import', vars: 'var', roles: 'role', pre_tasks: 'task block', tasks: 'task block',
    post_tasks: 'task block', handlers: 'task', block: 'task block', rescue: 'task block', always: 'task block'
  };
  const SECTION_LABELS = { vars: 'vars', roles: 'roles', pre_tasks: 'pre_tasks', tasks: 'tasks', post_tasks: 'post_tasks', handlers: 'handlers' };
  const VAR_REF = /^\{\{\s*([A-Za-z_]\w*)\s*\}\}$/;

  B.colorOf = function colorOf(node) {
    if (node.type === 'play' || node.type === 'import') return SX.category('plays').color;
    if (node.type === 'block') return SX.category('control').color;
    if (node.type === 'var') return SX.category('variables').color;
    if (node.type === 'role') return SX.category('roles').color;
    const module = SX.module(node.module);
    return module ? SX.category(module.category).color : null;
  };

  B.categoryOf = function categoryOf(node) {
    if (node.type === 'play' || node.type === 'import') return SX.category('plays');
    if (node.type === 'block') return SX.category('control');
    if (node.type === 'var') return SX.category('variables');
    if (node.type === 'role') return SX.category('roles');
    const module = SX.module(node.module);
    return module ? SX.category(module.category) : SX.category('generic');
  };

  const shortName = moduleName => (moduleName || '').split('.').pop() || 'module';
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

  B.summary = function summary(value) {
    if (Array.isArray(value)) return value.every(v => !isObject(v) && !Array.isArray(v)) ? value.join(', ') : `${value.length} item${value.length === 1 ? '' : 's'}`;
    if (isObject(value)) return `{${Object.keys(value).length} key${Object.keys(value).length === 1 ? '' : 's'}}`;
    return String(value ?? '');
  };

  // ---- Slots --------------------------------------------------------------------------

  function edit(ctx, id, change, typingKey) {
    if (ctx.readOnly || !ctx.edit) return;
    ctx.edit(id, change, typingKey);
  }

  // A text slot. Pure variable references show as a reporter, Jinja as an expression.
  B.textSlot = function textSlot(value, { ctx, onInput, typingKey, missing, cls = '', dropKey, label }) {
    const text = value === undefined || value === null ? '' : String(value);
    const ref = text.match(VAR_REF);
    const kind = cls || (ref ? 'reporter' : text.includes('{{') ? 'expr' : '');
    const classes = `slot ${kind}${text === '' ? ' empty' : ''}${missing ? ' missing' : ''}`;
    if (ctx.readOnly) {
      return el('span', { class: classes, text: ref && kind === 'reporter' ? ref[1] : text, title: text || undefined });
    }
    const makeInput = () => {
      const input = el('input', {
        class: classes.replace(' reporter', text.includes('{{') ? ' expr' : ''), value: text, size: Math.max(1, text.length),
        attrs: { 'aria-label': label, spellcheck: 'false' },
        oninput: e => {
          e.target.size = Math.max(1, e.target.value.length);
          e.target.classList.toggle('empty', e.target.value === '');
          if (!cls) e.target.classList.toggle('expr', e.target.value.includes('{{'));
          onInput(e.target.value);
        },
        onkeydown: e => { if (e.key === 'Enter') e.target.blur(); }
      });
      if (dropKey) input.dataset.slot = dropKey;
      if (typingKey) input.dataset.key = typingKey;
      return input;
    };
    if (ref && kind === 'reporter') {
      const pill = el('span', {
        class: classes, text: ref[1], title: `${text} — click to edit`, attrs: { tabindex: '0', role: 'button', 'aria-label': `${label}: ${text}` },
        onclick: e => { e.stopPropagation(); const input = makeInput(); pill.replaceWith(input); input.focus(); }
      });
      if (dropKey) pill.dataset.slot = dropKey;
      return pill;
    }
    return makeInput();
  };

  function argSlot(node, name, spec, ctx, missing) {
    const value = node.args[name];
    const label = name === '_raw' ? 'free-form value' : name;
    const typingKey = `${node.id}:arg:${name}`;
    const set = next => edit(ctx, node.id, n => {
      if (SX.Ansible.isEmpty(next)) delete n.args[name];
      else n.args[name] = next;
    }, typingKey);
    const kind = spec?.kind;
    if (kind === 'bool') {
      const shown = value === undefined ? !!spec.default : SX.Ansible.typedScalar(value) === true;
      return el('button', {
        class: 'tick', type: 'button', disabled: ctx.readOnly, attrs: { role: 'checkbox', 'aria-checked': String(shown) },
        onclick: e => {
          e.stopPropagation();
          const next = !shown;
          edit(ctx, node.id, n => { if (next === !!spec.default) delete n.args[name]; else n.args[name] = next; });
        }
      }, [el('span', { class: 'box' }, icon('check', 10, 2)), name.replace(/_/g, ' ')]);
    }
    if (kind === 'choice' && (value === undefined || value === '' || spec.choices.includes(String(value)))) {
      if (ctx.readOnly) return el('span', { class: 'slot choice', text: value ?? spec.default ?? '—' });
      const options = [['', spec.default ? `${spec.default} (default)` : '—'], ...spec.choices.map(c => [c, c])];
      return el('select', {
        class: `slot choice${missing ? ' missing' : ''}`, attrs: { 'aria-label': label },
        onchange: e => set(e.target.value), onclick: e => e.stopPropagation()
      }, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(value ?? '') === v })));
    }
    if ((kind === 'list' && typeof value !== 'string') || kind === 'yaml' || Array.isArray(value) || isObject(value)) {
      const isList = kind === 'list' || (Array.isArray(value) && value.every(v => !isObject(v)));
      const text = SX.Ansible.isEmpty(value) ? '' : B.summary(value);
      return el('span', {
        class: `slot ${isList ? 'seq' : 'data'}${text === '' ? ' empty' : ''}${missing ? ' missing' : ''}`, text, title: `Edit ${label} in the inspector`,
        onclick: () => ctx.select?.(node.id, { focus: `arg:${name}` })
      });
    }
    return B.textSlot(value, { ctx, onInput: set, typingKey, missing, dropKey: `${node.id}|${name}`, label });
  }

  function argLabel(name) {
    return name === '_raw' ? null : el('span', { text: name });
  }

  function paramRow(node, module, ctx, missing) {
    const parts = [];
    if (!module) {
      for (const [name, value] of Object.entries(node.args)) parts.push(argLabel(name), argSlot(node, name, null, ctx, false));
      return parts;
    }
    if (module.freeArgs) {
      for (const [name, value] of Object.entries(node.args)) {
        parts.push(el('span', { class: 'slot reporter', text: name }), el('span', { text: '=' }), argSlot(node, name, null, ctx, false));
      }
      return parts;
    }
    // Toggles only show once set, as in the reference; untouched ones live in the inspector.
    const shown = [...new Set([...module.palette, ...missing])].filter(name => SX.argSpec(module, name)?.kind !== 'bool' || node.args[name] !== undefined);
    for (const name of shown) {
      const spec = SX.argSpec(module, name);
      if (spec?.kind !== 'bool') parts.push(argLabel(name));
      parts.push(argSlot(node, name, spec, ctx, missing.includes(name)));
    }
    const extra = Object.keys(node.args).filter(name => !shown.includes(name) && !shown.includes(SX.argSpec(module, name)?.name));
    if (extra.length) parts.push(el('span', { class: 'blk-more', text: `+${extra.length}`, title: extra.join(', ') }));
    return parts;
  }

  // ---- Keyword pills -----------------------------------------------------------------

  B.keywordPill = function keywordPill(node, key, value, ctx) {
    const spec = SX.keywordSpec(key);
    const label = spec.label || key.replace(/_/g, ' ');
    const typingKey = `${node.id}:kw:${key}`;
    const set = next => edit(ctx, node.id, n => { n.kw[key] = next; }, typingKey);
    const parts = [label];
    if (spec.kind === 'cond' && !Array.isArray(value)) {
      parts.push(B.textSlot(value, { ctx, onInput: set, typingKey, cls: 'cond', label }));
    } else if (spec.kind === 'cond') {
      parts.push(el('span', { class: 'slot cond', text: value.join(' and ') }));
    } else if (spec.kind === 'handlers') {
      const handlers = ctx.handlers || [];
      [].concat(value).forEach((target, i) => {
        if (ctx.readOnly) {
          parts.push(el('span', { class: 'slot choice', text: target }));
          return;
        }
        const options = [...new Set([...handlers, target])];
        parts.push(el('select', {
          class: 'slot choice', attrs: { 'aria-label': 'Handler to notify' }, onclick: e => e.stopPropagation(),
          onchange: e => edit(ctx, node.id, n => { const list = [].concat(n.kw.notify); list[i] = e.target.value; n.kw.notify = list; })
        }, options.map(h => el('option', { value: h, text: h, selected: h === target }))));
      });
    } else if (spec.kind === 'list') {
      [].concat(value).forEach(item => parts.push(el('span', { class: 'slot', text: String(item) })));
    } else if (spec.kind === 'bool') {
      const on = SX.Ansible.typedScalar(value) === true;
      parts.push(el('button', {
        class: 'tick', type: 'button', disabled: ctx.readOnly, attrs: { role: 'checkbox', 'aria-checked': String(on), 'aria-label': label },
        onclick: e => { e.stopPropagation(); edit(ctx, node.id, n => { n.kw[key] = !on; }); }
      }, el('span', { class: 'box' }, icon('check', 10, 2))));
    } else if (isObject(value) || Array.isArray(value)) {
      parts.push(el('span', { class: 'slot data', text: B.summary(value), onclick: () => ctx.select?.(node.id, { focus: `kw:${key}` }) }));
    } else {
      parts.push(B.textSlot(value, { ctx, onInput: set, typingKey, cls: spec.kind === 'expr' ? 'expr' : '', label }));
    }
    return el('span', { class: 'kw-pill', data: { kw: key } }, parts);
  };

  function keywordRow(node, ctx, skip = []) {
    const pills = Object.entries(node.kw || {}).filter(([k, v]) => !skip.includes(k) && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => B.keywordPill(node, k, v, ctx));
    return pills.length ? el('div', { class: 'blk-row kws' }, pills) : null;
  }

  function lintBadge(allIssues) {
    // Unnamed tasks are reported in the inspector and on export, not as a badge on every new block.
    const issues = (allIssues || []).filter(i => i.rule !== 'name-missing');
    if (!issues.length) return null;
    const error = issues.some(i => i.severity === 'error');
    return el('span', { class: `lint-badge${error ? ' error' : ''}`, text: '!', title: issues.map(i => i.message).join('\n') });
  }

  function lineBadge(node, ctx) {
    const text = ctx.lineBadge?.(node.id);
    return text ? el('span', { class: 'line-badge', text }) : null;
  }

  function stateClasses(node, ctx) {
    const issues = ctx.issues?.get(node.id) || [];
    const missing = issues.find(i => i.rule === 'missing-required')?.missing || [];
    return {
      issues, missing,
      cls: `${ctx.selectedId === node.id ? ' selected' : ''}${missing.length || issues.some(i => i.rule === 'no-module' || i.rule === 'no-hosts') ? ' missing' : ''}`
    };
  }

  // ---- Items -----------------------------------------------------------------------------

  B.task = function task(node, ctx, { handler = false } = {}) {
    const module = SX.module(node.module);
    const category = module ? SX.category(module.category) : null;
    const { issues, missing, cls } = stateClasses(node, ctx);
    const sub = !module ? null : handler ? notifiedBy(node, ctx) : module.collection !== 'ansible.builtin' ? module.collection : null;
    const block = el('div', {
      class: `blk stack-blk${module ? '' : ' generic'}${cls}`, style: module ? `--c: ${category.color}` : '',
      data: { id: node.id, type: 'task' }
    }, [
      el('div', { class: 'blk-head' }, [
        handler ? icon('bell', 14) : null,
        el('span', { class: 'mod-chip', text: module ? module.short : node.module || 'module', title: node.module }),
        el('span', { class: `blk-title${node.name ? '' : ' placeholder'}`, text: node.name || 'Unnamed task' }),
        sub ? el('span', { class: 'blk-sub', text: sub }) : null
      ]),
      el('div', { class: 'blk-row' }, paramRow(node, module, ctx, missing)),
      keywordRow(node, ctx),
      !module ? el('div', { class: 'blk-note', text: node.module ? 'Generic block — module not in an installed set' : 'Generic block — set the module in the inspector' }) : null,
      lintBadge(issues),
      lineBadge(node, ctx)
    ]);
    if (block.querySelector('.blk-row:not(.kws)')?.childElementCount === 0) block.querySelector('.blk-row:not(.kws)').remove();
    return block;
  };

  function notifiedBy(node, ctx) {
    const count = ctx.notifyCount?.(node) || 0;
    return count ? `← notified by ${count} task${count === 1 ? '' : 's'}` : 'not notified yet';
  }

  B.stack = function stack(list, ownerId, section, ctx, hint = 'Drop blocks here') {
    const node = el('div', {
      class: 'stack', data: { owner: ownerId, section, accept: B.ACCEPT[section] || 'task block', hint }
    }, list.map(child => B.render(child, ctx, { handler: section === 'handlers' })));
    return node;
  };

  function arm(list, ownerId, section, ctx, hint) {
    return el('div', { class: 'c-arm' }, [el('div', { class: 'c-spine' }), B.stack(list, ownerId, section, ctx, hint)]);
  }
  B.arm = arm;

  // A role's task file as a hat with a mouth: ROLE TASKS tasks/main.yml.
  B.roleFile = function roleFile(role, section, ctx) {
    const label = section === 'tasks' ? 'role tasks' : 'handlers';
    const file = `${section}/main.yml`;
    return el('div', { class: 'cblk play-blk role-file', style: `--c: ${SX.category('roles').color}`, data: { roleFile: section } }, [
      el('div', { class: 'blk hat play-hat c-first', style: 'min-width: 360px' }, [
        el('div', { class: 'blk-head', style: 'gap: 10px' }, [el('span', { class: 'play-tag', text: label }), el('span', { class: 'play-title mono', style: 'font: 700 15px/1 var(--font-mono)', text: file })])
      ]),
      arm(role[section], `role:${role.id}`, section, ctx, section === 'tasks' ? 'Drop tasks here' : 'Drop handler tasks here'),
      el('div', { class: 'blk c-foot no-tab' })
    ]);
  };

  function titleField(node, ctx, { placeholder, cls = 'blk-title' }) {
    if (ctx.readOnly) return el('span', { class: `${cls}${node.name ? '' : ' placeholder'}`, text: node.name || placeholder });
    return el('input', {
      class: `title-input ${cls}`, value: node.name, placeholder, size: Math.max(placeholder.length, (node.name || '').length),
      attrs: { 'aria-label': `${node.type} name`, spellcheck: 'false' },
      oninput: e => { e.target.size = Math.max(placeholder.length, e.target.value.length); edit(ctx, node.id, n => { n.name = e.target.value; }, `${node.id}:name`); },
      onkeydown: e => { if (e.key === 'Enter') e.target.blur(); }
    });
  }

  B.block = function block(node, ctx) {
    const { issues, cls } = stateClasses(node, ctx);
    return el('div', { class: `cblk${cls}`, style: `--c: ${SX.category('control').color}`, data: { id: node.id, type: 'block' } }, [
      el('div', { class: 'blk c-head c-first' }, [
        el('span', { class: 'mod-chip', text: 'block' }),
        titleField(node, ctx, { placeholder: 'Unnamed block' }),
        ...Object.entries(node.kw).filter(([, v]) => v !== '' && v != null).map(([k, v]) => B.keywordPill(node, k, v, ctx)),
        lintBadge(issues),
        lineBadge(node, ctx)
      ]),
      arm(node.block, node.id, 'block', ctx),
      el('div', { class: 'blk c-mid', text: 'rescue' }),
      arm(node.rescue, node.id, 'rescue', ctx, 'Runs if a task above fails'),
      el('div', { class: 'blk c-mid', text: 'always' }),
      arm(node.always, node.id, 'always', ctx, 'Runs whatever happens'),
      el('div', { class: 'blk c-foot' })
    ]);
  };

  B.var = function varBlock(node, ctx) {
    const { cls } = stateClasses(node, ctx);
    const value = node.value;
    return el('div', { class: `blk var-blk${cls}`, style: `--c: ${SX.category('variables').color}`, data: { id: node.id, type: 'var' } }, [
      el('span', { class: 'mod-chip', text: 'var' }),
      B.textSlot(node.key, { ctx, label: 'Variable name', typingKey: `${node.id}:key`, onInput: v => edit(ctx, node.id, n => { n.key = v; }, `${node.id}:key`) }),
      el('span', { text: '=' }),
      isObject(value) || Array.isArray(value)
        ? el('span', { class: 'slot data', text: B.summary(value), onclick: () => ctx.select?.(node.id) })
        : B.textSlot(value, { ctx, label: `Value of ${node.key}`, typingKey: `${node.id}:value`, dropKey: `${node.id}|value`, onInput: v => edit(ctx, node.id, n => { n.value = v; }, `${node.id}:value`) })
    ]);
  };

  B.role = function role(node, ctx) {
    const { issues, cls } = stateClasses(node, ctx);
    const roles = ctx.project?.roles.map(r => r.name) || [];
    const nameSlot = ctx.readOnly || !roles.length
      ? B.textSlot(node.role, { ctx, label: 'Role name', onInput: v => edit(ctx, node.id, n => { n.role = v; }, `${node.id}:role`) })
      : el('select', {
        class: 'slot pick', attrs: { 'aria-label': 'Role' }, onclick: e => e.stopPropagation(),
        onchange: e => edit(ctx, node.id, n => { n.role = e.target.value; })
      }, [...new Set([...(node.role ? [] : ['']), ...roles, node.role])].map(r => el('option', { value: r, text: r || 'choose…', selected: r === node.role })));
    const vars = Object.entries(node.vars || {});
    return el('div', { class: `blk role-blk${cls}`, style: `--c: ${SX.category('roles').color}`, data: { id: node.id, type: 'role' } }, [
      el('span', { class: 'mod-chip', text: 'role' }),
      nameSlot,
      vars.length ? el('span', { text: 'with' }) : null,
      ...vars.map(([k, v]) => el('span', { class: 'slot reporter', text: `${k}: ${B.summary(v)}`, title: 'Edit role vars in the inspector', onclick: () => ctx.select?.(node.id) })),
      ...Object.entries(node.kw).filter(([, v]) => v !== '' && v != null).map(([k, v]) => B.keywordPill(node, k, v, ctx)),
      lintBadge(issues)
    ]);
  };

  B.import = function importBlock(node, ctx) {
    const { cls } = stateClasses(node, ctx);
    return el('div', { class: `cblk${cls}`, style: `--c: ${SX.category('plays').color}`, data: { id: node.id, type: 'import' } }, [
      el('div', { class: 'blk hat no-tab import-blk c-first' }, [
        el('span', { class: 'play-tag', text: 'import_playbook', style: "font: 700 10.5px/1 var(--font-mono); letter-spacing: .06em; padding: 4px 7px; border-radius: 4px; background: rgba(18,20,26,.14)" }),
        B.textSlot(node.path, { ctx, label: 'Playbook path', missing: !node.path, typingKey: `${node.id}:path`, onInput: v => edit(ctx, node.id, n => { n.path = v; }, `${node.id}:path`) })
      ])
    ]);
  };

  function sectionSummary(play, section) {
    const list = play[section];
    if (section === 'vars') return list.map(v => v.key).filter(Boolean).join(', ');
    if (section === 'roles') return list.map(r => r.role).filter(Boolean).join(', ');
    if (!list.length) return 'empty';
    return section === 'handlers' ? list.map(h => h.name).join(', ') : SX.plural(list.length, 'item');
  }

  B.play = function play(node, ctx) {
    const { issues, cls } = stateClasses(node, ctx);
    const groups = ctx.groups || ['all'];
    const hostOptions = [...new Set([...groups, node.hosts].filter(Boolean))];
    const hosts = ctx.readOnly
      ? el('span', { class: 'slot choice', text: node.hosts || '—' })
      : el('select', {
        class: `slot choice${node.hosts ? '' : ' missing'}`, attrs: { 'aria-label': 'Hosts' }, onclick: e => e.stopPropagation(),
        onchange: async e => {
          let value = e.target.value;
          if (value === '__other__') {
            value = await SX.ui.prompt('Hosts', { label: 'Host pattern', value: node.hosts, hint: 'A group, a host, or a pattern such as webservers:&production' });
            if (value === null) { e.target.value = node.hosts; return; }
          }
          edit(ctx, node.id, n => { n.hosts = value; });
        }
      }, [...hostOptions.map(h => el('option', { value: h, text: h, selected: h === node.hosts })), el('option', { value: '__other__', text: 'Other pattern…' })]);
    const tick = (key, label, defaultOn) => {
      const on = node.kw[key] === undefined ? defaultOn : SX.Ansible.typedScalar(node.kw[key]) === true;
      return el('button', {
        class: 'tick', type: 'button', disabled: ctx.readOnly, attrs: { role: 'checkbox', 'aria-checked': String(on) },
        onclick: e => { e.stopPropagation(); edit(ctx, node.id, n => { n.kw[key] = !on; }); }
      }, [el('span', { class: 'box' }, icon('check', 10, 2)), label]);
    };
    // A read-only view shows only what the source has; the editor keeps empty mouths to drop into.
    const shown = SX.SECTIONS.play.filter(s => ctx.readOnly ? node[s].length || s === 'tasks'
      : (s !== 'pre_tasks' && s !== 'post_tasks') || node.ui.show[s] || node[s].length);
    const sections = shown.flatMap(section => {
      const collapsed = !!node.ui.collapsed[section];
      const header = el('div', {
        class: 'blk c-mid toggle', attrs: { role: 'button', tabindex: '0', 'aria-expanded': String(!collapsed) },
        onclick: () => ctx.toggleSection?.(node.id, section),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.toggleSection?.(node.id, section); } }
      }, [
        icon(collapsed ? 'chevronRight' : 'chevronDown', 10, 1.7),
        el('span', { text: SECTION_LABELS[section] }),
        collapsed ? el('span', { class: 'summary', text: sectionSummary(node, section) }) : null
      ]);
      const hint = section === 'vars' ? 'Drop var blocks here' : section === 'roles' ? 'Drop role blocks here' : section === 'handlers' ? 'Drop handler tasks here' : 'Drop blocks here';
      return collapsed ? [header] : [header, arm(node[section], node.id, section, ctx, hint)];
    });
    const extraKw = Object.entries(node.kw).filter(([k, v]) => !['become', 'gather_facts'].includes(k) && v !== '' && v != null);
    return el('div', { class: `cblk play-blk${cls}`, style: `--c: ${SX.category('plays').color}`, data: { id: node.id, type: 'play' } }, [
      el('div', { class: 'blk hat play-hat c-first' }, [
        el('div', { class: 'blk-head', style: 'gap: 10px' }, [
          el('span', { class: 'play-tag', text: 'play' }),
          titleField(node, ctx, { placeholder: 'Unnamed play', cls: 'play-title' }),
          ctx.readOnly ? null : el('button', { class: 'blk-menu', type: 'button', title: 'Play options', attrs: { 'aria-label': 'Play options' }, onclick: e => { e.stopPropagation(); ctx.openMenu?.(node, e.currentTarget); } }, icon('more', 14))
        ]),
        el('div', { class: 'blk-row' }, [
          el('span', { text: 'on hosts' }), hosts,
          !ctx.readOnly || node.kw.become !== undefined ? tick('become', 'become', false) : null,
          !ctx.readOnly || node.kw.gather_facts !== undefined ? tick('gather_facts', 'gather facts', true) : null
        ]),
        extraKw.length ? el('div', { class: 'blk-row kws' }, extraKw.map(([k, v]) => B.keywordPill(node, k, v, ctx))) : null,
        lintBadge(issues),
        lineBadge(node, ctx)
      ]),
      ...sections,
      el('div', { class: 'blk c-foot no-tab' })
    ]);
  };

  B.render = function render(node, ctx, opts = {}) {
    if (node.type === 'play') return B.play(node, ctx);
    if (node.type === 'block') return B.block(node, ctx);
    if (node.type === 'var') return B.var(node, ctx);
    if (node.type === 'role') return B.role(node, ctx);
    if (node.type === 'import') return B.import(node, ctx);
    return B.task(node, ctx, opts);
  };

  // ---- Palette ----------------------------------------------------------------------------

  const emptySlot = () => el('span', { class: 'slot empty' });

  // A palette entry rendered as the block it creates.
  B.palette = function palette(def) {
    if (def.kind === 'module') {
      const module = def.module;
      const parts = [el('span', { class: 'pal-mod', text: module.short })];
      if (module.freeArgs) parts.push(el('span', { class: 'slot', text: 'name' }), el('span', { text: '=' }), emptySlot());
      for (const name of module.palette) {
        const spec = SX.argSpec(module, name);
        if (spec?.kind === 'bool') {
          parts.push(el('span', { class: 'tick', attrs: { 'aria-checked': String(!!(module.defaults[name] ?? spec.default)) } }, [el('span', { class: 'box' }, icon('check', 10, 2)), name.replace(/_/g, ' ')]));
          continue;
        }
        if (name !== '_raw') parts.push(el('span', { text: name }));
        const value = module.defaults[name];
        if (spec?.kind === 'choice') parts.push(el('span', { class: 'slot choice', text: value ?? spec.default ?? spec.choices[0] }));
        else if (spec?.kind === 'list') parts.push(el('span', { class: 'slot seq empty' }));
        else parts.push(value ? el('span', { class: 'slot', text: value }) : emptySlot());
      }
      return el('div', { class: 'blk pal-blk', style: `--c: ${SX.category(module.category).color}`, title: module.description ? `${module.name} — ${module.description}` : module.name }, parts);
    }
    if (def.kind === 'play') {
      return el('div', { class: 'blk hat pal-blk', style: `--c: ${SX.category('plays').color}`, title: def.title }, [
        el('span', { class: 'pal-mod', text: 'play' }), def.label ? el('span', { class: 'blk-sub', text: def.label }) : null,
        el('span', { text: 'on hosts' }), el('span', { class: 'slot choice', text: 'all' })
      ]);
    }
    if (def.kind === 'import') {
      return el('div', { class: 'blk hat pal-blk', style: `--c: ${SX.category('plays').color}` }, [el('span', { class: 'pal-mod', text: 'import_playbook' }), el('span', { class: 'slot', text: 'db.yml' })]);
    }
    if (def.kind === 'block') {
      return el('div', { class: 'pal-e', style: `--c: ${SX.category('control').color}`, title: 'block / rescue / always' }, [
        el('div', { class: 'blk c-head', text: 'block' }), el('div', { class: 'c-arm' }, el('div', { class: 'c-spine' })),
        el('div', { class: 'blk c-mid', text: 'rescue' }), el('div', { class: 'c-arm' }, el('div', { class: 'c-spine' })),
        el('div', { class: 'blk c-mid', text: 'always' }), el('div', { class: 'c-arm' }, el('div', { class: 'c-spine' })),
        el('div', { class: 'blk c-foot' })
      ]);
    }
    if (def.kind === 'var') {
      return el('div', { class: 'blk pal-blk', style: `--c: ${SX.category('variables').color}`, title: 'A play variable' }, [el('span', { class: 'pal-mod', text: 'var' }), el('span', { class: 'slot', text: 'name' }), el('span', { text: '=' }), emptySlot()]);
    }
    if (def.kind === 'role') {
      return el('div', { class: 'blk pal-blk', style: `--c: ${SX.category('roles').color}`, title: 'Goes in a play’s roles section' }, [el('span', { class: 'pal-mod', text: 'role' }), def.role ? el('span', { class: 'slot', text: def.role }) : el('span', { class: 'slot', text: 'name' })]);
    }
    if (def.kind === 'pill') {
      const spec = SX.keywordSpec(def.keyword);
      const label = spec.label || def.keyword;
      const slot = spec.kind === 'cond' ? el('span', { class: 'slot cond', style: 'min-width: 40px' })
        : spec.kind === 'handlers' ? el('span', { class: 'slot choice', text: 'handler' })
        : spec.kind === 'expr' ? el('span', { class: 'slot expr', text: '{{ items }}' })
        : spec.kind === 'bool' ? el('span', { class: 'slot choice', text: 'yes' })
        : emptySlot();
      return el('div', { class: 'pal-pill', title: `Drop onto a task to add ${def.keyword}` }, [label, slot]);
    }
    if (def.kind === 'reporter') {
      return el('div', { class: 'pal-rep', text: def.name, title: def.source ? `${def.name} — from ${def.source}. Drop into a slot.` : def.name });
    }
    if (def.kind === 'generic') {
      return el('div', { class: 'blk pal-blk pal-generic' }, [el('span', { class: 'pal-mod', text: 'module' }), el('span', { class: 'slot', text: 'ns.collection.name' }), el('span', { text: '+ param' })]);
    }
    return el('div');
  };
})();
