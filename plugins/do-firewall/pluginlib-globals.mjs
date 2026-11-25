/**
 * Imports Headlamp provides at runtime as the `pluginLib` global, and the
 * esbuild plugin that maps them to it (build.mjs). The mapping is the
 * @kinvolk/headlamp-plugin 0.14 CLI's (config/vite.config.mjs).
 */
const GLOBALS = [
  // Longest prefix first.
  ["@kinvolk/headlamp-plugin/lib/", "pluginLib."],
  ["@kinvolk/headlamp-plugin/lib", "pluginLib"],
  ["@mui/material/", "pluginLib.MuiMaterial."],
  ["@mui/material", "pluginLib.MuiMaterial"],
  ["react/jsx-runtime", "pluginLib.ReactJSX"],
  ["react", "pluginLib.React"],
];

export function globalFor(path) {
  for (const [mod, global] of GLOBALS) {
    if (mod.endsWith("/") ? path.startsWith(mod) : path === mod) {
      const rest = mod.endsWith("/") ? path.slice(mod.length).replace(/\/+/g, "") : "";
      if (rest && !/^[A-Za-z0-9_$]+$/.test(rest)) return null;
      return rest ? `${global}${rest}` : global;
    }
  }
  return null;
}

export const pluginLibGlobals = {
  name: "pluginlib-globals",
  setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|@mui\/material|@kinvolk\/headlamp-plugin\/lib)(\/.*)?$/ }, (args) => {
      const g = globalFor(args.path);
      if (!g) return { errors: [{ text: `no Headlamp global for ${args.path}` }] };
      return { path: g, namespace: "pluginlib" };
    });
    b.onLoad({ filter: /.*/, namespace: "pluginlib" }, (args) => ({
      contents: `module.exports = ${args.path};`,
      loader: "js",
    }));
  },
};

