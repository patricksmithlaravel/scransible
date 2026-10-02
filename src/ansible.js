// Turning the model into Ansible YAML and back: typed output, import with source
// line ranges, inventories, and the files a project exports as.
(function () {
  const SX = window.Scransible;
  const A = SX.Ansible = {};
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

  // ---- Values -----------------------------------------------------------------------

  // Fields hold plain text. Empty text, booleans and integers become real YAML values,
  // so `gather_facts: no` and `retries: 3` mean what they say. Everything else stays a
  // string (including decimals like 15.10, which would otherwise lose digits) and
  // js-yaml quotes it wherever YAML 1.1 would misread it.
  A.typedScalar = function typedScalar(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (text === '') return null;
    if (/^(true|yes|on)$/i.test(text)) return true;
    if (/^(false|no|off)$/i.test(text)) return false;
    if (/^(0|-?[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
    return value;
  };

  A.isEmpty = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && !value.length) || (isObject(value) && !Object.keys(value).length);

  // Arguments documented as strings, lists or choices are never converted, so
  // `cmd: true` runs the `true` command rather than becoming a boolean.
  function typedArg(module, name, value) {
    if (module?.freeArgs && name !== '_raw') return A.typedScalar(value);
    const kind = SX.argSpec(module, name)?.kind;
    if (typeof value === 'string' && kind && kind !== 'int' && kind !== 'bool') return value;
    return A.typedScalar(value);
  }

  function keywordValue(name, value) {
    if (A.isEmpty(value)) return undefined;
    const kind = SX.keywordSpec(name).kind;
    if (kind === 'list' || kind === 'handlers' || (kind === 'cond' && Array.isArray(value))) {
      const items = [].concat(value).filter(v => !A.isEmpty(v));
      if (!items.length) return undefined;
      // One handler, condition or tag is written as a plain value; vars_files and collections stay lists.
      const single = items.length === 1 && (kind !== 'list' || name === 'tags');
      return single ? items[0] : items;
    }
    if (kind === 'bool' || kind === 'int') return A.typedScalar(value);
    return value;
  }

  function addKeywords(out, kw) {
    for (const [name, value] of Object.entries(kw || {})) {
      const typed = keywordValue(name, value);
      if (typed !== undefined) out[name] = typed;
    }
  }

  function varsObject(vars) {
    const out = {};
    for (const v of vars || []) {
      if (String(v.key ?? '').trim() === '') continue;
      out[v.key] = typeof v.value === 'string' ? A.typedScalar(v.value) : v.value;
    }
    return out;
  }

  function plainVars(vars) {
    const out = {};
    for (const [key, value] of Object.entries(vars || {})) out[key] = typeof value === 'string' ? A.typedScalar(value) : value;
    return out;
  }

  // ---- Model -> YAML objects --------------------------------------------------------

  A.moduleKey = (name, opts = {}) => opts.fqcn === false && name.startsWith('ansible.builtin.') ? name.slice('ansible.builtin.'.length) : name;

  // The module's value: a mapping of arguments, or a free-form string such as
  // `meta: flush_handlers` (with any other arguments under `args:`).
  A.moduleValue = function moduleValue(task) {
    const module = SX.module(task.module);
    const typed = {};
    for (const [name, value] of Object.entries(task.args || {})) {
      if (A.isEmpty(value)) continue;
      typed[name] = typedArg(module, name, value);
    }
    if (!('_raw' in typed)) return { value: typed };
    const raw = typed._raw;
    delete typed._raw;
    return Object.keys(typed).length ? { value: raw, args: typed } : { value: raw };
  };

  A.taskObject = function taskObject(node, opts = {}) {
    if (node.type === 'block') return A.blockObject(node, opts);
    const out = {};
    if (node.name) out.name = node.name;
    const { value, args } = A.moduleValue(node);
    out[A.moduleKey(node.module || 'ansible.builtin.debug', opts)] = value;
    if (args) out.args = args;
    addKeywords(out, node.kw);
    return out;
  };

  // Block keys come last, as ansible-lint expects.
  A.blockObject = function blockObject(node, opts = {}) {
    const out = {};
    if (node.name) out.name = node.name;
    addKeywords(out, node.kw);
    out.block = A.taskList(node.block, opts);
    if (node.rescue.length) out.rescue = A.taskList(node.rescue, opts);
    if (node.always.length) out.always = A.taskList(node.always, opts);
    return out;
  };

  A.taskList = (list, opts) => list.filter(n => n.type === 'task' || n.type === 'block').map(n => A.taskObject(n, opts));

  A.roleRefObject = function roleRefObject(ref) {
    const out = { role: ref.role };
    const vars = plainVars(ref.vars);
    if (Object.keys(vars).length) out.vars = vars;
    addKeywords(out, ref.kw);
    return out;
  };

  A.playObject = function playObject(play, opts = {}) {
    const out = { name: play.name, hosts: play.hosts };
    addKeywords(out, play.kw);
    const vars = varsObject(play.vars);
    if (Object.keys(vars).length) out.vars = vars;
    if (play.roles.length) out.roles = play.roles.map(A.roleRefObject);
    for (const section of ['pre_tasks', 'tasks', 'post_tasks', 'handlers']) {
      if (play[section].length) out[section] = A.taskList(play[section], opts);
    }
    return out;
  };

  A.itemObject = function itemObject(item, opts = {}) {
    if (item.type === 'import') {
      const out = { [opts.fqcn === false ? 'import_playbook' : 'ansible.builtin.import_playbook']: item.path };
      addKeywords(out, item.kw);
      return out;
    }
    return A.playObject(item, opts);
  };

  A.playbookObject = (playbook, opts = {}) => playbook.items.map(item => A.itemObject(item, opts));

  // ---- YAML text --------------------------------------------------------------------

  A.yamlOptions = (opts = {}) => ({
    lineWidth: -1, noRefs: true, quotingType: '"', skipInvalid: true,
    forceQuotes: opts.quote === 'always', indent: Number(opts.indent) || 2
  });

  // Dumps with js-yaml, then parses the text back and compares, so a serializer
  // problem shows up as a problem instead of a silently broken playbook.
  A.dump = function dump(object, opts = {}, header = '---\n') {
    if (!window.jsyaml) return { text: '', problem: 'The js-yaml library did not load (are you offline?), so no YAML can be generated.' };
    try {
      const text = header + window.jsyaml.dump(object, A.yamlOptions(opts));
      let problem = null;
      try {
        if (JSON.stringify(window.jsyaml.load(text)) !== JSON.stringify(object)) problem = 'The generated YAML does not read back as the blocks shown.';
      } catch (error) {
        problem = `The generated YAML does not parse: ${error.message}`;
      }
      return { text, problem };
    } catch (error) {
      return { text: '', problem: `Could not generate YAML: ${error.message}` };
    }
  };

  A.playbookYaml = (playbook, opts = {}, header = '---\n') => A.dump(A.playbookObject(playbook, opts), opts, header);

  A.fragmentYaml = function fragmentYaml(node, opts = {}) {
    const object = node.type === 'play' || node.type === 'import' ? A.itemObject(node, opts)
      : node.type === 'role' ? A.roleRefObject(node)
      : node.type === 'var' ? varsObject([node])
      : A.taskObject(node, opts);
    return A.dump(node.type === 'var' ? object : [object], opts, '');
  };

  // Syntax colors from the design reference.
  A.YAML_COLORS = { text: '#ECEAE4', punct: '#808794', key: '#8DB9FF', fqcn: '#5FE0C6', string: '#E6CF9C', number: '#FFB067', jinja: '#F4A3E3', comment: '#808794' };

  A.highlightLine = function highlightLine(line) {
    const c = A.YAML_COLORS;
    const segs = [];
    const m = line.match(/^(\s*)(- )?(.*)$/);
    const [, indent, dash = '', rest] = m;
    const valueColor = v => v.includes('{{') ? c.jinja : /^(true|false|yes|no|null|~|-?\d+(\.\d+)?)$/.test(v.trim()) ? c.number : c.string;
    if (indent) segs.push([indent, c.text]);
    if (dash) segs.push([dash, c.punct]);
    if (rest.startsWith('#') || rest === '---') return segs.concat([[rest, c.comment]]);
    const kv = rest.match(/^([A-Za-z0-9_.\-/]+):(\s?)(.*)$/);
    if (kv) {
      segs.push([kv[1], kv[1].includes('.') ? c.fqcn : c.key], [':' + kv[2], c.punct]);
      if (kv[3]) segs.push([kv[3], valueColor(kv[3])]);
    } else if (rest) {
      segs.push([rest, valueColor(rest)]);
    }
    return segs;
  };

  // ---- YAML -> model (import) -------------------------------------------------------

  // Parses YAML and records each mapping/sequence's 1-based line range.
  A.loadWithRanges = function loadWithRanges(text) {
    const lines = text.split('\n');
    const ranges = new WeakMap();
    const stack = [];
    const data = window.jsyaml.load(text, {
      listener(event, state) {
        if (event === 'open') {
          stack.push(state.line);
          return;
        }
        const start = stack.pop();
        if (!state.result || typeof state.result !== 'object') return;
        let end = Math.max(start + 1, state.line);
        while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1] || '')) end--;
        ranges.set(state.result, { start: start + 1, end });
      }
    });
    return { data, ranges };
  };

  function parseKeyValues(text) {
    const args = {};
    for (const m of String(text).matchAll(/([A-Za-z_][\w]*)=("[^"]*"|'[^']*'|\S+)/g)) args[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    return args;
  }

  function normalizeKeyword(name, value) {
    if (name === 'notify') return [].concat(value).map(String);
    if (name === 'tags') return typeof value === 'string' ? value.split(',').map(t => t.trim()).filter(Boolean) : [].concat(value).map(String);
    return value;
  }

  function context(ranges) {
    return { ranges, nodeRanges: new Map(), problems: [], unknownModules: new Set(), jinja: 0, counts: { plays: 0, tasks: 0, handlers: 0, blocks: 0 } };
  }

  function track(ctx, source, node) {
    const range = ctx.ranges?.get(source);
    if (range) ctx.nodeRanges.set(node.id, range);
    return node;
  }

  function countJinja(ctx, value) {
    if (typeof value === 'string') ctx.jinja += (value.match(/\{\{/g) || []).length;
    else if (Array.isArray(value)) value.forEach(v => countJinja(ctx, v));
    else if (isObject(value)) Object.values(value).forEach(v => countJinja(ctx, v));
  }

  A.parseTask = function parseTask(obj, ctx, where = 'task') {
    if (!isObject(obj)) {
      ctx.problems.push(`A ${where} is not a mapping, so it was skipped.`);
      return null;
    }
    countJinja(ctx, obj);
    if ('block' in obj) {
      ctx.counts.blocks++;
      const kw = {};
      for (const [key, value] of Object.entries(obj)) {
        if (!['name', 'block', 'rescue', 'always'].includes(key)) kw[key] = normalizeKeyword(key, value);
      }
      return track(ctx, obj, SX.newBlock({
        name: obj.name ?? '', kw,
        block: A.parseTaskList(obj.block, ctx), rescue: A.parseTaskList(obj.rescue, ctx), always: A.parseTaskList(obj.always, ctx)
      }));
    }
    let moduleKey = Object.keys(obj).find(key => !SX.TASK_KEYWORD_NAMES.has(key) && !key.startsWith('with_'));
    let value = moduleKey ? obj[moduleKey] : undefined;
    const kw = {};
    if (!moduleKey && (obj.action || obj.local_action)) {
      const action = obj.action ?? obj.local_action;
      if (isObject(action)) {
        moduleKey = action.module;
        value = Object.fromEntries(Object.entries(action).filter(([k]) => k !== 'module'));
      } else {
        const [first, ...rest] = String(action).trim().split(/\s+/);
        moduleKey = first;
        value = rest.join(' ');
      }
      if (obj.local_action) kw.delegate_to = 'localhost';
    }
    if (!moduleKey) ctx.problems.push(`"${obj.name || 'A task'}" has no module, so it is kept as an empty generic block.`);
    const module = SX.module(moduleKey);
    if (moduleKey && !module) ctx.unknownModules.add(moduleKey);
    let args;
    if (isObject(value)) args = SX.clone(value);
    else if (value === null || value === undefined || value === '') args = {};
    else if (typeof value === 'string' && value.includes('=') && !(module && '_raw' in module.args)) args = parseKeyValues(value);
    else args = { _raw: value };
    if (isObject(obj.args)) Object.assign(args, obj.args);
    for (const [key, val] of Object.entries(obj)) {
      if (['name', 'args', 'action', 'local_action'].includes(key) || key === moduleKey) continue;
      kw[key] = normalizeKeyword(key, val);
    }
    ctx.counts.tasks++;
    return track(ctx, obj, { id: SX.uid(), type: 'task', name: obj.name ?? '', module: module ? module.name : (moduleKey || ''), args, kw });
  };

  A.parseTaskList = function parseTaskList(list, ctx) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      ctx.problems.push('A task list is not a list, so it was skipped.');
      return [];
    }
    return list.map(item => A.parseTask(item, ctx)).filter(Boolean);
  };

  function parseRoleRef(entry, ctx) {
    if (typeof entry === 'string') return SX.newRoleRef(entry);
    if (!isObject(entry)) return null;
    const name = entry.role ?? entry.name;
    const ref = SX.newRoleRef(String(name ?? ''), isObject(entry.vars) ? SX.clone(entry.vars) : {});
    for (const [key, value] of Object.entries(entry)) {
      if (!['role', 'name', 'vars'].includes(key)) ref.kw[key] = normalizeKeyword(key, value);
    }
    return track(ctx, entry, ref);
  }

  A.parsePlay = function parsePlay(obj, ctx) {
    if (!isObject(obj)) {
      ctx.problems.push('A top-level entry is not a mapping, so it was skipped.');
      return null;
    }
    const importKey = ['import_playbook', 'ansible.builtin.import_playbook'].find(k => k in obj);
    if (importKey) {
      const kw = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== importKey));
      return track(ctx, obj, SX.newImport({ path: String(obj[importKey]), kw }));
    }
    ctx.counts.plays++;
    countJinja(ctx, obj.vars);
    const vars = [];
    for (const block of [].concat(obj.vars || [])) {
      if (isObject(block)) Object.entries(block).forEach(([key, value]) => vars.push(SX.newVar(key, value)));
    }
    const kw = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!['name', 'hosts', 'vars', 'roles', 'pre_tasks', 'tasks', 'post_tasks', 'handlers'].includes(key)) kw[key] = normalizeKeyword(key, value);
    }
    const play = SX.newPlay({
      name: obj.name ?? '', hosts: Array.isArray(obj.hosts) ? obj.hosts.join(',') : String(obj.hosts ?? ''),
      kw, vars, roles: (obj.roles || []).map(r => parseRoleRef(r, ctx)).filter(Boolean),
      pre_tasks: A.parseTaskList(obj.pre_tasks, ctx), tasks: A.parseTaskList(obj.tasks, ctx), post_tasks: A.parseTaskList(obj.post_tasks, ctx)
    });
    const before = ctx.counts.tasks;
    play.handlers = A.parseTaskList(obj.handlers, ctx);
    ctx.counts.handlers += ctx.counts.tasks - before;
    ctx.counts.tasks = before;
    play.ui.collapsed.vars = vars.length > 0;
    play.ui.show = { pre_tasks: play.pre_tasks.length > 0, post_tasks: play.post_tasks.length > 0 };
    return track(ctx, obj, play);
  };

  // A playbook file: { items, ranges (node id -> 1-based lines), problems, unknownModules, counts, jinja }.
  A.parsePlaybook = function parsePlaybook(text) {
    const { data, ranges } = A.loadWithRanges(text);
    const ctx = context(ranges);
    if (data === null || data === undefined) return { ...ctx, items: [] };
    if (!Array.isArray(data)) throw new Error('a playbook must be a list of plays');
    const items = data.map(entry => A.parsePlay(entry, ctx)).filter(Boolean);
    return { items, ranges: ctx.nodeRanges, problems: ctx.problems, unknownModules: ctx.unknownModules, counts: ctx.counts, jinja: ctx.jinja };
  };

  // Text that looks like a playbook: a list whose entries have hosts or import_playbook.
  A.looksLikePlaybook = data => Array.isArray(data) && data.length > 0 && data.every(entry => isObject(entry)
    && ('hosts' in entry || 'import_playbook' in entry || 'ansible.builtin.import_playbook' in entry));

  A.parseTasksText = function parseTasksText(text) {
    const { data, ranges } = A.loadWithRanges(text);
    const ctx = context(ranges);
    return { items: A.parseTaskList(data || [], ctx), ranges: ctx.nodeRanges, problems: ctx.problems, unknownModules: ctx.unknownModules };
  };

  // ---- Inventories --------------------------------------------------------------------

  function inventoryBuilder(path) {
    const inv = SX.newInventory(path);
    const group = name => {
      let g = inv.groups.find(x => x.name === name);
      if (!g) inv.groups.push(g = { id: SX.uid(), name, children: [], hosts: [], vars: [] });
      return g;
    };
    const host = name => {
      let h = inv.hosts.find(x => x.name === name);
      if (!h) inv.hosts.push(h = { id: SX.uid(), name, address: '', vars: [] });
      return h;
    };
    const setVar = (list, key, value) => {
      const existing = list.find(v => v.key === key);
      if (existing) existing.value = value;
      else list.push(SX.newVar(key, value));
    };
    return { inv, group, host, setVar };
  }

  A.parseIniInventory = function parseIniInventory(text, path) {
    const { inv, group, host, setVar } = inventoryBuilder(path);
    let section = { kind: 'hosts', group: null };
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s[#;].*$/, '').trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const header = line.match(/^\[([^\]:]+)(?::(vars|children))?\]$/);
      if (header) {
        section = { kind: header[2] || 'hosts', group: group(header[1]) };
        continue;
      }
      if (section.kind === 'children') {
        group(line);
        if (!section.group.children.includes(line)) section.group.children.push(line);
      } else if (section.kind === 'vars') {
        const [key, ...rest] = line.split('=');
        setVar(section.group.vars, key.trim(), A.typedScalar(rest.join('=').trim()));
      } else {
        const [name, ...pairs] = line.split(/\s+/);
        const h = host(name);
        for (const [key, value] of Object.entries(parseKeyValues(pairs.join(' ')))) {
          if (key === 'ansible_host') h.address = value;
          else setVar(h.vars, key, A.typedScalar(value));
        }
        if (section.group && !section.group.hosts.includes(name)) section.group.hosts.push(name);
      }
    }
    return inv;
  };

  A.parseYamlInventory = function parseYamlInventory(data, path) {
    const { inv, group, host, setVar } = inventoryBuilder(path);
    const visit = (name, body) => {
      const g = group(name);
      if (!isObject(body)) return;
      for (const [hostName, hostVars] of Object.entries(body.hosts || {})) {
        const h = host(hostName);
        if (name !== 'all' && !g.hosts.includes(hostName)) g.hosts.push(hostName);
        for (const [key, value] of Object.entries(hostVars || {})) {
          if (key === 'ansible_host') h.address = String(value);
          else setVar(h.vars, key, value);
        }
      }
      for (const [key, value] of Object.entries(body.vars || {})) setVar(g.vars, key, value);
      for (const [child, childBody] of Object.entries(body.children || {})) {
        if (name !== 'all' && !g.children.includes(child)) g.children.push(child);
        visit(child, childBody);
      }
    };
    for (const [name, body] of Object.entries(data || {})) visit(name, body);
    return inv;
  };

  A.looksLikeYamlInventory = data => isObject(data) && Object.values(data).every(v => isObject(v) && ('hosts' in v || 'children' in v || 'vars' in v));

  // INI keeps hosts and group structure; variables go to group_vars/ and host_vars/ files,
  // because INI [group:vars] values are always strings.
  A.inventoryIni = function inventoryIni(inv) {
    const lines = [];
    const groups = inv.groups.filter(g => g.name !== 'all');
    const grouped = new Set(groups.flatMap(g => g.hosts));
    const hostLine = name => {
      const h = inv.hosts.find(x => x.name === name);
      return h?.address ? `${name} ansible_host=${h.address}` : name;
    };
    const ungrouped = inv.hosts.filter(h => !grouped.has(h.name));
    if (ungrouped.length) lines.push(...ungrouped.map(h => hostLine(h.name)), '');
    for (const g of groups) {
      if (g.hosts.length) lines.push(`[${g.name}]`, ...g.hosts.map(hostLine), '');
    }
    for (const g of groups) {
      if (g.children.length) lines.push(`[${g.name}:children]`, ...g.children, '');
    }
    for (const g of groups) {
      if (!g.hosts.length && !g.children.length) lines.push(`[${g.name}]`, '');
    }
    return lines.join('\n').replace(/\n+$/, '\n');
  };

  // ---- Project export -----------------------------------------------------------------

  const dir = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';

  A.collectionsUsed = function collectionsUsed(project) {
    const used = new Set();
    const visit = list => SX.walk(list, node => {
      if (node.type !== 'task' || !node.module) return;
      const parts = node.module.split('.');
      if (parts.length === 3 && !['ansible.builtin', 'ansible.legacy'].includes(`${parts[0]}.${parts[1]}`)) used.add(`${parts[0]}.${parts[1]}`);
    });
    project.playbooks.forEach(pb => visit(pb.items));
    project.roles.forEach(role => { visit(role.tasks); visit(role.handlers); });
    return [...used].sort();
  };

  function yamlFile(object, opts, header = '---\n') {
    return A.dump(object, opts, header).text;
  }

  A.roleFiles = function roleFiles(role, opts, prefix) {
    const files = [];
    const base = `${prefix}${role.name}/`;
    files.push({ path: `${base}tasks/main.yml`, kind: 'role', content: yamlFile(A.taskList(role.tasks, opts), opts) });
    if (role.handlers.length) files.push({ path: `${base}handlers/main.yml`, kind: 'role', content: yamlFile(A.taskList(role.handlers, opts), opts) });
    if (role.defaults.length) files.push({ path: `${base}defaults/main.yml`, kind: 'vars', content: yamlFile(varsObject(role.defaults), opts) });
    const meta = { galaxy_info: { role_name: role.name, description: role.description || role.name }, dependencies: role.dependencies.map(name => ({ role: name })) };
    files.push({ path: `${base}meta/main.yml`, kind: 'config', content: yamlFile(meta, opts) });
    role.templates.forEach(t => files.push({ path: `${base}templates/${t.path}`, kind: 'template', content: t.content }));
    role.files.forEach(f => files.push({ path: `${base}files/${f.path}`, kind: 'template', content: f.content }));
    return files;
  };

  A.layoutJson = function layoutJson(project) {
    const playbooks = {};
    for (const pb of project.playbooks) {
      playbooks[pb.path] = pb.items.map((item, index) => ({ index, pos: item.pos || null, collapsed: item.ui?.collapsed || {}, show: item.ui?.show || {} }));
    }
    return JSON.stringify({ version: 1, generator: 'Scransible', playbooks }, null, 2) + '\n';
  };

  // Every file a project archive contains, in display order.
  A.projectFiles = function projectFiles(project, opts = project.settings) {
    const files = [];
    const note = opts.keepLayout ? ' · block layout in .scransible/layout.json' : '';
    for (const pb of project.playbooks) {
      files.push({ path: pb.path, kind: 'playbook', content: A.playbookYaml(pb, opts, `# Generated by Scransible${note}\n---\n`).text });
    }
    const inventory = SX.activeInventory(project);
    files.push({
      path: 'ansible.cfg', kind: 'config',
      content: `[defaults]\ninventory = ${inventory ? inventory.path : 'inventory'}\nroles_path = roles\n`
    });
    const collections = A.collectionsUsed(project);
    if (collections.length) {
      const versionOf = name => SX.moduleSets.find(s => s.collection === name)?.version;
      const reqs = { collections: collections.map(name => (versionOf(name) ? { name, version: `>=${versionOf(name)}` } : { name })) };
      files.push({ path: 'requirements.yml', kind: 'requirements', content: yamlFile(reqs, opts) });
    }
    const varsFiles = new Map();
    for (const inv of project.inventories) {
      files.push({ path: inv.path, kind: 'inventory', content: A.inventoryIni(inv) });
      for (const g of inv.groups) {
        if (!g.vars.length) continue;
        const path = `${dir(inv.path)}group_vars/${g.name}.yml`;
        if (!varsFiles.has(path)) varsFiles.set(path, { path, kind: 'vars', content: yamlFile(varsObject(g.vars), opts) });
      }
      for (const h of inv.hosts) {
        if (!h.vars.length) continue;
        const path = `${dir(inv.path)}host_vars/${h.name}.yml`;
        if (!varsFiles.has(path)) varsFiles.set(path, { path, kind: 'vars', content: yamlFile(varsObject(h.vars), opts) });
      }
    }
    files.push(...varsFiles.values());
    for (const role of project.roles) files.push(...A.roleFiles(role, opts, 'roles/'));
    if (opts.keepLayout) files.push({ path: '.scransible/layout.json', kind: 'layout', content: A.layoutJson(project) });
    return files;
  };

  // ---- Variables ------------------------------------------------------------------------

  const JINJA_WORDS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'true', 'false', 'none', 'True', 'False', 'None',
    'defined', 'undefined', 'loop', 'range', 'lookup', 'query', 'q', 'omit', 'item', 'ansible_loop', 'namespace', 'dict', 'lipsum']);
  A.MAGIC_VARS = new Set(['inventory_hostname', 'inventory_hostname_short', 'hostvars', 'groups', 'group_names', 'play_hosts',
    'ansible_play_hosts', 'ansible_play_batch', 'playbook_dir', 'role_path', 'role_name', 'inventory_dir', 'inventory_file',
    'ansible_check_mode', 'ansible_version', 'ansible_facts', 'ansible_failed_task', 'ansible_failed_result', 'item', 'omit',
    'environment', 'ansible_play_name', 'ansible_role_names', 'ansible_run_tags', 'ansible_limit', 'ansible_parent_role_names']);

  // Variable names a value reads, from {{ ... }} expressions (or a bare condition).
  A.variablesIn = function variablesIn(value, isCondition = false) {
    const found = new Set();
    const scan = expr => {
      const cleaned = expr.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ').replace(/\|\s*[A-Za-z_][\w.]*/g, ' ').replace(/\bis\s+(not\s+)?[A-Za-z_]\w*/g, ' ');
      for (const m of cleaned.matchAll(/(?<![\w.])([A-Za-z_][\w]*)/g)) {
        if (!JINJA_WORDS.has(m[1])) found.add(m[1]);
      }
    };
    const visit = v => {
      if (typeof v === 'string') {
        for (const m of v.matchAll(/\{\{(.*?)\}\}/gs)) scan(m[1]);
        if (isCondition && !v.includes('{{')) scan(v);
      } else if (Array.isArray(v)) v.forEach(visit);
      else if (isObject(v)) Object.values(v).forEach(visit);
    };
    visit(value);
    return [...found];
  };

  // Names a play can read: its vars, its roles' defaults, inventory vars, registered
  // results and set_fact names anywhere in it.
  A.variablesInScope = function variablesInScope(project, play) {
    const scope = new Map();
    const add = (name, source) => { if (name && !scope.has(name)) scope.set(name, source); };
    if (play) {
      play.vars.forEach(v => add(v.key, 'play vars'));
      Object.keys(play.kw.vars || {}).forEach(k => add(k, 'play vars'));
      for (const ref of play.roles) {
        Object.keys(ref.vars || {}).forEach(k => add(k, `role ${ref.role} vars`));
        project.roles.find(r => r.name === ref.role)?.defaults.forEach(v => add(v.key, `roles/${ref.role}/defaults`));
      }
      SX.walk(SX.SECTIONS.play.filter(s => s !== 'vars' && s !== 'roles').flatMap(s => play[s]), node => {
        if (node.kw?.register) add(String(node.kw.register), 'registered');
        if (node.type === 'task' && /\.set_fact$/.test(node.module)) Object.keys(node.args).forEach(k => k !== 'cacheable' && add(k, 'set_fact'));
        Object.keys(node.kw?.vars || {}).forEach(k => add(k, 'task vars'));
        if (node.kw?.loop_control?.loop_var) add(node.kw.loop_control.loop_var, 'loop');
      });
    }
    const inv = SX.activeInventory(project);
    inv?.groups.forEach(g => g.vars.forEach(v => add(v.key, `group_vars/${g.name}`)));
    inv?.hosts.forEach(h => h.vars.forEach(v => add(v.key, `host_vars/${h.name}`)));
    return scope;
  };
})();
