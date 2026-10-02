// The builder: category rail, block palette, canvas, inspector and status bar.
(function () {
  const SX = window.Scransible;
  const { el, icon, ui, Blocks: B, Ansible: A } = SX;
  const store = SX.store;

  const PREFS_KEY = 'scransible.builder';
  const prefs = (() => {
    try { return JSON.parse(SX.readStorage(PREFS_KEY) || '{}'); } catch (error) { return {}; }
  })();
  const savePrefs = () => SX.writeStorage(PREFS_KEY, JSON.stringify({ category: state.category, view: state.view, zoom: state.zoom, collection: state.collection }));

  const state = {
    category: prefs.category || 'plays',
    collection: prefs.collection || 'all',
    view: prefs.view || 'blocks',
    zoom: prefs.zoom || 1,
    search: '',
    selectedId: null,
    focus: null,
    showAllParams: false,
    paletteOpen: false,
    yamlError: null
  };
  let root, refs = {};

  // A read-only session (from Import → Visualize) shows another project without editing.
  const session = () => SX.session?.readOnly ? SX.session : null;
  const project = () => session()?.project || store.project;
  const doc = () => SX.activeDoc(project());
  const playbook = () => SX.activePlaybook(project());
  const roleMode = () => doc().kind === 'role';
  const readOnly = () => !!session();
  let lintCache = null;
  const lint = () => (lintCache = lintCache || SX.Lint.run(project()));

  // ---- Editing helpers ----------------------------------------------------------------

  function editNode(id, change, typingKey, source = 'canvas') {
    if (readOnly()) return;
    if (typingKey) store.typing(typingKey, p => { const n = SX.findNode(p, id); if (n) change(n, p); }, source);
    else store.commit(p => { const n = SX.findNode(p, id); if (n) change(n, p); }, { source });
  }

  function containerList(p, owner, section) {
    if (owner.startsWith('pb:')) return p.playbooks.find(pb => pb.id === owner.slice(3))?.items;
    if (owner.startsWith('role:')) return p.roles.find(r => r.id === owner.slice(5))?.[section];
    return SX.findNode(p, owner)?.[section];
  }
  SX.containerList = containerList;

  function createNode(payload) {
    const p = project();
    switch (payload.type) {
      case 'task': return payload.module === null ? SX.newTask('') : SX.newTask(payload.module);
      case 'block': return SX.newBlock();
      case 'var': return SX.newVar('new_var', '');
      case 'role': return SX.newRoleRef(payload.role || p.roles[0]?.name || '');
      case 'import': return SX.newImport({ path: 'other.yml' });
      case 'play': {
        const play = SX.newPlay({ name: payload.label ? `Configure ${payload.label} devices` : 'New play', hosts: 'all' });
        if (payload.preset) {
          play.kw.connection = 'ansible.netcommon.network_cli';
          play.kw.gather_facts = false;
          play.vars.push(SX.newVar('ansible_network_os', payload.preset));
        }
        return play;
      }
      default: return null;
    }
  }

  // ---- Drag and drop -------------------------------------------------------------------

  const dndHandler = {
    resolve(hits, payload, pt) {
      if (readOnly()) return null;
      if (payload.kind === 'move' && hits.some(h => h.closest?.('.trash, .palette, .rail'))) return { kind: 'trash' };
      if (payload.type === 'reporter') {
        const slot = hits.find(h => h.dataset?.slot);
        return slot ? { kind: 'slot', element: slot, key: slot.dataset.slot } : null;
      }
      if (payload.type === 'pill') {
        const target = hits.map(h => h.closest?.('.stack-blk[data-type="task"], .cblk[data-type="block"]')).find(Boolean);
        return target ? { kind: 'node', element: target.dataset.type === 'task' ? target : target.querySelector('.c-first'), id: target.dataset.id } : null;
      }
      if (payload.type === 'play' || payload.type === 'import') {
        if (roleMode() || !hits.some(h => h.closest?.('.canvas-scroll'))) return null;
        const rect = refs.stage.getBoundingClientRect();
        return { kind: 'canvas', x: Math.max(0, Math.round((pt.x - rect.left) / state.zoom - pt.offsetX)), y: Math.max(0, Math.round((pt.y - rect.top) / state.zoom - pt.offsetY)) };
      }
      const seen = new Set();
      for (const h of hits) {
        const stack = h.closest?.('.stack');
        if (!stack || seen.has(stack)) continue;
        seen.add(stack);
        if (!refs.stage.contains(stack)) continue;
        if (payload.kind === 'move' && pt.source.contains(stack)) continue;
        if (!stack.dataset.accept.split(' ').includes(payload.type)) continue;
        return { kind: 'stack', element: stack, owner: stack.dataset.owner, section: stack.dataset.section, index: SX.DnD.indexIn(stack, pt.y, pt.source) };
      }
      return null;
    },

    drop(payload, target) {
      let selectId = null;
      if (target.kind === 'trash') {
        store.commit(p => { const loc = SX.locate(p, payload.id); if (loc) loc.list.splice(loc.index, 1); }, { source: 'dnd' });
        if (state.selectedId === payload.id) state.selectedId = null;
        ui.toast('Deleted the block.', { action: { label: 'Undo', onClick: () => store.undo() } });
        return;
      }
      if (target.kind === 'slot') {
        const [id, name] = target.key.split('|');
        editNode(id, n => { if (n.type === 'var') n.value = `{{ ${payload.name} }}`; else n.args[name] = `{{ ${payload.name} }}`; });
        return;
      }
      if (target.kind === 'node') {
        const key = payload.keyword;
        const spec = SX.keywordSpec(key);
        const initial = spec.kind === 'handlers' ? [SX.handlerNames(SX.playOf(project(), target.id))[0] || ''] : spec.kind === 'list' ? [] : spec.kind === 'bool' ? true : '';
        state.focus = `kw:${key}`;
        state.selectedId = target.id;
        editNode(target.id, n => { if (!(key in n.kw)) n.kw[key] = initial; });
        return;
      }
      store.commit(p => {
        let node;
        if (payload.kind === 'move') {
          const loc = SX.locate(p, payload.id);
          if (!loc) return;
          if (target.kind === 'canvas') {
            loc.node.pos = { x: target.x, y: target.y };
            selectId = loc.node.id;
            return;
          }
          [node] = loc.list.splice(loc.index, 1);
        } else {
          node = createNode(payload);
          if (!node) return;
        }
        selectId = node.id;
        if (target.kind === 'canvas') {
          node.pos = { x: target.x, y: target.y };
          SX.activePlaybook(p).items.push(node);
        } else {
          const list = containerList(p, target.owner, target.section);
          if (!list) return;
          if (target.section === 'vars' || target.section === 'roles' || target.section === 'handlers') {
            const play = SX.findNode(p, target.owner);
            if (play?.ui) play.ui.collapsed[target.section] = false;
          }
          list.splice(Math.min(target.index, list.length), 0, node);
        }
      }, { source: 'dnd' });
      if (selectId) {
        state.selectedId = selectId;
        if (payload.kind === 'new') state.focus = payload.module === null ? 'module' : payload.type === 'task' ? 'name' : null;
        render();
      }
    }
  };

  function paletteDraggable(element, def) {
    SX.DnD.attach(element, () => {
      if (readOnly()) return null;
      if (def.kind === 'module') return { kind: 'new', type: 'task', module: def.module.name };
      if (def.kind === 'generic') return { kind: 'new', type: 'task', module: null };
      if (def.kind === 'pill') return { kind: 'new', type: 'pill', keyword: def.keyword };
      if (def.kind === 'reporter') return { kind: 'new', type: 'reporter', name: def.name };
      if (def.kind === 'play') return { kind: 'new', type: 'play', preset: def.preset, label: def.label };
      return { kind: 'new', type: def.kind, role: def.role };
    });
    return element;
  }

  // Click-to-add: modules go to the end of the selected item's list (or the first play's tasks).
  function addFromPalette(def) {
    if (readOnly()) return;
    if (def.kind === 'pill' || def.kind === 'reporter') {
      ui.toast(def.kind === 'pill' ? 'Drag a keyword onto a task to add it.' : 'Drag a variable into a slot to use it.');
      return;
    }
    const pb = playbook();
    const type = def.kind === 'module' || def.kind === 'generic' ? 'task' : def.kind;
    if (roleMode()) {
      if (type !== 'task' && type !== 'block') {
        ui.toast('Role task files hold tasks and blocks. Open a playbook to add plays, vars or roles.');
        return;
      }
      const role = doc().role;
      const selected = state.selectedId && SX.locate(project(), state.selectedId);
      const target = selected?.node.type === 'block' ? { owner: selected.node.id, section: 'block' }
        : selected?.node.type === 'task' ? { owner: selected.owner.id && selected.owner.type ? selected.owner.id : `role:${role.id}`, section: selected.section, index: selected.index + 1 }
        : { owner: `role:${role.id}`, section: 'tasks' };
      const list = containerList(project(), target.owner, target.section);
      dndHandler.drop({ kind: 'new', type, module: def.kind === 'module' ? def.module.name : null }, { kind: 'stack', owner: target.owner, section: target.section, index: target.index ?? list.length });
      return;
    }
    const payload = { kind: 'new', type, module: def.kind === 'module' ? def.module.name : def.kind === 'generic' ? null : undefined, role: def.role, preset: def.preset, label: def.label };
    if (type === 'play' || type === 'import') {
      const bottom = Math.max(0, ...[...refs.stage.querySelectorAll('.stage-item')].map(n => (n.offsetTop + n.offsetHeight)));
      dndHandler.drop(payload, { kind: 'canvas', x: 32, y: pb.items.length ? bottom + 40 : 24 });
      return;
    }
    const section = type === 'var' ? 'vars' : type === 'role' ? 'roles' : 'tasks';
    let owner = null;
    const selected = state.selectedId && SX.locate(project(), state.selectedId);
    if (selected && type !== 'var' && type !== 'role') {
      const n = selected.node;
      if (n.type === 'block') owner = { owner: n.id, section: 'block' };
      else if (n.type === 'play') owner = { owner: n.id, section: 'tasks' };
      else if (n.type === 'task' && selected.owner?.id) owner = { owner: selected.owner.id || `pb:${pb.id}`, section: selected.section, index: selected.index + 1 };
    }
    if (!owner) {
      const play = (selected && SX.playOf(project(), state.selectedId)) || pb.items.find(i => i.type === 'play');
      if (!play) {
        ui.toast('Add a play first — drag one from the Plays category.');
        state.category = 'plays';
        renderPalette();
        return;
      }
      owner = { owner: play.id, section };
    }
    const list = containerList(project(), owner.owner, owner.section);
    dndHandler.drop(payload, { kind: 'stack', owner: owner.owner, section: owner.section, index: owner.index ?? list.length });
  }

  // ---- Rail and palette -----------------------------------------------------------------

  function renderRail() {
    refs.rail.replaceChildren(...SX.categories.filter(c => c.id !== 'generic').map(c => el('button', {
      type: 'button', style: `--c: ${c.color}`, attrs: { 'aria-pressed': String(c.id === state.category && !state.search) },
      onclick: () => { state.category = c.id; state.search = ''; refs.search.value = ''; state.paletteOpen = true; savePrefs(); renderRail(); renderPalette(); }
    }, [el('span', { class: 'swatch' }), el('span', { text: c.name })])));
  }

  function modulesIn(categoryId) {
    return SX.allModules().filter(m => m.category === categoryId && (state.collection === 'all' || m.collection === state.collection));
  }

  function scopeReporters() {
    const play = (state.selectedId && SX.playOf(project(), state.selectedId)) || playbook().items.find(i => i.type === 'play');
    return [...A.variablesInScope(project(), play)].map(([name, source]) => ({ kind: 'reporter', name, source }));
  }

  function paletteDefs(categoryId) {
    const mods = modulesIn(categoryId).map(module => ({ kind: 'module', module }));
    const head = text => ({ head: text });
    const note = text => ({ note: text });
    if (categoryId === 'plays') {
      const defs = [{ kind: 'play' }];
      if (SX.moduleSets.some(s => s.collection === 'cisco.ios')) defs.push({ kind: 'play', preset: 'cisco.ios.ios', label: 'Cisco IOS', title: 'A play with network_cli and ansible_network_os set for IOS' });
      if (SX.moduleSets.some(s => s.collection === 'cisco.nxos')) defs.push({ kind: 'play', preset: 'cisco.nxos.nxos', label: 'Cisco NX-OS', title: 'A play with network_cli and ansible_network_os set for NX-OS' });
      return [...defs, { kind: 'import' }, note('A play holds vars, roles, tasks and handlers sections. Turn on pre_tasks or post_tasks from the play’s ⋯ menu.')];
    }
    if (categoryId === 'control') {
      return [{ kind: 'block' }, ...mods, head('Task keywords · snap onto any task'),
        ...['when', 'loop', 'notify', 'register', 'tags', 'changed_when', 'become'].map(keyword => ({ kind: 'pill', keyword }))];
    }
    if (categoryId === 'variables') {
      const reporters = scopeReporters();
      return [{ kind: 'var' }, ...mods, head('In scope · drag into any slot'), ...(reporters.length ? reporters : [note('Variables appear here once a play defines them.')])];
    }
    if (categoryId === 'roles') {
      const roles = project().roles;
      return [{ kind: 'role' }, ...mods, head('Project roles'), ...(roles.length ? roles.map(r => ({ kind: 'role', role: r.name })) : [note('No roles yet. Create one on the Roles page.')])];
    }
    return mods.length ? mods : [note(state.collection === 'all' ? 'No installed module sets add blocks here yet.' : 'This collection has no blocks in this category.')];
  }

  function paletteEntry(def) {
    if (def.head) return el('div', { class: 'section-label palette-head', text: def.head });
    if (def.note) return el('p', { class: 'palette-note', text: def.note });
    const node = B.palette(def);
    node.addEventListener('dblclick', () => addFromPalette(def));
    node.addEventListener('keydown', e => { if (e.key === 'Enter') addFromPalette(def); });
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', def.kind === 'module' ? `${def.module.short} block — double-click or press Enter to add` : `${def.kind} block`);
    return paletteDraggable(node, def);
  }

  function searchResults(query) {
    const q = query.toLowerCase();
    const groups = [];
    for (const category of SX.categories) {
      const defs = paletteDefs(category.id).filter(d => {
        if (d.kind === 'module') return [d.module.name, d.module.label, d.module.description].some(s => s?.toLowerCase().includes(q));
        if (d.kind === 'pill') return d.keyword.includes(q.replace(/ /g, '_'));
        if (d.kind === 'reporter') return d.name.toLowerCase().includes(q);
        if (d.kind) return (d.role || d.kind).includes(q);
        return false;
      });
      if (defs.length) groups.push(el('div', { class: 'pal-search-group' }, [el('span', { class: 'color-square', style: `--c: ${category.color}` }), category.name]), ...defs.map(paletteEntry));
    }
    return groups.length ? groups : [el('p', { class: 'palette-note', text: `Nothing matches “${query}”. Use a generic module block below for anything else.` })];
  }

  function renderPalette() {
    const category = SX.category(state.category);
    const isModuleCategory = !['plays', 'control', 'variables', 'roles'].includes(category.id);
    const collections = [...new Set(SX.allModules().filter(m => m.category === category.id).map(m => m.collection))];
    const content = state.search ? searchResults(state.search) : [
      el('div', { class: 'palette-cat' }, [
        el('div', { class: 'palette-cat-name' }, [el('span', { class: 'color-square', style: `--c: ${category.color}` }), category.name]),
        el('span', { class: 'palette-cat-sub', text: category.sub || collections.join(' · ') || 'no module sets' })
      ]),
      ...paletteDefs(category.id).map(paletteEntry)
    ];
    if (state.search || isModuleCategory) {
      content.push(el('div', { class: 'palette-head', style: 'display: flex; flex-direction: column; gap: 10px' }, [
        el('div', { class: 'section-label', text: 'Not in the catalog?' }),
        paletteEntry({ kind: 'generic' }),
        el('p', { class: 'palette-note', text: 'Any module works as a generic block — keys and values pass through to YAML untouched.' })
      ]));
    }
    refs.paletteScroll.replaceChildren(...content);
    refs.collection.replaceChildren(...collectionOptions());
    refs.palette.classList.toggle('closed', !state.paletteOpen);
  }

  function collectionOptions() {
    const opts = [el('option', { value: 'all', text: 'All installed', selected: state.collection === 'all' })];
    for (const set of SX.moduleSets) opts.push(el('option', { value: set.collection, text: set.collection, selected: state.collection === set.collection }));
    opts.push(el('option', { value: '__add__', text: 'Add module set…' }), el('option', { value: '__manage__', text: 'Manage module sets…' }));
    return opts;
  }

  async function onCollection(value) {
    if (value === '__add__') {
      refs.collection.value = state.collection;
      const [file] = await ui.pickFiles({ accept: '.js,.json', multiple: false });
      if (!file) return;
      try {
        const set = SX.addUserModuleSet(await file.text());
        ui.toast(`Added ${set.collection} — ${SX.plural(set.modules.length, 'module')}.`);
        state.collection = set.collection;
        lintCache = null;
        render();
      } catch (error) {
        ui.dialog({ title: 'Couldn’t add that module set', body: el('p', { class: 'empty-note', text: error.message }), actions: [{ label: 'OK', primary: true }] });
      }
      return;
    }
    if (value === '__manage__') {
      refs.collection.value = state.collection;
      manageModuleSets();
      return;
    }
    state.collection = value;
    savePrefs();
    renderPalette();
  }

  function manageModuleSets() {
    const list = el('div', { class: 'list' }, SX.moduleSets.map(set => el('div', { class: 'list-row' }, [
      el('div', { class: 'row-main' }, [
        el('span', { class: 'row-title', text: set.collection }),
        el('span', { class: 'row-sub', text: `${set.title} · ${SX.plural(set.modules.length, 'module')}${set.version ? ` · ${set.version}` : ''} · ${set.source === 'added' ? 'added in this browser' : 'bundled in modules/'}` })
      ]),
      set.source === 'added' ? el('button', {
        class: 'btn btn-sm', type: 'button', text: 'Remove',
        onclick: () => { SX.removeUserModuleSet(set.collection); ui.closeMenu(); document.querySelector('dialog.dialog')?.close(); lintCache = null; render(); }
      }) : null
    ])));
    ui.dialog({
      title: 'Module sets',
      body: [list, el('p', { class: 'field-hint', text: 'Bundled sets are files in modules/ listed in modules/index.js. Build new ones from ansible-doc with tools/build-module-set.py, then add them here or to that folder.' })],
      actions: [{ label: 'Done', primary: true }]
    });
  }

  // ---- Canvas -----------------------------------------------------------------------------

  function groupsFor() {
    const inv = SX.activeInventory(project());
    return ['all', ...(inv?.groups.filter(g => g.name !== 'all').map(g => g.name) || [])];
  }

  function blockContext(play) {
    const p = project();
    return {
      readOnly: readOnly(), selectedId: state.selectedId, issues: lint().byNode, project: p, play,
      handlers: play ? SX.handlerNames(play) : [], groups: groupsFor(),
      notifyCount: handler => {
        let count = 0;
        if (!play) return 0;
        const names = [handler.name, handler.kw.listen].filter(Boolean).map(String);
        SX.walk(['pre_tasks', 'tasks', 'post_tasks', 'handlers'].flatMap(s => play[s]), n => {
          if ([].concat(n.kw?.notify || []).some(t => names.includes(String(t)))) count++;
        });
        return count;
      },
      select: (id, { focus } = {}) => { state.focus = focus || null; select(id); },
      edit: (id, change, typingKey) => editNode(id, change, typingKey, 'canvas'),
      toggleSection: (id, section) => store.commit(p2 => { const n = SX.findNode(p2, id); n.ui.collapsed[section] = !n.ui.collapsed[section]; }, { checkpoint: false, source: 'layout' }),
      openMenu: (node, anchor) => playMenu(node, anchor)
    };
  }

  function makeBlocksDraggable(container) {
    if (readOnly()) return;
    container.querySelectorAll('[data-id][data-type]').forEach(element => {
      if (element.closest('.drag-ghost')) return;
      SX.DnD.attach(element, () => ({ kind: 'move', type: element.dataset.type, id: element.dataset.id }));
    });
  }

  function roleContext(role) {
    const ctx = blockContext(null);
    ctx.handlers = SX.handlerNames({ handlers: role.handlers });
    ctx.notifyCount = handler => {
      const names = [handler.name, handler.kw.listen].filter(Boolean).map(String);
      let count = 0;
      SX.walk([...role.tasks, ...role.handlers], n => { if ([].concat(n.kw?.notify || []).some(t => names.includes(String(t)))) count++; });
      return count;
    };
    return ctx;
  }

  function renderRoleCanvas(role) {
    const ctx = roleContext(role);
    const column = el('div', { class: 'stage-item', style: 'left: 32px; top: 24px; gap: 44px' }, [B.roleFile(role, 'tasks', ctx), B.roleFile(role, 'handlers', ctx)]);
    refs.stage.replaceChildren(column);
    makeBlocksDraggable(refs.stage);
    refs.empty.hidden = true;
    const width = column.offsetWidth + 480, height = column.offsetHeight + 360;
    refs.stage.style.width = `${width}px`;
    refs.stage.style.height = `${height}px`;
    refs.stage.style.transform = `scale(${state.zoom})`;
    refs.sizer.style.width = `${width * state.zoom}px`;
    refs.sizer.style.height = `${height * state.zoom}px`;
    refs.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function renderCanvas() {
    if (roleMode()) {
      renderRoleCanvas(doc().role);
      return;
    }
    const pb = playbook();
    const items = pb.items.map(item => {
      const wrapper = el('div', { class: 'stage-item', data: { id: item.id } }, B.render(item, blockContext(item.type === 'play' ? item : null)));
      if (item.pos) {
        wrapper.style.left = `${item.pos.x}px`;
        wrapper.style.top = `${item.pos.y}px`;
      }
      return wrapper;
    });
    refs.stage.replaceChildren(...items);
    makeBlocksDraggable(refs.stage);
    refs.empty.hidden = pb.items.length > 0;
    layoutStage();
    refs.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  // Places items without a position below the others and nudges overlapping plays apart.
  function layoutStage() {
    const pb = playbook();
    const wrappers = [...refs.stage.children];
    const boxes = wrappers.map(w => {
      const item = pb.items.find(i => i.id === w.dataset.id);
      return { w, item, h: w.offsetHeight, wid: w.offsetWidth };
    });
    let changed = false;
    let bottom = 0;
    const placed = boxes.filter(b => b.item.pos).sort((a, b) => a.item.pos.y - b.item.pos.y);
    for (const b of boxes.filter(b => !b.item.pos)) {
      const maxBottom = Math.max(bottom, ...placed.map(p => p.item.pos.y + p.h));
      b.item.pos = { x: 32, y: placed.length || bottom ? maxBottom + 40 : 24 };
      placed.push(b);
      bottom = b.item.pos.y + b.h;
      changed = true;
    }
    placed.sort((a, b) => a.item.pos.y - b.item.pos.y);
    for (let i = 0; i < placed.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = placed[j].item.pos, b = placed[i].item.pos;
        const overlapX = b.x < a.x + placed[j].wid && b.x + placed[i].wid > a.x;
        if (overlapX && b.y < a.y + placed[j].h + 24 && b.y + placed[i].h > a.y) {
          b.y = a.y + placed[j].h + 32;
          changed = true;
        }
      }
    }
    let width = 0, height = 0;
    for (const b of boxes) {
      b.w.style.left = `${b.item.pos.x}px`;
      b.w.style.top = `${b.item.pos.y}px`;
      width = Math.max(width, b.item.pos.x + b.wid);
      height = Math.max(height, b.item.pos.y + b.h);
    }
    width += 480;
    height += 360;
    refs.stage.style.width = `${width}px`;
    refs.stage.style.height = `${height}px`;
    refs.stage.style.transform = `scale(${state.zoom})`;
    refs.sizer.style.width = `${width * state.zoom}px`;
    refs.sizer.style.height = `${height * state.zoom}px`;
    if (changed && !readOnly()) store.persist();
  }

  function setZoom(zoom) {
    state.zoom = Math.min(1.6, Math.max(0.4, Math.round(zoom * 10) / 10));
    savePrefs();
    if (roleMode()) renderCanvas();
    else layoutStage();
    refs.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function fitToScreen() {
    if (!refs.stage.children.length) return;
    const wrappers = [...refs.stage.children];
    const right = Math.max(...wrappers.map(w => w.offsetLeft + w.offsetWidth)) + 32;
    const bottom = Math.max(...wrappers.map(w => w.offsetTop + w.offsetHeight)) + 32;
    const box = refs.scroll.getBoundingClientRect();
    setZoom(Math.min(1, box.width / right, box.height / bottom));
    refs.scroll.scrollTo(0, 0);
  }

  function playMenu(node, anchor) {
    const items = [
      { label: node.ui.show.pre_tasks || node.pre_tasks.length ? 'Hide pre_tasks' : 'Show pre_tasks', disabled: node.pre_tasks.length > 0, onClick: () => store.commit(p => { const n = SX.findNode(p, node.id); n.ui.show.pre_tasks = !n.ui.show.pre_tasks; }, { source: 'layout' }) },
      { label: node.ui.show.post_tasks || node.post_tasks.length ? 'Hide post_tasks' : 'Show post_tasks', disabled: node.post_tasks.length > 0, onClick: () => store.commit(p => { const n = SX.findNode(p, node.id); n.ui.show.post_tasks = !n.ui.show.post_tasks; }, { source: 'layout' }) },
      'sep',
      ...nodeActions(node)
    ];
    ui.menu(anchor, items, { align: 'right' });
  }

  function nodeActions(node) {
    return [
      { label: 'Duplicate', hint: '⌘D', onClick: () => duplicate(node.id) },
      { label: 'Copy YAML', onClick: async () => ui.toast(await ui.copy(A.fragmentYaml(node, project().settings).text) ? 'Copied the YAML.' : 'Could not copy.') },
      'sep',
      { label: 'Delete', hint: '⌫', danger: true, onClick: () => remove(node.id) }
    ];
  }

  function duplicate(id) {
    if (readOnly()) return;
    let copyId = null;
    store.commit(p => {
      const loc = SX.locate(p, id);
      if (!loc) return;
      const copy = SX.clone(loc.node);
      SX.walk([copy], n => { n.id = SX.uid(); });
      if (copy.pos) copy.pos = { x: copy.pos.x + 40, y: copy.pos.y + 40 };
      loc.list.splice(loc.index + 1, 0, copy);
      copyId = copy.id;
    }, { source: 'action' });
    if (copyId) select(copyId);
  }

  function remove(id) {
    if (readOnly()) return;
    store.commit(p => { const loc = SX.locate(p, id); if (loc) loc.list.splice(loc.index, 1); }, { source: 'action' });
    if (state.selectedId === id) state.selectedId = null;
    render();
    ui.toast('Deleted.', { action: { label: 'Undo', onClick: () => store.undo() } });
  }

  // Selection changes classes in place (no canvas re-render), so a focused slot keeps focus.
  function select(id) {
    state.selectedId = id;
    refs.stage.querySelectorAll('.selected').forEach(n => n.classList.remove('selected'));
    if (id) refs.stage.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('selected');
    renderInspector();
    if (state.category === 'variables') renderPalette();
  }

  // ---- YAML pane (Split and YAML views) ----------------------------------------------

  function renderYamlPane() {
    refs.yamlPane.hidden = state.view === 'blocks';
    refs.canvasWrap.hidden = state.view === 'yaml';
    refs.yamlPane.classList.toggle('full', state.view === 'yaml');
    refs.canvasTools.replaceChildren(state.view === 'yaml' ? '' : viewSwitch());
    refs.yamlTools.replaceChildren(state.view === 'yaml' ? viewSwitch() : '');
    if (state.view === 'blocks') return;
    if (document.activeElement === refs.yamlText) return;
    const yaml = roleMode() ? A.dump(A.taskList(doc().role.tasks, project().settings), project().settings) : A.playbookYaml(playbook(), project().settings);
    refs.yamlText.value = yaml.text;
    refs.yamlText.readOnly = readOnly();
    paintYaml(yaml.text);
    state.yamlError = yaml.problem;
    refs.yamlStatus.textContent = yaml.problem || (readOnly() ? 'Read-only view.' : 'Edit the YAML directly — valid changes update the blocks.');
    refs.yamlStatus.classList.toggle('error', !!yaml.problem);
    refs.yamlFile.textContent = doc().path;
    refs.yamlBadge.textContent = roleMode() ? 'Role tasks' : 'Playbook';
    refs.yamlBadge.style.setProperty('--c', roleMode() ? SX.category('roles').color : SX.category('plays').color);
  }

  function paintYaml(text) {
    const issuesByLine = new Map();
    const view = ui.codeView(text, { decorate: n => issuesByLine.get(n) });
    refs.yamlCode.replaceWith(view);
    refs.yamlCode = view;
    refs.yamlText.style.height = `${Math.max(view.scrollHeight, refs.yamlEditor.clientHeight)}px`;
    refs.yamlText.style.width = `${Math.max(view.scrollWidth, refs.yamlEditor.clientWidth)}px`;
  }

  const applyYaml = SX.debounce(text => {
    let parsed;
    try {
      parsed = roleMode() ? A.parseTasksText(text) : A.parsePlaybook(text);
    } catch (error) {
      state.yamlError = error.message.split('\n')[0];
      refs.yamlStatus.textContent = `Not applied: ${state.yamlError}`;
      refs.yamlStatus.classList.add('error');
      renderStatus();
      return;
    }
    state.yamlError = null;
    refs.yamlStatus.textContent = parsed.problems.length ? `Applied, with notes: ${parsed.problems.join(' ')}` : 'Applied to the blocks.';
    refs.yamlStatus.classList.remove('error');
    store.typing('yaml-editor', p => {
      const current = SX.activeDoc(p);
      if (current.kind === 'role') {
        current.role.tasks = parsed.items;
        return;
      }
      const pb = current.playbook;
      parsed.items.forEach((item, i) => {
        const old = pb.items[i];
        if (old?.pos) item.pos = old.pos;
        if (old?.ui && item.ui) item.ui.collapsed = old.ui.collapsed;
      });
      pb.items = parsed.items;
    }, 'yaml');
  }, 450);

  // ---- Inspector -------------------------------------------------------------------------

  function inspectorEdit(id, change, typingKey) {
    editNode(id, change, typingKey, 'inspector');
  }

  function issueCallouts(node) {
    const issues = (lint().byNode.get(node.id) || []);
    if (!issues.length) return null;
    return el('div', { class: 'panel-section' }, [
      el('div', { class: 'issue-list' }, issues.map(issue => el('div', { class: `callout ${issue.severity === 'error' ? 'error' : 'warn'}` }, [
        icon(issue.severity === 'error' ? 'info' : 'warning', 16),
        el('div', { class: 'callout-body' }, [
          el('span', { text: issue.message }),
          issue.fix && !readOnly() ? el('button', {
            class: 'btn btn-sm btn-warn', type: 'button', text: issue.fix.label, style: 'align-self: flex-start',
            onclick: () => inspectorEdit(node.id, n => issue.fix.apply(n))
          }) : null
        ])
      ])))
    ]);
  }

  function yamlSection(node) {
    const yaml = A.fragmentYaml(node, project().settings);
    return el('div', { class: 'panel-section' }, [
      el('div', { class: 'panel-title-row' }, [
        el('h3', { class: 'panel-title', text: 'YAML' }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => ui.toast(await ui.copy(yaml.text) ? 'Copied the YAML.' : 'Could not copy.') }, [icon('copy', 14), 'Copy'])
      ]),
      ui.codeView(yaml.text, { compact: true })
    ]);
  }

  function inspectorHead(node, { category, title, fqcn, description, count, docs }) {
    return el('div', { class: 'insp-head' }, [
      el('div', { class: 'insp-meta' }, [
        el('span', { class: 'cat-chip', style: `--c: ${category.color}`, text: category.name }),
        count ? el('span', { class: 'count', text: count }) : null,
        el('span', { class: 'grow' }),
        docs ? el('a', { class: 'icon-btn sm', href: docs, target: '_blank', rel: 'noopener', title: 'Module documentation', attrs: { 'aria-label': 'Module documentation' } }, icon('book', 17)) : null,
        readOnly() ? null : el('button', {
          class: 'icon-btn sm', type: 'button', title: 'More actions', attrs: { 'aria-label': 'More actions' },
          onclick: e => ui.menu(e.currentTarget, nodeActions(node), { align: 'right' })
        }, icon('more', 16))
      ]),
      el('div', { style: 'display: flex; flex-direction: column; gap: 5px' }, [
        el('h2', { class: 'insp-title', text: title }),
        fqcn ? el('span', { class: 'insp-fqcn', text: fqcn }) : null
      ]),
      description ? el('p', { class: 'insp-desc', text: description }) : null
    ]);
  }

  function input(value, onInput, { mono = true, placeholder = '', focusKey, list } = {}) {
    const node = el('input', { class: `input${mono ? '' : ' ui'}`, value: value ?? '', placeholder, readOnly: readOnly(), attrs: { list, spellcheck: 'false' }, oninput: e => onInput(e.target.value) });
    if (focusKey) node.dataset.focus = focusKey;
    return node;
  }

  function argEditor(node, module, name) {
    const spec = SX.argSpec(module, name);
    const value = node.args[name];
    const typingKey = `${node.id}:arg:${name}`;
    const set = next => inspectorEdit(node.id, n => { if (A.isEmpty(next)) delete n.args[name]; else n.args[name] = next; }, typingKey);
    const label = name === '_raw' ? 'free-form' : name;
    const field = (control, hint) => {
      const node2 = ui.field(label, control, { mono: true, required: spec?.required, hint });
      if (spec?.doc) node2.querySelector('label').title = spec.doc;
      return node2;
    };
    const kind = spec?.kind;
    if (kind === 'bool' && (value === undefined || typeof A.typedScalar(value) === 'boolean')) {
      const id = ui.fieldId();
      const on = value === undefined ? !!spec.default : A.typedScalar(value) === true;
      return el('div', { class: 'inline-field', title: spec.doc }, [
        el('span', { class: 'field-label mono', id, text: label }),
        readOnly() ? el('span', { class: 'pill', text: String(on) }) : ui.switchEl(on, next => inspectorEdit(node.id, n => { if (next === !!spec.default) delete n.args[name]; else n.args[name] = next; }), id)
      ]);
    }
    if (kind === 'choice' && (value === undefined || spec.choices.includes(String(value)))) {
      const select = ui.select([['', spec.default ? `${spec.default} (default)` : '—'], ...spec.choices.map(c => [c, c])], value ?? '', v => set(v), { cls: 'select tall mono' });
      select.disabled = readOnly();
      select.dataset.focus = `arg:${name}`;
      return field(select);
    }
    if (kind === 'list' || Array.isArray(value) && value.every(v => typeof v !== 'object' || v === null)) {
      const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
      const area = el('textarea', {
        class: 'textarea', value: text, rows: Math.min(8, Math.max(2, text.split('\n').length + 1)), placeholder: 'One per line', readOnly: readOnly(),
        oninput: e => set(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))
      });
      area.dataset.focus = `arg:${name}`;
      return field(area);
    }
    if (kind === 'yaml' || (value !== null && typeof value === 'object')) {
      const text = A.isEmpty(value) ? '' : window.jsyaml.dump(value, A.yamlOptions()).trimEnd();
      const area = el('textarea', {
        class: 'textarea', value: text, rows: Math.min(12, Math.max(3, text.split('\n').length + 1)), placeholder: 'YAML', readOnly: readOnly(),
        oninput: e => {
          try {
            const parsed = e.target.value.trim() ? window.jsyaml.load(e.target.value, { schema: window.jsyaml.CORE_SCHEMA }) : null;
            e.target.classList.remove('invalid');
            set(parsed);
          } catch (error) {
            e.target.classList.add('invalid');
            e.target.title = error.message;
          }
        }
      });
      area.dataset.focus = `arg:${name}`;
      return field(area);
    }
    return field(input(value, v => set(v), { focusKey: `arg:${name}` }));
  }

  function moduleSelect(node) {
    const groups = SX.categories.map(c => ({ group: c.name, options: SX.allModules().filter(m => m.category === c.id).map(m => [m.name, `${m.short} — ${m.collection}`]) })).filter(g => g.options.length);
    if (node.module && !SX.module(node.module)) groups.unshift({ group: 'Not installed', options: [[node.module, node.module]] });
    const select = ui.select(groups, node.module, value => changeModule(node.id, value), { cls: 'select tall mono', label: 'Module' });
    select.disabled = readOnly();
    return select;
  }

  // Keeps arguments you changed if the new module accepts them; the rest start from its defaults.
  function changeModule(id, moduleName) {
    let dropped = [];
    editNode(id, n => {
      const next = SX.module(moduleName);
      const oldDefaults = SX.module(n.module)?.defaults || {};
      const args = SX.clone(next?.defaults || {});
      dropped = [];
      for (const [name, value] of Object.entries(n.args)) {
        if (JSON.stringify(value) === JSON.stringify(oldDefaults[name])) continue;
        if (!next || next.freeArgs || SX.argSpec(next, name)) args[name] = value;
        else dropped.push(name);
      }
      n.module = moduleName;
      n.args = args;
    }, null, 'action');
    if (dropped.length) ui.toast(`${moduleName} has no ${dropped.join(', ')} option, so ${dropped.length > 1 ? 'they were' : 'it was'} removed.`, { action: { label: 'Undo', onClick: () => store.undo() } });
  }

  function keywordEditor(node, key) {
    const spec = SX.keywordSpec(key);
    const value = node.kw[key];
    const typingKey = `${node.id}:kw:${key}`;
    const set = next => inspectorEdit(node.id, n => { n.kw[key] = next; }, typingKey);
    const removeBtn = readOnly() ? null : el('button', { class: 'icon-btn sm kw-remove', type: 'button', title: `Remove ${key}`, attrs: { 'aria-label': `Remove ${key}` }, onclick: () => inspectorEdit(node.id, n => { delete n.kw[key]; }) }, icon('x', 11));
    let control;
    if (spec.kind === 'handlers') {
      const play = SX.playOf(project(), node.id);
      const handlers = play ? SX.handlerNames(play) : SX.handlerNames({ handlers: project().roles.find(r => SX.locate({ playbooks: [], roles: [r] }, node.id))?.handlers || [] });
      const current = [].concat(value || []);
      control = el('div', { class: 'chip-row' }, [
        ...current.map((h, i) => el('span', { class: 'chip notify' }, [h, readOnly() ? null : el('button', { type: 'button', attrs: { 'aria-label': `Remove ${h}` }, onclick: () => inspectorEdit(node.id, n => { const list = [].concat(n.kw.notify); list.splice(i, 1); if (list.length) n.kw.notify = list; else delete n.kw.notify; }) }, icon('x', 10))])),
        readOnly() ? null : ui.select([['', '+ handler'], ...handlers.filter(h => !current.includes(h)).map(h => [h, h]), ['__new__', 'New handler…']], '', async v => {
          if (!v) return;
          if (v === '__new__') {
            const name = await ui.prompt('New handler', { label: 'Handler name', placeholder: 'restart nginx', mono: false });
            if (!name) { renderInspector(); return; }
            store.commit(p => {
              const n = SX.findNode(p, node.id);
              n.kw.notify = [...[].concat(n.kw.notify || []).filter(Boolean), name];
              const play2 = SX.playOf(p, node.id);
              if (play2 && !SX.handlerNames(play2).includes(name)) {
                play2.handlers.push(SX.newTask('ansible.builtin.service', { name, args: { name: '', state: 'restarted' } }));
                play2.ui.collapsed.handlers = false;
              }
            }, { source: 'inspector' });
            return;
          }
          inspectorEdit(node.id, n => { n.kw.notify = [...[].concat(n.kw.notify || []).filter(Boolean), v]; });
        }, { cls: 'select', label: 'Add a handler to notify' })
      ]);
    } else if (spec.kind === 'list') {
      const current = [].concat(value || []);
      const add = el('input', {
        class: 'chip-input', placeholder: '+ add', attrs: { 'aria-label': `Add to ${key}` }, readOnly: readOnly(),
        onkeydown: e => {
          if (e.key !== 'Enter' && e.key !== ',') return;
          e.preventDefault();
          const v = e.target.value.trim();
          if (v) inspectorEdit(node.id, n => { n.kw[key] = [...[].concat(n.kw[key] || []), v]; });
        }
      });
      add.dataset.focus = `kw:${key}`;
      control = el('div', { class: 'chip-row' }, [
        ...current.map((t, i) => el('span', { class: 'chip removable' }, [String(t), readOnly() ? null : el('button', { type: 'button', attrs: { 'aria-label': `Remove ${t}` }, onclick: () => inspectorEdit(node.id, n => { const list = [].concat(n.kw[key]); list.splice(i, 1); n.kw[key] = list; }) }, icon('x', 10))])),
        readOnly() ? null : add
      ]);
    } else if (spec.kind === 'bool') {
      const select = ui.select([['true', 'yes'], ['false', 'no']], String(A.typedScalar(value) === true), v => set(v === 'true'), { cls: 'select' });
      select.disabled = readOnly();
      control = select;
    } else if (spec.kind === 'cond' && Array.isArray(value)) {
      control = el('textarea', { class: 'textarea', value: value.join('\n'), rows: value.length + 1, readOnly: readOnly(), oninput: e => { const lines = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); set(lines.length > 1 ? lines : lines[0] || ''); } });
    } else if (spec.kind === 'yaml' || (value !== null && typeof value === 'object')) {
      control = el('textarea', {
        class: 'textarea', value: A.isEmpty(value) ? '' : window.jsyaml.dump(value, A.yamlOptions()).trimEnd(), rows: 3, readOnly: readOnly(), placeholder: 'YAML',
        oninput: e => { try { set(e.target.value.trim() ? window.jsyaml.load(e.target.value, { schema: window.jsyaml.CORE_SCHEMA }) : ''); e.target.classList.remove('invalid'); } catch (error) { e.target.classList.add('invalid'); } }
      });
    } else {
      control = input(value, set, { focusKey: `kw:${key}`, placeholder: spec.kind === 'cond' ? "app_env == 'production'" : spec.kind === 'expr' ? '{{ items }}' : '' });
    }
    if (control.dataset && !control.dataset.focus) control.dataset.focus = `kw:${key}`;
    return [el('label', { text: key }), el('div', { style: 'display: flex; gap: 6px; align-items: center; min-width: 0' }, [el('div', { style: 'flex: 1; min-width: 0' }, control), removeBtn])];
  }

  function keywordsSection(node, setName, exclude = []) {
    const present = Object.keys(node.kw).filter(k => !exclude.includes(k));
    const quick = setName === 'task' ? [['when', '+ Add condition'], ['register', '+ Save result as variable']] : setName === 'block' ? [['when', '+ Add condition']] : [];
    const rows = [];
    for (const key of present) rows.push(...keywordEditor(node, key));
    if (!readOnly()) {
      for (const [key, label] of quick) {
        if (present.includes(key)) continue;
        rows.push(el('span', { text: key }), el('button', { class: 'dashed-btn', type: 'button', text: label, onclick: () => { state.focus = `kw:${key}`; inspectorEdit(node.id, n => { n.kw[key] = ''; }); } }));
      }
    }
    const remaining = SX.KEYWORD_SETS[setName].filter(k => !present.includes(k) && !exclude.includes(k) && !quick.some(([q]) => q === k));
    return el('div', { class: 'panel-section' }, [
      el('h3', { class: 'panel-title', text: setName === 'play' ? 'Play keywords' : setName === 'block' ? 'Block keywords' : setName === 'role' ? 'Role keywords' : 'Task keywords' }),
      rows.length ? el('div', { class: 'kw-grid' }, rows) : null,
      readOnly() ? null : ui.select([['', '+ Add keyword…'], ...remaining.map(k => [k, k]), ['__other__', 'Other…']], '', async v => {
        if (!v) return;
        let key = v;
        if (v === '__other__') {
          key = await ui.prompt('Add keyword', { label: 'Keyword', placeholder: 'e.g. async' });
          if (!key) { renderInspector(); return; }
        }
        const spec = SX.keywordSpec(key);
        state.focus = `kw:${key}`;
        inspectorEdit(node.id, n => { n.kw[key] = spec.kind === 'list' || spec.kind === 'handlers' ? [] : spec.kind === 'bool' ? true : ''; });
      }, { cls: 'select', label: 'Add a keyword' })
    ]);
  }

  function inspectTask(node) {
    const module = SX.module(node.module);
    const category = module ? SX.category(module.category) : SX.category('generic');
    const loc = SX.locate(project(), node.id);
    const all = [];
    SX.walk(roleMode() ? [...doc().role.tasks, ...doc().role.handlers] : playbook().items, n => { if (n.type === 'task') all.push(n.id); });
    const index = all.indexOf(node.id);
    const head = inspectorHead(node, {
      category, title: module ? module.short : node.module ? node.module.split('.').pop() : 'Generic module',
      fqcn: node.module || 'no module set', description: module?.description ? `${module.description}.` : node.module ? 'This module isn’t in an installed module set, so its parameters are kept exactly as written.' : 'Name any module — namespace.collection.module.',
      count: index >= 0 ? `Task ${index + 1} of ${all.length}` : loc?.section === 'handlers' ? 'Handler' : null, docs: SX.docsUrl(module?.name || node.module)
    });
    const nameField = ui.field('Task name', input(node.name, v => inspectorEdit(node.id, n => { n.name = v; }, `${node.id}:name`), { mono: false, placeholder: 'Describe what this task does', focusKey: 'name' }));
    const moduleField = module
      ? ui.field('Module', moduleSelect(node))
      : ui.field('Module', input(node.module, v => inspectorEdit(node.id, n => { n.module = v.trim(); }, `${node.id}:module`), { placeholder: 'namespace.collection.module', focusKey: 'module' }), { hint: SX.module(node.module) ? 'Installed — reselect to use typed slots.' : undefined });
    const params = el('div', { class: 'panel-section' });
    params.append(el('div', { class: 'panel-title-row' }, [el('h3', { class: 'panel-title', text: 'Parameters' }), el('span', { class: 'field-hint' }, [el('span', { style: 'color: var(--required)', text: '*' }), ' required'])]));
    if (module && !module.freeArgs) {
      const specs = Object.keys(module.args);
      const isSet = name => node.args[name] !== undefined || (module.args[name].aliases || []).some(a => node.args[a] !== undefined);
      const rank = name => module.palette.includes(name) ? module.palette.indexOf(name) : module.args[name].required ? 100 : isSet(name) ? 200 : 300;
      const shown = specs.filter(name => state.showAllParams || module.args[name].required || module.palette.includes(name) || isSet(name))
        .sort((a, b) => rank(a) - rank(b) || specs.indexOf(a) - specs.indexOf(b));
      const trio = ['owner', 'group', 'mode'];
      const grid = trio.every(n => shown.includes(n)) ? el('div', { class: 'field-grid' }, trio.map(n => argEditor(node, module, n))) : null;
      for (const name of shown) {
        if (grid && trio.includes(name)) {
          if (name === 'owner') params.append(grid);
          continue;
        }
        params.append(argEditor(node, module, name));
      }
      const unknown = Object.keys(node.args).filter(name => !SX.argSpec(module, name));
      for (const name of unknown) params.append(otherArg(node, name));
      if (specs.length > shown.length || state.showAllParams) {
        params.append(el('button', { class: 'link-btn', type: 'button', onclick: () => { state.showAllParams = !state.showAllParams; renderInspector(); } }, [state.showAllParams ? 'Show fewer parameters' : `Show all parameters (${specs.length})`, icon(state.showAllParams ? 'chevronRight' : 'chevronDown', 10)]));
      }
    } else {
      for (const name of Object.keys(node.args)) params.append(otherArg(node, name));
      if (!readOnly()) {
        params.append(el('button', {
          class: 'dashed-btn', type: 'button', text: '+ Add parameter', onclick: async () => {
            const name = await ui.prompt('Add parameter', { label: 'Parameter name' });
            if (name) { state.focus = `arg:${name}`; inspectorEdit(node.id, n => { n.args[name] = ''; }); }
          }
        }));
      }
    }
    return [head, el('div', { class: 'panel-section' }, [nameField, moduleField]), params, keywordsSection(node, 'task'), issueCallouts(node), yamlSection(node)];
  }

  function otherArg(node, name) {
    const value = node.args[name];
    const control = value !== null && typeof value === 'object'
      ? el('textarea', { class: 'textarea', value: window.jsyaml.dump(value, A.yamlOptions()).trimEnd(), rows: 3, readOnly: readOnly(), oninput: e => { try { const v = window.jsyaml.load(e.target.value, { schema: window.jsyaml.CORE_SCHEMA }); e.target.classList.remove('invalid'); inspectorEdit(node.id, n => { n.args[name] = v; }, `${node.id}:arg:${name}`); } catch (error) { e.target.classList.add('invalid'); } } })
      : input(value, v => inspectorEdit(node.id, n => { n.args[name] = v; }, `${node.id}:arg:${name}`), { focusKey: `arg:${name}` });
    return el('div', { class: 'field' }, [
      el('div', { class: 'panel-title-row' }, [el('span', { class: 'field-label mono', text: name }), readOnly() ? null : el('button', { class: 'icon-btn sm', type: 'button', attrs: { 'aria-label': `Remove ${name}` }, onclick: () => inspectorEdit(node.id, n => { delete n.args[name]; }) }, icon('x', 11))]),
      control
    ]);
  }

  function varEditor(play) {
    return ui.varRows(play.vars, {
      keyPrefix: play.id,
      onEdit: (id, change, key) => inspectorEdit(id, n => Object.assign(n, change), key),
      onRemove: id => store.commit(p => { const loc = SX.locate(p, id); if (loc) loc.list.splice(loc.index, 1); }, { source: 'inspector' }),
      onAdd: () => store.commit(p => { const n = SX.findNode(p, play.id); n.vars.push(SX.newVar('new_var', '')); n.ui.collapsed.vars = false; }, { source: 'inspector' })
    });
  }

  function inspectPlay(node) {
    const groups = groupsFor();
    const hostsInput = input(node.hosts, v => inspectorEdit(node.id, n => { n.hosts = v; }, `${node.id}:hosts`), { list: 'host-groups', focusKey: 'hosts' });
    const switchRow = (key, label, defaultOn) => {
      const id = ui.fieldId();
      const on = node.kw[key] === undefined ? defaultOn : A.typedScalar(node.kw[key]) === true;
      return el('div', { class: 'inline-field' }, [el('span', { class: 'field-label', id, text: label }), readOnly() ? el('span', { class: 'pill', text: on ? 'yes' : 'no' }) : ui.switchEl(on, v => inspectorEdit(node.id, n => { n.kw[key] = v; }), id)]);
    };
    return [
      inspectorHead(node, { category: SX.category('plays'), title: node.name || 'Unnamed play', fqcn: `${playbook().path} · play`, description: 'A play runs its roles, then its tasks, against the hosts it targets. Handlers run once at the end when notified.' }),
      el('div', { class: 'panel-section' }, [
        ui.field('Play name', input(node.name, v => inspectorEdit(node.id, n => { n.name = v; }, `${node.id}:name`), { mono: false, focusKey: 'name' })),
        ui.field('Hosts', hostsInput, { hint: 'A group from the inventory, a host, or a pattern.' }),
        el('datalist', { id: 'host-groups' }, groups.map(g => el('option', { value: g }))),
        switchRow('become', 'Run with privilege escalation (become)', false),
        switchRow('gather_facts', 'Gather facts', true),
        ui.field('Connection', input(node.kw.connection, v => inspectorEdit(node.id, n => { if (v) n.kw.connection = v; else delete n.kw.connection; }, `${node.id}:connection`), { list: 'connections', placeholder: 'default (ssh)' })),
        el('datalist', { id: 'connections' }, ['ansible.netcommon.network_cli', 'ansible.netcommon.httpapi', 'ansible.netcommon.netconf', 'ssh', 'local'].map(c => el('option', { value: c })))
      ]),
      el('div', { class: 'panel-section' }, [el('h3', { class: 'panel-title', text: 'Play vars' }), varEditor(node)]),
      keywordsSection(node, 'play', ['become', 'gather_facts', 'connection']),
      issueCallouts(node),
      yamlSection(node)
    ];
  }

  function inspectBlock(node) {
    return [
      inspectorHead(node, { category: SX.category('control'), title: 'block', fqcn: 'block · rescue · always', description: 'Groups tasks so keywords apply to all of them. If a task fails, rescue runs; always runs either way.' }),
      el('div', { class: 'panel-section' }, [ui.field('Block name', input(node.name, v => inspectorEdit(node.id, n => { n.name = v; }, `${node.id}:name`), { mono: false, focusKey: 'name' }))]),
      keywordsSection(node, 'block'), issueCallouts(node), yamlSection(node)
    ];
  }

  function inspectVar(node) {
    const value = node.value;
    const valueControl = value !== null && typeof value === 'object'
      ? el('textarea', { class: 'textarea', value: window.jsyaml.dump(value, A.yamlOptions()).trimEnd(), rows: 4, readOnly: readOnly(), oninput: e => { try { const v = window.jsyaml.load(e.target.value, { schema: window.jsyaml.CORE_SCHEMA }); e.target.classList.remove('invalid'); inspectorEdit(node.id, n => { n.value = v; }, `${node.id}:value`); } catch (error) { e.target.classList.add('invalid'); } } })
      : input(value, v => inspectorEdit(node.id, n => { n.value = v; }, `${node.id}:value`), { focusKey: 'value' });
    return [
      inspectorHead(node, { category: SX.category('variables'), title: node.key || 'var', fqcn: 'play vars', description: 'Play variables are visible to every task, role and template in the play.' }),
      el('div', { class: 'panel-section' }, [
        ui.field('Name', input(node.key, v => inspectorEdit(node.id, n => { n.key = v; }, `${node.id}:key`), { focusKey: 'key' })),
        ui.field('Value', valueControl, { hint: 'yes/no and whole numbers become booleans and integers; everything else stays text.' })
      ]),
      yamlSection(node)
    ];
  }

  function inspectRole(node) {
    const role = project().roles.find(r => r.name === node.role);
    const vars = Object.entries(node.vars || {}).map(([key, value]) => ({ id: key, key, value }));
    return [
      inspectorHead(node, { category: SX.category('roles'), title: node.role || 'role', fqcn: role ? `roles/${role.name}` : 'not in this project', description: role?.description || 'Runs a role’s tasks before the play’s own tasks.' }),
      el('div', { class: 'panel-section' }, [
        ui.field('Role', input(node.role, v => inspectorEdit(node.id, n => { n.role = v; }, `${node.id}:role`), { list: 'project-roles', focusKey: 'role' })),
        el('datalist', { id: 'project-roles' }, project().roles.map(r => el('option', { value: r.name }))),
        role ? el('a', { class: 'link-btn', href: `#/roles/${encodeURIComponent(role.name)}` }, ['Open role', icon('forward', 12)]) : null
      ]),
      el('div', { class: 'panel-section' }, [
        el('h3', { class: 'panel-title', text: 'Role vars' }),
        role?.defaults.length ? el('p', { class: 'field-hint', text: `Defaults: ${role.defaults.map(d => d.key).join(', ')}` }) : null,
        ui.varRows(vars, {
          keyPrefix: node.id,
          onEdit: (key, change, typingKey) => inspectorEdit(node.id, n => {
            const entries = Object.entries(n.vars);
            const i = entries.findIndex(([k]) => k === key);
            if (i < 0) return;
            if ('key' in change) entries[i][0] = change.key;
            if ('value' in change) entries[i][1] = change.value;
            n.vars = Object.fromEntries(entries);
          }, typingKey),
          onRemove: key => inspectorEdit(node.id, n => { delete n.vars[key]; }),
          onAdd: () => inspectorEdit(node.id, n => { n.vars[role?.defaults.find(d => !(d.key in n.vars))?.key || `var_${Object.keys(n.vars).length + 1}`] = ''; }),
          addLabel: '+ Set a role variable'
        })
      ]),
      keywordsSection(node, 'role'), issueCallouts(node), yamlSection(node)
    ];
  }

  function inspectImport(node) {
    return [
      inspectorHead(node, { category: SX.category('plays'), title: 'import_playbook', fqcn: 'ansible.builtin.import_playbook', description: 'Includes another playbook’s plays at this point.' }),
      el('div', { class: 'panel-section' }, [ui.field('Playbook', input(node.path, v => inspectorEdit(node.id, n => { n.path = v; }, `${node.id}:path`), { focusKey: 'path', list: 'playbook-paths' })), el('datalist', { id: 'playbook-paths' }, project().playbooks.map(pb => el('option', { value: pb.path })))]),
      yamlSection(node)
    ];
  }

  function inspectNothing() {
    const p = project();
    const d = doc();
    const counts = countItems(d);
    const result = lint();
    const issues = result.issues.filter(i => i.where === d.where).slice(0, 12);
    if (d.kind === 'role') {
      return [
        el('div', { class: 'insp-empty' }, [
          el('h2', { text: `Role ${d.role.name}` }),
          el('p', { text: 'You’re editing this role’s tasks and handlers. Drag modules in from the palette; defaults, templates and dependencies live on the Roles page.' }),
          el('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap' }, [
            el('a', { class: 'btn btn-md', href: `#/roles/${encodeURIComponent(d.role.name)}`, text: 'Open on the Roles page' }),
            el('button', { class: 'btn btn-md', type: 'button', text: 'Back to the playbook', onclick: () => store.commit(p2 => SX.openPlaybook(p2, p2.activePlaybookId), { checkpoint: false }) })
          ])
        ]),
        el('div', { class: 'panel-section' }, [el('div', { class: 'stat-grid' }, [stat(counts.tasks, 'tasks'), stat(counts.handlers, 'handlers')])]),
        issues.length ? issueSection(issues) : null
      ];
    }
    return [
      el('div', { class: 'insp-empty' }, [
        el('h2', { text: readOnly() ? 'Read-only view' : 'Nothing selected' }),
        el('p', { text: readOnly() ? 'Click a block to see its parameters. Nothing here changes your project.' : 'Click a block to edit it, or drag one in from the palette. Double-click a palette block to add it to the selected play.' })
      ]),
      el('div', { class: 'panel-section' }, [
        el('h3', { class: 'panel-title', text: d.path }),
        el('div', { class: 'stat-grid' }, [
          stat(counts.plays, 'plays'), stat(counts.tasks, 'tasks'), stat(counts.handlers, 'handlers'), stat(p.roles.length, 'roles in project')
        ])
      ]),
      issues.length ? issueSection(issues) : null
    ];
  }

  function issueSection(issues) {
    return el('div', { class: 'panel-section' }, [
      el('h3', { class: 'panel-title', text: 'Checks' }),
      el('div', { class: 'issue-list' }, issues.map(issue => el('button', {
        class: `callout ${issue.severity === 'error' ? 'error' : 'warn'}`, type: 'button', style: 'border: 0; text-align: left; cursor: pointer',
        onclick: () => issue.nodeId && reveal(issue.nodeId)
      }, [icon(issue.severity === 'error' ? 'info' : 'warning', 16), el('span', { text: issue.message })])))
    ]);
  }

  const stat = (n, label) => el('div', { class: 'stat' }, [el('strong', { text: String(n) }), el('span', { text: label })]);

  function renderInspector() {
    const node = state.selectedId && SX.findNode(project(), state.selectedId);
    if (state.selectedId && !node) state.selectedId = null;
    const scrollTop = refs.inspector.scrollTop;
    const sameNode = refs.inspector.dataset.node === (node?.id || '');
    let content;
    if (!node) content = inspectNothing();
    else if (node.type === 'task') content = inspectTask(node);
    else if (node.type === 'play') content = inspectPlay(node);
    else if (node.type === 'block') content = inspectBlock(node);
    else if (node.type === 'var') content = inspectVar(node);
    else if (node.type === 'role') content = inspectRole(node);
    else content = inspectImport(node);
    refs.inspector.replaceChildren(...content.filter(Boolean));
    refs.inspector.dataset.node = node?.id || '';
    if (sameNode) refs.inspector.scrollTop = scrollTop;
    if (state.focus) {
      const target = refs.inspector.querySelector(`[data-focus="${CSS.escape(state.focus)}"]`);
      state.focus = null;
      if (target) {
        target.focus();
        target.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }

  // Shows and selects a node, opening collapsed sections on the way.
  function reveal(id) {
    const play = SX.playOf(project(), id);
    if (play && !readOnly()) {
      const loc = SX.locate(project(), id);
      let section = loc?.section;
      let owner = loc?.owner;
      while (owner && owner.type !== 'play') {
        const up = SX.locate(project(), owner.id);
        section = up?.section;
        owner = up?.owner;
      }
      if (section && play.ui.collapsed[section]) store.commit(p => { SX.findNode(p, play.id).ui.collapsed[section] = false; }, { checkpoint: false, source: 'layout' });
    }
    state.selectedId = id;
    render();
    refs.stage.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }
  SX.revealNode = reveal;

  // ---- Status bar ---------------------------------------------------------------------------

  function countItems(d) {
    const counts = { plays: 0, tasks: 0, handlers: 0, roles: 0 };
    if (d.kind === 'role') {
      SX.walk(d.role.tasks, n => { if (n.type === 'task') counts.tasks++; });
      SX.walk(d.role.handlers, n => { if (n.type === 'task') counts.handlers++; });
      return counts;
    }
    for (const item of d.playbook.items) {
      if (item.type !== 'play') continue;
      counts.plays++;
      counts.roles += item.roles.length;
      SX.walk([...item.pre_tasks, ...item.tasks, ...item.post_tasks], n => { if (n.type === 'task') counts.tasks++; });
      SX.walk(item.handlers, n => { if (n.type === 'task') counts.handlers++; });
    }
    return counts;
  }

  function renderStatus() {
    const d = doc();
    const counts = countItems(d);
    const result = lint();
    // Unnamed tasks are listed in the inspector and on export, but don't count toward the status bar.
    const here = result.issues.filter(i => i.where === d.where && (i.rule !== 'name-missing' || i.severity === 'error'));
    const errors = here.filter(i => i.severity === 'error').length;
    const warnings = here.length - errors;
    const builtin = SX.moduleSets.find(s => s.collection === 'ansible.builtin');
    refs.status.replaceChildren(...[
      readOnly()
        ? el('span', { class: 'item' }, [icon('eye', 13), 'Read-only'])
        : el('span', { class: 'item' }, [el('span', { class: 'dot', style: store.saved ? '' : 'background: var(--danger)' }), store.saved ? 'Saved' : 'Not saved — browser storage is unavailable']),
      el('span', { text: d.kind === 'role' ? `roles/${d.role.name} · ${SX.plural(counts.tasks, 'task')} · ${SX.plural(counts.handlers, 'handler')}` : [SX.plural(counts.plays, 'play'), SX.plural(counts.tasks, 'task'), SX.plural(counts.handlers, 'handler'), SX.plural(counts.roles, 'role')].join(' · ') }),
      errors || warnings ? el('button', {
        class: `warn${errors ? ' error' : ''}`, type: 'button',
        onclick: e => ui.menu(e.currentTarget, here.map(issue => ({ label: issue.message, onClick: () => issue.nodeId && reveal(issue.nodeId) })))
      }, [icon('warning', 13), [errors ? SX.plural(errors, 'error') : null, warnings ? SX.plural(warnings, 'lint warning') : null].filter(Boolean).join(' · ')]) : null,
      el('span', { class: 'grow' }),
      el('span', { class: 'hide-sm', text: state.yamlError ? 'YAML not applied' : 'Blocks and YAML in sync', style: state.yamlError ? 'color: var(--danger-text)' : '' }),
      builtin ? el('span', { class: 'hide-sm mono', text: `ansible-core ${builtin.version} schema` }) : null
    ].filter(Boolean));
  }

  // ---- Page ---------------------------------------------------------------------------------

  function viewSwitch() {
    return ui.seg([['blocks', 'Blocks'], ['split', 'Split'], ['yaml', 'YAML']], state.view, v => { state.view = v; savePrefs(); render(); }, { label: 'View' });
  }

  function build(container) {
    refs = {};
    refs.rail = el('nav', { class: 'rail', attrs: { 'aria-label': 'Block categories' } });
    refs.search = el('input', {
      type: 'search', placeholder: 'Search modules & keywords', attrs: { 'aria-label': 'Search modules' },
      oninput: e => { state.search = e.target.value.trim(); renderRail(); renderPalette(); }
    });
    refs.collection = el('select', { class: 'select', id: 'collection-filter', onchange: e => onCollection(e.target.value) });
    refs.paletteScroll = el('div', { class: 'palette-scroll' });
    refs.palette = el('aside', { class: 'palette', attrs: { 'aria-label': 'Block palette' } }, [
      el('div', { class: 'palette-top' }, [
        el('button', { class: 'btn btn-sm mobile-toggle', type: 'button', text: 'Show or hide blocks', onclick: () => { state.paletteOpen = !state.paletteOpen; renderPalette(); } }),
        el('div', { class: 'searchbox' }, [icon('search', 16), refs.search, el('span', { class: 'kbd', text: '/' })]),
        el('div', { class: 'collections-row' }, [el('label', { htmlFor: 'collection-filter', text: 'Collections' }), refs.collection])
      ]),
      refs.paletteScroll
    ]);
    refs.stage = el('div', { class: 'stage' });
    refs.sizer = el('div', { class: 'stage-sizer' }, refs.stage);
    refs.empty = el('div', { class: 'canvas-empty' }, el('div', { class: 'canvas-empty-card' }, [
      el('h2', { text: 'Start with a play' }),
      el('p', { text: 'Drag a play from the Plays category onto the canvas, then drop tasks into it. Or start from an example or your own files.' }),
      el('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; justify-content: center' }, [
        el('button', { class: 'btn btn-primary', type: 'button', text: 'Add a play', onclick: () => { state.category = 'plays'; addFromPalette({ kind: 'play' }); } }),
        el('button', { class: 'btn', type: 'button', text: 'Load the example', onclick: () => SX.app.loadExample() }),
        el('a', { class: 'btn', href: '#/import', text: 'Import…' })
      ])
    ]));
    refs.scroll = el('div', {
      class: 'canvas-scroll',
      onclick: e => { if (!e.target.closest('[data-id]') && !SX.DnD.active) select(null); else if (e.target.closest('[data-id]') && !e.target.closest('input, select, button, .slot')) select(e.target.closest('[data-id]').dataset.id); },
      onfocusin: e => { const blk = e.target.closest('[data-id]'); if (blk && blk.dataset.id !== state.selectedId) { state.selectedId = blk.dataset.id; refs.stage.querySelectorAll('.selected').forEach(n => n.classList.remove('selected')); blk.classList.add('selected'); renderInspector(); } },
      onwheel: e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }
    }, refs.sizer);
    refs.zoomLevel = el('button', { class: 'level', type: 'button', title: 'Reset to 100%', style: 'height: 24px; width: 44px; font: 500 11px/1 var(--font-mono); color: var(--text-muted); border-top: 1px solid var(--border-input); border-bottom: 1px solid var(--border-input)', onclick: () => setZoom(1) });
    refs.yamlText = el('textarea', {
      wrap: 'off', spellcheck: false, attrs: { 'aria-label': 'Playbook YAML' },
      oninput: e => { paintYaml(e.target.value); if (!readOnly()) applyYaml(e.target.value); },
      onkeydown: e => { if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); } }
    });
    refs.yamlCode = el('div');
    refs.yamlEditor = el('div', { class: 'yaml-editor' }, [refs.yamlCode, refs.yamlText]);
    refs.yamlFile = el('span', { class: 'mono', style: 'font: 600 13px/1 var(--font-mono)' });
    refs.yamlStatus = el('div', { class: 'yaml-status' });
    refs.yamlTools = el('span', { class: 'yaml-view-switch' });
    refs.yamlPane = el('section', { class: 'yaml-pane', attrs: { 'aria-label': 'YAML' } }, [
      el('div', { class: 'yaml-pane-head' }, [refs.yamlFile, refs.yamlBadge = el('span', { class: 'badge', style: '--c: #F4C542', text: 'Playbook' }), el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => ui.toast(await ui.copy(refs.yamlText.value) ? 'Copied the YAML.' : 'Could not copy.') }, [icon('copy', 14), 'Copy']), refs.yamlTools]),
      refs.yamlEditor, refs.yamlStatus
    ]);
    refs.trash = el('div', { class: 'trash', title: 'Drop a block here to delete it', attrs: { role: 'img', 'aria-label': 'Drop here to delete' } }, icon('trash', 18));
    refs.canvasTools = el('div', { class: 'canvas-tools' });
    refs.canvasWrap = el('div', { class: 'canvas-wrap' }, [
      refs.scroll,
      refs.empty,
      refs.canvasTools,
      el('div', { class: 'zoom-tools' }, [
        refs.trash,
        el('div', { class: 'zoom', attrs: { role: 'group', 'aria-label': 'Zoom' } }, [
          el('button', { type: 'button', title: 'Zoom in', attrs: { 'aria-label': 'Zoom in' }, onclick: () => setZoom(state.zoom + 0.1) }, icon('plus', 18)),
          refs.zoomLevel,
          el('button', { type: 'button', title: 'Zoom out', attrs: { 'aria-label': 'Zoom out' }, onclick: () => setZoom(state.zoom - 0.1) }, icon('minus', 18)),
          el('button', { class: 'fit', type: 'button', title: 'Fit to screen', attrs: { 'aria-label': 'Fit to screen' }, onclick: fitToScreen }, icon('fit', 18))
        ])
      ])
    ]);
    refs.workspace = el('main', { class: 'workspace well-canvas', attrs: { 'aria-label': 'Playbook workspace' } }, [refs.canvasWrap, refs.yamlPane]);
    refs.inspector = el('aside', { class: 'inspector', attrs: { 'aria-label': 'Inspector' } });
    refs.status = el('footer', { class: 'statusbar' });
    root = el('div', { class: 'builder' }, [refs.rail, refs.palette, refs.workspace, refs.inspector, refs.status]);
    container.replaceChildren(root);
  }

  function renderBanner() {
    refs.canvasWrap.querySelector('.readonly-banner')?.remove();
    if (!readOnly()) return;
    refs.canvasWrap.append(el('div', { class: 'readonly-banner' }, [
      icon('eye', 14), el('span', { text: `Viewing ${session().title} — read-only` }),
      el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: 'Make editable copy', onclick: () => session().makeEditable() }),
      el('button', { class: 'btn btn-sm', type: 'button', text: 'Close', onclick: () => session().close() })
    ]));
  }

  function render() {
    lintCache = null;
    renderRail();
    renderPalette();
    renderCanvas();
    renderYamlPane();
    renderInspector();
    renderStatus();
    renderBanner();
  }

  function onKey(e) {
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      refs.search.focus();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
      e.preventDefault();
      remove(state.selectedId);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && state.selectedId) {
      e.preventDefault();
      duplicate(state.selectedId);
    } else if (e.key === 'Escape' && state.selectedId) {
      select(null);
    }
  }

  SX.pages = SX.pages || {};
  SX.pages.builder = {
    mount(container, params) {
      SX.DnD.handler = dndHandler;
      build(container);
      if (params?.select) state.selectedId = params.select;
      render();
      document.addEventListener('keydown', onKey);
      if (params?.select) reveal(params.select);
    },
    unmount() {
      document.removeEventListener('keydown', onKey);
      SX.DnD.handler = null;
    },
    update(event) {
      lintCache = null;
      const src = event?.source;
      if (event?.select) state.selectedId = event.select;
      if (src === 'inspector' && event.typing) {
        renderCanvas();
        renderYamlPane();
        renderStatus();
        return;
      }
      if (src === 'canvas' && event.typing) {
        renderInspector();
        renderYamlPane();
        renderStatus();
        return;
      }
      if (src === 'yaml') {
        if (state.selectedId && !SX.findNode(project(), state.selectedId)) state.selectedId = null;
        renderCanvas();
        renderInspector();
        renderStatus();
        return;
      }
      if (src === 'layout') {
        renderCanvas();
        return;
      }
      render();
    },
    state
  };
})();
