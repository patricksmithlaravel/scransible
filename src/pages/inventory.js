// Inventory: groups and hosts as cards you can drag hosts between, group and host
// variables, and a walk through Ansible's variable precedence for one host.
(function () {
  const SX = window.Scransible;
  const { el, icon, ui, Blocks: B } = SX;
  const store = SX.store;
  const BLUE = '#5FA8FF';
  const state = { selected: { kind: 'group', name: null }, variable: null, host: null };
  let root;

  const project = () => store.project;
  const inventory = () => SX.activeInventory(project());

  function editInventory(change, typingKey) {
    const id = inventory().id;
    const apply = p => { const inv = p.inventories.find(i => i.id === id); if (inv) change(inv, p); };
    if (typingKey) store.typing(typingKey, apply, 'inventory');
    else store.commit(apply, { source: 'inventory' });
  }

  // ---- Group structure -------------------------------------------------------------------

  const realGroups = inv => inv.groups.filter(g => g.name !== 'all');
  const groupByName = (inv, name) => inv.groups.find(g => g.name === name);
  const parentsOf = (inv, name) => realGroups(inv).filter(g => g.children.includes(name));
  const topGroups = inv => realGroups(inv).filter(g => !parentsOf(inv, g.name).length);
  const groupsOfHost = (inv, host) => realGroups(inv).filter(g => g.hosts.includes(host));
  const ungrouped = inv => inv.hosts.filter(h => !groupsOfHost(inv, h.name).length);

  function hostsUnder(inv, name, seen = new Set()) {
    if (seen.has(name)) return new Set();
    seen.add(name);
    const g = groupByName(inv, name);
    const hosts = new Set(g?.hosts || []);
    for (const child of g?.children || []) hostsUnder(inv, child, seen).forEach(h => hosts.add(h));
    return hosts;
  }

  function depth(inv, name, seen = new Set()) {
    if (seen.has(name)) return 0;
    seen.add(name);
    const parents = parentsOf(inv, name);
    return parents.length ? 1 + Math.max(...parents.map(p => depth(inv, p.name, seen))) : 0;
  }

  // Plays whose host pattern names this group (or all).
  function playsTargeting(names) {
    const found = [];
    for (const pb of project().playbooks) {
      for (const item of pb.items) {
        if (item.type !== 'play') continue;
        const tokens = String(item.hosts || '').split(/[,:&!\s]+/).filter(Boolean);
        if (tokens.some(t => t === 'all' || names.includes(t))) found.push({ play: item, playbook: pb });
      }
    }
    return found;
  }

  function hostGroupsWithAncestors(inv, host) {
    const result = new Set();
    const visit = name => {
      if (result.has(name)) return;
      result.add(name);
      parentsOf(inv, name).forEach(p => visit(p.name));
    };
    groupsOfHost(inv, host).forEach(g => visit(g.name));
    return [...result];
  }

  function openPlay(play, playbook) {
    store.commit(p => SX.openPlaybook(p, playbook.id), { checkpoint: false });
    location.hash = '#/builder';
    setTimeout(() => SX.revealNode?.(play.id), 0);
  }

  // ---- Drag hosts between groups ------------------------------------------------------------

  const dndHandler = {
    resolve(hits, payload, pt) {
      if (payload.type !== 'host') return null;
      const card = hits.map(h => h.closest?.('[data-group]')).find(Boolean);
      if (card) return { kind: 'group', group: card.dataset.group, copy: pt.altKey, highlight: card.querySelector(':scope > .host-list > .host-drop') || card };
      const lane = hits.map(h => h.closest?.('.lane')).find(Boolean);
      if (lane) return { kind: 'ungrouped', highlight: lane };
      return null;
    },
    drop(payload, target) {
      const { host, from } = payload;
      editInventory(inv => {
        if (target.kind === 'ungrouped') {
          for (const g of inv.groups) g.hosts = g.hosts.filter(h => h !== host);
          return;
        }
        const to = groupByName(inv, target.group);
        if (!to || to.name === from) return;
        if (!to.hosts.includes(host)) to.hosts.push(host);
        if (from && !target.copy) {
          const source = groupByName(inv, from);
          if (source) source.hosts = source.hosts.filter(h => h !== host);
        }
      });
      ui.toast(target.kind === 'ungrouped' ? `${host} is now ungrouped.` : `${host} ${target.copy ? 'is also' : 'moved'} in ${target.group}.`, { action: { label: 'Undo', onClick: () => store.undo() } });
    }
  };

  // ---- Left -----------------------------------------------------------------------------

  async function newInventory() {
    const path = await ui.prompt('New inventory', {
      label: 'File path', value: 'inventory/staging.ini',
      validate: v => !/^[\w./-]+\.ini$/.test(v) ? 'Use a relative path ending in .ini.' : project().inventories.some(i => i.path === v) ? 'That inventory already exists.' : null
    });
    if (!path) return;
    store.commit(p => { const inv = SX.newInventory(path); p.inventories.push(inv); p.activeInventoryId = inv.id; }, { source: 'inventory' });
  }

  function inventoryMenu(inv, anchor) {
    ui.menu(anchor, [
      { label: 'Rename…', onClick: async () => {
        const path = await ui.prompt('Rename inventory', { label: 'File path', value: inv.path, validate: v => /^[\w./-]+\.ini$/.test(v) ? null : 'Use a relative path ending in .ini.' });
        if (path) store.commit(p => { p.inventories.find(i => i.id === inv.id).path = path; }, { source: 'inventory' });
      } },
      { label: 'Delete', danger: true, disabled: project().inventories.length < 2, onClick: async () => {
        if (!await ui.confirm(`Delete ${inv.path}?`, 'Its hosts, groups and variables are removed. Undo brings them back.', { confirmLabel: 'Delete', danger: true })) return;
        store.commit(p => { p.inventories = p.inventories.filter(i => i.id !== inv.id); p.activeInventoryId = p.inventories[0].id; }, { source: 'inventory' });
      } }
    ], { align: 'right' });
  }

  function treeButton(name, count, level, { current, ringClass = '', onClick, ungroupedRow } = {}) {
    return el('button', {
      class: 'tree-btn', type: 'button', style: `padding-left: ${10 + level * 16}px`, attrs: { 'aria-current': String(!!current) }, onclick: onClick
    }, [el('span', { class: `ring ${ringClass}` }), el('span', { text: name, style: ungroupedRow ? 'color: var(--text-muted)' : '' }), el('span', { class: 'count', text: String(count) })]);
  }

  function renderLeft() {
    const inv = inventory();
    const tree = [];
    const sel = state.selected;
    tree.push(treeButton('all', inv.hosts.length, 0, { current: sel.kind === 'group' && sel.name === 'all', onClick: () => select('group', 'all') }));
    const visit = (g, level, seen) => {
      if (seen.has(g.name)) return;
      seen.add(g.name);
      tree.push(treeButton(g.name, hostsUnder(inv, g.name).size, level, { current: sel.kind === 'group' && sel.name === g.name, ringClass: 'blue', onClick: () => select('group', g.name) }));
      g.children.map(c => groupByName(inv, c)).filter(Boolean).forEach(c => visit(c, level + 1, new Set(seen)));
    };
    topGroups(inv).forEach(g => visit(g, 1, new Set()));
    tree.push(treeButton('ungrouped', ungrouped(inv).length, 1, { current: sel.kind === 'group' && sel.name === 'ungrouped', onClick: () => select('group', 'ungrouped'), ungroupedRow: true }));
    return el('aside', { class: 'side' }, [
      el('div', { class: 'side-title-row' }, [
        el('h1', { class: 'side-title', text: 'Inventory' }),
        el('button', { class: 'btn btn-sm', type: 'button', title: 'New inventory', attrs: { 'aria-label': 'New inventory' }, onclick: newInventory }, icon('plus', 16))
      ]),
      el('div', { class: 'list', style: 'padding: 0 10px' }, project().inventories.map(i => el('div', { class: `list-row${i.id === inv.id ? ' selected' : ''}`, style: 'cursor: pointer', onclick: e => { if (!e.target.closest('button')) store.commit(p => { p.activeInventoryId = i.id; }, { checkpoint: false, source: 'inventory' }); } }, [
        el('span', { style: `color: ${i.id === inv.id ? BLUE : 'var(--text-muted)'}; display: flex` }, icon('server', 18)),
        el('span', { class: 'row-main' }, [el('span', { class: 'row-title', text: i.path.split('/').pop() }), el('span', { class: 'row-sub', text: `${SX.plural(i.hosts.length, 'host')} · ${SX.plural(realGroups(i).length, 'group')}` })]),
        i.id === inv.id ? el('button', { class: 'icon-btn sm', type: 'button', title: 'Inventory actions', attrs: { 'aria-label': 'Inventory actions' }, onclick: e => inventoryMenu(i, e.currentTarget) }, icon('more', 15)) : null
      ]))),
      el('div', { class: 'section-label', style: 'padding: 18px 20px 6px', text: 'Groups' }),
      el('div', { class: 'group-tree', style: 'padding: 0 10px' }, tree),
      el('p', { class: 'field-hint', style: 'padding: 16px 20px', text: 'Static INI inventories. On export, group and host variables go to group_vars/ and host_vars/ next to the inventory file.' })
    ]);
  }

  // ---- Center ------------------------------------------------------------------------------

  function hostRow(inv, host, fromGroup) {
    const h = inv.hosts.find(x => x.name === host);
    const row = el('div', {
      class: `host-row${state.selected.kind === 'host' && state.selected.name === host ? ' selected' : ''}`, title: 'Drag to another group (hold ⌥/Alt to keep it here too)',
      onclick: e => { e.stopPropagation(); select('host', host); }
    }, [icon('server', 16), el('span', { text: host }), el('span', { class: 'addr', text: h?.address || '' })]);
    SX.DnD.attach(row, () => ({ kind: 'move', type: 'host', host, from: fromGroup }));
    return row;
  }

  function groupCard(inv, g, seen = new Set()) {
    if (seen.has(g.name)) return null;
    seen.add(g.name);
    const selected = state.selected.kind === 'group' && state.selected.name === g.name;
    const targeting = playsTargeting(hostGroupsWithAncestorsFor(inv, g.name));
    const varsBadge = el('span', { class: 'pill', style: g.vars.length ? 'background: var(--warn-bg); color: var(--required)' : '', text: g.vars.length ? SX.plural(g.vars.length, 'var') : '0 vars' });
    if (g.children.length) {
      return el('div', { class: `group-card parent${selected ? ' selected' : ''}`, data: { group: g.name }, onclick: e => { e.stopPropagation(); select('group', g.name); } }, [
        el('div', { class: 'group-card-head' }, [
          el('span', { class: 'group-tag', text: 'PARENT' }),
          el('span', { class: 'gname', text: g.name }),
          el('span', { class: 'gsub', text: `children: ${g.children.join(', ')}` }),
          el('span', { class: 'grow' }),
          el('span', { class: 'gsub', text: g.vars.length ? SX.plural(g.vars.length, 'group var') : 'no group vars' })
        ]),
        el('div', { class: 'group-children' }, [
          ...g.children.map(c => groupByName(inv, c)).filter(Boolean).map(c => groupCard(inv, c, new Set(seen))),
          g.hosts.length ? el('div', { class: 'host-list', style: 'min-width: 240px; padding: 0' }, g.hosts.map(h => hostRow(inv, h, g.name))) : null
        ])
      ]);
    }
    return el('div', { class: `group-card${selected ? ' selected' : ''}`, data: { group: g.name }, onclick: e => { e.stopPropagation(); select('group', g.name); } }, [
      el('div', { class: 'group-card-head' }, [
        el('span', { class: 'color-square', style: `--c: ${BLUE}` }),
        el('span', { class: 'gname', text: g.name }),
        el('span', { class: 'grow' }),
        varsBadge
      ]),
      el('div', { class: 'host-list' }, [...g.hosts.map(h => hostRow(inv, h, g.name)), el('div', { class: 'host-drop', text: 'Drop a host here' })]),
      el('div', { class: 'group-foot' }, targeting.length
        ? ['Targeted by ', ...targeting.flatMap(({ play, playbook }, i) => [i ? ', ' : '', el('a', { href: '#/builder', text: play.name || 'a play', onclick: e => { e.preventDefault(); e.stopPropagation(); openPlay(play, playbook); } })])]
        : ['Not targeted by any play yet'])
    ]);
  }

  function hostGroupsWithAncestorsFor(inv, groupName) {
    const names = new Set([groupName]);
    const visit = name => parentsOf(inv, name).forEach(p => { if (!names.has(p.name)) { names.add(p.name); visit(p.name); } });
    visit(groupName);
    return [...names];
  }

  async function addGroup() {
    const inv = inventory();
    const name = await ui.prompt('New group', { label: 'Group name', placeholder: 'appservers', validate: v => !/^[A-Za-z_][\w-]*$/.test(v) ? 'Use letters, numbers, dashes and underscores.' : groupByName(inv, v) ? 'That group already exists.' : null });
    if (!name) return;
    const parent = state.selected.kind === 'group' && groupByName(inv, state.selected.name) && state.selected.name !== 'all' ? state.selected.name : null;
    editInventory(i => {
      i.groups.push({ id: SX.uid(), name, children: [], hosts: [], vars: [] });
      if (parent) groupByName(i, parent).children.push(name);
    });
    select('group', name);
  }

  async function addHost() {
    const inv = inventory();
    const name = el('input', { class: 'input', placeholder: 'web-03' });
    const address = el('input', { class: 'input', placeholder: '10.0.1.13' });
    const groupOptions = [['', 'No group (ungrouped)'], ...realGroups(inv).filter(g => !g.children.length).map(g => [g.name, g.name])];
    const preferred = state.selected.kind === 'group' && groupOptions.some(([v]) => v === state.selected.name) ? state.selected.name : '';
    const group = ui.select(groupOptions, preferred, () => {}, { cls: 'select tall' });
    const error = el('div', { class: 'field-hint', style: 'color: var(--danger-text)' });
    const body = [ui.field('Host name', name), ui.field('Address (ansible_host)', address, { hint: 'Optional — leave empty if the name resolves.' }), ui.field('Group', group), error];
    while (true) {
      const ok = await ui.dialog({ title: 'New host', body, actions: [{ label: 'Cancel', value: false }, { label: 'Add host', primary: true, value: true }], onOpen: () => name.focus() });
      if (!ok) return;
      const n = name.value.trim();
      if (!/^[\w.-]+$/.test(n)) { error.textContent = 'Use a host name or IP address.'; continue; }
      if (inv.hosts.some(h => h.name === n)) { error.textContent = 'That host already exists.'; continue; }
      editInventory(i => {
        i.hosts.push({ id: SX.uid(), name: n, address: address.value.trim(), vars: [] });
        if (group.value) groupByName(i, group.value).hosts.push(n);
      });
      select('host', n);
      return;
    }
  }

  function renderCenter() {
    const inv = inventory();
    const loose = ungrouped(inv);
    return el('main', { style: 'display: flex; flex-direction: column; min-height: 0; min-width: 0' }, [
      el('div', { class: 'pane-head', style: 'height: 56px' }, [
        el('span', { class: 'pane-title', style: 'font-size: 15px', text: 'Groups & hosts' }),
        el('span', { class: 'field-hint hide-sm', text: 'Drag a host between groups — hold ⌥/Alt to keep it in both.' }),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-md', type: 'button', onclick: addGroup }, [icon('plus', 15), 'Group']),
        el('button', { class: 'btn btn-md btn-blue', type: 'button', onclick: addHost }, [icon('plus', 15), 'Host'])
      ]),
      el('div', { class: 'well-canvas', style: 'flex: 1; overflow: auto', onclick: () => select('group', 'all') }, el('div', { class: 'inv-canvas' }, [
        ...topGroups(inv).map(g => groupCard(inv, g)),
        realGroups(inv).length ? null : el('p', { class: 'empty-note', text: 'No groups yet. Add a group, then add hosts to it.' }),
        el('div', { class: 'lane' }, [
          el('div', { class: 'lane-head' }, [el('strong', { text: 'ungrouped' }), el('span', { text: 'Hosts in no group land here. They still belong to all.' })]),
          loose.length ? el('div', { class: 'host-list', style: 'padding: 0; flex-direction: row; flex-wrap: wrap' }, loose.map(h => hostRow(inv, h.name, null))) : null
        ])
      ]))
    ]);
  }

  // ---- Right ---------------------------------------------------------------------------------

  // Ansible's common variable layers for one host, lowest precedence first.
  function layers(inv, host, variable) {
    const out = [];
    const memberGroups = hostGroupsWithAncestors(inv, host).sort((a, b) => depth(inv, a) - depth(inv, b) || a.localeCompare(b));
    const plays = playsTargeting(hostGroupsWithAncestors(inv, host).concat(host));
    const roleNames = [...new Set(plays.flatMap(({ play }) => play.roles.map(r => r.role)))];
    const roleDefault = roleNames.map(name => project().roles.find(r => r.name === name)).filter(Boolean).find(r => r.defaults.some(d => d.key === variable));
    out.push({ name: 'Role default', source: roleDefault ? `roles/${roleDefault.name}/defaults/main.yml` : 'roles/*/defaults/main.yml', value: roleDefault?.defaults.find(d => d.key === variable)?.value });
    out.push({ name: 'Group vars · all', source: 'group_vars/all.yml', value: groupByName(inv, 'all')?.vars.find(v => v.key === variable)?.value });
    for (const name of memberGroups) {
      const g = groupByName(inv, name);
      const isParent = !g.hosts.includes(host);
      out.push({ name: `Group vars · ${name}`, source: isParent ? 'parent group' : `group_vars/${name}.yml`, value: g.vars.find(v => v.key === variable)?.value });
    }
    out.push({ name: `Host vars · ${host}`, source: `host_vars/${host}.yml`, value: inv.hosts.find(h => h.name === host)?.vars.find(v => v.key === variable)?.value });
    for (const { play, playbook } of plays) {
      const v = play.vars.find(x => x.key === variable);
      out.push({ name: 'Play vars', source: `${playbook.path} › ${play.name || 'unnamed play'}`, value: v?.value });
    }
    out.push({ name: 'Extra vars', source: 'ansible-playbook -e', value: undefined });
    const winner = out.map(l => l.value !== undefined).lastIndexOf(true);
    return { layers: out, winner };
  }

  function variableNames(inv, host) {
    const names = new Set();
    inv.groups.forEach(g => g.vars.forEach(v => v.key && names.add(v.key)));
    inv.hosts.forEach(h => h.vars.forEach(v => v.key && names.add(v.key)));
    const plays = playsTargeting(hostGroupsWithAncestors(inv, host).concat(host));
    plays.forEach(({ play }) => {
      play.vars.forEach(v => v.key && names.add(v.key));
      play.roles.forEach(r => project().roles.find(x => x.name === r.role)?.defaults.forEach(d => names.add(d.key)));
    });
    return [...names].sort();
  }

  function precedence(inv, hostCandidates, preferred) {
    if (!hostCandidates.length) return null;
    const host = hostCandidates.includes(state.host) ? state.host : hostCandidates[0];
    const names = variableNames(inv, host);
    if (!names.length) return el('div', { class: 'panel-section' }, [el('h2', { class: 'panel-title', text: 'Where does a value come from?' }), el('p', { class: 'empty-note', text: 'Add a variable to see which layer sets it for each host.' })]);
    const variable = names.includes(state.variable) ? state.variable : names.includes(preferred) ? preferred : names[0];
    const { layers: list, winner } = layers(inv, host, variable);
    return el('div', { class: 'panel-section' }, [
      el('h2', { class: 'panel-title', text: 'Where does a value come from?' }),
      el('p', { class: 'empty-note', text: 'Lowest precedence at the top. The highest layer that sets it wins.' }),
      el('div', { style: 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px' }, [
        ui.field('Variable', ui.select(names.map(n => [n, n]), variable, v => { state.variable = v; render(); }, { cls: 'select tall mono' })),
        ui.field('For host', ui.select(hostCandidates.map(h => [h, h]), host, v => { state.host = v; render(); }, { cls: 'select tall mono' }))
      ]),
      el('div', { class: 'layers' }, list.map((l, i) => el('div', { class: `layer${l.value !== undefined ? ' set' : ''}${i === winner ? ' win' : ''}` }, [
        el('span', { class: 'ldot' }),
        el('div', {}, [el('div', { class: 'lname', text: l.name }), el('div', { class: 'lsrc', text: l.source })]),
        el('span', { class: 'lval', text: l.value === undefined ? '—' : B.summary(l.value) })
      ]))),
      el('div', { class: 'resolved' }, [el('span', {}, [`${host} gets `, el('strong', { class: 'mono', text: variable }), ' =']), el('span', { class: 'v', text: winner >= 0 ? B.summary(list[winner].value) : 'undefined' })])
    ]);
  }

  function varsEditor(list, keyPrefix, mutateList) {
    return ui.varRows(list, {
      keyPrefix,
      onEdit: (id, change, key) => editInventory(inv => Object.assign(mutateList(inv).find(v => v.id === id), change), key),
      onRemove: id => editInventory(inv => { const l = mutateList(inv); l.splice(l.findIndex(v => v.id === id), 1); }),
      onAdd: () => editInventory(inv => { mutateList(inv).push(SX.newVar('', '')); })
    });
  }

  function groupPanel(inv, name) {
    if (name === 'ungrouped') {
      return [el('div', { class: 'panel-section' }, [el('h2', { class: 'insp-title mono', text: 'ungrouped' }), el('p', { class: 'empty-note', text: `${SX.plural(ungrouped(inv).length, 'host')} in no group. They still belong to all.` })]), precedence(inv, ungrouped(inv).map(h => h.name))];
    }
    const g = groupByName(inv, name) || groupByName(inv, 'all');
    const dir = inv.path.includes('/') ? inv.path.slice(0, inv.path.lastIndexOf('/') + 1) : '';
    const parents = parentsOf(inv, g.name).map(p => p.name);
    const hosts = [...(g.name === 'all' ? new Set(inv.hosts.map(h => h.name)) : hostsUnder(inv, g.name))];
    const otherGroups = realGroups(inv).filter(x => x.name !== g.name && !g.children.includes(x.name) && !parents.includes(x.name));
    return [
      el('div', { class: 'panel-section' }, [
        el('div', { style: 'display: flex; align-items: center; gap: 10px' }, [el('span', { class: 'color-square', style: `--c: ${BLUE}` }), el('h2', { class: 'insp-title mono', style: 'font: 700 20px/1.1 var(--font-mono)', text: g.name })]),
        el('p', { class: 'empty-note' }, [
          SX.plural(hosts.length, 'host'),
          parents.length ? [' · child of ', el('span', { class: 'mono', text: parents.join(', ') })] : null,
          ' · vars in ', el('span', { class: 'mono', text: `${dir}group_vars/${g.name}.yml` })
        ])
      ]),
      el('div', { class: 'panel-section' }, [el('h2', { class: 'panel-title', text: 'Group variables' }), varsEditor(g.vars, g.id, i => groupByName(i, g.name).vars)]),
      g.name === 'all' ? null : el('div', { class: 'panel-section' }, [
        el('h2', { class: 'panel-title', text: 'Child groups' }),
        el('div', { class: 'chip-row' }, [
          ...g.children.map(c => el('span', { class: 'chip removable' }, [c, el('button', { type: 'button', attrs: { 'aria-label': `Remove child ${c}` }, onclick: () => editInventory(i => { const t = groupByName(i, g.name); t.children = t.children.filter(x => x !== c); }) }, icon('x', 10))])),
          otherGroups.length ? ui.select([['', '+ Add child group'], ...otherGroups.map(x => [x.name, x.name])], '', v => v && editInventory(i => { groupByName(i, g.name).children.push(v); }), { cls: 'select' }) : null
        ]),
        el('div', { style: 'display: flex; gap: 8px; margin-top: 4px' }, [
          el('button', { class: 'btn btn-md', type: 'button', text: 'Rename…', onclick: () => renameGroup(g.name) }),
          el('button', { class: 'btn btn-md btn-warn', type: 'button', text: 'Delete group', onclick: () => deleteGroup(g.name) })
        ])
      ]),
      precedence(inv, hosts, g.vars[0]?.key)
    ];
  }

  async function renameGroup(oldName) {
    const inv = inventory();
    const name = await ui.prompt('Rename group', { label: 'Group name', value: oldName, validate: v => !/^[A-Za-z_][\w-]*$/.test(v) ? 'Use letters, numbers, dashes and underscores.' : v !== oldName && groupByName(inv, v) ? 'That group already exists.' : null });
    if (!name || name === oldName) return;
    editInventory((i, p) => {
      groupByName(i, oldName).name = name;
      i.groups.forEach(g => { g.children = g.children.map(c => (c === oldName ? name : c)); });
      for (const pb of p.playbooks) {
        for (const item of pb.items) {
          if (item.type === 'play') item.hosts = String(item.hosts).split(/([,:&!\s]+)/).map(t => (t === oldName ? name : t)).join('');
        }
      }
    });
    select('group', name);
  }

  async function deleteGroup(name) {
    if (!await ui.confirm(`Delete group ${name}?`, 'Its hosts stay in the inventory (ungrouped if they were only in this group). Undo brings the group back.', { confirmLabel: 'Delete', danger: true })) return;
    editInventory(i => {
      i.groups = i.groups.filter(g => g.name !== name);
      i.groups.forEach(g => { g.children = g.children.filter(c => c !== name); });
    });
    select('group', 'all');
  }

  function hostPanel(inv, name) {
    const h = inv.hosts.find(x => x.name === name);
    if (!h) return groupPanel(inv, 'all');
    const member = groupsOfHost(inv, name).map(g => g.name);
    const others = realGroups(inv).filter(g => !member.includes(g.name) && !g.children.length);
    return [
      el('div', { class: 'panel-section' }, [
        el('div', { style: 'display: flex; align-items: center; gap: 10px; color: var(--link)' }, [icon('server', 18), el('h2', { class: 'insp-title mono', style: 'font: 700 20px/1.1 var(--font-mono); color: var(--text)', text: h.name })]),
        el('p', { class: 'empty-note', text: member.length ? `In ${member.join(', ')}` : 'Ungrouped — still part of all.' })
      ]),
      el('div', { class: 'panel-section' }, [
        ui.field('Address (ansible_host)', el('input', { class: 'input', value: h.address, placeholder: 'resolve the host name', oninput: e => editInventory(i => { i.hosts.find(x => x.name === name).address = e.target.value.trim(); }, `${h.id}:address`) })),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label', text: 'Groups' }),
          el('div', { class: 'chip-row' }, [
            ...member.map(g => el('span', { class: 'chip removable' }, [g, el('button', { type: 'button', attrs: { 'aria-label': `Remove from ${g}` }, onclick: () => editInventory(i => { const t = groupByName(i, g); t.hosts = t.hosts.filter(x => x !== name); }) }, icon('x', 10))])),
            others.length ? ui.select([['', '+ Add to group'], ...others.map(g => [g.name, g.name])], '', v => v && editInventory(i => { groupByName(i, v).hosts.push(name); }), { cls: 'select' }) : null
          ])
        ]),
        el('button', { class: 'btn btn-md btn-warn', type: 'button', style: 'align-self: flex-start', text: 'Delete host', onclick: async () => {
          if (!await ui.confirm(`Delete host ${name}?`, 'It is removed from every group. Undo brings it back.', { confirmLabel: 'Delete', danger: true })) return;
          editInventory(i => { i.hosts = i.hosts.filter(x => x.name !== name); i.groups.forEach(g => { g.hosts = g.hosts.filter(x => x !== name); }); });
          select('group', 'all');
        } })
      ]),
      el('div', { class: 'panel-section' }, [el('h2', { class: 'panel-title', text: 'Host variables' }), varsEditor(h.vars, h.id, i => i.hosts.find(x => x.name === name).vars)]),
      precedence(inv, [name], h.vars[0]?.key)
    ];
  }

  function renderRight() {
    const inv = inventory();
    const sel = state.selected;
    const content = sel.kind === 'host' ? hostPanel(inv, sel.name) : groupPanel(inv, sel.name || 'all');
    return el('aside', { class: 'panel', style: 'border-left: 1px solid var(--border)' }, content.filter(Boolean));
  }

  function select(kind, name) {
    if (state.selected.kind !== kind || state.selected.name !== name) state.variable = null;
    state.selected = { kind, name };
    if (kind === 'host') state.host = name;
    render();
  }

  function render() {
    const inv = inventory();
    if (state.selected.kind === 'group' && state.selected.name && !['all', 'ungrouped'].includes(state.selected.name) && !groupByName(inv, state.selected.name)) state.selected = { kind: 'group', name: 'all' };
    if (!state.selected.name) {
      const first = topGroups(inv).find(g => !g.children.length) || topGroups(inv)[0];
      state.selected = { kind: 'group', name: first ? (first.children.length ? first.children[0] : first.name) : 'all' };
    }
    const scroll = root.querySelector('.well-canvas')?.scrollTop;
    root.replaceChildren(renderLeft(), renderCenter(), renderRight());
    if (scroll) root.querySelector('.well-canvas').scrollTop = scroll;
  }

  SX.pages = SX.pages || {};
  SX.pages.inventory = {
    mount(container) {
      SX.DnD.handler = dndHandler;
      root = el('div', { class: 'cols', style: 'grid-template-columns: 280px minmax(0, 1fr) 400px; min-height: 0' });
      container.replaceChildren(root);
      render();
    },
    unmount() { SX.DnD.handler = null; },
    update(event) {
      if (event?.typing && event.source === 'inventory') return;
      render();
    }
  };
})();
