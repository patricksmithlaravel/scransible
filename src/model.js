// The project model: playbooks of plays and tasks, roles, inventories and export
// settings, plus the store that saves it and keeps undo history.
(function () {
  const SX = window.Scransible;

  const PROJECT_KEY = 'scransible.project';
  const LEGACY_KEY = 'ansiblePlaybookBuilderState';

  // Lists of child items, by the kind of item that holds them.
  SX.SECTIONS = {
    play: ['vars', 'roles', 'pre_tasks', 'tasks', 'post_tasks', 'handlers'],
    block: ['block', 'rescue', 'always'],
    roleDef: ['tasks', 'handlers']
  };
  const TASK_LISTS = ['pre_tasks', 'tasks', 'post_tasks', 'handlers', 'block', 'rescue', 'always'];

  // ---- Factories ------------------------------------------------------------------

  SX.newTask = function newTask(moduleName, fields = {}) {
    const module = SX.module(moduleName);
    return {
      id: SX.uid(),
      type: 'task',
      name: fields.name ?? '',
      module: module ? module.name : moduleName,
      args: fields.args ?? SX.clone(module?.defaults || {}),
      kw: fields.kw ?? {}
    };
  };

  SX.newBlock = (fields = {}) => ({
    id: SX.uid(), type: 'block', name: fields.name ?? '', kw: fields.kw ?? {},
    block: fields.block ?? [], rescue: fields.rescue ?? [], always: fields.always ?? []
  });

  SX.newPlay = (fields = {}) => ({
    id: SX.uid(), type: 'play', name: fields.name ?? 'New play', hosts: fields.hosts ?? 'all',
    kw: fields.kw ?? {}, vars: fields.vars ?? [], roles: fields.roles ?? [],
    pre_tasks: fields.pre_tasks ?? [], tasks: fields.tasks ?? [], post_tasks: fields.post_tasks ?? [], handlers: fields.handlers ?? [],
    ui: fields.ui ?? { collapsed: {}, show: {} }, pos: fields.pos ?? null
  });

  SX.newImport = (fields = {}) => ({ id: SX.uid(), type: 'import', path: fields.path ?? '', kw: fields.kw ?? {}, pos: fields.pos ?? null });
  SX.newVar = (key = '', value = '') => ({ id: SX.uid(), type: 'var', key, value });
  SX.newRoleRef = (role = '', vars = {}) => ({ id: SX.uid(), type: 'role', role, vars, kw: {} });

  SX.newRole = (name, fields = {}) => ({
    id: SX.uid(), name, description: fields.description ?? '', tasks: fields.tasks ?? [], handlers: fields.handlers ?? [],
    defaults: fields.defaults ?? [], templates: fields.templates ?? [], files: fields.files ?? [], dependencies: fields.dependencies ?? []
  });

  SX.newInventory = (path, fields = {}) => ({
    id: SX.uid(), path, groups: fields.groups ?? [{ id: SX.uid(), name: 'all', children: [], hosts: [], vars: [] }], hosts: fields.hosts ?? []
  });

  SX.newProject = (name = 'my-project') => {
    const playbook = { id: SX.uid(), path: 'site.yml', items: [] };
    const inventory = SX.newInventory('inventory/hosts.ini');
    return {
      version: 2, name, playbooks: [playbook], activePlaybookId: playbook.id, roles: [], inventories: [inventory],
      activeInventoryId: inventory.id,
      settings: { fqcn: true, keepLayout: true, quote: 'needed', indent: 2, format: 'zip', exportRole: null }
    };
  };

  // ---- Tree helpers ----------------------------------------------------------------

  SX.sectionsOf = node => node.type === 'play' ? SX.SECTIONS.play : node.type === 'block' ? SX.SECTIONS.block : [];

  SX.walk = function walk(nodes, callback, parent = null, section = null) {
    for (const node of nodes) {
      callback(node, parent, section);
      for (const s of SX.sectionsOf(node)) walk(node[s] || [], callback, node, s);
    }
  };

  // Every top-level list of items in the project (playbooks and role task files).
  SX.rootLists = function rootLists(project) {
    const lists = project.playbooks.map(pb => ({ owner: pb, section: 'items', list: pb.items }));
    for (const role of project.roles) {
      lists.push({ owner: role, section: 'tasks', list: role.tasks }, { owner: role, section: 'handlers', list: role.handlers });
    }
    return lists;
  };

  // Finds an item anywhere in the project: { node, list, index, owner, section }.
  SX.locate = function locate(project, id) {
    for (const root of SX.rootLists(project)) {
      const found = locateIn(root.list, id, root.owner, root.section);
      if (found) return found;
    }
    return null;
  };

  function locateIn(list, id, owner, section) {
    for (let index = 0; index < list.length; index++) {
      const node = list[index];
      if (node.id === id) return { node, list, index, owner, section };
      for (const s of SX.sectionsOf(node)) {
        const found = locateIn(node[s] || [], id, node, s);
        if (found) return found;
      }
    }
    return null;
  }

  SX.findNode = (project, id) => SX.locate(project, id)?.node || null;

  // The play a node belongs to, if any.
  SX.playOf = function playOf(project, id) {
    for (const pb of project.playbooks) {
      for (const item of pb.items) {
        if (item.type === 'play' && (item.id === id || locateIn([item], id))) return item;
      }
    }
    return null;
  };

  SX.reassignIds = node => {
    node.id = SX.uid();
    for (const s of SX.sectionsOf(node)) (node[s] || []).forEach(SX.reassignIds);
  };

  SX.activePlaybook = project => project.playbooks.find(pb => pb.id === project.activePlaybookId) || project.playbooks[0];

  // What the builder is editing: a playbook, or a role's tasks and handlers.
  SX.activeDoc = function activeDoc(project) {
    const d = project.activeDoc;
    if (d?.type === 'role') {
      const role = project.roles.find(r => r.id === d.id);
      if (role) return { kind: 'role', role, path: `roles/${role.name}/tasks/main.yml`, where: `roles/${role.name}` };
    }
    const playbook = SX.activePlaybook(project);
    return { kind: 'playbook', playbook, path: playbook.path, where: playbook.path };
  };
  SX.openPlaybook = (project, id) => { project.activePlaybookId = id; project.activeDoc = { type: 'playbook', id }; };
  SX.openRole = (project, id) => { project.activeDoc = { type: 'role', id }; };
  SX.activeInventory = project => project.inventories.find(inv => inv.id === project.activeInventoryId) || project.inventories[0];

  SX.handlerNames = function handlerNames(play) {
    const names = [];
    SX.walk(play?.handlers || [], node => {
      if (node.type !== 'task') return;
      if (node.name) names.push(node.name);
      if (node.kw.listen) names.push(String(node.kw.listen));
    });
    return [...new Set(names)];
  };

  // ---- Validation and normalizing -----------------------------------------------

  const NODE_TYPES = ['play', 'task', 'block', 'import', 'var', 'role'];
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

  function checkNodes(list, where) {
    if (!Array.isArray(list)) throw new Error(`${where} is not a list`);
    list.forEach((node, i) => {
      const here = `${where} item ${i + 1}`;
      if (!isObject(node)) throw new Error(`${here} is not an object`);
      if (!NODE_TYPES.includes(node.type)) throw new Error(`${here} has an unknown type`);
      for (const key of ['args', 'kw']) {
        if (node[key] != null && !isObject(node[key])) throw new Error(`${here} has an invalid "${key}"`);
      }
      for (const s of SX.sectionsOf(node)) if (node[s] != null) checkNodes(node[s], `${here} ${s}`);
    });
  }

  SX.validateProject = function validateProject(value) {
    if (!isObject(value) || value.version !== 2) throw new Error('not a Scransible project file');
    if (!Array.isArray(value.playbooks) || !value.playbooks.length) throw new Error('the project has no playbooks');
    value.playbooks.forEach((pb, i) => checkNodes(pb.items, `playbook ${i + 1}`));
    (value.roles || []).forEach((role, i) => {
      checkNodes(role.tasks || [], `role ${i + 1} tasks`);
      checkNodes(role.handlers || [], `role ${i + 1} handlers`);
    });
    if (value.inventories != null && !Array.isArray(value.inventories)) throw new Error('"inventories" must be a list');
  };

  function normalizeNode(node, seen) {
    if (typeof node.id !== 'string' || seen.has(node.id)) node.id = SX.uid();
    seen.add(node.id);
    node.kw = isObject(node.kw) ? node.kw : {};
    if (node.type === 'task') {
      node.name = node.name ?? '';
      node.args = isObject(node.args) ? node.args : {};
    }
    if (node.type === 'play') {
      node.name = node.name ?? '';
      node.hosts = node.hosts ?? 'all';
      node.ui = isObject(node.ui) ? node.ui : {};
      node.ui.collapsed = isObject(node.ui.collapsed) ? node.ui.collapsed : {};
      node.ui.show = isObject(node.ui.show) ? node.ui.show : {};
    }
    if (node.type === 'block') node.name = node.name ?? '';
    if (node.type === 'role') node.vars = isObject(node.vars) ? node.vars : {};
    for (const s of SX.sectionsOf(node)) {
      node[s] = Array.isArray(node[s]) ? node[s] : [];
      node[s].forEach(child => normalizeNode(child, seen));
    }
  }

  SX.normalizeProject = function normalizeProject(project) {
    const seen = new Set();
    const fresh = SX.newProject(project.name);
    project.name = project.name || 'my-project';
    project.settings = { ...fresh.settings, ...(project.settings || {}) };
    project.playbooks.forEach(pb => {
      pb.id = pb.id || SX.uid();
      pb.path = pb.path || 'site.yml';
      pb.items.forEach(node => normalizeNode(node, seen));
    });
    if (!project.playbooks.some(pb => pb.id === project.activePlaybookId)) project.activePlaybookId = project.playbooks[0].id;
    if (project.activeDoc?.type !== 'role') project.activeDoc = { type: 'playbook', id: project.activePlaybookId };
    project.roles = (project.roles || []).map(role => {
      const full = { ...SX.newRole(role.name), ...role };
      full.tasks.forEach(node => normalizeNode(node, seen));
      full.handlers.forEach(node => normalizeNode(node, seen));
      return full;
    });
    project.inventories = (project.inventories || []).length ? project.inventories : fresh.inventories;
    project.inventories.forEach(inv => {
      inv.id = inv.id || SX.uid();
      inv.groups = inv.groups || [];
      inv.hosts = inv.hosts || [];
      if (!inv.groups.some(g => g.name === 'all')) inv.groups.unshift({ id: SX.uid(), name: 'all', children: [], hosts: [], vars: [] });
    });
    if (!project.inventories.some(inv => inv.id === project.activeInventoryId)) project.activeInventoryId = project.inventories[0].id;
    return project;
  };

  // ---- Migration from the single-file builder (an array of plays) -------------------

  function legacyScalar(value) {
    return typeof value === 'string' ? SX.Ansible.typedScalar(value) : value;
  }

  function legacyKw(item) {
    const kw = {};
    if (item.when) kw.when = item.when;
    if (item.tags) kw.tags = String(item.tags).split(',').map(t => t.trim()).filter(Boolean);
    if (item.become) kw.become = legacyScalar(item.become);
    for (const { k, v } of item.custom || []) {
      if (!k) continue;
      kw[k] = k === 'notify' ? [String(v)] : k === 'tags' ? String(v).split(',').map(t => t.trim()).filter(Boolean) : legacyScalar(v);
    }
    if (item.type === 'block' && item.vars?.length) {
      kw.vars = Object.fromEntries(item.vars.map(({ k, v }) => [k, legacyScalar(v)]));
    }
    return kw;
  }

  function legacyItem(item, hoisted) {
    if (item.type === 'task') {
      return { id: SX.uid(), type: 'task', name: item.params?.name || '', module: item.params?.module || '', args: item.moduleArgs || {}, kw: legacyKw(item) };
    }
    if (item.type === 'block') {
      const list = arr => (arr || []).filter(c => c.type !== 'play' || (hoisted.push(c), false)).map(c => legacyItem(c, hoisted));
      return { ...SX.newBlock({ name: item.params?.name || '', kw: legacyKw(item) }), block: list(item.children), rescue: list(item.rescue), always: list(item.always) };
    }
    return null;
  }

  function legacyPlay(item, hoisted) {
    const params = item.params || {};
    const kw = {};
    if (params.connection) kw.connection = params.connection;
    const gather = legacyScalar(params.gather_facts ?? '');
    if (typeof gather === 'boolean') kw.gather_facts = gather;
    Object.assign(kw, legacyKw({ custom: item.custom }));
    const list = arr => (arr || []).filter(c => c.type !== 'play' || (hoisted.push(c), false)).map(c => legacyItem(c, hoisted));
    return SX.newPlay({
      name: params.name || '', hosts: params.hosts || 'all', kw,
      vars: (item.vars || []).map(({ k, v }) => SX.newVar(k, v)),
      tasks: list(item.children), handlers: list(item.handlers)
    });
  }

  SX.migrateLegacy = function migrateLegacy(plays) {
    const project = SX.newProject('my-project');
    const items = [];
    const queue = [...plays];
    while (queue.length) {
      const hoisted = [];
      items.push(legacyPlay(queue.shift(), hoisted));
      queue.push(...hoisted);
    }
    SX.activePlaybook(project).items = items;
    return SX.normalizeProject(project);
  };

  // ---- Store: saving and undo ------------------------------------------------------

  const store = SX.store = {
    project: null,
    undoStack: [],
    redoStack: [],
    saved: true,
    typingKey: null,
    typingAt: 0,

    load() {
      const saved = SX.readStorage(PROJECT_KEY);
      if (saved) {
        try {
          const project = JSON.parse(saved);
          SX.validateProject(project);
          this.project = SX.normalizeProject(project);
          return 'loaded';
        } catch (error) {
          SX.writeStorage(`${PROJECT_KEY}.unreadable`, saved);
          this.project = SX.newProject();
          return `unreadable: ${error.message}`;
        }
      }
      const legacy = SX.readStorage(LEGACY_KEY);
      if (legacy) {
        try {
          const plays = JSON.parse(legacy);
          if (Array.isArray(plays) && plays.length) {
            this.project = SX.migrateLegacy(plays);
            this.persist();
            return 'migrated';
          }
        } catch (error) {
          // An unreadable old save is left where it is.
        }
      }
      this.project = SX.newProject();
      return 'new';
    },

    persist() {
      this.saved = SX.writeStorage(PROJECT_KEY, JSON.stringify(this.project));
    },

    checkpoint() {
      this.undoStack.push(JSON.stringify(this.project));
      if (this.undoStack.length > 150) this.undoStack.shift();
      this.redoStack = [];
      this.typingKey = null;
    },

    // Every change goes through here: snapshot for undo, change, save, tell the views.
    commit(change, { source, checkpoint = true, select } = {}) {
      if (checkpoint) this.checkpoint();
      const result = change(this.project);
      this.persist();
      SX.emit('change', { source, select });
      return result;
    },

    // Typing in one field is one undo step until you pause or move to another field.
    typing(key, change, source) {
      const now = Date.now();
      if (key !== this.typingKey || now - this.typingAt > 1500) {
        this.checkpoint();
        this.typingKey = key;
      }
      this.typingAt = now;
      change(this.project);
      this.persist();
      SX.emit('change', { source, typing: true });
    },

    replace(project, { checkpoint = true } = {}) {
      if (checkpoint) this.checkpoint();
      this.project = SX.normalizeProject(project);
      this.persist();
      SX.emit('change', { source: 'replace' });
    },

    step(from, to) {
      if (!from.length) return;
      to.push(JSON.stringify(this.project));
      this.project = JSON.parse(from.pop());
      this.typingKey = null;
      this.persist();
      SX.emit('change', { source: 'history' });
    },
    undo() { this.step(this.undoStack, this.redoStack); },
    redo() { this.step(this.redoStack, this.undoStack); }
  };

  // ---- The example project (matches the design reference) -------------------------

  SX.exampleProject = function exampleProject() {
    const t = (module, name, args, kw) => SX.newTask(module, { name, args, kw });
    const project = SX.newProject('web-stack');
    const handlers = [t('ansible.builtin.service', 'reload nginx', { name: 'nginx', state: 'reloaded' })];
    const play = SX.newPlay({
      name: 'Configure web tier', hosts: 'webservers', kw: { become: true, gather_facts: true },
      vars: [SX.newVar('app_env', 'production'), SX.newVar('server_name', 'shop.example.com')],
      roles: [SX.newRoleRef('common'), SX.newRoleRef('nginx', { nginx_worker_processes: 4 })],
      tasks: [
        t('ansible.builtin.apt', 'Install packages', { name: ['git', 'curl', 'ufw'], state: 'present', update_cache: true }),
        t('ansible.builtin.template', 'Render site config',
          { src: 'site.conf.j2', dest: '/etc/nginx/sites-enabled/shop.conf', owner: 'root', group: 'root', mode: '0644', validate: 'nginx -t -c %s' },
          { notify: ['reload nginx'], tags: ['nginx', 'config'] }),
        t('community.general.ufw', 'Open HTTP port', { rule: 'allow', to_port: '{{ http_port }}', proto: 'tcp' }, { when: "app_env == 'production'" }),
        SX.newBlock({
          name: 'Deploy release',
          block: [t('ansible.builtin.command', 'Run migrations', { cmd: './manage.py migrate', chdir: '/srv/shop' }, { register: 'migrate_out' })],
          rescue: [t('ansible.builtin.debug', 'Report failure', { msg: '{{ migrate_out.stderr }}' })],
          always: [t('ansible.builtin.file', 'Clean up build dir', { path: '/srv/shop/tmp', state: 'absent' })]
        }),
        t('ansible.builtin.service', 'Ensure nginx running', { name: 'nginx', state: 'started', enabled: true })
      ],
      handlers,
      ui: { collapsed: { vars: true }, show: {} },
      pos: { x: 32, y: 24 }
    });
    SX.activePlaybook(project).items = [play];

    project.roles = [
      SX.newRole('common', {
        description: 'Baseline packages and settings every host gets.',
        tasks: [
          t('ansible.builtin.apt', 'Refresh package cache', { update_cache: true }),
          t('ansible.builtin.apt', 'Install baseline tools', { name: ['vim', 'htop', 'unattended-upgrades'], state: 'present' }),
          t('ansible.builtin.user', 'Create deploy user', { name: 'deploy', groups: ['sudo'] }),
          t('ansible.posix.authorized_key', 'Authorize deploy key', { user: 'deploy', key: "{{ lookup('file', 'files/deploy.pub') }}" }),
          t('community.general.timezone', 'Set timezone', { name: 'UTC' })
        ]
      }),
      SX.newRole('nginx', {
        description: 'Installs nginx and manages its main config.',
        tasks: [
          t('ansible.builtin.apt', 'Install nginx', { name: 'nginx', state: 'present' }),
          t('ansible.builtin.template', 'Write nginx.conf', { src: 'nginx.conf.j2', dest: '/etc/nginx/nginx.conf' }, { notify: ['restart nginx'] }),
          t('ansible.builtin.file', 'Remove default site', { path: '/etc/nginx/sites-enabled/default', state: 'absent' }, { notify: ['restart nginx'] }),
          t('ansible.builtin.service', 'Start nginx', { name: 'nginx', state: 'started', enabled: true })
        ],
        handlers: [t('ansible.builtin.service', 'restart nginx', { name: 'nginx', state: 'restarted' })],
        defaults: [SX.newVar('http_port', 80), SX.newVar('nginx_worker_processes', 'auto'), SX.newVar('nginx_client_max_body_size', '1m')],
        templates: [{
          id: SX.uid(), path: 'nginx.conf.j2',
          content: 'worker_processes {{ nginx_worker_processes }};\n\nevents {\n  worker_connections 768;\n}\n\nhttp {\n  client_max_body_size {{ nginx_client_max_body_size }};\n  include /etc/nginx/sites-enabled/*;\n}\n'
        }],
        dependencies: ['common']
      })
    ];

    const group = (name, extra = {}) => ({ id: SX.uid(), name, children: [], hosts: [], vars: [], ...extra });
    const host = (name, address) => ({ id: SX.uid(), name, address, vars: [] });
    project.inventories = [
      SX.newInventory('inventory/production.ini', {
        groups: [
          group('all'),
          group('production', { children: ['webservers', 'dbservers'] }),
          group('webservers', { hosts: ['web-01', 'web-02'], vars: [SX.newVar('http_port', 8080), SX.newVar('ansible_user', 'deploy')] }),
          group('dbservers', { hosts: ['db-01'] })
        ],
        hosts: [host('web-01', '10.0.1.11'), host('web-02', '10.0.1.12'), host('db-01', '10.0.2.21')]
      }),
      SX.newInventory('inventory/staging.ini', {
        groups: [group('all'), group('webservers', { hosts: ['stage-web'] }), group('dbservers', { hosts: ['stage-db'] })],
        hosts: [host('stage-web', '10.9.1.11'), host('stage-db', '10.9.2.21')]
      })
    ];
    project.activeInventoryId = project.inventories[0].id;
    return SX.normalizeProject(project);
  };

  SX.TASK_LISTS = TASK_LISTS;
})();
