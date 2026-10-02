// Role library: the project's roles, a role's tasks and handlers as blocks, its
// defaults, templates and dependencies, and where it is used.
(function () {
  const SX = window.Scransible;
  const { el, icon, ui, Blocks: B, Ansible: A } = SX;
  const store = SX.store;
  const state = { roleName: null, tab: 'tasks', search: '', template: null };
  let root;

  const project = () => store.project;
  const currentRole = () => project().roles.find(r => r.name === state.roleName) || project().roles[0] || null;

  function editRole(id, change, typingKey) {
    const apply = p => { const role = p.roles.find(r => r.id === id); if (role) change(role, p); };
    if (typingKey) store.typing(typingKey, apply, 'roles');
    else store.commit(apply, { source: 'roles' });
  }

  // Where a role is used: plays that list it, and roles that depend on it.
  function usage(role) {
    const plays = [];
    for (const pb of project().playbooks) {
      for (const item of pb.items) {
        if (item.type === 'play' && item.roles.some(r => r.role === role.name)) plays.push({ play: item, playbook: pb });
      }
    }
    const dependents = project().roles.filter(r => r.dependencies.includes(role.name)).map(r => r.name);
    return { plays, dependents };
  }

  function usageLine(role) {
    const { plays, dependents } = usage(role);
    const tasks = SX.plural(role.tasks.length, 'task');
    if (plays.length) return `${tasks} · used in ${SX.plural(plays.length, 'play')}`;
    if (dependents.length) return `${tasks} · dependency of ${dependents.join(', ')}`;
    return `${tasks} · not used yet`;
  }

  const validName = (name, except) => {
    if (!/^[a-z0-9_]+$/.test(name)) return 'Role names use lowercase letters, numbers and underscores.';
    if (project().roles.some(r => r.name === name && r.id !== except)) return 'There is already a role with that name.';
    return null;
  };

  async function newRole() {
    const name = await ui.prompt('New role', { label: 'Role name', placeholder: 'postgresql', validate: v => validName(v) });
    if (!name) return;
    store.commit(p => { p.roles.push(SX.newRole(name)); }, { source: 'roles' });
    location.hash = `#/roles/${encodeURIComponent(name)}`;
  }

  // ---- Left: role list ------------------------------------------------------------------

  function renderList() {
    const roles = project().roles.filter(r => !state.search || r.name.includes(state.search.toLowerCase()));
    const role = currentRole();
    return el('aside', { class: 'side' }, [
      el('div', { class: 'side-title-row' }, [
        el('h1', { class: 'side-title', text: 'Roles' }),
        el('button', { class: 'btn btn-sm', type: 'button', title: 'New role', attrs: { 'aria-label': 'New role' }, onclick: newRole }, icon('plus', 16))
      ]),
      el('div', { style: 'padding: 0 16px 12px' }, el('div', { class: 'searchbox' }, [
        icon('search', 16),
        el('input', { type: 'search', placeholder: 'Search roles', value: state.search, attrs: { 'aria-label': 'Search roles' }, oninput: e => { state.search = e.target.value; rerenderList(); } })
      ])),
      el('div', { class: 'section-label', style: 'padding: 6px 20px 8px', text: 'In this project' }),
      el('div', { class: 'list', style: 'padding: 0 10px' }, roles.length ? roles.map(r => el('a', {
        class: 'list-row', href: `#/roles/${encodeURIComponent(r.name)}`, attrs: { 'aria-current': String(r.id === role?.id) }, style: 'text-decoration: none'
      }, [
        el('span', { style: `width: 22px; height: 16px; border-radius: 4px; background: ${SX.category('roles').color}; flex-shrink: 0` }),
        el('span', { class: 'row-main' }, [el('span', { class: 'row-title', text: r.name }), el('span', { class: 'row-sub', text: usageLine(r) })])
      ])) : [el('p', { class: 'empty-note', style: 'padding: 8px 10px', text: state.search ? 'No roles match.' : 'No roles yet.' })]),
      el('span', { class: 'grow' }),
      el('div', { class: 'card', style: 'margin: 16px; border-style: dashed' }, [
        el('h2', { class: 'card-title', text: 'Bring in a role' }),
        el('p', { class: 'empty-note', text: 'From a role folder, a .zip or .tar.gz, or a GitHub repository. It opens read-only first so you can see what it does.' }),
        el('a', { class: 'btn btn-md', href: '#/import', style: 'align-self: flex-start', text: 'Import a role…' })
      ])
    ]);
  }

  function rerenderList() {
    root.querySelector('.side')?.replaceWith(renderList());
  }

  // ---- Center: role detail ---------------------------------------------------------------

  function addToPlayMenu(role, anchor) {
    const plays = project().playbooks.flatMap(pb => pb.items.filter(i => i.type === 'play').map(play => ({ play, pb })));
    if (!plays.length) {
      ui.toast('There are no plays yet. Add one in the builder.');
      return;
    }
    ui.menu(anchor, [{ heading: 'Add to a play’s roles' }, ...plays.map(({ play, pb }) => ({
      label: `${play.name || 'Unnamed play'} — ${pb.path}`, disabled: play.roles.some(r => r.role === role.name),
      onClick: () => {
        store.commit(p => {
          const target = SX.findNode(p, play.id);
          target.roles.push(SX.newRoleRef(role.name));
          target.ui.collapsed.roles = false;
        }, { source: 'roles' });
        ui.toast(`Added ${role.name} to “${play.name}”.`, { action: { label: 'Show', onClick: () => openInBuilder(play.id, pb.id) } });
      }
    }))]);
  }

  function openInBuilder(nodeId, playbookId) {
    store.commit(p => SX.openPlaybook(p, playbookId), { checkpoint: false });
    location.hash = '#/builder';
    setTimeout(() => SX.revealNode?.(nodeId), 0);
  }

  function editTasksInBuilder(role) {
    store.commit(p => SX.openRole(p, role.id), { checkpoint: false });
    location.hash = '#/builder';
  }

  function tasksTab(role, sections) {
    const ctx = {
      readOnly: true, project: project(), issues: SX.Lint.run(project()).byNode,
      handlers: SX.handlerNames({ handlers: role.handlers }),
      notifyCount: handler => {
        let count = 0;
        SX.walk(role.tasks, n => { if ([].concat(n.kw?.notify || []).includes(handler.name)) count++; });
        return count;
      }
    };
    const notifiers = handler => {
      const names = [];
      SX.walk(role.tasks, n => { if ([].concat(n.kw?.notify || []).includes(handler.name)) names.push(n.name || n.module); });
      return names;
    };
    return el('div', { class: 'well-canvas', style: 'flex: 1; overflow: auto; padding: 28px 30px 60px; display: flex; flex-direction: column; gap: 44px; align-items: flex-start' }, [
      el('div', { style: 'display: flex; gap: 8px; align-items: center' }, [
        el('button', { class: 'btn btn-md btn-primary', type: 'button', onclick: () => editTasksInBuilder(role) }, ['Edit in the builder', icon('arrowRight', 15)]),
        el('span', { class: 'field-hint', text: 'Blocks here are a preview. The builder edits them with the palette and inspector.' })
      ]),
      ...sections.map(section => el('div', { style: 'display: flex; flex-direction: column; gap: 12px' }, [
        B.roleFile(role, section, ctx),
        section === 'handlers' && role.handlers.length ? el('p', { class: 'field-hint', style: 'max-width: 360px' }, role.handlers.map(h => {
          const by = notifiers(h);
          return el('span', { style: 'display: block' }, [el('strong', { class: 'mono', text: h.name }), by.length ? ` is notified by ${by.join(' and ')}.` : ' isn’t notified by any task yet.']);
        })) : null
      ]))
    ]);
  }

  function defaultsTab(role) {
    return el('div', { style: 'padding: 24px; max-width: 720px; display: flex; flex-direction: column; gap: 14px; overflow: auto' }, [
      el('p', { class: 'empty-note', text: 'Defaults are the lowest-precedence variables: anything in the inventory, the play or the role block overrides them. Each one becomes a slot on the role block.' }),
      ui.varRows(role.defaults, {
        keyPrefix: role.id,
        onEdit: (id, change, key) => editRole(role.id, r => Object.assign(r.defaults.find(d => d.id === id), change), key),
        onRemove: id => editRole(role.id, r => { r.defaults = r.defaults.filter(d => d.id !== id); }),
        onAdd: () => editRole(role.id, r => { r.defaults.push(SX.newVar(`${r.name}_setting`, '')); }),
        addLabel: '+ Add default'
      }),
      ui.codeView(A.dump(Object.fromEntries(role.defaults.filter(d => d.key).map(d => [d.key, typeof d.value === 'string' ? A.typedScalar(d.value) : d.value])), project().settings).text, { compact: true })
    ]);
  }

  function templatesTab(role) {
    const current = role.templates.find(t => t.id === state.template) || role.templates[0];
    return el('div', { style: 'display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 0; flex: 1' }, [
      el('div', { style: 'border-right: 1px solid var(--border); padding: 14px 10px; display: flex; flex-direction: column; gap: 8px; overflow: auto' }, [
        el('div', { class: 'list' }, role.templates.map(t => el('button', {
          class: 'list-row', type: 'button', attrs: { 'aria-current': String(t.id === current?.id) }, onclick: () => { state.template = t.id; render(); }
        }, [icon('file', 15), el('span', { class: 'row-title', text: t.path })]))),
        el('button', {
          class: 'dashed-btn', type: 'button', text: '+ New template', onclick: async () => {
            const path = await ui.prompt('New template', { label: 'File name', value: `${role.name}.conf.j2`, validate: v => /^[\w./-]+$/.test(v) ? null : 'Use a relative file name.' });
            if (!path) return;
            const tpl = { id: SX.uid(), path, content: '' };
            state.template = tpl.id;
            editRole(role.id, r => { r.templates.push(tpl); });
          }
        })
      ]),
      current ? el('div', { style: 'display: flex; flex-direction: column; min-height: 0' }, [
        el('div', { class: 'pane-head' }, [
          el('span', { class: 'mono', style: 'font: 600 13px/1 var(--font-mono)', text: `templates/${current.path}` }), el('span', { class: 'grow' }),
          el('button', { class: 'btn btn-sm', type: 'button', text: 'Rename', onclick: async () => { const path = await ui.prompt('Rename template', { label: 'File name', value: current.path }); if (path) editRole(role.id, r => { r.templates.find(t => t.id === current.id).path = path; }); } }),
          el('button', { class: 'btn btn-sm', type: 'button', text: 'Delete', onclick: () => editRole(role.id, r => { r.templates = r.templates.filter(t => t.id !== current.id); }) })
        ]),
        el('textarea', {
          class: 'textarea', value: current.content, spellcheck: false, style: 'flex: 1; border: 0; border-radius: 0; resize: none; padding: 16px; min-height: 320px',
          attrs: { 'aria-label': `Contents of ${current.path}` },
          oninput: e => editRole(role.id, r => { r.templates.find(t => t.id === current.id).content = e.target.value; }, `${current.id}:content`)
        })
      ]) : el('p', { class: 'empty-note', style: 'padding: 24px', text: 'No templates yet. Templates are Jinja2 files the template module renders onto hosts.' })
    ]);
  }

  function metaTab(role) {
    const others = project().roles.filter(r => r.name !== role.name && !role.dependencies.includes(r.name));
    return el('div', { style: 'padding: 24px; max-width: 640px; display: flex; flex-direction: column; gap: 18px; overflow: auto' }, [
      ui.field('Description', el('textarea', { class: 'textarea', value: role.description, rows: 3, style: 'font-family: var(--font-ui)', oninput: e => editRole(role.id, r => { r.description = e.target.value; }, `${role.id}:description`) })),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Dependencies' }),
        el('div', { class: 'chip-row' }, [
          ...role.dependencies.map(dep => el('span', { class: 'chip removable', style: `background: color-mix(in srgb, ${SX.category('roles').color} 16%, transparent)` }, [dep, el('button', { type: 'button', attrs: { 'aria-label': `Remove ${dep}` }, onclick: () => editRole(role.id, r => { r.dependencies = r.dependencies.filter(d => d !== dep); }) }, icon('x', 10))])),
          others.length ? ui.select([['', '+ Add dependency'], ...others.map(r => [r.name, r.name])], '', v => v && editRole(role.id, r => { r.dependencies.push(v); }), { cls: 'select' }) : null
        ]),
        el('span', { class: 'field-hint', text: 'Dependencies run before this role wherever it is used (meta/main.yml).' })
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Name' }),
        el('div', { style: 'display: flex; gap: 8px' }, [
          el('button', { class: 'btn btn-md', type: 'button', text: 'Rename role…', onclick: () => renameRole(role) }),
          el('button', { class: 'btn btn-md btn-warn', type: 'button', text: 'Delete role…', onclick: () => deleteRole(role) })
        ])
      ])
    ]);
  }

  async function renameRole(role) {
    const name = await ui.prompt('Rename role', { label: 'Role name', value: role.name, validate: v => validName(v, role.id) });
    if (!name || name === role.name) return;
    store.commit(p => {
      const target = p.roles.find(r => r.id === role.id);
      for (const r of p.roles) r.dependencies = r.dependencies.map(d => (d === role.name ? name : d));
      for (const pb of p.playbooks) SX.walk(pb.items, n => { if (n.type === 'role' && n.role === role.name) n.role = name; });
      target.name = name;
    }, { source: 'roles' });
    location.hash = `#/roles/${encodeURIComponent(name)}`;
  }

  async function deleteRole(role) {
    const { plays } = usage(role);
    const message = plays.length ? `It is used in ${SX.plural(plays.length, 'play')}; those role blocks stay and will be flagged. Undo brings the role back.` : 'Undo brings it back.';
    if (!await ui.confirm(`Delete role ${role.name}?`, message, { confirmLabel: 'Delete', danger: true })) return;
    store.commit(p => { p.roles = p.roles.filter(r => r.id !== role.id); if (p.activeDoc?.id === role.id) SX.openPlaybook(p, p.activePlaybookId); }, { source: 'roles' });
    location.hash = '#/roles';
  }

  function renderDetail(role) {
    if (!role) {
      return el('main', { style: 'display: flex; align-items: center; justify-content: center' }, el('div', { class: 'canvas-empty-card' }, [
        el('h2', { text: 'No roles yet' }),
        el('p', { text: 'Roles package tasks, handlers, defaults and templates so plays can reuse them.' }),
        el('div', { style: 'display: flex; gap: 8px' }, [el('button', { class: 'btn btn-primary', type: 'button', text: 'New role', onclick: newRole }), el('a', { class: 'btn', href: '#/import', text: 'Import a role' })])
      ]));
    }
    const tabs = [['tasks', 'Tasks', role.tasks.length], ['handlers', 'Handlers', role.handlers.length], ['defaults', 'Defaults', role.defaults.length], ['templates', 'Templates', role.templates.length], ['meta', 'Meta', null]];
    const body = state.tab === 'tasks' ? tasksTab(role, ['tasks', 'handlers'])
      : state.tab === 'handlers' ? tasksTab(role, ['handlers'])
      : state.tab === 'defaults' ? defaultsTab(role)
      : state.tab === 'templates' ? templatesTab(role)
      : metaTab(role);
    const roleBlock = el('div', { class: 'blk role-blk', style: `--c: ${SX.category('roles').color}; --well: var(--bg)` }, [
      icon('grip', 12), el('span', { class: 'mod-chip', text: 'role' }), el('span', { class: 'slot', text: role.name }),
      el('span', { text: 'with' }), el('span', { class: 'slot reporter', style: 'background: transparent; box-shadow: 0 0 0 1.5px var(--ink); border-style: dashed', text: '+ var' })
    ]);
    return el('main', { style: 'display: flex; flex-direction: column; min-height: 0; min-width: 0' }, [
      el('div', { class: 'role-head' }, [
        el('div', { class: 'role-head-top' }, [
          el('div', { style: 'display: flex; flex-direction: column; gap: 8px; min-width: 0; flex: 1' }, [
            el('div', {}, [el('span', { class: 'role-name', text: role.name }), el('span', { class: 'role-path', text: `roles/${role.name}` })]),
            el('p', { class: 'insp-desc', text: role.description || 'No description yet — add one on the Meta tab.' })
          ]),
          el('div', { style: 'display: flex; flex-direction: column; align-items: flex-end; gap: 6px' }, [
            roleBlock,
            el('button', { class: 'link-btn', type: 'button', onclick: e => addToPlayMenu(role, e.currentTarget) }, ['Add to a play’s roles', icon('chevronDown', 10)])
          ])
        ]),
        el('div', { class: 'tabs', attrs: { role: 'tablist' } }, tabs.map(([id, label, n]) => el('button', {
          type: 'button', attrs: { role: 'tab', 'aria-selected': String(state.tab === id) }, onclick: () => { state.tab = id; render(); }
        }, [label, n === null ? null : el('span', { class: 'n', text: String(n) })])))
      ]),
      body
    ]);
  }

  // ---- Right: role interface ---------------------------------------------------------------

  // Where each default gets a value in this project, if anywhere.
  function overrides(role, key) {
    const found = [];
    const inv = SX.activeInventory(project());
    for (const g of inv?.groups || []) {
      const v = g.vars.find(x => x.key === key);
      if (v) found.push({ value: v.value, where: `group_vars/${g.name}`, href: '#/inventory' });
    }
    for (const pb of project().playbooks) {
      SX.walk(pb.items, n => {
        if (n.type === 'role' && n.role === role.name && key in (n.vars || {})) found.push({ value: n.vars[key], where: `${pb.path} · role vars`, nodeId: n.id, playbookId: pb.id });
        if (n.type === 'var' && n.key === key) found.push({ value: n.value, where: `${pb.path} · play vars`, nodeId: n.id, playbookId: pb.id });
      });
    }
    return found;
  }

  function renderAside(role) {
    if (!role) return el('aside', { class: 'panel', style: 'border-left: 1px solid var(--border)' });
    const { plays } = usage(role);
    const files = A.roleFiles(role, project().settings, 'roles/').map(f => f.path.replace(`roles/${role.name}/`, ''));
    const kindColor = path => path.startsWith('tasks') ? SX.category('roles').color : path.startsWith('handlers') ? SX.category('services').color
      : path.startsWith('defaults') ? SX.category('variables').color : path.startsWith('templates') ? SX.category('files').color : SX.category('utilities').color;
    return el('aside', { class: 'panel', style: 'border-left: 1px solid var(--border)' }, [
      el('div', { class: 'panel-section' }, [
        el('h2', { class: 'panel-title', text: 'Inputs' }),
        el('p', { class: 'empty-note' }, ['Every default in ', el('span', { class: 'mono', text: 'defaults/main.yml' }), ' becomes a slot you can fill on the role block.']),
        role.defaults.length ? el('table', { class: 'table' }, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Variable' }), el('th', { text: 'Default' }), el('th', { text: 'In this project' })])),
          el('tbody', {}, role.defaults.map(d => {
            const over = overrides(role, d.key);
            return el('tr', {}, [
              el('td', { class: 'mono', text: d.key }),
              el('td', { class: 'mono num', text: B.summary(d.value) }),
              el('td', {}, over.length ? over.map(o => el('div', {}, [
                el('span', { class: 'mono num', text: B.summary(o.value) }), el('br'),
                o.nodeId
                  ? el('a', { href: '#/builder', style: 'font-size: 12px', text: o.where, onclick: e => { e.preventDefault(); openInBuilder(o.nodeId, o.playbookId); } })
                  : el('a', { href: o.href, style: 'font-size: 12px', text: o.where })
              ])) : el('span', { class: 'faint', text: 'Default' }))
            ]);
          }))
        ]) : null,
        el('button', { class: 'dashed-btn', type: 'button', text: '+ Add default', onclick: () => { state.tab = 'defaults'; editRole(role.id, r => { r.defaults.push(SX.newVar(`${r.name}_setting`, '')); }); } })
      ]),
      el('div', { class: 'panel-section' }, [
        el('h2', { class: 'panel-title', text: 'Depends on' }),
        role.dependencies.length ? el('div', { class: 'chip-row' }, role.dependencies.map(dep => el('a', { class: 'chip', href: `#/roles/${encodeURIComponent(dep)}`, style: `text-decoration: none; background: color-mix(in srgb, ${SX.category('roles').color} 16%, transparent); color: #F5A6E2` }, [el('span', { class: 'color-square', style: `--c: ${SX.category('roles').color}; width: 8px; height: 8px` }), dep]))) : el('p', { class: 'empty-note', text: 'No dependencies.' }),
        role.dependencies.length ? el('p', { class: 'field-hint' }, ['From ', el('span', { class: 'mono', text: 'meta/main.yml' }), ` — runs before ${role.name} wherever ${role.name} is used.`]) : null
      ]),
      el('div', { class: 'panel-section' }, [
        el('h2', { class: 'panel-title', text: 'Used in' }),
        plays.length ? el('div', { class: 'list' }, plays.map(({ play, playbook }) => el('button', {
          class: 'list-row', type: 'button', style: 'border: 1px solid var(--border); background: var(--bg-sunken)', onclick: () => openInBuilder(play.id, playbook.id)
        }, [
          el('span', { style: `width: 26px; height: 16px; border-radius: 9px 5px 3px 3px; background: ${SX.category('plays').color}; flex-shrink: 0` }),
          el('span', { class: 'row-main' }, [el('span', { class: 'row-title', style: 'font-family: var(--font-ui)', text: play.name || 'Unnamed play' }), el('span', { class: 'row-sub mono', text: playbook.path })]),
          icon('forward', 16)
        ]))) : el('p', { class: 'empty-note', text: 'No play uses this role yet.' })
      ]),
      el('div', { class: 'panel-section' }, [
        el('h2', { class: 'panel-title', text: 'Role files' }),
        el('div', { style: 'display: flex; flex-direction: column; gap: 4px; font: 500 12.5px/1.6 var(--font-mono); color: var(--text-soft)' },
          files.map(path => el('div', { class: 'tree-row' }, [el('span', { class: 'color-square', style: `--c: ${kindColor(path)}; width: 8px; height: 8px` }), path])))
      ])
    ]);
  }

  function render() {
    const role = currentRole();
    if (role) state.roleName = role.name;
    root.replaceChildren(renderList(), renderDetail(role), renderAside(role));
  }

  SX.pages = SX.pages || {};
  SX.pages.roles = {
    mount(container, { arg } = {}) {
      SX.DnD.handler = null;
      if (arg && arg !== state.roleName) {
        state.roleName = arg;
        state.tab = 'tasks';
        state.template = null;
      }
      root = el('div', { class: 'cols', style: 'grid-template-columns: 300px minmax(0, 1fr) 380px; min-height: 0' });
      container.replaceChildren(root);
      render();
    },
    update(event) {
      if (event?.typing && event.source === 'roles') return;
      render();
    }
  };
})();
