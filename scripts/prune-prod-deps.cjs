#!/usr/bin/env node
/*
 * Poda de devDependencies para la imagen de runtime (mini-lote de builds, D).
 *
 * Parte del node_modules COMPLETO de la stage `deps` (una sola instalación) y deja solo lo que
 * alcanzan las `dependencies`/`optionalDependencies` de producción, siguiendo la misma resolución
 * de Node (node_modules anidados primero, luego los de los padres). No usa yarn ni red: solo borra.
 *
 * Por qué no `yarn install --production`: yarn 1 reinstala/relinka todo (muy lento en disco lento) y
 * además conserva las devDependencies que un paquete de producción declara como peer opcional
 * (typeorm → ts-node → typescript). Los peers NO se siguen aquí: el runtime ejecuta JS compilado.
 *
 * Uso (desde /app): node scripts/prune-prod-deps.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const rootModules = path.join(root, "node_modules");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const depNames = (pkg) => Object.keys(Object.assign({}, pkg.dependencies, pkg.optionalDependencies));

// Resuelve `name` desde el directorio `fromDir` como lo haría require(): sube por los node_modules.
const resolveDir = (name, fromDir) => {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (dir === root) return null;
    const parent = path.dirname(dir);
    dir = parent.startsWith(root) ? parent : root;
  }
};

const reachable = new Set();
const queue = depNames(readJson(path.join(root, "package.json"))).map((n) => [n, root]);
while (queue.length > 0) {
  const [name, fromDir] = queue.pop();
  const dir = resolveDir(name, fromDir);
  if (dir === null || reachable.has(dir)) continue; // opcional no instalado o ya visitado
  reachable.add(dir);
  for (const dep of depNames(readJson(path.join(dir, "package.json")))) queue.push([dep, dir]);
}

// Borra los paquetes de primer nivel (incl. @scope/name) que no alcanza producción.
let removed = 0;
const removeIfUnreachable = (dir) => {
  if (!reachable.has(fs.realpathSync(dir))) {
    fs.rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
};
for (const entry of fs.readdirSync(rootModules)) {
  if (entry.startsWith(".")) continue;
  const full = path.join(rootModules, entry);
  if (entry.startsWith("@")) {
    for (const sub of fs.readdirSync(full)) removeIfUnreachable(path.join(full, sub));
    if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
  } else if (fs.existsSync(path.join(full, "package.json"))) {
    removeIfUnreachable(full);
  }
}

// Enlaces de node_modules/.bin que apuntaban a paquetes borrados.
const binDir = path.join(rootModules, ".bin");
if (fs.existsSync(binDir)) {
  for (const link of fs.readdirSync(binDir)) {
    const full = path.join(binDir, link);
    if (!fs.existsSync(full)) fs.unlinkSync(full); // existsSync sigue el enlace: false si está roto
  }
}
console.log(`prune-prod-deps: ${reachable.size} paquetes de producción, ${removed} podados`);
