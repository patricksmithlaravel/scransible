// Scransible core: the global namespace, DOM and icon helpers, and the registries
// (block categories, module sets, keywords) the rest of the app builds on.
(function () {
  const SX = window.Scransible = window.Scransible || {};

  // ---- DOM -------------------------------------------------------------------------

  // Builds DOM nodes from properties rather than HTML strings, so text that was typed
  // in or imported is never parsed as markup or script.
  SX.el = function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false && key !== 'value' && key !== 'checked') continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key === 'style') node.style.cssText = value;
      else if (key === 'attrs') Object.entries(value).forEach(([name, attr]) => attr != null && node.setAttribute(name, attr));
      else if (key === 'data') Object.entries(value).forEach(([name, data]) => { node.dataset[name] = data; });
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node[key] = value;
    }
    append(node, children);
    return node;
  };

  function append(node, children) {
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      if (Array.isArray(child)) append(node, child);
      else node.append(child);
    }
  }

  const ICONS = {
    chevronDown: ['0 0 10 10', 'M2.5 4l2.5 2.5L7.5 4'],
    chevronRight: ['0 0 10 10', 'M4 2.5L6.5 5 4 7.5'],
    check: ['0 0 10 10', 'M2 5.2l2 2L8 3'],
    x: ['0 0 10 10', 'M2.5 2.5l5 5M7.5 2.5l-5 5'],
    undo: ['0 0 24 24', 'M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
    redo: ['0 0 24 24', 'M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
    import: ['0 0 24 24', 'M12 3v12', 'M7 10l5 5 5-5', 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'],
    export: ['0 0 24 24', 'M12 15V3', 'M7 8l5-5 5 5', 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'],
    upload: ['0 0 24 24', 'M12 15V4', 'M7 9l5-5 5 5', 'M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4'],
    search: ['0 0 24 24', 'circle:11,11,7', 'M20 20l-3.5-3.5'],
    bell: ['0 0 24 24', 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
    trash: ['0 0 24 24', 'M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
    plus: ['0 0 24 24', 'M12 5v14M5 12h14'],
    minus: ['0 0 24 24', 'M5 12h14'],
    fit: ['0 0 24 24', 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'],
    book: ['0 0 24 24', 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z', 'M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5'],
    copy: ['0 0 24 24', 'rect:9,9,12,12,2', 'M5 15V5a2 2 0 0 1 2-2h10'],
    warning: ['0 0 24 24', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4M12 17h.01'],
    info: ['0 0 24 24', 'circle:12,12,9', 'M12 11v5M12 8h.01'],
    back: ['0 0 24 24', 'M15 18l-6-6 6-6'],
    forward: ['0 0 24 24', 'M9 18l6-6-6-6'],
    arrowRight: ['0 0 24 24', 'M5 12h14M13 6l6 6-6 6'],
    archive: ['0 0 24 24', 'M21 8v13H3V8', 'M1 3h22v5H1z', 'M10 12h4'],
    checkLarge: ['0 0 24 24', 'M5 12.5l4.5 4.5L19 7.5'],
    eye: ['0 0 24 24', 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'circle:12,12,3'],
    shield: ['0 0 24 24', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    server: ['0 0 24 24', 'rect:3,4,18,7,2', 'rect:3,13,18,7,2', 'M7 7.5h.01M7 16.5h.01'],
    folder: ['0 0 24 24', 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
    file: ['0 0 24 24', 'M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z', 'M14 3v5h5'],
    link: ['0 0 24 24', 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1', 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1'],
    arrowDown: ['0 0 18 22', 'M9 2v17M3 13l6 6 6-6']
  };
  const FILLED = {
    more: ['0 0 24 24', 'circle:5,12,1.8', 'circle:12,12,1.8', 'circle:19,12,1.8'],
    grip: ['0 0 12 16', 'circle:3,3,1.4', 'circle:9,3,1.4', 'circle:3,8,1.4', 'circle:9,8,1.4', 'circle:3,13,1.4', 'circle:9,13,1.4']
  };

  // Inline SVG icon from the reference set. Stroked icons follow currentColor.
  SX.icon = function icon(name, size = 16, strokeWidth) {
    const filled = FILLED[name];
    const [viewBox, ...shapes] = filled || ICONS[name] || ICONS.info;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', filled ? 'currentColor' : 'none');
    if (!filled) {
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', strokeWidth || (viewBox === '0 0 10 10' ? 1.6 : 1.9));
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    for (const shape of shapes) {
      let node;
      if (shape.startsWith('circle:')) {
        const [cx, cy, r] = shape.slice(7).split(',');
        node = document.createElementNS(ns, 'circle');
        Object.entries({ cx, cy, r }).forEach(([k, v]) => node.setAttribute(k, v));
      } else if (shape.startsWith('rect:')) {
        const [x, y, width, height, rx] = shape.slice(5).split(',');
        node = document.createElementNS(ns, 'rect');
        Object.entries({ x, y, width, height, rx }).forEach(([k, v]) => node.setAttribute(k, v));
      } else {
        node = document.createElementNS(ns, 'path');
        node.setAttribute('d', shape);
      }
      svg.append(node);
    }
    return svg;
  };

  SX.logo = function logo(size = 28) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('aria-hidden', 'true');
    const parts = [
      ['path', { d: 'M3 5a2 2 0 0 1 2-2h4.5l1.5 2h3l1.5-2H23a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', fill: '#F4C542' }],
      ['rect', { x: 8, y: 12.5, width: 17, height: 6.5, rx: 2, fill: '#5FA8FF' }],
      ['rect', { x: 3, y: 20.5, width: 15, height: 5, rx: 2, fill: '#33CFB0' }]
    ];
    for (const [tag, attrs] of parts) {
      const node = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
      svg.append(node);
    }
    return svg;
  };

  // ---- Small utilities ------------------------------------------------------------

  SX.uid = () => 'n' + Math.random().toString(36).slice(2, 10);
  SX.clone = value => structuredClone(value);
  SX.debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };
  SX.plural = (count, word, pluralWord = word + 's') => `${count} ${count === 1 ? word : pluralWord}`;

  const listeners = {};
  SX.on = (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); };
  SX.emit = (event, payload) => (listeners[event] || []).forEach(fn => fn(payload));

  SX.readStorage = key => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  };
  SX.writeStorage = (key, value) => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  };

  // ---- Block categories -----------------------------------------------------------

  // Hue picks the job; every block also names its category, so color is never the only cue.
  SX.categories = [
    { id: 'plays', name: 'Plays', color: '#F4C542', sub: 'Playbook structure' },
    { id: 'control', name: 'Control', color: '#FF9A3C', sub: 'Blocks, includes & task keywords' },
    { id: 'variables', name: 'Variables', color: '#E2CBA4', sub: 'vars · set_fact · registered results' },
    { id: 'roles', name: 'Roles', color: '#F08BD8', sub: 'roles/ in this project' },
    { id: 'packages', name: 'Packages', color: '#5FA8FF' },
    { id: 'files', name: 'Files', color: '#33CFB0' },
    { id: 'services', name: 'Services', color: '#8FD45B' },
    { id: 'commands', name: 'Commands', color: '#FF7C84' },
    { id: 'access', name: 'Access', color: '#B49CFF' },
    { id: 'utilities', name: 'Utilities', color: '#C3CCDB' }
  ];
  const GENERIC_CATEGORY = { id: 'generic', name: 'Generic', color: '#3A3F4A', generic: true };

  SX.category = id => SX.categories.find(c => c.id === id) || GENERIC_CATEGORY;

  // ---- Module sets ------------------------------------------------------------------

  SX.moduleSets = [];
  const byName = new Map();
  const byShort = new Map();

  function indexModules() {
    byName.clear();
    byShort.clear();
    for (const set of SX.moduleSets) {
      for (const module of set.modules) {
        module.collection = set.collection;
        byName.set(module.name, module);
        if (!byShort.has(module.short)) byShort.set(module.short, []);
        byShort.get(module.short).push(module);
      }
    }
  }

  function checkModuleSet(set) {
    if (!set || typeof set !== 'object') throw new Error('a module set must be an object');
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(set.collection || '')) throw new Error('"collection" must look like namespace.name');
    if (!Array.isArray(set.modules)) throw new Error('"modules" must be a list');
    for (const module of set.modules) {
      if (!module || typeof module.name !== 'string' || !module.name.startsWith(set.collection + '.')) {
        throw new Error(`module "${module?.name}" must be named ${set.collection}.<module>`);
      }
      if (!module.args || typeof module.args !== 'object') throw new Error(`${module.name} needs an "args" object`);
    }
    for (const category of set.categories || []) {
      if (!category.id || !category.name || !/^#[0-9a-f]{6}$/i.test(category.color || '')) {
        throw new Error('each category needs an id, a name and a #rrggbb color');
      }
    }
  }

  // Module set files call this. A set for a collection that is already registered replaces it.
  SX.registerModuleSet = function registerModuleSet(set, source = 'bundled') {
    checkModuleSet(set);
    const entry = SX.clone(set);
    entry.source = source;
    entry.modules.forEach(module => {
      module.short = module.short || module.name.split('.').pop();
      module.palette = module.palette || [];
      module.defaults = module.defaults || {};
    });
    for (const category of entry.categories || []) {
      if (!SX.categories.some(c => c.id === category.id)) SX.categories.push({ ...category });
    }
    const existing = SX.moduleSets.findIndex(s => s.collection === entry.collection);
    if (existing >= 0) SX.moduleSets.splice(existing, 1, entry);
    else SX.moduleSets.push(entry);
    indexModules();
    SX.emit('modulesets');
    return entry;
  };

  // Resolves a fully qualified or short module name; short names prefer ansible.builtin.
  SX.module = function module(name) {
    if (!name) return null;
    if (byName.has(name)) return byName.get(name);
    if (byName.has('ansible.builtin.' + name)) return byName.get('ansible.builtin.' + name);
    if (byName.has('ansible.legacy.' + name)) return byName.get('ansible.legacy.' + name);
    const candidates = byShort.get(name);
    return candidates && candidates.length === 1 ? candidates[0] : null;
  };

  SX.allModules = () => SX.moduleSets.flatMap(set => set.modules);

  // One argument's spec, looked up by name or alias: { name, kind, required, choices, ... }.
  SX.argSpec = function argSpec(module, name) {
    if (!module) return null;
    const entry = Object.entries(module.args).find(([argName, spec]) => argName === name || spec.aliases?.includes(name));
    return entry ? { ...entry[1], name: entry[0] } : null;
  };

  SX.docsUrl = function docsUrl(moduleName) {
    const parts = (moduleName || '').split('.');
    if (parts.length !== 3) return null;
    return `https://docs.ansible.com/ansible/latest/collections/${parts[0]}/${parts[1]}/${parts[2]}_module.html`;
  };

  // Module set files are JSON inside one registerModuleSet(...) call, so an added
  // file can be read as data without running it.
  SX.parseModuleSetText = function parseModuleSetText(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const start = trimmed.indexOf('registerModuleSet(');
    const end = trimmed.lastIndexOf(')');
    if (start < 0 || end < start) throw new Error('expected JSON or a Scransible.registerModuleSet({...}) file');
    return JSON.parse(trimmed.slice(start + 'registerModuleSet('.length, end));
  };

  const USER_SETS_KEY = 'scransible.moduleSets';

  function userSets() {
    try {
      return JSON.parse(SX.readStorage(USER_SETS_KEY) || '[]');
    } catch (error) {
      return [];
    }
  }

  SX.addUserModuleSet = function addUserModuleSet(text) {
    const set = SX.parseModuleSetText(text);
    const entry = SX.registerModuleSet(set, 'added');
    const saved = userSets().filter(s => s.collection !== set.collection);
    saved.push(set);
    SX.writeStorage(USER_SETS_KEY, JSON.stringify(saved));
    return entry;
  };

  SX.removeUserModuleSet = function removeUserModuleSet(collection) {
    SX.writeStorage(USER_SETS_KEY, JSON.stringify(userSets().filter(s => s.collection !== collection)));
    const index = SX.moduleSets.findIndex(s => s.collection === collection && s.source === 'added');
    if (index >= 0) SX.moduleSets.splice(index, 1);
    indexModules();
    SX.emit('modulesets');
  };

  function loadScript(src) {
    return new Promise(resolve => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.append(script);
    });
  }

  // Loads the bundled sets listed in modules/index.js, then any the user added in the app.
  SX.loadModuleSets = async function loadModuleSets() {
    const failed = [];
    for (const file of SX.moduleSetFiles || []) {
      if (!(await loadScript(`modules/${file}`))) failed.push(file);
    }
    for (const set of userSets()) {
      try {
        SX.registerModuleSet(set, 'added');
      } catch (error) {
        failed.push(set.collection || 'an added module set');
      }
    }
    return failed;
  };

  // ---- Keywords -------------------------------------------------------------------

  // Kinds: cond (a Jinja test without braces), expr (a value that is usually a Jinja
  // expression), list, handlers (notify targets), name, bool, int, str and yaml.
  SX.KEYWORDS = {
    when: { kind: 'cond' },
    loop: { kind: 'expr', label: 'loop over' },
    notify: { kind: 'handlers' },
    register: { kind: 'name' },
    tags: { kind: 'list' },
    changed_when: { kind: 'cond', label: 'changed when' },
    failed_when: { kind: 'cond', label: 'failed when' },
    become: { kind: 'bool' },
    become_user: { kind: 'str' },
    ignore_errors: { kind: 'bool' },
    delegate_to: { kind: 'str' },
    run_once: { kind: 'bool' },
    no_log: { kind: 'bool' },
    until: { kind: 'cond' },
    retries: { kind: 'int' },
    delay: { kind: 'int' },
    check_mode: { kind: 'bool' },
    listen: { kind: 'str' },
    loop_control: { kind: 'yaml' },
    environment: { kind: 'yaml' },
    vars: { kind: 'yaml' },
    connection: { kind: 'str' },
    gather_facts: { kind: 'bool', label: 'gather facts' },
    serial: { kind: 'str' },
    strategy: { kind: 'str' },
    any_errors_fatal: { kind: 'bool' },
    max_fail_percentage: { kind: 'int' },
    remote_user: { kind: 'str' },
    timeout: { kind: 'int' },
    throttle: { kind: 'int' },
    diff: { kind: 'bool' },
    order: { kind: 'str' },
    force_handlers: { kind: 'bool' },
    vars_files: { kind: 'list' },
    collections: { kind: 'list' },
    module_defaults: { kind: 'yaml' }
  };

  SX.keywordSpec = name => SX.KEYWORDS[name] || { kind: 'str' };

  // What each kind of item can carry, in the order the inspector offers them.
  SX.KEYWORD_SETS = {
    task: ['when', 'loop', 'notify', 'register', 'tags', 'changed_when', 'failed_when', 'become', 'become_user', 'ignore_errors',
      'delegate_to', 'run_once', 'no_log', 'until', 'retries', 'delay', 'check_mode', 'listen', 'loop_control', 'environment', 'vars', 'timeout', 'throttle'],
    block: ['when', 'tags', 'become', 'become_user', 'ignore_errors', 'delegate_to', 'run_once', 'no_log', 'environment', 'vars', 'notify'],
    play: ['become', 'become_user', 'gather_facts', 'connection', 'serial', 'strategy', 'any_errors_fatal', 'max_fail_percentage',
      'ignore_errors', 'remote_user', 'order', 'force_handlers', 'vars_files', 'collections', 'module_defaults', 'environment', 'tags', 'timeout'],
    role: ['when', 'tags', 'become', 'delegate_to']
  };

  // Every keyword Ansible accepts on a task, so an imported task's module is whatever key is left.
  SX.TASK_KEYWORD_NAMES = new Set(['action', 'any_errors_fatal', 'args', 'async', 'become', 'become_exe', 'become_flags',
    'become_method', 'become_user', 'changed_when', 'check_mode', 'collections', 'connection', 'debugger', 'delay',
    'delegate_facts', 'delegate_to', 'diff', 'environment', 'failed_when', 'ignore_errors', 'ignore_unreachable',
    'local_action', 'loop', 'loop_control', 'module_defaults', 'name', 'no_log', 'notify', 'poll', 'port', 'register',
    'remote_user', 'retries', 'run_once', 'tags', 'throttle', 'timeout', 'until', 'vars', 'when', 'listen',
    'block', 'rescue', 'always']);
})();
