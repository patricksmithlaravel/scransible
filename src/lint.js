// Checks that ride on the blocks themselves (badges, outlines) and feed the export
// page. Errors block the download; warnings don't.
(function () {
  const SX = window.Scransible;
  const A = SX.Ansible;
  const CONDITION_KEYWORDS = ['when', 'changed_when', 'failed_when', 'until'];
  const COMMAND_MODULES = /^ansible\.builtin\.(command|shell|raw|script)$/;

  const label = node => `"${node.name || node.module?.split('.').pop() || 'Unnamed task'}"`;

  // Ansible rejects keywords that don't exist or don't belong on this kind of item.
  function keywordIssues(node, type, push) {
    for (const key of Object.keys(node.kw || {})) {
      if (SX.keywordAppliesTo(key, type)) continue;
      const known = SX.KEYWORDS[key];
      const where = { task: 'tasks', handler: 'handlers', block: 'blocks', play: 'plays', role: 'role blocks' }[type];
      push(node, 'unknown-keyword', 'warning', known
        ? `"${key}" doesn't apply to ${where} (it works on ${known.appliesTo.join(', ')}), so Ansible will reject it here.`
        : `"${key}" isn't an Ansible keyword, so Ansible will reject it. Is it a typo, or an argument that belongs to the module?`);
    }
  }

  function taskIssues(node, env, push) {
    keywordIssues(node, env.inHandlers?.has(node.id) ? 'handler' : 'task', push);
    if (!node.module) {
      push(node, 'no-module', 'error', `${label(node)} has no module.`);
      return;
    }
    const module = SX.module(node.module);
    if (!module) {
      push(node, 'unknown-module', 'warning', `${node.module} isn't in an installed module set, so it's shown as a generic block. Its parameters are kept exactly as written.`);
    } else {
      const missing = Object.entries(module.args)
        .filter(([name, spec]) => spec.required && ![name, ...(spec.aliases || [])].some(n => !A.isEmpty(node.args[n])))
        .map(([name]) => name);
      if (missing.length) {
        push(node, 'missing-required', 'error', `${label(node)} needs ${missing.join(', ')}.`, { missing });
      }
      if (!module.freeArgs) {
        for (const name of Object.keys(node.args)) {
          if (!SX.argSpec(module, name)) push(node, 'unknown-arg', 'warning', `${label(node)}: "${name}" is not an option of ${module.name}.`);
        }
      }
    }
    if (!node.name) push(node, 'name-missing', 'warning', `A ${node.module.split('.').pop()} task has no name, so its output is hard to follow.`);
    if (COMMAND_MODULES.test(node.module) && !('changed_when' in node.kw) && !node.args.creates && !node.args.removes) {
      push(node, 'no-changed-when', 'warning',
        `${label(node)} runs a command but never says when it changed something, so every run reports it as changed.`,
        { fix: { label: 'Add changed_when: false', apply: target => { target.kw.changed_when = 'false'; } } });
    }
    for (const handler of [].concat(node.kw.notify || [])) {
      if (handler && !String(handler).includes('{{') && !env.handlers.includes(String(handler))) {
        push(node, 'notify-handler', 'warning', `${label(node)} notifies "${handler}", but no handler ${env.handlerScope} has that name.`);
      }
    }
    checkVariables(node, [node.args, ...Object.entries(node.kw).filter(([k]) => !CONDITION_KEYWORDS.includes(k) && k !== 'register').map(([, v]) => v)],
      CONDITION_KEYWORDS.map(k => node.kw[k]).filter(Boolean), env, push);
  }

  function checkVariables(node, values, conditions, env, push) {
    const names = new Set([...A.variablesIn(values), ...A.variablesIn(conditions, true)]);
    const undefinedNames = [...names].filter(name => !env.scope.has(name) && !A.MAGIC_VARS.has(name) && !name.startsWith('ansible_'));
    if (undefinedNames.length) {
      push(node, 'undefined-var', 'warning', `${label(node)} uses ${undefinedNames.join(', ')}, which ${undefinedNames.length > 1 ? "aren't" : "isn't"} defined anywhere in this project.`, { names: undefinedNames });
    }
  }

  function walkTasks(list, env, push) {
    SX.walk(list, node => {
      if (node.type === 'task') taskIssues(node, env, push);
      if (node.type === 'block') {
        keywordIssues(node, 'block', push);
        if (!node.block.length && !node.rescue.length && !node.always.length) push(node, 'empty-block', 'warning', `Block "${node.name || 'unnamed'}" is empty.`);
        checkVariables(node, Object.entries(node.kw).filter(([k]) => k !== 'when').map(([, v]) => v), node.kw.when ? [node.kw.when] : [], env, push);
      }
    });
  }

  SX.Lint = {
    run(project) {
      const issues = [];
      const byNode = new Map();
      let where = '';
      const push = (node, rule, severity, message, extra = {}) => {
        const issue = { nodeId: node?.id || null, rule, severity, message, where, ...extra };
        issues.push(issue);
        if (node) {
          if (!byNode.has(node.id)) byNode.set(node.id, []);
          byNode.get(node.id).push(issue);
        }
      };
      for (const pb of project.playbooks) {
        where = pb.path;
        const yaml = A.playbookYaml(pb, project.settings);
        if (yaml.problem) push(null, 'yaml', 'error', yaml.problem);
        for (const item of pb.items) {
          if (item.type !== 'play') continue;
          if (!String(item.hosts ?? '').trim()) push(item, 'no-hosts', 'error', `Play "${item.name || 'unnamed'}" has no hosts.`);
          keywordIssues(item, 'play', push);
          if (!item.tasks.length && !item.roles.length && !item.pre_tasks.length && !item.post_tasks.length) {
            push(item, 'empty-play', 'warning', `Play "${item.name || 'unnamed'}" has no tasks or roles.`);
          }
          for (const ref of item.roles) {
            keywordIssues(ref, 'role', push);
            if (!ref.role) push(ref, 'role-missing', 'error', 'A role block has no role name.');
            else if (!project.roles.some(r => r.name === ref.role)) {
              push(ref, 'unknown-role', 'warning', `Role "${ref.role}" isn't in this project, so it has to come from Galaxy or roles_path.`);
            }
          }
          const inHandlers = new Set();
          SX.walk(item.handlers, n => inHandlers.add(n.id));
          const env = { scope: A.variablesInScope(project, item), handlers: SX.handlerNames(item), handlerScope: 'in this play', inHandlers };
          checkVariables(item, [item.vars.map(v => v.value), item.roles.map(r => r.vars)], [], env, push);
          walkTasks(SX.SECTIONS.play.filter(s => s !== 'vars' && s !== 'roles').flatMap(s => item[s]), env, push);
        }
      }
      for (const role of project.roles) {
        where = `roles/${role.name}`;
        const scope = A.variablesInScope(project, null);
        role.defaults.forEach(v => scope.set(v.key, 'role defaults'));
        SX.walk([...role.tasks, ...role.handlers], node => {
          if (node.kw?.register) scope.set(String(node.kw.register), 'registered');
          if (node.type === 'task' && /\.set_fact$/.test(node.module)) Object.keys(node.args).forEach(k => scope.set(k, 'set_fact'));
        });
        const handlers = SX.handlerNames({ handlers: role.handlers });
        const inHandlers = new Set();
        SX.walk(role.handlers, n => inHandlers.add(n.id));
        walkTasks([...role.tasks, ...role.handlers], { scope, handlers, handlerScope: `in role ${role.name}`, inHandlers }, push);
      }
      const counts = { errors: issues.filter(i => i.severity === 'error').length, warnings: issues.filter(i => i.severity === 'warning').length };
      return { issues, byNode, counts };
    }
  };

})();
