# Scransible

A drag-and-drop builder for Ansible playbooks, aimed at network automation with
Cisco IOS and NX-OS. It's a single HTML file: open it in a browser, build plays,
tasks and blocks visually, and copy or download the generated YAML.

## Using it

Open `index.html` in a browser. It loads [js-yaml](https://github.com/nodeca/js-yaml)
from cdnjs, so it needs a network connection; offline, it says so instead of
producing YAML.

- **Add things** by dragging them from the library onto the canvas, or by clicking
  them. A click adds to the area you last clicked on the canvas (it's outlined).
- **Plays** go at the top level. The Cisco IOS and NX-OS plays come with
  `connection: ansible.netcommon.network_cli` and `ansible_network_os` set.
- **Tasks and blocks** go inside plays and blocks. Blocks have Rescue and Always
  sections, and plays have a Handlers section for tasks you `notify`.
- **Move** an item by dragging its header, or with the ↑ ↓ buttons. ⧉ duplicates it.
- **Undo and redo** with the buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (outside text
  fields, which keep their own undo).
- **Module arguments** use the right input for their type: one item per line for
  lists such as `lines` and `commands`, a dropdown for booleans and choices, and
  YAML for nested data such as the `ios_interfaces` `config`. "+ Add module
  argument…" lists every documented option.

The warnings panel flags missing required arguments, unknown arguments, `notify`
targets with no matching handler, empty plays and blocks, and similar mistakes.

Your work is saved in the browser automatically. Save Snapshot keeps a separate
copy to return to with Load Snapshot. Export JSON and Import JSON (or dropping a
JSON file on the page) move work between browsers.

## How field values become YAML

Fields are plain text. When the YAML is generated:

| You type | You get |
|---|---|
| `yes`, `no`, `true`, `false`, `on`, `off` | a boolean |
| a whole number such as `3` | an integer |
| nothing | `null` |
| anything else, such as `0644`, `15.10` or `{{ var }}` | a string, quoted where YAML would otherwise misread it |

Module arguments documented as strings, lists or choices always stay strings, so
`cmd: true` runs the `true` command. After generating, the builder parses its own
output back and warns if it doesn't match.

## Adding a module

Modules are listed in `MODULES` in `index.html`. Each entry has a label, a library
group, default arguments, and its documented arguments. The argument kinds come from
`ansible-doc -j <module>`: `'str'`, `'int'`, `'bool'`, `'list'`, `'yaml'`, or an array
of allowed choices, with `required`, `aliases` and `default` where the docs give them.

## Development

```bash
npm install
npm test
```

The tests load `index.html` in jsdom with the same js-yaml version the page uses.
If `python3` with PyYAML and `ansible-playbook` are on your PATH, they also check that
PyYAML reads the output identically and that Ansible runs a generated playbook;
otherwise those two tests are skipped. CI installs both.
