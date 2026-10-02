// Module sets the app loads at start, in this order. Each file registers one
// collection's modules. To add one, build it with tools/build-module-set.py, put the
// file in this folder and list it here — or add it in the app from the Collections
// menu (kept in that browser only).
window.Scransible.moduleSetFiles = [
  'ansible.builtin.js',
  'ansible.posix.js',
  'community.general.js',
  'cisco.ios.js',
  'cisco.nxos.js'
];
