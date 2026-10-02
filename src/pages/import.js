// Import: bring playbooks, roles, inventories and variables in from files, archives,
// pasted YAML or a GitHub repository; review how they map to blocks; then open them
// read-only or as an editable copy.
(function () {
  const SX = window.Scransible;
  const { el, icon, ui, Blocks: B, Ansible: A } = SX;
  const store = SX.store;
  const KIND_COLORS = { Playbook: '#F4C542', Role: '#F08BD8', Inventory: '#5FA8FF', Variables: '#E2CBA4', Config: '#C3CCDB', Tasks: '#FF9A3C', Unreadable: '#FF5A5F' };
  const TEXT_FILE = /\.(ya?ml|ini|cfg|j2|json|conf|txt|sh|py|md|toml)$|(^|\/)(hosts|inventory)$/i;

  const state = {
    tab: 'upload', paste: '', github: { url: '', ref: '', path: '' },
    source: null, entries: [], focus: null, linkId: null, mode: 'view', busy: null, error: null
  };
  let root;

  // ---- Reading sources ----------------------------------------------------------------

  async function readUploads(files) {
    const out = [];
    for (const file of files) {
      const path = file.webkitRelativePath || file.relativePath || file.name;
      if (/\.zip$/i.test(path)) {
        (await SX.Archive.unzip(await file.arrayBuffer())).forEach(f => TEXT_FILE.test(f.path) && out.push({ path: f.path, text: SX.Archive.text(f.bytes) }));
      } else if (/\.(tar\.gz|tgz|tar)$/i.test(path)) {
        (await SX.Archive.untarGz(await file.arrayBuffer())).forEach(f => TEXT_FILE.test(f.path) && out.push({ path: f.path, text: SX.Archive.text(f.bytes) }));
      } else if (TEXT_FILE.test(path) && file.size < 2_000_000) {
        out.push({ path, text: await file.text() });
      }
    }
    return out;
  }

  // Folders dropped onto the page arrive as entries to walk.
  async function filesFromDrop(dataTransfer) {
    const entries = [...dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...dataTransfer.files];
    const files = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        file.relativePath = prefix + file.name;
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const entry of entries) await walk(entry, '');
    return files;
  }

  async function fetchGitHub({ url, ref, path }) {
    const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/);
    if (!m) throw new Error('Enter a GitHub repository URL, like https://github.com/owner/repo');
    const [, owner, repo, urlRef, urlPath] = m;
    const branch = ref.trim() || urlRef || 'HEAD';
    const sub = (path.trim() || urlPath || '').replace(/^\/|\/$/g, '');
    const treeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (!treeResponse.ok) throw new Error(treeResponse.status === 404 ? 'Repository or branch not found (private repositories aren’t supported).' : `GitHub said ${treeResponse.status}${treeResponse.status === 403 ? ' — the hourly API limit may be used up' : ''}.`);
    const tree = await treeResponse.json();
    const wanted = tree.tree.filter(t => t.type === 'blob' && (!sub || t.path.startsWith(`${sub}/`)) && TEXT_FILE.test(t.path) && t.size < 2_000_000).slice(0, 300);
    const files = [];
    for (let i = 0; i < wanted.length; i += 8) {
      const batch = await Promise.all(wanted.slice(i, i + 8).map(async t => {
        const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${tree.sha}/${t.path.split('/').map(encodeURIComponent).join('/')}`);
        return response.ok ? { path: sub ? t.path.slice(sub.length + 1) : t.path, text: await response.text() } : null;
      }));
      files.push(...batch.filter(Boolean));
    }
    return { files, label: `${owner}/${repo}${sub ? `/${sub}` : ''}`, truncated: tree.truncated || wanted.length === 300 };
  }

  // ---- Analysis -----------------------------------------------------------------------------

  // Drops a folder name every path starts with (an unpacked archive's top folder).
  function stripCommonFolder(files) {
    const first = files[0]?.path.split('/')[0];
    if (files.length && files.every(f => f.path.includes('/') && f.path.split('/')[0] === first)) {
      return { files: files.map(f => ({ ...f, path: f.path.slice(first.length + 1) })), folder: first };
    }
    return { files, folder: null };
  }

  function safeLoad(text) {
    try { return { data: window.jsyaml.load(text) }; } catch (error) { return { error: error.message.split('\n')[0] }; }
  }

  function analyze(rawFiles, label) {
    const { files, folder } = stripCommonFolder(rawFiles.map(f => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.\//, '') })));
    const entries = [];
    const roles = new Map();
    const role = name => {
      if (!roles.has(name)) roles.set(name, { name, files: [] });
      return roles.get(name);
    };
    // A role folder uploaded on its own (tasks/main.yml at the top) is named after the folder.
    const loneRole = files.some(f => /^(tasks|meta)\/main\.ya?ml$/.test(f.path)) && !files.some(f => /^roles\//.test(f.path));
    for (const file of files) {
      const roleMatch = file.path.match(/(?:^|\/)roles\/([^/]+)\/(tasks|handlers|defaults|vars|meta|templates|files)\/(.+)$/)
        || (loneRole && file.path.match(/^()(tasks|handlers|defaults|vars|meta|templates|files)\/(.+)$/));
      if (roleMatch) {
        role(roleMatch[1] || folder || (label || 'imported_role').replace(/\.(zip|tar\.gz|tgz)$/, '')).files.push({ ...file, part: roleMatch[2], rest: roleMatch[3] });
        continue;
      }
      if (/(^|\/)\.scransible\/layout\.json$/.test(file.path)) {
        entries.push({ id: SX.uid(), kind: 'Layout', path: file.path, text: file.text, hidden: true });
        continue;
      }
      const varsMatch = file.path.match(/(?:^|\/)(group_vars|host_vars)\/([^/]+?)(?:\.ya?ml)?(?:\/[^/]+\.ya?ml)?$/);
      if (varsMatch && /\.ya?ml$|\/[^.]+$/.test(file.path)) {
        const loaded = safeLoad(file.text);
        entries.push(loaded.error ? { id: SX.uid(), kind: 'Unreadable', path: file.path, text: file.text, error: loaded.error }
          : { id: SX.uid(), kind: 'Variables', path: file.path, text: file.text, scope: varsMatch[1] === 'group_vars' ? 'group' : 'host', target: varsMatch[2], vars: loaded.data || {} });
        continue;
      }
      if (/(^|\/)ansible\.cfg$/.test(file.path)) {
        entries.push({ id: SX.uid(), kind: 'Config', path: file.path, text: file.text, note: 'has no visual form — on export Scransible writes its own ansible.cfg.' });
        continue;
      }
      if (/(^|\/)requirements\.ya?ml$/.test(file.path)) {
        entries.push({ id: SX.uid(), kind: 'Config', path: file.path, text: file.text, note: 'is regenerated on export from the collections your blocks use.' });
        continue;
      }
      if (/\.ini$|(^|\/)(hosts|inventory)$/.test(file.path)) {
        entries.push({ id: SX.uid(), kind: 'Inventory', path: file.path.endsWith('.ini') ? file.path : `${file.path}.ini`, text: file.text, inventory: A.parseIniInventory(file.text, file.path.endsWith('.ini') ? file.path : `${file.path}.ini`) });
        continue;
      }
      if (!/\.ya?ml$/.test(file.path)) continue;
      const loaded = safeLoad(file.text);
      if (loaded.error) {
        entries.push({ id: SX.uid(), kind: 'Unreadable', path: file.path, text: file.text, error: loaded.error });
      } else if (A.looksLikePlaybook(loaded.data)) {
        try {
          entries.push({ id: SX.uid(), kind: 'Playbook', path: file.path, text: file.text, parsed: A.parsePlaybook(file.text) });
        } catch (error) {
          entries.push({ id: SX.uid(), kind: 'Unreadable', path: file.path, text: file.text, error: error.message });
        }
      } else if (A.looksLikeYamlInventory(loaded.data)) {
        const path = file.path.replace(/\.ya?ml$/, '.ini');
        entries.push({ id: SX.uid(), kind: 'Inventory', path, text: file.text, inventory: A.parseYamlInventory(loaded.data, path) });
      } else if (Array.isArray(loaded.data)) {
        entries.push({ id: SX.uid(), kind: 'Tasks', path: file.path, text: file.text, parsed: A.parseTasksText(file.text), note: 'is a task file. It imports as a role you can rename.' });
      }
    }
    for (const r of roles.values()) entries.push(buildRole(r));
    const order = ['Playbook', 'Role', 'Tasks', 'Inventory', 'Variables', 'Config', 'Unreadable'];
    entries.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.path.localeCompare(b.path));
    entries.forEach(e => { e.selected = !['Config', 'Unreadable', 'Layout'].includes(e.kind) && e.kind !== 'Tasks'; });
    return entries;
  }

  function buildRole({ name, files }) {
    const part = (p, file = 'main') => files.find(f => f.part === p && new RegExp(`^${file}\\.ya?ml$`).test(f.rest));
    const tasksFile = part('tasks');
    const parsedTasks = tasksFile ? A.parseTasksText(tasksFile.text) : { items: [], ranges: new Map(), problems: [], unknownModules: new Set() };
    const handlersFile = part('handlers');
    const parsedHandlers = handlersFile ? A.parseTasksText(handlersFile.text) : { items: [], problems: [], unknownModules: new Set() };
    const defaults = { ...(safeLoad(part('defaults')?.text || '').data || {}), ...(safeLoad(part('vars')?.text || '').data || {}) };
    const meta = safeLoad(part('meta')?.text || '').data || {};
    const role = SX.newRole(name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(), {
      description: meta.galaxy_info?.description || '',
      tasks: parsedTasks.items, handlers: parsedHandlers.items,
      defaults: Object.entries(defaults).map(([k, v]) => SX.newVar(k, v)),
      dependencies: (meta.dependencies || []).map(d => (typeof d === 'string' ? d : d?.role || d?.name)).filter(Boolean),
      templates: files.filter(f => f.part === 'templates').map(f => ({ id: SX.uid(), path: f.rest, content: f.text })),
      files: files.filter(f => f.part === 'files').map(f => ({ id: SX.uid(), path: f.rest, content: f.text }))
    });
    return {
      id: SX.uid(), kind: 'Role', path: `roles/${name}/`, text: tasksFile?.text || '', role,
      parsed: { ...parsedTasks, unknownModules: new Set([...parsedTasks.unknownModules, ...parsedHandlers.unknownModules]), problems: [...parsedTasks.problems, ...parsedHandlers.problems] }
    };
  }

  // The selected entries as a project of their own.
  function importedProject() {
    const name = (state.source?.label || 'imported').replace(/\.(zip|tar\.gz|tgz)$/i, '').split('/').pop().replace(/[^\w.-]/g, '-');
    const p = SX.newProject(name);
    p.playbooks = [];
    p.inventories = [];
    const selected = state.entries.filter(e => e.selected);
    for (const e of selected) {
      if (e.kind === 'Playbook') p.playbooks.push({ id: SX.uid(), path: e.path, items: SX.clone(e.parsed.items) });
      if (e.kind === 'Role') p.roles.push(SX.clone(e.role));
      if (e.kind === 'Tasks') p.roles.push(SX.newRole(e.path.split('/').pop().replace(/\.ya?ml$/, '').replace(/\W/g, '_').toLowerCase(), { tasks: SX.clone(e.parsed.items) }));
      if (e.kind === 'Inventory') p.inventories.push(SX.clone(e.inventory));
    }
    if (!p.inventories.length) p.inventories.push(SX.newInventory('inventory/hosts.ini'));
    for (const e of selected.filter(x => x.kind === 'Variables')) {
      for (const inv of p.inventories) {
        if (e.scope === 'group') {
          let g = inv.groups.find(x => x.name === e.target);
          if (!g) inv.groups.push(g = { id: SX.uid(), name: e.target, children: [], hosts: [], vars: [] });
          for (const [k, v] of Object.entries(e.vars)) g.vars.push(SX.newVar(k, v));
        } else {
          let h = inv.hosts.find(x => x.name === e.target);
          if (!h) inv.hosts.push(h = { id: SX.uid(), name: e.target, address: '', vars: [] });
          for (const [k, v] of Object.entries(e.vars)) h.vars.push(SX.newVar(k, v));
        }
      }
    }
    const layout = state.entries.find(e => e.kind === 'Layout');
    if (layout) {
      try {
        const saved = JSON.parse(layout.text).playbooks || {};
        for (const pb of p.playbooks) {
          (saved[pb.path] || []).forEach(({ index, pos, collapsed, show }) => {
            const item = pb.items[index];
            if (!item) return;
            if (pos) item.pos = pos;
            if (item.ui) Object.assign(item.ui, { collapsed: collapsed || item.ui.collapsed, show: show || item.ui.show });
          });
        }
      } catch (error) {
        // A damaged layout file just means default positions.
      }
    }
    if (!p.playbooks.length) p.playbooks.push({ id: SX.uid(), path: 'site.yml', items: [] });
    p.activePlaybookId = p.playbooks[0].id;
    if (!selected.some(e => e.kind === 'Playbook') && p.roles.length) p.activeDoc = { type: 'role', id: p.roles[0].id };
    return SX.normalizeProject(p);
  }

  // ---- Report ---------------------------------------------------------------------------------

  function report() {
    const selected = state.entries.filter(e => e.selected);
    const counts = { plays: 0, tasks: 0, handlers: 0 };
    const unknown = new Set();
    const problems = [];
    let jinja = 0;
    const links = [];
    for (const e of selected) {
      if (e.kind === 'Playbook') {
        counts.plays += e.parsed.counts.plays;
        counts.tasks += e.parsed.counts.tasks;
        counts.handlers += e.parsed.counts.handlers;
        jinja += e.parsed.jinja;
        for (const item of e.parsed.items) {
          if (item.type !== 'play') continue;
          const handlers = SX.handlerNames(item);
          SX.walk(['pre_tasks', 'tasks', 'post_tasks'].flatMap(s => item[s]), n => {
            [].concat(n.kw?.notify || []).forEach(t => { if (handlers.includes(String(t))) links.push(String(t)); });
          });
        }
      }
      if (e.kind === 'Role' || e.kind === 'Tasks') {
        SX.walk([...(e.role?.tasks || e.parsed.items), ...(e.role?.handlers || [])], n => { if (n.type === 'task') counts.tasks++; });
      }
      e.parsed?.unknownModules?.forEach(m => unknown.add(m));
      e.parsed?.problems?.forEach(p => problems.push(`${e.path}: ${p}`));
    }
    return { counts, unknown: [...unknown], problems, jinja, links: [...new Set(links)] };
  }

  // ---- Linking lines and blocks -----------------------------------------------------------

  function focusEntry() {
    return state.entries.find(e => e.id === state.focus && !e.hidden) || state.entries.find(e => !e.hidden && e.selected) || state.entries.find(e => !e.hidden);
  }

  function nodesOf(entry) {
    if (entry.kind === 'Playbook') return entry.parsed.items;
    if (entry.kind === 'Role') return entry.role.tasks;
    if (entry.kind === 'Tasks') return entry.parsed.items;
    return [];
  }

  function rangeOf(entry, id) {
    return entry.parsed?.ranges?.get(id) || null;
  }

  // The innermost task, block or play whose lines include this one.
  function nodeAtLine(entry, line) {
    let best = null;
    SX.walk(nodesOf(entry), node => {
      const r = rangeOf(entry, node.id);
      if (r && line >= r.start && line <= r.end && (!best || r.end - r.start <= best.r.end - best.r.start)) best = { node, r };
    });
    return best?.node || null;
  }

  function decorateFor(entry) {
    const lineInfo = new Map();
    const marks = new Set();
    SX.walk(nodesOf(entry), node => {
      const r = rangeOf(entry, node.id);
      if (!r) return;
      const color = B.colorOf(node) || '#C3CCDB';
      for (let n = r.start; n <= r.end; n++) {
        const current = lineInfo.get(n);
        if (!current || current.size >= r.end - r.start) lineInfo.set(n, { color, size: r.end - r.start });
      }
      if (node.type === 'task' && node.module && !SX.module(node.module)) marks.add(r.start + 1);
    });
    const link = state.linkId && rangeOf(entry, state.linkId);
    const linkColor = link && (B.colorOf(SX.findNode({ playbooks: [{ items: nodesOf(entry) }], roles: [] }, state.linkId) || {}) || '#8DB9FF');
    return n => ({
      gut: lineInfo.get(n)?.color,
      bg: link && n >= link.start && n <= link.end ? linkColor : null,
      mark: marks.has(n) ? '!' : '',
      title: marks.has(n) ? 'Module not in an installed module set' : undefined
    });
  }

  // ---- Rendering --------------------------------------------------------------------------------

  async function load(files, label, note = 'Unpacked') {
    state.entries = analyze(files, label);
    state.source = { label, note, count: files.length };
    state.focus = null;
    state.linkId = null;
    state.error = state.entries.length ? null : 'No Ansible content found — expected playbooks, roles, inventories or group_vars.';
    render();
  }

  async function handleFiles(files, label) {
    if (!files.length) return;
    state.busy = 'Reading files…';
    state.error = null;
    render();
    try {
      const read = await readUploads(files);
      const name = label || (files.length === 1 ? files[0].name : `${files.length} files`);
      state.busy = null;
      await load(read, name, files.length === 1 && /\.(zip|tar\.gz|tgz|tar)$/i.test(files[0].name) ? 'Unpacked' : `${read.length} files`);
    } catch (error) {
      state.busy = null;
      state.error = `Couldn’t read that: ${error.message}`;
      render();
    }
  }

  function sourcePanel() {
    const tabs = ui.seg([['upload', 'Upload'], ['paste', 'Paste'], ['github', 'GitHub']], state.tab, v => { state.tab = v; render(); }, { cls: 'fill', label: 'Source type' });
    let body;
    if (state.tab === 'upload') {
      const zone = el('div', {
        class: 'dropzone',
        ondragover: e => { e.preventDefault(); zone.classList.add('over'); },
        ondragleave: () => zone.classList.remove('over'),
        ondrop: async e => { e.preventDefault(); zone.classList.remove('over'); handleFiles(await filesFromDrop(e.dataTransfer)); }
      }, [
        icon('upload', 22),
        el('p', {}, ['Drop playbooks, a role folder, or a ', el('span', { class: 'mono', text: '.zip' }), ' / ', el('span', { class: 'mono', text: '.tar.gz' }), ' of a project']),
        el('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; justify-content: center' }, [
          el('button', { class: 'btn btn-md btn-secondary', type: 'button', text: 'Browse files', onclick: async () => handleFiles(await ui.pickFiles({ accept: '.yml,.yaml,.ini,.cfg,.j2,.json,.zip,.tgz,.gz,.tar' })) }),
          el('button', { class: 'btn btn-md btn-secondary', type: 'button', text: 'Choose a folder', onclick: async () => handleFiles(await ui.pickFiles({ directory: true })) })
        ])
      ]);
      body = [zone];
    } else if (state.tab === 'paste') {
      const area = el('textarea', { class: 'textarea', rows: 10, value: state.paste, placeholder: '- name: My play\n  hosts: all\n  tasks: …', oninput: e => { state.paste = e.target.value; } });
      body = [
        ui.field('Paste a playbook, task file or role tasks', area),
        el('button', { class: 'btn btn-md btn-secondary', type: 'button', style: 'align-self: flex-start', text: 'Map to blocks', onclick: () => {
          const looksLikePlaybook = A.looksLikePlaybook(safeLoad(state.paste).data);
          load([{ path: looksLikePlaybook ? 'pasted.yml' : 'tasks/pasted.yml', text: state.paste }], 'Pasted YAML', 'Pasted');
        } })
      ];
    } else {
      const field = (key, label, placeholder) => ui.field(label, el('input', { class: 'input', value: state.github[key], placeholder, oninput: e => { state.github[key] = e.target.value; } }));
      body = [
        field('url', 'Repository URL', 'https://github.com/owner/repo'),
        el('div', { style: 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px' }, [field('ref', 'Branch or tag', 'default branch'), field('path', 'Sub-path', 'ansible/')]),
        el('button', { class: 'btn btn-md btn-secondary', type: 'button', style: 'align-self: flex-start', text: 'Fetch repository', onclick: async () => {
          state.busy = 'Fetching from GitHub…';
          state.error = null;
          render();
          try {
            const { files, label, truncated } = await fetchGitHub(state.github);
            state.busy = null;
            await load(files, label, `${files.length} files${truncated ? ' (first 300)' : ''}`);
          } catch (error) {
            state.busy = null;
            state.error = error.message;
            render();
          }
        } }),
        el('p', { class: 'field-hint', text: 'Public GitHub repositories only. Files are fetched straight from GitHub by your browser.' })
      ];
    }
    const sourceRow = state.source ? el('div', { class: 'file-row' }, [icon('archive', 16), el('span', { class: 'grow', text: state.source.label }), el('span', { style: 'color: var(--ok); font: 500 12px/1 var(--font-ui)', text: state.source.note })]) : null;
    return el('div', { class: 'side-pad', style: 'padding-bottom: 0' }, [tabs, ...body, state.busy ? el('p', { class: 'empty-note', text: state.busy }) : null, state.error ? el('div', { class: 'callout error' }, [icon('info', 16), el('span', { text: state.error })]) : null, sourceRow]);
  }

  function detectedPanel() {
    const visible = state.entries.filter(e => !e.hidden);
    if (!visible.length) return null;
    const focus = focusEntry();
    return el('div', { style: 'padding: 20px 18px 0; display: flex; flex-direction: column; gap: 8px' }, [
      el('div', { class: 'panel-title-row' }, [el('h2', { class: 'panel-title', text: 'Detected in this upload' }), el('span', { class: 'field-hint', text: `${visible.filter(e => e.selected).length} of ${visible.length} selected` })]),
      el('div', { class: 'list' }, visible.map(e => {
        const id = `imp-${e.id}`;
        const disabled = ['Config', 'Unreadable'].includes(e.kind);
        return el('div', { class: `check-row${e.id === focus?.id ? ' current' : ''}`, title: e.error || (e.note ? `${e.path} ${e.note}` : e.path), onclick: ev => { if (ev.target.tagName !== 'INPUT') { state.focus = e.id; state.linkId = null; render(); } } }, [
          el('input', { type: 'checkbox', id, checked: e.selected, disabled, onchange: ev => { e.selected = ev.target.checked; render(); } }),
          el('label', { htmlFor: id, text: e.path, onclick: ev => { ev.preventDefault(); state.focus = e.id; state.linkId = null; render(); } }),
          el('span', { class: 'badge', style: `--c: ${KIND_COLORS[e.kind]}`, text: e.kind === 'Tasks' ? 'Task file' : e.kind })
        ]);
      }))
    ]);
  }

  function reportPanel() {
    if (!state.entries.some(e => !e.hidden)) return null;
    const r = report();
    const items = [];
    const parts = [r.counts.plays && SX.plural(r.counts.plays, 'play'), r.counts.tasks && SX.plural(r.counts.tasks, 'task'), r.counts.handlers && SX.plural(r.counts.handlers, 'handler')].filter(Boolean);
    if (parts.length) items.push(el('div', { class: 'found' }, [icon('checkLarge', 16), el('span', { text: `${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')} mapped to blocks` })]));
    r.links.slice(0, 3).forEach(link => items.push(el('div', { class: 'found' }, [icon('checkLarge', 16), el('span', {}, [el('span', { class: 'mono', text: `notify: ${link}` }), ' linked to its handler'])])));
    if (r.jinja) items.push(el('div', { class: 'found' }, [icon('checkLarge', 16), el('span', { text: `${SX.plural(r.jinja, 'Jinja expression')} kept as expression slots` })]));
    for (const module of r.unknown) {
      const parts2 = module.split('.');
      items.push(el('div', { class: 'callout warn' }, [icon('warning', 16), el('div', { class: 'callout-body' }, [
        el('span', {}, [el('span', { class: 'mono', text: module }), ' isn’t in an installed module set, so it’s shown as a generic block. Its parameters are kept exactly as written.']),
        parts2.length === 3 ? el('span', { class: 'field-hint', style: 'color: inherit; opacity: .8' }, ['Export lists ', el('span', { class: 'mono', text: `${parts2[0]}.${parts2[1]}` }), ' in requirements.yml. To get typed slots, add its module set from the builder’s Collections menu.']) : null
      ])]));
    }
    r.problems.slice(0, 4).forEach(p => items.push(el('div', { class: 'found muted' }, [icon('info', 16), el('span', { text: p })])));
    state.entries.filter(e => e.note && !e.hidden).forEach(e => items.push(el('div', { class: 'found muted' }, [icon('info', 16), el('span', {}, [el('span', { class: 'mono', text: e.path }), ` ${e.note}`])])));
    state.entries.filter(e => e.kind === 'Unreadable').forEach(e => items.push(el('div', { class: 'callout error' }, [icon('info', 16), el('span', {}, [el('span', { class: 'mono', text: e.path }), ` couldn’t be read: ${e.error}`])])));
    if (state.entries.some(e => e.kind === 'Layout')) items.push(el('div', { class: 'found' }, [icon('checkLarge', 16), el('span', { text: 'Block layout from a Scransible export restored' })]));
    return el('div', { class: 'card', style: 'margin: 20px 18px' }, [el('h2', { class: 'card-title', text: 'What we found' }), ...items]);
  }

  function sourceViewer() {
    const entry = focusEntry();
    if (!entry) {
      return el('section', { class: 'yaml-pane', style: 'width: auto; max-width: none; border-left: 0; border-right: 1px solid var(--border)' }, [
        el('div', { class: 'pane-head' }, [el('span', { class: 'pane-title', text: 'Source' })]),
        el('div', { class: 'insp-empty', style: 'margin: auto; text-align: center; max-width: 380px' }, [el('h2', { text: 'Nothing loaded yet' }), el('p', { text: 'Drop files on the left, paste YAML, or fetch a GitHub repository. Each line will link to the block it becomes.' })])
      ]);
    }
    const text = entry.kind === 'Role' ? entry.text || '# This role has no tasks/main.yml' : entry.text || '';
    const decorate = ['Playbook', 'Role', 'Tasks'].includes(entry.kind) ? decorateFor(entry) : null;
    const viewer = ui.codeView(text, {
      decorate, onLineClick: decorate ? line => { state.linkId = nodeAtLine(entry, line)?.id || null; render({ scrollBlock: true }); } : null
    });
    viewer.style.flex = '1';
    return el('section', { style: 'background: var(--bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; min-width: 0' }, [
      el('div', { class: 'pane-head' }, [
        el('span', { class: 'mono', style: 'font: 600 13px/1 var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap', text: entry.kind === 'Role' ? `${entry.path}tasks/main.yml` : entry.path }),
        el('span', { class: 'badge', style: `--c: ${KIND_COLORS[entry.kind]}`, text: entry.kind === 'Tasks' ? 'Task file' : entry.kind }),
        el('span', { class: 'grow' }),
        decorate ? el('span', { class: 'field-hint hide-sm', text: 'Click a line or a block to link them' }) : null
      ]),
      viewer
    ]);
  }

  function previewNodes(entry) {
    const ctx = {
      readOnly: true, selectedId: state.linkId, project: { roles: [] },
      lineBadge: id => (id === state.linkId && rangeOf(entry, id) ? `L${rangeOf(entry, id).start}-${rangeOf(entry, id).end}` : null)
    };
    if (entry.kind === 'Playbook') {
      return entry.parsed.items.map(item => {
        const c = { ...ctx, handlers: item.type === 'play' ? SX.handlerNames(item) : [], groups: ['all', item.hosts].filter(Boolean),
          notifyCount: h => { let n = 0; SX.walk(item.tasks || [], t => { if ([].concat(t.kw?.notify || []).includes(h.name)) n++; }); return n; } };
        return B.render(item, c);
      });
    }
    if (entry.kind === 'Role') return [B.roleFile(entry.role, 'tasks', { ...ctx, handlers: SX.handlerNames({ handlers: entry.role.handlers }) }), B.roleFile(entry.role, 'handlers', ctx)];
    if (entry.kind === 'Tasks') return [B.roleFile({ id: 'preview', tasks: entry.parsed.items }, 'tasks', ctx)];
    if (entry.kind === 'Variables') return [el('div', { class: 'stack', style: 'gap: 2px' }, Object.entries(entry.vars).map(([k, v]) => B.var(SX.newVar(k, v), ctx)))];
    if (entry.kind === 'Inventory') {
      const inv = entry.inventory;
      return [el('div', { class: 'card', style: 'min-width: 320px; background: var(--bg-panel)' }, [
        el('h3', { class: 'card-title', text: inv.path }),
        ...inv.groups.filter(g => g.name !== 'all').map(g => el('div', { class: 'found' }, [icon('server', 15), el('span', {}, [el('strong', { class: 'mono', text: g.name }), g.hosts.length ? ` — ${g.hosts.join(', ')}` : '', g.children.length ? ` (children: ${g.children.join(', ')})` : ''])])),
        el('p', { class: 'field-hint', text: `${SX.plural(inv.hosts.length, 'host')} · ${SX.plural(inv.groups.length - 1, 'group')}` })
      ])];
    }
    return [el('p', { class: 'empty-note', style: 'max-width: 360px', text: entry.error ? `This file couldn’t be read: ${entry.error}` : `${entry.path} ${entry.note || 'has no block form.'}` })];
  }

  function previewPane() {
    const entry = focusEntry();
    const stage = el('div', { style: 'display: flex; flex-direction: column; gap: 32px; width: max-content; transform: scale(.9); transform-origin: 0 0' }, entry ? previewNodes(entry) : []);
    return el('section', { class: 'well-canvas', style: 'position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0', attrs: { 'aria-label': 'Block preview' } }, [
      el('div', { class: 'pane-head', style: 'background: var(--bg-bar)' }, [
        el('span', { class: 'pane-title', text: 'Block preview' }),
        el('span', { class: 'pill' }, [icon('eye', 12), state.mode === 'view' ? 'Read-only' : 'Editable copy']),
        el('span', { class: 'grow' }),
        el('span', { class: 'mono faint', style: 'font-size: 12px', text: '90%' })
      ]),
      el('div', {
        class: 'import-preview', style: 'flex: 1; overflow: auto; padding: 26px 28px 40px',
        onclick: e => {
          const blk = e.target.closest('[data-id]');
          state.linkId = blk?.dataset.id || null;
          render({ scrollLine: true });
        }
      }, stage)
    ]);
  }

  function openNow() {
    const imported = importedProject();
    if (state.mode === 'view') {
      SX.session = {
        readOnly: true, project: imported, title: state.source?.label || 'the import',
        makeEditable: () => { SX.session = null; mergeIntoProject(imported); },
        close: () => { SX.session = null; SX.app.navigate('#/builder'); }
      };
      SX.app.navigate('#/builder');
      return;
    }
    mergeIntoProject(imported);
  }

  function mergeIntoProject(imported) {
    const counts = { playbooks: imported.playbooks.filter(pb => pb.items.length).length, roles: imported.roles.length, inventories: imported.inventories.filter(i => i.hosts.length).length };
    store.commit(p => {
      const wasEmpty = p.playbooks.every(pb => !pb.items.length) && !p.roles.length;
      if (wasEmpty && p.name === 'my-project') p.name = imported.name;
      let first = null;
      for (const pb of imported.playbooks.filter(x => x.items.length)) {
        const existing = p.playbooks.find(x => x.path === pb.path);
        if (existing) existing.items = pb.items;
        else p.playbooks.push(pb);
        first = first || (existing || pb).id;
      }
      if (wasEmpty) p.playbooks = p.playbooks.filter(pb => pb.items.length || p.playbooks.length === 1);
      for (const role of imported.roles) {
        const index = p.roles.findIndex(r => r.name === role.name);
        if (index >= 0) p.roles[index] = role;
        else p.roles.push(role);
      }
      for (const inv of imported.inventories.filter(i => i.hosts.length || i.groups.length > 1)) {
        const index = p.inventories.findIndex(i => i.path === inv.path);
        if (index >= 0) p.inventories[index] = inv;
        else p.inventories.push(inv);
        p.activeInventoryId = inv.id;
      }
      if (first) SX.openPlaybook(p, first);
      else if (imported.roles.length) SX.openRole(p, p.roles.find(r => r.name === imported.roles[0].name).id);
    }, { source: 'import' });
    const summary = [counts.playbooks && SX.plural(counts.playbooks, 'playbook'), counts.roles && SX.plural(counts.roles, 'role'), counts.inventories && SX.plural(counts.inventories, 'inventory', 'inventories')].filter(Boolean).join(', ');
    SX.app.navigate('#/builder');
    ui.toast(`Imported ${summary || 'the selection'}.`, { action: { label: 'Undo', onClick: () => store.undo() } });
  }

  function render(opts = {}) {
    const hasEntries = state.entries.some(e => !e.hidden);
    const selectedCount = state.entries.filter(e => e.selected && !e.hidden).length;
    const step = (n, label, status) => el('li', { class: status, attrs: { 'aria-current': status === 'now' ? 'step' : null } }, [el('span', { class: 'num' }, status === 'done' ? icon('checkLarge', 14) : String(n)), label]);
    const sourceScroll = root?.querySelector('.side')?.scrollTop;
    root.replaceChildren(
      el('div', { class: 'page-head', style: 'min-height: 68px' }, [
        el('a', { class: 'back-link', href: '#/builder' }, [icon('back', 16), 'Builder']),
        el('h1', { class: 'page-title', text: 'Import Ansible content' }),
        el('span', { class: 'grow' }),
        el('ol', { class: 'stepper hide-sm', attrs: { 'aria-label': 'Import steps' } }, [
          step(1, 'Source', hasEntries ? 'done' : 'now'), el('li', { class: 'line', attrs: { 'aria-hidden': 'true' } }),
          step(2, 'Review mapping', hasEntries ? 'now' : ''), el('li', { class: 'line', attrs: { 'aria-hidden': 'true' } }),
          step(3, 'Open', '')
        ])
      ]),
      el('div', { class: 'cols', style: 'grid-template-columns: 340px minmax(0, 1fr) minmax(0, 1fr)' }, [
        el('section', { class: 'side', attrs: { 'aria-label': 'Source' } }, [sourcePanel(), detectedPanel(), reportPanel()]),
        sourceViewer(),
        previewPane()
      ]),
      el('div', { class: 'actionbar', style: 'min-height: 72px' }, [
        el('span', { style: 'font: 600 13px/1 var(--font-ui); color: var(--text-muted)', text: 'Open as' }),
        ui.seg([['view', 'Visualize (read-only)'], ['edit', 'Editable copy']], state.mode, v => { state.mode = v; render(); }, { cls: 'lg', label: 'Open as' }),
        el('span', { class: 'field-hint hide-sm', style: 'font-size: 12.5px', text: state.mode === 'view' ? 'Explore the blocks without changing your project.' : 'Adds the selected files to your project (same-named files are replaced). Undo reverts it.' }),
        el('span', { class: 'grow' }),
        el('a', { class: 'btn btn-ghost', href: '#/builder', text: 'Cancel' }),
        el('button', { class: 'btn btn-primary', type: 'button', disabled: !selectedCount, onclick: openNow }, ['Open in builder', icon('arrowRight', 16)])
      ])
    );
    if (sourceScroll) root.querySelector('.side').scrollTop = sourceScroll;
    const entry = focusEntry();
    if (opts.scrollBlock && state.linkId) {
      // Scroll only vertically, so the left edge of the play stays in view.
      const pane = root.querySelector('.import-preview');
      const block = pane?.querySelector(`[data-id="${CSS.escape(state.linkId)}"]`);
      if (block) pane.scrollTop += block.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 3;
    }
    if (opts.scrollLine && state.linkId && entry) {
      const r = rangeOf(entry, state.linkId);
      if (r) root.querySelector(`.code-line[data-line="${r.start}"]`)?.scrollIntoView({ block: 'center' });
    }
  }

  SX.pages = SX.pages || {};
  SX.pages.import = {
    mount(container) {
      SX.DnD.handler = null;
      root = el('div', { class: 'page with-head', style: 'grid-template-rows: auto minmax(0, 1fr) auto; min-height: 0' });
      container.replaceChildren(root);
      render();
    },
    update() {}
  };
})();
