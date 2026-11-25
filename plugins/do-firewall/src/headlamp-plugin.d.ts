/*
 * The parts of Headlamp's plugin API this plugin uses. Headlamp provides them
 * at runtime as the `pluginLib` global (build.mjs maps the imports to it), so
 * the plugin is built without @kinvolk/headlamp-plugin and its ~1,300-package
 * toolchain. Signatures follow @kinvolk/headlamp-plugin 0.14 (Headlamp
 * v0.46.0); re-check them when the Headlamp image is upgraded.
 */
declare module '@kinvolk/headlamp-plugin/lib' {
  import type { ComponentType } from 'react';

  export interface SidebarEntryProps {
    name: string;
    label: string;
    url?: string;
    parent?: string | null;
    icon?: string;
    sidebar?: string;
    useClusterURL?: boolean;
  }
  export function registerSidebarEntry(entry: SidebarEntryProps): void;

  export interface Route {
    path: string;
    name?: string;
    exact?: boolean;
    sidebar: string | null | { item: string | null; sidebar: string };
    useClusterURL?: boolean;
    noAuthRequired?: boolean;
    component: ComponentType;
  }
  export function registerRoute(route: Route): void;

  export namespace ApiProxy {
    function request(path: string, params?: Record<string, unknown>): Promise<unknown>;
    function apply(body: Record<string, unknown>): Promise<unknown>;
  }
  export namespace Utils {
    function getCluster(): string | null;
  }
}

declare module '@kinvolk/headlamp-plugin/lib/CommonComponents' {
  import type { ReactNode } from 'react';
  export function SectionBox(props: { title?: ReactNode; children?: ReactNode }): JSX.Element;
  export function Loader(props: { title: string }): JSX.Element;
}
