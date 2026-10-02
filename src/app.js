// The app shell: top bar, routes (#/builder, #/roles, #/inventory, #/import,
// #/export), the project menu, keyboard shortcuts and startup.
(function () {
  const SX = window.Scransible;
  const { el, icon, ui } = SX;
  const store = SX.store;
  const SNAPSHOT_KEY = 'scransible.snapshot';
  const app = SX.app = {};
  const refs = {};
  let current = null;

  function parseRoute() {
    const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
    const page = SX.pages?.[name] ? name : 'builder';
    return { name: page, arg: page === name && rest.length ? rest.map(decodeURIComponent).join('/') : null };
  }

  app.navigate = hash => {
    if (location.hash === hash) mountRoute(true);
    else location.hash = hash;
  };

  // ---- Top bar --------------------------------------------------------------------------

  function crumb(route) {
    const project = store.project;
    if (route.name === 'builder') {
      return el('button', {
        class: 'crumb', type: 'button', title: 'Project and files', attrs: { 'aria-haspopup': 'menu' },
        onclick: e => projectMenu(e.currentTarget)
      }, [el('span', { class: 'crumb-project', text: `${project.name} /` }), el('span', { class: 'crumb-file', text: SX.activeDoc(project).path }), icon('chevronDown', 12)]);
    }
    const where = { import: 'Import', export: 'Export', roles: route.arg ? `roles/${route.arg}` : 'roles', inventory: SX.activeInventory(project)?.path || 'inventory' }[route.name];
    return el('span', { class: 'crumb-plain' }, [`${project.name} /`, el('strong', { class: route.name === 'roles' || route.name === 'inventory' ? 'mono' : '', text: where })]);
  }

  function renderTopbar() {
    const route = parseRoute();
    const navLink = (name, label) => el('a', { href: `#/${name}`, text: label, attrs: { 'aria-current': route.name === name ? 'page' : null } });
    refs.topbar.replaceChildren(
      el('a', { class: 'brand', href: '#/builder', attrs: { 'aria-label': 'Scransible — builder' } }, [SX.logo(28), el('span', { class: 'brand-name', text: 'Scransible' })]),
      el('div', { class: 'topbar-divider hide-sm' }),
      crumb(route),
      el('nav', { class: 'nav', attrs: { 'aria-label': 'Workspace' } }, [navLink('builder', 'Builder'), navLink('roles', 'Roles'), navLink('inventory', 'Inventory')]),
      el('span', { class: 'grow' }),
      el('div', { class: 'topbar-actions hide-sm' }, [
        el('button', { class: 'icon-btn', type: 'button', title: 'Undo (⌘Z)', disabled: !store.undoStack.length, attrs: { 'aria-label': 'Undo' }, onclick: () => store.undo() }, icon('undo', 18, 1.8)),
        el('button', { class: 'icon-btn', type: 'button', title: 'Redo (⇧⌘Z)', disabled: !store.redoStack.length, attrs: { 'aria-label': 'Redo' }, onclick: () => store.redo() }, icon('redo', 18, 1.8))
      ]),
      el('a', { class: 'btn', href: '#/import' }, [icon('import', 16), 'Import']),
      el('a', { class: 'btn btn-primary', href: '#/export' }, [icon('export', 16, 2), 'Export'])
    );
  }

  // ---- Project menu -----------------------------------------------------------------------

  const validPath = (value, except) => {
    if (!/^[\w./-]+\.ya?ml$/.test(value)) return 'Use a relative path ending in .yml or .yaml, like deploy.yml.';
    if (store.project.playbooks.some(pb => pb.path === value && pb.id !== except)) return 'There is already a playbook at that path.';
    return null;
  };

  function projectMenu(anchor) {
    const project = store.project;
    const active = SX.activePlaybook(project);
    const doc = SX.activeDoc(project);
    ui.menu(anchor, [
      { heading: 'Playbooks' },
      ...project.playbooks.map(pb => ({ label: pb.path, current: doc.kind === 'playbook' && pb.id === active.id, hint: `${pb.items.filter(i => i.type === 'play').length} play${pb.items.length === 1 ? '' : 's'}`, onClick: () => store.commit(p => SX.openPlaybook(p, pb.id), { checkpoint: false }) })),
      { label: 'New playbook…', icon: 'plus', onClick: async () => {
        const path = await ui.prompt('New playbook', { label: 'File name', value: 'deploy.yml', validate: v => validPath(v) });
        if (path) store.commit(p => { const pb = { id: SX.uid(), path, items: [] }; p.playbooks.push(pb); SX.openPlaybook(p, pb.id); });
      } },
      { label: 'Rename playbook…', onClick: async () => {
        const path = await ui.prompt('Rename playbook', { label: 'File name', value: active.path, validate: v => validPath(v, active.id) });
        if (path) store.commit(p => { SX.activePlaybook(p).path = path; });
      } },
      { label: 'Delete playbook', danger: true, disabled: project.playbooks.length < 2, onClick: async () => {
        if (!await ui.confirm(`Delete ${active.path}?`, 'Its plays are removed from the project. Undo brings them back.', { confirmLabel: 'Delete', danger: true })) return;
        store.commit(p => { p.playbooks = p.playbooks.filter(pb => pb.id !== active.id); SX.openPlaybook(p, p.playbooks[0].id); });
      } },
      ...(project.roles.length ? ['sep', { heading: 'Role task files' }, ...project.roles.map(role => ({
        label: `roles/${role.name}/tasks/main.yml`, current: doc.kind === 'role' && doc.role.id === role.id,
        onClick: () => store.commit(p => SX.openRole(p, role.id), { checkpoint: false })
      }))] : []),
      'sep',
      { heading: 'Project' },
      { label: 'Rename project…', onClick: async () => {
        const name = await ui.prompt('Rename project', { label: 'Project name', value: project.name, validate: v => /^[\w.-]+$/.test(v) ? null : 'Use letters, numbers, dots, dashes and underscores.' });
        if (name) store.commit(p => { p.name = name; });
      } },
      { label: 'Load the example project', onClick: () => app.loadExample() },
      { label: 'New empty project', onClick: async () => {
        if (!await ui.confirm('Start a new project?', 'Your current project is replaced. Undo brings it back, and Save snapshot keeps a copy.', { confirmLabel: 'Start new' })) return;
        store.replace(SX.newProject());
      } },
      'sep',
      { label: 'Save snapshot', onClick: () => ui.toast(SX.writeStorage(SNAPSHOT_KEY, JSON.stringify(store.project)) ? 'Saved a snapshot of the project.' : 'Could not save: browser storage is unavailable.') },
      { label: 'Restore snapshot', disabled: !SX.readStorage(SNAPSHOT_KEY), onClick: () => {
        try {
          const snapshot = JSON.parse(SX.readStorage(SNAPSHOT_KEY));
          SX.validateProject(snapshot);
          store.replace(snapshot);
          ui.toast('Restored the snapshot.', { action: { label: 'Undo', onClick: () => store.undo() } });
        } catch (error) {
          ui.toast(`Could not restore: ${error.message}`);
        }
      } },
      'sep',
      { label: 'Download project file', icon: 'import', onClick: () => ui.download(new Blob([JSON.stringify(store.project, null, 2)], { type: 'application/json' }), `${project.name}.scransible.json`) },
      { label: 'Open project file…', icon: 'upload', onClick: () => openProjectFile() }
    ]);
  }

  async function openProjectFile() {
    const [file] = await ui.pickFiles({ accept: '.json,application/json', multiple: false });
    if (!file) return;
    try {
      app.loadProjectJson(await file.text());
      ui.toast(`Opened ${file.name}.`, { action: { label: 'Undo', onClick: () => store.undo() } });
    } catch (error) {
      ui.dialog({ title: 'Couldn’t open that file', body: el('p', { class: 'empty-note', text: error.message }), actions: [{ label: 'OK', primary: true }] });
    }
  }

  // Project files, and exports from the single-file builder (a list of plays).
  app.loadProjectJson = text => {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      store.replace(SX.migrateLegacy(data));
      return;
    }
    SX.validateProject(data);
    store.replace(data);
  };

  app.loadExample = async () => {
    const hasWork = store.project.playbooks.some(pb => pb.items.length) || store.project.roles.length;
    if (hasWork && !await ui.confirm('Load the example project?', 'Your current project is replaced. Undo brings it back.', { confirmLabel: 'Load example' })) return;
    store.replace(SX.exampleProject());
    app.navigate('#/builder');
  };

  // ---- Routing ----------------------------------------------------------------------------

  function mountRoute(force = false) {
    const route = parseRoute();
    if (!force && current && current.name === route.name && current.arg === route.arg) return;
    current?.page.unmount?.();
    ui.closeMenu();
    current = { ...route, page: SX.pages[route.name] };
    current.page.mount(refs.main, { arg: route.arg });
    renderTopbar();
    const titles = { builder: 'Builder', roles: 'Roles', inventory: 'Inventory', import: 'Import', export: 'Export' };
    document.title = `${titles[route.name]} · ${store.project.name} · Scransible`;
  }

  function onKey(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      store.redo();
    }
  }

  app.boot = async function boot() {
    const root = document.getElementById('app');
    refs.topbar = el('header', { class: 'topbar' });
    refs.main = el('div', { class: 'main', style: 'display: grid; min-height: 0' });
    root.replaceChildren(refs.topbar, refs.main);
    const failed = await SX.loadModuleSets();
    const loaded = store.load();
    SX.on('change', event => {
      renderTopbar();
      current?.page.update?.(event);
    });
    SX.on('modulesets', () => current?.page.update?.({ source: 'modulesets' }));
    window.addEventListener('hashchange', () => mountRoute());
    document.addEventListener('keydown', onKey);
    mountRoute();
    if (!window.jsyaml) ui.toast('The js-yaml library did not load (are you offline?), so YAML can’t be generated.', { timeout: 10000 });
    else if (failed.length) ui.toast(`Couldn’t load ${failed.join(', ')}.`, { timeout: 8000 });
    else if (loaded === 'migrated') ui.toast('Your playbook from the previous version was carried over.', { timeout: 7000 });
    else if (loaded.startsWith('unreadable')) ui.toast(`Your saved project couldn’t be read (${loaded.slice(12)}), so a new one was started. The old data is kept in browser storage.`, { timeout: 12000 });
  };
})();
