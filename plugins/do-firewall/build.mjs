/**
 * Builds dist/main.js the way Headlamp loads a plugin, with esbuild instead
 * of the @kinvolk/headlamp-plugin CLI (whose ~1,300-package toolchain was
 * build-time supply-chain exposure for a 21 kB file).
 *
 * Headlamp hands every plugin its own copies of React, MUI and its plugin API
 * as the `pluginLib` global; those imports must not be bundled. The mapping
 * is the CLI's (config/vite.config.mjs in @kinvolk/headlamp-plugin 0.14):
 *   react -> pluginLib.React, react/jsx-runtime -> pluginLib.ReactJSX,
 *   @mui/material[/X] -> pluginLib.MuiMaterial[.X],
 *   @kinvolk/headlamp-plugin/lib[/X] -> pluginLib[.X].
 */
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { pluginLibGlobals } from "./pluginlib-globals.mjs";

await build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/main.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [pluginLibGlobals],
  logLevel: "info",
});

// The package.json Headlamp reads next to main.js. Headlamp refuses a plugin
// whose devDependencies["@kinvolk/headlamp-plugin"] is missing or below
// 0.8.0 (frontend/src/plugin/index.ts, filterSources): it is the plugin-API
// level the plugin targets, not something installed here. 0.14.0 is the API
// of Headlamp v0.46.0, which src/headlamp-plugin.d.ts describes.
const PLUGIN_API_VERSION = "0.14.0";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  "dist/package.json",
  JSON.stringify(
    { name: pkg.name, version: pkg.version, description: pkg.description, devDependencies: { "@kinvolk/headlamp-plugin": PLUGIN_API_VERSION } },
    null,
    2,
  ) + "\n",
);
